import os
from PIL import Image, ImageDraw

def create_spotlight(image_path, out_path, region, padding=80):
    try:
        img = Image.open(image_path).convert("RGBA")
        x1, y1, x2, y2 = region
        
        # Ensure region bounds are valid
        x1 = max(0, min(x1, img.width))
        y1 = max(0, min(y1, img.height))
        x2 = max(0, min(x2, img.width))
        y2 = max(0, min(y2, img.height))
        
        # Darken the background
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 200)) # 200/255 opacity
        dark_img = Image.alpha_composite(img, overlay)
        
        # Crop the bright region from original
        bright_region = img.crop((x1, y1, x2, y2))
        
        # Paste the bright region back
        dark_img.paste(bright_region, (x1, y1))
        
        # Add a light border around the highlighted region
        draw = ImageDraw.Draw(dark_img)
        draw.rectangle([x1-1, y1-1, x2+1, y2+1], outline="#ffffff", width=3)
        draw.rectangle([x1-3, y1-3, x2+3, y2+3], outline="#8bb0ff", width=2)
        
        # Crop with padding
        px1 = max(0, x1 - padding)
        py1 = max(0, y1 - padding)
        px2 = min(img.width, x2 + padding)
        py2 = min(img.height, y2 + padding)
        
        zoomed_img = dark_img.crop((px1, py1, px2, py2))
        
        # Resize to make it look zoomed in (1.4x scale for balanced fit on slides)
        new_size = (int(zoomed_img.width * 1.4), int(zoomed_img.height * 1.4))
        zoomed_img = zoomed_img.resize(new_size, Image.Resampling.LANCZOS)
        
        zoomed_img.convert("RGB").save(out_path)
        print(f"[OK] Generated spotlight: {out_path}")
    except Exception as e:
        print(f"[Error] Error processing {image_path}: {e}")

regions = {
    # format: 'out_name': ('base_image', (x1, y1, x2, y2), padding)
    'dashboard_1': ('screenshot_dashboard.png', (290, 90, 1250, 220), 40),
    
    'devices_1': ('screenshot_devices.png', (290, 110, 1250, 310), 40),
    'devices_2': ('screenshot_devices.png', (290, 320, 1250, 600), 40),
    
    'execute_1': ('screenshot_execute.png', (290, 150, 1250, 240), 30),
    'execute_2': ('screenshot_execute.png', (290, 250, 600, 550), 30),
    'execute_3': ('screenshot_execute.png', (610, 250, 920, 550), 30),
    'execute_4': ('screenshot_execute.png', (930, 250, 1250, 550), 30),
    
    'vs_1': ('screenshot_vs.png', (290, 150, 750, 480), 40),
    'vs_2': ('screenshot_vs.png', (760, 150, 1250, 480), 40),
    
    'logs_1': ('screenshot_logs.png', (290, 150, 1250, 450), 40),
    
    'term_1': ('screenshot_terminal.png', (290, 150, 1250, 230), 40),
    'term_2': ('screenshot_terminal.png', (290, 240, 1250, 650), 40),
    
    # 7th Tab: Hardware Load spotlights
    'hardware_load_1': ('screenshot_hardware_load.png', (290, 150, 1250, 380), 40), # Form input & actions
    'hardware_load_2': ('screenshot_hardware_load.png', (290, 390, 1250, 700), 40)  # Active jobs & History table
}

def generate_all_spotlights():
    print("Starting spotlight generation sequence...")
    for out_name, (base_img, coords, pad) in regions.items():
        if not os.path.exists(base_img):
            print(f"[Warning] Base image '{base_img}' not found, skipping spotlight '{out_name}'.")
            continue
        out_file = f"spotlight_{out_name}.png"
        create_spotlight(base_img, out_file, coords, pad)
    print("Spotlight generation complete!")

if __name__ == "__main__":
    generate_all_spotlights()
