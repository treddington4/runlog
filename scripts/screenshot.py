#!/usr/bin/env python3
"""Visual verification helper — screenshots the live app with a headless browser.

This repo has no test suite (see STATUS.md), so this is the primary way to
actually *see* a UI/layout change take effect rather than only checking API
responses via curl. Not part of the running app — a standalone dev tool with
its own dependencies (see scripts/requirements.txt).

Usage:
    python scripts/screenshot.py                              # every tab, every viewport, scaled to 720p-wide
    python scripts/screenshot.py --tabs home,insights          # specific tabs
    python scripts/screenshot.py --viewports desktop           # specific viewport(s)
    python scripts/screenshot.py --url http://localhost:8000   # override target
    python scripts/screenshot.py --out .screenshots            # output dir (gitignored)
    python scripts/screenshot.py --resolution 480p             # scale down further
    python scripts/screenshot.py --resolution native           # keep the real captured size, no scaling
    python scripts/screenshot.py --quality 80                  # higher-fidelity JPEG (default 60)

Target URL resolves in order: --url flag, RUNLOG_URL env var, http://localhost:8000.
If your instance runs elsewhere (a NAS, a VPS, ...), either pass --url or set
RUNLOG_URL — keep host-specific values out of anything you'd commit (an env var
or a local .env-style file, same pattern as this project's own .RUNBOOK.md).

Always captures the full scrolled page (not just what's visible without
scrolling), then scales the whole image down proportionally to a target
resolution tier before saving as JPEG. An agent reading these back only needs
to judge layout/structure, not pixel-perfect fidelity, and a full-page capture
of a long tab (Insights, with its stack of charts, is 4000px+ tall natively)
costs far more tokens to review at full resolution than a scaled-down version
for no real benefit — this keeps the whole page in view while keeping file
size and token cost down.

Setup (one-time):
    pip install -r scripts/requirements.txt
    playwright install chromium
"""
import argparse
import io
import os
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ALL_TABS = ["home", "goals", "runs", "insights", "map", "chat", "workouts", "settings"]

# Matches the preset sizes used by Claude Code's own browser tooling, for consistency.
VIEWPORTS = {
    "mobile": {"width": 375, "height": 812},
    "tablet": {"width": 768, "height": 1024},
    "desktop": {"width": 1280, "height": 800},
}

# Target *height* to scale a captured screenshot down to, preserving aspect ratio —
# matches the conventional meaning of "720p"/"480p" (the "p" is progressive scan
# lines, i.e. vertical resolution). Height is also the dimension that actually
# explodes here: a full-page capture's width is always just the viewport width
# (375/768/1280), fixed regardless of content — height is what grows with a long
# page and is what actually needs capping. "native" skips scaling entirely.
RESOLUTIONS = {
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "native": None,
}

DEFAULT_URL = os.environ.get("RUNLOG_URL", "http://localhost:8000")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=DEFAULT_URL, help=f"App base URL (default: {DEFAULT_URL}, or $RUNLOG_URL)")
    parser.add_argument("--tabs", default=",".join(ALL_TABS), help="Comma-separated tab list (default: all)")
    parser.add_argument("--viewports", default=",".join(VIEWPORTS), help="Comma-separated viewport list (default: all)")
    parser.add_argument("--out", default=".screenshots", help="Output directory (default: .screenshots, gitignored)")
    parser.add_argument("--resolution", choices=list(RESOLUTIONS), default="720p",
                         help="Scale the full-page capture down to this target height, preserving aspect ratio (default: 720p / 720px tall). Use 'native' to skip scaling.")
    parser.add_argument("--quality", type=int, default=60, help="JPEG quality 1-100 (default: 60) — lower is smaller/cheaper to review, higher preserves more detail")
    args = parser.parse_args()

    tabs = [t.strip() for t in args.tabs.split(",") if t.strip()]
    viewports = [v.strip() for v in args.viewports.split(",") if v.strip()]

    bad_tabs = set(tabs) - set(ALL_TABS)
    if bad_tabs:
        sys.exit(f"Unknown tab(s): {', '.join(bad_tabs)} — valid: {', '.join(ALL_TABS)}")
    bad_vps = set(viewports) - set(VIEWPORTS)
    if bad_vps:
        sys.exit(f"Unknown viewport(s): {', '.join(bad_vps)} — valid: {', '.join(VIEWPORTS)}")
    if not 1 <= args.quality <= 100:
        sys.exit("--quality must be between 1 and 100")

    max_height = RESOLUTIONS[args.resolution]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for vp_name in viewports:
            page = browser.new_page(viewport=VIEWPORTS[vp_name])
            page.goto(args.url, timeout=15000)
            page.wait_for_timeout(1000)
            for tab in tabs:
                # navigateTo() is app.js's own tab-switch function — calling it directly
                # is more reliable than clicking through the nav menu each time, and
                # keeps active-state/menu-label consistent with a real tab click.
                page.evaluate(f"navigateTo({{tab: '{tab}'}})")
                page.wait_for_timeout(800)

                # Capture lossless first; scale, then do the one lossy JPEG encode at
                # the end, rather than compressing twice (once in-browser, once here).
                raw_png = page.screenshot(full_page=True, type="png")
                img = Image.open(io.BytesIO(raw_png)).convert("RGB")
                if max_height and img.height > max_height:
                    scale = max_height / img.height
                    img = img.resize((round(img.width * scale), max_height), Image.LANCZOS)

                out_path = out_dir / f"{tab}_{vp_name}.jpg"
                img.save(out_path, "JPEG", quality=args.quality)
                print(f"saved {out_path} ({img.width}x{img.height})")
            page.close()
        browser.close()


if __name__ == "__main__":
    main()
