/* ============================================================
   Eka Automation — Frontend Application Logic
   ============================================================ */

const API = window.location.origin;
let currentExecId = null;
let ws = null;
let allLogs = [];           // [{dut_name, script_name, level, message, timestamp}]
let _queuePollTimer = null; // setInterval handle for queue status polling

// Per-DUT interface cache: {dutId: [{name, speed, mtu, fec, alias, oper, admin}, ...]}
// Automatically populated when a DUT is added. Falls back to SONIC_PORTS if empty.
let dutInterfaces = {};

// Session management variables
let currentSession = null;
let sessionKeepAliveTimer = null;

// PTY Terminal (xterm.js) global variables
let terminalInstance = null;  // xterm.js Terminal instance
let terminalSocket = null;    // WebSocket connection for PTY
let xtermLoaded = false;      // Track if xterm.js library is loaded
let terminalOutputBuffer = []; // Store all terminal output for reconnection
let terminalCurrentDutId = null; // Track which DUT is currently connected
let terminalIsReconnecting = false; // Flag to prevent multiple reconnect attempts
let terminalHeartbeatInterval = null; // Interval ID for heartbeat monitoring

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
            startSessionKeepAlive();
            return;
        } else {
            console.log('Existing session invalid, creating new one');
            localStorage.removeItem('eka-session-id');
            localStorage.removeItem('eka-user-name');
        }
    }

    // No valid session - auto-create one without modal
    await autoCreateSession();
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

                console.log(`[KEEPALIVE] ✓ Success: Session ${sessionId.substring(0,8)}... expires in ${data.time_remaining_minutes}m`, data);
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
 * Update session status display with health information
 */
function updateSessionStatusDisplay(sessionData) {
    // Only update the health-dot indicator, no text status display
    const healthDot = document.getElementById('health-dot');
    const remaining = Math.max(0, sessionData.time_remaining_minutes || 0);

    console.log('[SESSION] Updating health-dot, time remaining:', remaining, 'minutes');

    // Update health dot color based on session time remaining
    if (healthDot) {
        healthDot.classList.remove('healthy', 'warning', 'critical');
        if (remaining <= 10) {
            // Red: 10 minutes or less (CRITICAL)
            healthDot.classList.add('critical');
            healthDot.title = `Session Status: CRITICAL (${remaining}m remaining)`;
            console.log('[SESSION] Health-dot set to CRITICAL (red)');
        } else if (remaining <= 30) {
            // Yellow: 30 minutes or less (WARNING)
            healthDot.classList.add('warning');
            healthDot.title = `Session Status: Warning (${remaining}m remaining)`;
            console.log('[SESSION] Health-dot set to WARNING (yellow)');
        } else if (remaining >= 420) {
            // Green: 7-8 hours (HEALTHY)
            healthDot.classList.add('healthy');
            const hours = Math.floor(remaining / 60);
            const mins = remaining % 60;
            healthDot.title = `Session Status: Healthy (${hours}h ${mins}m remaining)`;
            console.log('[SESSION] Health-dot set to HEALTHY (green)');
        } else {
            // Gray: Between 30m and 7h (NORMAL)
            const hours = Math.floor(remaining / 60);
            const mins = remaining % 60;
            healthDot.title = `Session Status: Active (${hours}h ${mins}m remaining)`;
            console.log('[SESSION] Health-dot set to NORMAL (gray)');
        }
    } else {
        console.warn('[SESSION] Health-dot element not found!');
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
    }
    if (tab === 'devices') loadDUTs();
    if (tab === 'logs') loadExecutions();
    if (tab === 'terminal') {
        loadDUTs(); // Load DUTs to populate terminal dropdown
        setupTerminalHandlers(); // Re-setup handlers when entering terminal tab
    }
    if (tab === 'vs') renderVSHostList();
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
        // Close terminal connection if this device is currently connected
        if (terminalCurrentDutId === id && terminalSocket) {
            console.log(`[PTY] Closing terminal connection for deleted device ${id}`);
            terminalSocket.close();
            terminalSocket = null;
            terminalCurrentDutId = null;
            if (terminalInstance) {
                terminalInstance.dispose();
                terminalInstance = null;
            }
        }

        const res = await fetch(`${API}/api/duts/${id}`, { method: 'DELETE', headers: getSessionHeaders() });
        if (!res.ok) throw new Error('Failed');
        toast('Device deleted', 'success');
        selectedDUTIds.delete(id);

        // Clear terminal if it was showing this device
        const termSelect = document.getElementById('term-dut');
        if (termSelect && parseInt(termSelect.value) === id) {
            termSelect.value = '';
            const container = document.getElementById('term-container');
            if (container) {
                container.innerHTML = `
                    <div class="log-placeholder">
                        <span class="material-icons-round">terminal</span>
                        <p>Select a device to open PTY terminal session.</p>
                        <p style="font-size: 12px; color: #888;">Supports vi, nano, top, htop, screen, tmux</p>
                    </div>`;
            }
        }

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
    const duts = dutsData.filter(d => d.device_type === 'DUT');
    if (!duts.length) {
        el.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">No DUTs available. Add devices with type "DUT" in Devices tab.</p>';
        updateDUTSelectionCount();
        return;
    }
    el.innerHTML = duts.map(d => {
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
    } else {
        selectedDUTIds.delete(numId);
        delete dutPositions[numId];
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

function renderSpyVMs() {
    const sel = document.getElementById('spy-vm-select');
    if (!sel) return;
    const vms = dutsData.filter(d => d.device_type === 'VM');
    const prevVal = sel.value;
    sel.innerHTML = '<option value="">-- Select VM Host --</option>';
    vms.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.name} (${d.ip_address}:${d.port}) — ${d.status}`;
        sel.appendChild(opt);
    });
    if (prevVal) sel.value = prevVal;
    updateSpyStartBtn();
}


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
    scriptsList.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Select VM to load folders and scripts.</p>';
    updateScriptMultiSelectText();

    // Reset subfolders
    if (subfoldersEl) {
        subfoldersEl.innerHTML = '<p class="muted" style="padding:8px;font-size:12px;margin:0">Select VM to load folders.</p>';
    }

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

    // Automatically navigate to root folder to show top-level categories
    await navigateToPath('');

    updateSpyStartBtn();
}

// ============================================================
// EXECUTE — HIERARCHICAL CATEGORY & SCRIPT NAVIGATION
// ============================================================

let selectedScriptPaths = new Set();
let currentFolderPath = '';  // Current folder path (e.g., "routing/bgp")

/**
 * Navigate to a specific folder path and load its contents
 * @param {string} path - Relative path from tests directory (empty string for root)
 */
async function navigateToPath(path) {
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
        const url = `${API}/api/spytest/browse/${encodeURIComponent(path)}?host_id=${vmId}`;
        console.log(`Fetching: ${url}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();
        console.log('Browse data:', data);

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
        const pathDisplay = path || 'root';
        toast(`Loaded ${data.subfolder_count} folders, ${data.script_count} scripts from ${pathDisplay}`, 'success');

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
    let html = `<label class="multi-select-item select-all">
        <input type="checkbox" onchange="toggleAllScripts(this)"> Select All
    </label>`;

    let checkedCount = 0;
    scriptsData.forEach(s => {
        const isChecked = selectedScriptPaths.has(s.path);
        if (isChecked) {
            checkedCount++;
            console.log(`Script ${s.path} is checked`);
        }
        const checked = isChecked ? 'checked' : '';
        html += `<label class="multi-select-item">
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

function onScriptCheckboxChange(scriptPath, cb) {
    // Enhancement 2: If deselecting during execution, show confirmation
    if (!cb.checked && currentExecId) {
        // User is trying to deselect a script during execution
        // Show confirmation dialog
        cb.checked = true;  // Re-check for now
        const scriptName = scriptPath.split('/').pop();  // Get filename
        showCancelConfirmation(scriptName);
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
}

function toggleAllScripts(cb) {
    const items = document.querySelectorAll('#script-dropdown-list .multi-select-item:not(.select-all) input[type=checkbox]');
    items.forEach(item => {
        item.checked = cb.checked;
        const path = item.value;
        if (cb.checked) selectedScriptPaths.add(path); else selectedScriptPaths.delete(path);
    });
    updateScriptMultiSelectText();
    updateSpyStartBtn();
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

async function pollQueueStatus(execId) {
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
    const statusMeta = {
        queued:  { icon: 'hourglass_empty', cls: 'pending',   label: 'Queued'  },
        waiting: { icon: 'schedule',        cls: 'pending',   label: 'Waiting' },
        running: { icon: 'play_circle',     cls: 'running',   label: 'Running' },
        done:    { icon: 'check_circle',    cls: 'completed', label: 'Done'    },
        failed:  { icon: 'error',           cls: 'failed',    label: 'Failed'  },
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
    Object.keys(scriptHideTimers).forEach(key => clearTimeout(scriptHideTimers[key]));
    scriptHideTimers = {};
    showOnlyRunning = false;
    const btn = document.getElementById('btn-show-only-running');
    if (btn) {
        btn.classList.remove('active');
        btn.title = 'Hide completed scripts';
        const icon = btn.querySelector('.material-icons-round');
        if (icon) icon.textContent = 'visibility_off';
    }

    // Enhancement 2: Hide add scripts button
    const addScriptsBtn = document.getElementById('btn-add-scripts-exec');
    if (addScriptsBtn) addScriptsBtn.style.display = 'none';

    console.log('Execution state reset: selections cleared');
}

async function startExecution() {
    const vmId = parseInt(document.getElementById('spy-vm-select').value);
    const scriptPaths = Array.from(selectedScriptPaths);
    const logLevel = document.getElementById('spy-log-level')?.value || 'info';
    const skipInit = document.getElementById('spy-skip-init')?.checked || false;
    // Enhancement 3: Capture DUT reservation checkbox
    const reserveDuts = document.getElementById('reserve-duts-checkbox')?.checked || false;
    const allocInfoEl = document.getElementById('exec-allocation-info');

    // Auto-generate master testbed from topology if devices are selected (silent mode)
    if (selectedDUTIds.size > 0) {
        try {
            await generateMasterTestbed(true); // Silent = true (no modal/toasts)
        } catch (e) {
            console.error('Failed to auto-generate master testbed:', e);
            toast('Failed to generate testbed. Please check topology and try again.', 'error');
            return;
        }
    }

    // Always use master_testbed.yaml (auto-generated from topology)
    const testbedFile = 'master_testbed.yaml';

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
                try {
                    const r = await fetch(`${API}/api/spytest/script-info`, {
                        method: 'POST',
                        headers: getSessionHeaders(),
                        body: JSON.stringify({ host_id: vmId, script_path: path }),
                    });
                    if (r.ok) { const info = await r.json(); dut_count = info.dut_count || 1; }
                } catch (_) { /* default dut_count 1 */ }
                scriptsWithCount.push({ path, dut_count });
            }
        } catch (_) {
            scriptsWithCount = scriptPaths.map(p => ({ path: p, dut_count: 1 }));
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
        loadStats();
    } catch (e) {
        toast(`Failed to start execution: ${e.message}`, 'error');
        const btn = document.getElementById('btn-start-exec');
        if (btn) { btn.disabled = false; updateSpyStartBtn(); }
    }
}

function stopExecution() {
    if (ws) { ws.close(); ws = null; }
    stopQueuePolling();
    document.getElementById('btn-start-exec').style.display = '';
    document.getElementById('btn-stop-exec').style.display = 'none';
    const qPanel = document.getElementById('queue-status-panel');
    if (qPanel) qPanel.style.display = 'none';
    toast('Execution monitoring stopped', 'info');
}

function connectWS(execId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/execution/${execId}`);
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'execution_complete') {
            toast(`Execution ${data.status} (${data.duration || 0}s)`, data.status === 'completed' ? 'success' : 'error');
            document.getElementById('btn-start-exec').style.display = '';
            document.getElementById('btn-stop-exec').style.display = 'none';
            // Enhancement 2: Hide "Add Scripts" button after execution
            const addScriptsBtn = document.getElementById('btn-add-scripts-exec');
            if (addScriptsBtn) addScriptsBtn.style.display = 'none';
            // Enhancement 1: Hide "Show Only Running" button after execution
            const showOnlyBtn = document.getElementById('btn-show-only-running');
            if (showOnlyBtn) showOnlyBtn.style.display = 'none';
            stopQueuePolling();
            // Update queue badge to completed/failed
            const badge = document.getElementById('queue-exec-badge');
            if (badge) {
                badge.className = `badge ${data.status === 'completed' ? 'completed' : 'failed'}`;
                badge.textContent = data.status;
            }
            loadStats();
            loadExecutions();

            // BUG FIX: Clear live logs from Execute tab after completion
            // Users should view completed logs in Logs tab, not Execute tab
            allLogs = [];
            logStreams = {};
            const logContainer = document.getElementById('exec-log-container');
            if (logContainer) {
                logContainer.innerHTML = '<div class="log-placeholder"><span class="material-icons-round">terminal</span><p>Logs will appear here when an execution starts...</p></div>';
            }
            // Hide download button
            const downloadBtn = document.getElementById('btn-download-logs');
            if (downloadBtn) downloadBtn.style.display = 'none';

            // Reset UI to normal state: unselect scripts and DUTs
            resetExecutionState();
            return;
        }
        // Skip QUEUE log entries from appearing in log panes (they're handled by the queue panel)
        if (data.message && data.message.startsWith('[QUEUE]')) return;
        allLogs.push(data);
        appendLogEntry(data);
    };
    ws.onerror = () => toast('WebSocket connection error', 'error');
    ws.onclose = () => { ws = null; };
}

// ============================================================
// LOG RENDERING — panes keyed by script name (dut_name field)
// ============================================================

let logStreams = {};  // {scriptName: DOM element}
let showOnlyRunning = false;  // Toggle for "Show Only Running" button
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
    if ((msg.includes('passed') || msg.includes('failed') || msg.includes('completed')) &&
        !msg.includes('waiting')) {
        if (!completedScripts.has(source)) {
            completedScripts.add(source);
            // Set auto-hide timer for 5 minutes (300000 ms)
            setAutoHideScriptLog(source, 300000);
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
                <span class="material-icons-round" style="font-size:14px;opacity:.5;margin-left:auto">open_in_new</span>
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
}

function openLogPopup(source) {
    const logs = allLogs.filter(l => (l.dut_name || 'SYSTEM') === source);
    const html = '<div class="log-popup-body">' + (logs.length ? logs.map(logHTML).join('') : '<p class="muted" style="padding:8px">No logs yet.</p>') + '</div>';
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

// Toggle "Show Only Running" filter for log panes
function toggleShowOnlyRunning() {
    showOnlyRunning = !showOnlyRunning;
    const btn = document.getElementById('btn-show-only-running');
    if (btn) {
        btn.classList.toggle('active');
        btn.title = showOnlyRunning ? 'Show all scripts' : 'Hide completed scripts';
        const icon = btn.querySelector('.material-icons-round');
        if (icon) icon.textContent = showOnlyRunning ? 'visibility' : 'visibility_off';
    }

    // Update all log panes visibility
    document.querySelectorAll('.script-log-pane').forEach(pane => {
        const scriptName = pane.dataset.scriptName;
        if (showOnlyRunning && completedScripts.has(scriptName)) {
            pane.classList.add('log-pane-hidden');
        } else {
            pane.classList.remove('log-pane-hidden');
        }
    });
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

let pendingCancelScript = null;  // Track which script user is trying to cancel

function showCancelConfirmation(scriptName) {
    // Show cancel confirmation dialog for a script
    pendingCancelScript = scriptName;
    const modal = document.getElementById('cancel-script-confirmation-modal');
    const nameDisplay = document.getElementById('cancel-script-name-display');
    if (modal && nameDisplay) {
        nameDisplay.textContent = scriptName;
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

        // Remove checkbox for cancelled script
        const checkbox = document.querySelector(`.script-item input[data-script-name="${pendingCancelScript}"]`);
        if (checkbox) checkbox.checked = false;

        // Hide the log pane for cancelled script
        const logPane = document.querySelector(`.script-log-pane[data-script-name="${pendingCancelScript}"]`);
        if (logPane) logPane.classList.add('log-pane-hidden');

        toast(`Script "${pendingCancelScript}" cancelled`, 'success');
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
    try {
        const res = await fetch(`${API}/api/executions`, {
            headers: getSessionHeaders()
        });
        const execs = await res.json();
        const tbody = document.getElementById('exec-history-tbody');
        if (!execs.length) { tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">No executions yet.</td></tr>'; return; }
        tbody.innerHTML = execs.map(ex => `
            <tr>
                <td>#${ex.id}</td>
                <td>${esc(ex.name)}</td>
                <td>${esc(ex.type || '-')}</td>
                <td><span class="badge ${ex.status}">${ex.status}</span></td>
                <td>${ex.dut_count}</td>
                <td>${ex.duration != null ? ex.duration + 's' : '-'}</td>
                <td>${ex.created_at ? new Date(ex.created_at).toLocaleString() : '-'}</td>
                <td><button class="btn outline small" onclick="viewExecLogs(${ex.id})"><span class="material-icons-round" style="font-size:16px">visibility</span></button></td>
            </tr>`).join('');

        // Dashboard recent
        const recent = execs.slice(0, 5);
        const dashEl = document.getElementById('dash-recent-exec');
        dashEl.innerHTML = recent.map(ex => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
                <div><strong>#${ex.id}</strong> <span class="muted">${esc(ex.name)}</span></div>
                <span class="badge ${ex.status}">${ex.status}</span>
            </div>`).join('') || '<p class="muted">No executions yet.</p>';
    } catch { }
}

// Store current viewing execution ID for delete operations
let currentViewingExecId = null;

async function viewExecLogs(execId) {
    try {
        currentViewingExecId = execId;
        const res = await fetch(`${API}/api/executions/${execId}/logs?limit=500`);
        const logs = await res.json();

        // Show modal instead of inline card
        const overlay = document.getElementById('log-detail-modal-overlay');
        overlay.classList.add('active');

        document.getElementById('log-detail-title').textContent = `#${execId}`;
        const container = document.getElementById('log-detail-container');
        if (!logs.length) {
            container.innerHTML = '<p class="muted" style="padding:20px;">No logs for this execution.</p>';
            return;
        }
        container.innerHTML = logs.map(logHTML).join('');
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

/**
 * Delete logs with confirmation dialog asking what to delete
 */
async function deleteLogs() {
    if (!currentViewingExecId) {
        toast('No logs selected', 'warning');
        return;
    }

    // First confirmation: confirm delete action
    const confirmDelete = confirm(`⚠️ Delete all logs for execution #${currentViewingExecId}?\n\nThis cannot be undone.`);
    if (!confirmDelete) return;

    // Second confirmation: ask what to delete (all or specific logs)
    const options = {
        'all': 'Delete ALL logs for this execution',
        'current_session': 'Delete logs from current session only',
        'cancel': 'Cancel (do not delete)'
    };

    // Create choice dialog
    const choice = await showDeleteChoiceDialog(
        `What logs do you want to delete for execution #${currentViewingExecId}?`,
        options
    );

    if (choice === 'cancel' || !choice) {
        toast('Delete cancelled', 'info');
        return;
    }

    // Proceed with deletion
    try {
        const res = await fetch(`${API}/api/executions/${currentViewingExecId}/logs`, {
            method: 'DELETE',
            headers: getSessionHeaders(),
            body: JSON.stringify({ scope: choice })
        });

        if (res.ok) {
            toast(`✓ Logs deleted (scope: ${choice})`, 'success');
            closeLogViewer();
            // Refresh execution history
            loadExecutions();
        } else {
            const err = await res.json();
            toast(`Failed to delete logs: ${err.detail}`, 'error');
        }
    } catch (e) {
        toast(`Error deleting logs: ${e.message}`, 'error');
        console.error('Delete logs error:', e);
    }
}

/**
 * Show custom delete choice dialog
 * Returns: 'all', 'current_session', or null if cancelled
 */
async function showDeleteChoiceDialog(message, options) {
    return new Promise((resolve) => {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active';
        overlay.id = 'delete-choice-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.maxWidth = '500px';

        modal.innerHTML = `
            <div class="modal-header">
                <h3><span class="material-icons-round">delete_forever</span> Delete Logs</h3>
                <button class="btn icon" onclick="document.getElementById('delete-choice-overlay').remove()" title="Close">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            <div class="modal-body">
                <p style="margin-bottom: 16px; color: var(--text-secondary);">${message}</p>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <button class="btn outline" onclick="deleteChoiceClick('all')" style="justify-content: flex-start;">
                        <span class="material-icons-round">delete_sweep</span> ${options['all']}
                    </button>
                    <button class="btn outline" onclick="deleteChoiceClick('current_session')" style="justify-content: flex-start;">
                        <span class="material-icons-round">filter_alt</span> ${options['current_session']}
                    </button>
                    <button class="btn outline" onclick="deleteChoiceClick('cancel')" style="justify-content: flex-start;">
                        <span class="material-icons-round">close</span> ${options['cancel']}
                    </button>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                resolve(null);
            }
        });

        // Store resolve function globally to be called from buttons
        window.deleteChoiceClick = (choice) => {
            document.getElementById('delete-choice-overlay')?.remove();
            resolve(choice);
        };
    });
}

// ============================================================
// TERMINAL - PTY Mode with xterm.js
// ============================================================

function renderTermDUTList() {
    const sel = document.getElementById('term-dut');
    const current = sel.value;
    // Filter out telnet devices - Terminal tab only supports SSH
    const sshDevices = dutsData.filter(d => d.connection_type !== 'telnet');
    sel.innerHTML = '<option value="">-- Select Device --</option>' +
        sshDevices.map(d => `<option value="${d.id}" ${d.id == current ? 'selected' : ''}>${esc(d.name)} (${esc(d.ip_address)})</option>`).join('');
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
 * Initialize PTY terminal with xterm.js for a specific device
 * Creates WebSocket connection for bidirectional terminal streaming
 */
async function initPTYTerminal(dutId) {
    console.log(`[PTY] Initializing terminal for DUT ${dutId}`);

    // Ensure xterm.js library is loaded
    try {
        await loadXtermLibrary();
    } catch (e) {
        console.error('[PTY] Failed to load xterm.js library:', e);
        toast('Failed to load terminal library', 'error');
        return;
    }

    // Clean up existing terminal and connection
    if (terminalSocket) {
        console.log('[PTY] Closing existing WebSocket connection');
        terminalSocket.close();
        terminalSocket = null;
    }
    if (terminalInstance) {
        console.log('[PTY] Disposing existing terminal instance');
        terminalInstance.dispose();
        terminalInstance = null;
    }

    // Get container element
    const container = document.getElementById('term-container');
    if (!container) {
        console.error('[PTY] Terminal container not found');
        toast('Terminal container not found', 'error');
        return;
    }

    // Create xterm.js Terminal instance
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#ffffff',
            cursorAccent: '#000000',
            selection: '#264f78',
            black: '#000000',
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#2472c8',
            magenta: '#bc3fbc',
            cyan: '#11a8cd',
            white: '#e5e5e5',
            brightBlack: '#666666',
            brightRed: '#f14c4c',
            brightGreen: '#23d18b',
            brightYellow: '#f5f543',
            brightBlue: '#3b8eea',
            brightMagenta: '#d670d6',
            brightCyan: '#29b8db',
            brightWhite: '#e5e5e5'
        },
        cols: 80,
        rows: 24,
        scrollback: 10000,  // Keep last 10,000 lines
        scrollOnUserInput: true,  // Auto-scroll to cursor when typing
        allowTransparency: false
    });

    // Add fit addon for auto-resize
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    // Mount terminal to DOM
    container.innerHTML = '<div class="term-info" style="padding: 10px;">Connecting to device...</div>';
    setTimeout(() => {
        container.innerHTML = '';  // Clear loading message
        term.open(container);
        fitAddon.fit();
        console.log(`[PTY] Terminal mounted - size: ${term.cols}x${term.rows}`);

        // Prevent terminal from scrolling the page
        const xtermViewport = container.querySelector('.xterm-viewport');
        if (xtermViewport) {
            xtermViewport.addEventListener('scroll', (e) => {
                e.stopPropagation();
            }, { passive: true });
        }

        // Prevent wheel events from bubbling to page
        container.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, { passive: true });
    }, 100);

    // Establish WebSocket connection with session authentication
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sessionId = localStorage.getItem('eka-session-id');
    const wsUrl = `${wsProtocol}//${window.location.host}/api/terminal/ws/${dutId}?session_id=${sessionId}`;
    console.log(`[PTY] Connecting to ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    // Track current DUT and reset buffer on new connection
    terminalCurrentDutId = dutId;
    terminalOutputBuffer = [];
    terminalIsReconnecting = false;

    // WebSocket event handlers
    ws.onopen = () => {
        console.log('[PTY] WebSocket connected');
        terminalIsReconnecting = false;
        term.focus();
        term.write('\x1b[32m✓ Connected to PTY terminal\x1b[0m\r\n');
        term.write('\x1b[33mSupports: vi, nano, top, htop, screen, tmux, and all interactive applications\x1b[0m\r\n\r\n');
    };

    ws.onmessage = (event) => {
        // Receive binary data from SSH PTY and render in terminal
        if (event.data instanceof ArrayBuffer) {
            const data = new Uint8Array(event.data);
            term.write(data);
            // Store output in buffer for reconnection
            terminalOutputBuffer.push(data);
            // Auto-scroll to show cursor/prompt
            const viewport = container.querySelector('.xterm-viewport');
            if (viewport) {
                viewport.scrollTop = viewport.scrollHeight;
            }
        } else if (typeof event.data === 'string') {
            // Handle JSON messages (status updates, errors, heartbeat, etc.)
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'heartbeat') {
                    // Silently handle heartbeat - keep connection alive
                    console.debug('[PTY] Heartbeat received');
                } else if (msg.error) {
                    term.write(`\r\n\x1b[31mError: ${msg.error}\x1b[0m\r\n`);
                    const viewport = container.querySelector('.xterm-viewport');
                    if (viewport) {
                        viewport.scrollTop = viewport.scrollHeight;
                    }
                } else if (msg.status === 'connecting') {
                    // Show connection status message
                    term.write(`\x1b[33m${msg.message}\x1b[0m\r\n`);
                    const viewport = container.querySelector('.xterm-viewport');
                    if (viewport) {
                        viewport.scrollTop = viewport.scrollHeight;
                    }
                }
            } catch (e) {
                // Not JSON, write as text
                term.write(event.data);
                const viewport = container.querySelector('.xterm-viewport');
                if (viewport) {
                    viewport.scrollTop = viewport.scrollHeight;
                }
            }
        }
    };

    ws.onerror = (error) => {
        console.error('[PTY] WebSocket error:', error);
        term.write('\r\n\x1b[31m✗ Connection error\x1b[0m\r\n');
        toast('Terminal connection error', 'error');
    };

    ws.onclose = (event) => {
        console.log('[PTY] WebSocket closed:', event.code, event.reason);
        term.write('\r\n\x1b[33m[Terminal session ended - attempting to reconnect...]\x1b[0m\r\n');

        // Auto-reconnect if user is actively viewing Terminal tab
        if (!document.hidden && terminalCurrentDutId && !terminalIsReconnecting) {
            terminalIsReconnecting = true;
            setTimeout(() => {
                console.log(`[PTY] Auto-reconnecting to DUT ${terminalCurrentDutId}...`);
                initPTYTerminal(terminalCurrentDutId).catch(e => {
                    console.error('[PTY] Auto-reconnect failed:', e);
                    term.write('\x1b[31mReconnection failed. Select device to try again.\x1b[0m\r\n');
                });
            }, 1000);  // Wait 1 second before attempting reconnect
        }
    };

    // Send keyboard input from terminal to SSH via WebSocket
    term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            // Convert string to Uint8Array and send as binary
            const encoder = new TextEncoder();
            ws.send(encoder.encode(data));
        }
    });

    // Handle terminal resize events
    term.onResize(({ cols, rows }) => {
        console.log(`[PTY] Terminal resized to ${cols}x${rows}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'resize',
                cols: cols,
                rows: rows
            }));
        }
    });

    // Auto-resize terminal when window size changes
    const resizeObserver = new ResizeObserver(() => {
        if (terminalInstance) {
            try {
                fitAddon.fit();
            } catch (e) {
                // Ignore resize errors during cleanup
            }
        }
    });
    resizeObserver.observe(container);

    // Store globally for cleanup
    terminalInstance = term;
    terminalSocket = ws;

    // Add Page Visibility API detection for tab focus (one-time setup)
    if (!terminalHeartbeatInterval) {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && terminalCurrentDutId && terminalIsReconnecting && terminalSocket?.readyState !== WebSocket.OPEN) {
                // Tab became visible and connection was lost - try to reconnect
                console.log('[PTY] Tab became visible - checking connection...');
                if (terminalSocket?.readyState !== WebSocket.OPEN) {
                    initPTYTerminal(terminalCurrentDutId).catch(e => {
                        console.error('[PTY] Visibility-triggered reconnect failed:', e);
                    });
                }
            }
        });
    }

    console.log('[PTY] Terminal initialization complete');
}

/**
 * Called when device selection changes in terminal dropdown
 */
async function termDeviceChanged() {
    const dutSelect = document.getElementById('term-dut');
    const dutId = dutSelect ? dutSelect.value : null;
    const container = document.getElementById('term-container');

    console.log('[PTY] Device changed - DUT ID:', dutId);

    if (!dutId) {
        // No device selected - clean up and show placeholder
        if (terminalSocket) {
            terminalSocket.close();
            terminalSocket = null;
        }
        if (terminalInstance) {
            terminalInstance.dispose();
            terminalInstance = null;
        }

        if (container) {
            container.innerHTML = `
                <div class="log-placeholder">
                    <span class="material-icons-round">terminal</span>
                    <p>Select a device to open PTY terminal session.</p>
                    <p style="font-size: 12px; color: #888;">Supports vi, nano, top, htop, screen, tmux</p>
                </div>`;
        }
        return;
    }

    // Initialize PTY terminal for selected device
    await initPTYTerminal(dutId);
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

function toast(msg, type = 'info') {
    const icons = { success: 'check_circle', error: 'error', info: 'info' };
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="material-icons-round">${icons[type] || 'info'}</span> ${esc(msg)}`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(40px)'; setTimeout(() => el.remove(), 300); }, 4000);
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

    try {
        const res = await fetch(`${API}/api/topology/generate-master-testbed`, {
            method: 'POST',
            headers: getSessionHeaders(),
            body: JSON.stringify({
                host_id: parseInt(vmId),
                master_filename: 'master_testbed.yaml'
            })
        });

        if (!res.ok) {
            const err = await res.json();
            if (!silent) toast(`Failed to generate master testbed: ${err.detail || 'Unknown error'}`, 'error');
            throw new Error(err.detail || 'Failed to generate testbed');
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host_id: parseInt(vmId), script_path: scriptPath }),
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

    // Filter: Only show VM, Switch, and Router (exclude DUT devices)
    const vsHostDevices = dutsData.filter(d =>
        d.device_type === 'VM' || d.device_type === 'Switch' || d.device_type === 'Router'
    );

    vsHostDevices.forEach(d => {
        const option = document.createElement('option');
        option.value = d.id;

        // Status indicator (colored dot)
        const statusColor = d.status === 'online' ? '#10b981' :
                           d.status === 'offline' ? '#ef4444' : '#f59e0b';
        const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};margin-right:6px;vertical-align:middle"></span>`;

        // Show status text for non-online devices
        const statusText = d.status !== 'online' ? ` [${d.status || 'unknown'}]` : '';

        option.innerHTML = `${statusDot}${esc(d.name)} (${esc(d.ip_address)})${statusText}`;
        option.selected = d.id == current;

        // Disable devices that are not online
        if (d.status !== 'online') {
            option.disabled = true;
            option.style.color = '#6b7280';
        }

        sel.appendChild(option);
    });
}

function renderVSSourceServerList() {
    const sel = document.getElementById('vs-source-server');
    if (!sel) return; // Element may not exist on all pages
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Use Host Device (Local Copy) --</option>';

    // Show all devices (VM, Switch, Router, DUT) as potential source servers
    dutsData.forEach(d => {
        const option = document.createElement('option');
        option.value = d.id;

        // Status indicator (colored dot)
        const statusColor = d.status === 'online' ? '#10b981' :
                           d.status === 'offline' ? '#ef4444' : '#f59e0b';
        const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};margin-right:6px;vertical-align:middle"></span>`;

        // Show status text for non-online devices
        const statusText = d.status !== 'online' ? ` [${d.status || 'unknown'}]` : '';

        option.innerHTML = `${statusDot}${esc(d.name)} (${esc(d.ip_address)})${statusText}`;
        option.selected = d.id == current;

        // Disable devices that are not online
        if (d.status !== 'online') {
            option.disabled = true;
            option.style.color = '#6b7280';
        }

        sel.appendChild(option);
    });
}

function onVSHostChange() {
    const dutId = document.getElementById('vs-host').value;
    selectedVSNames.clear();
    updateVSSelectionSummary();
    if (!dutId) {
        document.getElementById('vs-vm-list').innerHTML = '<p class="muted" style="padding:16px;text-align:center">Select a host device to see VMs</p>';
        return;
    }
    loadVSList(dutId);
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
                    <th>Target Image Name</th>
                    <th style="width:60px">Action</th>
                </tr>
            </thead>
            <tbody>`;

        data.vms.forEach(vm => {
            const isRunning = vm.state.includes('running');
            const stateClass = isRunning ? 'online' : (vm.state.includes('shut') ? 'offline' : 'pending');
            const checked = selectedVSNames.has(vm.name) ? 'checked' : '';
            // Auto-generate target: sp-Sonic-102 → Dlink-sonic-vs2.img
            const numMatch = vm.name.match(/(\d+)\s*$/);
            const vsNum = numMatch ? numMatch[1].replace(/^10/, (m) => m === '10' ? '10' : m).replace(/^0+/, '') : '';
            // Extract trailing number: sp-Sonic-101 → 1, sp-Sonic-110 → 10
            const rawNum = numMatch ? parseInt(numMatch[1], 10) % 100 : 0;
            const defaultTarget = rawNum > 0 ? `Dlink-sonic-vs${rawNum}.img` : `${vm.name}.img`;

            html += `<tr class="vs-vm-row ${selectedVSNames.has(vm.name) ? 'selected' : ''}" data-vm="${esc(vm.name)}">
                <td>
                    <input type="checkbox" class="vs-cb" value="${esc(vm.name)}" ${checked}
                        onchange="toggleVSSelect('${esc(vm.name)}', this)">
                </td>
                <td>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="material-icons-round" style="font-size:18px;color:var(--${isRunning ? 'green' : 'text-muted'})">${isRunning ? 'play_circle' : 'stop_circle'}</span>
                        <span style="font-weight:600;font-size:0.9rem">${esc(vm.name)}</span>
                    </div>
                </td>
                <td><span class="badge ${stateClass}" style="white-space:nowrap">${esc(vm.state)}</span></td>
                <td>
                    <input type="text" class="vs-target-input" data-vm="${esc(vm.name)}"
                        value="${esc(defaultTarget)}"
                        placeholder="${esc(defaultTarget)}"
                        style="width:100%;padding:5px 8px;font-size:0.82rem;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:var(--mono)">
                </td>
                <td>
                    ${isRunning
                    ? `<button class="btn outline small" onclick="vsQuickAction('${esc(vm.name)}','destroy')" title="Destroy" style="color:var(--red);padding:5px 8px"><span class="material-icons-round" style="font-size:16px">stop</span></button>`
                    : `<button class="btn outline small" onclick="vsQuickAction('${esc(vm.name)}','start')" title="Start" style="color:var(--green);padding:5px 8px"><span class="material-icons-round" style="font-size:16px">play_arrow</span></button>`
                }
                </td>
            </tr>`;
        });

        html += `</tbody></table>`;
        el.innerHTML = html;
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
    const n = selectedVSNames.size;
    if (countEl) countEl.textContent = n > 0 ? `${n} selected` : '';
    if (btn) btn.disabled = n === 0;
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

    // For destroy action, require VS name confirmation
    if (action === 'destroy') {
        const confirmed = await showVSDestroyConfirmation(vmName);
        if (!confirmed) return;
    } else {
        if (!confirm(`${action.toUpperCase()} VM "${vmName}"?`)) return;
    }

    toast(`Executing ${action} on ${vmName}...`, 'info');
    try {
        const res = await fetch(`${API}/api/vs/${dutId}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vs_name: vmName, action: action }),
        });
        const data = await res.json();
        if (data.status === 'success') {
            toast(`${action} on '${vmName}' — ${data.message}`, 'success');
        } else {
            toast(`${action} on '${vmName}' failed: ${data.message}`, 'error');
        }
        // Refresh VM list after a short delay
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

    // Build per-VM list: read target image from each row's input
    const vsEntries = [];
    selectedVSNames.forEach(vmName => {
        const input = document.querySelector(`.vs-target-input[data-vm="${vmName}"]`);
        const targetImage = input ? input.value.trim() : `${vmName}.img`;
        vsEntries.push({ vs_name: vmName, target_image_name: targetImage || `${vmName}.img` });
    });

    console.log('[VS] vsEntries:', vsEntries);

    // Show inline confirmation in log area instead of browser confirm()
    const logEl = document.getElementById('vs-log-container');
    const vmRows = vsEntries.map(e =>
        `<div style="padding:3px 0;font-family:var(--mono);font-size:0.82rem">• <b>${esc(e.vs_name)}</b> → ${esc(e.target_image_name)}</div>`
    ).join('');

    // Get source server name for display
    const sourceServerName = sourceServerId ? (dutsData.find(d => d.id == sourceServerId)?.name || 'Unknown') : 'Host Device (Local)';
    const copyMethod = sourceServerId ? '(Direct SCP Copy)' : '(Local Copy)';

    logEl.innerHTML = `<div style="padding:16px">
        <div style="font-weight:600;margin-bottom:8px">⚠ Confirm batch update for ${vsEntries.length} VM(s):</div>
        ${vmRows}
        <div style="margin-top:8px;font-size:0.82rem;color:var(--text-secondary)">Source Server: ${esc(sourceServerName)} ${copyMethod}</div>
        <div style="font-size:0.82rem;color:var(--text-secondary)">Source Path: ${esc(sourceImage)}</div>
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
    const progress = document.getElementById('vs-progress');
    progress.style.display = '';
    // Initialize all steps to pending, reset any previous states
    progress.querySelectorAll('.vs-step').forEach(s => {
        s.classList.remove('active', 'done', 'error', 'pending');
        s.classList.add('pending');
    });
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
            console.log(`[VS Update] Moving to next VM...`);

        } catch (e) {
            console.error(`[VS Update] Error updating ${entry.vs_name}:`, e);
            toast(`${vmLabel}: FAILED — ${e.message}`, 'error');
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
    btn.innerHTML = '<span class="material-icons-round">rocket_launch</span> Update Image & Restart VMs';

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
            const res = await fetch(`${API}/api/executions/${execId}`);
            if (!res.ok) {
                console.warn(`[waitForExecution] API returned ${res.status} for exec ${execId}`);
                continue;
            }
            const exec = await res.json();
            console.log(`[waitForExecution] Exec ${execId} status:`, exec.status);

            // Also fetch logs for display
            const logsRes = await fetch(`${API}/api/executions/${execId}/logs?limit=200`);
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
        const ws = new WebSocket(`${proto}//${location.host}/ws/execution/${execId}`);
        const timeout = setTimeout(() => {
            console.error(`[waitForVSCompletion] Timeout after 10 minutes for exec ${execId}`);
            ws.close();
            reject(new Error('Update timed out after 10 minutes'));
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

                if (data.status === 'completed') {
                    resolve();
                } else {
                    reject(new Error(`Update failed with status: ${data.status}`));
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
            // If closed without resolving, fall back to polling
            if (timeout) {
                console.log(`[waitForVSCompletion] Falling back to polling for exec ${execId}`);
                pollForCompletion(execId, label, timeout, resolve, reject);
            }
        };
    });
}

// Fallback polling if WebSocket fails
async function pollForCompletion(execId, label, timeout, resolve, reject) {
    const pollInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API}/api/executions/${execId}`);
            if (res.ok) {
                const exec = await res.json();
                console.log(`[pollForCompletion] Exec ${execId} status: ${exec.status}`);

                if (exec.status === 'completed') {
                    clearInterval(pollInterval);
                    clearTimeout(timeout);
                    console.log(`[pollForCompletion] ✓ Exec ${execId} completed`);
                    resolve();
                } else if (exec.status === 'failed') {
                    clearInterval(pollInterval);
                    clearTimeout(timeout);
                    console.log(`[pollForCompletion] ✗ Exec ${execId} failed`);
                    reject(new Error('Update failed'));
                }
            }
        } catch (e) {
            console.error(`[pollForCompletion] Error polling exec ${execId}:`, e);
        }
    }, 3000); // Poll every 3 seconds
}

function appendVSLogEntry(log) {
    const el = document.getElementById('vs-log-container');
    if (el.querySelector('.log-placeholder')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', logHTML(log));
    el.scrollTop = el.scrollHeight;
}

function updateVSProgress(log) {
    const msg = (log.message || '').trim();

    // Debug: Log all messages to console for debugging
    console.log('[VS Progress] Message:', msg);

    // Map backend steps to UI steps (keep only 4)
    // Step 1/6 → UI Step 1 (Destroy VM)
    // Step 2/6 → UI Step 2 (Remove Old Image)
    // Step 3/6 → UI Step 3 (Copy New Image)
    // Step 6/6 → UI Step 4 (Start VM)
    const stepMap = {
        'Step 1/6': '1',
        'Step 2/6': '2',
        'Step 3/6': '3',
        'Step 6/6': '4',
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
let currentHWJobId = null;
let hwWebSocket = null;
let hwAutoScroll = true;

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

        // Filter for telnet devices only
        const telnetDevices = devices.filter(d => d.connection_type === 'telnet');

        const deviceSelect = document.getElementById('hwDeviceSelect');
        if (!deviceSelect) {
            console.warn('Hardware Load tab elements not found. Tab may not be loaded yet.');
            return;
        }

        deviceSelect.innerHTML = '<option value="">-- Select Device --</option>';

        telnetDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `${device.name} (${device.ip_address}:${device.port})`;
            deviceSelect.appendChild(option);
        });

        // Load all devices for source server dropdown (SSH/Telnet)
        const serverSelect = document.getElementById('hwSourceServer');
        if (!serverSelect) {
            console.warn('Hardware Load server select not found.');
            return;
        }

        serverSelect.innerHTML = '<option value="">-- Select Server --</option>';

        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `${device.name} (${device.ip_address})`;
            option.dataset.password = device.password || '';
            option.dataset.username = device.username || 'admin';
            option.dataset.ip = device.ip_address;
            serverSelect.appendChild(option);
        });

    } catch (error) {
        console.error('Error loading hardware devices:', error);
        const errorMsg = error.message || error.toString() || 'Failed to load devices';
        toast(errorMsg, 'error');
    }
}

/**
 * Update source server details when server is selected
 * Password is auto-filled from device credentials (hidden field)
 */
function updateSourceServerDetails() {
    const serverSelect = document.getElementById('hwSourceServer');
    const selectedOption = serverSelect.options[serverSelect.selectedIndex];
    const passwordField = document.getElementById('hwServerPassword');

    if (selectedOption && selectedOption.dataset.password) {
        passwordField.value = selectedOption.dataset.password;
    } else {
        passwordField.value = '';
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

    // Validation
    if (!deviceId || !sourceServerId || !imagePath) {
        toast('Please fill all required fields', 'error');
        return;
    }

    // Password is optional - will be fetched from device data if not provided
    if (!serverPassword) {
        console.warn('Server password not auto-filled, will fetch from device data');
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
 * Connect WebSocket for real-time progress updates
 */
function connectHWWebSocket(jobId) {
    // Close existing connection
    if (hwWebSocket) {
        hwWebSocket.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host + '/api/hardware-load/ws/' + jobId;

    hwWebSocket = new WebSocket(wsUrl);

    hwWebSocket.onopen = () => {
        console.log('Hardware load WebSocket connected');
        appendHWLog('[System] Connected to progress stream\n', 'log-success');
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
        appendHWLog('[System] Connection error occurred\n', 'log-error');
    };

    hwWebSocket.onclose = () => {
        console.log('Hardware load WebSocket closed');
        hwWebSocket = null;
    };
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

            // Close WebSocket
            if (hwWebSocket) {
                hwWebSocket.close();
                hwWebSocket = null;
            }

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

        row.innerHTML = '<td>' + job.id + '</td>' +
            '<td>' + esc(job.device_name || ('DUT ' + job.dut_id) || '-') + '</td>' +
            '<td title="' + esc(job.image_path || '') + '">' + esc(job.image_name || job.image_path || '-') + '</td>' +
            '<td><span class="status-badge ' + (job.status || '') + '">' + formatStatusText(job.status || '') + '</span></td>' +
            '<td>' + (job.progress_percentage != null ? job.progress_percentage : 0) + '%</td>' +
            '<td>' + (job.started_at ? formatDateTime(job.started_at) : '-') + '</td>' +
            '<td>' + duration + '</td>' +
            '<td>' +
                '<button class="btn-icon" onclick="viewHWJobDetails(' + job.id + ')" title="View Details">' +
                    '<span class="material-icons-round">visibility</span>' +
                '</button>' +
                (job.status === 'failed' ?
                    '<button class="btn-icon" onclick="retryHWJob(' + job.id + ')" title="Retry">' +
                        '<span class="material-icons-round">refresh</span>' +
                    '</button>'
                : '') +
            '</td>';

        tbody.appendChild(row);
    });
}

/**
 * View job details in modal
 */
async function viewHWJobDetails(jobId) {
    try {
        const response = await fetch('/api/hardware-load/job/' + jobId, {
            headers: { 'X-Session-ID': getSessionId() }
        });

        if (!response.ok) throw new Error('Failed to load job details');

        const job = await response.json();

        // Show in modal (reuse existing modal or create custom one)
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');

        const deviceLabel = job.device_name || ('DUT ' + job.dut_id) || 'Unknown Device';
        modalTitle.textContent = 'Job #' + job.id + ' - ' + deviceLabel;
        modalBody.innerHTML = '<div style="margin-bottom: 20px;">' +
                '<div style="margin-bottom: 10px;"><strong>Status:</strong> <span class="status-badge ' + (job.status || '') + '">' + formatStatusText(job.status || '') + '</span></div>' +
                '<div style="margin-bottom: 10px;"><strong>Progress:</strong> ' + (job.progress_percentage != null ? job.progress_percentage : 0) + '%</div>' +
                '<div style="margin-bottom: 10px;"><strong>Current Step:</strong> ' + esc(job.current_step || '-') + '</div>' +
                '<div style="margin-bottom: 10px;"><strong>Image:</strong> ' + esc(job.image_path || '-') + '</div>' +
                '<div style="margin-bottom: 10px;"><strong>Started:</strong> ' + (job.started_at ? formatDateTime(job.started_at) : '-') + '</div>' +
                '<div style="margin-bottom: 10px;"><strong>Completed:</strong> ' + (job.completed_at ? formatDateTime(job.completed_at) : 'In progress') + '</div>' +
                (job.error_message ? '<div style="margin-bottom: 10px; color: var(--red);"><strong>Error:</strong> ' + esc(job.error_message) + '</div>' : '') +
            '</div>' +
            '<div class="hw-log-terminal">' +
                '<div class="hw-terminal-header"><span class="material-icons-round">terminal</span> Full Execution Log</div>' +
                '<div class="hw-terminal-output"><pre>' + esc(job.execution_log || 'No logs available') + '</pre></div>' +
            '</div>';

        openModal();

    } catch (error) {
        console.error('Error loading job details:', error);
        toast('Failed to load job details', 'error');
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

        // Close WebSocket
        if (hwWebSocket) {
            hwWebSocket.close();
            hwWebSocket = null;
        }

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
