
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
        const response = await fetch('/api/duts', {
            headers: { 'X-Session-ID': getSessionId() }
        });

        if (!response.ok) throw new Error('Failed to load devices');

        const devices = await response.json();

        // Filter for telnet devices only
        const telnetDevices = devices.filter(d => d.connection_type === 'telnet');

        const deviceSelect = document.getElementById('hwDeviceSelect');
        deviceSelect.innerHTML = '<option value="">-- Select Device --</option>';

        telnetDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.id;
            option.textContent = `${device.name} (${device.ip_address}:${device.port})`;
            deviceSelect.appendChild(option);
        });

        // Load all devices for source server dropdown (SSH/Telnet)
        const serverSelect = document.getElementById('hwSourceServer');
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
        showToast('Failed to load devices', 'error');
    }
}

/**
 * Update source server details when server is selected
 */
function updateSourceServerDetails() {
    const serverSelect = document.getElementById('hwSourceServer');
    const selectedOption = serverSelect.options[serverSelect.selectedIndex];

    // Auto-fill username and IP from the selected server DUT record.
    // DO NOT auto-fill the password — the SCP server password is the
    // Linux account password (e.g. hp_test's password on 192.168.100.175)
    // which is DIFFERENT from the device's telnet login password.
    // The user must always type it explicitly.
    const pwdField = document.getElementById('hwServerPassword');
    if (pwdField) {
        pwdField.value = '';          // clear on server change
        pwdField.focus();             // guide user to fill it
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
    if (!deviceId || !sourceServerId || !imagePath || !serverPassword) {
        showToast('Please fill all required fields including Server Password', 'error');
        if (!serverPassword) {
            document.getElementById('hwServerPassword').focus();
        }
        return;
    }

    // Validate IP format
    const ipRegex = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
    if (!ipRegex.test(gatewayIP) || !ipRegex.test(subnetMask)) {
        showToast('Invalid IP address or subnet mask format', 'error');
        return;
    }

    // Get source server details
    const serverSelect = document.getElementById('hwSourceServer');
    const selectedOption = serverSelect.options[serverSelect.selectedIndex];
    const serverIP = selectedOption.dataset.ip;
    const serverUsername = selectedOption.dataset.username || 'admin';

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
            const error = await response.json();
            throw new Error(error.detail || 'Failed to start hardware load');
        }

        const result = await response.json();
        currentHWJobId = result.job_id;

        // Show progress container
        document.getElementById('hwProgressContainer').style.display = 'block';
        document.getElementById('hwCompletionMessage').style.display = 'none';

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

        showToast('Hardware load started successfully', 'success');

    } catch (error) {
        console.error('Error starting hardware load:', error);
        showToast(error.message, 'error');
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
                : 'Hardware load failed: ' + data.error_message;

            completionDiv.innerHTML = '<span class="material-icons-round">' + icon + '</span>' + message;

            // Update progress bar
            document.getElementById('hwProgressFill').style.width = isSuccess ? '100%' : document.getElementById('hwProgressFill').style.width;
            document.getElementById('hwProgressPercent').textContent = isSuccess ? '100%' : 'Failed';

            // Stop pulsing animation
            const stepIcon = document.querySelector('.hw-current-step .hw-step-icon');
            if (stepIcon) stepIcon.style.animation = 'none';

            // Close WebSocket
            if (hwWebSocket) {
                hwWebSocket.close();
                hwWebSocket = null;
            }

            // Refresh history
            refreshHWHistory();

            // Notification
            showToast(message, isSuccess ? 'success' : 'error');
            break;

        case 'error':
            appendHWLog('[System Error] ' + data.message + '\n', 'log-error');
            showToast('WebSocket error: ' + data.message, 'error');
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
        'failed': 'Failed'
    };

    return statusMap[status] || status;
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
        showToast('Failed to load job history', 'error');
    }
}

/**
 * Render job history table
 */
function renderHWHistoryTable(jobs) {
    const tbody = document.getElementById('hwHistoryTable');
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
            '<td>' + esc(job.device_name) + '</td>' +
            '<td title="' + esc(job.image_path) + '">' + esc(job.image_name) + '</td>' +
            '<td><span class="status-badge ' + job.status + '">' + formatStatusText(job.status) + '</span></td>' +
            '<td>' + job.progress_percentage + '%</td>' +
            '<td>' + formatDateTime(job.started_at) + '</td>' +
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

        modalTitle.textContent = 'Job #' + job.job_id + ' - ' + job.device_name;
        modalBody.innerHTML = '<div style="margin-bottom: 20px;">' +
                '<div style="margin-bottom: 10px;"><strong>Status:</strong> <span class="status-badge ' + job.status + '">' + formatStatusText(job.status) + '</span></div>' +
                '<div style="margin-bottom: 10px;"><strong>Progress:</strong> ' + job.progress_percentage + '%</div>' +
                '<div style="margin-bottom: 10px;"><strong>Current Step:</strong> ' + (job.current_step || '-') + '</div>' +
                '<div style="margin-bottom: 10px;"><strong>Image:</strong> ' + esc(job.image_path) + '</div>' +
                '<div style="margin-bottom: 10px;"><strong>Started:</strong> ' + formatDateTime(job.started_at) + '</div>' +
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
        showToast('Failed to load job details', 'error');
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

        showToast('Form pre-filled with previous job settings', 'info');

    } catch (error) {
        console.error('Error loading job for retry:', error);
        showToast('Failed to load job details', 'error');
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
    document.getElementById('hwSubnetMask').value = '255.255.255.0';
}

/**
 * Format datetime for display
 */
function formatDateTime(dateString) {
    if (!dateString) return '-';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return diffMins + ' min ago';

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return diffHours + ' hour' + (diffHours > 1 ? 's' : '') + ' ago';

    return date.toLocaleString();
}
