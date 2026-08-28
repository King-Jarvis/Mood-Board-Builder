---
name: mood-board-builder
description: Start, use or debug the local Mood Board Builder — a dashboard for collecting visual references into zones drawn on a board (rooms on a floor plan, areas on a van layout, or boxes on a blank canvas) and compositing them into one image. Use when the user wants to open their mood board, work on a house/room/garden/van/wedding mood board, collect Pinterest inspiration by area, or export a combined board image.
---

# Mood Board Builder

Repo: `~/Mood-Board-Builder` (github.com/King-Jarvis/Mood-Board-Builder)
Data: `~/.moodboards` — **outside the repo**, never commit or delete it.

## Running it

Double-click **Mood Board Builder** on the Desktop, or:

```bash
python3 -m moodboards --open
```

(from `~/Mood-Board-Builder`; Python stdlib only, no install step)

`--port` 8765 · `--host` 127.0.0.1 (`0.0.0.0` serves the LAN, no auth) ·
`--data` overrides `~/.moodboards`.

Logs: `~/.moodboards/moodboards.log` (every ingest with timing, every error with
a traceback) and `~/Mood-Board-Builder/launcher.log` (each app launch, step by
step). **Check these first when something misbehaves.**

## Model

**Board** → **Zones** → images. Each board picks its own word for its zones, so
the house board says "Rooms" and a van build says "Areas". A board's background
image is optional; without one it is a blank canvas. Zone rects are normalised
0–1 either way, so the Mosaic View and export don't care which kind it is.

Screens: dashboard (`#/`) · board (`#/b/<id>`) · zone triad
(`#/b/<id>/z/<zone>`) · **Mosaic View** (`#/b/<id>/mosaic`).

## Things not to re-derive

- **`static/layout.js` is settled.** Verified across 7,920 generated cases. Two
  caps hold it together: no row may exceed 1.6× the working row height (without
  it a lone leftover portrait demands a row ~3× a zone's height and shrinks the
  whole board), and no cell is cropped past ~2.2× (beyond that the block
  shrinks and centres, and the gap is the honest signal). Don't "simplify"
  these. Re-run the browser-console harness after any change.
- **Portrait-heavy images in a wide zone crop more.** Geometry, not a bug. Fix
  by adding images, reordering, or ★ as a hero.
- **★ hero rows are sized against sibling rows**, never the image's own
  proportions and never the layout's trial height — both were tried and both
  broke (overflow, then a hero collapsed to 1% of the board).
- **HTTP 308 is followed explicitly** in `images.py`. Python only learned to in
  3.11 and `pin.it` links answer 308; without it every shared pin fails. Every
  redirect hop is re-checked so a public URL can't redirect into private space.
- **Error responses must drain the request body** (`server.py: drain_body`) or
  keep-alive desyncs and the page hangs.
- **The Mosaic caches cell rects on the on-screen draw only**, never the 3200px
  export draw — otherwise quick-peek clicks land on the wrong images.
- **The macOS launcher must not live under `~/Documents`, `~/Desktop` or
  `~/Downloads`.** TCC blocks a background app from reading them, and
  `fileExistsAtPath` still returns true, so it presents as
  `ModuleNotFoundError`. JXA's NSTask `environment` / `currentDirectory*`
  assignments also silently don't take — the module path goes in a `-c`
  bootstrap.

## Limits

Rectangular zones only · export is PNG at 3200px wide · no authentication of
any kind · Pinterest has no public search API, so discovery happens in a real
Pinterest window (⌘V an image, paste pin links, or drag files in).
