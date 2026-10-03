#!/usr/bin/env python3
"""
Bundle the app into a single self-contained HTML file.

    python3 tools/build_standalone.py                 # -> dist/vwap-lab.html
    python3 tools/build_standalone.py --fragment -o preview.html

The standalone file runs without the Python server (double-click it): built-in
strategies are embedded, edits are saved in the browser, and data comes from
the synthetic samples or CSV files you open. Live Yahoo/Binance downloads and
saving to strategies/ need `python3 server.py`.

--fragment writes body-level markup (no <html>/<head>/<body> wrapper) and loads
the chart library from jsDelivr, for hosts that supply their own page skeleton.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
STRATEGIES = ROOT / "strategies"
LIBRARY = ROOT / "research" / "library.json"
CHART_CDN = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"


def between(text, start, end):
    i = text.index(start) + len(start)
    return text[i : text.index(end, i)]


def inline_js(code):
    return code.replace("</script", "<\\/script")


def build(fragment):
    html = (WEB / "index.html").read_text(encoding="utf-8")
    title = re.search(r"<title>.*?</title>", html, re.S).group(0)
    links = "\n".join(re.findall(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts[^>]*>', html))
    css_files = re.findall(r'href="([^"]+\.css)"', between(html, "<!-- build:css -->", "<!-- /build:css -->"))
    css = "\n".join((WEB / f).read_text(encoding="utf-8") for f in css_files)
    body = between(html, "<!-- build:body -->", "<!-- /build:body -->").strip()
    js_files = re.findall(r'<script src="([^"]+)"></script>', between(html, "<!-- build:js -->", "<!-- /build:js -->"))

    strategies = [
        {"id": p.stem, "code": p.read_text(encoding="utf-8")}
        for p in sorted(STRATEGIES.glob("*.js"))
        if re.match(r"^[A-Za-z0-9_-]{1,64}$", p.stem)
    ]
    boot = "window.BT_PREVIEW = true;\nwindow.BT_BUNDLED_STRATEGIES = " + json.dumps(strategies, indent=0) + ";"
    if LIBRARY.exists():  # the Library tab works offline too
        boot += "\nwindow.BT_LIBRARY = " + json.dumps(json.loads(LIBRARY.read_text(encoding="utf-8")), ensure_ascii=False) + ";"

    scripts = [f"<script>{inline_js(boot)}</script>"]
    for f in js_files:
        if fragment and f.startswith("vendor/lightweight-charts"):
            scripts.append(f'<script src="{CHART_CDN}"></script>')
        else:
            scripts.append(f"<script>\n{inline_js((WEB / f).read_text(encoding='utf-8'))}\n</script>")

    head = f"{title}\n{links}\n<style>\n{css}\n</style>"
    if fragment:
        return f"{head}\n{body}\n" + "\n".join(scripts) + "\n"
    return (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f"{head}\n</head>\n<body>\n{body}\n" + "\n".join(scripts) + "\n</body>\n</html>\n"
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--output", help="output file (default dist/vwap-lab.html)")
    ap.add_argument("--fragment", action="store_true", help="omit the html/head/body wrapper and load the chart library from a CDN")
    args = ap.parse_args(argv)
    out = Path(args.output) if args.output else ROOT / "dist" / "vwap-lab.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(args.fragment), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
