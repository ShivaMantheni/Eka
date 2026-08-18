/* ============================================================
   Eka Automation — Frontend Application Logic
   ============================================================ */

const API = window.location.origin;
let currentExecId = null;
let currentExecActive = false;  // true only while currentExecId is running/pending — gates the
                                // cancel-script flow so unchecking a script after a run finished
                                // (or after the execution was deleted) is a plain deselect, not a
                                // cancel against a stale/dead execution id (Session 14 fix)
let ws = null;
let allLogs = [];           // [{dut_name, script_name, level, message, timestamp}]
let _queuePollTimer = null; // setInterval handle for queue status polling

// Live Results state
let _liveScripts = {};       // scriptStem -> {passed,failed,skipped,duration_s,status,row}
let _liveScriptOrder = [];   // ordered array of scriptStems
let _liveTotalScripts = 0;
let _liveDoneScripts = 0;

// Compare state
let _compareSelected = new Set();   // set of execution IDs (numbers)

// Testcase history data cache
let _tcHistoryData = [];

// Per-DUT interface cache: {dutId: [{name, speed, mtu, fec, alias, oper, admin}, ...]}
// Automatically populated when a DUT is added. Falls back to SONIC_PORTS if empty.
let dutInterfaces = {};

// Session management variables
let currentSession = null;
let sessionKeepAliveTimer = null;

// PTY Terminal (xterm.js) global variables
let xtermLoaded = false;      // Track if xterm.js library is loaded
// Multi-session terminal: allow several devices connected at once, one tab each.
// termSessions maps dutId (string) -> {
//   dutId, name, term, socket, fitAddon, pane, outputBuffer,
//   reconnecting, resizeObserver, generation }
let termSessions = {};
let termActiveDutId = null;   // dutId of the currently visible session tab
let _termVisibilityListenerAdded = false; // Guard to prevent duplicate visibilitychange listeners

// ============================================================
// API HELPERS - Session-based headers
// ============================================================

function getSessionHeaders() {
    const sessionId = localStorage.getItem('eka-session-id');
    const headers = {
        'Content-Type': 'application/json'
    };
    if (sessionId) {
        headers['X-Session-ID'] = sessionId;
    }
    return headers;
}

/**
 * Get the current session ID from localStorage
 * @returns {string|null} The session ID or null if not found
 */
function getSessionId() {
    return localStorage.getItem('eka-session-id');
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    // Restore saved theme before anything renders
    const savedTheme = localStorage.getItem('eka-theme') || 'dark';
    setTheme(savedTheme, true);

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('token') && window.location.pathname === '/') {
        window.location.href = '/hub-callback?token=' + urlParams.get('token');
        return; // Stop execution while redirecting
    }

    // Handle SSO callback before initializing session
    if (urlParams.get('sso') === '1') {
        const sessionId = urlParams.get('session_id');
        if (sessionId) {
            // Store session_id AND user identity fields passed back from hub_callback
            localStorage.setItem('eka-session-id', sessionId);
            const cbUserName  = urlParams.get('user_name');
            const cbUserEmail = urlParams.get('user_email');
            const cbUserRole  = urlParams.get('user_role');
            if (cbUserName)  localStorage.setItem('eka-user-name',  cbUserName);
            if (cbUserEmail) localStorage.setItem('eka-user-email', cbUserEmail);
            if (cbUserRole)  localStorage.setItem('eka-user-role',  cbUserRole);
            // Clean up the URL so tokens don't stay in browser history
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    // Add backdrop click handlers for modals (close on backdrop click)
    const logModalOverlay = document.getElementById('log-detail-modal-overlay');
    if (logModalOverlay) {
        logModalOverlay.addEventListener('click', (e) => {
            if (e.target === logModalOverlay) closeLogViewer();
        });
    }

    // Initialize session management - MUST complete before making API calls
    await initializeSession();

    // Add backdrop click handlers for modals (close on backdrop click)
    const editModalOverlay = document.getElementById('edit-device-modal-overlay');
    if (editModalOverlay) {
        editModalOverlay.addEventListener('click', (e) => {
            if (e.target === editModalOverlay) closeEditDeviceModal();
        });
    }

    // Now that session is initialized, load data
    checkHealth();
    loadStats();
    loadDUTs();
    loadExecutions();
    // Hardware devices will be loaded when Hardware Load tab is opened
    setInterval(checkHealth, 15000);
    setInterval(loadStats, 10000);
});

/**
 * Switch the app theme: 'dark' | 'light'
 * Saves the choice to localStorage so it persists across refreshes.
 */
function setTheme(theme, silent = false) {
    // Ensure only valid themes are used
    if (theme !== 'dark' && theme !== 'light') {
        theme = 'dark'; // Default to dark if invalid theme
    }

    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('eka-theme', theme);

    // Update the toggle button icon
    updateThemeIcon();
}

/**
 * Toggle between dark and light theme
 */
function toggleTheme() {
    console.log('Toggle theme clicked');
    const currentTheme = localStorage.getItem('eka-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    console.log(`Switching from ${currentTheme} to ${newTheme}`);
    setTheme(newTheme);
}

/**
 * Update the theme icon based on current theme
 * If dark mode is active, show sun icon (to switch to light)
 * If light mode is active, show moon icon (to switch to dark)
 */
function updateThemeIcon() {
    const currentTheme = localStorage.getItem('eka-theme') || 'dark';
    const iconEl = document.getElementById('theme-icon');

    if (iconEl) {
        // Show opposite icon - what clicking will switch TO
        const newIcon = currentTheme === 'dark' ? 'light_mode' : 'dark_mode';
        console.log(`Updating icon: current theme=${currentTheme}, setting icon to=${newIcon}`);
        iconEl.textContent = newIcon;
    } else {
        console.error('theme-icon element not found!');
    }
}


// ============================================================
// SESSION MANAGEMENT
// ============================================================

/**
 * Initialize session management on page load
 * Auto-creates session based on browser session without requiring user login
 */
async function initializeSession() {
    // Check if session exists in localStorage
    let sessionId = localStorage.getItem('eka-session-id');

    if (sessionId) {
        // Validate existing session
        const valid = await validateSession(sessionId);
        if (valid) {
            console.log('Existing session validated:', sessionId);
            renderUserBadge();
            startSessionKeepAlive();
            return;
        } else {
            console.log('Existing session invalid, creating new one');
            localStorage.removeItem('eka-session-id');
            localStorage.removeItem('eka-user-name');
        }
    }

    // No localStorage session — check if SSO set the eka_session_id cookie
    // (happens when backend does the redirect but frontend localStorage was cleared)
    const cookieSession = document.cookie.split(';').map(c => c.trim())
        .find(c => c.startsWith('eka_session_id='));
    if (cookieSession) {
        const cookieId = cookieSession.split('=')[1];
        const valid = await validateSession(cookieId);
        if (valid) {
            localStorage.setItem('eka-session-id', cookieId);
            console.log('Session restored from SSO cookie:', cookieId);
            renderUserBadge();
            startSessionKeepAlive();
            return;
        }
    }

    // No valid session — redirect to OnePalC login
    try {
        const cfgRes = await fetch(`${API}/api/onepalc/config`);
        if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            if (cfg.hub_auth_url) {
                const callback = cfg.callback_url || (window.location.origin + '/hub-callback');
                const loginUrl = `${cfg.hub_auth_url}?app_name=${encodeURIComponent(cfg.app_name)}&redirect_uri=${encodeURIComponent(callback)}`;
                window.location.href = loginUrl;
                return;
            }
        }
    } catch (_) { /* ignore */ }

    // Fallback: hub URL not reachable — show a plain error message (no manual modal)
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;
        background:#111;color:#fff;font-family:sans-serif;flex-direction:column;gap:16px">
        <span style="font-size:48px">🔒</span>
        <h2 style="margin:0">Authentication Required</h2>
        <p style="margin:0;color:#aaa">Could not reach OnePalC login server. Contact your administrator.</p>
        <button onclick="location.reload()" style="padding:10px 24px;background:#4CAF50;color:#fff;
            border:none;border-radius:6px;cursor:pointer;font-size:14px">Retry</button>
    </div>`;
}

/**
 * Update the user badge in the header with current session info
 */
function renderUserBadge() {
    const badge = document.getElementById('user-badge');
    const badgeName = document.getElementById('user-badge-name');
    const logoutBtn = document.getElementById('logout-btn');
    const userName = localStorage.getItem('eka-user-name');

    if (badge && badgeName && userName) {
        badgeName.textContent = userName;
        badge.style.display = 'inline-flex';
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';

        // Add role to tooltip if available
        const role = localStorage.getItem('eka-user-role');
        if (role) {
            badge.title = 'User: ' + userName + ' | Role: ' + role;
        }
    }
}

/**
 * Logout: clear browser cookie only — session and all workspace data stay intact in DB.
 * On next login via OnePalC the same session is reused, restoring devices and scripts.
 */
async function logoutUser() {
    // Clear only localStorage — the server-side session stays active to preserve data
    localStorage.removeItem('eka-session-id');
    localStorage.removeItem('eka-user-name');
    localStorage.removeItem('eka-user-email');
    localStorage.removeItem('eka-user-role');

    // Redirect through backend logout (clears the eka_session_id cookie, then to OnePalC)
    window.location.href = `${API}/api/onepalc/logout`;
}

/**
 * Show modal to collect user information
 */
function showUserIdentificationModal() {
    const modal = `
        <div id="session-modal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);
             display:flex;align-items:center;justify-content:center;z-index:10000">
            <div style="background:var(--bg-secondary);padding:24px;border-radius:12px;max-width:400px;width:90%">
                <h2 style="margin:0 0 16px 0;font-size:20px">Welcome to Eka Automation</h2>
                <p style="margin:0 0 20px 0;color:var(--text-secondary);font-size:14px">
                    Please identify yourself to start a session:
                </p>
                <div style="margin-bottom:16px">
                    <label style="display:block;margin-bottom:6px;font-size:12px;font-weight:500">
                        Your Name <span style="color:var(--error)">*</span>
                    </label>
                    <input type="text" id="session-user-name" placeholder="John Doe"
                           style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;
                                  background:var(--bg-primary);color:var(--text);font-size:14px">
                </div>
                <div style="margin-bottom:20px">
                    <label style="display:block;margin-bottom:6px;font-size:12px;font-weight:500">
                        Email (Optional)
                    </label>
                    <input type="email" id="session-user-email" placeholder="john@example.com"
                           style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;
                                  background:var(--bg-primary);color:var(--text);font-size:14px">
                </div>
                <button onclick="registerUserSession()"
                        style="width:100%;padding:10px;background:var(--accent);color:white;border:none;
                               border-radius:6px;cursor:pointer;font-size:14px;font-weight:500">
                    Start Session
                </button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modal);

    // Focus on name input
    setTimeout(() => {
        document.getElementById('session-user-name').focus();
    }, 100);

    // Allow Enter key to submit
    document.getElementById('session-user-name').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') registerUserSession();
    });
    document.getElementById('session-user-email').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') registerUserSession();
    });
}

/**
 * Auto-create session without user input (browser session based)
 */
async function autoCreateSession() {
    // Generate unique session ID based on timestamp and random string
    const sessionId = 'eka-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    // Generate anonymous user name with timestamp
    const timestamp = new Date().toLocaleString('en-US', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    const userName = `User_${timestamp.replace(/[^a-zA-Z0-9]/g, '_')}`;

    try {
        const res = await fetch(`${API}/api/sessions/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                user_name: userName,
                user_email: '',
                ttl_minutes: 480  // 8 hours
            })
        });

        if (!res.ok) {
            const err = await res.json();
            console.error('Auto-session registration failed:', err.detail);
            // Fallback: continue without session (app will still work)
            return;
        }

        const data = await res.json();
        currentSession = data;

        // Save to localStorage (persists across browser sessions)
        localStorage.setItem('eka-session-id', sessionId);
        localStorage.setItem('eka-user-name', userName);

        // Fetch session diagnostics to get time_remaining_minutes and update health dot
        try {
            const diagRes = await fetch(`${API}/api/sessions/${sessionId}/diagnostics`);
            if (diagRes.ok) {
                const diagData = await diagRes.json();
                updateSessionStatusDisplay({
                    status: 'success',
                    time_remaining_minutes: diagData.time_remaining_minutes
                });
            }
        } catch (e) {
            console.error('Failed to fetch session diagnostics:', e);
        }

        // Start keep-alive
        startSessionKeepAlive();

        console.log('Session auto-created:', userName, sessionId);
        renderUserBadge();

    } catch (error) {
        console.error('Error auto-creating session:', error);
        // Continue without session - app will still function
    }
}

/**
 * Register new user session
 */
async function registerUserSession() {
    const userName = document.getElementById('session-user-name').value.trim();
    const userEmail = document.getElementById('session-user-email').value.trim();

    if (!userName) {
        toast('Please enter your name', 'error');
        return;
    }

    // Generate unique session ID
    const sessionId = 'eka-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    try {
        const res = await fetch(`${API}/api/sessions/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                user_name: userName,
                user_email: userEmail,
                ttl_minutes: 480  // 8 hours
            })
        });

        if (!res.ok) {
            const err = await res.json();
            toast(`Session registration failed: ${err.detail}`, 'error');
            return;
        }

        const data = await res.json();
        currentSession = data;

        // Save to localStorage
        localStorage.setItem('eka-session-id', sessionId);
        localStorage.setItem('eka-user-name', userName);

        // Fetch session diagnostics to get time_remaining_minutes and update health dot
        try {
            const diagRes = await fetch(`${API}/api/sessions/${sessionId}/diagnostics`);
            if (diagRes.ok) {
                const diagData = await diagRes.json();
                updateSessionStatusDisplay({
                    status: 'success',
                    time_remaining_minutes: diagData.time_remaining_minutes
                });
            }
        } catch (e) {
            console.error('Failed to fetch session diagnostics:', e);
        }

        // Remove modal
        document.getElementById('session-modal').remove();

        // Start keep-alive
        startSessionKeepAlive();

        toast(`Welcome, ${userName}! Session started.`, 'success');
        console.log('Session registered:', data);
        renderUserBadge();

    } catch (error) {
        toast(`Error registering session: ${error.message}`, 'error');
        console.error('Session registration error:', error);
    }
}

/**
 * Validate existing session
 */
async function validateSession(sessionId) {
    try {
        const res = await fetch(`${API}/api/sessions/validate/${sessionId}`);
        const data = await res.json();

        if (data.valid) {
            currentSession = data.session;

            if (data.session) {
                if (data.session.user_name) {
                    localStorage.setItem('eka-user-name', data.session.user_name);
                }
                if (data.session.user_email) {
                    localStorage.setItem('eka-user-email', data.session.user_email);
                }
                if (data.session.user_role) {
                    localStorage.setItem('eka-user-role', data.session.user_role);
                }
            }

            // Fetch session diagnostics to get time_remaining_minutes and update health dot
            try {
                const diagRes = await fetch(`${API}/api/sessions/${sessionId}/diagnostics`);
                if (diagRes.ok) {
                    const diagData = await diagRes.json();
                    updateSessionStatusDisplay({
                        status: 'success',
                        time_remaining_minutes: diagData.time_remaining_minutes
                    });
                }
            } catch (e) {
                console.error('Failed to fetch session diagnostics:', e);
            }

            return true;
        }
        return false;
    } catch (error) {
        console.error('Session validation error:', error);
        return false;
    }
}

/**
 * Enhanced session keep-alive with detailed logging, failure tracking, and auto-retry
 */
let keepaliveState = {
    failureCount: 0,
    lastSuccess: null,
    isRetrying: false,
    retryDelay: 5000  // Start with 5s, exponential backoff
};

function startSessionKeepAlive() {
    if (sessionKeepAliveTimer) {
        clearInterval(sessionKeepAliveTimer);
    }

    // Main keep-alive check every 4 minutes (instead of 5) for better safety margin
    sessionKeepAliveTimer = setInterval(async () => {
        const sessionId = localStorage.getItem('eka-session-id');
        if (!sessionId) return;

        try {
            const response = await fetch(`${API}/api/sessions/${sessionId}/extend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extend_minutes: 480 })  // 8 hours to maintain session duration
            });

            if (response.ok) {
                const data = await response.json();
                keepaliveState.failureCount = 0;
                keepaliveState.lastSuccess = new Date();
                keepaliveState.isRetrying = false;

                console.log(`[KEEPALIVE] ✓ Activity recorded for session ${sessionId.substring(0,8)}...`, data);
                updateSessionStatusDisplay(data);
            } else {
                handleKeepAliveFailure(sessionId, response.status);
            }
        } catch (error) {
            handleKeepAliveFailure(sessionId, error.message);
        }
    }, 4 * 60 * 1000); // Every 4 minutes (safer than 5)

    // Retry mechanism: if keep-alive fails, retry with exponential backoff
    async function retryKeepAlive(sessionId, retryCount = 0) {
        if (retryCount > 3) {
            console.error('[KEEPALIVE] ✗ Max retries exceeded, session may expire');
            showSessionWarning('Keep-alive failed - Session may expire!');
            return;
        }

        const delay = keepaliveState.retryDelay * Math.pow(2, retryCount);
        console.log(`[KEEPALIVE] Retrying in ${delay}ms (attempt ${retryCount + 1}/3)...`);

        await new Promise(resolve => setTimeout(resolve, delay));

        try {
            const response = await fetch(`${API}/api/sessions/${sessionId}/extend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extend_minutes: 480 })  // 8 hours to maintain session duration
            });

            if (response.ok) {
                const data = await response.json();
                keepaliveState.failureCount = 0;
                keepaliveState.lastSuccess = new Date();
                console.log(`[KEEPALIVE] ✓ Retry succeeded at attempt ${retryCount + 1}`);
                updateSessionStatusDisplay(data);
                return;
            }
        } catch (error) {
            console.error(`[KEEPALIVE] Retry failed: ${error.message}`);
        }

        retryKeepAlive(sessionId, retryCount + 1);
    }

    function handleKeepAliveFailure(sessionId, errorInfo) {
        keepaliveState.failureCount++;
        keepaliveState.isRetrying = true;
        console.warn(`[KEEPALIVE] ✗ Keep-alive failed (attempt ${keepaliveState.failureCount}): ${errorInfo}`);

        // Update UI to show failure
        const statusEl = document.getElementById('session-status');
        if (statusEl) {
            statusEl.className = 'session-status warning';
            statusEl.innerHTML = '⚠️ Keep-alive failed - retrying...';
        }

        // Attempt retry
        retryKeepAlive(sessionId);
    }

    // Activity-based keep-alive: also extend on user activity
    document.addEventListener('click', debounce(() => {
        const sessionId = localStorage.getItem('eka-session-id');
        if (sessionId && (Date.now() - (keepaliveState.lastSuccess?.getTime() || 0)) > 2 * 60 * 1000) {
            console.log('[KEEPALIVE] Activity detected, extending session...');
            fetch(`${API}/api/sessions/${sessionId}/extend`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ extend_minutes: 480 })  // 8 hours to maintain session duration
            }).catch(e => console.error('[KEEPALIVE] Activity-based extend failed:', e));
        }
    }, 60000)); // Only check once per minute

    console.log('[KEEPALIVE] Enhanced session keep-alive started');
}

function debounce(fn, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

/**
 * Update session status display.
 * Sessions are user-based and persistent — health dot is always green when active.
 */
function updateSessionStatusDisplay(sessionData) {
    const healthDot = document.getElementById('health-dot');
    const remaining = sessionData.time_remaining_minutes || 0;

    // For user-based persistent sessions: dot is green when active, red if terminated
    if (healthDot) {
        healthDot.classList.remove('healthy', 'warning', 'critical');
        if (!sessionData || sessionData.status === 'error') {
            // No session or errored
            healthDot.classList.add('critical');
            healthDot.title = 'Session Status: Error';
        } else if (remaining === 999999 || remaining >= 60) {
            // Persistent session — always healthy
            healthDot.classList.add('healthy');
            healthDot.title = 'Session Status: Active (user-based persistent session)';
        } else {
            // Fallback for any legacy session data
            healthDot.classList.add('healthy');
            healthDot.title = 'Session Status: Active';
        }
    }
}

/**
 * Show session warning banner
 */
function showSessionWarning(message) {
    const warningEl = document.createElement('div');
    warningEl.className = 'session-warning';
    warningEl.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #dc2626;
        color: white;
        padding: 12px 20px;
        text-align: center;
        font-weight: 500;
        z-index: 10000;
    `;
    warningEl.innerHTML = `🔴 ${message} - <a href="#" style="color: white; text-decoration: underline;" onclick="location.reload(); return false;">Reload page</a>`;
    document.body.appendChild(warningEl);

    console.error(`[SESSION_WARNING] ${message}`);
    toast(message, 'error');
}

/**
 * Fetch and display session diagnostics (for debugging)
 */
async function getSessionDiagnostics() {
    const sessionId = localStorage.getItem('eka-session-id');
    if (!sessionId) return null;

    try {
        const response = await fetch(`${API}/api/sessions/${sessionId}/diagnostics`);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.error('[DIAGNOSTICS] Failed to fetch:', error);
        return null;
    }
}

/**
 * Log session lifecycle events
 */
function logSessionEvent(eventType, details = {}) {
    const event = {
        timestamp: new Date().toISOString(),
        type: eventType,
        sessionId: localStorage.getItem('eka-session-id'),
        ...details
    };
    console.log(`[SESSION_EVENT] ${eventType}:`, event);

    // Store in session storage for debugging
    const events = JSON.parse(sessionStorage.getItem('eka-session-events') || '[]');
    events.push(event);
    sessionStorage.setItem('eka-session-events', JSON.stringify(events.slice(-50))); // Keep last 50
}


// ============================================================
// HEALTH & STATS
// ============================================================

async function checkHealth() {
    // API health check - health-dot now used for session status instead
    try {
        const res = await fetch(`${API}/health`);
        // Health check passes silently - no visual indicator needed
        console.log('[HEALTH] API health check:', res.ok ? 'OK' : 'FAILED');
    } catch (e) {
        console.error('[HEALTH] API health check failed:', e.message);
    }
}

async function loadStats() {
    try {
        const res = await fetch(`${API}/api/stats`, {
            headers: getSessionHeaders()
        });
        const s = await res.json();
        setText('dash-total-duts', s.total_duts);
        setText('dash-online-duts', s.online_duts);
        setText('dash-scripts', s.total_scripts);
        setText('dash-executions', s.total_executions);
        document.querySelector('#stat-duts span:nth-child(2)').textContent = s.total_duts;
        document.querySelector('#stat-online span:nth-child(2)').textContent = s.online_duts;
        const runEl = document.getElementById('stat-running');
        if (s.running_executions > 0) {
            runEl.style.display = 'flex';
            runEl.querySelector('span:nth-child(2)').textContent = s.running_executions;
        } else { runEl.style.display = 'none'; }
    } catch { }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');

    // Load hardware devices when Hardware Load tab is opened
    if (tab === 'hardware-load') {
        loadHardwareDevices();
        loadHWHistory();
    }

    if (tab === 'execute') {
        loadDUTs();
        updateSpyStartBtn();
        renderTopologyCanvas();
        loadTopologyConnectionsFromServer();
        loadDUTLockStatus();
        loadJobs().then(() => {
            if (activeJobList.length === 0) {
                // Auto-create Job-1 on first open
                createJob();
            } else if (!activeJobId) {
                switchJob(activeJobList[0].id);
            }
        });
        _startJobPoller();
    } else {
        _stopJobPoller();
    }
    if (tab === 'devices') loadDUTs();
    if (tab === 'logs') loadExecutions();
    if (tab === 'dashboard') { loadExecutions(); loadTestcaseHistory(); }
    if (tab === 'terminal') {
        loadDUTs(); // Load DUTs to populate terminal dropdown
        setupTerminalHandlers(); // Re-setup handlers when entering terminal tab
    }
    if (tab === 'vs') renderVSHostList();
    if (tab === 'users') { loadUsers(); loadActiveSessions(); }
}

// ============================================================
// DUT MANAGEMENT
// ============================================================

let dutsData = [];

async function loadDUTs() {
    try {
        const res = await fetch(`${API}/api/duts`, {
            headers: getSessionHeaders()
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.statusText}`);
        dutsData = await res.json();
        // Seed the per-device interface cache from persisted data so each device
        // shows its own real interfaces after reload (not the shared defaults)
        dutsData.forEach(d => {
            if (d.interfaces && d.interfaces.length > 0) dutInterfaces[d.id] = d.interfaces;
        });
        renderDUTsTable();
        renderDUTChecklist();   // was renderExecDUTList (undefined)
        renderTermDUTList();
        renderDashDevices();
        renderSpyVMs();
        renderVSHostList();
        renderVSSourceServerList();
        // renderSpyDUTs / renderGitVMs: DUT checklist already covers DUTs; VMs in renderSpyVMs
    } catch (e) {
        console.error('loadDUTs failed:', e);
        toast(`Failed to load devices: ${e.message}`, 'error');
    }
}

function renderDUTsTable() {
    const tbody = document.getElementById('duts-tbody');
    if (!dutsData.length) { tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No devices added yet. Add one above.</td></tr>'; return; }
    tbody.innerHTML = dutsData.map(d => `
        <tr>
            <td data-label="Name"><strong>${esc(d.name)}</strong></td>
            <td data-label="IP Address" style="font-family:var(--mono)">${esc(d.ip_address)}</td>
            <td data-label="Port">${d.port}</td>
            <td data-label="Type">${esc(d.device_type || '-')}</td>
            <td data-label="Status"><span class="badge ${d.status}">${d.status}</span></td>
            <td data-label="Actions" style="display:flex;gap:4px">
                <button class="btn outline small" onclick="openEditDeviceModal(${d.id})" title="Edit" style="color:var(--blue)"><span class="material-icons-round" style="font-size:16px">edit</span></button>
                <button class="btn outline small" onclick="deleteDUT(${d.id})" title="Delete" style="color:var(--red)"><span class="material-icons-round" style="font-size:16px">delete</span></button>
            </td>
        </tr>`).join('');
}

function renderDashDevices() {
    const el = document.getElementById('dash-devices-list');
    if (!dutsData.length) { el.innerHTML = '<p class="muted">No devices configured yet.</p>'; return; }

    const vms = dutsData.filter(d => d.device_type === 'VM');
    const duts = dutsData.filter(d => d.device_type !== 'VM');
    let html = '';

    if (vms.length) {
        html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text-secondary);margin-bottom:4px">🖥 VMs</div>';
        html += vms.map(d => {
            const connIcon = d.connection_type === 'telnet' ? '📞' : '🔐';
            const connTitle = d.connection_type === 'telnet' ? 'Telnet' : 'SSH';
            return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
                <div><strong>${esc(d.name)}</strong> <span class="muted" style="font-family:var(--mono);margin-left:8px">${esc(d.ip_address)}</span> <span title="${connTitle}" style="font-size:12px">${connIcon}</span></div>
                <span class="badge ${d.status}">${d.status}</span>
            </div>`;
        }).join('');
    }

    if (duts.length) {
        html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text-secondary);margin-top:${vms.length ? '12px' : '0'};margin-bottom:4px">🔧 DUTs</div>`;
        html += duts.map(d => {
            const connIcon = d.connection_type === 'telnet' ? '📞' : '🔐';
            const connTitle = d.connection_type === 'telnet' ? 'Telnet' : 'SSH';
            return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
                <div><strong>${esc(d.name)}</strong> <span class="muted" style="font-family:var(--mono);margin-left:8px">${esc(d.ip_address)}</span> <span title="${connTitle}" style="font-size:12px">${connIcon}</span></div>
                <span class="badge ${d.status}">${d.status}</span>
            </div>`;
        }).join('');
    }

    el.innerHTML = html;
}

async function addDUT(e) {
    e.preventDefault();
    const data = {
        name: document.getElementById('dut-name').value.trim(),
        ip_address: document.getElementById('dut-ip').value.trim(),
        port: parseInt(document.getElementById('dut-port').value) || 22,
        username: document.getElementById('dut-user').value || 'admin',
        password: document.getElementById('dut-pass').value || '',
        xml_path: document.getElementById('dut-xml-path').value || '/home/hp/prajwal/VMs',
        device_type: document.getElementById('dut-type').value,
        connection_type: document.getElementById('dut-connection-type').value || 'ssh',
    };

    // Validate device name (alphanumeric only: A-Z, a-z, 0-9)
    const nameRegex = /^[A-Za-z0-9]+$/;
    if (!data.name) {
        toast('Device name is required', 'error');
        return;
    }
    if (!nameRegex.test(data.name)) {
        toast('Device name must contain only letters (A-Z, a-z) and numbers (0-9). No special characters or spaces allowed.', 'error');
        return;
    }

    // Validate IP address (IPv4 format: xxx.xxx.xxx.xxx)
    const ipRegex = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
    if (!data.ip_address) {
        toast('IP address is required', 'error');
        return;
    }
    if (!ipRegex.test(data.ip_address)) {
        toast('Invalid IP address. Must be valid IPv4 format (e.g., 192.168.1.100). No subnet mask allowed.', 'error');
        return;
    }

    try {
        const res = await fetch(`${API}/api/duts`, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        const result = await res.json();
        toast(`Device "${data.name}" added successfully`, 'success');

        // Reset form
        document.getElementById('add-dut-form').reset();
        document.getElementById('dut-port').value = '22';
        document.getElementById('dut-user').value = 'admin';
        document.getElementById('dut-xml-path').value = '/home/hp/prajwal/VMs';

        // Reload device list first
        await loadDUTs();
        loadStats();

        // Refresh Hardware Load device list if telnet device was added
        if (data.connection_type === 'telnet') {
            loadHardwareDevices();
        }

        // Test connectivity for all devices (SSH and Telnet)
        if (result.id) {
            if (data.device_type === 'DUT' && data.connection_type !== 'telnet') {
                // DUT devices with SSH: fetch interfaces via SSH
                toast(`Connecting to ${data.name} — fetching interfaces...`, 'info');
                await fetchDUTInterfaces(result.id);
                await loadDUTs(); // Refresh status after interface fetch
            } else {
                // All other devices (VM, Switch, Router, Telnet): test basic connectivity
                const connType = data.connection_type === 'telnet' ? 'telnet' : 'SSH';
                toast(`Testing ${connType} connectivity to ${data.name}...`, 'info');
                try {
                    const res = await fetch(`${API}/api/duts/${result.id}/ping`, { method: 'POST' });
                    const pingData = await res.json();
                    if (res.ok) {
                        toast(`${data.name} is ONLINE ✓`, 'success');
                    } else {
                        toast(`${data.name} is OFFLINE — ${pingData.detail || 'Cannot connect'}`, 'warning');
                    }
                    await loadDUTs(); // Refresh status
                } catch (e) {
                    toast(`${data.name}: connection test failed — ${e.message}`, 'error');
                    await loadDUTs();
                }
            }
        } else if (data.connection_type === 'telnet') {
            // Telnet devices are marked online by default
            toast(`${data.name} added successfully (telnet)`, 'success');
        }
    } catch (e) { toast(`Failed to add device: ${e.message}`, 'error'); }
}

async function deleteDUT(id) {
    if (!confirm('Delete this device?')) return;
    try {
        // Close any open terminal session for this device
        if (termSessions[String(id)]) {
            console.log(`[PTY] Closing terminal session for deleted device ${id}`);
            termCloseSession(id);
        }

        const res = await fetch(`${API}/api/duts/${id}`, { method: 'DELETE', headers: getSessionHeaders() });
        if (!res.ok) throw new Error('Failed');
        toast('Device deleted', 'success');
        selectedDUTIds.delete(id);

        loadDUTs();
        loadStats();

        // Refresh terminal device list
        renderTermDUTList();
    } catch (e) {
        toast('Failed to delete device', 'error');
    }
}

async function pingDUT(id) {
    const dut = dutsData.find(d => d.id === id);

    // Only fetch interfaces for actual DUTs, not VMs or other device types
    if (dut && (dut.device_type === 'DUT' || dut.device_type === 'Switch' || dut.device_type === 'Router')) {
        toast(`Connecting to ${dut?.name || id} — fetching interfaces...`, 'info');
        // Single SSH connection only — directly fetch interfaces (no separate ping)
        await fetchDUTInterfaces(id);
    } else {
        // For VMs and other types, just check basic connectivity
        toast(`Checking connectivity to ${dut?.name || id}...`, 'info');
        try {
            const res = await fetch(`${API}/api/duts/${id}/ping`, { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                toast(`${dut?.name || 'Device'} is ONLINE ✓`, 'success');
            } else {
                toast(`${dut?.name || 'Device'} is OFFLINE — ${data.detail || 'Cannot connect'}`, 'error');
            }
        } catch (e) {
            toast(`${dut?.name || 'Device'}: connection failed — ${e.message}`, 'error');
        }
    }
    // Wait for the device list to refresh so status is properly updated
    await loadDUTs();
}

/**
 * Fetch real interface list from the DUT via SSH.
 * ONE SSH connection: connect → run 'show interfaces status' → disconnect.
 * Only applies to SONiC DUTs — not VS hosts or other device types.
 */
async function fetchDUTInterfaces(dutId) {
    const dut = dutsData.find(d => d.id === dutId);

    // Safety check: only fetch interfaces for network devices (DUT, Switch, Router)
    // Skip for VMs and other device types
    if (!dut || (dut.device_type !== 'DUT' && dut.device_type !== 'Switch' && dut.device_type !== 'Router')) {
        console.log(`Skipping interface fetch for ${dut?.name || dutId} (device_type: ${dut?.device_type})`);
        return;
    }

    // Skip interface fetching for telnet devices (they don't use SSH)
    if (dut.connection_type === 'telnet') {
        console.log(`Skipping interface fetch for ${dut.name} (telnet device)`);
        toast(`${dut.name} added successfully (telnet device - use Hardware Load tab)`, 'success');
        return;
    }

    try {
        const res = await fetch(`${API}/api/duts/${dutId}/interfaces`);
        const data = await res.json();
        if (res.ok && data.interfaces && data.interfaces.length > 0) {
            dutInterfaces[dutId] = data.interfaces;
            toast(`${dut?.name || 'DUT'} ONLINE ✓ — ${data.count} interfaces found`, 'success');
            // Don't render here - let pingDUT() refresh after loadDUTs()
        } else if (!res.ok) {
            toast(`${dut?.name || 'DUT'} OFFLINE — ${data.detail || 'Cannot connect'}`, 'error');
        }
    } catch (e) {
        toast(`${dut?.name || 'DUT'}: connection failed — ${e.message}`, 'error');
    }
}

/**
 * Returns the interface list for a DUT.
 * Uses cached real interfaces if available, otherwise falls back to SONIC_PORTS.
 * Always returns an array of objects with at least a .name field.
 */
function _getInterfacesForDUT(dutId) {
    const cached = dutInterfaces[dutId];
    if (cached && cached.length > 0) return cached;
    // Fallback: wrap SONIC_PORTS as minimal interface objects
    return SONIC_PORTS.map(name => ({ name, oper: 'N/A', admin: 'N/A' }));
}

// ============================================================
// DEVICE EDIT FUNCTIONALITY
// ============================================================

let editingDutId = null;

function openEditDeviceModal(id) {
    // Find device in dutsData
    const dut = dutsData.find(d => d.id === id);
    if (!dut) {
        toast('Device not found', 'error');
        return;
    }

    editingDutId = id;

    // Populate form with current values
    document.getElementById('edit-dut-name').value = dut.name || '';
    document.getElementById('edit-dut-ip').value = dut.ip_address || '';
    document.getElementById('edit-dut-port').value = dut.port || 22;
    document.getElementById('edit-dut-type').value = dut.device_type || 'VM';
    document.getElementById('edit-dut-user').value = dut.username || 'admin';
    document.getElementById('edit-dut-pass').value = ''; // Don't pre-fill password for security
    document.getElementById('edit-dut-xml-path').value = dut.xml_path || '/home/hp/prajwal/VMs';

    // Show modal as popup overlay
    document.getElementById('edit-device-modal-overlay').classList.add('active');
}

function closeEditDeviceModal() {
    document.getElementById('edit-device-modal-overlay').classList.remove('active');
    editingDutId = null;
    document.getElementById('edit-device-form').reset();
}

async function editDUT(event) {
    event.preventDefault();

    if (!editingDutId) return;

    const dut = dutsData.find(d => d.id === editingDutId);
    if (!dut) {
        toast('Device not found', 'error');
        return;
    }

    const newName = document.getElementById('edit-dut-name').value.trim();
    const newIp = document.getElementById('edit-dut-ip').value.trim();
    const newPort = parseInt(document.getElementById('edit-dut-port').value) || 22;
    const newType = document.getElementById('edit-dut-type').value;
    const newUser = document.getElementById('edit-dut-user').value.trim() || 'admin';
    const newPass = document.getElementById('edit-dut-pass').value;
    const newXmlPath = document.getElementById('edit-dut-xml-path').value.trim();

    // Validate device name (alphanumeric only: A-Z, a-z, 0-9)
    const nameRegex = /^[A-Za-z0-9]+$/;
    if (!newName) {
        toast('Device name is required', 'error');
        return;
    }
    if (!nameRegex.test(newName)) {
        toast('Device name must contain only letters (A-Z, a-z) and numbers (0-9). No special characters or spaces allowed.', 'error');
        return;
    }

    // Validate IP address (IPv4 format: xxx.xxx.xxx.xxx)
    const ipRegex = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
    if (!newIp) {
        toast('IP address is required', 'error');
        return;
    }
    if (!ipRegex.test(newIp)) {
        toast('Invalid IP address. Must be valid IPv4 format (e.g., 192.168.1.100). No subnet mask allowed.', 'error');
        return;
    }

    // Check what changed
    const ipChanged = newIp !== dut.ip_address;
    const userChanged = newUser !== dut.username;
    const passChanged = newPass !== ''; // If password field is filled, it changed
    const credsChanged = ipChanged || userChanged || passChanged;

    try {
        // Prepare update data
        const updateData = {
            name: newName,
            ip_address: newIp,
            port: newPort,
            device_type: newType,
            username: newUser,
            xml_path: newXmlPath
        };

        // Include password only if user entered a new one
        if (passChanged) {
            updateData.password = newPass;
        }

        // Send update request
        const res = await fetch(`${API}/api/duts/${editingDutId}`, {
            method: 'PUT',
            headers: { ...getSessionHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.detail || 'Failed to update device');
        }

        const result = await res.json();

        // If credentials changed, validate SSH connection
        if (credsChanged && (newType === 'DUT' || newType === 'Switch' || newType === 'Router')) {
            toast(`Device updated. Testing SSH connection to ${newName}...`, 'info');
            // Fetch interfaces to validate connection and get device capabilities
            await fetchDUTInterfaces(editingDutId);
        } else if (credsChanged) {
            // For VMs, just test basic connectivity
            try {
                const pingRes = await fetch(`${API}/api/duts/${editingDutId}/ping`, { method: 'POST' });
                const pingData = await pingRes.json();
                if (pingRes.ok) {
                    toast(`Device ${newName} updated and connection verified ✓`, 'success');
                } else {
                    toast(`Device updated but connection failed: ${pingData.detail || 'Cannot connect'}`, 'warning');
                }
            } catch (e) {
                toast(`Device updated but connection test failed: ${e.message}`, 'warning');
            }
        } else {
            toast(`Device ${newName} updated successfully ✓`, 'success');
        }

        closeEditDeviceModal();
        await loadDUTs();
        await loadStats();

    } catch (e) {
        toast(`Failed to update device: ${e.message}`, 'error');
    }
}

// ============================================================
// EXEC — DUT SELECTION (Checklist in DUTs panel)
// ============================================================

let dutConnections = []; // [{dut_a, intf_a, dut_b, intf_b}, ...]
let dutLockStatus = {};  // {dutId: 'AVAILABLE'|'ALLOCATED'|'IN_USE'}

// ============================================================
// DUT LOCK STATUS
// ============================================================

async function loadDUTLockStatus() {
    try {
        const res = await fetch(`${API}/api/dut-locks`);
        if (res.ok) {
            const locks = await res.json();
            dutLockStatus = {};
            locks.forEach(l => { dutLockStatus[l.dut_id] = l.status; });
            // Only re-render if dutsData is already populated
            if (dutsData && dutsData.length > 0) renderDUTChecklist();
        }
    } catch (_) { }
}

function renderDUTChecklist() {
    const el = document.getElementById('exec-dut-checklist');
    if (!el) return;
    // Only show DUTs that are online — offline devices cannot be used for execution
    const allDuts = dutsData.filter(d => d.device_type === 'DUT');
    const duts = allDuts.filter(d => d.status === 'online');
    const offlineCount = allDuts.length - duts.length;

    if (!duts.length) {
        const offlineNote = offlineCount > 0
            ? ` <span style="color:var(--text-secondary);font-size:11px">(${offlineCount} offline device${offlineCount > 1 ? 's' : ''} hidden)</span>`
            : '';
        el.innerHTML = `<p class="muted" style="padding:8px;font-size:12px;margin:0">No online DUTs available.${offlineNote} Add devices with type "DUT" in Devices tab.</p>`;
        updateDUTSelectionCount();
        return;
    }
    const offlineBanner = offlineCount > 0
        ? `<div style="padding:4px 8px;font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--border)">
               <span class="material-icons-round" style="font-size:13px;color:#ef4444">wifi_off</span>
               ${offlineCount} offline device${offlineCount > 1 ? 's' : ''} hidden
           </div>`
        : '';
    el.innerHTML = offlineBanner + duts.map(d => {
        const checked = selectedDUTIds.has(d.id) ? 'checked' : '';
        const sel = selectedDUTIds.has(d.id) ? 'selected' : '';
        const lockStatus = dutLockStatus[d.id] || 'AVAILABLE';
        const lockIcon = lockStatus === 'IN_USE'
            ? '<span title="In Use" style="color:var(--red);font-size:13px" class="material-icons-round">lock</span>'
            : lockStatus === 'ALLOCATED'
                ? '<span title="Allocated" style="color:var(--orange,#f59e0b);font-size:13px" class="material-icons-round">pending</span>'
                : '';
        return `<label class="dut-selector-item ${sel}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:6px;transition:background .15s" onmouseenter="this.style.background='var(--bg-tertiary)'" onmouseleave="this.style.background=''">
            <input type="checkbox" ${checked} onchange="toggleDUTCheck(${d.id}, this)">
            <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:13px">${esc(d.name)}${lockIcon}</div>
                <div style="font-size:11px;color:var(--text-secondary)">${esc(d.ip_address)}:${d.port}</div>
            </div>
            <span class="badge ${d.status}" style="font-size:10px">${d.status}</span>
        </label>`;
    }).join('');
    updateDUTSelectionCount();
}

function toggleDUTCheck(id, cb) {
    const numId = Number(id);
    if (cb.checked) {
        selectedDUTIds.add(numId);
            checkDUTConflicts([numId]);
            saveJobState();
    } else {
        selectedDUTIds.delete(numId);
        delete dutPositions[numId];
            saveJobState();
    }
    const label = cb.closest('.dut-selector-item');
    if (label) label.classList.toggle('selected', cb.checked);
    updateDUTSelectionCount();
    updateSpyStartBtn();
    renderTopologyCanvas();
}

function updateDUTSelectionCount() {
    const el = document.getElementById('dut-selection-count');
    if (el) el.textContent = selectedDUTIds.size > 0 ? `${selectedDUTIds.size} selected` : '';
}

// --- DUT Connection Editor ---
function addDUTConnection() {
    const allDUTs = dutsData.filter(d => d.device_type === 'DUT');
    if (allDUTs.length < 2) {
        toast('Need at least 2 DUT devices. Add devices in the Devices tab first.', 'error');
        return;
    }
    dutConnections.push({ dut_a: '', intf_a: 'Ethernet0', dut_b: '', intf_b: 'Ethernet0' });
    renderTopologyCanvas();
    _openConnEditor(dutConnections.length - 1);
    setTimeout(() => {
        const ed = document.getElementById('conn-editor');
        if (ed) ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
    _saveConnectionsToServer();
}

function removeDUTConnection(idx) {
    dutConnections.splice(idx, 1);
    renderTopologyCanvas();
    const ed = document.getElementById('conn-editor');
    if (ed) ed.style.display = 'none';
    _saveConnectionsToServer();
}

function updateConnection(idx, field, value) {
    if (!dutConnections[idx]) return;
    dutConnections[idx][field] = value;

    // Auto-select the DUT on the canvas when picked in the connection editor
    if ((field === 'dut_a' || field === 'dut_b') && value) {
        const dutId = parseInt(value);
        if (!selectedDUTIds.has(dutId)) {
            selectedDUTIds.add(dutId);
            renderDUTChecklist();
            updateDUTSelectionCount();
        }
    }
    renderTopologyCanvas();
    _saveConnectionsToServer();
}


function renderConnections() {
    // Legacy: now the SVG canvas renders connections. Just re-render the canvas.
    renderTopologyCanvas();
}

function updateSpyStartBtn() {
    const btn = document.getElementById('btn-start-exec');
    if (!btn) return;
    const hasVM = document.getElementById('spy-vm-select')?.value;
    const hasScripts = getSelectedScriptPaths().length > 0;
    const hasTopology = selectedDUTIds.size > 0 && dutConnections.length > 0;
    // Enable if: VM selected + scripts selected + topology configured
    btn.disabled = !hasVM || !hasScripts || !hasTopology;
}

// ============================================================
// EXECUTE — VM & DUT DROPDOWN RENDERING
// ============================================================

let selectedDUTIds = new Set();
let scriptsData = [];

// ── Execution Job state ───────────────────────────────────────────────────
let activeJobId   = null;   // currently-active job id
let activeJobList = [];     // [{id, name, status, execution_count}]
let _jobSaveTimer = null;   // debounce handle for auto-save
let _jobStatusSnapshot = {}; // BF-10: {jobId: status} — detects background job state changes


function renderSpyVMs() {
    const sel = document.getElementById('spy-vm-select');
    if (!sel) return;
    // Only show online VMs — offline VMs cannot run test scripts
    const allVms = dutsData.filter(d => d.device_type === 'VM');
    const vms = allVms.filter(d => d.status === 'online');
    const offlineCount = allVms.length - vms.length;
    const prevVal = sel.value;
    sel.innerHTML = '<option value="">-- Select VM Host --</option>';
    vms.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `\u{1F7E2} ${d.name} (${d.ip_address}:${d.port})`;
        sel.appendChild(opt);
    });
    if (offlineCount > 0) {
        const divider = document.createElement('option');
        divider.disabled = true;
        divider.textContent = `\u2014 ${offlineCount} offline VM${offlineCount > 1 ? 's' : ''} hidden \u2014`;
        sel.appendChild(divider);
    }
    if (prevVal) sel.value = prevVal;
    updateSpyStartBtn();
}


// ── Execution Job Management ────────────────────────────────────────────────

async function loadJobs() {
    try {
        const res = await fetch(`${API}/api/execution-jobs`, { headers: getSessionHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        activeJobList = data.jobs || [];
        // BF-10: Seed snapshot so first sweep doesn't toast stale status changes
        activeJobList.forEach(j => { _jobStatusSnapshot[j.id] = j.status; });
        renderJobDropdown();
    } catch (_) {}
}

function renderJobDropdown() {
    const sel = document.getElementById('job-select');
    const badge = document.getElementById('job-status-badge');
    if (!sel) return;
    sel.innerHTML = '';
    if (activeJobList.length === 0) {
        sel.innerHTML = '<option value="">-- No Jobs --</option>';
    } else {
        activeJobList.forEach(j => {
            const opt = document.createElement('option');
            opt.value = j.id;
            opt.textContent = `${j.name} (${j.status})`;
            if (j.id === activeJobId) opt.selected = true;
            sel.appendChild(opt);
        });
    }
    const activeJob = activeJobList.find(j => j.id === activeJobId);
    if (badge && activeJob) {
        badge.textContent = activeJob.status;
        badge.className = `job-status-badge ${activeJob.status}`;
    }
    const btnDelete = document.getElementById('btn-delete-job');
    const btnRename = document.getElementById('btn-rename-job');
    if (btnDelete) btnDelete.disabled = !activeJobId || (activeJob && activeJob.status === 'running');
    if (btnRename) btnRename.disabled = !activeJobId;
}

async function createJob() {
    const name = `Job-${activeJobList.length + 1}`;
    try {
        const res = await fetch(`${API}/api/execution-jobs`, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!res.ok) { toast('Failed to create job', 'error'); return; }
        const data = await res.json();
        activeJobList.unshift({ id: data.id, name: data.name, status: data.status, execution_count: 0 });
        await switchJob(data.id);
    } catch (e) {
        toast('Failed to create job: ' + e.message, 'error');
    }
}

// BF-13: Derive live-results row stems from an execution's script_results
// (preferred — reflects actual run) or the job's saved scripts (fallback).
function _jobScriptStems(latestExec, jobScripts) {
    const sr = (latestExec && latestExec.script_results) || [];
    if (sr.length > 0) return sr.map(r => r.script_stem);
    return (jobScripts || []).map(s => (s.path || s).split('/').pop().replace(/\.py$/, ''));
}

// BF-13: Single source of truth for the execution viewer. Fully resets the
// global execution display (logs, queue panel, live results, run buttons) and
// restores it from the given job's latest execution. Called by both switchJob()
// and _pollActiveJob() so the viewer is always a clean function of the selected
// job — no stale logs or half-restored state leaking across jobs.
function _syncExecutionView(latestExec, jobScripts) {
    // 1. Tear down any connection/polling from the previously-viewed execution
    if (ws) { ws.close(); ws = null; }
    stopQueuePolling();

    // 2. Always clear the logs panel — stale lines from another job must not linger
    allLogs = [];
    logStreams = {};
    renderLogs();

    // 3. Reset run-specific ancillary controls
    ['btn-add-scripts-exec', 'btn-show-only-running', 'btn-download-logs'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const qPanel      = document.getElementById('queue-status-panel');
    const jobHtmlBtn  = document.getElementById('btn-job-html');
    const jobExcelBtn = document.getElementById('btn-job-excel');
    const startBtn    = document.getElementById('btn-start-exec');
    const stopBtn     = document.getElementById('btn-stop-exec');

    currentExecId      = latestExec ? latestExec.id : null;
    _jobPollLastExecId = currentExecId;
    currentExecActive  = !!(latestExec && (latestExec.status === 'running' || latestExec.status === 'pending'));

    if (latestExec && (latestExec.status === 'running' || latestExec.status === 'pending')) {
        // Active execution — stream live (logs via WS, queue panel, live results)
        if (startBtn)    startBtn.style.display    = 'none';
        if (stopBtn)     stopBtn.style.display     = '';
        if (jobHtmlBtn)  jobHtmlBtn.style.display  = 'none';
        if (jobExcelBtn) jobExcelBtn.style.display = 'none';
        const stems = _jobScriptStems(latestExec, jobScripts);
        if (stems.length) {
            showLiveResultsPanel(stems.map(s => `${s}.py`));
            // Replay any scripts that already finished before we connected
            (latestExec.script_results || []).forEach(r => updateLiveResults(r));
        } else {
            hideLiveResultsPanel();
        }
        if (qPanel) qPanel.style.display = '';
        startQueuePolling(currentExecId);
        connectWS(currentExecId);
        startExecLogPolling(currentExecId);   // reliable live logs via REST on reload
    } else if (latestExec) {
        // Completed/failed — restore per-script rows + job report buttons
        if (startBtn)    startBtn.style.display    = '';
        if (stopBtn)     stopBtn.style.display     = 'none';
        if (jobHtmlBtn)  jobHtmlBtn.style.display  = '';
        if (jobExcelBtn) jobExcelBtn.style.display = '';
        if (qPanel) qPanel.style.display = 'none';
        _restoreLiveResultsPanel(latestExec, jobScripts);
    } else {
        // No executions yet — fresh idle state
        if (startBtn)    startBtn.style.display    = '';
        if (stopBtn)     stopBtn.style.display     = 'none';
        if (jobHtmlBtn)  jobHtmlBtn.style.display  = 'none';
        if (jobExcelBtn) jobExcelBtn.style.display = 'none';
        if (qPanel) qPanel.style.display = 'none';
        hideLiveResultsPanel();
    }
}

async function switchJob(newId) {
    if (!newId || newId === activeJobId) return;
    // Clear schedule label immediately so old job's time never bleeds into new job
    const _nrEl = document.getElementById('job-next-run');
    if (_nrEl) { _nrEl.textContent = ''; _nrEl.style.display = 'none'; }
    // Flush the OUTGOING job's state without blocking the switch.
    // This used to `await saveJobState(true)` here — but this call sits OUTSIDE the try
    // below, so if the PUT stalled while the server was busy during a running execution,
    // switchJob() hung forever with no error toast and none of the panels (device hub,
    // topology, scripts, queue, live results, logs) ever updated until a page reload.
    // State is already debounce-saved on every change, and the running execution does not
    // mutate the selection, so a fire-and-forget flush loses nothing. (saveJobState reads
    // the current globals synchronously to build the request body before it awaits, so the
    // outgoing values are captured correctly even though we overwrite the globals below.)
    if (activeJobId) saveJobState(true);  // fire-and-forget — do NOT await
    // Load new job state from server — guarded with a timeout so a wedged request can never
    // leave the viewer stuck on the previous job.
    try {
        const _ctrl = new AbortController();
        const _to = setTimeout(() => _ctrl.abort(), 15000);
        let res;
        try {
            res = await fetch(`${API}/api/execution-jobs/${newId}`, {
                headers: getSessionHeaders(), signal: _ctrl.signal });
        } finally {
            clearTimeout(_to);
        }
        if (!res.ok) { toast('Failed to load job', 'error'); return; }
        const data = await res.json();
        activeJobId = newId;
        // Restore DUT selection
        selectedDUTIds = new Set((data.dut_ids || []).map(Number));
        // Restore base path
        activeBasePath = data.base_path || '';
        const pathInput = document.getElementById('scripts-base-path');
        if (pathInput) pathInput.value = activeBasePath;
        // Restore host VM
        if (data.host_id) {
            const vmSel = document.getElementById('spy-vm-select');
            if (vmSel) vmSel.value = data.host_id;
        }
        // Restore topology connections
        if (data.topology && data.topology.length > 0) {
            dutConnections = data.topology;
        } else {
            dutConnections = [];
        }
        // Restore script selection
        if (data.scripts && data.scripts.length > 0) {
            selectedScriptPaths = new Set(data.scripts.map(s => s.path || s));
        } else {
            selectedScriptPaths = new Set();
        }
        // Re-render everything
        renderDUTChecklist();
        renderTopologyCanvas();
        updateDUTMultiSelectText();
        renderJobDropdown();
        _renderNextRunLabel(data);

        // BF-14: Rebuild the Categories & Scripts panel for this job.
        // Always reset first so the previous job's folders/scripts never linger.
        _resetScriptPanel();
        const vmSel = document.getElementById('spy-vm-select');
        const hostId = vmSel ? parseInt(vmSel.value) || null : null;
        if (activeBasePath && hostId) {
            // Job has a saved path + VM — reload its folders/scripts silently.
            // Restored selectedScriptPaths get re-checked where visible.
            navigateToPath('', true);
        } else {
            // Fresh job — leave the panel empty
            updateScriptMultiSelectText();
        }

        // BF-13: Restore the entire execution viewer from this job's latest run
        const latestExec = data.executions && data.executions.length > 0 ? data.executions[0] : null;
        _syncExecutionView(latestExec, data.scripts);

        toast(`Switched to ${data.name}`, 'info', 2000);
    } catch (e) {
        toast('Failed to switch job: ' + e.message, 'error');
    }
}

async function saveJobState(immediate) {
    if (!activeJobId) return;
    if (!immediate) {
        clearTimeout(_jobSaveTimer);
        _jobSaveTimer = setTimeout(() => saveJobState(true), 500);
        return;
    }
    try {
        const vmSel = document.getElementById('spy-vm-select');
        const hostId = vmSel ? parseInt(vmSel.value) || null : null;
        await fetch(`${API}/api/execution-jobs/${activeJobId}`, {
            method: 'PUT',
            headers: getSessionHeaders(),
            body: JSON.stringify({
                dut_ids:   Array.from(selectedDUTIds).map(Number),
                base_path: activeBasePath || '',
                host_id:   hostId,
                topology:  dutConnections || [],
                scripts:   Array.from(selectedScriptPaths).map(p => ({ path: p })),
            }),
        });
    } catch (_) {}
}

async function renameActiveJob() {
    if (!activeJobId) return;
    const job = activeJobList.find(j => j.id === activeJobId);
    const newName = prompt('Job name:', job ? job.name : '');
    if (!newName || !newName.trim()) return;
    try {
        await fetch(`${API}/api/execution-jobs/${activeJobId}`, {
            method: 'PUT',
            headers: getSessionHeaders(),
            body: JSON.stringify({ name: newName.trim() }),
        });
        if (job) job.name = newName.trim();
        renderJobDropdown();
    } catch (e) {
        toast('Rename failed: ' + e.message, 'error');
    }
}

async function deleteActiveJob() {
    if (!activeJobId) return;
    const job = activeJobList.find(j => j.id === activeJobId);
    if (!confirm(`Delete "${job ? job.name : 'this job'}"? This cannot be undone.`)) return;
    try {
        const res = await fetch(`${API}/api/execution-jobs/${activeJobId}`, {
            method: 'DELETE',
            headers: getSessionHeaders(),
        });
        if (!res.ok) {
            const d = await res.json();
            toast(d.detail || 'Delete failed', 'error');
            return;
        }
        activeJobList = activeJobList.filter(j => j.id !== activeJobId);
        activeJobId = null;
        const _nrEl = document.getElementById('job-next-run');
        if (_nrEl) { _nrEl.textContent = ''; _nrEl.style.display = 'none'; }
        if (activeJobList.length > 0) {
            await switchJob(activeJobList[0].id);
        } else {
            renderJobDropdown();
        }
        toast('Job deleted', 'success');
    } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
    }
}

async function checkDUTConflicts(dutIds) {
    if (!activeJobId || !dutIds || dutIds.length === 0) return;
    try {
        const res = await fetch(
            `${API}/api/execution-jobs/${activeJobId}/conflicts?dut_ids=${dutIds.join(',')}`,
            { headers: getSessionHeaders() }
        );
        if (!res.ok) return;
        const data = await res.json();
        const banner = document.getElementById('conflict-banner');
        if (!banner) return;
        if (data.conflicts && data.conflicts.length > 0) {
            const msgs = data.conflicts.map(c => {
                const label = c.conflict_type === 'runtime'
                    ? `<strong>${esc(c.dut_name)}</strong> is currently locked by <strong>${esc(c.conflicting_job_name)}</strong> (execution running)`
                    : `<strong>${esc(c.dut_name)}</strong> is already selected in <strong>${esc(c.conflicting_job_name)}</strong>`;
                return label;
            });
            banner.innerHTML = `<span class="material-icons-round" style="font-size:14px">warning</span> ${msgs.join(' &bull; ')} &nbsp;<span style="cursor:pointer;opacity:0.6" onclick="this.parentElement.classList.remove('visible')">✕</span>`;
            banner.classList.add('visible');
        } else {
            banner.classList.remove('visible');
        }
    } catch (_) {}
}

async function downloadJobReport(type) {
    if (!activeJobId) {
        toast('This run has no job — use the HTML/Excel buttons in Live Results instead', 'info');
        return;
    }
    // Must use fetch (not window.open) so the X-Session-ID header is sent — the job
    // report endpoint filters by session and returns "Job not found" without it.
    try {
        const res = await fetch(`${API}/api/execution-jobs/${activeJobId}/report/${type}`,
            { headers: getSessionHeaders() });
        if (!res.ok) {
            let detail = res.status;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            toast(`Job report failed: ${detail}`, 'error');
            return;
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `job_${activeJobId}_report.${type === 'excel' ? 'xlsx' : 'html'}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
    } catch (e) {
        toast(`Job report error: ${e.message}`, 'error');
    }
}

// ── Rerun (full batch / failed-only) ─────────────────────────────────────────
function _showRerunButtons() {
    const allBtn = document.getElementById('btn-rerun-all');
    const failBtn = document.getElementById('btn-rerun-failed');
    if (allBtn) allBtn.style.display = (_lastRunScriptPaths && _lastRunScriptPaths.length) ? '' : 'none';
    if (failBtn) {
        const n = (_lastRunFailedPaths || []).length;
        failBtn.style.display = n ? '' : 'none';
        const lbl = document.getElementById('rerun-failed-count');
        if (lbl) lbl.textContent = n ? ` (${n})` : '';
    }
}

function _hideRerunButtons() {
    const allBtn = document.getElementById('btn-rerun-all');
    const failBtn = document.getElementById('btn-rerun-failed');
    if (allBtn) allBtn.style.display = 'none';
    if (failBtn) failBtn.style.display = 'none';
}

// Restore the given scripts + the last run's DUT selection, then start a new run.
function _rerunWith(paths) {
    if (!paths || !paths.length) { toast('Nothing to rerun', 'warning'); return; }
    selectedScriptPaths = new Set(paths);
    selectedDUTIds = new Set(_lastRunDUTIds || []);
    try { if (typeof renderScriptsDropdown === 'function') renderScriptsDropdown(); } catch (_) {}
    try { if (typeof renderDUTChecklist === 'function') renderDUTChecklist(); } catch (_) {}
    try { if (typeof updateSelectedScriptsCount === 'function') updateSelectedScriptsCount(); } catch (_) {}
    try { if (typeof updateSpyStartBtn === 'function') updateSpyStartBtn(); } catch (_) {}
    _hideRerunButtons();
    startExecution();
}

function rerunAll() {
    if (!_lastRunScriptPaths || !_lastRunScriptPaths.length) {
        toast('No previous batch to rerun', 'warning'); return;
    }
    toast(`Rerunning all ${_lastRunScriptPaths.length} script(s)…`, 'info');
    _rerunWith(_lastRunScriptPaths);
}

function rerunFailed() {
    if (!_lastRunFailedPaths || !_lastRunFailedPaths.length) {
        toast('No failed scripts to rerun 🎉', 'success'); return;
    }
    toast(`Rerunning ${_lastRunFailedPaths.length} failed script(s)…`, 'info');
    _rerunWith(_lastRunFailedPaths);
}

function _updateJobStatusBadge(status) {
    const badge = document.getElementById('job-status-badge');
    if (!badge) return;
    badge.textContent = status;
    badge.className = `job-status-badge ${status}`;
    const job = activeJobList.find(j => j.id === activeJobId);
    if (job) job.status = status;
    const resetBtn = document.getElementById('btn-reset-job');
    if (resetBtn) resetBtn.style.display = status === 'running' ? '' : 'none';
    renderJobDropdown();
}

async function resetJobToIdle() {
    if (!activeJobId) return;
    if (!confirm('Reset this job back to idle? Use this only if the job is stuck.')) return;
    try {
        const res = await fetch(`${API}/api/execution-jobs/${activeJobId}`, {
            method: 'PUT',
            headers: { ...getSessionHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'idle' }),
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Reset failed');
        _updateJobStatusBadge('idle');
        toast('Job reset to idle', 'success');
    } catch (e) {
        toast(`Reset failed: ${e.message}`, 'error');
    }
}

// ── Job Scheduler UI ─────────────────────────────────────────────────────────

async function openScheduleModal() {
    if (!activeJobId) return;
    const modal = document.getElementById('schedule-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    // Always reset fields first so stale values from a previous job never show
    document.querySelectorAll('input[name="sched-type"]').forEach(r => { r.checked = r.value === 'none'; });
    document.getElementById('sched-at-input').value = '';
    document.getElementById('sched-cron-preset').value = 'daily';
    document.getElementById('sched-daily-time').value = '';
    document.getElementById('sched-cron-expr').value = '';
    const infoEl = document.getElementById('sched-info');
    if (infoEl) infoEl.textContent = '';
    onSchedTypeChange();
    onCronPresetChange();

    // Load current schedule from server
    try {
        const res = await fetch(`${API}/api/execution-jobs/${activeJobId}/schedule`,
            { headers: getSessionHeaders() });
        const data = res.ok ? await res.json() : {};

        // Set radio to actual schedule type
        const stype = data.schedule_type || 'none';
        document.querySelectorAll('input[name="sched-type"]').forEach(r => { r.checked = r.value === stype; });
        onSchedTypeChange();

        // Populate once field — only if this job actually has a schedule_at
        if (data.schedule_at) {
            const d = new Date(data.schedule_at + 'Z');
            const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                .toISOString().slice(0, 16);
            document.getElementById('sched-at-input').value = local;
        }

        // Populate cron fields — only if this job has a cron expression
        if (data.schedule_cron) {
            const expr = data.schedule_cron;
            if (/^\d{1,2}:\d{2}$/.test(expr)) {
                document.getElementById('sched-cron-preset').value = 'daily';
                document.getElementById('sched-daily-time').value = expr;
            } else if (expr === '0 * * * *' || expr === '*/60') {
                document.getElementById('sched-cron-preset').value = 'hourly';
            } else {
                document.getElementById('sched-cron-preset').value = 'custom';
                document.getElementById('sched-cron-expr').value = expr;
            }
            onCronPresetChange();
        }

        // Info line
        const parts = [];
        if (data.last_run_at) parts.push(`Last run: ${new Date(data.last_run_at + 'Z').toLocaleString()}`);
        if (data.next_run) {
            try {
                parts.push(`Next run: ${new Date(data.next_run.replace(' UTC', 'Z').replace(' ', 'T')).toLocaleString()}`);
            } catch (_) {
                parts.push(`Next run: ${data.next_run}`);
            }
        }
        if (infoEl) infoEl.textContent = parts.join('  ·  ');
    } catch (_) {}
}

function closeScheduleModal() {
    const modal = document.getElementById('schedule-modal');
    if (modal) modal.style.display = 'none';
}

function onSchedTypeChange() {
    const type = document.querySelector('input[name="sched-type"]:checked')?.value || 'none';
    document.getElementById('sched-once-row').style.display = type === 'once' ? '' : 'none';
    document.getElementById('sched-cron-row').style.display = type === 'cron' ? '' : 'none';
}

function onCronPresetChange() {
    const preset = document.getElementById('sched-cron-preset')?.value;
    document.getElementById('sched-daily-row').style.display  = preset === 'daily'  ? '' : 'none';
    document.getElementById('sched-custom-row').style.display = preset === 'custom' ? '' : 'none';
}

async function saveSchedule() {
    if (!activeJobId) return;
    // Flush current state immediately before registering the schedule so the
    // scheduler always reads up-to-date scripts, host_id, and base_path from DB.
    await saveJobState(true);
    const type = document.querySelector('input[name="sched-type"]:checked')?.value || 'none';
    const body = { schedule_type: type, enabled: true };

    if (type === 'once') {
        const val = document.getElementById('sched-at-input').value;
        if (!val) { toast('Please pick a date and time', 'error'); return; }
        // Convert local datetime-local to UTC ISO
        body.schedule_at = new Date(val).toISOString();
    } else if (type === 'cron') {
        const preset = document.getElementById('sched-cron-preset').value;
        if (preset === 'daily') {
            body.schedule_cron = document.getElementById('sched-daily-time').value; // "HH:MM"
        } else if (preset === 'hourly') {
            body.schedule_cron = '0 * * * *';
        } else {
            body.schedule_cron = document.getElementById('sched-cron-expr').value.trim();
            if (!body.schedule_cron) { toast('Please enter a cron expression', 'error'); return; }
        }
    } else {
        body.enabled = false;
    }

    try {
        const res = await fetch(`${API}/api/execution-jobs/${activeJobId}/schedule`, {
            method: 'PUT',
            headers: getSessionHeaders(),
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const d = await res.json();
            toast(d.detail || 'Failed to save schedule', 'error');
            return;
        }
        const data = await res.json();
        closeScheduleModal();
        _renderNextRunLabel(data);
        const typeLabels = { none: 'disabled', once: `once at ${data.schedule_at?.slice(0,16).replace('T',' ')} UTC`, cron: data.schedule_cron };
        toast(`Schedule saved — ${typeLabels[data.schedule_type] || type}`, 'success');
    } catch (e) {
        toast('Save failed: ' + e.message, 'error');
    }
}

function _renderNextRunLabel(data) {
    const el = document.getElementById('job-next-run');
    if (!el) return;
    if (data && data.schedule_enabled && data.schedule_type && data.schedule_type !== 'none') {
        if (data.next_run) {
            try {
                const utcStr = data.next_run.replace(' UTC', 'Z').replace(' ', 'T');
                const local  = new Date(utcStr).toLocaleString([], {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                });
                el.textContent = `⏰ Next: ${local}`;
            } catch (_) {
                el.textContent = `⏰ ${data.next_run}`;
            }
        } else {
            // schedule_enabled but next_run not yet computed (scheduler still loading)
            const typeHint = data.schedule_type === 'once' && data.schedule_at
                ? new Date(data.schedule_at + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : data.schedule_cron || '';
            el.textContent = `⏰ Scheduled${typeHint ? ': ' + typeHint : ''}`;
        }
        el.style.display = '';
    } else {
        el.style.display = 'none';
    }
}

// ── Scheduled-run live log watcher ───────────────────────────────────────────
// Polls the active job every 5 s. When a scheduled run starts (execution_id
// we didn't launch manually), it connects the WebSocket so logs stream live
// and the Stop button appears — identical to a manual run.

let _jobPollTimer = null;
let _jobPollLastExecId = null;

function _startJobPoller() {
    _stopJobPoller();
    _jobPollTimer = setInterval(_pollActiveJob, 5000);
}

function _stopJobPoller() {
    if (_jobPollTimer) { clearInterval(_jobPollTimer); _jobPollTimer = null; }
}

async function _pollActiveJob() {
    if (!activeJobId) return;
    try {
        const res = await fetch(`${API}/api/execution-jobs/${activeJobId}`, { headers: getSessionHeaders() });
        if (!res.ok) return;
        const data = await res.json();

        // Update status badge
        _updateJobStatusBadge(data.status);
        _renderNextRunLabel(data);

        if (data.executions && data.executions.length > 0) {
            const latestExec = data.executions[0]; // most recent first
            // A new execution we haven't wired up yet (e.g. a scheduled run that
            // started on the job currently being viewed).
            if (latestExec.id !== currentExecId && latestExec.id !== _jobPollLastExecId) {
                if (latestExec.status === 'running' || latestExec.status === 'pending') {
                    // BF-13: restore the full viewer (logs + queue + live results)
                    _syncExecutionView(latestExec, data.scripts);
                    toast(`Scheduled run started — Execution #${latestExec.id}`, 'info');
                } else if (latestExec.status === 'failed') {
                    // Execution failed before we could connect (e.g., SSH error)
                    _jobPollLastExecId = latestExec.id;
                    toast(`Scheduled run #${latestExec.id} failed — check Logs tab for details`, 'error');
                }
            }
        }
    } catch (_) {}

    // BF-10: Sweep all background jobs for status changes
    _sweepBackgroundJobs();
}

async function _sweepBackgroundJobs() {
    if (activeJobList.length <= 1) return;
    try {
        const res = await fetch(`${API}/api/execution-jobs`, { headers: getSessionHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const jobs = data.jobs || [];
        jobs.forEach(j => {
            if (j.id === activeJobId) return; // active job handled by main poller
            const prev = _jobStatusSnapshot[j.id];
            if (prev !== undefined && prev !== j.status) {
                // Status changed on a background job — notify the user
                if (j.status === 'running') {
                    toast(`Job "${j.name}" started (scheduled run)`, 'info');
                } else if (j.status === 'completed') {
                    toast(`Job "${j.name}" completed`, 'success');
                } else if (j.status === 'failed') {
                    toast(`Job "${j.name}" failed — switch to it for details`, 'error');
                }
            }
            _jobStatusSnapshot[j.id] = j.status;
        });
        // Update the dropdown badges for all jobs so status colours stay current
        activeJobList = jobs;
        renderJobDropdown();
    } catch (_) {}
}

// Close modal on backdrop click
document.addEventListener('click', e => {
    const modal = document.getElementById('schedule-modal');
    if (modal && e.target === modal) closeScheduleModal();
});

function updateDUTMultiSelectText() {
    const textEl = document.querySelector('#dut-multi-select .multi-select-text');
    if (!textEl) return;
    const count = selectedDUTIds.size;
    if (count === 0) {
        textEl.textContent = '-- Select DUTs --';
        textEl.classList.remove('has-value');
    } else {
        const duts = dutsData.filter(d => selectedDUTIds.has(d.id));
        textEl.textContent = duts.map(d => d.name).join(', ');
        textEl.classList.add('has-value');
    }
}

async function onSpyVMChange() {
    const vmId = document.getElementById('spy-vm-select').value;
    const scriptsList = document.getElementById('script-dropdown-list');
    const testbedSel = document.getElementById('spy-testbed');
    const subfoldersEl = document.getElementById('subfolders-list');

    // Reset state - clear ALL selections when changing VM or refreshing
    console.log(`onSpyVMChange: Clearing ${selectedScriptPaths.size} selected scripts`);
    selectedScriptPaths.clear();
    scriptsData = [];
    currentFolderPath = '';
    activeBasePath = '';
    const basePathInput = document.getElementById('scripts-base-path');
    if (basePathInput) basePathInput.value = '';
    scriptsList.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Select VM to load folders and scripts.</p>';
    updateScriptMultiSelectText();

    // Reset subfolders
    if (subfoldersEl) {
        subfoldersEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Select VM to load folders.</p>';
    }
    updateBreadcrumb('');
    const subfolderCountEl = document.getElementById('subfolder-count');
    if (subfolderCountEl) subfolderCountEl.textContent = '0';
    const scriptsCountEl = document.getElementById('scripts-count');
    if (scriptsCountEl) scriptsCountEl.textContent = '0';

    // Reset testbed
    if (testbedSel) {
        testbedSel.innerHTML = '<option value="">-- Select VM first --</option>';
        testbedSel.disabled = true;
    }

    if (!vmId) {
        updateSpyStartBtn();
        return;
    }

    // Load testbed YAML files
    if (testbedSel) {
        testbedSel.innerHTML = '<option value="">Loading testbeds...</option>';
        try {
            const tbRes = await fetch(`${API}/api/spytest/testbeds?host_id=${vmId}`);
            if (!tbRes.ok) throw new Error(`Server returned ${tbRes.status}`);
            const tbData = await tbRes.json();
            const testbeds = tbData.testbeds || [];
            testbedSel.innerHTML = '<option value="">-- Select a testbed --</option>' +
                testbeds.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
            testbedSel.disabled = false;
            toast(`Loaded ${testbeds.length} testbed files`, 'success');
        } catch (e) {
            testbedSel.innerHTML = '<option value="">-- Failed to load --</option>';
            toast(`Failed to load testbeds: ${e.message}`, 'error');
        }
    }

    // Scripts are loaded only when the user explicitly enters a path and clicks Load
    const subfoldersEl2 = document.getElementById('subfolders-list');
    const scriptsEl2    = document.getElementById('script-dropdown-list');
    if (subfoldersEl2) subfoldersEl2.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Enter a path above and click Load.</p>';
    if (scriptsEl2)    scriptsEl2.innerHTML    = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Enter a path above and click Load.</p>';

    updateSpyStartBtn();
    // Persist the new VM selection (and the cleared script/path state) to the job record
    saveJobState();
}

// ============================================================
// EXECUTE — HIERARCHICAL CATEGORY & SCRIPT NAVIGATION
// ============================================================

let selectedScriptPaths = new Set();
let currentFolderPath = '';   // Current folder path (e.g., "routing/bgp")
let activeBasePath    = '';   // User-supplied base path on the VM

function loadScriptsFromPath() {
    const input = document.getElementById('scripts-base-path');
    const raw = (input ? input.value : '').trim().replace(/\/+$/, ''); // strip trailing slashes
    if (!raw) { toast('Please enter a path first', 'warning'); return; }
    const vmId = document.getElementById('spy-vm-select').value;
    if (!vmId) { toast('Please select a VM first', 'warning'); return; }
    activeBasePath = raw;
    saveJobState();
    navigateToPath('');
}

// BF-14: Reset the "Categories & Scripts" panel to its fresh, empty state.
// Clears the global script data plus the subfolders list, script dropdown,
// breadcrumb and counts so no stale content leaks across a job switch.
function _resetScriptPanel() {
    scriptsData = [];
    currentFolderPath = '';
    const subfoldersEl = document.getElementById('subfolders-list');
    if (subfoldersEl) subfoldersEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Enter a path above and click Load.</p>';
    const scriptsEl = document.getElementById('script-dropdown-list');
    if (scriptsEl) scriptsEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Enter a path above and click Load.</p>';
    updateBreadcrumb('');
    const subfolderCountEl = document.getElementById('subfolder-count');
    if (subfolderCountEl) subfolderCountEl.textContent = '0';
    const scriptsCountEl = document.getElementById('scripts-count');
    if (scriptsCountEl) scriptsCountEl.textContent = '0';
    const inspector = document.getElementById('script-inspector');
    if (inspector) inspector.style.display = 'none';
    updateScriptMultiSelectText();
}

/**
 * Navigate to a specific folder path and load its contents
 * @param {string} path - Relative path from tests directory (empty string for root)
 * @param {boolean} silent - Suppress the success toast (used when restoring a job)
 */
async function navigateToPath(path, silent) {
    console.log(`Navigating to path: "${path}"`);
    const vmId = document.getElementById('spy-vm-select').value;

    if (!vmId) {
        toast('Please select a VM first', 'error');
        return;
    }

    currentFolderPath = path;

    // KEEP selections across folders - accumulate script selections
    console.log(`Keeping ${selectedScriptPaths.size} previously selected scripts`);
    scriptsData = [];  // Clear current scripts data (will be repopulated)

    // Show loading state
    const subfoldersContainer = document.getElementById('subfolders-container');
    const subfoldersEl = document.getElementById('subfolders-list');
    const scriptsEl = document.getElementById('script-dropdown-list');

    subfoldersEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0"><span class="material-icons-round spin" style="font-size:14px;vertical-align:middle">sync</span> Loading...</p>';
    scriptsEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0"><span class="material-icons-round spin" style="font-size:14px;vertical-align:middle">sync</span> Loading...</p>';

    try {
        // Fetch folder contents using the new browse API
        // NOTE: Starlette's {path:path} requires at least one char — use /browse (no slash)
        // for root and /browse/<path> for sub-folders so routing always matches.
        const pathSegment = path ? `/${encodeURIComponent(path)}` : '';
        let url = `${API}/api/spytest/browse${pathSegment}?host_id=${vmId}`;
        if (activeBasePath) url += `&base_path=${encodeURIComponent(activeBasePath)}`;
        console.log(`Fetching: ${url}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        console.log('Browse data:', data);

        // Show warning if the tests directory doesn't exist on this VM
        if (data.warning) {
            toast(data.warning, 'warning');
            if (subfoldersEl) subfoldersEl.innerHTML = `<p class="muted" style="padding:8px;font-size:12px;margin:0">${data.warning}</p>`;
            if (scriptsEl)    scriptsEl.innerHTML    = '<p class="muted" style="padding:8px;font-size:12px;margin:0">No scripts available.</p>';
            updateBreadcrumb(path);
            return;
        }

        // Update breadcrumb
        updateBreadcrumb(path);

        // Render subfolders
        console.log(`Subfolders count: ${data.subfolders ? data.subfolders.length : 0}`);
        if (data.subfolders && data.subfolders.length > 0) {
            console.log('Rendering subfolders:', data.subfolders);
            renderSubfolders(data.subfolders, path);
        } else {
            console.log('No subfolders in this folder');
            // Show empty state message
            if (subfoldersEl) {
                subfoldersEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">No subfolders in this folder.</p>';
            }
        }

        // Render scripts
        scriptsData = data.scripts || [];
        renderScriptsDropdown();

        // Update counts
        document.getElementById('subfolder-count').textContent = data.subfolder_count || 0;
        document.getElementById('scripts-count').textContent = data.script_count || 0;

        // Show toast
        if (!silent) {
            const pathDisplay = path || 'root';
            toast(`Loaded ${data.subfolder_count} folders, ${data.script_count} scripts from ${pathDisplay}`, 'success');
        }

    } catch (e) {
        console.error('Error in navigateToPath:', e);
        if (subfoldersEl) subfoldersEl.innerHTML = `<p class="muted" style="padding:8px;font-size:12px;margin:0;color:var(--red)">Error: ${esc(e.message)}</p>`;
        if (scriptsEl) scriptsEl.innerHTML = `<p class="muted" style="padding:8px;font-size:12px;margin:0;color:var(--red)">Error: ${esc(e.message)}</p>`;
        toast(`Failed to load folder: ${e.message}`, 'error');
    }

    updateSpyStartBtn();
}

/**
 * Update breadcrumb navigation based on current path
 */
function updateBreadcrumb(path) {
    const breadcrumb = document.getElementById('category-breadcrumb');
    let html = `<span class="breadcrumb-item ${!path ? 'active' : ''}" onclick="navigateToPath('')" title="Go to root">
        <span class="material-icons-round" style="font-size:14px;vertical-align:middle">home</span>
        Home
    </span>`;

    if (path) {
        const parts = path.split('/');
        parts.forEach((part, index) => {
            const partPath = parts.slice(0, index + 1).join('/');
            const isLast = index === parts.length - 1;

            html += `<span class="breadcrumb-separator">›</span>`;
            html += `<span class="breadcrumb-item ${isLast ? 'active' : ''}"
                     onclick="navigateToPath('${esc(partPath)}')"
                     title="${isLast ? 'Current folder' : 'Go to ' + esc(part)}">
                ${esc(part)}
            </span>`;
        });
    }

    breadcrumb.innerHTML = html;
}

/**
 * Render subfolder list as clickable cards
 */
function renderSubfolders(subfolders, currentPath) {
    const el = document.getElementById('subfolders-list');
    console.log('renderSubfolders called with:', subfolders, 'currentPath:', currentPath);

    if (!el) {
        console.error('subfolders-list element not found!');
        return;
    }

    let html = '';

    subfolders.forEach(folder => {
        const newPath = currentPath ? `${currentPath}/${folder}` : folder;
        html += `<div class="folder-item" onclick="navigateToPath('${esc(newPath)}')" title="Open ${esc(folder)}">
            <span class="material-icons-round">folder</span>
            <span>${esc(folder)}</span>
        </div>`;
    });

    console.log('Generated subfolder HTML length:', html.length);
    el.innerHTML = html;
    console.log('Subfolders rendered successfully');
}

/**
 * Legacy function - now redirects to navigateToPath for backward compatibility
 */
async function onCategoryChange() {
    // This function is kept for backward compatibility
    // New navigation uses navigateToPath()
    await navigateToPath('');
}

function renderScriptsDropdown() {
    const el = document.getElementById('script-dropdown-list');
    if (!el) return;

    console.log(`renderScriptsDropdown: ${scriptsData.length} scripts, ${selectedScriptPaths.size} selected`);

    if (!scriptsData.length) {
        el.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">No scripts found in this folder.</p>';
        updateScriptMultiSelectText();
        return;
    }
    // Sticky search bar to filter scripts by name/path
    let html = `<div class="script-search-wrap" style="position:sticky;top:0;z-index:2;padding:6px;background:var(--bg-secondary);border-bottom:1px solid var(--border)">
        <input type="text" id="script-search-input" placeholder="🔍 Search scripts…"
            oninput="filterScriptDropdown(this.value)" onclick="event.stopPropagation()"
            style="width:100%;padding:6px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);box-sizing:border-box">
    </div>
    <label class="multi-select-item select-all">
        <input type="checkbox" onchange="toggleAllScripts(this)"> Select All
    </label>`;

    let checkedCount = 0;
    scriptsData.forEach(s => {
        const isChecked = selectedScriptPaths.has(s.path);
        if (isChecked) checkedCount++;
        const checked = isChecked ? 'checked' : '';
        const hay = esc((s.name + ' ' + s.path).toLowerCase());
        html += `<label class="multi-select-item" data-search="${hay}">
            <input type="checkbox" value="${esc(s.path)}" ${checked} onchange="onScriptCheckboxChange('${esc(s.path)}', this)">
            <div class="item-label">
                <div class="item-name">${esc(s.name)}</div>
                <div class="item-sub">${esc(s.path)}</div>
            </div>
        </label>`;
    });

    console.log(`Rendered ${scriptsData.length} scripts, ${checkedCount} are checked`);
    el.innerHTML = html;
    updateScriptMultiSelectText();
}

// Live-filter the script dropdown by name/path. Also shows a "no match" hint.
function filterScriptDropdown(query) {
    const el = document.getElementById('script-dropdown-list');
    if (!el) return;
    const q = (query || '').trim().toLowerCase();
    let shown = 0;
    el.querySelectorAll('.multi-select-item:not(.select-all)').forEach(item => {
        const hay = item.dataset.search || item.textContent.toLowerCase();
        const match = !q || hay.includes(q);
        item.style.display = match ? '' : 'none';
        if (match) shown++;
    });
    // Manage a "no results" line
    let empty = el.querySelector('.script-search-empty');
    if (q && shown === 0) {
        if (!empty) {
            empty = document.createElement('p');
            empty.className = 'script-search-empty muted';
            empty.style.cssText = 'padding:8px;font-size:12px;margin:0';
            el.appendChild(empty);
        }
        empty.textContent = `No scripts match “${query}”`;
        empty.style.display = '';
    } else if (empty) {
        empty.style.display = 'none';
    }
}

function onScriptCheckboxChange(scriptPath, cb) {
    // Enhancement 2: If deselecting during a LIVE execution, show cancel confirmation.
    // Gate on currentExecActive (not just currentExecId): currentExecId lingers after a run
    // completes or after the execution is deleted from the Logs tab, so unchecking a script
    // then would fire cancel-script against a dead id → "Execution not found" (Session 14).
    if (!cb.checked && currentExecId && currentExecActive) {
        // User is trying to deselect a script during execution
        // Show confirmation dialog
        cb.checked = true;  // Re-check for now
        showCancelConfirmation(scriptPath);   // pass full path so we can deselect it on confirm
        return;
    }

    if (cb.checked) selectedScriptPaths.add(scriptPath); else selectedScriptPaths.delete(scriptPath);
    updateScriptMultiSelectText();
    const selectAllCb = document.querySelector('#script-dropdown-list .select-all input');
    if (selectAllCb) {
        const itemCbs = Array.from(document.querySelectorAll('#script-dropdown-list .multi-select-item:not(.select-all) input[type=checkbox]'));
        selectAllCb.checked = itemCbs.length > 0 && itemCbs.every(c => c.checked);
    }
    updateSpyStartBtn();
    // Script Inspector: show info for exactly one selected script
    const inspector = document.getElementById('script-inspector');
    if (inspector) {
        if (selectedScriptPaths.size === 1) {
            fetchScriptInfo(Array.from(selectedScriptPaths)[0]);
        } else {
            inspector.style.display = 'none';
        }
    }
    saveJobState();
}

function toggleAllScripts(cb) {
    // Only toggle items visible under the current search filter (a hidden item's
    // parent label has display:none), so "Select All" while searching selects
    // just the matches.
    const items = document.querySelectorAll('#script-dropdown-list .multi-select-item:not(.select-all) input[type=checkbox]');
    items.forEach(item => {
        const label = item.closest('.multi-select-item');
        if (label && label.style.display === 'none') return;   // skip filtered-out items
        item.checked = cb.checked;
        const path = item.value;
        if (cb.checked) selectedScriptPaths.add(path); else selectedScriptPaths.delete(path);
    });
    updateScriptMultiSelectText();
    updateSpyStartBtn();
    saveJobState();
}

function updateScriptMultiSelectText() {
    const textEl = document.querySelector('#script-multi-select .multi-select-text');
    if (!textEl) return;
    const count = selectedScriptPaths.size;
    if (count === 0) {
        textEl.textContent = '-- Select Scripts --';
        textEl.classList.remove('has-value');
    } else {
        const names = scriptsData.filter(s => selectedScriptPaths.has(s.path)).map(s => s.name);
        textEl.textContent = count === scriptsData.length ? `All Scripts (${count})` : names.join(', ');
        textEl.classList.add('has-value');
    }
}

function getSelectedScriptPaths() {
    return Array.from(selectedScriptPaths);
}

// ============================================================
// MULTI-SELECT TOGGLE
// ============================================================

function toggleMultiSelect(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const isOpen = container.classList.contains('open');
    // Close all open multi-selects first
    document.querySelectorAll('.multi-select.open').forEach(el => el.classList.remove('open'));
    if (!isOpen) container.classList.add('open');
}

// Close multi-selects when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select')) {
        document.querySelectorAll('.multi-select.open').forEach(el => el.classList.remove('open'));
    }
});

// ============================================================
// QUEUE STATUS POLLING
// ============================================================

function startQueuePolling(execId) {
    stopQueuePolling();
    _queuePollTimer = setInterval(() => pollQueueStatus(execId), 3000);
    pollQueueStatus(execId); // immediate first call
}

function stopQueuePolling() {
    if (_queuePollTimer) { clearInterval(_queuePollTimer); _queuePollTimer = null; }
}

// ── Live log polling (REST) ─────────────────────────────────────────────────
// The /ws/execution WebSocket only reliably delivers the final drain at completion
// (its long-lived read transaction can miss rows committed mid-run). Polling the
// REST logs endpoint sidesteps that entirely — each request is a fresh transaction
// that sees everything committed so far — so the Live Execution Logs panel streams
// during the run. De-duped by id via _seenExecLogIds (shared with the WS path).
let _execLogPollTimer = null;
let _execLogMaxId = 0;

async function _pollExecLogsOnce(execId) {
    try {
        const res = await fetch(`${API}/api/executions/${execId}/logs?after_id=${_execLogMaxId}&limit=3000`,
            { headers: getSessionHeaders() });
        if (!res.ok) return;
        const logs = await res.json();
        if (!Array.isArray(logs)) return;
        for (const log of logs) {
            if (log.id != null) {
                if (log.id > _execLogMaxId) _execLogMaxId = log.id;
                if (_seenExecLogIds.has(log.id)) continue;
                _seenExecLogIds.add(log.id);
            }
            if (log.message && log.message.startsWith('[QUEUE]')) continue;
            allLogs.push(log);
            appendLogEntry(log);
        }
    } catch (_) { /* transient — next tick retries */ }
}

function startExecLogPolling(execId) {
    stopExecLogPolling();
    _execLogMaxId = 0;
    _pollExecLogsOnce(execId);                 // immediate first fetch
    _execLogPollTimer = setInterval(() => _pollExecLogsOnce(execId), 1500);
}

function stopExecLogPolling() {
    if (_execLogPollTimer) { clearInterval(_execLogPollTimer); _execLogPollTimer = null; }
}

async function pollQueueStatus(execId) {
    // Completion fallback: if the WebSocket never delivered `execution_complete`
    // (flaky WS), detect the finished run here and finalize the UI (Stop→Start,
    // Rerun buttons, enable downloads) instead of staying stuck in "running".
    if (!_execCompleteHandled) {
        try {
            const sres = await fetch(`${API}/api/executions/${execId}`, { headers: getSessionHeaders() });
            if (sres.ok) {
                const ex = await sres.json();
                if (['completed', 'failed', 'cancelled'].includes(ex.status)) {
                    handleExecutionComplete(ex.status, ex.duration);
                    return;
                }
            }
        } catch (_) {}
    }
    try {
        const res = await fetch(`${API}/api/execution-queue`);
        if (!res.ok) {
            // Endpoint might not exist on old server — show error in panel
            _showQueueLoading('Server error — restart required');
            return;
        }
        const allQueues = await res.json();
        // JSON keys are always strings; execId may be a number — try both
        const state = allQueues[execId] || allQueues[String(execId)];
        if (!state) {
            // State not initialised yet (very first poll) — show loading
            _showQueueLoading('Connecting…');
            return;
        }
        updateQueuePanel(state);
        // Drive Live Results live from per-script aggregates the runner publishes
        (state.script_results || []).forEach(r => updateLiveResults(r));
    } catch (_) { }
}

function _showQueueLoading(msg) {
    const el = document.getElementById('queue-scripts-list');
    if (el) el.innerHTML = `<span class="muted" style="font-size:12px">${msg}</span>`;
}

function updateQueuePanel(state) {
    const freeDutsEl  = document.getElementById('queue-free-duts');
    const busyDutsEl  = document.getElementById('queue-busy-duts');
    const scriptsEl   = document.getElementById('queue-scripts-list');
    if (!freeDutsEl || !busyDutsEl || !scriptsEl) return;

    const allDuts  = state.all_duts  || [];
    const freeDuts = state.free_duts || [];
    const busyDuts = allDuts.filter(d => !freeDuts.includes(d));

    // Free DUTs
    freeDutsEl.innerHTML = freeDuts.length
        ? freeDuts.map(d => `<span class="queue-dut-chip free">${esc(d)}</span>`).join('')
        : '<span class="muted" style="font-size:12px">None</span>';

    // Busy DUTs
    busyDutsEl.innerHTML = busyDuts.length
        ? busyDuts.map(d => `<span class="queue-dut-chip busy">${esc(d)}</span>`).join('')
        : '<span class="muted" style="font-size:12px">None</span>';

    // Scripts
    const scripts = state.scripts || [];
    // Track each script's live status and re-apply the "Show Only Running" filter,
    // so waiting/queued panes are hidden (not just completed ones).
    scripts.forEach(s => { if (s.name) scriptStatuses[s.name] = s.status; });
    _applyRunningFilter();
    const statusMeta = {
        queued:  { icon: 'hourglass_empty', cls: 'pending',   label: 'Queued'  },
        waiting: { icon: 'schedule',        cls: 'pending',   label: 'Waiting' },
        running: { icon: 'play_circle',     cls: 'running',   label: 'Running' },
        done:    { icon: 'check_circle',    cls: 'completed', label: 'Done'    },
        failed:  { icon: 'error',           cls: 'failed',    label: 'Failed'  },
        skipped: { icon: 'block',           cls: 'pending',   label: 'Skipped (topology)' },
    };
    scriptsEl.innerHTML = scripts.map(s => {
        const m = statusMeta[s.status] || statusMeta.queued;
        const dutsChip = s.duts && s.duts.length
            ? `<span style="font-size:10px;color:var(--text-secondary);margin-left:6px">→ ${esc(s.duts.join(' + '))}</span>`
            : '';
        return `
            <div class="queue-script-row">
                <span class="material-icons-round" style="font-size:15px;color:var(--${m.cls === 'running' ? 'blue' : m.cls === 'completed' ? 'green' : m.cls === 'failed' ? 'red' : 'orange'})"
                    title="${m.label}">${m.icon}</span>
                <span class="badge ${m.cls}" style="font-size:10px;padding:2px 7px">${m.label}</span>
                <span style="font-size:12px;font-family:var(--mono)">${esc(s.name)}</span>
                ${dutsChip}
            </div>`;
    }).join('');
}

// ============================================================
// EXECUTION — START / STOP
// ============================================================

/**
 * Reset execution state after completion - unselect all scripts and DUTs
 */
function resetExecutionState() {
    stopExecLogPolling();   // safety net — ensure the live-log poller is stopped
    // Clear script selections
    selectedScriptPaths.clear();
    document.querySelectorAll('.script-item input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });

    // Clear DUT selections
    selectedDUTIds.clear();
    document.querySelectorAll('.dut-card input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });

    // Update selection count displays
    const scriptCountEl = document.getElementById('selected-scripts-count');
    if (scriptCountEl) scriptCountEl.textContent = '0 scripts selected';

    const dutCountEl = document.getElementById('selected-duts-count');
    if (dutCountEl) dutCountEl.textContent = '0 devices selected';

    // Refresh DUT display to remove 'selected' highlighting
    loadDUTs();

    // Enhancement 1: Clear auto-hide state for completed scripts
    completedScripts.clear();
    scriptStatuses = {};
    Object.keys(scriptHideTimers).forEach(key => clearTimeout(scriptHideTimers[key]));
    scriptHideTimers = {};
    // Default to "only running" — a completed script's log pane is hidden the moment it
    // finishes, so the Live Execution Logs section only shows scripts that are still running.
    showOnlyRunning = true;
    const btn = document.getElementById('btn-show-only-running');
    if (btn) {
        btn.classList.add('active');
        btn.title = 'Show all scripts (including completed)';
        const icon = btn.querySelector('.material-icons-round');
        if (icon) icon.textContent = 'visibility';
        const lbl = document.getElementById('show-only-running-label');
        if (lbl) lbl.textContent = 'Show All';
    }

    // Enhancement 2: Hide add scripts button
    const addScriptsBtn = document.getElementById('btn-add-scripts-exec');
    if (addScriptsBtn) addScriptsBtn.style.display = 'none';

    console.log('Execution state reset: selections cleared');
}

// Remember the last batch so it can be re-run (all / failed-only) after completion.
let _lastRunScriptPaths = [];
let _lastRunDUTIds = [];
let _lastRunFailedPaths = [];
let _reportExecId = null;   // stable exec id for the Live Results report buttons

async function startExecution() {
    const vmId = parseInt(document.getElementById('spy-vm-select').value);
    const scriptPaths = Array.from(selectedScriptPaths);
    // Snapshot this batch (scripts + DUTs) — completion clears the live selections.
    _lastRunScriptPaths = [...scriptPaths];
    _lastRunDUTIds = Array.from(selectedDUTIds);
    _lastRunFailedPaths = [];
    const logLevel = document.getElementById('spy-log-level')?.value || 'info';
    const skipInit = document.getElementById('spy-skip-init')?.checked || false;
    // Enhancement 3: Capture DUT reservation checkbox
    const reserveDuts = document.getElementById('reserve-duts-checkbox')?.checked || false;
    const allocInfoEl = document.getElementById('exec-allocation-info');

    // Auto-generate master testbed from topology if devices are selected (silent mode)
    let generatedTestbedPath = '';  // full remote path returned by generate API
    if (selectedDUTIds.size > 0) {
        if (!activeBasePath) {
            const pathInput = document.getElementById('scripts-base-path');
            if (pathInput) { pathInput.style.border = '2px solid #e74c3c'; pathInput.focus(); setTimeout(() => { pathInput.style.border = ''; }, 4000); }
            toast('Please enter the Scripts Path on VM and click Load before starting execution.', 'error', 7000);
            return;
        }
        try {
            const tbData = await generateMasterTestbed(true); // Silent = true (no modal/toasts)
            generatedTestbedPath = tbData?.master_testbed_path || '';
        } catch (e) {
            console.error('Failed to auto-generate master testbed:', e);
            const emsg = e.message || '';
            if (emsg.includes('PATH_NOT_FOUND') || emsg.includes('SCRIPTS_PATH_REQUIRED') || emsg.includes('Scripts Path on VM')) {
                const pathInput = document.getElementById('scripts-base-path');
                if (pathInput) { pathInput.style.border = '2px solid #e74c3c'; pathInput.focus(); setTimeout(() => { pathInput.style.border = ''; }, 4000); }
                toast('Scripts path not set or not found on VM — enter the SPyTest scripts path and click Load first.', 'error', 7000);
            } else {
                toast('Failed to generate testbed. Please check topology and try again.', 'error');
            }
            return;
        }
    }

    // Use the full remote path if available, otherwise fall back to filename
    const testbedFile = generatedTestbedPath || 'master_testbed.yaml';

    let endpoint, body;

    if (window._gitConnected) {
        endpoint = `${API}/api/git/execute`;
        body = { host_id: vmId, scripts: scriptPaths, dut_ids: Array.from(selectedDUTIds) };
    } else {
        // Smart allocation: fetch script topology info for each selected script
        if (allocInfoEl) allocInfoEl.innerHTML = '<span class="material-icons-round spin" style="font-size:14px;vertical-align:middle">sync</span> <span class="muted" style="font-size:12px">Analyzing scripts...</span>';
        const btn = document.getElementById('btn-start-exec');
        if (btn) btn.disabled = true;

        let scriptsWithCount = [];
        try {
            for (const path of scriptPaths) {
                let dut_count = 1;
                let min_topology = [];
                try {
                    const r = await fetch(`${API}/api/spytest/script-info`, {
                        method: 'POST',
                        headers: getSessionHeaders(),
                        body: JSON.stringify({ host_id: vmId, script_path: path, base_path: activeBasePath || '' }),
                    });
                    if (r.ok) {
                        const info = await r.json();
                        dut_count    = info.dut_count    || 1;
                        min_topology = info.min_topology || [];
                    }
                } catch (_) { /* default dut_count 1, min_topology [] */ }
                scriptsWithCount.push({ path, dut_count, min_topology });
            }
        } catch (_) {
            scriptsWithCount = scriptPaths.map(p => ({ path: p, dut_count: 1, min_topology: [] }));
        }

        // Run allocation: pair scripts to DUT slots from selected + connected DUTs
        const allocation = allocateDUTsForScripts(scriptsWithCount, dutConnections, selectedDUTIds);

        // Build allocation preview
        if (allocInfoEl) {
            const lines = scriptsWithCount.map((s, i) => {
                const name = s.path.split('/').pop();
                const duts = allocation[i] ? allocation[i].join(' + ') : `(${s.dut_count} DUT${s.dut_count > 1 ? 's' : ''})`;
                return `<span style="background:var(--bg-tertiary);border-radius:6px;padding:2px 8px;font-size:11px;white-space:nowrap">📄 ${esc(name)} → ${esc(duts)}</span>`;
            });
            allocInfoEl.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${lines.join('')}</div>`;
        }
        if (btn) btn.disabled = false;

        endpoint = `${API}/api/spytest/execute`;
        body = {
            host_id: vmId,
            scripts: scriptsWithCount,
            testbed: testbedFile,
            available_dut_count: selectedDUTIds.size || 1,  // canvas-selected DUT count drives parallelism
            options: { log_level: logLevel, skip_init_config: skipInit },
            // Enhancement 3: Pass DUT reservation flag
            reserve_duts: reserveDuts,
            base_path: activeBasePath || '',
            job_id: activeJobId || null,
        };
    }

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).detail);
        const data = await res.json();
        currentExecId = data.execution_id;
        currentExecActive = true;
        _updateJobStatusBadge('running');
        // Persist the testbed path so the scheduler can reuse it next time
        if (activeJobId && generatedTestbedPath) {
            fetch(`${API}/api/execution-jobs/${activeJobId}`, {
                method: 'PUT',
                headers: getSessionHeaders(),
                body: JSON.stringify({ testbed_path: generatedTestbedPath }),
            }).catch(() => {});
        }
        allLogs = [];
        logStreams = {};
        renderLogs();
        document.getElementById('btn-start-exec').style.display = 'none';
        document.getElementById('btn-stop-exec').style.display = '';
        // Enhancement 2: Show "Add Scripts" button during execution
        const addScriptsBtn = document.getElementById('btn-add-scripts-exec');
        if (addScriptsBtn) addScriptsBtn.style.display = '';
        const dlBtn = document.getElementById('btn-download-logs');
        if (dlBtn) dlBtn.style.display = '';
        // Enhancement 1: Show "Show Only Running" button for auto-hide feature
        const showOnlyBtn = document.getElementById('btn-show-only-running');
        if (showOnlyBtn) showOnlyBtn.style.display = '';
        // Show queue panel and start polling
        const qPanel = document.getElementById('queue-status-panel');
        if (qPanel) qPanel.style.display = '';
        startQueuePolling(currentExecId);
        const mode = window._gitConnected ? 'Git' : 'SPyTest';
        toast(`${mode} Execution #${currentExecId} started`, 'success');
        connectWS(currentExecId);
        startExecLogPolling(currentExecId);   // reliable live logs via REST (WS is best-effort)
        _hideRerunButtons();   // rerun buttons reappear only after this run completes
        // Initialize live results panel with queued scripts
        showLiveResultsPanel(scriptPaths);
        loadStats();
    } catch (e) {
        toast(`Failed to start execution: ${e.message}`, 'error');
        const btn = document.getElementById('btn-start-exec');
        if (btn) { btn.disabled = false; updateSpyStartBtn(); }
    }
}

async function stopExecution() {
    // Actually terminate the running execution on the server — not just stop watching.
    if (!currentExecId) { toast('No execution to stop', 'info'); return; }
    if (!confirm('Stop this execution? All running scripts will be terminated on the VM.')) return;

    const stopBtn = document.getElementById('btn-stop-exec');
    if (stopBtn) stopBtn.disabled = true;
    try {
        const res = await fetch(`${API}/api/executions/${currentExecId}/stop`, {
            method: 'POST',
            headers: getSessionHeaders(),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toast(`Failed to stop: ${err.detail || res.status}`, 'error');
            return;
        }
        // The server is now killing the remote scripts. Keep the WebSocket open so the
        // logs/queue update and the final `execution_complete` (status: cancelled) event
        // resets the UI cleanly. Reflect the stopping state immediately.
        currentExecActive = false;
        const badge = document.getElementById('queue-exec-badge');
        if (badge) { badge.className = 'badge failed'; badge.textContent = 'stopping'; }
        _updateJobStatusBadge('cancelled');
        toast('Stopping execution — terminating scripts on the VM…', 'info');
    } catch (e) {
        toast(`Failed to stop: ${e.message}`, 'error');
    } finally {
        if (stopBtn) stopBtn.disabled = false;
    }
}

// Execution WebSocket state — supports auto-reconnect + log de-duplication.
let _execWsReconnectAttempts = 0;
let _execWsIntentionalClose = false;
let _seenExecLogIds = new Set();   // dedupe: backend replays logs from id 0 each connect
let _execCompleteHandled = false;  // guards the completion UI so it fires exactly once

// Finalize the run UI when the execution completes — called from the WebSocket
// `execution_complete` event AND from polling (in case the WS never delivers it),
// guarded so it runs only once per execution.
async function handleExecutionComplete(status, duration) {
    if (_execCompleteHandled) return;
    _execCompleteHandled = true;
    currentExecActive = false;  // run finished — unchecking scripts is now a plain deselect
    stopQueuePolling();          // stop the interval; a final fetch happens below
    const doneId = currentExecId;

    // Flip the run controls IMMEDIATELY so the UI never lingers on "running".
    const _startBtn = document.getElementById('btn-start-exec');
    if (_startBtn) _startBtn.style.display = '';
    const _stopBtn = document.getElementById('btn-stop-exec');
    if (_stopBtn) _stopBtn.style.display = 'none';

    // ── Final backend refresh so the LAST script shows pass/fail (not stuck at
    //    running/queued) and the queue reflects completion, even when the WS died.
    try {
        const qr = await fetch(`${API}/api/execution-queue`);
        if (qr.ok) {
            const all = await qr.json();
            const state = all[doneId] || all[String(doneId)];
            if (state) {
                updateQueuePanel(state);
                (state.script_results || []).forEach(r => updateLiveResults(r));
            }
        }
        // Authoritative per-script results from the executions list.
        const lr = await fetch(`${API}/api/executions`, { headers: getSessionHeaders() });
        if (lr.ok) {
            const list = await lr.json();
            const ex = Array.isArray(list) ? list.find(e => String(e.id) === String(doneId)) : null;
            if (ex && Array.isArray(ex.script_results)) ex.script_results.forEach(r => updateLiveResults(r));
        }
    } catch (_) {}

    toast(`Execution ${status} (${duration || 0}s)`,
          status === 'completed' ? 'success' : 'error');
    const startBtn = document.getElementById('btn-start-exec');
    if (startBtn) startBtn.style.display = '';
    const stopBtn = document.getElementById('btn-stop-exec');
    if (stopBtn) stopBtn.style.display = 'none';
    const addScriptsBtn = document.getElementById('btn-add-scripts-exec');
    if (addScriptsBtn) addScriptsBtn.style.display = 'none';
    const showOnlyBtn = document.getElementById('btn-show-only-running');
    if (showOnlyBtn) showOnlyBtn.style.display = 'none';
    // Final log fetch, then stop the live poller (catches any last lines)
    if (doneId) _pollExecLogsOnce(doneId).finally(stopExecLogPolling);
    else stopExecLogPolling();
    const badge = document.getElementById('queue-exec-badge');
    if (badge) {
        badge.className = `badge ${status === 'completed' ? 'completed' : 'failed'}`;
        badge.textContent = status;
    }
    // The queue panel is a live monitor — hide it now that the run is finished so it
    // doesn't sit showing a stale "running" state (Live Results has the final status).
    const qPanel = document.getElementById('queue-status-panel');
    if (qPanel) qPanel.style.display = 'none';
    loadStats();
    loadExecutions();

    // Enable download buttons in Live Results panel
    const btnHtml = document.getElementById('btn-dl-html');
    const btnXls = document.getElementById('btn-dl-excel');
    if (btnHtml) btnHtml.disabled = false;
    if (btnXls) btnXls.disabled = false;
    const jobHtmlBtn = document.getElementById('btn-job-html');
    const jobExcelBtn = document.getElementById('btn-job-excel');
    if (activeJobId && jobHtmlBtn) jobHtmlBtn.style.display = '';
    if (activeJobId && jobExcelBtn) jobExcelBtn.style.display = '';
    _updateJobStatusBadge(status || 'completed');

    // Remember this execution's id for the report buttons and reveal Rerun.
    // (Failed set computed AFTER the final refresh so last-script failures count.)
    _reportExecId = doneId;
    _lastRunFailedPaths = (_lastRunScriptPaths || []).filter(p => {
        const stem = p.split('/').pop().replace(/\.py$/, '');
        const st = _liveScripts[stem];
        return st && st.status === 'failed';
    });
    _showRerunButtons();

    allLogs = [];
    logStreams = {};
    const logContainer = document.getElementById('exec-log-container');
    if (logContainer) {
        logContainer.innerHTML = '<div class="log-placeholder"><span class="material-icons-round">terminal</span><p>Logs will appear here when an execution starts...</p></div>';
    }
    const downloadBtn = document.getElementById('btn-download-logs');
    if (downloadBtn) downloadBtn.style.display = 'none';

    resetExecutionState();
}

// Fresh connection for a (possibly new) execution — resets dedupe + counters.
function connectWS(execId) {
    _seenExecLogIds = new Set();
    _execWsReconnectAttempts = 0;
    _execWsIntentionalClose = false;
    _execCompleteHandled = false;   // arm completion handling for this run
    _openExecWS(execId);
}

function _openExecWS(execId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/execution/${execId}`);
    ws.onopen = () => { _execWsReconnectAttempts = 0; };
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        // Handle script_result events (live results table)
        if (data.type === 'script_result') {
            updateLiveResults(data);
            return;
        }

        if (data.type === 'execution_complete') {
            _execWsIntentionalClose = true;   // server closes after this — don't reconnect
            handleExecutionComplete(data.status, data.duration);
            return;
        }

        if (data.message && data.message.startsWith('[QUEUE]')) return;
        // De-dupe by log id so reconnects (which replay from id 0) don't double-print
        if (data.id != null) {
            if (_seenExecLogIds.has(data.id)) return;
            _seenExecLogIds.add(data.id);
        }
        allLogs.push(data);
        appendLogEntry(data);
    };
    // Quiet on error — let onclose drive reconnection instead of alarming the user
    ws.onerror = () => { console.warn('[exec-ws] error; will attempt reconnect on close'); };
    ws.onclose = () => {
        ws = null;
        if (_execWsIntentionalClose) { _execWsIntentionalClose = false; return; }
        // Unexpected drop — reconnect while the execution is still running so live
        // logs/results resume. Backend replays logs from the start; dedupe handles it.
        if (!currentExecActive) return;
        _execWsReconnectAttempts++;
        if (_execWsReconnectAttempts <= 15) {
            const delay = Math.min(1000 * _execWsReconnectAttempts, 5000);
            console.log(`[exec-ws] reconnecting in ${delay}ms (attempt ${_execWsReconnectAttempts})`);
            setTimeout(() => { if (currentExecActive) _openExecWS(execId); }, delay);
        } else {
            toast('Live log stream lost — execution continues; status still updating via polling', 'warning');
        }
    };
}

// ── Live Results Panel ─────────────────────────────────────────────────────

function showLiveResultsPanel(scriptPaths) {
    const panel = document.getElementById('live-results-panel');
    if (!panel) return;
    panel.style.display = '';

    // Reset state
    _liveScripts = {};
    _liveScriptOrder = [];
    _liveTotalScripts = scriptPaths.length;
    _liveDoneScripts = 0;

    // Reset download buttons
    const btnHtml = document.getElementById('btn-dl-html');
    const btnXls = document.getElementById('btn-dl-excel');
    if (btnHtml) btnHtml.disabled = true;
    if (btnXls) btnXls.disabled = true;

    // Populate table with queued rows
    const tbody = document.getElementById('live-results-tbody');
    if (!tbody) return;

    const rows = scriptPaths.map(p => {
        const stem = p.split('/').pop().replace(/\.py$/, '');
        _liveScriptOrder.push(stem);
        _liveScripts[stem] = { passed: 0, failed: 0, skipped: 0, duration_s: 0, status: 'queued' };
        return `<tr id="lr-row-${CSS.escape(stem)}">
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                title="${esc(p)}">${esc(stem)}</td>
            <td><span class="badge" style="background:var(--bg-tertiary);color:var(--text-secondary)">◌ queued</span></td>
            <td style="text-align:center">–</td>
            <td style="text-align:center">–</td>
            <td style="text-align:center">–</td>
            <td>–</td>
        </tr>`;
    });
    tbody.innerHTML = rows.join('');
    _updateLiveProgressBar();
}

function hideLiveResultsPanel() {
    const panel = document.getElementById('live-results-panel');
    if (panel) panel.style.display = 'none';
}

// BF-11: Restore live results panel from a completed/failed execution's script_results.
// scriptResults — array of {script_stem, passed, failed, skipped, duration_s, status}
// from get_execution_job's execs_data[].script_results
function _restoreLiveResultsPanel(latestExec, jobScripts) {
    const scriptResults = latestExec.script_results || [];
    // Build path list: prefer script_results order; fall back to job's saved scripts
    const stems = scriptResults.length > 0
        ? scriptResults.map(r => r.script_stem)
        : (jobScripts || []).map(s => (s.path || s).split('/').pop().replace(/\.py$/, ''));

    if (stems.length === 0) { hideLiveResultsPanel(); return; }

    // Use showLiveResultsPanel to initialise the table rows
    showLiveResultsPanel(stems.map(stem => `${stem}.py`));

    // Replay each result row
    scriptResults.forEach(r => updateLiveResults(r));

    // Enable download buttons (execution already completed) + remember the id so
    // the report buttons work after a refresh.
    _reportExecId = latestExec.id;
    const btnHtml = document.getElementById('btn-dl-html');
    const btnXls  = document.getElementById('btn-dl-excel');
    if (btnHtml) btnHtml.disabled = false;
    if (btnXls)  btnXls.disabled  = false;
}

function updateLiveResults(data) {
    const stem = data.script_stem || (data.script || '').split('/').pop().replace(/\.py$/, '');
    if (!stem) return;

    const state = _liveScripts[stem] || {};
    state.passed = data.passed || 0;
    state.failed = data.failed || 0;
    state.skipped = data.skipped || 0;
    state.duration_s = data.duration_s || 0;
    // Trust the counts for the status so a failed script is never shown as passed
    // (fixes "all passed" after a refresh): any failed testcase → failed.
    let st = (data.status || '').toLowerCase();
    if ((data.failed || 0) > 0) {
        st = 'failed';
    } else if (!st || st === 'unknown' || st === 'running' || st === 'queued' || st === 'waiting') {
        if ((data.passed || 0) > 0) st = 'passed';
        else if ((data.skipped || 0) > 0) st = 'skipped';
        else st = st || 'unknown';
    }
    state.status = st;
    _liveScripts[stem] = state;
    _liveDoneScripts = Object.values(_liveScripts).filter(s => s.status !== 'queued').length;

    const row = document.getElementById(`lr-row-${CSS.escape(stem)}`);
    if (!row) return;

    const statusColor = state.status === 'passed' ? 'var(--green,#22c55e)'
        : state.status === 'failed' ? 'var(--red,#ef4444)'
        : 'var(--text-secondary)';
    const statusIcon = state.status === 'passed' ? '✓' : state.status === 'failed' ? '✗' : '↷';
    const dur = state.duration_s ? `${state.duration_s}s` : '–';

    row.innerHTML = `
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(stem)}</td>
        <td><span style="color:${statusColor};font-weight:600">${statusIcon} ${state.status}</span></td>
        <td style="text-align:center;color:var(--green,#22c55e)">${state.passed}</td>
        <td style="text-align:center;color:var(--red,#ef4444)">${state.failed}</td>
        <td style="text-align:center;color:var(--text-secondary)">${state.skipped}</td>
        <td>${dur}</td>`;

    _updateLiveProgressBar();
}

function _updateLiveProgressBar() {
    const total = _liveTotalScripts;
    const done = _liveDoneScripts;
    const pct = total ? Math.round(done / total * 100) : 0;

    const totalPass = Object.values(_liveScripts).reduce((s, x) => s + (x.passed || 0), 0);
    const totalFail = Object.values(_liveScripts).reduce((s, x) => s + (x.failed || 0), 0);
    const totalSkip = Object.values(_liveScripts).reduce((s, x) => s + (x.skipped || 0), 0);

    const bar = document.getElementById('live-progress-bar');
    if (bar) bar.style.width = pct + '%';
    const summary = document.getElementById('live-results-summary');
    if (summary) {
        summary.textContent = `${done}/${total} scripts done`;
        if (totalPass + totalFail + totalSkip > 0) {
            summary.textContent += ` · ✓${totalPass} ✗${totalFail} ↷${totalSkip}`;
        }
    }
}

async function downloadReport(execId, format) {
    // Fall back to the last completed execution if the live id was cleared
    execId = execId || _reportExecId || currentExecId;
    if (!execId) { toast('No execution to download a report for', 'warning'); return; }
    const endpoint = format === 'excel'
        ? `${API}/api/executions/${execId}/excel`
        : `${API}/api/executions/${execId}/dashboard`;
    try {
        const res = await fetch(endpoint, { headers: getSessionHeaders() });
        if (!res.ok) {
            let detail = res.status;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            toast(`Download failed: ${detail}`, 'error');
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = format === 'excel'
            ? `eka_results_${execId}.xlsx`
            : `eka_dashboard_${execId}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) {
        toast(`Download error: ${e.message}`, 'error');
    }
}

// ============================================================
// LOG RENDERING — panes keyed by script name (dut_name field)
// ============================================================

let logStreams = {};  // {scriptName: DOM element}
let showOnlyRunning = true;   // Default: Live Execution Logs shows only running scripts;
                              // a script's pane is hidden as soon as it completes
let completedScripts = new Set();  // Track completed script names
let scriptHideTimers = {};  // Auto-hide timers per script

function renderLogs() {
    const container = document.getElementById('exec-log-container');
    logStreams = {};
    if (!allLogs.length) {
        container.innerHTML = '<div class="log-placeholder"><span class="material-icons-round">terminal</span><p>Waiting for logs...</p></div>';
        return;
    }
    container.innerHTML = '';
    // Re-create the pane wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'log-panes-wrapper';
    container.appendChild(wrapper);
    allLogs.forEach(appendLogEntry);
    // Re-apply "only running" filter after a full rebuild (waiting + completed hidden).
    _applyRunningFilter();
}

function _ensurePaneWrapper() {
    const container = document.getElementById('exec-log-container');
    if (container.querySelector('.log-placeholder')) {
        container.innerHTML = '';
        const w = document.createElement('div');
        w.className = 'log-panes-wrapper';
        container.appendChild(w);
    }
    return container.querySelector('.log-panes-wrapper') || container;
}

function appendLogEntry(log) {
    // Use dut_name as the script-key (backend tags each log with the script filename)
    const source = log.dut_name || 'SYSTEM';
    const wrapper = _ensurePaneWrapper();

    // Detect script completion messages and mark as completed
    const msg = (log.message || '').toLowerCase();
    let justCompleted = false;
    if ((msg.includes('passed') || msg.includes('failed') || msg.includes('completed')) &&
        !msg.includes('waiting')) {
        if (!completedScripts.has(source)) {
            completedScripts.add(source);
            justCompleted = true;
        }
    }

    if (!logStreams[source]) {
        const safeId = 'log-stream-' + source.replace(/[^a-zA-Z0-9]/g, '_');
        const pane = document.createElement('div');
        pane.className = 'script-log-pane';
        pane.dataset.scriptName = source;

        pane.innerHTML = `
            <div class="script-pane-header" onclick="openLogPopup('${esc(source)}')" title="Click to expand">
                <span class="material-icons-round" style="font-size:15px;opacity:.7">description</span>
                <span class="script-pane-title">${esc(source)}</span>
                <span class="material-icons-round script-pane-dl" style="font-size:15px;opacity:.6;margin-left:auto;cursor:pointer"
                    onclick="event.stopPropagation();downloadScriptLog('${esc(source)}')"
                    title="Download this script's log">download</span>
                <span class="material-icons-round" style="font-size:14px;opacity:.5;margin-left:6px">open_in_new</span>
            </div>
            <div id="${safeId}" class="script-pane-body"></div>
        `;
        wrapper.appendChild(pane);
        logStreams[source] = document.getElementById(safeId);
    }

    const target = logStreams[source];
    if (target) {
        target.insertAdjacentHTML('beforeend', logHTML(log));
        // Auto-scroll only the individual pane (not the main container)
        // This allows each script section to scroll independently
        target.scrollTop = target.scrollHeight;
    }

    // In "only running" mode, show this pane only while its script is actually
    // running — hide it while queued/waiting and once it completes.
    if (showOnlyRunning && target && source !== 'SYSTEM') {
        const pane = target.closest('.script-log-pane');
        if (pane) {
            const isRunning = scriptStatuses[source] === 'running';
            pane.classList.toggle('log-pane-hidden', !isRunning);
        }
    }
}

function openLogPopup(source) {
    const logs = allLogs.filter(l => (l.dut_name || 'SYSTEM') === source);
    const dl = `<div style="text-align:right;margin-bottom:8px">
        <button class="btn outline small" onclick="downloadScriptLog('${esc(source)}')">
            <span class="material-icons-round" style="font-size:15px;vertical-align:middle">download</span> Download log
        </button></div>`;
    const html = dl + '<div class="log-popup-body">' + (logs.length ? logs.map(logHTML).join('') : '<p class="muted" style="padding:8px">No logs yet.</p>') + '</div>';
    openModal(`Logs — ${source}`, html);
}

function logHTML(log) {
    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
    return `<div class="log-entry" style="margin-bottom:2px">
        <span class="time" style="color:var(--text-muted)">${time}</span>
        <span class="level ${log.level || ''}">${log.level || ''}</span>
        <span class="msg">${esc(log.message || '')}</span>
    </div>`;
}

function downloadLogs() {
    if (!allLogs.length) return;
    const text = allLogs.map(l => `[${l.timestamp}] [${l.dut_name}] [${l.level}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `execution_${currentExecId}_logs.txt`;
    a.click();
}

// Download the log for a single script pane (Live Execution Logs)
function downloadScriptLog(source) {
    const logs = allLogs.filter(l => (l.dut_name || 'SYSTEM') === source);
    if (!logs.length) { toast('No logs for this script yet', 'info'); return; }
    const text = logs.map(l => `[${l.timestamp || ''}] [${l.level || ''}] ${l.message || ''}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safe = source.replace(/[^a-zA-Z0-9._-]/g, '_');
    a.download = `exec${currentExecId || ''}_${safe}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

// Per-script queue status (name -> queued/waiting/running/done/failed), from the
// queue poll — the source of truth for the "Show Only Running" filter.
let scriptStatuses = {};

// Apply the "Show Only Running" filter: when active, only panes whose script is
// currently RUNNING are shown (waiting/queued AND completed panes are hidden).
// SYSTEM/general logs always stay visible.
function _applyRunningFilter() {
    document.querySelectorAll('.script-log-pane').forEach(pane => {
        const name = pane.dataset.scriptName;
        let show;
        if (!showOnlyRunning) show = true;
        else if (name === 'SYSTEM') show = true;
        else show = scriptStatuses[name] === 'running';
        pane.classList.toggle('log-pane-hidden', !show);
    });
}

// Toggle "Show Only Running" filter for log panes
function toggleShowOnlyRunning() {
    showOnlyRunning = !showOnlyRunning;
    const btn = document.getElementById('btn-show-only-running');
    if (btn) {
        btn.classList.toggle('active', showOnlyRunning);
        btn.title = showOnlyRunning ? 'Show all scripts (including completed/waiting)' : 'Show only running scripts';
        const icon = btn.querySelector('.material-icons-round');
        if (icon) icon.textContent = showOnlyRunning ? 'visibility' : 'visibility_off';
        const lbl = document.getElementById('show-only-running-label');
        if (lbl) lbl.textContent = showOnlyRunning ? 'Show All' : 'Show Only Running';
    }
    _applyRunningFilter();
}

// Auto-hide a completed script's logs after delay (in milliseconds)
function setAutoHideScriptLog(scriptName, delay) {
    // Clear any existing timer for this script
    if (scriptHideTimers[scriptName]) {
        clearTimeout(scriptHideTimers[scriptName]);
    }

    // Set new timer to hide after delay
    scriptHideTimers[scriptName] = setTimeout(() => {
        if (showOnlyRunning) {
            const pane = document.querySelector(`.script-log-pane[data-script-name="${scriptName}"]`);
            if (pane) {
                pane.classList.add('log-pane-hidden');
            }
        }
        delete scriptHideTimers[scriptName];
    }, delay);
}

// ============================================================
// ENHANCEMENT 2: DYNAMIC BATCH ADDITION & SCRIPT CANCELLATION
// ============================================================

let pendingCancelScript = null;      // script NAME (for the cancel API)
let pendingCancelScriptPath = null;  // script PATH (for deselecting the checkbox)

function showCancelConfirmation(scriptPath) {
    // Show cancel confirmation dialog for a script
    pendingCancelScriptPath = scriptPath;
    pendingCancelScript = scriptPath.split('/').pop();   // filename for the API + display
    const modal = document.getElementById('cancel-script-confirmation-modal');
    const nameDisplay = document.getElementById('cancel-script-name-display');
    if (modal && nameDisplay) {
        nameDisplay.textContent = pendingCancelScript;
        modal.style.display = 'flex';
        // Focus the NO button (default)
        const noBtn = document.getElementById('btn-cancel-no');
        if (noBtn) noBtn.focus();
    }
}

function closeCancelConfirmation() {
    // Close the cancel confirmation dialog
    const modal = document.getElementById('cancel-script-confirmation-modal');
    if (modal) modal.style.display = 'none';
    pendingCancelScript = null;
    pendingCancelScriptPath = null;
}

async function confirmCancelScript() {
    // Confirm and execute script cancellation
    if (!pendingCancelScript || !currentExecId) {
        toast('Error: Script or execution ID missing', 'error');
        closeCancelConfirmation();
        return;
    }

    try {
        const res = await fetch(`${API}/api/executions/${currentExecId}/cancel-script`, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify({ script_name: pendingCancelScript }),
        });

        if (!res.ok) {
            const err = await res.json();
            toast(`Failed to cancel: ${err.detail}`, 'error');
            closeCancelConfirmation();
            return;
        }

        // Actually deselect the script: remove from the selection set AND uncheck its
        // checkbox in the Test Scripts dropdown (checkboxes are keyed by full path).
        const path = pendingCancelScriptPath;
        const name = pendingCancelScript;
        if (path) {
            selectedScriptPaths.delete(path);
            document.querySelectorAll('#script-dropdown-list .multi-select-item input[type=checkbox]')
                .forEach(cb => { if (cb.value === path) cb.checked = false; });
            const selectAllCb = document.querySelector('#script-dropdown-list .select-all input');
            if (selectAllCb) selectAllCb.checked = false;
            updateScriptMultiSelectText();
            try { if (typeof updateSpyStartBtn === 'function') updateSpyStartBtn(); } catch (_) {}
            try { if (typeof saveJobState === 'function') saveJobState(); } catch (_) {}
        }

        // Hide the log pane for the cancelled script (pane is keyed by filename)
        const logPane = document.querySelector(`.script-log-pane[data-script-name="${name}"]`);
        if (logPane) logPane.classList.add('log-pane-hidden');

        toast(`Script "${name}" cancelled`, 'success');
        closeCancelConfirmation();
    } catch (e) {
        toast(`Error cancelling script: ${e.message}`, 'error');
        closeCancelConfirmation();
    }
}

async function addScriptsDuringExecution() {
    // Open modal to add new scripts during execution
    if (!currentExecId) {
        toast('No active execution', 'error');
        return;
    }

    // Create modal to select scripts
    const allScripts = Array.from(document.querySelectorAll('.script-item'));
    if (!allScripts.length) {
        toast('No scripts available', 'error');
        return;
    }

    // Build script selection UI
    const scriptOptions = allScripts.map(item => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        const label = item.querySelector('label');
        const path = checkbox?.getAttribute('data-script-name') || '';
        return {
            path,
            name: label?.textContent || path,
            el: item
        };
    });

    // Show modal with unselected scripts
    const modal = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.textContent = 'Add Scripts to Running Execution';
    body.innerHTML = `
        <div style="max-height: 400px; overflow-y: auto;">
            <p style="margin-bottom: 12px; font-size: 12px; color: var(--text-muted);">
                Select scripts to add to the current execution queue:
            </p>
            <div id="add-scripts-selection">
                ${scriptOptions.map(s => `
                    <label style="display: flex; align-items: center; padding: 8px; cursor: pointer; border-radius: 6px; transition: background 0.1s;" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background=''">
                        <input type="checkbox" data-add-script-path="${s.path}" style="margin-right: 8px;">
                        <span style="font-family: var(--mono); font-size: 12px;">${s.name}</span>
                    </label>
                `).join('')}
            </div>
        </div>
    `;

    const footer = document.querySelector('.modal-footer');
    footer.innerHTML = `
        <button class="btn outline" onclick="closeModal()">Cancel</button>
        <button class="btn primary" onclick="submitAddScripts()">Add Selected Scripts</button>
    `;

    modal.style.display = 'flex';
}

async function submitAddScripts() {
    // Submit selected scripts to be added to execution
    if (!currentExecId) {
        toast('No active execution', 'error');
        return;
    }

    // Get selected scripts
    const selected = Array.from(document.querySelectorAll('input[data-add-script-path]:checked'));
    if (!selected.length) {
        toast('Please select at least one script', 'error');
        return;
    }

    const scripts = selected.map(checkbox => ({
        path: checkbox.getAttribute('data-add-script-path'),
        dut_count: 1,  // Default, will be analyzed by backend
        min_topology: []
    }));

    try {
        const res = await fetch(`${API}/api/executions/${currentExecId}/add-scripts`, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify({ scripts }),
        });

        if (!res.ok) {
            const err = await res.json();
            toast(`Failed to add scripts: ${err.detail}`, 'error');
            return;
        }

        const data = await res.json();
        toast(`Added ${data.added} script(s) to queue`, 'success');
        closeModal();

        // Re-render scripts to show queued status
        loadScripts();
    } catch (e) {
        toast(`Error adding scripts: ${e.message}`, 'error');
    }
}

// ============================================================
// ENHANCEMENT 3: DUT RESERVATION SYSTEM
// ============================================================

async function releaseReservedDuts() {
    // Release all DUTs reserved by current user
    try {
        // Get list of reservations
        const res = await fetch(`${API}/api/duts/reservations`, {
            headers: getSessionHeaders()
        });

        if (!res.ok) {
            toast('Failed to fetch reservations', 'error');
            return;
        }

        const data = await res.json();
        if (data.total === 0) {
            toast('No reserved DUTs to release', 'info');
            return;
        }

        // Release each reserved DUT
        let released = 0;
        for (const reservation of data.reservations) {
            const releaseRes = await fetch(`${API}/api/duts/${reservation.dut_id}/reserve`, {
                method: 'POST',
                headers: getSessionHeaders(),
                body: JSON.stringify({ reserve: false }),
            });

            if (releaseRes.ok) {
                released++;
            }
        }

        toast(`Released ${released} DUT(s)`, 'success');

        // Hide release button if no more reservations
        const btn = document.getElementById('btn-release-duts');
        if (btn && released === data.total) {
            btn.style.display = 'none';
        }
    } catch (e) {
        toast(`Error releasing DUTs: ${e.message}`, 'error');
    }
}

async function checkAndShowReservedDuts() {
    // Check if user has reserved DUTs and show release button
    try {
        const res = await fetch(`${API}/api/duts/reservations`, {
            headers: getSessionHeaders()
        });

        if (!res.ok) return;

        const data = await res.json();
        const btn = document.getElementById('btn-release-duts');

        if (btn && data.total > 0) {
            btn.style.display = '';
            btn.textContent = `🔒 Release ${data.total} DUT(s)`;
        } else if (btn) {
            btn.style.display = 'none';
        }
    } catch (e) {
        console.log('Could not fetch reservations:', e);
    }
}

// ============================================================
// EXECUTION HISTORY
// ============================================================

async function loadExecutions() {
    let execs = [];
    try {
        const res = await fetch(`${API}/api/executions`, {
            headers: getSessionHeaders()
        });
        const allExecs = await res.json();
        execs = Array.isArray(allExecs)
            ? allExecs.filter(ex => !ex.type || ex.type === 'script' || ex.type === 'spytest')
            : [];
        const tbody = document.getElementById('exec-history-tbody');
        if (tbody && !execs.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="muted" style="text-align:center;padding:24px">No script executions yet.</td></tr>';
        } else if (tbody) tbody.innerHTML = execs.map(ex => {
            const totalP = ex.passed || 0;
            const totalF = ex.failed || 0;
            const totalS = ex.skipped || 0;
            const resultsBadge = (totalP + totalF + totalS > 0)
                ? `<span style="font-size:11px;white-space:nowrap">
                    <span style="color:var(--green,#22c55e)">✓${totalP}</span>
                    <span style="color:var(--red,#ef4444)"> ✗${totalF}</span>
                    <span style="color:var(--text-secondary)"> ↷${totalS}</span>
                  </span>`
                : '<span class="muted" style="font-size:11px">–</span>';
            const checked = _compareSelected.has(ex.id) ? 'checked' : '';
            const isScript = ex.type === 'script' || ex.type === 'spytest';
            return `<tr>
                <td style="text-align:center"><input type="checkbox" class="cmp-chk"
                    data-id="${ex.id}" onchange="onCompareCheck(this)" ${checked}></td>
                <td>#${ex.id}</td>
                <td>${esc(ex.name)}</td>
                <td>${esc(ex.type || '-')}</td>
                <td><span class="badge ${ex.status}">${ex.status}</span></td>
                <td>${resultsBadge}</td>
                <td>${ex.dut_count}</td>
                <td>${ex.duration != null ? ex.duration + 's' : '-'}</td>
                <td>${ex.created_at ? new Date(ex.created_at).toLocaleString() : '-'}</td>
                <td style="display:flex;gap:4px;align-items:center">
                    <button class="btn outline small" onclick="viewExecLogs(${ex.id})"
                        title="View logs">
                        <span class="material-icons-round" style="font-size:15px">visibility</span>
                    </button>
                    ${isScript ? `
                    <button class="btn outline small" onclick="downloadReport(${ex.id},'html')"
                        title="HTML report">
                        <span class="material-icons-round" style="font-size:14px">download</span>
                    </button>
                    <button class="btn outline small" onclick="downloadReport(${ex.id},'excel')"
                        title="Excel report">
                        <span class="material-icons-round" style="font-size:14px">table_chart</span>
                    </button>` : ''}
                    <button class="btn outline small" onclick="deleteExecution(${ex.id})"
                        title="Delete" style="color:var(--red)">
                        <span class="material-icons-round" style="font-size:15px">delete</span>
                    </button>
                </td>
            </tr>`;
        }).join('');

    } catch (e) { console.error('loadExecutions error', e); }

    // Always render the dashboard summary — in its OWN try so a chart error can't
    // silently blank the panel. renderDashExecSummary handles the empty case itself.
    try {
        renderDashExecSummary(execs);
    } catch (e) {
        console.error('renderDashExecSummary error', e);
        const el = document.getElementById('dash-exec-summary');
        if (el) el.innerHTML = `<div style="padding:24px;color:var(--text-muted);font-size:12px">
            Chart failed to render: ${esc(e && e.message || e)}</div>`;
    }
}

function renderDashExecSummary(execs) {
    const el = document.getElementById('dash-exec-summary');
    if (!el) return;

    const scriptExecs = (execs || []).filter(ex => !ex.type || ex.type === 'script' || ex.type === 'spytest');
    if (!scriptExecs.length) {
        el.style.display = '';
        el.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px;gap:8px">
            <span class="material-icons-round" style="font-size:48px;opacity:0.15">bar_chart</span>
            <p class="muted" style="margin:0">No script executions yet.</p>
        </div>`;
        return;
    }

    // ── Aggregates ──────────────────────────────────────────────────────────
    const totalRuns = scriptExecs.length;
    let sumP = 0, sumF = 0, sumS = 0;
    scriptExecs.forEach(ex => { sumP += ex.passed||0; sumF += ex.failed||0; sumS += ex.skipped||0; });
    const sumTests  = sumP + sumF + sumS;
    const passRate  = sumTests ? +((sumP / sumTests) * 100).toFixed(1) : null;
    const lastEx    = scriptExecs[0];
    const withDur   = scriptExecs.filter(ex => (ex.duration||0) > 0);
    const avgDur    = withDur.length ? Math.round(withDur.reduce((a,b) => a+(b.duration||0), 0) / withDur.length) : null;
    const passColor = passRate == null ? '#94a3b8' : passRate >= 80 ? '#22c55e' : passRate >= 50 ? '#f59e0b' : '#ef4444';

    // ── Failure categorisation (heuristic) ──────────────────────────────────
    let catProd = 0, catAuto = 0, catSys = 0, catInv = 0;
    scriptExecs.forEach(ex => {
        const tot = (ex.passed||0)+(ex.failed||0)+(ex.skipped||0);
        const f   = ex.failed||0;
        if (!tot && ex.status === 'failed') { catSys++; return; }
        if (!f) return;
        const r = f / tot;
        if (r >= 0.5) catProd++;
        else if (r <= 0.15) catAuto++;
        else catInv++;
    });
    const catTotal = catProd + catAuto + catSys + catInv;

    // ── Chart data — ALWAYS per BATCH (one bar per execution) ─────────────────
    // Each bar shows how many SCRIPTS passed / failed / skipped in that batch,
    // with the batch's duration in the tooltip.
    const LIMIT = 40;
    const recent = [...scriptExecs].reverse().slice(-LIMIT);   // oldest→newest, last N
    const modeLabel = `per batch — last ${recent.length}`;
    const chartData = recent.map(ex => {
        const sr = ex.script_results || [];
        let sp = 0, sf = 0, ss = 0;
        sr.forEach(r => {
            const st = (r.status || '').toLowerCase();
            if (st === 'passed') sp++;
            else if (st === 'failed') sf++;
            else ss++;
        });
        const hasScripts = sr.length > 0;
        const testTime = sr.reduce((a, x) => a + (x.duration_s || 0), 0);
        return {
            label: `#${ex.id}`, tooltip: `#${ex.id}: ${ex.name}`,
            // Bar segments: per-script counts (fall back to testcase counts for old data)
            p: hasScripts ? sp : (ex.passed || 0),
            f: hasScripts ? sf : (ex.failed || 0),
            s: hasScripts ? ss : (ex.skipped || 0),
            dur: ex.duration || 0, testTime,
            scriptsPassed: sp, scriptsFailed: sf, scriptsSkipped: ss,
            tcP: ex.passed || 0, tcF: ex.failed || 0, tcS: ex.skipped || 0,
        };
    });

    // ── KPI cards ──────────────────────────────────────────────────────────
    const _kpiCard = (label, value, sub, bg, border, accent) =>
        `<div style="background:${bg};border:1px solid ${border};border-left:3px solid ${accent};border-radius:6px;padding:5px 9px">
            <div style="font-size:8px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);line-height:1.6">${label}</div>
            <div style="font-size:15px;font-weight:700;color:${accent};line-height:1.25">${value}</div>
            <div style="font-size:8px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>
        </div>`;
    const kpi = `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,118px));gap:6px;margin-bottom:10px;justify-content:start">
        ${_kpiCard('Total Launches', totalRuns.toLocaleString(), sumTests.toLocaleString()+' cases', 'rgba(59,130,246,0.08)', 'rgba(59,130,246,0.22)', '#3b82f6')}
        ${_kpiCard('Pass Rate', passRate != null ? passRate+'%' : '—', `✓${sumP.toLocaleString()} ✗${sumF.toLocaleString()} ↷${sumS.toLocaleString()}`, `rgba(${passRate==null?'148,163,184':passRate>=80?'34,197,94':passRate>=50?'245,158,11':'239,68,68'},0.08)`, `rgba(${passRate==null?'148,163,184':passRate>=80?'34,197,94':passRate>=50?'245,158,11':'239,68,68'},0.22)`, passColor)}
        ${_kpiCard('Total Failures', sumF.toLocaleString(), 'across all launches', 'rgba(239,68,68,0.08)', 'rgba(239,68,68,0.22)', '#ef4444')}
        ${_kpiCard('Avg Duration', avgDur ? _fmtDurShort(avgDur) : '—', 'per launch', 'rgba(139,92,246,0.08)', 'rgba(139,92,246,0.22)', '#8b5cf6')}
    </div>`;

    // ── Main stacked bar ────────────────────────────────────────────────────
    const W = 560, H = 150;
    const maxValBar = Math.max(...chartData.map(d => d.p+d.f+d.s), 1);
    const { ticks: bt, niceMax: bNM } = _niceAxisTicks(maxValBar);
    const yLW = bt[bt.length-1] >= 10000 ? 44 : bt[bt.length-1] >= 1000 ? 38 : bt[bt.length-1] >= 100 ? 30 : 24;
    const bpL = yLW+4, bpR = 8, bpT = 8, bpB = 28;
    const bcW = W-bpL-bpR, bcH = H-bpT-bpB;
    const bn = chartData.length, bgrp = bcW/bn;
    const bw = Math.max(Math.min(bgrp*0.72, 38), 3);
    // Gradient defs for colourful bars
    const svgDefs = `<defs>
        <linearGradient id="dg-p" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4ade80"/><stop offset="100%" stop-color="#15803d"/></linearGradient>
        <linearGradient id="dg-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f87171"/><stop offset="100%" stop-color="#b91c1c"/></linearGradient>
        <linearGradient id="dg-s" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#475569"/></linearGradient>
    </defs>`;
    let bGrid = '', bBars = '', bX = '';
    bt.forEach(val => {
        const y = bpT+bcH-(val/bNM)*bcH;
        const lbl = val >= 1000 ? (val/1000)+'k' : String(val);
        bGrid += `<line x1="${bpL}" y1="${y}" x2="${W-bpR}" y2="${y}" stroke="rgba(148,163,184,${val===0?'.2':'.08'})" stroke-width="1" ${val>0?'stroke-dasharray="4,3"':''}/>
            <text x="${bpL-5}" y="${y+3.5}" text-anchor="end" font-size="9" fill="rgba(148,163,184,.65)">${lbl}</text>`;
    });
    const bls = bn > 24 ? Math.ceil(bn/16) : 1;
    // Rich tooltip: launch, breakdown, pass-rate AND duration — merged into one graph
    const _tip = d => {
        const st = (d.scriptsPassed || 0) + (d.scriptsFailed || 0) + (d.scriptsSkipped || 0);
        const srate = st ? ((d.scriptsPassed / st) * 100).toFixed(0) + '%' : '—';
        const elapsed = d.dur ? _fmtDurShort(d.dur) : '—';
        const testT = d.testTime ? _fmtDurShort(d.testTime) : '—';
        return `${d.tooltip}\n──────────────\n`
            + `Scripts:   ✓${d.scriptsPassed || 0}  ✗${d.scriptsFailed || 0}  ↷${d.scriptsSkipped || 0}  (${srate} pass)\n`
            + `Testcases: ✓${d.tcP || 0}  ✗${d.tcF || 0}  ↷${d.tcS || 0}\n`
            + `⏱ Duration: ${elapsed}   ⧗ Test time: ${testT}`;
    };
    // Full-width invisible hover zone per launch so the tooltip shows anywhere over the column
    chartData.forEach((d, i) => {
        const cx = bpL+bgrp*i+bgrp/2, x0 = cx-bw/2, tot = d.p+d.f+d.s;
        const tip = _tip(d);
        if (!tot) { bBars += `<rect x="${x0}" y="${bpT+bcH-2}" width="${bw}" height="2" fill="rgba(148,163,184,.15)" rx="1"><title>${tip}</title></rect>`; }
        else {
            let cy = bpT+bcH;
            const hS=(d.s/bNM)*bcH, hF=(d.f/bNM)*bcH, hP=(d.p/bNM)*bcH;
            if(hS>0.5){cy-=hS;bBars+=`<rect x="${x0}" y="${cy}" width="${bw}" height="${hS}" fill="url(#dg-s)"><title>${tip}</title></rect>`;}
            if(hF>0.5){cy-=hF;bBars+=`<rect x="${x0}" y="${cy}" width="${bw}" height="${hF}" fill="url(#dg-f)"><title>${tip}</title></rect>`;}
            if(hP>0.5){cy-=hP;bBars+=`<rect x="${x0}" y="${cy}" width="${bw}" height="${hP}" fill="url(#dg-p)" rx="${hS<0.5&&hF<0.5?2:0}"><title>${tip}</title></rect>`;}
        }
        // transparent overlay covering the whole column height for easy hovering
        bBars += `<rect x="${bpL+bgrp*i}" y="${bpT}" width="${bgrp}" height="${bcH}" fill="transparent"><title>${tip}</title></rect>`;
        if(i%bls===0||i===bn-1) bX+=`<text x="${cx}" y="${bpT+bcH+13}" text-anchor="middle" font-size="${bn>20?7.5:9}" fill="rgba(148,163,184,.7)">${d.label}</text>`;
    });
    const bAxes = `<line x1="${bpL}" y1="${bpT}" x2="${bpL}" y2="${bpT+bcH}" stroke="rgba(148,163,184,.25)" stroke-width="1"/>
        <line x1="${bpL}" y1="${bpT+bcH}" x2="${W-bpR}" y2="${bpT+bcH}" stroke="rgba(148,163,184,.25)" stroke-width="1"/>`;
    const mainBarSvg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible">${svgDefs}${bGrid}${bAxes}${bBars}${bX}</svg>`;

    const legend = `<div style="display:flex;align-items:center;gap:12px;justify-content:center;margin-top:4px;flex-wrap:wrap">
        <span style="display:flex;align-items:center;gap:3px;font-size:9px;color:var(--text-secondary)"><span style="width:8px;height:8px;background:linear-gradient(#4ade80,#15803d);border-radius:2px;display:inline-block"></span>Passed</span>
        <span style="display:flex;align-items:center;gap:3px;font-size:9px;color:var(--text-secondary)"><span style="width:8px;height:8px;background:linear-gradient(#f87171,#b91c1c);border-radius:2px;display:inline-block"></span>Failed</span>
        <span style="display:flex;align-items:center;gap:3px;font-size:9px;color:var(--text-secondary)"><span style="width:8px;height:8px;background:linear-gradient(#94a3b8,#475569);border-radius:2px;display:inline-block"></span>Skipped</span>
        <span style="font-size:9px;color:var(--text-muted)">${modeLabel}</span>
    </div>`;

    // ── Trend charts ─────────────────────────────────────────────────────────
    const rateData = chartData.map(d => {
        const tot = d.p+d.f+d.s;
        return { label: d.label, v: tot ? +((d.p/tot)*100).toFixed(1) : null };
    });
    const failData = chartData.map(d => ({ label: d.label, v: d.f }));

    const rateSvg = _svgLine(rateData, 560, 100, { yMax: 100, suffix: '%', color: '#22c55e', fill: 'rgba(34,197,94,0.22)' });
    const failSvg = _svgLine(failData, 560, 100, { color: '#ef4444', fill: 'rgba(239,68,68,0.22)' });

    // ── Assemble ─────────────────────────────────────────────────────────────
    const secH = lbl => `<div style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:4px">${lbl}</div>`;

    const _panel = (accent, r, g, b, content) =>
        `<div style="background:rgba(${r},${g},${b},0.05);border:1px solid rgba(${r},${g},${b},0.18);border-top:2px solid rgba(${r},${g},${b},0.55);border-radius:8px;padding:8px">${content}</div>`;

    const secHhint = (lbl, hint) => `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted)">${lbl}</span>
        <span style="font-size:8px;color:var(--text-muted);font-style:italic">${hint}</span>
    </div>`;

    el.style.display = 'block';
    el.innerHTML = kpi
        + _panel('blue',59,130,246,
            secHhint('Scripts Passed / Failed per Batch','hover a bar for scripts, testcases &amp; duration')
            + mainBarSvg + legend)
        + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
            ${_panel('green',34,197,94,secH('Pass Rate Trend')+rateSvg)}
            ${_panel('red',239,68,68,secH('Failed Cases Trend')+failSvg)}
        </div>`;
}

function _niceAxisTicks(maxVal, target = 5) {
    if (maxVal <= 0) return { ticks: [0], niceMax: 1 };
    // For small integers keep every integer tick to avoid duplicates
    if (maxVal < target) {
        const ticks = Array.from({ length: maxVal + 1 }, (_, i) => i);
        return { ticks, niceMax: maxVal };
    }
    const roughStep = maxVal / target;
    const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const step = [1, 2, 5, 10].map(n => n * mag).find(s => s >= roughStep) || mag * 10;
    const niceMax = Math.ceil(maxVal / step) * step;
    const ticks = [];
    for (let v = 0; v <= niceMax + step * 0.01; v += step) {
        const t = Math.round(v);
        if (!ticks.length || ticks[ticks.length - 1] !== t) ticks.push(t);
        if (ticks.length > 12) break;
    }
    return { ticks, niceMax };
}

function _fmtDayLabel(isoDate) {
    if (!isoDate || isoDate === 'unknown') return '?';
    try {
        const [y, m, d] = isoDate.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return isoDate.slice(5); }
}

function _fmtDurShort(seconds) {
    if (!seconds) return '—';
    if (seconds < 60)   return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds/60)}m${seconds%60?(seconds%60)+'s':''}`;
    return `${Math.floor(seconds/3600)}h${Math.floor((seconds%3600)/60)?Math.floor((seconds%3600)/60)+'m':''}`;
}

function _svgDonut(slices) {
    const W = 156, H = 140;
    const cx = 78, cy = 65, R = 50, SW = 15;
    const C = 2 * Math.PI * R;
    const total = slices.reduce((a, b) => a + b.v, 0);
    if (!total) return `<svg viewBox="0 0 ${W} ${H}" style="display:block;width:100%">
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(148,163,184,.07)" stroke-width="${SW}"/>
        <text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" fill="rgba(148,163,184,.35)">No data</text>
    </svg>`;
    const pass = slices.find(s => s.label === 'Passed');
    const passPct = pass ? Math.round((pass.v/total)*100) : 0;
    const passColor = pass ? pass.color : '#22c55e';
    let cumDash = 0;
    const rings = slices.filter(s => s.v > 0).map(s => {
        const dash = (s.v/total)*C;
        const offset = -cumDash;
        cumDash += dash;
        return `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${SW}" opacity="0.88"
            stroke-dasharray="${dash.toFixed(2)} ${(C-dash+0.01).toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}">
            <title>${s.label}: ${s.v.toLocaleString()} (${((s.v/total)*100).toFixed(1)}%)</title>
        </circle>`;
    }).join('');
    const legItems = slices.map((s, i) => {
        const x = 6 + i * 50;
        return `<rect x="${x}" y="${H-13}" width="7" height="7" fill="${s.color}" rx="1" opacity="0.85"/>
            <text x="${x+10}" y="${H-6}" font-size="7.5" fill="rgba(148,163,184,.7)">${s.label}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="display:block;width:100%">
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(148,163,184,.06)" stroke-width="${SW}"/>
        <g transform="rotate(-90 ${cx} ${cy})">${rings}</g>
        <text x="${cx}" y="${cy-4}" text-anchor="middle" font-size="18" font-weight="700" fill="${passColor}">${passPct}%</text>
        <text x="${cx}" y="${cy+10}" text-anchor="middle" font-size="7.5" fill="rgba(148,163,184,.55)">PASS RATE</text>
        ${legItems}
    </svg>`;
}

function _svgLine(data, W, H, opts = {}) {
    const { color = '#3b82f6', fill = 'rgba(59,130,246,0.1)', yMax, suffix = '' } = opts;
    const pL = 32, pR = 6, pT = 6, pB = 20;
    const cW = W-pL-pR, cH = H-pT-pB, n = data.length;
    if (!n) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block"></svg>`;
    const vals = data.map(d => d.v).filter(v => v !== null && v !== undefined);
    const raw = vals.length ? Math.max(...vals) : 1;
    const usedMax = yMax !== undefined ? yMax : raw || 1;
    const { ticks: lt, niceMax: drawMax } = yMax !== undefined
        ? { ticks: [0,25,50,75,100], niceMax: 100 }
        : _niceAxisTicks(usedMax);
    let grid = '';
    lt.forEach(v => {
        const y = pT+cH-(v/drawMax)*cH;
        const lbl = yMax !== undefined ? `${v}${suffix}` : (v>=1000?(v/1000)+'k':String(v));
        grid += `<line x1="${pL}" y1="${y}" x2="${W-pR}" y2="${y}" stroke="rgba(148,163,184,.07)" stroke-width="1"/>
            <text x="${pL-3}" y="${y+3}" text-anchor="end" font-size="7.5" fill="rgba(148,163,184,.55)">${lbl}</text>`;
    });
    const xOf = i => pL + (n > 1 ? (i/(n-1))*cW : cW/2);
    const yOf = v => pT + cH - (v/drawMax)*cH;
    const pts = data.map((d, i) => ({ x: xOf(i), y: (d.v !== null && d.v !== undefined) ? yOf(d.v) : null, d }));
    const vp = pts.filter(p => p.y !== null);
    let pathD = '', areaD = '';
    vp.forEach((p, i) => { pathD += i===0 ? `M${p.x} ${p.y}` : ` L${p.x} ${p.y}`; });
    if (vp.length > 1) areaD = pathD + ` L${vp[vp.length-1].x} ${pT+cH} L${vp[0].x} ${pT+cH}Z`;
    const dots = vp.map(p =>
        `<circle cx="${p.x}" cy="${p.y}" r="2.2" fill="${color}"><title>${p.d.label}: ${p.d.v!==null?(p.d.v.toFixed?p.d.v.toFixed(1):p.d.v):'—'}${suffix}</title></circle>`
    ).join('');
    const ls = n>18?Math.ceil(n/10):n>8?2:1;
    let xSvg='';
    data.forEach((d,i)=>{
        if(i%ls===0||i===n-1) xSvg+=`<text x="${xOf(i)}" y="${pT+cH+13}" text-anchor="middle" font-size="7" fill="rgba(148,163,184,.55)">${d.label}</text>`;
    });
    const axes = `<line x1="${pL}" y1="${pT}" x2="${pL}" y2="${pT+cH}" stroke="rgba(148,163,184,.18)" stroke-width="1"/>
        <line x1="${pL}" y1="${pT+cH}" x2="${W-pR}" y2="${pT+cH}" stroke="rgba(148,163,184,.18)" stroke-width="1"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible">
        ${grid}${axes}
        ${areaD?`<path d="${areaD}" fill="${fill}" stroke="none"/>`:''}
        ${pathD?`<path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`:''}
        ${dots}${xSvg}
    </svg>`;
}

function _svgSimpleBar(data, W, H, opts = {}) {
    const { color = '#8b5cf6', color2 = null, yFmt = v => String(v) } = opts;
    const pL = 40, pR = 6, pT = 6, pB = 20;
    const cW = W-pL-pR, cH = H-pT-pB, n = data.length;
    if (!n) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block"></svg>`;
    const maxV = Math.max(...data.map(d=>d.v||0), 1);
    const { ticks, niceMax } = _niceAxisTicks(maxV);
    const gradDef = color2 ? `<defs><linearGradient id="dg-sb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${color2}"/></linearGradient></defs>` : '';
    const fillRef = color2 ? 'url(#dg-sb)' : color;
    let grid='';
    ticks.forEach(v => {
        const y = pT+cH-(v/niceMax)*cH;
        grid += `<line x1="${pL}" y1="${y}" x2="${W-pR}" y2="${y}" stroke="rgba(148,163,184,.07)" stroke-width="1"/>
            <text x="${pL-3}" y="${y+3}" text-anchor="end" font-size="7.5" fill="rgba(148,163,184,.55)">${yFmt(v)}</text>`;
    });
    const bg=cW/n, bw=Math.max(Math.min(bg*0.7,32),2);
    const ls=n>18?Math.ceil(n/10):n>8?2:1;
    let bars='', xSvg='';
    data.forEach((d,i)=>{
        const cx=pL+bg*i+bg/2, h=((d.v||0)/niceMax)*cH;
        bars += h>0.5
            ? `<rect x="${cx-bw/2}" y="${pT+cH-h}" width="${bw}" height="${h}" fill="${fillRef}" rx="2"><title>${d.label}: ${yFmt(d.v)}</title></rect>`
            : `<rect x="${cx-bw/2}" y="${pT+cH-2}" width="${bw}" height="2" fill="rgba(148,163,184,.12)" rx="1"/>`;
        if(i%ls===0||i===n-1) xSvg+=`<text x="${cx}" y="${pT+cH+13}" text-anchor="middle" font-size="7" fill="rgba(148,163,184,.55)">${d.label}</text>`;
    });
    const axes = `<line x1="${pL}" y1="${pT}" x2="${pL}" y2="${pT+cH}" stroke="rgba(148,163,184,.18)" stroke-width="1"/>
        <line x1="${pL}" y1="${pT+cH}" x2="${W-pR}" y2="${pT+cH}" stroke="rgba(148,163,184,.18)" stroke-width="1"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible">
        ${gradDef}${grid}${axes}${bars}${xSvg}
    </svg>`;
}

// ── Compare ────────────────────────────────────────────────────────────────

function onCompareCheck(checkbox) {
    const id = parseInt(checkbox.dataset.id);
    if (checkbox.checked) _compareSelected.add(id);
    else _compareSelected.delete(id);
    _syncLogsHeaderBtns();
}

function toggleAllCompare(masterChk) {
    _compareSelected.clear();
    document.querySelectorAll('.cmp-chk').forEach(c => {
        c.checked = masterChk.checked;
        if (masterChk.checked) _compareSelected.add(parseInt(c.dataset.id));
    });
    _syncLogsHeaderBtns();
}

function _syncLogsHeaderBtns() {
    const n = _compareSelected.size;
    const compareBtn = document.getElementById('btn-compare-selected');
    const deleteBtn  = document.getElementById('btn-delete-selected');
    const countSpan  = document.getElementById('del-selected-count');
    if (compareBtn) compareBtn.style.display = n === 2 ? '' : 'none';
    if (deleteBtn) {
        const active = n >= 1;
        deleteBtn.style.opacity       = active ? '1' : '0.35';
        deleteBtn.style.pointerEvents = active ? '' : 'none';
        deleteBtn.style.cursor        = active ? '' : 'not-allowed';
    }
    if (countSpan) countSpan.textContent = n >= 1 ? ` (${n})` : '';
}

async function runComparison() {
    if (_compareSelected.size !== 2) { toast('Select exactly 2 executions', 'warning'); return; }
    const [a, b] = [..._compareSelected];
    try {
        const res = await fetch(`${API}/api/executions/compare?a=${a}&b=${b}`,
            { headers: getSessionHeaders() });
        if (!res.ok) { toast('Comparison failed', 'error'); return; }
        const data = await res.json();
        renderComparePanel(data);
    } catch (e) { toast(`Compare error: ${e.message}`, 'error'); }
}

function renderComparePanel(data) {
    const panel = document.getElementById('compare-panel');
    const body = document.getElementById('compare-panel-body');
    const title = document.getElementById('compare-panel-title');
    if (!panel || !body) return;
    title.textContent = `Run #${data.run_a.id} vs Run #${data.run_b.id}`;
    panel.style.display = '';
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);

    const section = (label, color, icon, items) => {
        if (!items.length) return '';
        const rows = items.map(i =>
            `<tr><td style="color:${color}">${icon}</td>
             <td style="font-family:var(--font-mono,monospace);font-size:11px">${esc(i.test_function)}</td>
             <td style="color:var(--text-secondary);font-size:12px">${esc(i.result_a)}</td>
             <td style="color:var(--text-secondary);font-size:12px">→</td>
             <td style="font-size:12px;color:${color}">${esc(i.result_b)}</td></tr>`
        ).join('');
        return `<div style="margin-bottom:16px">
            <div style="font-weight:600;font-size:12px;text-transform:uppercase;
                letter-spacing:1px;color:${color};margin-bottom:6px">
                ${label} (${items.length})</div>
            <table class="data-table" style="font-size:12px">
                <tbody>${rows}</tbody></table></div>`;
    };

    const stableSection = (label, items) => {
        if (!items.length) return '';
        const preview = items.slice(0, 3).map(i =>
            `<span style="font-size:11px;background:var(--bg-tertiary);padding:2px 8px;
             border-radius:4px;font-family:monospace">${esc(i.test_function)}</span>`
        ).join(' ');
        const more = items.length > 3 ? ` <span class="muted">+${items.length - 3} more</span>` : '';
        return `<div style="margin-bottom:10px;font-size:12px">
            <span class="muted" style="font-weight:600">${label} (${items.length}):</span>
            <span style="margin-left:8px">${preview}${more}</span></div>`;
    };

    body.innerHTML =
        section('REGRESSED', 'var(--red,#ef4444)', '🔴', data.regressed) +
        section('NEW FAILURES', 'var(--red,#ef4444)', '🆕', data.new_failures) +
        section('FIXED', 'var(--green,#22c55e)', '🟢', data.fixed) +
        stableSection('STABLE PASS', data.stable_pass) +
        stableSection('STABLE FAIL', data.stable_fail) +
        stableSection('STABLE SKIP', data.stable_skip) +
        ((!data.regressed.length && !data.new_failures.length && !data.fixed.length)
            ? '<p class="muted" style="text-align:center;padding:20px">No regressions or fixes found between these two runs.</p>'
            : '');
}

function closeComparePanel() {
    const panel = document.getElementById('compare-panel');
    if (panel) panel.style.display = 'none';
}

// ── Testcase History ───────────────────────────────────────────────────────

async function loadTestcaseHistory() {
    const tbody = document.getElementById('tc-history-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">Loading...</td></tr>';
    try {
        const res = await fetch(`${API}/api/testcases/summary?limit=50`,
            { headers: getSessionHeaders() });
        if (!res.ok) { tbody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">No data.</td></tr>'; return; }
        _tcHistoryData = await res.json();
        renderTestcaseHistory(_tcHistoryData);
    } catch {
        tbody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">Failed to load.</td></tr>';
    }
}

function renderTestcaseHistory(data) {
    const tbody = document.getElementById('tc-history-tbody');
    if (!tbody) return;
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align:center;padding:20px">No testcase data yet. Run a SpyTest execution first.</td></tr>';
        return;
    }
    tbody.innerHTML = data.map(tc => {
        const dots = tc.results.map(r => {
            const n = (r.result || '').toLowerCase();
            const color = n === 'pass' ? '#22c55e' : n === 'fail' ? '#ef4444' : '#94a3b8';
            const sym = n === 'pass' ? '✓' : n === 'fail' ? '✗' : '↷';
            return `<span title="${esc(r.result)} (exec #${r.execution_id})"
                style="color:${color};font-size:14px;margin-right:4px">${sym}</span>`;
        }).join('');
        const trendInfo = _trendLabel(tc.trend);
        const fn = tc.test_function || '';
        const shortFn = fn.length > 55 ? fn.slice(0, 52) + '…' : fn;
        return `<tr style="cursor:pointer" onclick="showTcPopover(this,'${encodeURIComponent(JSON.stringify(tc))}')">
            <td style="font-family:monospace;font-size:11px" title="${esc(fn)}">${esc(shortFn)}</td>
            <td>${dots}</td>
            <td><span style="color:${trendInfo.color};font-size:12px">${trendInfo.label}</span></td>
        </tr>`;
    }).join('');
}

function _trendLabel(trend) {
    const map = {
        stable_pass: { label: 'Stable ✓', color: '#22c55e' },
        stable_fail: { label: 'Stable ✗', color: '#ef4444' },
        regressing:  { label: 'Regressing 🔴', color: '#ef4444' },
        fixing:      { label: 'Fixing 🟢', color: '#22c55e' },
        flaky:       { label: 'Flaky ⚠', color: '#f59e0b' },
        unknown:     { label: '–', color: '#94a3b8' },
    };
    return map[trend] || map.unknown;
}

function filterTestcaseHistory(query) {
    const q = query.toLowerCase();
    const filtered = _tcHistoryData.filter(tc =>
        (tc.test_function || '').toLowerCase().includes(q));
    renderTestcaseHistory(filtered);
}

function showTcPopover(row, encoded) {
    // Remove any existing popover
    document.querySelectorAll('.tc-popover').forEach(p => p.remove());

    let tc;
    try { tc = JSON.parse(decodeURIComponent(encoded)); }
    catch { return; }

    const rows = tc.results.map(r => {
        const color = (r.result || '').toLowerCase() === 'pass' ? '#22c55e'
            : (r.result || '').toLowerCase() === 'fail' ? '#ef4444' : '#94a3b8';
        return `<tr>
            <td style="padding:3px 8px">#${r.execution_id}</td>
            <td style="padding:3px 8px;color:${color}">${esc(r.result || '')}</td>
            <td style="padding:3px 8px;color:#94a3b8">${r.time_seconds || 0}s</td>
        </tr>`;
    }).join('');

    const pop = document.createElement('div');
    pop.className = 'tc-popover';
    pop.style.cssText = 'position:absolute;z-index:999;background:var(--bg-secondary);' +
        'border:1px solid var(--border);border-radius:8px;padding:12px;min-width:200px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px';
    pop.innerHTML = `<div style="font-family:monospace;font-size:10px;color:#94a3b8;
        margin-bottom:8px;word-break:break-all">${esc(tc.test_function)}</div>
        <table style="border-collapse:collapse;width:100%">
        <thead><tr><th style="padding:2px 8px;color:#64748b;text-align:left">Exec</th>
            <th style="padding:2px 8px;color:#64748b;text-align:left">Result</th>
            <th style="padding:2px 8px;color:#64748b;text-align:left">Time</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <div style="margin-top:8px;text-align:right">
            <button onclick="this.closest('.tc-popover').remove()"
                style="border:none;background:none;color:#64748b;cursor:pointer;font-size:11px">
                close ✕</button></div>`;

    // Position below the row
    const rect = row.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = (rect.left + window.scrollX) + 'px';
    document.body.appendChild(pop);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function handler(e) {
            if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', handler); }
        });
    }, 10);
}

// ── Execution delete helpers ──────────────────────────────────────────────────

async function deleteExecution(id) {
    if (!confirm(`Delete execution #${id}?\nThis permanently removes the record and all its logs.`)) return;
    try {
        const res = await fetch(`${API}/api/executions/${id}/logs`, {
            method: 'DELETE',
            headers: { ...getSessionHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'all' }),
        });
        if (res.ok) {
            toast(`Execution #${id} deleted`, 'success');
            if (currentExecId && Number(currentExecId) === Number(id)) {
                currentExecId = null; currentExecActive = false;
            }
            _compareSelected.delete(id);
            _syncLogsHeaderBtns();
            loadExecutions();
        } else {
            const err = await res.json().catch(() => ({}));
            toast(err.detail || 'Delete failed', 'error');
        }
    } catch (e) { toast(`Delete error: ${e.message}`, 'error'); }
}

async function deleteSelectedExecutions() {
    const ids = [..._compareSelected];
    if (!ids.length) { toast('Select at least one execution', 'warning'); return; }
    if (!confirm(`Delete ${ids.length} execution(s)?\nThis permanently removes all selected records and logs.`)) return;

    let ok = 0, fail = 0;
    for (const id of ids) {
        try {
            const res = await fetch(`${API}/api/executions/${id}/logs`, {
                method: 'DELETE',
                headers: { ...getSessionHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'all' }),
            });
            res.ok ? ok++ : fail++;
        } catch { fail++; }
    }

    if (fail) toast(`${ok} deleted, ${fail} failed`, 'error');
    else toast(`${ok} execution(s) deleted`, 'success');

    _compareSelected.clear();
    _syncLogsHeaderBtns();
    loadExecutions();
}

// ─────────────────────────────────────────────────────────────────────────────

// Store current viewing execution ID for delete operations
let currentViewingExecId = null;

async function viewExecLogs(execId) {
    try {
        currentViewingExecId = execId;
        // Show modal instead of inline card
        const overlay = document.getElementById('log-detail-modal-overlay');
        overlay.classList.add('active');
        document.getElementById('log-detail-title').textContent = `#${execId}`;
        const container = document.getElementById('log-detail-container');
        container.innerHTML = '<p class="muted" style="padding:20px;">Loading logs…</p>';

        // Fetch ALL logs (every script), paging by id — the endpoint caps each page,
        // so a single limited request only showed the first script's lines.
        const all = [];
        let after = 0;
        for (let page = 0; page < 500; page++) {   // hard guard: up to 500 pages
            const res = await fetch(`${API}/api/executions/${execId}/logs?after_id=${after}&limit=2000`, {
                headers: getSessionHeaders()
            });
            if (!res.ok) break;
            const rows = await res.json();
            if (!Array.isArray(rows) || rows.length === 0) break;
            all.push(...rows);
            after = rows[rows.length - 1].id;
            if (rows.length < 2000) break;   // last page reached
        }

        if (!all.length) {
            container.innerHTML = '<p class="muted" style="padding:20px;">No logs for this execution.</p>';
            return;
        }
        container.innerHTML = all.map(logHTML).join('');
    } catch (e) {
        toast('Failed to load logs', 'error');
        console.error('Error loading logs:', e);
    }
}

/**
 * Close the log viewer modal
 */
function closeLogViewer() {
    const overlay = document.getElementById('log-detail-modal-overlay');
    overlay.classList.remove('active');
    currentViewingExecId = null;
}

async function deleteLogs() {
    if (!currentViewingExecId) return;
    try {
        const res = await fetch(`${API}/api/executions/${currentViewingExecId}/logs`, {
            method: 'DELETE',
            headers: { ...getSessionHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'all' }),
        });
        if (res.ok) {
            toast(`Execution #${currentViewingExecId} deleted`, 'success');
            if (currentExecId && Number(currentExecId) === Number(currentViewingExecId)) {
                currentExecId = null; currentExecActive = false;
            }
            closeLogViewer();
            loadExecutions();
        } else {
            const err = await res.json().catch(() => ({}));
            toast(err.detail || 'Delete failed', 'error');
        }
    } catch (e) { toast(`Delete error: ${e.message}`, 'error'); }
}

// ============================================================
// TERMINAL - PTY Mode with xterm.js
// ============================================================

function renderTermDUTList() {
    const sel = document.getElementById('term-dut');
    if (!sel) return;
    // Terminal tab: only show online SSH devices — offline or telnet devices
    // cannot open a PTY session.
    const allSsh = dutsData.filter(d => d.connection_type !== 'telnet');
    const onlineSsh = allSsh.filter(d => d.status === 'online');
    const offlineCount = allSsh.length - onlineSsh.length;

    sel.innerHTML = '<option value="">+ Connect Device…</option>';
    onlineSsh.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        const isOpen = !!termSessions[String(d.id)];
        opt.textContent = `\u{1F7E2} ${d.name} (${d.ip_address})${isOpen ? ' — connected' : ''}`;
        sel.appendChild(opt);
    });
    if (offlineCount > 0) {
        const divider = document.createElement('option');
        divider.disabled = true;
        divider.textContent = `\u2014 ${offlineCount} offline device${offlineCount > 1 ? 's' : ''} hidden \u2014`;
        sel.appendChild(divider);
    }
    sel.value = '';  // stay a pure "add" control
}

// ── Multi-session terminal: tab bar ──────────────────────────────────────────
function renderTermTabs() {
    const bar = document.getElementById('term-tabs');
    const empty = document.getElementById('term-empty');
    if (!bar) return;
    const ids = Object.keys(termSessions);
    if (ids.length === 0) {
        bar.style.display = 'none';
        bar.innerHTML = '';
        if (empty) empty.style.display = '';
        return;
    }
    bar.style.display = 'flex';
    if (empty) empty.style.display = 'none';
    bar.innerHTML = ids.map(id => {
        const s = termSessions[id];
        const active = id === termActiveDutId ? ' active' : '';
        const dot = s.connected ? '#0dbc79' : (s.reconnecting ? '#e5e510' : '#f14c4c');
        return `<div class="term-tab${active}" onclick="termActivate('${id}')" title="${esc(s.name)}">
            <span class="term-tab-dot" style="background:${dot}"></span>
            <span class="term-tab-label">${esc(s.name)}</span>
            <span class="term-tab-close" onclick="event.stopPropagation();termCloseSession('${id}')" title="Close session">&times;</span>
        </div>`;
    }).join('');
}

// Show one session's pane, hide the rest; fit + focus the active terminal.
function termActivate(dutId) {
    dutId = String(dutId);
    const s = termSessions[dutId];
    if (!s) return;
    termActiveDutId = dutId;
    Object.keys(termSessions).forEach(id => {
        const sess = termSessions[id];
        if (sess.pane) sess.pane.style.display = (id === dutId) ? 'block' : 'none';
    });
    renderTermTabs();
    setTimeout(() => {
        try { s.fitAddon && s.fitAddon.fit(); } catch (_) {}
        try { s.term && s.term.focus(); } catch (_) {}
    }, 30);
}

// Called by the dropdown: open a new session for the chosen device (or focus it
// if already open). The dropdown then resets to the "add" placeholder.
async function termAddDevice() {
    const sel = document.getElementById('term-dut');
    const dutId = sel ? String(sel.value) : '';
    if (sel) sel.value = '';
    if (!dutId) return;

    if (termSessions[dutId]) { termActivate(dutId); return; }

    const dev = dutsData.find(d => String(d.id) === dutId);
    const name = dev ? `${dev.name}` : `DUT ${dutId}`;

    const panes = document.getElementById('term-panes');
    const empty = document.getElementById('term-empty');
    if (empty) empty.style.display = 'none';
    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.id = `term-pane-${dutId}`;
    pane.style.cssText = 'height:100%;width:100%;padding:10px;box-sizing:border-box;background:#1e1e1e;';
    panes.appendChild(pane);

    const session = {
        dutId, name, term: null, socket: null, fitAddon: null,
        pane, outputBuffer: [], reconnecting: false, resizeObserver: null,
        generation: 0, connected: false,
    };
    termSessions[dutId] = session;
    renderTermDUTList();
    termActivate(dutId);

    await initPTYSession(session);
}

/**
 * Load xterm.js library dynamically from CDN
 * Loads core library, fit addon, and CSS
 */
async function loadXtermLibrary() {
    if (xtermLoaded) return; // Already loaded

    return new Promise((resolve, reject) => {
        // Load xterm.js CSS
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css';
        document.head.appendChild(link);

        // Load xterm.js core library
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js';
        script.onload = () => {
            // Load fit addon for auto-resize
            const fitScript = document.createElement('script');
            fitScript.src = 'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js';
            fitScript.onload = () => {
                xtermLoaded = true;
                console.log('[PTY] xterm.js library loaded successfully');
                resolve();
            };
            fitScript.onerror = () => {
                console.error('[PTY] Failed to load xterm-addon-fit');
                reject(new Error('Failed to load xterm-addon-fit'));
            };
            document.head.appendChild(fitScript);
        };
        script.onerror = () => {
            console.error('[PTY] Failed to load xterm.js');
            reject(new Error('Failed to load xterm.js'));
        };
        document.head.appendChild(script);
    });
}

/**
 * Initialize a PTY xterm session for ONE device (multi-session aware).
 * All state lives on the `session` object so many devices run concurrently.
 */
async function initPTYSession(session) {
    try {
        await loadXtermLibrary();
    } catch (e) {
        console.error('[PTY] Failed to load xterm.js library:', e);
        toast('Failed to load terminal library', 'error');
        return;
    }
    if (!termSessions[session.dutId]) return;  // closed while loading

    const dutId = session.dutId;
    const gen = ++session.generation;  // invalidates stale reconnects

    if (session.socket) {
        session.socket.onclose = null;
        try { session.socket.close(); } catch (_) {}
        session.socket = null;
    }
    if (session.term) { try { session.term.dispose(); } catch (_) {} session.term = null; }

    const container = session.pane;
    if (!container) return;

    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        theme: {
            background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff', cursorAccent: '#000000',
            selection: '#264f78', black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
            blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666',
            brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea',
            brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5'
        },
        cols: 80, rows: 24, scrollback: 10000, scrollOnUserInput: true, allowTransparency: false
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    container.innerHTML = '';
    term.open(container);
    setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 60);

    const xtermViewport = container.querySelector('.xterm-viewport');
    if (xtermViewport) xtermViewport.addEventListener('scroll', e => e.stopPropagation(), { passive: true });
    container.addEventListener('wheel', e => e.stopPropagation(), { passive: true });

    session.term = term;
    session.fitAddon = fitAddon;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sessionId = localStorage.getItem('eka-session-id');
    const wsUrl = `${wsProtocol}//${window.location.host}/api/terminal/ws/${dutId}?session_id=${sessionId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    session.socket = ws;

    ws.onopen = () => {
        session.reconnecting = false;
        session.connected = true;
        renderTermTabs();
        if (termActiveDutId === dutId) term.focus();
        term.write('\x1b[32m✓ Connected to PTY terminal\x1b[0m\r\n');
        term.write('\x1b[33mSupports: vi, nano, top, htop, screen, tmux, and all interactive applications\x1b[0m\r\n\r\n');
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            const data = new Uint8Array(event.data);
            term.write(data);
            session.outputBuffer.push(data);
            const vp = container.querySelector('.xterm-viewport');
            if (vp) vp.scrollTop = vp.scrollHeight;
        } else if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'heartbeat') { /* keepalive */ }
                else if (msg.error) { term.write(`\r\n\x1b[31mError: ${msg.error}\x1b[0m\r\n`); }
                else if (msg.status === 'connecting') { term.write(`\x1b[33m${msg.message}\x1b[0m\r\n`); }
            } catch (e) { term.write(event.data); }
            const vp = container.querySelector('.xterm-viewport');
            if (vp) vp.scrollTop = vp.scrollHeight;
        }
    };

    ws.onerror = () => {
        session.connected = false;
        renderTermTabs();
        if (termSessions[dutId] && session.generation === gen) {
            term.write('\r\n\x1b[31m✗ Connection error\x1b[0m\r\n');
        }
    };

    ws.onclose = () => {
        session.connected = false;
        if (!termSessions[dutId] || session.generation !== gen) return;  // stale/closed
        renderTermTabs();
        term.write('\r\n\x1b[33m[Terminal session ended - attempting to reconnect...]\x1b[0m\r\n');
        if (!document.hidden && !session.reconnecting) {
            session.reconnecting = true;
            renderTermTabs();
            setTimeout(() => {
                if (!termSessions[dutId] || session.generation !== gen) { session.reconnecting = false; return; }
                initPTYSession(session).catch(e => {
                    console.error('[PTY] Auto-reconnect failed:', e);
                    if (termSessions[dutId] && session.term) {
                        session.term.writeln('\x1b[31mReconnection failed. Close and re-open the tab to retry.\x1b[0m');
                    }
                });
            }, 1000);
        }
    };

    term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    });
    term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    const resizeObserver = new ResizeObserver(() => {
        if (termActiveDutId === dutId && session.fitAddon) {
            try { session.fitAddon.fit(); } catch (_) {}
        }
    });
    resizeObserver.observe(container);
    session.resizeObserver = resizeObserver;

    // One-time: refit/reconnect the active session when the tab regains visibility
    if (!_termVisibilityListenerAdded) {
        _termVisibilityListenerAdded = true;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden || !termActiveDutId) return;
            const s = termSessions[termActiveDutId];
            if (!s) return;
            if (s.socket && s.socket.readyState !== WebSocket.OPEN && !s.reconnecting) {
                initPTYSession(s).catch(e => console.error('[PTY] Visibility reconnect failed:', e));
            } else if (s.fitAddon) {
                try { s.fitAddon.fit(); } catch (_) {}
            }
        });
    }
}

// Close a single session: tear down socket/term/observer and drop its tab.
function termCloseSession(dutId) {
    dutId = String(dutId);
    const s = termSessions[dutId];
    if (!s) return;
    s.generation++;  // invalidate any pending reconnect
    if (s.socket) { s.socket.onclose = null; try { s.socket.close(); } catch (_) {} }
    if (s.resizeObserver) { try { s.resizeObserver.disconnect(); } catch (_) {} }
    if (s.term) { try { s.term.dispose(); } catch (_) {} }
    if (s.pane && s.pane.parentNode) s.pane.parentNode.removeChild(s.pane);
    delete termSessions[dutId];

    const remaining = Object.keys(termSessions);
    if (termActiveDutId === dutId) termActiveDutId = null;
    if (remaining.length) {
        termActivate(termActiveDutId && termSessions[termActiveDutId] ? termActiveDutId : remaining[remaining.length - 1]);
    } else {
        renderTermTabs();
    }
    renderTermDUTList();
}

/**
 * Backwards-compatible entry point for older callers — opens/focuses a session.
 */
async function termDeviceChanged() {
    return termAddDevice();
}

// ============================================================
// MODAL
// ============================================================

function openModal(title, bodyHTML) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-overlay').classList.add('active');
}
function showModal(title, bodyHTML) { openModal(title, bodyHTML); } // Alias for openModal
function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function toast(msg, type = 'info', duration = 4000) {
    const icons = { success: 'check_circle', error: 'error', info: 'info' };
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="material-icons-round">${icons[type] || 'info'}</span> ${esc(msg)}`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(40px)'; setTimeout(() => el.remove(), 300); }, duration);
}

// ============================================================
// GIT REPOSITORY INTEGRATION (SSH-based: git pull on VM)
// ============================================================

window._gitConnected = false;

async function connectGitRepo() {
    const vmId = document.getElementById('spy-vm-select').value;
    const repoUrl = document.getElementById('git-repo-url').value.trim();
    const username = document.getElementById('git-username').value.trim();
    const token = document.getElementById('git-token').value.trim();
    const branch = document.getElementById('git-branch').value.trim() || 'master';

    if (!repoUrl) {
        toast('Repo URL is required', 'error');
        return;
    }
    if (!token) {
        toast('Password / Token is required', 'error');
        return;
    }
    if (!vmId) {
        toast('Please select a VM host', 'error');
        return;
    }

    const btn = document.getElementById('btn-git-connect');
    const progressEl = document.getElementById('git-progress');

    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons-round spin">sync</span> Connecting...';

    progressEl.style.display = '';
    progressEl.innerHTML = '<span class="material-icons-round spin" style="font-size:14px;vertical-align:middle">sync</span> Connecting to VM and running git clone/pull...';

    try {
        const res = await fetch(`${API}/api/git/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                host_id: parseInt(vmId),
                repo_url: repoUrl,
                username: username,
                token: token,
                branch: branch,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Server error ${res.status}`);
        }
        const data = await res.json();
        window._gitConnected = true;

        // Show success
        progressEl.innerHTML = `<div style="color:var(--green)">
            <span class="material-icons-round" style="font-size:14px;vertical-align:middle">check_circle</span>
            <strong>git ${esc(data.action || 'pull')}</strong> successful on <strong>${esc(data.host_name)}</strong>
            <br><span style="color:var(--text-secondary);font-size:11px">${esc(data.pull_message || 'OK')}</span>
        </div>`;

        // Update UI
        const badge = document.getElementById('git-status-badge');
        badge.className = 'badge online';
        badge.textContent = `Connected (${data.categories_count} categories)`;

        document.getElementById('btn-git-connect').style.display = 'none';
        document.getElementById('btn-git-disconnect').style.display = '';
        document.getElementById('spy-vm-select').disabled = true;
        document.getElementById('git-repo-url').disabled = true;
        document.getElementById('git-username').disabled = true;
        document.getElementById('git-token').disabled = true;
        document.getElementById('git-branch').disabled = true;

        const info = document.getElementById('git-info');
        info.style.display = '';
        info.innerHTML = `<div style="margin-bottom:4px"><strong>Repo URL:</strong> <a href="${esc(repoUrl)}" target="_blank" style="color:var(--primary)">${esc(repoUrl)}</a></div>
            <strong>Branch:</strong> ${esc(data.branch)} &bull; <strong>VM:</strong> ${esc(data.host_name)} &bull; <strong>Path:</strong> ${esc(data.tests_path)} &bull; <strong>Categories:</strong> ${data.categories_count}`;

        toast(`Git repo connected! ${data.categories_count} categories found on ${data.host_name}`, 'success');

        // Trigger VM change to reload categories/testbeds from git
        onSpyVMChange();

    } catch (e) {
        progressEl.innerHTML = `<div style="color:var(--red)">
            <span class="material-icons-round" style="font-size:14px;vertical-align:middle">error</span>
            ${esc(e.message)}
        </div>`;
        toast(`Git connection failed: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.style.display = window._gitConnected ? 'none' : '';
        btn.innerHTML = '<span class="material-icons-round">sync</span> Pull';
    }
}

async function disconnectGitRepo() {
    try {
        await fetch(`${API}/api/git/disconnect`, { method: 'POST' });
    } catch (e) { /* ignore */ }

    window._gitConnected = false;

    const badge = document.getElementById('git-status-badge');
    badge.className = 'badge offline';
    badge.textContent = 'Disconnected';

    document.getElementById('btn-git-connect').style.display = '';
    document.getElementById('btn-git-disconnect').style.display = 'none';
    document.getElementById('git-info').style.display = 'none';
    document.getElementById('git-progress').style.display = 'none';
    document.getElementById('spy-vm-select').disabled = false;
    document.getElementById('git-repo-url').disabled = false;
    document.getElementById('git-username').disabled = false;
    document.getElementById('git-token').disabled = false;
    document.getElementById('git-branch').disabled = false;

    toast('Git repo disconnected', 'success');

    // Reload categories from SSH if VM is selected
    const vmId = document.getElementById('spy-vm-select').value;
    if (vmId) onSpyVMChange();
}

// Check Git status on page load
async function checkGitStatus() {
    try {
        const res = await fetch(`${API}/api/git/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'connected') {
            window._gitConnected = true;
            const badge = document.getElementById('git-status-badge');
            badge.className = 'badge online';
            badge.textContent = `Connected (${data.categories_count} categories)`;
            document.getElementById('btn-git-connect').style.display = 'none';
            document.getElementById('btn-git-disconnect').style.display = '';

            // Restore and disable form fields
            if (data.repo_url) document.getElementById('git-repo-url').value = data.repo_url;
            if (data.branch) document.getElementById('git-branch').value = data.branch;
            if (data.host_id) {
                const spyVmSel = document.getElementById('spy-vm-select');
                if (spyVmSel) spyVmSel.value = data.host_id;
            }
            document.getElementById('spy-vm-select').disabled = true;
            document.getElementById('git-repo-url').disabled = true;
            document.getElementById('git-username').disabled = true;
            document.getElementById('git-token').disabled = true;
            document.getElementById('git-branch').disabled = true;

            const info = document.getElementById('git-info');
            info.style.display = '';
            info.innerHTML = `<strong>Repo:</strong> ${esc(data.repo_name || '')} &bull; <strong>Branch:</strong> ${esc(data.branch || '')} &bull; <strong>Host:</strong> ${esc(data.host_name || '')} &bull; <strong>Categories:</strong> ${data.categories_count}`;
        }
    } catch (e) { /* ignore */ }
}


checkGitStatus();




// ============================================================
// TOPOLOGY CANVAS — GNS3-Style DUT Visualization
// ============================================================

let dutPositions = {};  // {dutId: {x, y}}
let _dragState = null;  // active drag info
let _portCenters = {};  // {"{dutId}:{iface}": {cx, cy}} — set during _drawPortChips
const NODE_W = 92, NODE_H = 46;

function renderTopologyCanvas() {
    const svg = document.getElementById('topology-canvas');
    if (!svg) return;
    const nodesG = document.getElementById('topo-nodes');
    const connsG = document.getElementById('topo-connections');
    const emptyEl = document.getElementById('topo-empty');

    const duts = dutsData.filter(d => d.device_type === 'DUT' && selectedDUTIds.has(Number(d.id)));

    if (!duts.length) {
        if (nodesG) nodesG.innerHTML = '';
        if (connsG) connsG.innerHTML = '';
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // Auto-place nodes that have no custom position yet
    const svgW = svg.getBoundingClientRect().width || 320;
    const cols = Math.max(1, Math.ceil(Math.sqrt(duts.length)));
    const padX = 16, padY = 20, gapX = (svgW - padX * 2 - NODE_W * cols) / Math.max(1, cols - 1) + NODE_W;
    duts.forEach((d, i) => {
        if (!dutPositions[d.id]) {
            dutPositions[d.id] = {
                x: padX + (i % cols) * Math.max(NODE_W + 20, gapX),
                y: padY + Math.floor(i / cols) * (NODE_H + 44),
            };
        }
    });

    _drawTopoConnections(connsG, duts);
    _drawTopoNodes(nodesG, duts);

    // Wire SVG drag events
    svg.onmousemove = _onSVGDrag;
    svg.onmouseup = _endSVGDrag;
    svg.onmouseleave = _endSVGDrag;
}

function _svgPoint(svg, clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function _drawTopoNodes(nodesG, duts) {
    nodesG.innerHTML = '';
    duts.forEach(d => {
        const pos = dutPositions[d.id];
        const online = d.status === 'online';
        const colorFg = '#fff';
        const colorBg = '#3b82f6'; // primary-like blue

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
        g.setAttribute('data-dut-id', d.id);
        g.style.cursor = 'grab';
        g.style.userSelect = 'none';

        // Background rect (shadow)
        const sh = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        sh.setAttribute('width', NODE_W); sh.setAttribute('height', NODE_H);
        sh.setAttribute('rx', '10'); sh.setAttribute('fill', 'rgba(0,0,0,0.25)');
        sh.setAttribute('transform', 'translate(2,3)');
        g.appendChild(sh);

        // Main rect
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('width', NODE_W); r.setAttribute('height', NODE_H);
        r.setAttribute('rx', '10'); r.setAttribute('fill', colorBg);
        r.setAttribute('stroke', online ? '#22c55e' : '#6b7280'); r.setAttribute('stroke-width', '1.5');
        g.appendChild(r);

        // Status dot
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', NODE_W - 9); dot.setAttribute('cy', 9); dot.setAttribute('r', '4');
        dot.setAttribute('fill', online ? '#22c55e' : '#ef4444');
        g.appendChild(dot);

        // Name label
        const name = d.name.length > 11 ? d.name.substring(0, 10) + '…' : d.name;
        const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t1.setAttribute('x', NODE_W / 2); t1.setAttribute('y', 19);
        t1.setAttribute('text-anchor', 'middle'); t1.setAttribute('fill', colorFg);
        t1.setAttribute('font-size', '12'); t1.setAttribute('font-weight', '600');
        t1.setAttribute('font-family', 'Inter,sans-serif');
        t1.textContent = name;
        g.appendChild(t1);

        // IP label
        const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t2.setAttribute('x', NODE_W / 2); t2.setAttribute('y', 33);
        t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('fill', 'rgba(255,255,255,0.7)');
        t2.setAttribute('font-size', '9'); t2.setAttribute('font-family', 'JetBrains Mono,monospace');
        t2.textContent = d.ip_address;
        g.appendChild(t2);

        g.addEventListener('mousedown', e => {
            // In cable mode, prevent drag — popup handles interaction
            if (_cableModeActive) return;
            e.preventDefault();
            const svg = document.getElementById('topology-canvas');
            const svgPt = _svgPoint(svg, e.clientX, e.clientY);
            _dragState = {
                dutId: d.id, svg,
                startX: svgPt.x, startY: svgPt.y,
                origX: dutPositions[d.id].x, origY: dutPositions[d.id].y,
            };
            g.style.cursor = 'grabbing';
            g.dataset.startDragTime = Date.now();
        });

        g.addEventListener('mouseup', e => {
            if (_cableModeActive) {
                // In cable mode: show the floating interface picker popup
                const svgEl = document.getElementById('topology-canvas');
                const rect = svgEl.getBoundingClientRect();
                const svgPt = _svgPoint(svgEl, e.clientX, e.clientY);
                _showInterfacePickerPopup(d, e.clientX, e.clientY);
                return;
            }
            const dt = Date.now() - (g.dataset.startDragTime || 0);
            if (dt < 200) {
                // Short click -> open rich interface details popup
                _showInterfaceInfoModal(d);
            }
        });

        nodesG.appendChild(g);
    });
}

function _drawTopoConnections(connsG, duts) {
    const dutMap = Object.fromEntries(duts.map(d => [d.id, d]));
    connsG.innerHTML = '';

    // Draw pending cable start indicator (if in cable mode and first port selected)
    if (_cableModeActive && _cableStart) {
        const startKey = `${_cableStart.dutId}:${_cableStart.interface}`;
        const startPt = _portCenters[startKey];
        if (startPt) {
            const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            pulse.setAttribute('cx', startPt.cx);
            pulse.setAttribute('cy', startPt.cy);
            pulse.setAttribute('r', '10');
            pulse.setAttribute('fill', 'none');
            pulse.setAttribute('stroke', '#f59e0b');
            pulse.setAttribute('stroke-width', '2');
            pulse.setAttribute('opacity', '0.7');
            connsG.appendChild(pulse);
        }
    }

    dutConnections.forEach((conn, idx) => {
        const aId = Number(conn.dut_a);
        const bId = Number(conn.dut_b);
        if (!aId || !bId || !dutMap[aId] || !dutMap[bId]) return;
        const pA = dutPositions[aId], pB = dutPositions[bId];
        if (!pA || !pB) return;

        // Use port-center coordinates if available (from cable mode), else node center
        const keyA = `${aId}:${conn.intf_a}`;
        const keyB = `${bId}:${conn.intf_b}`;
        const ptA = _portCenters[keyA] || { cx: pA.x + NODE_W / 2, cy: pA.y + NODE_H / 2 };
        const ptB = _portCenters[keyB] || { cx: pB.x + NODE_W / 2, cy: pB.y + NODE_H / 2 };

        const x1 = ptA.cx, y1 = ptA.cy;
        const x2 = ptB.cx, y2 = ptB.cy;

        // Hit-area line (wider, transparent)
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hit.setAttribute('x1', x1); hit.setAttribute('y1', y1);
        hit.setAttribute('x2', x2); hit.setAttribute('y2', y2);
        hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', '14');
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', () => _openConnEditor(idx));
        connsG.appendChild(hit);

        // Visible dashed line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x1); line.setAttribute('y1', y1);
        line.setAttribute('x2', x2); line.setAttribute('y2', y2);
        line.setAttribute('stroke', '#6366f1'); line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '5 3'); line.setAttribute('opacity', '0.75');
        line.style.pointerEvents = 'none';
        connsG.appendChild(line);

        // Right-click on hit-area removes the connection
        hit.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (confirm(`Remove link ${idx + 1}: ${conn.intf_a || '?'} ↔ ${conn.intf_b || '?'}?`)) {
                dutConnections.splice(idx, 1);
                const ed = document.getElementById('conn-editor');
                if (ed) ed.style.display = 'none';
                renderTopologyCanvas();
                _saveConnectionsToServer();
            }
        });


        // Interface label at midpoint
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        if (conn.intf_a || conn.intf_b) {
            const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            const labelText = `${conn.intf_a || '?'} ↔ ${conn.intf_b || '?'}`;
            const labelW = Math.min(120, labelText.length * 5.5 + 8);
            bg.setAttribute('x', mx - labelW / 2); bg.setAttribute('y', my - 10);
            bg.setAttribute('width', labelW); bg.setAttribute('height', 14);
            bg.setAttribute('rx', '4'); bg.setAttribute('fill', 'var(--bg-secondary)');
            bg.setAttribute('opacity', '0.85');
            bg.style.pointerEvents = 'none';
            connsG.appendChild(bg);

            const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            lbl.setAttribute('x', mx); lbl.setAttribute('y', my);
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('fill', 'var(--text-secondary)'); lbl.setAttribute('font-size', '8');
            lbl.setAttribute('font-family', 'JetBrains Mono,monospace');
            lbl.style.pointerEvents = 'none';
            lbl.textContent = labelText;
            connsG.appendChild(lbl);
        }
    });
}

function _onSVGDrag(e) {
    if (!_dragState || _cableModeActive) return;
    e.stopPropagation();
    const svgPt = _svgPoint(_dragState.svg, e.clientX, e.clientY);
    dutPositions[_dragState.dutId] = {
        x: Math.max(0, _dragState.origX + svgPt.x - _dragState.startX),
        y: Math.max(0, _dragState.origY + svgPt.y - _dragState.startY),
    };
    // Incremental update: just move the node group and redraw connections
    const pos = dutPositions[_dragState.dutId];
    const node = document.querySelector(`g[data-dut-id="${_dragState.dutId}"]`);
    if (node) node.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    const duts = dutsData.filter(d => d.device_type === 'DUT' && selectedDUTIds.has(Number(d.id)));
    _drawTopoConnections(document.getElementById('topo-connections'), duts);
}

function _endSVGDrag() {
    if (!_dragState) return;
    const node = document.querySelector(`g[data-dut-id="${_dragState.dutId}"]`);
    if (node) node.style.cursor = 'grab';
    _dragState = null;
}

function _openConnEditor(idx) {
    const conn = dutConnections[idx];
    if (conn === undefined) return;
    const duts = dutsData.filter(d => d.device_type === 'DUT');
    const optA = duts.map(d => `<option value="${d.id}" ${Number(conn.dut_a) === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    const optB = duts.map(d => `<option value="${d.id}" ${Number(conn.dut_b) === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    // Build interface dropdown — use real device interfaces if fetched, else SONIC_PORTS
    const ifacesA = _getInterfacesForDUT(conn.dut_a).map(i => i.name);
    const ifacesB = _getInterfacesForDUT(conn.dut_b).map(i => i.name);
    const portOptA = ifacesA.map(p => `<option value="${p}" ${conn.intf_a === p ? 'selected' : ''}>${p}</option>`).join('');
    const portOptB = ifacesB.map(p => `<option value="${p}" ${conn.intf_b === p ? 'selected' : ''}>${p}</option>`).join('');
    const sel = 'font-size:11px;padding:3px 5px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:5px;color:var(--text-primary)';

    const ed = document.getElementById('conn-editor');
    if (!ed) return;
    ed.style.display = '';
    ed.innerHTML = `
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
            <strong style="color:var(--text-secondary);font-size:10px">LINK ${idx + 1}:</strong>
            <select style="${sel}" onchange="updateConnection(${idx},'dut_a',this.value);renderTopologyCanvas()"><option value="">DUT A</option>${optA}</select>
            <select style="${sel};width:100px" onchange="updateConnection(${idx},'intf_a',this.value);renderTopologyCanvas()"><option value="">Port A</option>${portOptA}</select>
            <span style="color:var(--text-secondary)">↔</span>
            <select style="${sel}" onchange="updateConnection(${idx},'dut_b',this.value);renderTopologyCanvas()"><option value="">DUT B</option>${optB}</select>
            <select style="${sel};width:100px" onchange="updateConnection(${idx},'intf_b',this.value);renderTopologyCanvas()"><option value="">Port B</option>${portOptB}</select>
            <button class="btn outline small" onclick="removeDUTConnection(${idx})" style="padding:2px 5px;color:var(--red)" title="Delete link">
                <span class="material-icons-round" style="font-size:12px">delete</span>
            </button>
            <button onclick="document.getElementById('conn-editor').style.display='none'" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:11px;padding:2px 5px">Close</button>
        </div>`;
}

function clearConnections() {
    dutConnections = [];
    _cableStart = null;
    _portCenters = {};
    renderTopologyCanvas();
    const ed = document.getElementById('conn-editor');
    if (ed) ed.style.display = 'none';
    _saveConnectionsToServer();
    toast('All connections cleared', 'info');
}

// ============================================================
// GNS3-STYLE CABLE MODE
// ============================================================

let _cableModeActive = false;
let _cableStart = null;  // {dutId, interface}

function toggleCableMode() {
    _cableModeActive = !_cableModeActive;
    _cableStart = null;
    if (!_cableModeActive) _portCenters = {};  // Clear port center cache when leaving cable mode

    const btn = document.getElementById('btn-cable-mode');
    if (btn) {
        btn.classList.toggle('active', _cableModeActive);
        btn.title = _cableModeActive ? 'Click to exit cable mode' : 'Cable Mode: click port → click port to connect';
        btn.style.background = _cableModeActive ? 'var(--primary)' : '';
        btn.style.color = _cableModeActive ? '#fff' : '';
        btn.style.borderColor = _cableModeActive ? 'var(--primary)' : '';
        btn.innerHTML = _cableModeActive
            ? '<span class="material-icons-round" style="font-size:12px">cable</span> Cable Mode ON'
            : '<span class="material-icons-round" style="font-size:12px">cable</span> Cable Mode';
    }

    // Switching mode: redraw canvas with / without port icons
    renderTopologyCanvas();
    toast(_cableModeActive ? '🔌 Cable mode ON — click a port chip to start a cable' : '✖ Cable mode OFF', 'info');
}

/**
 * Generate master testbed YAML from ALL canvas DUTs and topology connections
 * @param {boolean} silent - If true, don't show modal/toasts (for auto-generation)
 */
async function generateMasterTestbed(silent = false) {
    const vmId = document.getElementById('spy-vm-select').value;
    if (!vmId) {
        if (!silent) toast('Please select a VM host first', 'error');
        throw new Error('No VM selected');
    }

    if (selectedDUTIds.size === 0) {
        if (!silent) toast('No DUTs in topology. Add devices first.', 'warning');
        throw new Error('No DUTs selected');
    }

    if (dutConnections.length === 0) {
        if (!silent) toast('No connections found. Create connections between DUTs first.', 'warning');
        throw new Error('No connections');
    }

    if (!activeBasePath) {
        const pathInput = document.getElementById('scripts-base-path');
        if (pathInput) { pathInput.style.border = '2px solid #e74c3c'; pathInput.focus(); setTimeout(() => { pathInput.style.border = ''; }, 4000); }
        if (!silent) toast('Please enter the Scripts Path on VM first, then click Load before generating the testbed.', 'error', 7000);
        throw new Error('SCRIPTS_PATH_REQUIRED');
    }

    try {
        // Persist the CURRENT canvas connections to the server first (awaited) so the
        // backend generation reads a consistent, up-to-date topology. Connection saves
        // are otherwise fire-and-forget and could lag behind the click, producing a
        // spurious "No connections found in Topology Canvas" error.
        await _saveConnectionsToServer();

        const res = await fetch(`${API}/api/topology/generate-master-testbed`, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify({
                host_id: parseInt(vmId),
                master_filename: 'master_testbed.yaml',
                base_path: activeBasePath || '',
                // Send the canvas connections directly so generation always reflects
                // exactly what's on the canvas (independent of the async save above).
                connections: dutConnections
            })
        });

        if (!res.ok) {
            const err = await res.json();
            const detail = err.detail || 'Unknown error';
            if (!silent) {
                if (detail.includes('PATH_NOT_FOUND') || detail.includes('SCRIPTS_PATH_REQUIRED') || detail.includes('Scripts Path on VM')) {
                    // Path not set or not found on VM — highlight the path input and guide the user
                    const pathInput = document.getElementById('scripts-base-path');
                    if (pathInput) {
                        pathInput.style.border = '2px solid #e74c3c';
                        pathInput.focus();
                        setTimeout(() => { pathInput.style.border = ''; }, 4000);
                    }
                    const msg = detail.includes('SCRIPTS_PATH_REQUIRED')
                        ? 'Please enter the Scripts Path on VM and click Load before generating the testbed.'
                        : 'Testbed directory not found on VM — verify the Scripts Path on VM field is correct and try again.';
                    toast(msg, 'error', 7000);
                } else {
                    toast(`Failed to generate master testbed: ${detail}`, 'error');
                }
            }
            throw new Error(detail);
        }

        const data = await res.json();
        if (!silent) {
            toast(`Master testbed generated: ${data.device_count} devices, ${data.connection_count} connections`, 'success');
            console.log('Master testbed generated:', data);

            // Show success modal with details
            showModal(
                'Master Testbed Generated',
                `<div style="text-align:left">
                    <p><strong>Testbed Path:</strong> ${data.master_testbed_path}</p>
                    <p><strong>Devices:</strong> ${data.device_count}</p>
                    <p><strong>Connections:</strong> ${data.connection_count}</p>
                    <p><strong>Device Names:</strong> ${data.devices.join(', ')}</p>
                    <p style="margin-top:12px;padding:8px;background:var(--bg-tertiary);border-radius:4px;font-size:11px">
                        The master testbed has been saved to the SPyTest testbeds directory on the VM host.
                        You can now use this testbed for script execution.
                    </p>
                </div>`
            );
        }
        return data;
    } catch (error) {
        if (!silent) {
            toast(`Error generating master testbed: ${error.message}`, 'error');
            console.error('Master testbed generation error:', error);
        }
        throw error;
    }
}

/**
 * Returns the list of interfaces that are already used (by any connection)
 * for a given DUT id (as a Set of interface names).
 */
function _usedPorts(dutId) {
    const used = new Set();
    dutConnections.forEach(c => {
        if (String(c.dut_a) === String(dutId)) used.add(c.intf_a);
        if (String(c.dut_b) === String(dutId)) used.add(c.intf_b);
    });
    return used;
}

/**
 * Standard Sonic/SONiC Ethernet interface names, spaced by 4.
 * Display full names (Ethernet0, Ethernet4, ...) — do NOT abbreviate.
 */
const SONIC_PORTS = Array.from({ length: 32 }, (_, i) => `Ethernet${i * 4}`);

/**
 * Show rich interface info modal when clicking a DUT node in normal mode.
 * Displays all 32 ports in a scrollable list with connected/available status.
 */
function _showInterfaceInfoModal(dut) {
    const usedPorts = _usedPorts(dut.id);

    // Build connection map: port -> peer DUT name + peer interface
    const portConnMap = {};
    dutConnections.forEach(c => {
        if (String(c.dut_a) === String(dut.id) && c.intf_a) {
            const peerDut = dutsData.find(d => String(d.id) === String(c.dut_b));
            portConnMap[c.intf_a] = `↔ ${peerDut ? peerDut.name : 'DUT'} / ${c.intf_b || '?'}`;
        }
        if (String(c.dut_b) === String(dut.id) && c.intf_b) {
            const peerDut = dutsData.find(d => String(d.id) === String(c.dut_a));
            portConnMap[c.intf_b] = `↔ ${peerDut ? peerDut.name : 'DUT'} / ${c.intf_a || '?'}`;
        }
    });

    const usedCount = usedPorts.size;
    const interfaces = _getInterfacesForDUT(dut.id);
    const totalPorts = interfaces.length;
    const isRealData = !!(dutInterfaces[dut.id] && dutInterfaces[dut.id].length > 0);

    let html = `
        <div style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <span class="badge online" style="font-size:11px">${usedCount} Used</span>
            <span class="badge" style="font-size:11px;background:var(--green);color:#fff">${totalPorts - usedCount} Available</span>
            <span style="font-size:11px;color:var(--text-secondary)">${dut.ip_address}:${dut.port}</span>
            ${isRealData
                ? `<span style="font-size:10px;background:var(--accent-glow);color:var(--accent);padding:1px 7px;border-radius:10px">Live data</span>`
                : `<span style="font-size:10px;color:var(--text-muted);font-style:italic">Default ports — ping DUT to get real interfaces</span>`
            }
        </div>
        <div style="max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:8px">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
                <thead>
                    <tr style="background:var(--bg-tertiary);position:sticky;top:0">
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Interface</th>
                        ${isRealData ? `
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Speed</th>
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Oper</th>
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Admin</th>
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Alias</th>
                        ` : ''}
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Used</th>
                        <th style="padding:7px 12px;text-align:left;font-weight:600;border-bottom:1px solid var(--border)">Connection</th>
                    </tr>
                </thead>
                <tbody>`;
    interfaces.forEach(intf => {
        const port = intf.name;
        const isUsed = usedPorts.has(port);
        const peerInfo = portConnMap[port] || '';
        const operColor = intf.oper === 'up' ? 'var(--green)' : intf.oper === 'down' ? 'var(--red)' : 'var(--text-muted)';
        html += `
                    <tr style="border-bottom:1px solid var(--border);transition:background .1s" onmouseenter="this.style.background='var(--bg-tertiary)'" onmouseleave="this.style.background=''">
                        <td style="padding:6px 12px;font-family:var(--mono);font-weight:500">${port}</td>
                        ${isRealData ? `
                        <td style="padding:6px 12px;font-size:11px;color:var(--text-secondary);font-family:var(--mono)">${esc(intf.speed || 'N/A')}</td>
                        <td style="padding:6px 12px">
                            <span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;color:${operColor}">
                                <span style="width:6px;height:6px;border-radius:50%;background:${operColor}"></span>
                                ${esc(intf.oper || 'N/A')}
                            </span>
                        </td>
                        <td style="padding:6px 12px;font-size:11px;color:var(--text-secondary)">${esc(intf.admin || 'N/A')}</td>
                        <td style="padding:6px 12px;font-size:11px;color:var(--text-muted);font-family:var(--mono)">${esc(intf.alias || '')}</td>
                        ` : ''}
                        <td style="padding:6px 12px">
                            <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:${isUsed ? 'var(--red)' : 'var(--green)'}">
                                <span style="width:6px;height:6px;border-radius:50%;background:${isUsed ? 'var(--red)' : 'var(--green)'}"></span>
                                ${isUsed ? 'Connected' : 'Free'}
                            </span>
                        </td>
                        <td style="padding:6px 12px;font-size:11px;color:var(--text-secondary);font-family:var(--mono)">${esc(peerInfo)}</td>
                    </tr>`;
    });
    html += '</tbody></table></div>';
    openModal(`Interfaces — ${dut.name}`, html);
}

/**
 * Floating interface picker popup for cable mode.
 * Shown when user clicks a DUT node while cable mode is active.
 * Positioned near the mouse cursor.
 */
function _showInterfacePickerPopup(dut, clientX, clientY) {
    // Remove any existing picker
    _closeInterfacePickerPopup();

    const usedPorts = _usedPorts(dut.id);
    const isSecondClick = !!_cableStart;
    const dutName = dut.name;

    const popup = document.createElement('div');
    popup.id = 'intf-picker-popup';
    popup.className = 'intf-picker-popup';

    // Position near click, keeping within viewport
    const vpW = window.innerWidth, vpH = window.innerHeight;
    const popW = 240, popH = 320;
    let left = clientX + 10;
    let top = clientY - 20;
    if (left + popW > vpW - 12) left = clientX - popW - 10;
    if (top + popH > vpH - 12) top = vpH - popH - 12;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    const title = isSecondClick
        ? `Connect to: ${dutName}`
        : `Start cable from: ${dutName}`;

    let rowsHtml = '';
    const interfaces = _getInterfacesForDUT(dut.id);
    interfaces.forEach(intf => {
        const port = intf.name;
        const isUsed = usedPorts.has(port);
        const rowClass = isUsed ? 'intf-row used' : 'intf-row available';
        // Oper state indicator (only if real data available)
        const operDot = (intf.oper && intf.oper !== 'N/A')
            ? `<span style="width:5px;height:5px;border-radius:50%;background:${intf.oper === 'up' ? 'var(--green)' : 'var(--red)'};display:inline-block;margin-right:2px"></span>`
            : '';
        const badge = isUsed
            ? `<span style="font-size:9px;padding:1px 5px;border-radius:10px;background:var(--red);color:#fff">Used</span>`
            : `<span style="font-size:9px;padding:1px 5px;border-radius:10px;background:var(--green);color:#fff">${operDot}Free</span>`;
        const clickAttr = isUsed
            ? `onclick="_showUsedPortInfo('${dut.id}','${port}',this)" title="Click to see connection details"`
            : `onclick="_pickInterfaceFromPopup('${dut.id}','${port}')"`;
        rowsHtml += `
            <div class="${rowClass}" ${clickAttr} style="cursor:pointer">
                <span class="intf-row-name">${port}</span>
                ${badge}
            </div>`;
    });

    popup.innerHTML = `
        <div class="intf-picker-header">
            <span class="material-icons-round" style="font-size:14px;color:var(--primary)">cable</span>
            <span>${esc(title)}</span>
            <button onclick="_closeInterfacePickerPopup()" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);margin-left:auto;display:flex;align-items:center">
                <span class="material-icons-round" style="font-size:16px">close</span>
            </button>
        </div>
        <div class="intf-picker-search">
            <input type="text" placeholder="🔍 Filter interfaces..." oninput="_filterInterfacePicker(this.value)"
                style="width:100%;box-sizing:border-box;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:5px;color:var(--text-primary);padding:5px 8px;font-size:12px;outline:none">
        </div>
        <div class="intf-picker-list" id="intf-picker-list">
            ${rowsHtml}
        </div>`;

    document.body.appendChild(popup);

    // Close on outside click (with tiny delay to avoid immediate close)
    setTimeout(() => {
        document.addEventListener('click', _pickerOutsideClickHandler);
    }, 50);
}

function _pickerOutsideClickHandler(e) {
    const popup = document.getElementById('intf-picker-popup');
    if (popup && !popup.contains(e.target)) {
        _closeInterfacePickerPopup();
        document.removeEventListener('click', _pickerOutsideClickHandler);
    }
}

function _closeInterfacePickerPopup() {
    const existing = document.getElementById('intf-picker-popup');
    if (existing) existing.remove();
    document.removeEventListener('click', _pickerOutsideClickHandler);
}

function _filterInterfacePicker(query) {
    const list = document.getElementById('intf-picker-list');
    if (!list) return;
    const q = query.toLowerCase();
    list.querySelectorAll('.intf-row').forEach(row => {
        const name = row.querySelector('.intf-row-name')?.textContent.toLowerCase() || '';
        row.style.display = name.includes(q) ? '' : 'none';
    });
}

function _pickInterfaceFromPopup(dutId, port) {
    _closeInterfacePickerPopup();
    _handlePortClick(dutId, port);
}

/**
 * Called when user clicks a "Used" port row in the interface picker.
 * Shows an inline info card with peer DUT/port details and a Remove button.
 * rowEl is the clicked .intf-row element.
 */
function _showUsedPortInfo(dutId, port, rowEl) {
    // Remove any existing info card in the popup
    const existing = document.getElementById('used-port-info-card');
    if (existing) {
        existing.remove();
        // If it was the same row that was clicked, just toggle off
        if (existing.dataset.port === port && existing.dataset.dutId === String(dutId)) return;
    }

    // Find the matching connection
    const connIdx = dutConnections.findIndex(c =>
        (String(c.dut_a) === String(dutId) && c.intf_a === port) ||
        (String(c.dut_b) === String(dutId) && c.intf_b === port)
    );
    if (connIdx === -1) { toast('Connection not found', 'error'); return; }

    const conn = dutConnections[connIdx];
    const isSideA = String(conn.dut_a) === String(dutId);
    const peerDutId = isSideA ? conn.dut_b : conn.dut_a;
    const peerPort  = isSideA ? conn.intf_b : conn.intf_a;
    const peerDut   = dutsData.find(d => String(d.id) === String(peerDutId));
    const peerName  = peerDut ? peerDut.name : `DUT ${peerDutId}`;
    const isLoop    = String(conn.dut_a) === String(conn.dut_b);

    // Build and insert the info card right below the clicked row
    const card = document.createElement('div');
    card.id = 'used-port-info-card';
    card.dataset.port = port;
    card.dataset.dutId = String(dutId);
    card.style.cssText = `
        margin: 4px 8px 6px;
        padding: 9px 10px;
        background: var(--bg-primary);
        border: 1px solid rgba(239,68,68,0.35);
        border-radius: 7px;
        font-size: 11px;
        line-height: 1.6;
    `;
    card.innerHTML = `
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:6px;color:var(--red)">
            <span class="material-icons-round" style="font-size:13px">link</span>
            <strong>${isLoop ? 'Loopback on this DUT' : 'Connected to another DUT'}</strong>
        </div>
        <div style="color:var(--text-secondary);margin-bottom:2px">
            <span style="font-family:var(--mono);color:var(--text-primary)">${port}</span>
            &nbsp;↔&nbsp;
            <span style="font-family:var(--mono);color:var(--text-primary)">${peerPort}</span>
        </div>
        <div style="color:var(--text-secondary);margin-bottom:8px">
            Peer: <strong style="color:var(--text-primary)">${esc(peerName)}</strong>
        </div>
        <button onclick="_removeConnectionFromPopup(${connIdx},'${dutId}','${port}')"
            style="width:100%;padding:5px;background:var(--red);color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px">
            <span class="material-icons-round" style="font-size:13px">link_off</span>
            Remove This Connection
        </button>
    `;

    // Insert after the clicked row
    rowEl.insertAdjacentElement('afterend', card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _removeConnectionFromPopup(connIdx, dutId, port) {
    if (connIdx < 0 || connIdx >= dutConnections.length) return;
    const conn = dutConnections[connIdx];
    dutConnections.splice(connIdx, 1);
    renderTopologyCanvas();
    _saveConnectionsToServer();
    toast(`🗑 Connection removed: ${conn.intf_a} ↔ ${conn.intf_b}`, 'success');
    _closeInterfacePickerPopup();
}

/**
 * Draw clickable port chips below a DUT node in cable mode.
 */
function _drawPortChips(nodesG, dut, pos) {
    const usedPorts = _usedPorts(dut.id);
    const ports = SONIC_PORTS.slice(0, 14);  // Show first 14 ports (Eth0..Eth52)

    const chipW = 76, chipH = 18, gapX = 4, gapY = 8;
    const cols = 3;
    const totalChipW = cols * (chipW + gapX) - gapX;
    const startX = pos.x + (NODE_W - totalChipW) / 2;
    const startY = pos.y + NODE_H + gapY;

    ports.forEach((port, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const chipX = startX + col * (chipW + gapX);
        const chipY = startY + row * (chipH + gapY);
        // Center of this chip — used for cable line endpoint
        const centerX = chipX + chipW / 2;
        const centerY = chipY + chipH / 2;

        // Store port center for cable drawing
        const portKey = `${dut.id}:${port}`;
        _portCenters[portKey] = { cx: centerX, cy: centerY };

        const isUsed = usedPorts.has(port);
        const isSelected = _cableStart && String(_cableStart.dutId) === String(dut.id)
            && _cableStart.interface === port;

        const chipBg = isSelected ? '#f59e0b'
            : isUsed ? '#ef4444'
                : '#22c55e';

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-port', portKey);
        g.style.cursor = isUsed ? 'not-allowed' : 'crosshair';

        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', chipX);
        r.setAttribute('y', chipY);
        r.setAttribute('width', chipW);
        r.setAttribute('height', chipH);
        r.setAttribute('rx', '4');
        r.setAttribute('fill', chipBg);
        r.setAttribute('opacity', isUsed ? '0.55' : (isSelected ? '1' : '0.88'));
        r.setAttribute('stroke', isSelected ? '#fff' : 'none');
        r.setAttribute('stroke-width', '1.5');
        g.appendChild(r);

        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', centerX);
        t.setAttribute('y', centerY + 4);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('fill', '#fff');
        t.setAttribute('font-size', '9');
        t.setAttribute('font-weight', '600');
        t.setAttribute('font-family', 'JetBrains Mono,monospace');
        t.setAttribute('pointer-events', 'none');
        t.textContent = port;  // Full name: Ethernet0, Ethernet4, etc.
        g.appendChild(t);

        // Always attach click — even for used ports (to show a warning)
        g.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isUsed) {
                toast(`Port ${port} is already connected`, 'info');
                return;
            }
            _handlePortClick(dut.id, port);
        });

        nodesG.appendChild(g);
    });
}

function _handlePortClick(dutId, iface) {
    const dutName = dutsData.find(d => String(d.id) === String(dutId))?.name || `DUT ${dutId}`;
    if (!_cableStart) {
        // First click — start the cable
        _cableStart = { dutId, interface: iface };
        renderTopologyCanvas();
        toast(`🔌 Cable started: ${iface} on ${dutName}. Now click a port to connect to (same DUT allowed for loop).`, 'info');
    } else if (String(_cableStart.dutId) === String(dutId) && _cableStart.interface === iface) {
        // Clicked exact same port again — cancel
        _cableStart = null;
        renderTopologyCanvas();
        toast('Cancelled — clicked the same port twice', 'info');
    } else {
        // Second click — complete the cable (same DUT = loopback, different DUT = normal link)
        const conn = {
            dut_a: String(_cableStart.dutId),
            intf_a: _cableStart.interface,
            dut_b: String(dutId),
            intf_b: iface,
        };
        const isLoop = String(_cableStart.dutId) === String(dutId);
        dutConnections.push(conn);
        _cableStart = null;
        renderTopologyCanvas();
        _saveConnectionsToServer();
        toast(isLoop
            ? `🔁 Loopback: ${dutName} ${conn.intf_a} ↔ ${conn.intf_b}`
            : `✅ Connected: ${conn.intf_a} ↔ ${conn.intf_b}`, 'success');
    }
}



// ============================================================
// TESTBED INFO PANEL — fetch YAML parse from backend
// ============================================================

async function onTestbedChange() {
    updateSpyStartBtn();
    const vmId = document.getElementById('spy-vm-select')?.value;
    const testbed = document.getElementById('spy-testbed')?.value;
    const panel = document.getElementById('testbed-info-panel');
    const content = document.getElementById('testbed-info-content');
    if (!panel || !content) return;

    if (!vmId || !testbed) { panel.style.display = 'none'; return; }

    panel.style.display = '';
    content.innerHTML = '<span class="material-icons-round spin" style="font-size:12px;vertical-align:middle">sync</span> Loading...';
    try {
        const res = await fetch(`${API}/api/spytest/testbed-info?host_id=${vmId}&testbed=${encodeURIComponent(testbed)}`);
        if (!res.ok) throw new Error(`Server ${res.status}`);
        const info = await res.json();
        const deviceChips = info.device_names.map(n =>
            `<span style="background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:10px">${esc(n)}</span>`
        ).join(' ');
        content.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
                <span class="badge online">${info.device_count} DUT${info.device_count !== 1 ? 's' : ''}</span>
                <span class="badge pending">${esc(info.topology_type)}</span>
                ${info.link_count > 0 ? `<span class="badge">${info.link_count} link${info.link_count !== 1 ? 's' : ''}</span>` : ''}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${deviceChips}</div>
            ${info.links.length ? `<div style="margin-top:6px;font-size:10px;color:var(--text-secondary)">` +
                info.links.map(l => `<div>• ${esc(l.from)} ↔ ${esc(l.to)}</div>`).join('') + `</div>` : ''}`;
    } catch (e) {
        content.innerHTML = `<span style="color:var(--text-secondary);font-size:11px">Could not load testbed info</span>`;
    }
}

// ============================================================
// SCRIPT INSPECTOR — fetch topology metadata for selected script
// ============================================================

async function fetchScriptInfo(scriptPath) {
    const vmId = document.getElementById('spy-vm-select')?.value;
    const inspector = document.getElementById('script-inspector');
    if (!inspector || !scriptPath) return;
    if (!vmId) { inspector.style.display = 'none'; return; }

    inspector.style.display = '';
    inspector.innerHTML = '<span class="material-icons-round spin" style="font-size:12px;vertical-align:middle">sync</span> <span style="font-size:11px;color:var(--text-secondary)">Loading script info...</span>';
    try {
        const res = await fetch(`${API}/api/spytest/script-info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getSessionHeaders() },
            body: JSON.stringify({ host_id: parseInt(vmId), script_path: scriptPath, base_path: activeBasePath || '' }),
        });
        if (!res.ok) throw new Error(`Server ${res.status}`);
        const info = await res.json();
        const topoColor = info.dut_count > 1 ? '#6366f1' : '#22c55e';
        inspector.innerHTML = `
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:${info.description ? '6px' : '0'}">
                <span style="font-weight:600;font-size:11px">${esc(info.script_name || scriptPath.split('/').pop())}</span>
                <span style="background:${topoColor};color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600">${esc(info.topology_type || 'standalone')}</span>
                <span style="color:var(--text-secondary);font-size:11px">Requires <strong>${info.dut_count}</strong> DUT${info.dut_count !== 1 ? 's' : ''}</span>
                ${info.topology_marker ? `<span style="color:var(--text-secondary);font-size:10px">@ <code style="background:var(--bg-primary);padding:1px 5px;border-radius:3px">${esc(info.topology_marker)}</code></span>` : ''}
            </div>
            ${info.description ? `<div style="color:var(--text-secondary);font-size:10px;line-height:1.5;margin-top:2px">${esc(info.description.substring(0, 220))}</div>` : ''}`;

        // Auto-select testbed YAML if inspector detected one
        if (info.testbed_yaml) {
            const tbSel = document.getElementById('spy-testbed');
            if (tbSel) {
                // Find matching option
                const opt = Array.from(tbSel.options).find(o => o.value === info.testbed_yaml);
                if (opt) {
                    tbSel.value = info.testbed_yaml;
                    onTestbedChange();
                    toast(`Auto-selected testbed: ${info.testbed_yaml}`, 'info');
                }
            }
        }
    } catch (e) {
        inspector.innerHTML = `<span style="font-size:11px;color:var(--text-secondary)">Script info unavailable</span>`;
    }
}

// ============================================================
// CATEGORY SEARCH FILTER
// ============================================================

function filterCategories(query) {
    const sel = document.getElementById('spy-category');
    if (!sel) return;
    const q = (query || '').toLowerCase();
    Array.from(sel.options).forEach(opt => {
        if (!opt.value) return; // keep placeholder
        opt.style.display = !q || opt.text.toLowerCase().includes(q) ? '' : 'none';
    });
    // Enable search input whenever categories are loaded
    const searchEl = document.getElementById('category-search');
    if (searchEl && sel.options.length > 2) searchEl.disabled = false;
}

// (onSpyVMChange already handles enabling the category dropdown and search input)

// ============================================================
// TOPOLOGY CONNECTION PERSISTENCE
// ============================================================

async function _saveConnectionsToServer() {
    try {
        await fetch(`${API}/api/topology/connections`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connections: dutConnections }),
        });
    } catch (_) { }
}

async function loadTopologyConnectionsFromServer() {
    try {
        const res = await fetch(`${API}/api/topology/connections`);
        if (!res.ok) return;
        const conns = await res.json();
        if (Array.isArray(conns) && conns.length > 0) {
            dutConnections = conns.map(c => ({
                dut_a: c.dut_a,
                intf_a: c.intf_a,
                dut_b: c.dut_b,
                intf_b: c.intf_b,
            }));
            // Auto-select DUTs that appear in connections
            dutConnections.forEach(c => {
                if (c.dut_a) selectedDUTIds.add(parseInt(c.dut_a));
                if (c.dut_b) selectedDUTIds.add(parseInt(c.dut_b));
            });
            renderDUTChecklist();
            renderTopologyCanvas();
        }
    } catch (_) { }
}

// ============================================================
// DYNAMIC DUT ALLOCATION (pre-execution)
// ============================================================

/**
 * Greedy DUT allocator: for each script (sorted by dut_count desc),
 * find a set of DUTs from the connection graph that satisfies requirements.
 *
 * Returns an array parallel to scriptsWithCount:
 *   [ ["DUT1","DUT2"], ["DUT3"], ... ]
 */
function allocateDUTsForScripts(scriptsWithCount, connections, selectedDUTIds) {
    // Build name lookup
    const dutById = Object.fromEntries(dutsData.map(d => [d.id, d]));
    // Available pool of selected DUT ids (as numbers)
    let available = Array.from(selectedDUTIds).map(Number).filter(id => dutById[id]);

    // Build adjacency from connections (only between selected+available DUTs)
    const adj = {};
    available.forEach(id => { adj[id] = []; });
    connections.forEach(c => {
        const a = Number(c.dut_a), b = Number(c.dut_b);
        if (adj[a] !== undefined && adj[b] !== undefined) {
            if (!adj[a].includes(b)) adj[a].push(b);
            if (!adj[b].includes(a)) adj[b].push(a);
        }
    });

    const result = [];
    for (const s of scriptsWithCount) {
        const need = s.dut_count || 1;
        if (need === 1) {
            // Any single available DUT works
            const picked = available.shift();
            result.push(picked ? [dutById[picked]?.name || String(picked)] : null);
        } else {
            // Try to find a connected set of `need` DUTs
            let found = null;
            for (let i = 0; i < available.length && !found; i++) {
                const start = available[i];
                // BFS from start to collect connected available DUTs
                const visited = [start];
                const queue = [start];
                while (queue.length && visited.length < need) {
                    const cur = queue.shift();
                    for (const nbr of (adj[cur] || [])) {
                        if (available.includes(nbr) && !visited.includes(nbr)) {
                            visited.push(nbr);
                            queue.push(nbr);
                        }
                    }
                }
                if (visited.length >= need) {
                    found = visited.slice(0, need);
                }
            }
            if (found) {
                found.forEach(id => { available = available.filter(x => x !== id); });
                result.push(found.map(id => dutById[id]?.name || String(id)));
            } else {
                result.push(null); // insufficient DUTs
            }
        }
    }
    return result;
}

// ============================================================
// VS (VIRTUAL SYSTEM) MANAGER — MULTI-VM SELECTION
// ============================================================

let vsWS = null;
let vsLogs = [];
let currentVSExecId = null;
let selectedVSNames = new Set();

function renderVSHostList() {
    const sel = document.getElementById('vs-host');
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Select Host Device --</option>';

    // Filter: Only show online VM, Switch, and Router devices
    // Offline devices cannot be used as VS hosts
    const vsHostDevices = dutsData.filter(d =>
        (d.device_type === 'VM' || d.device_type === 'Switch' || d.device_type === 'Router')
        && d.status === 'online'
    );
    const offlineCount = dutsData.filter(d =>
        (d.device_type === 'VM' || d.device_type === 'Switch' || d.device_type === 'Router')
        && d.status !== 'online'
    ).length;

    vsHostDevices.forEach(d => {
        const option = document.createElement('option');
        option.value = d.id;
        option.textContent = `\u{1F7E2} ${d.name} (${d.ip_address})`;
        option.selected = d.id == current;
        sel.appendChild(option);
    });

    if (offlineCount > 0) {
        const divider = document.createElement('option');
        divider.disabled = true;
        divider.textContent = `\u2014 ${offlineCount} offline device${offlineCount > 1 ? 's' : ''} hidden \u2014`;
        sel.appendChild(divider);
    }
    // If previously selected device is now offline, reset selection
    if (current && !vsHostDevices.find(d => d.id == current)) {
        sel.value = '';
    }
}

function renderVSSourceServerList() {
    const sel = document.getElementById('vs-source-server');
    if (!sel) return; // Element may not exist on all pages
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Use Host Device (Local Copy) --</option>';

    // Only show online devices as source servers
    const onlineDevices = dutsData.filter(d => d.status === 'online');
    const offlineCount = dutsData.length - onlineDevices.length;

    onlineDevices.forEach(d => {
        const option = document.createElement('option');
        option.value = d.id;
        option.textContent = `\u{1F7E2} ${d.name} (${d.ip_address})`;
        option.selected = d.id == current;
        sel.appendChild(option);
    });

    if (offlineCount > 0) {
        const divider = document.createElement('option');
        divider.disabled = true;
        divider.textContent = `\u2014 ${offlineCount} offline device${offlineCount > 1 ? 's' : ''} hidden \u2014`;
        sel.appendChild(divider);
    }
    // If previously selected device is now offline, reset selection
    if (current && !onlineDevices.find(d => d.id == current)) {
        sel.value = '';
    }
}

function onVSHostChange() {
    const dutId = document.getElementById('vs-host').value;
    selectedVSNames.clear();
    updateVSSelectionSummary();
    // Reset spin source dropdown
    const spinSel = document.getElementById('spin-source-vs');
    if (spinSel) spinSel.innerHTML = '<option value="">-- Select host device first --</option>';
    const xmlEl = document.getElementById('spin-xml-preview');
    const imgEl = document.getElementById('spin-image-preview');
    if (xmlEl) { xmlEl.value = ''; xmlEl.placeholder = 'Select a VS above'; }
    if (imgEl) { imgEl.value = ''; imgEl.placeholder = 'Select a VS to read image path'; }

    if (!dutId) {
        document.getElementById('vs-vm-list').innerHTML = '<p class="muted" style="padding:16px;text-align:center">Select a host device to see VMs</p>';
        document.getElementById('vs-stats-bar').style.display = 'none';
        return;
    }
    loadVSList(dutId);
    fetchVSNames();
}

function refreshVSList() {
    const dutId = document.getElementById('vs-host').value;
    if (dutId) { loadVSList(dutId); }
    else toast('Select a host device first', 'error');
}

async function loadVSList(dutId) {
    const el = document.getElementById('vs-vm-list');
    el.innerHTML = '<p class="muted" style="padding:16px;text-align:center"><span class="material-icons-round spin" style="vertical-align:middle">sync</span> Loading VMs...</p>';

    // Check device status first
    await loadDUTs();  // Refresh device list to get latest status
    const dut = dutsData.find(d => d.id == dutId);

    if (!dut) {
        el.innerHTML = '<p class="muted" style="padding:16px;text-align:center;color:var(--red)">Device not found</p>';
        toast('Device not found', 'error');
        return;
    }

    if (dut.status !== 'online') {
        const statusColor = dut.status === 'offline' ? 'var(--red)' : 'var(--orange)';
        el.innerHTML = `<div style="padding:24px;text-align:center">
            <span class="material-icons-round" style="font-size:48px;color:${statusColor};opacity:0.5">cloud_off</span>
            <p style="margin-top:12px;font-size:1.1rem;font-weight:600;color:${statusColor}">Device ${dut.status || 'Not Online'}</p>
            <p class="muted" style="margin-top:8px">Please wait for <strong>${esc(dut.name)}</strong> to come online before managing VMs.</p>
            <button class="btn outline" onclick="loadDUTs(); loadVSList(${dutId})" style="margin-top:16px">
                <span class="material-icons-round" style="font-size:16px">refresh</span> Retry
            </button>
        </div>`;
        toast(`Device ${dut.name} is ${dut.status || 'not online'} - cannot fetch VS list`, 'warning');
        return;
    }

    try {
        const res = await fetch(`${API}/api/vs/list/${dutId}`);
        if (!res.ok) {
            // Try to parse as JSON, fallback to text if it fails
            let errorMsg = 'Failed to load VMs';
            try {
                const data = await res.json();
                errorMsg = data.detail || errorMsg;
            } catch (e) {
                const text = await res.text();
                errorMsg = text.substring(0, 100) || errorMsg;
            }
            throw new Error(errorMsg);
        }
        const data = await res.json();
        if (!data.vms || !data.vms.length) {
            el.innerHTML = '<p class="muted" style="padding:16px;text-align:center">No VMs found on this host.</p>';
            document.getElementById('vs-stats-bar').style.display = 'none';

            updateVSSelectionCount();
            return;
        }

        // Render as a full table
        let html = `<table class="vs-vm-table">
            <thead>
                <tr>
                    <th style="width:36px">
                        <input type="checkbox" class="vs-cb" id="vs-select-all-cb" onchange="toggleAllVS(this)" title="Select All">
                    </th>
                    <th>VM Name</th>
                    <th>State</th>
                    <th></th>
                    <th style="width:100px">Action</th>
                </tr>
            </thead>
            <tbody>`;

        data.vms.forEach(vm => {
            const state = (vm.state || '').toLowerCase();
            const isRunning = state.includes('running');
            const isPaused  = state.includes('paused');
            const isShutoff = state.includes('shut') || state === 'off';

            // Badge colour class
            const stateClass = isRunning ? 'online'
                             : isPaused  ? 'paused'
                             : isShutoff ? 'offline'
                             : 'pending';

            // Icon
            const iconName = isRunning ? 'play_circle'
                           : isPaused  ? 'pause_circle'
                           : 'stop_circle';
            const iconColor = isRunning ? 'var(--green)'
                            : isPaused  ? 'var(--yellow, #f59e0b)'
                            : 'var(--text-muted)';

            const checked = selectedVSNames.has(vm.name) ? 'checked' : '';
            // Image path is resolved from the VM's XML on the backend — show it read-only here
            const xmlImageName = vm.image_path ? vm.image_path.split('/').pop() : '';

            // Action button based on state
            let actionBtn = '';
            if (isRunning) {
                // Running → Pause + Destroy
                actionBtn = `
                <div style="display:flex;gap:4px">
                    <button class="btn outline small" onclick="vsQuickAction('${esc(vm.name)}','suspend')"
                        title="Pause (virsh suspend ${esc(vm.name)})"
                        style="color:var(--yellow,#f59e0b);padding:5px 8px;border-color:var(--yellow,#f59e0b)">
                        <span class="material-icons-round" style="font-size:16px">pause</span>
                    </button>
                    <button class="btn outline small" onclick="vsQuickAction('${esc(vm.name)}','destroy')"
                        title="Destroy (hard stop)" style="color:var(--red);padding:5px 8px">
                        <span class="material-icons-round" style="font-size:16px">stop</span>
                    </button>
                </div>`;
            } else if (isPaused) {
                // Paused → Resume only
                actionBtn = `<button class="btn outline small" onclick="vsQuickAction('${esc(vm.name)}','resume')"
                    title="Resume (virsh resume ${esc(vm.name)})"
                    style="color:var(--yellow,#f59e0b);padding:5px 8px;border-color:var(--yellow,#f59e0b)">
                    <span class="material-icons-round" style="font-size:16px">play_arrow</span>
                </button>`;
            } else {
                // Shut off / unknown → Start only
                actionBtn = `<button class="btn outline small" onclick="vsQuickAction('${esc(vm.name)}','start')"
                    title="Start" style="color:var(--green);padding:5px 8px">
                    <span class="material-icons-round" style="font-size:16px">play_arrow</span>
                </button>`;
            }

            html += `<tr class="vs-vm-row ${selectedVSNames.has(vm.name) ? 'selected' : ''}" data-vm="${esc(vm.name)}">
                <td>
                    <input type="checkbox" class="vs-cb" value="${esc(vm.name)}" ${checked}
                        onchange="toggleVSSelect('${esc(vm.name)}', this)">
                </td>
                <td>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="material-icons-round" style="font-size:18px;color:${iconColor}">${iconName}</span>
                        <span style="font-weight:600;font-size:0.9rem">${esc(vm.name)}</span>
                    </div>
                </td>
                <td><span class="badge ${stateClass}" style="white-space:nowrap">${esc(vm.state)}</span></td>
                <td>
                    <span style="font-family:var(--mono);font-size:0.8rem;color:var(--text-secondary)"
                          title="Resolved automatically from ${esc(vm.name)}.xml on the host">
                        ${esc(xmlImageName)}
                    </span>
                </td>
                <td>${actionBtn}</td>
            </tr>`;
        });

        html += `</tbody></table>`;
        el.innerHTML = html;

        // Compute and show T/R/D/P stats
        let cntR = 0, cntP = 0, cntD = 0;
        data.vms.forEach(vm => {
            const s = (vm.state || '').toLowerCase();
            if (s.includes('running')) cntR++;
            else if (s.includes('paused')) cntP++;
            else cntD++;
        });
        const cntT = data.vms.length;
        const statsBar = document.getElementById('vs-stats-bar');
        statsBar.innerHTML =
            `<span style="font-weight:600;color:var(--text-secondary)">T:<span style="color:var(--text-primary);margin-left:3px">${cntT}</span></span>` +
            `<span style="font-weight:600;color:var(--green)">R:${cntR}</span>` +
            `<span style="font-weight:600;color:var(--text-muted)">D:${cntD}</span>` +
            (cntP > 0 ? `<span style="font-weight:600;color:var(--yellow,#f59e0b)">P:${cntP}</span>` : '');
        statsBar.style.display = 'flex';

        updateVSSelectAllCheckbox();
        updateVSSelectionCount();
    } catch (e) {
        el.innerHTML = `<p class="muted" style="padding:16px;text-align:center;color:var(--red)">Error: ${esc(e.message)}</p>`;
        toast(`Failed to load VMs: ${e.message}`, 'error');
    }
}

function toggleVSSelect(vmName, cb) {
    if (cb.checked) selectedVSNames.add(vmName); else selectedVSNames.delete(vmName);
    // Highlight row
    const row = document.querySelector(`.vs-vm-row[data-vm="${vmName}"]`);
    if (row) row.classList.toggle('selected', cb.checked);
    updateVSSelectAllCheckbox();
    updateVSSelectionCount();
}

function toggleAllVS(cb) {
    const items = document.querySelectorAll('.vs-vm-row .vs-cb');
    items.forEach(item => {
        item.checked = cb.checked;
        const vmName = item.value;
        if (cb.checked) selectedVSNames.add(vmName); else selectedVSNames.delete(vmName);
        const row = document.querySelector(`.vs-vm-row[data-vm="${vmName}"]`);
        if (row) row.classList.toggle('selected', cb.checked);
    });
    updateVSSelectionCount();
}

function updateVSSelectAllCheckbox() {
    const selectAllCb = document.getElementById('vs-select-all-cb');
    if (!selectAllCb) return;
    const itemCbs = Array.from(document.querySelectorAll('.vs-vm-row .vs-cb'));
    selectAllCb.checked = itemCbs.length > 0 && itemCbs.every(c => c.checked);
    selectAllCb.indeterminate = !selectAllCb.checked && itemCbs.some(c => c.checked);
}

function updateVSSelectionCount() {
    const countEl = document.getElementById('vs-selection-count');
    const btn = document.getElementById('btn-vs-update');
    const btnRemove = document.getElementById('btn-remove-vs');
    const n = selectedVSNames.size;
    if (countEl) countEl.textContent = n > 0 ? `${n} selected` : '';
    if (btn) btn.disabled = n === 0;
    if (btnRemove) btnRemove.disabled = n === 0;
}

function updateSpinPreview() {
    const proj = (document.getElementById('spin-project').value || '').toUpperCase().trim();
    const user = (document.getElementById('spin-username').value || '').trim();
    const num  = (document.getElementById('spin-number').value || '').trim();
    const vsName = proj && user && num ? `${proj}_${user}_${num}` : '—';
    document.getElementById('spin-vs-preview').textContent = vsName;
}

async function fetchVSNames() {
    const dutId = document.getElementById('vs-host').value;
    if (!dutId) { toast('Select a host device first', 'error'); return; }
    const sel = document.getElementById('spin-source-vs');
    sel.innerHTML = '<option value="">Loading…</option>';
    try {
        const res = await fetch(`${API}/api/vs/${dutId}/vs-names`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
        const data = await res.json();
        const names = data.vs_names || [];
        if (names.length === 0) {
            sel.innerHTML = '<option value="">No VS XML files found on host</option>';
            return;
        }
        sel.innerHTML = '<option value="">-- Select VS --</option>' +
            names.map(n => `<option value="${n}">${n}</option>`).join('');
    } catch (e) {
        sel.innerHTML = '<option value="">Error loading VS names</option>';
        toast('Failed to fetch VS names: ' + e.message, 'error');
    }
}

async function onSourceVSChange() {
    const dutId  = document.getElementById('vs-host').value;
    const vsName = document.getElementById('spin-source-vs').value;
    const xmlEl  = document.getElementById('spin-xml-preview');
    const imgEl  = document.getElementById('spin-image-preview');

    if (!vsName) {
        xmlEl.value = ''; imgEl.value = '';
        xmlEl.placeholder = 'Select a VS above';
        imgEl.placeholder = 'Select a VS to read image path';
        return;
    }

    // Show XML path immediately from DUT data
    const dut = dutsData.find(d => d.id == dutId);
    if (dut && dut.xml_path) xmlEl.value = `${dut.xml_path}/${vsName}.xml`;

    // Fetch image path from XML on host
    imgEl.value = '';
    imgEl.placeholder = 'Reading image path from XML…';
    try {
        const res = await fetch(`${API}/api/vs/${dutId}/xml-info?vs_name=${encodeURIComponent(vsName)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
        const data = await res.json();
        imgEl.value = data.image_path || '';
        if (!data.image_path) imgEl.placeholder = 'Image path not found in XML';
    } catch (e) {
        imgEl.placeholder = 'Failed to read image path';
        toast('Could not read XML: ' + e.message, 'error');
    }
}

async function spinVS() {
    const dutId    = document.getElementById('vs-host').value;
    const sourceVS = document.getElementById('spin-source-vs').value;
    const proj     = (document.getElementById('spin-project').value || '').toUpperCase().trim();
    const user     = (document.getElementById('spin-username').value || '').trim();
    const num      = (document.getElementById('spin-number').value || '').trim();

    if (!dutId)    { toast('Select a host device first', 'error'); return; }
    if (!sourceVS) { toast('Select a source VS first', 'error'); return; }
    if (!proj || proj.length !== 4) { toast('Project name must be exactly 4 letters', 'error'); return; }
    if (!user)     { toast('Username is required', 'error'); return; }
    if (!num)      { toast('VS number is required', 'error'); return; }

    const vsName = `${proj}_${user}_${num}`;

    if (!confirm(`Spin new VS "${vsName}" from "${sourceVS}"?\n\n  1. Clone XML with new name\n  2. virsh define\n  3. virsh start`)) return;

    const progressTitle = document.getElementById('vs-progress-title');
    if (progressTitle) progressTitle.textContent = `Spin VS — ${vsName}`;
    // Labels aligned to the backend spin steps (1/3 Validate, 2/3 Clone, 3/3 Define+Start)
    _initVSProgress(['Validate XML', 'Clone XML', 'Define + Start VS']);

    const logEl = document.getElementById('vs-log-container');
    logEl.innerHTML = `<div class="log-placeholder"><span class="material-icons-round spin">sync</span><p>Spinning up ${vsName}…</p></div>`;

    const btnSpin = document.getElementById('btn-spin-vs');
    btnSpin.disabled = true;
    btnSpin.innerHTML = '<span class="material-icons-round spin">sync</span> Spinning…';

    try {
        const res = await fetch(`${API}/api/vs/${dutId}/spin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vs_name: vsName, source_vs: sourceVS }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || res.statusText);
        }
        const data = await res.json();
        toast(`Spin started for ${vsName}`, 'success');
        await waitForVSCompletion(data.execution_id, vsName, logEl);
        // Clear the spinner if completion arrived with no streamed logs (WS/poll fallback)
        clearVSLogPlaceholder(logEl, `<div style="padding:8px;color:var(--text-secondary)"><span class="material-icons-round" style="font-size:14px;vertical-align:middle">check_circle</span> ${esc(vsName)}: running.</div>`);
        toast(`✓ ${vsName} is running`, 'success');
        setTimeout(() => loadVSList(dutId), 2000);
    } catch (e) {
        toast(`Spin failed: ${e.message}`, 'error');
        clearVSLogPlaceholder(logEl, '');
        logEl.innerHTML += `<div style="color:#ff5252;padding:8px;margin-top:8px;border:1px solid #ff5252;border-radius:4px;">
            <strong>ERROR:</strong> ${escapeHTML(e.message)}
        </div>`;
    } finally {
        btnSpin.disabled = false;
        btnSpin.innerHTML = '<span class="material-icons-round">play_circle</span> Spin VS';
    }
}

async function removeSelectedVS() {
    const dutId = document.getElementById('vs-host').value;
    if (!dutId) { toast('Select a host device first', 'error'); return; }
    if (selectedVSNames.size === 0) { toast('Select a VM from the list first', 'error'); return; }
    if (selectedVSNames.size > 1) { toast('Select only one VM to remove at a time', 'error'); return; }

    const vsName = [...selectedVSNames][0];

    // Two-step confirmation: type VS name exactly
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:2000;display:flex;align-items:center;justify-content:center';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:450px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5)';
    modal.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <span class="material-icons-round" style="color:var(--red);font-size:32px">delete_forever</span>
            <h3 style="margin:0;font-size:1.2rem;color:var(--text-primary)">Remove VS Permanently</h3>
        </div>
        <p style="color:var(--text-secondary);margin:0 0 8px 0;line-height:1.6">
            This will <strong style="color:var(--red)">permanently delete</strong> VS:
            <strong style="color:var(--text-primary)">${esc(vsName)}</strong>
        </p>
        <p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 16px 0">
            Removes: virsh undefine, XML file, image file. This cannot be undone.
        </p>
        <p style="color:var(--text-muted);font-size:0.88rem;margin:0 0 6px 0">Type VS name to confirm:</p>
        <input type="text" id="vs-remove-confirm-input" placeholder="Enter: ${esc(vsName)}"
            style="width:100%;padding:10px;font-size:0.95rem;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--mono);margin-bottom:8px;box-sizing:border-box">
        <div id="vs-remove-error" style="color:var(--red);font-size:0.82rem;margin-bottom:12px;display:none"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="vs-remove-cancel" class="btn outline" style="padding:8px 16px">Cancel</button>
            <button id="vs-remove-confirm" class="btn" style="padding:8px 16px;background:var(--red);border-color:var(--red)">Remove</button>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const confirmed = await new Promise((resolve) => {
        const inp = document.getElementById('vs-remove-confirm-input');
        const errDiv = document.getElementById('vs-remove-error');
        setTimeout(() => inp.focus(), 100);

        document.getElementById('vs-remove-confirm').addEventListener('click', () => {
            if (inp.value.trim() === vsName) {
                document.body.removeChild(overlay); resolve(true);
            } else {
                errDiv.textContent = `Name does not match "${vsName}"`;
                errDiv.style.display = 'block';
                inp.select();
            }
        });
        document.getElementById('vs-remove-cancel').addEventListener('click', () => {
            document.body.removeChild(overlay); resolve(false);
        });
        inp.addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('vs-remove-confirm').click(); });
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('vs-remove-cancel').click(); });
    });

    if (!confirmed) return;

    // Set up progress UI for remove (3 steps + step 4 hidden)
    const progressTitle = document.getElementById('vs-progress-title');
    if (progressTitle) progressTitle.textContent = `Remove VS — ${vsName}`;
    _initVSProgress(['Destroy + Undefine', 'Remove XML', 'Remove Image', '']);

    const logEl = document.getElementById('vs-log-container');
    logEl.innerHTML = `<div class="log-placeholder"><span class="material-icons-round spin">sync</span><p>Removing ${vsName}...</p></div>`;

    const btnRemove = document.getElementById('btn-remove-vs');
    btnRemove.disabled = true;
    btnRemove.innerHTML = '<span class="material-icons-round spin">sync</span> Removing...';

    try {
        const res = await fetch(`${API}/api/vs/${dutId}/remove/${encodeURIComponent(vsName)}`, {
            method: 'DELETE',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || res.statusText);
        }
        const data = await res.json();
        toast(`Removal started for ${vsName}`, 'info');
        await waitForVSCompletion(data.execution_id, vsName, logEl);
        // Clear the spinner if completion arrived with no streamed logs (WS/poll fallback)
        clearVSLogPlaceholder(logEl, `<div style="padding:8px;color:var(--text-secondary)"><span class="material-icons-round" style="font-size:14px;vertical-align:middle">check_circle</span> ${esc(vsName)}: removed.</div>`);
        toast(`✓ ${vsName} removed`, 'success');
        selectedVSNames.clear();
        updateVSSelectionCount();
        setTimeout(() => loadVSList(dutId), 2000);
    } catch (e) {
        toast(`Remove failed: ${e.message}`, 'error');
        clearVSLogPlaceholder(logEl, '');
        logEl.innerHTML += `<div style="color:#ff5252;padding:8px;margin-top:8px;border:1px solid #ff5252;border-radius:4px;">
            <strong>ERROR:</strong> ${escapeHTML(e.message)}
        </div>`;
    } finally {
        btnRemove.disabled = selectedVSNames.size === 0;
        btnRemove.innerHTML = '<span class="material-icons-round">delete_forever</span> Remove Selected VS';
    }
}

function _initVSProgress(labels) {
    const progress = document.getElementById('vs-progress');
    progress.style.display = '';
    progress.querySelectorAll('.vs-step').forEach((s, i) => {
        s.classList.remove('active', 'done', 'error', 'pending');
        s.classList.add('pending');
        const lbl = labels[i] || '';
        const lblEl = document.getElementById(`vs-step-label-${i + 1}`);
        if (lblEl) lblEl.textContent = lbl;
        s.style.display = lbl ? '' : 'none';
    });
}

function updateVSSelectionSummary() {
    // Kept for compatibility — now handled by updateVSSelectionCount
    updateVSSelectionCount();
}

async function loadXMLFiles(dutId) {
    // Removed — XML is auto-derived from VS name in backend
}

async function vsQuickAction(vmName, action) {
    const dutId = document.getElementById('vs-host').value;
    if (!dutId) { toast('Select a host device first', 'error'); return; }

    // Confirmation messages per action
    if (action === 'destroy') {
        const confirmed = await showVSDestroyConfirmation(vmName);
        if (!confirmed) return;
    } else if (action === 'resume') {
        // Resume is safe — just a simple confirm
        if (!confirm(`Resume paused VM "${vmName}"?\n\nThis will run:\n  sudo virsh resume ${vmName}`)) return;
    } else if (action === 'suspend') {
        if (!confirm(`Suspend (pause) VM "${vmName}"?\n\nThis will run:\n  sudo virsh suspend ${vmName}`)) return;
    } else {
        if (!confirm(`${action.toUpperCase()} VM "${vmName}"?`)) return;
    }

    const actionLabel = {
        start: 'Starting', destroy: 'Destroying', reboot: 'Rebooting',
        shutdown: 'Shutting down', resume: 'Resuming', suspend: 'Suspending'
    }[action] || action;

    toast(`${actionLabel} ${vmName}...`, 'info');
    try {
        const res = await fetch(`${API}/api/vs/${dutId}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vs_name: vmName, action: action }),
        });

        let data = {};
        try { data = await res.json(); } catch (_) {}

        // FastAPI errors use 'detail'; app-level errors use 'message'
        const errMsg = data.detail || data.message || data.error || `HTTP ${res.status}`;

        if (res.ok && data.status === 'success') {
            toast(`✓ ${vmName}: ${data.message || action + ' completed'}`, 'success');
        } else {
            toast(`${action} on '${vmName}' failed: ${errMsg}`, 'error');
        }
        // Refresh VM list after a short delay to show updated state
        setTimeout(() => loadVSList(dutId), 1500);
    } catch (e) { toast(`Action failed: ${e.message}`, 'error'); }
}

function showVSDestroyConfirmation(vmName) {
    return new Promise((resolve) => {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:2000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s';

        // Create modal dialog
        const modal = document.createElement('div');
        modal.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:450px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5)';

        modal.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
                <span class="material-icons-round" style="color:var(--red);font-size:32px">warning</span>
                <h3 style="margin:0;font-size:1.3rem;color:var(--text-primary)">Confirm VS Destruction</h3>
            </div>
            <p style="color:var(--text-secondary);margin:0 0 16px 0;line-height:1.6">
                You are about to <strong style="color:var(--red)">destroy</strong> the virtual switch: <strong style="color:var(--text-primary)">${vmName}</strong>
            </p>
            <p style="color:var(--text-muted);font-size:0.9rem;margin:0 0 16px 0">
                This action cannot be undone. To confirm, please type the VS name below:
            </p>
            <input type="text" id="vs-destroy-confirm-input" placeholder="Enter VS name: ${vmName}"
                style="width:100%;padding:10px;font-size:0.95rem;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--mono);margin-bottom:16px">
            <div id="vs-destroy-error" style="color:var(--red);font-size:0.85rem;margin-bottom:12px;display:none"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="vs-destroy-cancel" class="btn outline" style="padding:8px 16px">Cancel</button>
                <button id="vs-destroy-confirm" class="btn" style="padding:8px 16px;background:var(--red);border-color:var(--red)">Destroy</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const input = document.getElementById('vs-destroy-confirm-input');
        const confirmBtn = document.getElementById('vs-destroy-confirm');
        const cancelBtn = document.getElementById('vs-destroy-cancel');
        const errorDiv = document.getElementById('vs-destroy-error');

        // Focus input
        setTimeout(() => input.focus(), 100);

        // Validate on input
        input.addEventListener('input', () => {
            errorDiv.style.display = 'none';
        });

        // Confirm button
        confirmBtn.addEventListener('click', () => {
            const enteredName = input.value.trim();
            if (enteredName === vmName) {
                document.body.removeChild(overlay);
                resolve(true);
            } else {
                errorDiv.textContent = `Entered name "${enteredName}" does not match "${vmName}"`;
                errorDiv.style.display = 'block';
                input.select();
            }
        });

        // Cancel button
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(false);
        });

        // Press Enter to confirm
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') confirmBtn.click();
        });

        // Press Escape to cancel
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancelBtn.click();
        });
    });
}

async function startVSUpdate() {
    console.log('[VS] startVSUpdate called. selectedVSNames.size =', selectedVSNames.size);
    const dutId = document.getElementById('vs-host').value;
    const sourceImage = document.getElementById('vs-source-image').value.trim();
    const sourceServerId = document.getElementById('vs-source-server').value;

    if (!dutId) { toast('Select a host device', 'error'); return; }
    if (!selectedVSNames.size) { toast('Select at least one VM using the checkboxes', 'error'); return; }

    // Build per-VM list — no target name needed, backend reads it from each VM's XML
    const vsEntries = [];
    selectedVSNames.forEach(vmName => vsEntries.push({ vs_name: vmName }));

    // Show inline confirmation
    const logEl = document.getElementById('vs-log-container');
    const vmRows = vsEntries.map(e =>
        `<div style="padding:3px 0;font-family:var(--mono);font-size:0.82rem">• <b>${esc(e.vs_name)}</b> <span style="color:var(--text-secondary)">(image name from XML)</span></div>`
    ).join('');

    const sourceServerName = sourceServerId ? (dutsData.find(d => d.id == sourceServerId)?.name || 'Unknown') : 'Host Device (Local)';
    const copyMethod = sourceServerId ? '(Direct SCP Copy)' : '(Local Copy)';

    logEl.innerHTML = `<div style="padding:16px">
        <div style="font-weight:600;margin-bottom:8px">⚠ Confirm update for ${vsEntries.length} VM(s):</div>
        ${vmRows}
        <div style="margin-top:8px;font-size:0.82rem;color:var(--text-secondary)">Source Server: ${esc(sourceServerName)} ${copyMethod}</div>
        <div style="font-size:0.82rem;color:var(--text-secondary)">Source Image: <span style="font-family:var(--mono)">${esc(sourceImage)}</span></div>
        <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:4px">Target path &amp; filename resolved from each VM's XML file on the host.</div>
        <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn primary" onclick="execVSUpdate()" style="padding:8px 20px">
                <span class="material-icons-round" style="font-size:16px">rocket_launch</span> Confirm & Start Update
            </button>
            <button class="btn outline" onclick="cancelVSUpdate()" style="padding:8px 16px">Cancel</button>
        </div>
    </div>`;

    // Store pending data for execVSUpdate to pick up
    window._vsPendingUpdate = { dutId, vsEntries, sourceImage, sourceServerId };
}

function cancelVSUpdate() {
    window._vsPendingUpdate = null;
    const logEl = document.getElementById('vs-log-container');
    logEl.innerHTML = '<div class="log-placeholder"><span class="material-icons-round">memory</span><p>Update cancelled.</p></div>';
}

async function execVSUpdate() {
    const pending = window._vsPendingUpdate;
    if (!pending) return;
    window._vsPendingUpdate = null;

    const { dutId, vsEntries, sourceImage, sourceServerId } = pending;

    // Reset progress UI
    vsLogs = [];
    const progressTitle = document.getElementById('vs-progress-title');
    if (progressTitle) progressTitle.textContent = 'Update VS Image';
    _initVSProgress(['Destroy VM', 'Remove Old Image', 'Copy New Image', 'Start VM']);
    const logEl = document.getElementById('vs-log-container');
    logEl.innerHTML = `<div class="log-placeholder"><span class="material-icons-round spin">sync</span><p>Starting VS image update for ${vsEntries.length} VM(s)...</p></div>`;

    const btn = document.getElementById('btn-vs-update');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons-round spin">sync</span> Updating...';

    // Call the existing working single-VM endpoint for each VM sequentially
    let allOk = true;
    console.log(`[VS Update] ========================================`);
    console.log(`[VS Update] Starting sequential update of ${vsEntries.length} VMs`);
    console.log(`[VS Update] ========================================`);

    for (let i = 0; i < vsEntries.length; i++) {
        const entry = vsEntries[i];
        const vmLabel = `[${i + 1}/${vsEntries.length}] ${entry.vs_name}`;

        console.log(`\n[VS Update] ====== VM ${i + 1}/${vsEntries.length} ======`);
        console.log(`[VS Update] VS Name:`, entry.vs_name);
        console.log(`[VS Update] Target Image:`, entry.target_image_name);
        console.log(`[VS Update] About to fetch API...`);

        // Update log area
        logEl.innerHTML = `<div class="log-placeholder"><span class="material-icons-round spin">sync</span><p>Updating ${vmLabel}...</p></div>`;

        try {
            const requestBody = {
                dut_id: parseInt(dutId),
                vs_name: entry.vs_name,
                source_image_path: sourceImage,
                target_image_name: entry.target_image_name || '',
                source_server_id: sourceServerId ? parseInt(sourceServerId) : null,
            };
            console.log('[VS Update] Request body:', JSON.stringify(requestBody, null, 2));

            const res = await fetch(`${API}/api/vs/update-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            console.log(`[VS Update] API response status:`, res.status);

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                console.error(`[VS Update] API returned error:`, errData);
                throw new Error(errData.detail || res.statusText);
            }
            const data = await res.json();
            currentVSExecId = data.execution_id;
            console.log(`[VS Update] Execution ID:`, data.execution_id);
            toast(`${vmLabel}: update started`, 'success');

            // Close previous WebSocket if exists
            if (vsWS) {
                console.log('[VS Update] Closing previous WebSocket connection');
                vsWS.close();
                vsWS = null;
            }

            // Connect to WebSocket and wait for completion
            console.log('[VS Update] Connecting WebSocket for execution:', data.execution_id);
            await waitForVSCompletion(data.execution_id, vmLabel, logEl);
            console.log(`[VS Update] ✓ VM ${i + 1}/${vsEntries.length} COMPLETED: ${entry.vs_name}`);
            // Clear placeholder spinner if WebSocket fallback was used and no logs were rendered
            clearVSLogPlaceholder(logEl, `<div style="padding:8px;color:var(--text-secondary)"><span class="material-icons-round" style="font-size:14px;vertical-align:middle">check_circle</span> ${esc(vmLabel)}: completed.</div>`);
            console.log(`[VS Update] Moving to next VM...`);

        } catch (e) {
            console.error(`[VS Update] Error updating ${entry.vs_name}:`, e);
            toast(`${vmLabel}: FAILED — ${e.message}`, 'error');
            // Replace spinner with error message (handles WebSocket fallback case)
            clearVSLogPlaceholder(logEl, '');
            logEl.innerHTML += `<div style="color:#ff5252;padding:8px;margin-top:8px;border:1px solid #ff5252;border-radius:4px;">
                <strong>ERROR:</strong> ${escapeHTML(e.message)}<br>
                <small>Continuing with remaining VMs...</small>
            </div>`;
            allOk = false;
            // Continue with next VM even if one fails
            console.log(`[VS Update] Continuing to next VM after error...`);
        }
    }

    console.log(`[VS Update] Loop finished. All VMs processed. allOk=${allOk}`);

    // Done — all VMs processed
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons-round">rocket_launch</span> Update Image &amp; Restart Selected VMs';

    if (allOk) {
        toast(`All ${vsEntries.length} VM(s) updated successfully!`, 'success');
    } else {
        toast('Some VMs failed to update — check logs', 'error');
    }

    // Unselect all checkboxes after update
    selectedVSNames.clear();
    document.querySelectorAll('.vs-cb').forEach(cb => cb.checked = false);
    document.querySelectorAll('.vs-vm-row').forEach(r => r.classList.remove('selected'));
    updateVSSelectionCount();
    btn.disabled = true;

    // Refresh VM list after updates
    if (dutId) setTimeout(() => loadVSList(dutId), 3000);
}

// Poll execution status until completed/failed
async function waitForExecution(execId, label, logEl) {
    const maxWait = 600; // 10 minutes max
    const interval = 3;  // poll every 3 seconds
    let elapsed = 0;

    console.log(`[waitForExecution] Starting polling for exec ${execId}, max wait ${maxWait}s`);

    while (elapsed < maxWait) {
        await new Promise(r => setTimeout(r, interval * 1000));
        elapsed += interval;

        console.log(`[waitForExecution] Polling exec ${execId} at ${elapsed}s / ${maxWait}s`);

        try {
            const res = await fetch(`${API}/api/executions/${execId}`, {
                headers: getSessionHeaders()
            });
            if (!res.ok) {
                console.warn(`[waitForExecution] API returned ${res.status} for exec ${execId}`);
                continue;
            }
            const exec = await res.json();
            console.log(`[waitForExecution] Exec ${execId} status:`, exec.status);

            // Also fetch logs for display
            const logsRes = await fetch(`${API}/api/executions/${execId}/logs?limit=200`, {
                headers: getSessionHeaders()
            });
            if (logsRes.ok) {
                const logsData = await logsRes.json();
                // API returns array directly, not {logs: [...]}
                const logsArr = Array.isArray(logsData) ? logsData : (logsData.logs || []);
                if (logsArr.length > 0) {
                    let html = '<div style="font-family:monospace;font-size:13px;line-height:1.6;padding:12px;">';
                    for (const log of logsArr) {
                        const lvl = log.level || log.log_level || 'INFO';
                        const color = lvl === 'ERROR' ? '#ff5252' :
                            lvl === 'WARNING' ? '#ffab40' : '#b0bec5';
                        html += `<div style="color:${color};margin-bottom:2px;">${escapeHTML(log.message)}</div>`;
                    }
                    html += '</div>';
                    logEl.innerHTML = html;
                    logEl.scrollTop = logEl.scrollHeight;
                }
            }

            // Check completion
            if (exec.status === 'completed' || exec.status === 'failed') {
                console.log(`[waitForExecution] ✓ Exec ${execId} ${exec.status}! Returning from wait.`);
                if (exec.status === 'completed') {
                    toast(`${label}: completed successfully (${exec.duration || 0}s)`, 'success');
                } else {
                    toast(`${label}: update failed`, 'error');
                }
                return;
            } else {
                console.log(`[waitForExecution] Status is '${exec.status}', continuing to poll...`);
            }
        } catch (e) {
            console.error(`[waitForExecution] Error polling exec ${execId}:`, e);
            // Network error, keep polling
        }
    }
    console.error(`[waitForExecution] ✗ TIMEOUT after ${maxWait}s for exec ${execId}`);
    toast(`${label}: timed out after ${maxWait}s`, 'error');
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Wait for VS update to complete using WebSocket + polling fallback
async function waitForVSCompletion(execId, label, logEl) {
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // VS service streams on /ws/vs/execution/{id} (routed to eka-vs by nginx)
        const ws = new WebSocket(`${proto}//${location.host}/ws/vs/execution/${execId}`);
        let settled = false;
        const timeout = setTimeout(() => {
            console.error(`[waitForVSCompletion] Timeout after 10 minutes for exec ${execId}`);
            ws.close();
            if (!settled) { settled = true; reject(new Error('Update timed out after 10 minutes')); }
        }, 600000); // 10 minute timeout

        ws.onopen = () => {
            console.log(`[waitForVSCompletion] WebSocket connected for exec ${execId}`);
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'execution_complete') {
                console.log(`[waitForVSCompletion] ✓ Received execution_complete for exec ${execId}, status: ${data.status}`);
                clearTimeout(timeout);
                ws.close();
                toast(`${label}: ${data.status} (${data.duration || 0}s)`, data.status === 'completed' ? 'success' : 'error');

                if (!settled) {
                    settled = true;
                    if (data.status === 'completed') {
                        resolve();
                    } else {
                        reject(new Error(`Update failed with status: ${data.status}`));
                    }
                }
                return;
            }

            // Display logs in real-time
            if (data.message) {
                vsLogs.push(data);
                appendVSLogEntry(data);
                updateVSProgress(data);
            }
        };

        ws.onerror = (error) => {
            console.error(`[waitForVSCompletion] WebSocket error for exec ${execId}:`, error);
            // Don't reject - let timeout handle it or wait for close
        };

        ws.onclose = () => {
            console.log(`[waitForVSCompletion] WebSocket closed for exec ${execId}`);
            // Only fall back to polling if we haven't settled yet (WS failed before execution_complete)
            if (!settled) {
                console.log(`[waitForVSCompletion] Falling back to polling for exec ${execId}`);
                pollForCompletion(execId, label, timeout, resolve, reject, () => { settled = true; });
            }
        };
    });
}

// Fallback polling if WebSocket fails.
// Renders logs too (not just status) so the VS Progress panel isn't empty when
// the WebSocket cannot connect — the previous behaviour that left the panel blank.
let _pollLogCursor = {};  // execId -> last rendered log id

// Fetch any logs newer than the cursor and render them via the shared log path.
async function _pollFetchVSLogs(execId) {
    try {
        const after = _pollLogCursor[execId] || 0;
        const res = await fetch(`${API}/api/vs/executions/${execId}/logs?after_id=${after}`);
        if (!res.ok) return;
        const logs = await res.json();
        if (Array.isArray(logs)) {
            for (const log of logs) {
                if (log.message) { vsLogs.push(log); appendVSLogEntry(log); updateVSProgress(log); }
                if (log.id) _pollLogCursor[execId] = log.id;
            }
        }
    } catch (e) {
        console.error(`[pollForCompletion] Error fetching logs for exec ${execId}:`, e);
    }
}

async function pollForCompletion(execId, label, timeout, resolve, reject, markSettled) {
    _pollLogCursor[execId] = 0;
    // Poll the VS service executions endpoint (same DB, so exec ID is valid)
    const pollInterval = setInterval(async () => {
        try {
            // Pull any new logs first so the panel streams even without a WebSocket
            await _pollFetchVSLogs(execId);

            const res = await fetch(`${API}/api/vs/executions/${execId}`);
            if (res.ok) {
                const exec = await res.json();
                console.log(`[pollForCompletion] Exec ${execId} status: ${exec.status}`);

                if (exec.status === 'completed' || exec.status === 'failed') {
                    clearInterval(pollInterval);
                    clearTimeout(timeout);
                    // Final log drain so the last lines (incl. the success/fail banner) render
                    await _pollFetchVSLogs(execId);
                    delete _pollLogCursor[execId];
                    if (markSettled) markSettled();
                    if (exec.status === 'completed') {
                        console.log(`[pollForCompletion] ✓ Exec ${execId} completed`);
                        resolve();
                    } else {
                        console.log(`[pollForCompletion] ✗ Exec ${execId} failed`);
                        reject(new Error('Update failed'));
                    }
                }
            }
        } catch (e) {
            console.error(`[pollForCompletion] Error polling exec ${execId}:`, e);
        }
    }, 3000); // Poll every 3 seconds
}

// Clear the "…ing" spinner placeholder if it's still showing (i.e. no logs
// streamed). Called after waitForVSCompletion resolves/rejects regardless of
// whether the WebSocket or the poll fallback completed it, so the spinner never
// hangs. htmlOrText is the replacement markup.
function clearVSLogPlaceholder(logEl, htmlOrText) {
    if (logEl && logEl.querySelector('.log-placeholder')) {
        logEl.innerHTML = htmlOrText;
    }
}

function appendVSLogEntry(log) {
    const el = document.getElementById('vs-log-container');
    if (!el) return;
    if (el.querySelector('.log-placeholder')) el.innerHTML = '';

    const raw = log.message || '';
    const msg = raw.trim();
    if (!msg) return;

    let html = '';

    // ── Numbered step header: "▶ Step X/Y: Name" ─────────────────
    const stepMatch = msg.match(/^▶ (Step \d+\/\d+):\s*(.+)$/);
    if (stepMatch) {
        html = `<div class="vs-step-log-hdr">
            <span class="vs-step-log-badge">${esc(stepMatch[1])}</span>
            <span class="vs-step-log-title">${esc(stepMatch[2])}</span>
        </div>`;
    }
    // ── Non-numbered "▶" section header ──────────────────────────
    else if (msg.startsWith('▶')) {
        html = `<div class="vs-step-log-hdr section">
            <span class="vs-step-log-title">${esc(msg.slice(1).trim())}</span>
        </div>`;
    }
    // ── Command line: "  $ ..." ───────────────────────────────────
    else if (/^ {2}\$ /.test(raw)) {
        html = `<div class="vs-log-cmd">$ ${esc(msg.replace(/^\$\s*/, ''))}</div>`;
    }
    // ── Final success banner: "✓ VS ... completed / is running" ──
    else if (msg.startsWith('✓') && (msg.includes('completed') || msg.includes('is running'))) {
        html = `<div class="vs-log-final ok">
            <span class="material-icons-round" style="font-size:15px">task_alt</span>
            ${esc(msg.replace(/^✓\s*/, ''))}
        </div>`;
    }
    // ── Step success: "  ✓ ..." ───────────────────────────────────
    else if (/^ {2}✓/.test(raw)) {
        html = `<div class="vs-log-ok">✓ ${esc(msg.replace(/^✓\s*/, ''))}</div>`;
    }
    // ── Step error: "  ✗ ..." ────────────────────────────────────
    else if (/^ {2}✗/.test(raw) || (msg.includes('FAILED') && !msg.includes('sudo'))) {
        html = `<div class="vs-log-err">✗ ${esc(msg.replace(/^✗\s*/, ''))}</div>`;
    }
    // ── Warning / retry: "  ⚠ …" or "  ↻ …" ─────────────────────
    else if (/^ {2}[⚠↻]/.test(raw) || log.level === 'WARNING') {
        html = `<div class="vs-log-warn">${esc(msg)}</div>`;
    }
    // ── Command output (4-space indent) ───────────────────────────
    else if (/^ {4}/.test(raw)) {
        html = `<div class="vs-log-out">${esc(msg)}</div>`;
    }
    // ── Regular info line ─────────────────────────────────────────
    else {
        html = `<div class="vs-log-info">${esc(msg)}</div>`;
    }

    el.insertAdjacentHTML('beforeend', html);
    el.scrollTop = el.scrollHeight;
}

function updateVSProgress(log) {
    const msg = (log.message || '').trim();

    // Debug: Log all messages to console for debugging
    console.log('[VS Progress] Message:', msg);

    // Map backend steps to UI steps
    // Update (6-step): 1/6→1, 2/6→2, 3/6→3, 6/6→4
    // Spin  (4-step):  1/4→1, 2/4→2, 3/4→3, 4/4→4
    // Remove(3-step):  1/3→1, 2/3→2, 3/3→3
    const stepMap = {
        'Step 1/6': '1', 'Step 2/6': '2', 'Step 3/6': '3', 'Step 6/6': '4',
        'Step 1/4': '1', 'Step 2/4': '2', 'Step 3/4': '3', 'Step 4/4': '4',
        'Step 1/3': '1', 'Step 2/3': '2', 'Step 3/3': '3',
    };

    let stepFound = false;
    for (const [prefix, stepNum] of Object.entries(stepMap)) {
        if (msg.includes(prefix)) {
            stepFound = true;
            console.log(`[VS Progress] Found ${prefix}, mapping to step ${stepNum}`);

            const stepEl = document.querySelector(`.vs-step[data-step="${stepNum}"]`);
            if (!stepEl) {
                console.warn(`[VS Progress] Step element not found for data-step="${stepNum}"`);
                continue;
            }

            // Remove all state classes first
            stepEl.classList.remove('active', 'done', 'error', 'pending');

            // Mark all previous steps as done
            for (let i = 1; i < parseInt(stepNum); i++) {
                const prev = document.querySelector(`.vs-step[data-step="${i}"]`);
                if (prev && !prev.classList.contains('error')) {
                    prev.classList.remove('active', 'pending');
                    prev.classList.add('done');
                }
            }

            // Determine current step state
            if (msg.includes('FAILED') || msg.includes('✗')) {
                // Error state
                console.log(`[VS Progress] Step ${stepNum} ERROR`);
                stepEl.classList.add('error');
                // Mark following steps as pending (skipped)
                for (let i = parseInt(stepNum) + 1; i <= 4; i++) {
                    const next = document.querySelector(`.vs-step[data-step="${i}"]`);
                    if (next) {
                        next.classList.remove('active', 'done');
                        next.classList.add('pending');
                    }
                }
            } else if (msg.includes('completed successfully') || msg.includes('✓')) {
                // Completed state
                console.log(`[VS Progress] Step ${stepNum} DONE`);
                stepEl.classList.add('done');
            } else {
                // Active/Running state
                console.log(`[VS Progress] Step ${stepNum} ACTIVE`);
                stepEl.classList.add('active');
            }

            break; // Stop after finding the step
        }
    }

    if (!stepFound && msg.length > 0) {
        console.log(`[VS Progress] No step prefix matched in message: "${msg.substring(0, 100)}..."`);
    }

    // Handle final completion message
    if (msg.includes('VS image update completed') || msg.includes('update successfully')) {
        console.log('[VS Progress] Final completion detected');
        let allDone = true;
        for (let i = 1; i <= 4; i++) {
            const s = document.querySelector(`.vs-step[data-step="${i}"]`);
            if (s) {
                if (!s.classList.contains('error')) {
                    s.classList.remove('active', 'pending');
                    s.classList.add('done');
                } else {
                    allDone = false;
                }
            }
        }
    }
}

// ============================================================
// UTILITIES
// ============================================================

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// Listen for select changes
document.addEventListener('change', (e) => {
    if (e.target.id === 'spy-vm-select' || e.target.id === 'spy-testbed') updateSpyStartBtn();
});

// ============================================================================
// HARDWARE LOAD FUNCTIONALITY
// ============================================================================

// Hardware Load state
// currentHWJobId is persisted to localStorage so it survives page refresh
let currentHWJobId = parseInt(localStorage.getItem('hwCurrentJobId')) || null;
let hwWebSocket = null;
let hwAutoScroll = true;
let hwReconnectTimer = null;  // setTimeout handle for reconnect
let hwViewingJobId = null;    // Which job is open in the modal

// On DOMContentLoaded, try to reconnect to any in-progress job
document.addEventListener('DOMContentLoaded', () => {
    if (currentHWJobId) {
        // Give the rest of the app a moment to settle before reconnecting
        setTimeout(() => hwTryResumeJob(currentHWJobId), 1500);
    }
});

/**
 * Load hardware devices (telnet-only) for device dropdown
 */
async function loadHardwareDevices() {
    try {
        const response = await fetch(`${API}/api/duts`, {
            headers: getSessionHeaders()
        });

        if (!response.ok) throw new Error('Failed to load devices');

        const devices = await response.json();

        // Filter for online telnet devices only — offline devices cannot be used
        const telnetDevices = devices.filter(d => d.connection_type === 'telnet' && d.status === 'online');
        const offlineTelnetCount = devices.filter(d => d.connection_type === 'telnet' && d.status !== 'online').length;

        const deviceSelect = document.getElementById('hwDeviceSelect');
        if (!deviceSelect) {
            console.warn('Hardware Load tab elements not found. Tab may not be loaded yet.');
            return;
        }

        deviceSelect.innerHTML = '<option value="">-- Select Device --</option>';

        telnetDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `\u{1F7E2} ${device.name} (${device.ip_address}:${device.port})`;
            deviceSelect.appendChild(option);
        });

        if (offlineTelnetCount > 0) {
            const divider = document.createElement('option');
            divider.disabled = true;
            divider.textContent = `\u2014 ${offlineTelnetCount} offline device${offlineTelnetCount > 1 ? 's' : ''} hidden \u2014`;
            deviceSelect.appendChild(divider);
        }

        // Load only online devices for source server dropdown
        const serverSelect = document.getElementById('hwSourceServer');
        if (!serverSelect) {
            console.warn('Hardware Load server select not found.');
            return;
        }

        const onlineServers = devices.filter(d => d.status === 'online');
        const offlineServerCount = devices.length - onlineServers.length;

        serverSelect.innerHTML = '<option value="">-- Select Server --</option>';

        onlineServers.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `\u{1F7E2} ${device.name} (${device.ip_address})`;
            option.dataset.password = device.password || '';
            option.dataset.username = device.username || 'admin';
            option.dataset.ip = device.ip_address;
            serverSelect.appendChild(option);
        });

        if (offlineServerCount > 0) {
            const divider = document.createElement('option');
            divider.disabled = true;
            divider.textContent = `\u2014 ${offlineServerCount} offline device${offlineServerCount > 1 ? 's' : ''} hidden \u2014`;
            serverSelect.appendChild(divider);
        }

    } catch (error) {
        console.error('Error loading hardware devices:', error);
        const errorMsg = error.message || error.toString() || 'Failed to load devices';
        toast(errorMsg, 'error');
    }
}

/**
 * Update source server details when server is selected
 * Username and IP auto-filled from device; password must be typed by user.
 */
function updateSourceServerDetails() {
    const serverSelect = document.getElementById('hwSourceServer');
    const selectedOption = serverSelect.options[serverSelect.selectedIndex];
    const passwordField = document.getElementById('hwServerPassword');

    // DO NOT auto-fill the password.
    // The SCP server password is the Linux account password on the source server
    // (e.g. hp_test's password on 192.168.100.175).
    // This is DIFFERENT from the device's telnet login password stored in the DB.
    // Auto-filling the wrong password is the root cause of SCP auth failures.
    if (passwordField) {
        passwordField.value = '';    // always clear on server change
        passwordField.focus();       // guide user to fill it in
    }
}

/**
 * Start hardware load job
 */
async function startHardwareLoad(event) {
    event.preventDefault();

    // Gather form data
    const deviceId = parseInt(document.getElementById('hwDeviceSelect').value);
    const sourceServerId = parseInt(document.getElementById('hwSourceServer').value);
    const imagePath = document.getElementById('hwImagePath').value.trim();
    const serverPassword = document.getElementById('hwServerPassword').value;
    const gatewayIP = document.getElementById('hwGatewayIP').value.trim();
    const subnetMask = document.getElementById('hwSubnetMask').value.trim();

    // Validation — password is REQUIRED, must be typed by user
    if (!deviceId || !sourceServerId || !imagePath) {
        toast('Please fill all required fields', 'error');
        return;
    }
    if (!serverPassword) {
        toast('Server Password is required — enter the Linux account password for the source server (e.g. hp_test\'s password)', 'error');
        document.getElementById('hwServerPassword').focus();
        return;
    }

    // Validate gateway IP format
    const ipRegex = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
    if (!ipRegex.test(gatewayIP)) {
        toast('Invalid gateway IP address format', 'error');
        return;
    }

    // Validate subnet mask (allow common valid masks including 255.255.255.255)
    const validSubnetMasks = [
        '255.0.0.0', '255.255.0.0', '255.255.255.0',
        '255.255.255.128', '255.255.255.192', '255.255.255.224',
        '255.255.255.240', '255.255.255.248', '255.255.255.252',
        '255.255.255.255'  // /32 host route
    ];
    if (!validSubnetMasks.includes(subnetMask)) {
        toast('Invalid subnet mask. Must be one of: 255.0.0.0, 255.255.0.0, 255.255.255.0, 255.255.255.128, 255.255.255.192, 255.255.255.224, 255.255.255.240, 255.255.255.248, 255.255.255.252, or 255.255.255.255', 'error');
        return;
    }

    // Get source server details
    const serverSelect = document.getElementById('hwSourceServer');
    const selectedOption = serverSelect.options[serverSelect.selectedIndex];
    const serverIP = selectedOption.dataset.ip;
    const serverUsername = selectedOption.dataset.username || 'admin';

    // Validate server details
    if (!serverIP) {
        toast('Source server IP not found. Please reselect the server.', 'error');
        console.error('Missing server IP for source server ID:', sourceServerId);
        return;
    }

    // Debug log
    console.log('Hardware Load Request Data:', {
        dut_id: deviceId,
        source_server_id: sourceServerId,
        image_path: imagePath,
        source_server_ip: serverIP,
        source_server_username: serverUsername,
        gateway_ip: gatewayIP,
        subnet_mask: subnetMask
    });

    // Confirm before starting
    const deviceName = document.getElementById('hwDeviceSelect').options[document.getElementById('hwDeviceSelect').selectedIndex].textContent;
    const imageName = imagePath.split('/').pop();

    if (!confirm('Start hardware load for ' + deviceName + '?\n\nImage: ' + imageName + '\nThis will reboot the device and install a new OS image.\n\nThis process takes 15-30 minutes and cannot be interrupted.')) {
        return;
    }

    try {
        // Send request
        const response = await fetch('/api/hardware-load/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Session-ID': getSessionId()
            },
            body: JSON.stringify({
                dut_id: deviceId,
                source_server_id: sourceServerId,
                image_path: imagePath,
                source_server_ip: serverIP,
                source_server_username: serverUsername,
                source_server_password: serverPassword,
                gateway_ip: gatewayIP,
                subnet_mask: subnetMask
            })
        });

        if (!response.ok) {
            let errorMessage = 'Failed to start hardware load';
            try {
                const errorData = await response.json();

                // Handle FastAPI validation errors (422 - detail is an array)
                if (Array.isArray(errorData.detail)) {
                    const errors = errorData.detail.map(err => {
                        const field = err.loc ? err.loc[err.loc.length - 1] : 'unknown';
                        return `${field}: ${err.msg}`;
                    }).join(', ');
                    errorMessage = `Validation error: ${errors}`;
                }
                // Handle regular error responses (detail is a string)
                else if (typeof errorData.detail === 'string') {
                    errorMessage = errorData.detail;
                }
                // Fallback to message field
                else if (errorData.message) {
                    errorMessage = errorData.message;
                }
            } catch (parseError) {
                // If response is not JSON, use status text
                errorMessage = response.statusText || errorMessage;
            }
            throw new Error(errorMessage);
        }

        const result = await response.json();
        currentHWJobId = result.job_id;
        localStorage.setItem('hwCurrentJobId', currentHWJobId);

        // Show progress container
        document.getElementById('hwProgressContainer').style.display = 'block';
        document.getElementById('hwCompletionMessage').style.display = 'none';

        // Show stop button for new job
        const stopBtnWrap = document.getElementById('hwStopBtnWrapper');
        if (stopBtnWrap) stopBtnWrap.style.display = 'flex';

        // Reset progress
        document.getElementById('hwProgressFill').style.width = '0%';
        document.getElementById('hwProgressPercent').textContent = '0%';
        document.getElementById('hwProgressStatus').textContent = 'Starting...';
        document.getElementById('hwCurrentStep').textContent = 'Initializing hardware load...';
        document.getElementById('hwExecutionLog').innerHTML = '';

        // Connect WebSocket for real-time updates
        connectHWWebSocket(currentHWJobId);

        // Scroll to progress section
        document.getElementById('hwProgressContainer').scrollIntoView({ behavior: 'smooth' });

        toast('Hardware load started successfully', 'success');

    } catch (error) {
        console.error('Error starting hardware load:', error);
        // Ensure we always have a string message to display
        const errorMessage = error.message || error.toString() || 'An unknown error occurred';
        toast(errorMessage, 'error');
    }
}

/**
 * Connect WebSocket for real-time progress updates.
 * Automatically reconnects if connection is lost and job is still running.
 */
function connectHWWebSocket(jobId) {
    // Clear any pending reconnect timer
    if (hwReconnectTimer) {
        clearTimeout(hwReconnectTimer);
        hwReconnectTimer = null;
    }

    // Close existing connection
    if (hwWebSocket) {
        hwWebSocket.close();
        hwWebSocket = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + '/api/hardware-load/ws/' + jobId;

    try {
        hwWebSocket = new WebSocket(wsUrl);
    } catch (e) {
        console.error('Failed to create WebSocket:', e);
        // Schedule reconnect
        hwScheduleReconnect(jobId);
        return;
    }

    hwWebSocket.onopen = () => {
        console.log('Hardware load WebSocket connected for job', jobId);
        appendHWLog('[System] Connected to live progress stream\n', 'log-success');
    };

    hwWebSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleHWProgressUpdate(data);
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    };

    hwWebSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    hwWebSocket.onclose = (event) => {
        console.log('Hardware load WebSocket closed. Code:', event.code, 'Job:', jobId);
        hwWebSocket = null;

        // Only reconnect if this job is still marked as active
        if (currentHWJobId === jobId) {
            hwScheduleReconnect(jobId);
        }
    };
}

/**
 * Schedule a WebSocket reconnect, checking job status first.
 */
function hwScheduleReconnect(jobId) {
    if (hwReconnectTimer) return;  // Already scheduled
    appendHWLog('[System] Connection lost — checking job status...\n', 'log-warning');

    hwReconnectTimer = setTimeout(async () => {
        hwReconnectTimer = null;
        // Check if job is still actually running before reconnecting
        try {
            const res = await fetch('/api/hardware-load/job/' + jobId, {
                headers: { 'X-Session-ID': getSessionId() }
            });
            if (!res.ok) {
                // Job not found — clear state
                appendHWLog('[System] Job no longer accessible. Process may have been cancelled.\n', 'log-warning');
                hwClearActiveJob();
                return;
            }
            const job = await res.json();

            if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
                // Job finished while we were disconnected — update UI
                appendHWLog('[System] Job finished while disconnected. Final status: ' + formatStatusText(job.status) + '\n',
                    job.status === 'completed' ? 'log-success' : 'log-error');
                handleHWProgressUpdate({
                    type: 'complete',
                    status: job.status,
                    error_message: job.error_message,
                    progress_percentage: job.progress_percentage
                });
                hwClearActiveJob();
            } else {
                // Job is still running — reconnect
                appendHWLog('[System] Job still running (status: ' + formatStatusText(job.status) + '). Reconnecting...\n', 'log-warning');
                // Update UI immediately with latest polled state
                const pct = job.progress_percentage || 0;
                document.getElementById('hwProgressFill').style.width = pct + '%';
                document.getElementById('hwProgressPercent').textContent = pct + '%';
                document.getElementById('hwProgressStatus').textContent = formatStatusText(job.status);
                document.getElementById('hwCurrentStep').textContent = job.current_step || '...';
                connectHWWebSocket(jobId);
            }
        } catch (e) {
            console.error('Error checking job status during reconnect:', e);
            appendHWLog('[System] Could not reach server. Retrying in 5s...\n', 'log-warning');
            // Try again in 5 seconds
            hwReconnectTimer = setTimeout(() => {
                hwReconnectTimer = null;
                hwScheduleReconnect(jobId);
            }, 5000);
        }
    }, 3000);
}

/**
 * Try to resume tracking an in-progress job (called on page load).
 */
async function hwTryResumeJob(jobId) {
    try {
        const res = await fetch('/api/hardware-load/job/' + jobId, {
            headers: { 'X-Session-ID': getSessionId() }
        });
        if (!res.ok) { hwClearActiveJob(); return; }

        const job = await res.json();

        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
            // Job already done — just refresh history
            hwClearActiveJob();
            refreshHWHistory();
            return;
        }

        // Job is still running — restore progress UI and reconnect
        const progressContainer = document.getElementById('hwProgressContainer');
        if (progressContainer) {
            progressContainer.style.display = 'block';
            const pct = job.progress_percentage || 0;
            document.getElementById('hwProgressFill').style.width = pct + '%';
            document.getElementById('hwProgressPercent').textContent = pct + '%';
            document.getElementById('hwProgressStatus').textContent = formatStatusText(job.status);
            document.getElementById('hwCurrentStep').textContent = job.current_step || 'Resuming...';
            document.getElementById('hwCompletionMessage').style.display = 'none';
            const stopBtnWrap = document.getElementById('hwStopBtnWrapper');
            if (stopBtnWrap) stopBtnWrap.style.display = 'flex';
            appendHWLog('[System] Resuming connection to running job #' + jobId + ' (status: ' + formatStatusText(job.status) + ')\n', 'log-warning');
        }

        connectHWWebSocket(jobId);
    } catch (e) {
        console.warn('Could not resume HW job', jobId, e);
        hwClearActiveJob();
    }
}

/**
 * Clear the active job tracking state.
 */
function hwClearActiveJob() {
    currentHWJobId = null;
    localStorage.removeItem('hwCurrentJobId');
    if (hwWebSocket) { hwWebSocket.close(); hwWebSocket = null; }
    if (hwReconnectTimer) { clearTimeout(hwReconnectTimer); hwReconnectTimer = null; }
}

/**
 * Handle progress update from WebSocket
 */
function handleHWProgressUpdate(data) {
    switch (data.type) {
        case 'progress':
            // Update progress bar
            document.getElementById('hwProgressFill').style.width = data.progress_percentage + '%';
            document.getElementById('hwProgressPercent').textContent = data.progress_percentage + '%';
            document.getElementById('hwProgressStatus').textContent = formatStatusText(data.status);
            document.getElementById('hwCurrentStep').textContent = data.current_step;

            // Append new log lines
            if (data.new_log_lines) {
                appendHWLog(data.new_log_lines);
            }
            break;

        case 'complete':
            // Job completed (success or failure)
            const isSuccess = data.status === 'completed';

            // Show completion message
            const completionDiv = document.getElementById('hwCompletionMessage');
            completionDiv.style.display = 'flex';
            completionDiv.className = 'hw-completion-message ' + (isSuccess ? 'success' : 'error');

            const icon = isSuccess ? 'check_circle' : 'error';
            const message = isSuccess
                ? 'Hardware load completed successfully!'
                : 'Hardware load failed: ' + (data.error_message || 'Unknown error');

            completionDiv.innerHTML = '<span class="material-icons-round">' + icon + '</span>' + message;

            // Update progress bar
            document.getElementById('hwProgressFill').style.width = isSuccess ? '100%' : document.getElementById('hwProgressFill').style.width;
            document.getElementById('hwProgressPercent').textContent = isSuccess ? '100%' : 'Failed';

            // Stop pulsing animation
            const stepIcon = document.querySelector('.hw-current-step .hw-step-icon');
            if (stepIcon) stepIcon.style.animation = 'none';

            // Hide stop button - job is done
            const stopWrapper = document.getElementById('hwStopBtnWrapper');
            if (stopWrapper) stopWrapper.style.display = 'none';

            // Close WebSocket and clear reconnect state
            hwClearActiveJob();

            // Refresh history
            refreshHWHistory();

            // Notification
            toast(message, isSuccess ? 'success' : 'error');
            break;

        case 'error':
            appendHWLog('[System Error] ' + data.message + '\n', 'log-error');
            toast('WebSocket error: ' + data.message, 'error');
            break;
    }
}

/**
 * Append log line to terminal
 */
function appendHWLog(text, cssClass) {
    cssClass = cssClass || '';
    const logDiv = document.getElementById('hwExecutionLog');

    const lines = text.split('\n');
    lines.forEach(line => {
        if (line.trim()) {
            const lineDiv = document.createElement('div');
            lineDiv.className = 'log-line ' + cssClass;

            // Color coding based on content
            if (line.includes('✓') || line.includes('SUCCESS')) {
                lineDiv.className = 'log-line log-success';
            } else if (line.includes('✗') || line.includes('ERROR') || line.includes('failed')) {
                lineDiv.className = 'log-line log-error';
            } else if (line.includes('WARNING') || line.includes('⚠')) {
                lineDiv.className = 'log-line log-warning';
            }

            lineDiv.textContent = line;
            logDiv.appendChild(lineDiv);
        }
    });

    // Auto-scroll to bottom
    if (hwAutoScroll) {
        logDiv.scrollTop = logDiv.scrollHeight;
    }
}

/**
 * Format status text for display
 */
function formatStatusText(status) {
    const statusMap = {
        'pending': 'Pending',
        'connecting': 'Connecting to device',
        'detecting_mode': 'Detecting device mode',
        'saving_config': 'Saving configuration',
        'rebooting': 'Rebooting device',
        'grub_menu': 'Waiting for GRUB menu',
        'grub_navigation': 'Navigating to ONIE',
        'onie_menu': 'ONIE menu detected',
        'onie_install_select': 'Selecting Install mode',
        'onie_loading': 'Loading ONIE',
        'onie_stop': 'Stopping discovery',
        'network_config': 'Configuring network',
        'downloading': 'Downloading image',
        'installing': 'Installing image',
        'completed': 'Completed',
        'failed': 'Failed',
        'cancelled': 'Cancelled'
    };

    return statusMap[status] || status || '-';
}

/**
 * Clear log terminal
 */
function clearHWLog() {
    if (confirm('Clear execution log?')) {
        document.getElementById('hwExecutionLog').innerHTML = '';
    }
}

/**
 * Load hardware load job history
 */
async function loadHWHistory() {
    try {
        const response = await fetch('/api/hardware-load/jobs', {
            headers: { 'X-Session-ID': getSessionId() }
        });

        if (!response.ok) throw new Error('Failed to load job history');

        const jobs = await response.json();
        renderHWHistoryTable(jobs);

    } catch (error) {
        console.error('Error loading job history:', error);
        toast('Failed to load job history', 'error');
    }
}

/**
 * Render job history table
 */
function renderHWHistoryTable(jobs) {
    const tbody = document.getElementById('hwHistoryTable');
    if (!tbody) {
        console.warn('Hardware history table element not found');
        return;
    }

    tbody.innerHTML = '';

    if (jobs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: rgba(255,255,255,0.5);">No hardware load jobs yet</td></tr>';
        return;
    }

    jobs.forEach(job => {
        const row = document.createElement('tr');

        // Calculate duration
        let duration = '-';
        if (job.started_at) {
            const start = new Date(job.started_at);
            const end = job.completed_at ? new Date(job.completed_at) : new Date();
            const diffMs = end - start;
            const diffMins = Math.floor(diffMs / 60000);
            const diffSecs = Math.floor((diffMs % 60000) / 1000);
            duration = diffMins + 'm ' + diffSecs + 's';
        }

        row.innerHTML = '<td style="font-weight:600;color:var(--text-secondary);font-size:12px">#' + job.id + '</td>' +
            '<td>' + esc(job.device_name || ('DUT ' + job.dut_id) || '-') + '</td>' +
            '<td title="' + esc(job.image_path || '') + '" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(job.image_name || job.image_path || '-') + '</td>' +
            '<td><span class="status-badge ' + (job.status || '') + '">' + formatStatusText(job.status || '') + '</span></td>' +
            '<td style="font-weight:600">' + (job.progress_percentage != null ? job.progress_percentage : 0) + '%</td>' +
            '<td style="font-size:12px;color:var(--text-secondary)">' + (job.started_at ? formatDateTime(job.started_at) : '-') + '</td>' +
            '<td style="font-size:12px;color:var(--text-secondary)">' + duration + '</td>' +
            '<td>' +
                '<div class="hw-action-group">' +
                    '<button class="hw-action-btn view" onclick="viewHWJobDetails(' + job.id + ')" title="View full execution logs">' +
                        '<span class="material-icons-round">description</span>' +
                    '</button>' +
                    (job.status === 'failed' || job.status === 'cancelled' ?
                        '<button class="hw-action-btn retry" onclick="retryHWJob(' + job.id + ')" title="Retry with same settings">' +
                            '<span class="material-icons-round">replay</span>' +
                        '</button>'
                    : '') +
                    (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled' ?
                        '<button class="hw-action-btn del" onclick="deleteHWJob(' + job.id + ')" title="Delete this record permanently">' +
                            '<span class="material-icons-round">delete_outline</span>' +
                        '</button>'
                    : '') +
                '</div>' +
            '</td>';

        tbody.appendChild(row);
    });
}

/**
 * View job details in the dedicated HW Job Log modal.
 * Uses hw-job-modal-overlay to avoid the generic modal's "undefined" issue.
 */
async function viewHWJobDetails(jobId) {
    hwViewingJobId = jobId;
    try {
        const response = await fetch('/api/hardware-load/job/' + jobId, {
            headers: { 'X-Session-ID': getSessionId() }
        });

        if (!response.ok) throw new Error('Failed to load job details');

        const job = await response.json();

        const overlay = document.getElementById('hw-job-modal-overlay');
        const titleEl = document.getElementById('hw-job-modal-title');
        const bodyEl = document.getElementById('hw-job-modal-body');
        const deleteBtn = document.getElementById('hw-job-delete-btn');

        const deviceLabel = job.device_name || ('DUT ' + (job.dut_id || '?'));
        titleEl.innerHTML = '<span class="material-icons-round">terminal</span> Job #' + job.id + ' — ' + esc(deviceLabel);

        // Only allow delete for finished jobs
        const deletable = (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled');
        deleteBtn.style.display = deletable ? '' : 'none';

        // Build info grid
        const statusBadge = '<span class="status-badge ' + (job.status || '') + '">' + formatStatusText(job.status || '') + '</span>';
        const pct = job.progress_percentage != null ? job.progress_percentage : 0;
        const errorHtml = job.error_message
            ? '<div style="margin-bottom:10px;padding:8px 12px;background:rgba(255,80,80,.08);border-left:3px solid var(--red);border-radius:4px;"><strong style="color:var(--red)">Error:</strong> ' + esc(job.error_message) + '</div>'
            : '';

        bodyEl.innerHTML =
            '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 20px;margin-bottom:16px;padding:12px 16px;background:var(--bg-secondary);border-radius:8px;">' +
                '<div><span style="color:var(--text-secondary);font-size:11px">STATUS</span><br>' + statusBadge + '</div>' +
                '<div><span style="color:var(--text-secondary);font-size:11px">PROGRESS</span><br><strong>' + pct + '%</strong></div>' +
                '<div><span style="color:var(--text-secondary);font-size:11px">CURRENT STEP</span><br><span style="font-size:13px">' + esc(job.current_step || '-') + '</span></div>' +
                '<div><span style="color:var(--text-secondary);font-size:11px">IMAGE</span><br><span style="font-size:12px;word-break:break-all">' + esc(job.image_name || job.image_path || '-') + '</span></div>' +
                '<div><span style="color:var(--text-secondary);font-size:11px">STARTED</span><br><span style="font-size:13px">' + (job.started_at ? formatDateTime(job.started_at) : '-') + '</span></div>' +
                '<div><span style="color:var(--text-secondary);font-size:11px">COMPLETED</span><br><span style="font-size:13px">' + (job.completed_at ? formatDateTime(job.completed_at) : 'In progress') + '</span></div>' +
            '</div>' +
            errorHtml +
            '<div class="hw-log-terminal" style="min-height:300px">' +
                '<div class="hw-terminal-header"><span class="material-icons-round">terminal</span> Full Execution Log</div>' +
                '<div class="hw-terminal-output" style="height:420px;overflow-y:auto"><pre style="margin:0;white-space:pre-wrap;word-break:break-word">' + esc(job.execution_log || 'No logs available.') + '</pre></div>' +
            '</div>';

        overlay.style.display = 'flex';

    } catch (error) {
        console.error('Error loading job details:', error);
        toast('Failed to load job details: ' + (error.message || 'unknown error'), 'error');
    }
}

/** Close the HW Job Log modal. */
function closeHWJobModal() {
    const overlay = document.getElementById('hw-job-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    hwViewingJobId = null;
}

/** Delete the job currently shown in the modal. */
async function deleteHWJobFromModal() {
    if (!hwViewingJobId) return;
    await deleteHWJob(hwViewingJobId, true /* closeModal */);
}

/** Delete a hardware load job by ID. */
async function deleteHWJob(jobId, closeModal) {
    if (!confirm('Delete job #' + jobId + ' from history?\nThis cannot be undone.')) return;
    try {
        const res = await fetch('/api/hardware-load/job/' + jobId, {
            method: 'DELETE',
            headers: { 'X-Session-ID': getSessionId() }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to delete job');
        }
        toast('Job #' + jobId + ' deleted', 'success');
        if (closeModal) closeHWJobModal();
        refreshHWHistory();
    } catch (e) {
        console.error('Error deleting HW job:', e);
        toast(e.message || 'Failed to delete job', 'error');
    }
}

/**
 * Retry failed job
 */
async function retryHWJob(jobId) {
    try {
        const response = await fetch('/api/hardware-load/job/' + jobId, {
            headers: { 'X-Session-ID': getSessionId() }
        });

        if (!response.ok) throw new Error('Failed to load job details');

        const job = await response.json();

        // Pre-fill form
        // Note: need to get dut_id from job details endpoint
        document.getElementById('hwImagePath').value = job.image_path;

        // Switch to hardware load tab
        switchTab('hardware-load');

        // Scroll to form
        document.getElementById('hardwareLoadForm').scrollIntoView({ behavior: 'smooth' });

        toast('Form pre-filled with previous job settings', 'info');

    } catch (error) {
        console.error('Error loading job for retry:', error);
        toast('Failed to load job details', 'error');
    }
}

/**
 * Stop / cancel the currently running hardware load job
 */
async function stopHardwareLoad() {
    if (!currentHWJobId) {
        toast('No active hardware load job to stop', 'error');
        return;
    }

    if (!confirm('Are you sure you want to stop the hardware load process?\n\nThis will forcibly cancel the job and close the device connection.')) {
        return;
    }

    try {
        const response = await fetch('/api/hardware-load/cancel/' + currentHWJobId, {
            method: 'POST',
            headers: { 'X-Session-ID': getSessionId() }
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || 'Failed to cancel job');
        }

        // Close WebSocket and clear reconnect state
        hwClearActiveJob();

        // Update UI to reflect cancellation
        const completionDiv = document.getElementById('hwCompletionMessage');
        completionDiv.style.display = 'flex';
        completionDiv.className = 'hw-completion-message error';
        completionDiv.innerHTML = '<span class="material-icons-round">cancel</span> Hardware load cancelled by user.';

        document.getElementById('hwProgressPercent').textContent = 'Stopped';
        document.getElementById('hwProgressStatus').textContent = 'Cancelled';
        document.getElementById('hwCurrentStep').textContent = 'Process stopped by user';

        // Hide stop button
        const stopBtn = document.getElementById('hwStopBtnWrapper');
        if (stopBtn) stopBtn.style.display = 'none';

        appendHWLog('[System] Hardware load process cancelled by user\n', 'log-warning');

        refreshHWHistory();
        toast('Hardware load job cancelled', 'warning');

    } catch (error) {
        console.error('Error cancelling hardware load:', error);
        toast(error.message || 'Failed to cancel job', 'error');
    }
}

/**
 * Refresh job history
 */
function refreshHWHistory() {
    loadHWHistory();
}

/**
 * Reset hardware load form
 */
function resetHardwareLoadForm() {
    document.getElementById('hardwareLoadForm').reset();
    document.getElementById('hwGatewayIP').value = '192.168.100.1';
    document.getElementById('hwSubnetMask').value = '255.255.255.255';  // Host route
}

/**
 * Format datetime for display
 */
function formatDateTime(dateString) {
    if (!dateString) return '-';

    // Handle UTC datetime from database (append Z if not present)
    let isoString = dateString;
    if (!dateString.endsWith('Z') && !dateString.includes('+')) {
        isoString = dateString + 'Z';  // Treat as UTC
    }

    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + ' min ago';

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return diffHours + ' hour' + (diffHours > 1 ? 's' : '') + ' ago';

    return date.toLocaleString();
}

// ============================================================
// USER MANAGEMENT (OnePalC Integration)
// ============================================================

async function loadUsers() {
    const container = document.getElementById('users-container');
    const countBadge = document.getElementById('users-count-badge');
    if (!container) return;

    container.innerHTML = `
        <div class="user-row" style="justify-content:center;padding:32px;border:none;">
            <span class="loader"></span>
            <span style="margin-left:12px;color:var(--text-muted);font-size:0.9rem;">Loading users…</span>
        </div>`;
    if (countBadge) countBadge.style.display = 'none';

    try {
        const res = await fetch(`${API}/api/users`, { headers: getSessionHeaders() });
        if (!res.ok) throw new Error(`Failed to load users (HTTP ${res.status})`);
        const data = await res.json();
        const users = Array.isArray(data) ? data : (data.users || []);

        if (countBadge) {
            countBadge.textContent = users.length;
            countBadge.style.display = 'inline-flex';
        }

        if (users.length === 0) {
            container.innerHTML = `
                <div class="user-row" style="justify-content:center;padding:40px;border:none;color:var(--text-muted);flex-direction:column;gap:8px;text-align:center">
                    <span class="material-icons-round" style="font-size:36px;opacity:0.3">group_off</span>
                    <span>No users yet. Click <b>Add User</b> to create the first account.</span>
                </div>`;
            return;
        }

        // Sort: admins first, then alphabetically
        users.sort((a, b) => {
            if (a.role === 'admin' && b.role !== 'admin') return -1;
            if (b.role === 'admin' && a.role !== 'admin') return 1;
            return (a.full_name || a.username || '').localeCompare(b.full_name || b.username || '');
        });

        container.innerHTML = '';
        users.forEach(u => {
            const displayName = u.full_name || u.username;
            const initial     = displayName.charAt(0).toUpperCase();
            const isAdmin     = u.role === 'admin';
            const isActive    = u.is_active !== false;

            const roleBadge = `<span class="user-role-badge${isAdmin ? ' is-admin' : ''}">${esc(u.role || 'operator')}</span>`;
            const statusBadge = isActive
                ? `<span style="font-size:0.68rem;background:rgba(16,185,129,0.12);color:var(--green,#10b981);border:1px solid rgba(16,185,129,0.3);border-radius:4px;padding:2px 7px">active</span>`
                : `<span style="font-size:0.68rem;background:rgba(239,68,68,0.1);color:var(--red);border:1px solid rgba(239,68,68,0.3);border-radius:4px;padding:2px 7px">inactive</span>`;

            const row = document.createElement('div');
            row.className = 'user-row';
            row.id = `user-row-${u.id}`;
            row.innerHTML = `
                <div class="user-row-avatar${isAdmin ? ' is-admin' : ''}" style="opacity:${isActive ? 1 : 0.45}">${esc(initial)}</div>
                <div class="user-row-info" style="flex:1;min-width:0">
                    <div class="user-row-name" style="display:flex;align-items:center;gap:6px">
                        ${esc(displayName)}
                        ${statusBadge}
                    </div>
                    <div class="user-row-email" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <span style="font-family:var(--mono);font-size:0.75rem;color:var(--text-secondary)">@${esc(u.username)}</span>
                        ${u.email ? `<span style="color:var(--text-muted);font-size:0.75rem">${esc(u.email)}</span>` : ''}
                    </div>
                    ${u.last_login ? `<div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px">Last login: ${_timeAgo(u.last_login)}</div>` : ''}
                </div>
                <div class="user-row-roles" style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                    ${roleBadge}
                    <button class="btn-icon" title="Toggle active/inactive"
                        onclick="toggleUserActive(${u.id}, ${isActive})"
                        style="padding:4px 6px;font-size:12px;color:${isActive ? 'var(--green,#10b981)' : 'var(--text-muted)'}">
                        <span class="material-icons-round" style="font-size:16px">${isActive ? 'toggle_on' : 'toggle_off'}</span>
                    </button>
                    <button class="btn-icon" title="Delete user"
                        onclick="deleteUser(${u.id}, '${esc(u.username)}')"
                        style="padding:4px 6px;font-size:12px;color:var(--red)">
                        <span class="material-icons-round" style="font-size:16px">delete</span>
                    </button>
                </div>`;
            container.appendChild(row);
        });

    } catch (err) {
        console.error('loadUsers error:', err);
        container.innerHTML = `
            <div class="user-row" style="justify-content:center;padding:40px;border:none;flex-direction:column;gap:8px;color:var(--red)">
                <span class="material-icons-round" style="font-size:36px">error_outline</span>
                <span style="font-size:0.88rem;text-align:center">${esc(err.message)}</span>
            </div>`;
    }
}

function showAddUserModal() {
    const overlay = document.createElement('div');
    overlay.id = 'add-user-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:2000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:440px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
                <span class="material-icons-round" style="color:var(--accent);font-size:26px">person_add</span>
                <h3 style="margin:0;font-size:1.15rem">Add New User</h3>
            </div>

            <label class="field-label">Username <span style="color:var(--red)">*</span></label>
            <input type="text" id="nu-username" placeholder="john_doe" class="input-full" style="margin-bottom:12px">

            <label class="field-label">Full Name</label>
            <input type="text" id="nu-fullname" placeholder="John Doe" class="input-full" style="margin-bottom:12px">

            <label class="field-label">Email</label>
            <input type="email" id="nu-email" placeholder="john@example.com" class="input-full" style="margin-bottom:12px">

            <label class="field-label">Password <span style="color:var(--red)">*</span> <span class="muted">(min 6 characters)</span></label>
            <input type="password" id="nu-password" placeholder="••••••" class="input-full" style="margin-bottom:12px">

            <label class="field-label">Role</label>
            <select id="nu-role" class="select-full" style="margin-bottom:20px">
                <option value="operator" selected>Operator</option>
                <option value="admin">Admin</option>
            </select>

            <div id="nu-error" style="color:var(--red);font-size:0.82rem;margin-bottom:12px;display:none"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="btn outline" onclick="document.getElementById('add-user-overlay').remove()">Cancel</button>
                <button class="btn primary" onclick="submitAddUser()">
                    <span class="material-icons-round" style="font-size:16px">save</span> Create User
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('nu-username').focus(), 80);
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') overlay.remove();
        if (e.key === 'Enter') submitAddUser();
    });
}

async function submitAddUser() {
    const username  = (document.getElementById('nu-username').value || '').trim();
    const full_name = (document.getElementById('nu-fullname').value || '').trim();
    const email     = (document.getElementById('nu-email').value || '').trim();
    const password  = (document.getElementById('nu-password').value || '');
    const role      = document.getElementById('nu-role').value;
    const errEl     = document.getElementById('nu-error');

    if (!username) { errEl.textContent = 'Username is required'; errEl.style.display = 'block'; return; }
    if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';

    try {
        const res = await fetch(`${API}/api/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getSessionHeaders() },
            body: JSON.stringify({ username, full_name: full_name || null, email: email || null, password, role }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            errEl.textContent = data.detail || `Server error ${res.status} — check core service logs`;
            errEl.style.display = 'block';
            return;
        }
        document.getElementById('add-user-overlay').remove();
        toast(`✓ User "${username}" created`, 'success');
        loadUsers();
    } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
    }
}

async function deleteUser(userId, username) {
    if (!confirm(`Delete user "${username}"?\n\nThis cannot be undone.`)) return;
    try {
        const res = await fetch(`${API}/api/users/${userId}`, {
            method: 'DELETE',
            headers: getSessionHeaders(),
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.detail || `HTTP ${res.status}`);
        }
        toast(`User "${username}" deleted`, 'success');
        const row = document.getElementById(`user-row-${userId}`);
        if (row) row.remove();
        // Update count badge
        const badge = document.getElementById('users-count-badge');
        if (badge) {
            const n = parseInt(badge.textContent || '0') - 1;
            badge.textContent = Math.max(0, n);
        }
    } catch (e) {
        toast(`Delete failed: ${e.message}`, 'error');
    }
}

async function toggleUserActive(userId, currentlyActive) {
    try {
        const res = await fetch(`${API}/api/users/${userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...getSessionHeaders() },
            body: JSON.stringify({ is_active: !currentlyActive }),
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.detail || `Server error ${res.status}`);
        }
        toast(`User ${currentlyActive ? 'deactivated' : 'activated'}`, 'success');
        loadUsers();
    } catch (e) {
        toast(`Update failed: ${e.message}`, 'error');
    }
}


function _timeAgo(isoStr) {
    if (!isoStr) return '—';
    const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (diff < 60)  return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

async function loadActiveSessions() {
    const container = document.getElementById('sessions-container');
    const countBadge = document.getElementById('sessions-count-badge');
    if (!container) return;

    container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;padding:32px;gap:10px;color:var(--text-muted);font-size:0.875rem;">
            <span class="loader"></span> Loading sessions…
        </div>`;
    if (countBadge) countBadge.style.display = 'none';

    try {
        // X-Session-ID header required — without it the backend returns 401
        const res = await fetch('/api/sessions/active', { headers: getSessionHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const sessions = data.sessions || [];
        const isAdmin  = data.is_admin === true;
        const myId     = getSessionId() || '';

        if (countBadge) {
            countBadge.textContent = sessions.length;
            countBadge.style.display = 'inline-flex';
        }

        if (sessions.length === 0) {
            container.innerHTML = `
                <div style="padding:40px;text-align:center;color:var(--text-muted);font-size:0.875rem;">
                    No active sessions.
                </div>`;
            return;
        }

        // Sort: own session first, then alphabetically
        sessions.sort((a, b) => {
            if (a.session_id === myId) return -1;
            if (b.session_id === myId) return 1;
            return (a.user_name || '').localeCompare(b.user_name || '');
        });

        container.innerHTML = '';
        sessions.forEach(s => {
            const displayName = s.user_name || s.user_email || 'Unknown';
            const initial     = displayName.charAt(0).toUpperCase();
            const role        = (s.user_role || 'user').toLowerCase();
            const isAdmin_row = role === 'admin';
            const isSelf      = s.session_id === myId;
            const dutCount    = s.allocated_dut_count || 0;

            const selfTag = isSelf
                ? `<span class="session-you-tag">You</span>` : '';

            const roleBadge = `<span class="session-role-badge ${isAdmin_row ? 'admin' : 'user'}">${esc(role)}</span>`;

            const metaChips = `
                <div class="session-meta-chip">
                    <span class="material-icons-round">schedule</span>
                    ${_timeAgo(s.last_activity)}
                </div>
                <div class="session-meta-chip">
                    <span class="material-icons-round">devices</span>
                    ${dutCount} DUT${dutCount !== 1 ? 's' : ''}
                </div>
                <div class="session-meta-chip">
                    <span class="material-icons-round">login</span>
                    Since ${s.created_at ? new Date(s.created_at).toLocaleDateString() : '—'}
                </div>`;

            const revokeBtn = (isAdmin && !isSelf)
                ? `<div class="session-card-actions">
                       <button class="btn outline small" style="color:var(--red);border-color:var(--red);opacity:0.85;"
                           onclick="revokeSession('${esc(s.session_id)}','${esc(displayName)}')"
                           title="Revoke this session">
                           <span class="material-icons-round" style="font-size:13px">block</span> Revoke
                       </button>
                   </div>`
                : '';

            const card = document.createElement('div');
            card.className = 'session-card';
            card.innerHTML = `
                <div class="session-card-top">
                    <div class="session-avatar ${isAdmin_row ? 'session-avatar-admin' : ''}">${initial}</div>
                    <div class="session-info">
                        <div class="session-name">${esc(displayName)}${selfTag}</div>
                        <div class="session-email">${esc(s.user_email || '—')}</div>
                    </div>
                    ${roleBadge}
                </div>
                <div class="session-card-bottom">
                    <div class="session-card-meta">${metaChips}</div>
                    ${revokeBtn}
                </div>`;
            container.appendChild(card);
        });

    } catch (err) {
        console.error('loadActiveSessions error:', err);
        container.innerHTML = `
            <div style="padding:32px;text-align:center;color:var(--red);font-size:0.875rem;">
                <span class="material-icons-round" style="font-size:28px;display:block;margin-bottom:8px">error_outline</span>
                ${esc(err.message)}
            </div>`;
    }
}


async function revokeSession(sessionId, userName) {
    if (!confirm(`Revoke session for "${userName}"?\n\nThis will immediately end their access.`)) return;
    try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/revoke`, {
            method: 'POST',
            headers: getSessionHeaders()
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast(`Session revoked for ${userName}`, 'success');
        loadActiveSessions();
    } catch (err) {
        toast(`Revoke failed: ${err.message}`, 'error');
    }
}


