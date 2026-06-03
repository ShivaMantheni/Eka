import os
import shutil
import subprocess

brain_dir = r"C:\Users\shivakumar.m\.gemini\antigravity\brain\33577d81-95fc-4273-9507-35ffa9fe86a0"
workspace_dir = r"c:\Users\shivakumar.m\OneDrive - PalC Networks\!Shiva\antigarvity\EKA\Eka-master"

file_map = {
    "graphic_dashboard_1779815666491.png": "mockup_dashboard.png",
    "graphic_devices_1779815686037.png": "mockup_devices.png",
    "graphic_execute_1779815704976.png": "mockup_execute.png",
    "graphic_vs_1779815725603.png": "mockup_vs.png",
    "graphic_logs_1779815745728.png": "mockup_logs.png",
    "graphic_terminal_1779815766125.png": "mockup_terminal.png",
    "graphic_hardware_load_1779815786073.png": "mockup_hardware_load.png"
}

print("Copying generated 3D graphic assets...")
for src_name, dest_name in file_map.items():
    src_path = os.path.join(brain_dir, src_name)
    dest_path = os.path.join(workspace_dir, dest_name)
    if os.path.exists(src_path):
        shutil.copy(src_path, dest_path)
        print(f"[OK] Copied {src_name} -> {dest_name}")
    else:
        print(f"[ERROR] Source file not found: {src_path}")

print("\nTriggering presentation compiler...")
try:
    python_exe = os.path.join(workspace_dir, ".venv", "Scripts", "python.exe")
    result = subprocess.run([python_exe, "generate_presentations_v3.py"], capture_output=True, text=True, check=True)
    print(result.stdout)
    print("Compilation completed successfully!")
except Exception as e:
    print(f"Error compiling: {e}")
    if hasattr(e, 'stderr'):
        print(e.stderr)
