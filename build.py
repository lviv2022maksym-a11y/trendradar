"""Збирає програму TrendRadar з web/src:
  web/dist/trendradar.html — один файл (для перегляду на claude.ai)
  docs/ (або --out)        — сайт-застосунок для GitHub Pages: index.html, іконки, manifest, service worker

  python web/build.py
  python web/build.py --out _site
"""
import argparse
import base64
import hashlib
import json
import shutil
from pathlib import Path

WEB = Path(__file__).resolve().parent
SRC, ASSETS, REPO = WEB / "src", WEB.parent / "assets", WEB.parent
LC_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"
SCRIPTS = ("i18n.js", "engine.js", "data.js", "app.js")


def fragment() -> str:
    shell = (SRC / "shell.html").read_text(encoding="utf-8")
    css = (SRC / "styles.css").read_text(encoding="utf-8")
    logo = "data:image/png;base64," + base64.b64encode((ASSETS / "icon-192.png").read_bytes()).decode()
    parts = [f'<script src="{LC_URL}"></script>']
    for name in SCRIPTS:
        code = (SRC / name).read_text(encoding="utf-8")
        assert "</script" not in code.lower(), f"{name} містить </script>"
        parts.append(f"<script>\n{code}\n</script>")
    return shell.replace("/*STYLE*/", css).replace("{{LOGO}}", logo).replace("<!--SCRIPTS-->", "\n".join(parts))


def site(out: Path, frag: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    head, body = frag.split("<!--BODY-->", 1)
    version = hashlib.sha1(frag.encode()).hexdigest()[:10]
    html = f"""<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1722">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="TrendRadar">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="favicon.png">
<link rel="apple-touch-icon" href="icon-192.png">
<script>window.TR_PWA = true;</script>
<style>:root{{padding-top:env(safe-area-inset-top,0px)}}[hidden]{{display:none!important}}img{{max-width:100%}}</style>
{head.strip()}
</head>
<body>
{body.strip()}
</body>
</html>
"""
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "sw.js").write_text((SRC / "sw.js").read_text(encoding="utf-8").replace("__VERSION__", version), encoding="utf-8")
    for f in ("icon-192.png", "icon-512.png", "favicon.png"):
        shutil.copyfile(ASSETS / f, out / f)
    manifest = {
        "name": "TrendRadar", "short_name": "TrendRadar", "lang": "uk",
        "description": "Оцінка ВИГІДНО / ЧЕКАТИ / НЕВИГІДНО, живі графіки, пульс ринку, новини і школа трейдера.",
        "start_url": "./#market", "scope": "./", "display": "standalone",
        "background_color": "#080d15", "theme_color": "#0f1722",
        "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                  {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                  {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    }
    (out / "manifest.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "data").mkdir(exist_ok=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "docs"))
    args = ap.parse_args()
    frag = fragment()
    dist = WEB / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "trendradar.html").write_text(frag.replace("<!--BODY-->", ""), encoding="utf-8")
    site(Path(args.out), frag)
    print(f"OK: {dist / 'trendradar.html'} ({len(frag) // 1024} КБ), сайт → {args.out}")


if __name__ == "__main__":
    main()
