/* ============================================================
   Eka Automation — Frontend Application Logic
   ============================================================ */

const API = window.location.origin;
let currentExecId = null;
let ws = null;
let selectedDUTs = new Set();
let allLogs = [];           // [{dut_name, script_name, level, message, timestamp}]
let _queuePollTimer = null; // setInterval handle for queue status polling

// Per-DUT interface cache: {dutId: [{name, speed, mtu, fec, alias, oper, admin}, ...]}
// Populated when user clicks the wifi/ping button. Falls back to SONIC_PORTS if empty.
let dutInterfaces = {};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    // Restore saved theme before anything renders
    const savedTheme = localStorage.getItem('eka-theme') || 'dark';
    setTheme(savedTheme, true);

    checkHealth();
    loadStats();
    loadDUTs();
    loadExecutions();
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
// HEALTH & STATS
// ============================================================

async function checkHealth() {
    try {
        const res = await fetch(`${API}/health`);
        const dot = document.getElementById('health-dot');
        dot.classList.toggle('healthy', res.ok);
    } catch { document.getElementById('health-dot').classList.remove('healthy'); }
}

async function loadStats() {
    try {
        const res = await fetch(`${API}/api/stats`);
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
    if (tab === 'execute') {
        loadDUTs();
        updateSpyStartBtn();
        renderTopologyCanvas();
        loadTopologyConnectionsFromServer();
        loadDUTLockStatus();
    }
    if (tab === 'devices') loadDUTs();
    if (tab === 'logs') loadExecutions();
    if (tab === 'terminal') renderTermDUTList();
    if (tab === 'vs') renderVSHostList();
}

// ============================================================
// DUT MANAGEMENT
// ============================================================

let dutsData = [];

async function loadDUTs() {
    try {
        const res = await fetch(`${API}/api/duts`);
        if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.statusText}`);
        dutsData = await res.json();
        renderDUTsTable();
        renderDUTChecklist();   // was renderExecDUTList (undefined)
        renderTermDUTList();
        renderDashDevices();
        renderSpyVMs();
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
            <td><strong>${esc(d.name)}</strong></td>
            <td style="font-family:var(--mono)">${esc(d.ip_address)}</td>
            <td>${d.port}</td>
            <td>${esc(d.device_type || '-')}</td>
            <td><span class="badge ${d.status}">${d.status}</span></td>
            <td>
                <button class="btn outline small" onclick="pingDUT(${d.id})" title="Test Connectivity"><span class="material-icons-round" style="font-size:16px">wifi_find</span></button>
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
        html += vms.map(d => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
                <div><strong>${esc(d.name)}</strong> <span class="muted" style="font-family:var(--mono);margin-left:8px">${esc(d.ip_address)}</span></div>
                <span class="badge ${d.status}">${d.status}</span>
            </div>`).join('');
    }

    if (duts.length) {
        html += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text-secondary);margin-top:${vms.length ? '12px' : '0'};margin-bottom:4px">🔧 DUTs</div>`;
        html += duts.map(d => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
                <div><strong>${esc(d.name)}</strong> <span class="muted" style="font-family:var(--mono);margin-left:8px">${esc(d.ip_address)}</span></div>
                <span class="badge ${d.status}">${d.status}</span>
            </div>`).join('');
    }

    el.innerHTML = html;
}

async function addDUT(e) {
    e.preventDefault();
    const data = {
        name: document.getElementById('dut-name').value,
        ip_address: document.getElementById('dut-ip').value,
        port: parseInt(document.getElementById('dut-port').value) || 22,
        username: document.getElementById('dut-user').value || 'admin',
        password: document.getElementById('dut-pass').value || '',
        device_type: document.getElementById('dut-type').value,
    };
    try {
        const res = await fetch(`${API}/api/duts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error((await res.json()).detail);
        toast(`Device "${data.name}" added successfully`, 'success');
        document.getElementById('add-dut-form').reset();
        document.getElementById('dut-port').value = '22';
        document.getElementById('dut-user').value = 'admin';
        loadDUTs();
        loadStats();
    } catch (e) { toast(`Failed to add device: ${e.message}`, 'error'); }
}

async function deleteDUT(id) {
    if (!confirm('Delete this device?')) return;
    try {
        const res = await fetch(`${API}/api/duts/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed');
        toast('Device deleted', 'success');
        selectedDUTs.delete(id);
        loadDUTs(); loadStats();
    } catch (e) { toast('Failed to delete device', 'error'); }
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

    try {
        const res = await fetch(`${API}/api/duts/${dutId}/interfaces`);
        const data = await res.json();
        if (res.ok && data.interfaces && data.interfaces.length > 0) {
            dutInterfaces[dutId] = data.interfaces;
            toast(`${dut?.name || 'DUT'} ONLINE ✓ — ${data.count} interfaces found`, 'success');
            renderDUTsTable();
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
    const hasTestbed = document.getElementById('spy-testbed')?.value;
    btn.disabled = !hasVM || !hasScripts || !hasTestbed;
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

async function startExecution() {
    const vmId = parseInt(document.getElementById('spy-vm-select').value);
    const scriptPaths = Array.from(selectedScriptPaths);
    const testbedFile = document.getElementById('spy-testbed')?.value || '';
    const logLevel = document.getElementById('spy-log-level')?.value || 'info';
    const skipInit = document.getElementById('spy-skip-init')?.checked || false;
    const allocInfoEl = document.getElementById('exec-allocation-info');

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
                        headers: { 'Content-Type': 'application/json' },
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
        };
    }

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        const dlBtn = document.getElementById('btn-download-logs');
        if (dlBtn) dlBtn.style.display = '';
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
            stopQueuePolling();
            // Update queue badge to completed/failed
            const badge = document.getElementById('queue-exec-badge');
            if (badge) {
                badge.className = `badge ${data.status === 'completed' ? 'completed' : 'failed'}`;
                badge.textContent = data.status;
            }
            loadStats();
            loadExecutions();
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

    if (!logStreams[source]) {
        const safeId = 'log-stream-' + source.replace(/[^a-zA-Z0-9]/g, '_');
        const pane = document.createElement('div');
        pane.className = 'script-log-pane';

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

// ============================================================
// EXECUTION HISTORY
// ============================================================

async function loadExecutions() {
    try {
        const res = await fetch(`${API}/api/executions`);
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

async function viewExecLogs(execId) {
    try {
        const res = await fetch(`${API}/api/executions/${execId}/logs?limit=500`);
        const logs = await res.json();
        const card = document.getElementById('log-detail-card');
        card.hidden = false;
        document.getElementById('log-detail-title').textContent = `#${execId}`;
        const container = document.getElementById('log-detail-container');
        if (!logs.length) { container.innerHTML = '<p class="muted">No logs for this execution.</p>'; return; }
        container.innerHTML = logs.map(logHTML).join('');
        card.scrollIntoView({ behavior: 'smooth' });
    } catch { toast('Failed to load logs', 'error'); }
}

// ============================================================
// TERMINAL
// ============================================================

function renderTermDUTList() {
    const sel = document.getElementById('term-dut');
    const current = sel.value;
    sel.innerHTML = '<option value="">-- Select Device --</option>' +
        dutsData.map(d => `<option value="${d.id}" ${d.id == current ? 'selected' : ''}>${esc(d.name)} (${esc(d.ip_address)})</option>`).join('');
}

async function termExec() {
    const dutId = document.getElementById('term-dut').value;
    const cmd = document.getElementById('term-cmd').value.trim();
    if (!dutId) { toast('Select a device first', 'error'); return; }
    if (!cmd) return;

    const el = document.getElementById('term-output');
    if (el.querySelector('.log-placeholder')) el.innerHTML = '';

    const dut = dutsData.find(d => d.id == dutId);
    el.insertAdjacentHTML('beforeend', `<div class="term-block"><div class="term-prompt">${esc(dut?.name || 'device')}:~$ ${esc(cmd)}</div><div class="term-info">Executing...</div></div>`);
    el.scrollTop = el.scrollHeight;
    document.getElementById('term-cmd').value = '';

    try {
        const res = await fetch(`${API}/api/duts/${dutId}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd }),
        });
        const data = await res.json();
        // Remove "Executing..." message
        const blocks = el.querySelectorAll('.term-block');
        const last = blocks[blocks.length - 1];
        const infoEl = last.querySelector('.term-info');
        if (infoEl) infoEl.remove();

        if (res.ok) {
            if (data.stdout) last.insertAdjacentHTML('beforeend', `<div class="term-output-text">${esc(data.stdout)}</div>`);
            if (data.stderr) last.insertAdjacentHTML('beforeend', `<div class="term-error">${esc(data.stderr)}</div>`);
            if (!data.stdout && !data.stderr) last.insertAdjacentHTML('beforeend', `<div class="term-info">(no output)</div>`);
            if (data.exit_code !== 0) last.insertAdjacentHTML('beforeend', `<div class="term-error">Exit code: ${data.exit_code}</div>`);
        } else {
            last.insertAdjacentHTML('beforeend', `<div class="term-error">Error: ${data.detail || 'Connection failed'}</div>`);
        }
        el.scrollTop = el.scrollHeight;
    } catch (e) {
        const blocks = el.querySelectorAll('.term-block');
        const last = blocks[blocks.length - 1];
        last.innerHTML += `<div class="term-error">Network error: ${e.message}</div>`;
    }
}

// ============================================================
// MODAL
// ============================================================

function openModal(title, bodyHTML) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-overlay').classList.add('active');
}
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
    sel.innerHTML = '<option value="">-- Select Host Device --</option>' +
        dutsData.map(d => `<option value="${d.id}" ${d.id == current ? 'selected' : ''}>${esc(d.name)} (${esc(d.ip_address)})</option>`).join('');
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
                <td><span class="badge ${stateClass}">${esc(vm.state)}</span></td>
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
    if (!confirm(`${action.toUpperCase()} VM "${vmName}"?`)) return;
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

async function startVSUpdate() {
    console.log('[VS] startVSUpdate called. selectedVSNames.size =', selectedVSNames.size);
    const dutId = document.getElementById('vs-host').value;
    const sourceImage = document.getElementById('vs-source-image').value.trim();

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

    logEl.innerHTML = `<div style="padding:16px">
        <div style="font-weight:600;margin-bottom:8px">⚠ Confirm batch update for ${vsEntries.length} VM(s):</div>
        ${vmRows}
        <div style="margin-top:8px;font-size:0.82rem;color:var(--text-secondary)">Source: ${esc(sourceImage)}</div>
        <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn primary" onclick="execVSUpdate()" style="padding:8px 20px">
                <span class="material-icons-round" style="font-size:16px">rocket_launch</span> Confirm & Start Update
            </button>
            <button class="btn outline" onclick="cancelVSUpdate()" style="padding:8px 16px">Cancel</button>
        </div>
    </div>`;

    // Store pending data for execVSUpdate to pick up
    window._vsPendingUpdate = { dutId, vsEntries, sourceImage };
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

    const { dutId, vsEntries, sourceImage } = pending;

    // Reset progress UI
    vsLogs = [];
    const progress = document.getElementById('vs-progress');
    progress.style.display = '';
    progress.querySelectorAll('.vs-step').forEach(s => s.classList.remove('active', 'done', 'error'));
    const logEl = document.getElementById('vs-log-container');
    logEl.innerHTML = `<div class="log-placeholder"><span class="material-icons-round spin">sync</span><p>Starting VS image update for ${vsEntries.length} VM(s)...</p></div>`;

    const btn = document.getElementById('btn-vs-update');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-icons-round spin">sync</span> Updating...';

    // Call the existing working single-VM endpoint for each VM sequentially
    let allOk = true;
    for (let i = 0; i < vsEntries.length; i++) {
        const entry = vsEntries[i];
        const vmLabel = `[${i + 1}/${vsEntries.length}] ${entry.vs_name}`;

        // Update log area
        logEl.innerHTML = `<div class="log-placeholder"><span class="material-icons-round spin">sync</span><p>Updating ${vmLabel}...</p></div>`;

        try {
            const res = await fetch(`${API}/api/vs/update-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dut_id: parseInt(dutId),
                    vs_name: entry.vs_name,
                    source_image_path: sourceImage,
                    target_image_name: entry.target_image_name || '',
                }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || res.statusText);
            }
            const data = await res.json();
            currentVSExecId = data.execution_id;
            toast(`${vmLabel}: update started`, 'success');

            // Wait for this VM's update to complete via polling
            await waitForExecution(data.execution_id, vmLabel, logEl);

        } catch (e) {
            toast(`${vmLabel}: FAILED — ${e.message}`, 'error');
            allOk = false;
            // Continue with next VM even if one fails
        }
    }

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

    while (elapsed < maxWait) {
        await new Promise(r => setTimeout(r, interval * 1000));
        elapsed += interval;

        try {
            const res = await fetch(`${API}/api/executions/${execId}`);
            if (!res.ok) continue;
            const exec = await res.json();

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
                if (exec.status === 'completed') {
                    toast(`${label}: completed successfully (${exec.duration || 0}s)`, 'success');
                } else {
                    toast(`${label}: update failed`, 'error');
                }
                return;
            }
        } catch (e) {
            // Network error, keep polling
        }
    }
    toast(`${label}: timed out after ${maxWait}s`, 'error');
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function connectVSWebSocket(execId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    vsWS = new WebSocket(`${proto}//${location.host}/ws/execution/${execId}`);

    vsWS.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'execution_complete') {
            const btn = document.getElementById('btn-vs-update');
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons-round">rocket_launch</span> Update Image & Restart VMs';
            toast(`VS update ${data.status} (${data.duration || 0}s)`, data.status === 'completed' ? 'success' : 'error');
            // Refresh VM list
            const dutId = document.getElementById('vs-host').value;
            if (dutId) setTimeout(() => loadVSList(dutId), 2000);
            return;
        }

        vsLogs.push(data);
        appendVSLogEntry(data);
        updateVSProgress(data);
    };

    vsWS.onerror = () => toast('VS WebSocket connection error', 'error');
    vsWS.onclose = () => { vsWS = null; };
}

function appendVSLogEntry(log) {
    const el = document.getElementById('vs-log-container');
    if (el.querySelector('.log-placeholder')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', logHTML(log));
    el.scrollTop = el.scrollHeight;
}

function updateVSProgress(log) {
    const msg = log.message || '';
    const stepMap = {
        'Step 1/6': '1', 'Step 2/6': '2', 'Step 3/6': '3',
        'Step 4/6': '4', 'Step 5/6': '5', 'Step 6/6': '6',
    };

    for (const [prefix, stepNum] of Object.entries(stepMap)) {
        if (msg.includes(prefix)) {
            const stepEl = document.querySelector(`.vs-step[data-step="${stepNum}"]`);
            if (!stepEl) continue;

            // Mark previous steps as done
            for (let i = 1; i < parseInt(stepNum); i++) {
                const prev = document.querySelector(`.vs-step[data-step="${i}"]`);
                if (prev && !prev.classList.contains('error')) {
                    prev.classList.remove('active');
                    prev.classList.add('done');
                }
            }

            if (msg.includes('FAILED') || msg.includes('error')) {
                stepEl.classList.remove('active');
                stepEl.classList.add('error');
            } else if (msg.includes('completed successfully') || msg.includes('✓')) {
                stepEl.classList.remove('active');
                stepEl.classList.add('done');
            } else {
                stepEl.classList.add('active');
            }
        }
    }

    // Handle final completion message
    if (msg.includes('VS image update completed')) {
        for (let i = 1; i <= 6; i++) {
            const s = document.querySelector(`.vs-step[data-step="${i}"]`);
            if (s && !s.classList.contains('error')) {
                s.classList.remove('active');
                s.classList.add('done');
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
