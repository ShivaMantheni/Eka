import sys
import os
from PIL import Image, ImageDraw

def create_spotlight(image_path, out_path, region, padding=80):
    try:
        img = Image.open(image_path).convert("RGBA")
        x1, y1, x2, y2 = region
        
        # Darken the background
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 200)) # 200/255 opacity
        dark_img = Image.alpha_composite(img, overlay)
        
        # Crop the bright region from original
        bright_region = img.crop((x1, y1, x2, y2))
        
        # Paste the bright region back
        dark_img.paste(bright_region, (x1, y1))
        
        # Add a light border
        draw = ImageDraw.Draw(dark_img)
        draw.rectangle([x1-1, y1-1, x2+1, y2+1], outline="#ffffff", width=3)
        draw.rectangle([x1-3, y1-3, x2+3, y2+3], outline="#8bb0ff", width=2)
        
        # Crop with padding
        px1 = max(0, x1 - padding)
        py1 = max(0, y1 - padding)
        px2 = min(img.width, x2 + padding)
        py2 = min(img.height, y2 + padding)
        
        zoomed_img = dark_img.crop((px1, py1, px2, py2))
        
        # Resize to make it look zoomed in (1.5x scale)
        new_size = (int(zoomed_img.width * 1.5), int(zoomed_img.height * 1.5))
        zoomed_img = zoomed_img.resize(new_size, Image.Resampling.LANCZOS)
        
        zoomed_img.convert("RGB").save(out_path)
    except Exception as e:
        print(f"Error processing {image_path}: {e}")

regions = {
    # format: 'out_name': ('base_image', (x1, y1, x2, y2), padding)
    'devices_1': ('screenshot_devices.png', (290, 115, 990, 275), 50),
    'devices_2': ('screenshot_devices.png', (290, 280, 990, 500), 50),
    
    'execute_1': ('screenshot_execute.png', (290, 160, 990, 230), 40),
    'execute_2': ('screenshot_execute.png', (300, 230, 550, 480), 40),
    'execute_3': ('screenshot_execute.png', (560, 230, 770, 480), 40),
    'execute_4': ('screenshot_execute.png', (780, 230, 1000, 480), 40),
    
    'vs_1': ('screenshot_vs.png', (290, 160, 620, 450), 50),
    'vs_2': ('screenshot_vs.png', (630, 160, 990, 480), 50),
    
    'dashboard_1': ('screenshot_dashboard.png', (290, 90, 990, 200), 60),
    
    'logs_1': ('screenshot_logs.png', (290, 160, 990, 400), 60),
    
    'term_1': ('screenshot_terminal.png', (290, 160, 990, 220), 50),
    'term_2': ('screenshot_terminal.png', (290, 230, 990, 500), 50)
}

for out_name, (base_img, coords, pad) in regions.items():
    if not os.path.exists(base_img):
        print(f"Warning: {base_img} not found.")
        continue
    out_file = f"spotlight_{out_name}.png"
    create_spotlight(base_img, out_file, coords, pad)
    print(f"Created {out_file}")

print("Spotlight generation complete!")
