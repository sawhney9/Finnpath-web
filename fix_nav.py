import os
import re
import glob

directory = '/Users/rimas/finnpath-web'
html_files = glob.glob(os.path.join(directory, '*.html'))

# We want to replace everything from <ul class="nav-links"> up to </ul>
# with the new dropdown structure, while keeping the active class correct.

for filepath in html_files:
    basename = os.path.basename(filepath)
    if basename in ['login.html', 'sim_part1.html', 'simulator.html.bak']: 
        continue
    
    with open(filepath, 'r') as f:
        content = f.read()

    # Find the ul class="nav-links" block
    pattern = re.compile(r'<ul class="nav-links">.*?</ul>', re.DOTALL)
    
    # Generate the new nav-links
    # Function to add class="active" if it matches
    def act(page, current=basename):
        return ' class="active"' if page == current else ''

    new_nav = f'''<ul class="nav-links">
    <li><a href="index.html"{act("index.html")}>Home</a></li>
    <li><a href="learn.html"{act("learn.html")}>Learn</a></li>
    <li class="nav-dropdown">
      <a href="#" class="nav-dropdown-toggle">Tools <span class="nav-caret">▾</span></a>
      <div class="nav-dropdown-menu">
        <a href="calculator.html">🧮 Calculator</a>
        <a href="simulator.html">📈 Portfolio Tracker</a>
        <a href="401k.html">📄 401k Decoder</a>
      </div>
    </li>
    <li><a href="paths.html"{act("paths.html")}>Your Path</a></li>
    <li><a href="blog.html"{act("blog.html")}>Money Moves</a></li>
  </ul>'''

    # For the tools in the dropdown, we need to add the active class there if the file is one of them.
    # Actually, the original index.html didn't even put active class on the dropdown links, 
    # but let's make it nice.
    if basename == 'calculator.html':
        new_nav = new_nav.replace('href="calculator.html"', 'href="calculator.html" class="active"')
    elif basename == 'simulator.html':
        new_nav = new_nav.replace('href="simulator.html"', 'href="simulator.html" class="active"')
    elif basename == '401k.html':
        new_nav = new_nav.replace('href="401k.html"', 'href="401k.html" class="active"')
        
    # Replace in file
    new_content, count = pattern.subn(new_nav, content)
    
    if count > 0:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated {basename}")

