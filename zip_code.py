import zipfile
import os
import time

def zip_dir(dir_path, zipf, exclude_dirs=None, exclude_files=None):
    if exclude_dirs is None:
        exclude_dirs = set()
    if exclude_files is None:
        exclude_files = set()
        
    for root, dirs, files in os.walk(dir_path):
        # modify dirs in-place to prune walk
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for file in files:
            if file in exclude_files or file.endswith('.db') or file.startswith('.'):
                continue
            abs_path = os.path.join(root, file)
            rel_path = os.path.relpath(abs_path, os.path.join(dir_path, '..'))
            
            # Skip if file is an open database or cannot be read
            try:
                zipf.write(abs_path, rel_path)
            except Exception as e:
                print(f"Skipping {abs_path}: {e}")

dest_zip = "Eka_Automation_App_Source.zip"

with zipfile.ZipFile(dest_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
    # Add main files
    for file in ["main.py", "start.bat", "Eka_Automation_Demo.html", "Eka_Automation_Demo.pptx", "requirements.txt"]:
        if os.path.exists(file):
            zipf.write(file, file)
            
    # Add static folder
    zip_dir("static", zipf)
    
    # Add data scripts folder (without hitting the DB or logs)
    zip_dir("data/scripts", zipf)

print(f"Successfully created {dest_zip} in the current directory.")
