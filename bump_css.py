import os
import re
import glob

directory = '/Users/rimas/finnpath-web'
html_files = glob.glob(os.path.join(directory, '*.html'))

for filepath in html_files:
    with open(filepath, 'r') as f:
        content = f.read()

    # Find the link rel="stylesheet" href="shared.css..."
    pattern = re.compile(r'href="shared\.css\?v=\d+"')
    new_content, count = pattern.subn('href="shared.css?v=7"', content)
    
    # Also handle cases where there might not be a ?v=
    pattern2 = re.compile(r'href="shared\.css"')
    new_content, count2 = pattern2.subn('href="shared.css?v=7"', new_content)

    if count > 0 or count2 > 0:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Bumped CSS version in {os.path.basename(filepath)}")

