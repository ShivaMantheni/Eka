import sys
import subprocess

def install_pkg(pkg):
    subprocess.check_call([sys.executable, "-m", "pip", "install", pkg])

try:
    from PIL import Image, ImageDraw
except ImportError:
    install_pkg("Pillow")
    from PIL import Image, ImageDraw

def highlight_region(image_path, out_path, regions):
    """
    Regions is a list of tuples: (x1, y1, x2, y2, color, thickness)
    """
    try:
        img = Image.open(image_path)
        draw = ImageDraw.Draw(img)
        
        for region in regions:
            x1, y1, x2, y2, color, thickness = region
            
            # Draw semi-transparent overlay outside the region to highlight it?
            # Or just draw a thick bounding box:
            draw.rectangle([x1, y1, x2, y2], outline=color, width=thickness)
            
        img.save(out_path)
    except Exception as e:
        print(f"Error processing {image_path}: {e}")

# Device Tab highlights
# Coordinates need to be estimated based on a 1280x800 resolution viewport
# Form input area: Top portion
# Table area: Bottom portion
device_regions = [
    # (x1, y1, x2, y2, color, thickness)
    # Highlight "Add New Device" form
    (310, 150, 970, 260, 'red', 4),  
    # Highlight Table actions (Wifi/Trash)
    (880, 390, 950, 480, 'red', 4)
]
highlight_region("screenshot_devices.png", "screenshot_devices_hl.png", device_regions)

# Execution Tab highlights
# VM Selection & Git
# Topology Canvas
# Categories & Scripts
# Testbed YAML
execute_regions = [
    # VM Host
    (300, 160, 520, 230, 'red', 4),
    # Topology Canvas
    (305, 255, 600, 450, 'orange', 4),
    # Scripts Column
    (615, 255, 785, 450, 'yellow', 4),
    # Target Target  
    (800, 255, 965, 450, 'green', 4)
]
highlight_region("screenshot_execute.png", "screenshot_execute_hl.png", execute_regions)

# VS Manager Tab highlights
vs_regions = [
    # Host selection left
    (300, 160, 620, 250, 'red', 4),
    # Form input right
    (640, 160, 970, 250, 'blue', 4)
]
highlight_region("screenshot_vs.png", "screenshot_vs_hl.png", vs_regions)

# Dashboard
dash_regions = [
    # Top stats
    (300, 90, 970, 180, 'red', 4)
]
highlight_region("screenshot_dashboard.png", "screenshot_dashboard_hl.png", dash_regions)

# Logs
logs_regions = [
    # Table bounds
    (300, 160, 970, 400, 'red', 4)
]
highlight_region("screenshot_logs.png", "screenshot_logs_hl.png", logs_regions)

# Terminal
term_regions = [
    # Input area
    (300, 160, 970, 210, 'red', 4),
    # Terminal display
    (300, 230, 970, 500, 'blue', 4)
]
highlight_region("screenshot_terminal.png", "screenshot_terminal_hl.png", term_regions)

print("Highlights generated!")
