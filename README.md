# Mood Board Builder

Collect visual references for anything — a house, a garden, a van build, a
wedding — arranged the way the thing itself is arranged, then composited into
one image.

You draw **zones** on a **board**: rooms over a floor plan, areas over a van
layout, or boxes on a blank canvas. Each zone collects images. The **Mosaic
View** reflows every zone's images back into its own footprint, so adjacency
becomes visible — the living room's warmth sitting directly against the
kitchen's palette, in the arrangement you'd actually walk through.

## Install

### Local (macOS)

Builds a Desktop app, starts the dashboard and opens it in your browser.

```bash
curl -fsSL https://raw.githubusercontent.com/King-Jarvis/Mood-Board-Builder/main/install/install-local.command -o ~/Downloads/install-local.command && bash ~/Downloads/install-local.command
```

Code goes to `~/Mood-Board-Builder`, boards to `~/.moodboards`. Re-run any time
to update — your boards are untouched.

*(The install directory is deliberately not under `~/Documents`, `~/Desktop` or
`~/Downloads`: macOS TCC gates those, and a background app can't show the
consent prompt — it fails as a confusing "No module named moodboards".)*

### Network (Linux / NAS)

Adds a `moodboards` service to your `docker-compose.yml`, builds it, and starts
it. Run it from the directory your compose file lives in.

```bash
curl -fsSL https://raw.githubusercontent.com/King-Jarvis/Mood-Board-Builder/main/install/install-network.sh -o install-network.sh && bash install-network.sh
```

Then open `http://<host-address>:8765` from any machine on the network.

It backs up your compose file first, matches the indentation the file already
uses, validates with `docker compose config` before starting anything, and
restores the backup if the edit doesn't validate. Re-running is safe: it skips
the compose edit if the service is already there.

Override with `STACK_DIR=/path/to/stack PORT=9000 bash install-network.sh`.

## Running it manually

Python 3.8+ standard library only. No `pip install`, no Node, no build step.

```bash
python3 -m moodboards --open
```

| Flag | Default | Notes |
|---|---|---|
| `--port` | `8765` | auto-increments if busy |
| `--host` | `127.0.0.1` | `0.0.0.0` serves the whole LAN — see the warning below |
| `--data` | `$MOODBOARDS_DATA`, else `~/.moodboards` | never inside the repo |
| `--open` | off | open a browser once it's up |

Data lives **outside the checkout** so you can `git pull`, delete and re-clone
without ever putting hand-curated images at risk. Back up your data directory
like any other folder; it is plain JSON and original-resolution image files.

### Docker

`docker/docker-compose.example.yml` is a service block to paste into an
existing `docker-compose.yml`. Plain port mapping, a data directory beside the
compose file, nothing to install:

```yaml
  moodboards:
    build:
      context: ./path/to/repo
      dockerfile: docker/Dockerfile
    container_name: moodboards
    ports:
      - "8765:8765"
    volumes:
      - ./moodboards-data:/data
    restart: unless-stopped
```

```bash
docker compose up -d --build moodboards
```

Mount a host directory at `/data`. The image contains no data.

### macOS double-click launcher

```bash
osacompile -l JavaScript -o ~/Desktop/"Mood Board Builder.app" scripts/launcher.js
cp scripts/launcher-icon.icns ~/Desktop/"Mood Board Builder.app"/Contents/Resources/applet.icns
```

It starts the server if it isn't running and opens the browser; clicking again
just opens the board. It uses `NSTask` rather than `do shell script`, which
otherwise waits on the spawned process and never reaches the step that opens
the browser. `launcher.log` records each launch step by step.

## There is no authentication

None. No login, no sessions. Anyone who can reach the port can view, edit and
permanently delete every board.

That is fine on a trusted home network. If you put it behind a reverse proxy on
a public hostname, add an access list or basic auth **at the proxy** — in Nginx
Proxy Manager, the proxy host's *Access List* tab.

## How it works

**Boards and zones.** Zone rectangles are stored normalised 0–1 against the
board, which is what lets a board work with a background image or without one:
the geometry is identical either way, so the Mosaic View and the export do not
care which kind of board they are drawing.

**Layout.** A zone's images are stored as an *ordered list*, never as fixed
coordinates, because every zone footprint has a different aspect ratio — the
same images must reflow into a wide living room and a narrow hallway.
`layout.js` enumerates the possible row structures, picks the one closest to
the footprint's shape, and stretches it to fill edge to edge; cells then
centre-crop to their tile.

Two caps keep that honest. No row may exceed 1.6× the working row height —
without it a single leftover portrait demands a row about three times a zone's
height and drags the whole board down with it. And no cell is cropped past
~2.2×; beyond that the block shrinks and centres instead, and the gap is the
signal that these images cannot tile this footprint.

Practical consequence: **portrait-heavy images in a wide zone crop more.** Four
portraits in a landscape footprint lose about half of each. Fixes, in order of
effect: add more images (more images → more structures → better fit), reorder,
or ★ one as a hero.

**Quick peek.** The Mosaic crops every image to tile its footprint. Click one
and it opens whole and uncropped — the one place in the app that never crops.
The source link is shown but never followed for you, so a click is a look, not
a trip to Pinterest.

**Pinterest.** There is no public search API and pins cannot be embedded, so
discovery happens in a real Pinterest window. Three ways in: ⌘V an image copied
from anywhere; paste pin links (both `pin.it/…` short links and full
`pinterest.com/pin/…` URLs); or drag files in. Duplicates are dropped by
content hash, so re-pasting is safe.

The URL fetcher follows HTTP 308 explicitly — Python only learned to in 3.11,
and `pin.it` share links answer 308, so without it every shared pin fails. It
also re-checks every hop of a redirect chain, so a public URL cannot redirect
the fetcher into private address space.

## Layout

```
moodboards/
  __main__.py   entry point           storage.py  data root, atomic writes, migration
  server.py     routing + HTTP        images.py   fetch, SSRF guard, dedupe, header parsing
  static/       dashboard / board / zone / mosaic views, layout.js, styles
docker/         Dockerfile + compose example
scripts/        macOS launcher
```

Data:

```
<data-root>/
  boards/<board-id>/board.json, background.<ext>
    zones/<zone-id>/zone.json, images/<sha>.<ext>
  exports/
```

## Migrating from the house-only version

On first run, if the data root is empty and an older `houses/` layout is found,
it is **copied** forward: `rooms` become `zones`, `plan` becomes `background`,
and the zones are labelled *Room*/*Rooms* so a migrated house still reads as a
house. The source is never moved, rewritten or deleted, and a marker file
records where it came from.

## Limits

- **Rectangular zones only.** An L-shaped room is two boxes.
- **Export is PNG**, 3200px wide.
- A zone's folder id is minted from its name when created and then frozen; the
  board view offers *Fix folder name* when the two drift apart.
