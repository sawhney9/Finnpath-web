"""Render the 5 text slides (1080x1350, 4:5) from a JSON config.

usage: python3 render_slides.py <config.json> <outdir>
config: {brand, handle, accent, bg?, swipe?, slides: [{kicker, big, small, cta?, disclaimer?}]}
swipe: show a "swipe →" hint (for carousels; off for reels, which auto-advance)
"""
import html
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

cfg = json.load(open(sys.argv[1]))
out = pathlib.Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
         'family=Inter:wght@400;600&family=Outfit:wght@700;800&display=block">')

CSS = """
*{margin:0;box-sizing:border-box}
body{width:1080px;height:1350px;overflow:hidden;background:BG;color:#f4f4f2;
  font-family:'Inter','Inter Display',sans-serif;padding:96px 88px;display:flex;flex-direction:column}
.top{display:flex;justify-content:space-between;font-size:26px;letter-spacing:.18em;font-weight:600;color:#8a8a86}
.top .k{color:ACC}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
.bar{width:96px;height:8px;background:ACC;border-radius:4px;margin-bottom:56px;flex:none}
.big{font-family:'Outfit','Inter Display','Inter',sans-serif;font-size:100px;line-height:1.04;
  font-weight:800;letter-spacing:-.02em;white-space:pre-line}
.small{font-size:42px;line-height:1.45;color:#c9c9c4;margin-top:48px}
.cta{margin-top:56px;display:inline-block;background:ACC;color:#0b0b0b;font-weight:600;font-size:36px;
  padding:22px 34px;border-radius:14px;align-self:flex-start}
.foot{display:flex;justify-content:space-between;align-items:flex-end;gap:40px;font-size:26px;color:#8a8a86;flex:none}
.disc{font-size:23px;color:#77776f;line-height:1.4}
.swipe{color:ACC;font-weight:600;white-space:nowrap}
""".replace('ACC', cfg['accent']).replace('BG', cfg.get('bg', '#0b0b0b'))

# Shrink the headline, then the body, until the slide fits.
FIT = """() => {
  const fits = () => document.body.scrollHeight <= 1350 &&
    document.querySelector('.mid').scrollHeight <= document.querySelector('.mid').clientHeight + 1;
  const big = document.querySelector('.big'), small = document.querySelector('.small');
  let b = 100, s = 42;
  while (!fits() && b > 64) { b -= 4; big.style.fontSize = b + 'px'; }
  while (!fits() && s > 32) { s -= 2; small.style.fontSize = s + 'px'; }
  return fits();
}"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1080, 'height': 1350})
    n = len(cfg['slides'])
    for i, s in enumerate(cfg['slides'], 1):
        e = lambda k: html.escape(s.get(k, '') or '')
        foot_left = (f'<div class="disc">{e("disclaimer")}</div>' if s.get('disclaimer')
                     else f'<div>{html.escape(cfg["handle"])}</div>')
        swipe = '<div class="swipe">swipe →</div>' if cfg.get('swipe') and i < n else ''
        cta = f'<div class="cta">{e("cta")}</div>' if s.get('cta') else ''
        doc = f"""<html><head>{FONTS}<style>{CSS}</style></head><body>
<div class="top"><div>{html.escape(cfg['brand'])}</div><div class="k">{e('kicker')}</div></div>
<div class="mid"><div class="bar"></div><div class="big">{e('big')}</div><div class="small">{e('small')}</div>{cta}</div>
<div class="foot">{foot_left}{swipe}</div></body></html>"""
        try:
            page.set_content(doc, wait_until='networkidle', timeout=15000)
        except Exception:
            page.set_content(doc)  # offline: fall back to local fonts
        page.evaluate('document.fonts.ready.then(() => true)')
        if not page.evaluate(FIT):
            print(f'  ⚠ slide {i}: text still overflows after shrinking', file=sys.stderr)
        page.screenshot(path=str(out / f'slide-{i}.jpg'), type='jpeg', quality=92)
    browser.close()
print(f'  ✓ rendered {n} slides')
