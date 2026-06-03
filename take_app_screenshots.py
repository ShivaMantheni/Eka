import os
import time
from playwright.sync_api import sync_playwright

def take_screenshots():
    print("Initializing Playwright screenshot capture...")
    screenshots = {}
    
    with sync_playwright() as p:
        # Launch Chromium headless
        browser = p.chromium.launch(headless=True)
        # Create context with 3x high-res Retina scale factor for crisp text and line quality
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            device_scale_factor=3.0
        )
        page = context.new_page()
        
        # Navigate to Eka server
        url = "http://localhost:8000/"
        print(f"Navigating to Eka server at {url}...")
        page.goto(url)
        
        # Force Playwright browser to use the database session
        session_id = 'eka-1779703928606-16auizk8w'
        user_name = 'User_May_25__15_42'
        print(f"Setting session ID '{session_id}' in localStorage...")
        page.evaluate(f"localStorage.setItem('eka-session-id', '{session_id}')")
        page.evaluate(f"localStorage.setItem('eka-user-name', '{user_name}')")
        page.reload()
        
        # Wait for page reload and session validation
        print("Waiting for page reload and session validation...")
        time.sleep(3) 
        
        # List of tabs to navigate to
        tabs = {
            'dashboard': 'dashboard',
            'devices': 'devices',
            'execute': 'execute',
            'vs': 'vs',
            'logs': 'logs',
            'terminal': 'terminal',
            'hardware-load': 'hardware_load'
        }
        
        for tab_id, file_suffix in tabs.items():
            print(f"Switching to tab: '{tab_id}'...")
            try:
                try:
                    page.evaluate(f"switchTab('{tab_id}')")
                except Exception as eval_err:
                    print(f"  Warning: Page.evaluate switchTab failed for '{tab_id}': {eval_err}")
                
                time.sleep(1)
                
                # Custom UI enhancements per tab for realistic and populated screenshots
                if tab_id == 'dashboard':
                    print("  Populating dashboard stats...")
                    page.evaluate("""() => {
                        const totalDuts = document.getElementById('dash-total-duts');
                        const onlineDuts = document.getElementById('dash-online-duts');
                        const totalScripts = document.getElementById('dash-scripts');
                        const totalExecutions = document.getElementById('dash-executions');
                        if (totalDuts) totalDuts.innerText = '16';
                        if (onlineDuts) onlineDuts.innerText = '12';
                        if (totalScripts) totalScripts.innerText = '48';
                        if (totalExecutions) totalExecutions.innerText = '256';
                        
                        // Set first execution to show success BGP test run
                        const execRows = document.querySelectorAll('#dash-recent-executions tr');
                        if (execRows && execRows.length > 0) {
                            execRows[0].innerHTML = `
                                <td>#154</td>
                                <td>test_bgp_route_advertise.py</td>
                                <td><span class="status-badge success">COMPLETED</span></td>
                                <td>2m 14s</td>
                                <td>Just now</td>
                            `;
                        }
                    }""")
                    time.sleep(0.5)

                elif tab_id == 'execute':
                    print("  Setting up topology canvas and selecting scripts...")
                    page.evaluate("""async () => {
                        // 1. Select the mock VM Host
                        const vmSelect = document.getElementById('spy-vm-select');
                        if (vmSelect) {
                            vmSelect.value = "5";
                            // Trigger VM selection change and wait for it
                            await onSpyVMChange();
                        }
                    }""")
                    time.sleep(1.0)
                    
                    page.evaluate("""async () => {
                        // Navigate to routing/bgp folder
                        await navigateToPath('routing/bgp');
                    }""")
                    time.sleep(1.0)
                    
                    page.evaluate("""() => {
                        // 2. Select the BGP script
                        selectedScriptPaths.add('routing/bgp/test_bgp_route_advertise.py');
                        
                        // 3. Select DUTs for topology
                        selectedDUTIds.add(1);
                        selectedDUTIds.add(3);
                        
                        // 4. Force UI refresh
                        renderDUTChecklist();
                        renderTopologyCanvas();
                        renderScriptsDropdown();
                        updateScriptMultiSelectText();
                    }""")
                    time.sleep(1.0)

                elif tab_id == 'terminal':
                    print("  Simulating active SSH terminal session...")
                    page.evaluate("""() => {
                        // Select Server in dropdown
                        const termSelect = document.getElementById('term-dut');
                        if (termSelect) termSelect.value = "1";
                        
                        // Inject simulated SONiC bash outputs
                        const termContainer = document.getElementById('term-container');
                        if (termContainer) {
                            termContainer.innerHTML = `
                                <div style="font-family: 'Courier New', monospace; color: #a6e22e; font-size: 14px; line-height: 1.6; padding: 18px; background: #0c1017; height: 100%; border-radius: 4px; box-sizing: border-box; text-align: left; overflow: hidden; border: 1px solid #1a2f4c;">
                                    <span style="color: #66d9ef;">admin@Eka-Control-Server:~$</span> ssh admin@192.168.100.175<br>
                                    admin@192.168.100.175's password: *******<br><br>
                                    <span style="color: #00ffff; font-weight: bold;">Welcome to SONiC on Server (192.168.100.175)</span><br>
                                    Software Version: SONiC.Community.202305.0-dirty<br>
                                    Distribution: Debian 11.7 (bullseye)<br>
                                    Kernel: 5.10.0-8-amd64<br><br>
                                    admin@Server:~$ show version<br>
                                    SONiC Software Version: SONiC.Community.202305.0-dirty<br>
                                    OS Version: 11.7 (bullseye)<br>
                                    Kernel: 5.10.0-8-amd64<br>
                                    Build commit: 8e7fd6a3a<br>
                                    Build date: Mon May 25 15:42:00 UTC 2026<br><br>
                                    admin@Server:~$ show interfaces status<br>
                                    Interface    Lanes    Speed    MTU    Alias    Vlan    Oper    Admin<br>
                                    -----------  -------  -------  -----  -------  ------  ------  -------<br>
                                    Ethernet0    1        10G      9100   et0      routed  up      up     <br>
                                    Ethernet4    2        10G      9100   et1      routed  up      up     <br>
                                    Ethernet8    3        10G      9100   et2      routed  up      up     <br>
                                    Ethernet12   4        10G      9100   et3      routed  down    up     <br><br>
                                    <span style="color: #66d9ef;">admin@Server:~$</span> <span class="blink" style="animation: blink-animation 1s steps(5, start) infinite; background: #00ffff; color: #000; padding: 0 4px;"> </span>
                                    <style>
                                        @keyframes blink-animation {
                                            to { visibility: hidden; }
                                        }
                                    </style>
                                </div>
                            `;
                        }
                    }""")
                    time.sleep(1.0)
                
                # Take crisp 3x retina screenshot
                filepath = f"screenshot_{file_suffix}.png"
                page.screenshot(path=filepath)
                print(f"[OK] Captured screenshot: {filepath}")
                screenshots[tab_id] = filepath
            except Exception as e:
                print(f"[Error] Error capturing tab '{tab_id}': {e}")
                
        browser.close()
    
    print("Screenshot capture sequence complete!")
    return screenshots

if __name__ == "__main__":
    take_screenshots()
