import re
import urllib.request
import os

for css_file in ['fonts.css', 'icons.css']:
    with open(css_file, 'r') as f:
        css = f.read()
    
    urls = re.findall(r'url\((https://[^)]+)\)', css)
    for url in urls:
        filename = url.split('/')[-1]
        print(f"Downloading {filename}")
        urllib.request.urlretrieve(url, filename)
        css = css.replace(url, filename)
        
    with open(css_file, 'w') as f:
        f.write(css)
