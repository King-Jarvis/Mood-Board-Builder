"""Where boards live on disk, and how they get there safely.

Data never lives inside the repo. The root is chosen once at startup:
``--data PATH``, else ``$MOODBOARDS_DATA``, else ``~/.moodboards``. That way the
checkout can be pulled, deleted and re-cloned without ever putting hand-curated
images at risk.
"""

import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time

DEFAULT_ROOT = os.path.join(os.path.expanduser("~"), ".moodboards")

# Where the pre-repo version kept things, for the one-time import.
LEGACY_SKILL_DATA = os.path.join(
    os.path.expanduser("~"), ".claude", "skills", "house-mood-board", "data")

SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
SAFE_SHA = re.compile(r"^[a-f0-9]{64}$")

_write_lock = threading.Lock()
_log_lock = threading.Lock()

# Set by configure().
ROOT = DEFAULT_ROOT
BOARDS = os.path.join(DEFAULT_ROOT, "boards")
EXPORTS = os.path.join(DEFAULT_ROOT, "exports")
LOGFILE = os.path.join(DEFAULT_ROOT, "moodboards.log")


def configure(root):
    """Point the module at a data root and make sure it exists."""
    global ROOT, BOARDS, EXPORTS, LOGFILE
    ROOT = os.path.abspath(os.path.expanduser(root))
    BOARDS = os.path.join(ROOT, "boards")
    EXPORTS = os.path.join(ROOT, "exports")
    LOGFILE = os.path.join(ROOT, "moodboards.log")
    os.makedirs(BOARDS, exist_ok=True)
    os.makedirs(EXPORTS, exist_ok=True)
    return ROOT


def resolve_root(cli_value):
    return cli_value or os.environ.get("MOODBOARDS_DATA") or DEFAULT_ROOT


# --------------------------------------------------------------------------
# logging -- always on, unbuffered, next to the data
# --------------------------------------------------------------------------

def log(message):
    """Append one line to the log and echo to stderr.

    Written unbuffered on purpose: the point is that the file is useful while
    the server is still running, or after it dies unexpectedly.
    """
    line = "%s  %s\n" % (time.strftime("%H:%M:%S"), message)
    with _log_lock:
        try:
            with open(LOGFILE, "a", encoding="utf-8") as fh:
                fh.write(line)
        except OSError:
            pass
    sys.stderr.write(line)
    sys.stderr.flush()


# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

def safe_id(value):
    """Reject anything that could escape the data directory."""
    if not value or not SAFE_ID.match(value):
        raise ValueError("bad id: %r" % (value,))
    return value


def slugify(name, fallback="zone"):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug[:48] or fallback


def unique_id(name, taken, fallback="zone"):
    """Readable id from a name, with a numeric suffix only on collision."""
    base = slugify(name, fallback)
    candidate = base
    n = 2
    while candidate in taken:
        candidate = "%s-%d" % (base, n)
        n += 1
    return candidate


def board_dir(board_id):
    return os.path.join(BOARDS, safe_id(board_id))


def zone_dir(board_id, zone_id):
    return os.path.join(board_dir(board_id), "zones", safe_id(zone_id))


def images_dir(board_id, zone_id):
    return os.path.join(zone_dir(board_id, zone_id), "images")


# --------------------------------------------------------------------------
# json
# --------------------------------------------------------------------------

def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (IOError, OSError, ValueError):
        return default


def write_json(path, payload):
    """Atomic write: temp file in the same directory, then rename."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    with _write_lock:
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, sort_keys=False)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------
# shapes
# --------------------------------------------------------------------------

SCHEMA = 2


def default_board(board_id, name=None, subject="", zone_one="Zone",
                  zone_many="Zones"):
    return {
        "v": SCHEMA,
        "id": board_id,
        "name": name or "Untitled board",
        "subject": subject,
        "zoneLabel": {"one": zone_one, "many": zone_many},
        "notes": "",
        "background": None,
        "canvas": {"w": 16, "h": 10},
        "cover": None,
        "created": now(),
        "updated": now(),
        "zones": [],
        # Key stays "stitch" so boards migrated from the house-only version
        # keep their gutters and ground colour when the view was renamed.
        "stitch": {"roomGutter": 14, "imageGutter": 6,
                   "bg": "#fff0d6", "showPlan": True, "showLabels": True},
    }


def default_zone(zone_id):
    return {
        "id": zone_id,
        "images": {},      # sha -> {sha, file, w, h, src, color}
        "candidates": [],  # [sha]
        "selected": [],    # [{sha, feature}]
        "gutter": 8,
        "bg": "#fff8ec",
    }


def board_path(board_id):
    return os.path.join(board_dir(board_id), "board.json")


def zone_path(board_id, zone_id):
    return os.path.join(zone_dir(board_id, zone_id), "zone.json")


def load_board(board_id, create=False):
    path = board_path(board_id)
    if not os.path.exists(path):
        if not create:
            return None
        board = default_board(board_id)
        write_json(path, board)
        return board
    board = read_json(path, None)
    if board is None:
        return None
    board.setdefault("zones", [])
    board.setdefault("zoneLabel", {"one": "Zone", "many": "Zones"})
    board.setdefault("canvas", {"w": 16, "h": 10})
    board.setdefault("subject", "")
    return board


def save_board(board_id, board):
    board["id"] = board_id
    board["updated"] = now()
    board.setdefault("created", board["updated"])
    write_json(board_path(board_id), board)
    return board


def load_zone(board_id, zone_id):
    path = zone_path(board_id, zone_id)
    if not os.path.exists(path):
        return default_zone(zone_id)
    zone = read_json(path, default_zone(zone_id))
    zone.setdefault("images", {})
    zone.setdefault("candidates", [])
    zone.setdefault("selected", [])
    return zone


def save_zone(board_id, zone_id, zone):
    zone["id"] = zone_id
    write_json(zone_path(board_id, zone_id), zone)
    return zone


def delete_board(board_id):
    path = board_dir(board_id)
    if os.path.isdir(path):
        shutil.rmtree(path)
        return True
    return False


def counts_for(board_id, board):
    """Per-zone selected/candidate counts, for the rail and the dashboard."""
    counts = {}
    for zone in board.get("zones", []):
        data = load_zone(board_id, zone["id"])
        counts[zone["id"]] = {
            "selected": len(data.get("selected", [])),
            "candidates": len(data.get("candidates", [])),
        }
    return counts


def pick_cover(board_id, board):
    """Stored cover if it still exists, else the first image on any zone."""
    cover = board.get("cover")
    if cover and cover.get("zone") and cover.get("sha"):
        zone = load_zone(board_id, cover["zone"])
        meta = zone.get("images", {}).get(cover["sha"])
        if meta:
            return {"zone": cover["zone"], "sha": cover["sha"], "file": meta["file"]}
    for zone_meta in board.get("zones", []):
        zone = load_zone(board_id, zone_meta["id"])
        for entry in zone.get("selected", []):
            meta = zone.get("images", {}).get(entry.get("sha"))
            if meta:
                return {"zone": zone_meta["id"], "sha": meta["sha"], "file": meta["file"]}
    return None


def list_boards():
    """Everything the dashboard needs, without a second round trip."""
    if not os.path.isdir(BOARDS):
        return []
    out = []
    for entry in sorted(os.listdir(BOARDS)):
        if not os.path.exists(os.path.join(BOARDS, entry, "board.json")):
            continue
        board = load_board(entry)
        if not board:
            continue
        counts = counts_for(entry, board)
        images = sum(c["selected"] for c in counts.values())
        filled = sum(1 for c in counts.values() if c["selected"])
        out.append({
            "id": entry,
            "name": board.get("name", entry),
            "subject": board.get("subject", ""),
            "zoneLabel": board.get("zoneLabel", {"one": "Zone", "many": "Zones"}),
            "zones": len(board.get("zones", [])),
            "filled": filled,
            "images": images,
            "hasBackground": bool(board.get("background")),
            "cover": pick_cover(entry, board),
            "updated": board.get("updated", ""),
            "created": board.get("created", ""),
        })
    out.sort(key=lambda b: b.get("updated", ""), reverse=True)
    return out


# --------------------------------------------------------------------------
# migration from the house-only layout
# --------------------------------------------------------------------------
#
# The previous version stored `houses/<id>/house.json` with `rooms` and a
# `plan`. This copies that forward to `boards/<id>/board.json` with `zones` and
# a `background`, and labels the zones "Room"/"Rooms" so a migrated house still
# reads as a house.
#
# It only ever COPIES. The source is never moved, rewritten or deleted, so a
# failed run costs nothing and the old install stays usable.

def find_legacy(root):
    """A legacy `houses/` directory to import, or None."""
    for candidate in (os.path.join(root, "houses"),
                      os.path.join(LEGACY_SKILL_DATA, "houses")):
        if os.path.isdir(candidate) and os.listdir(candidate):
            return candidate
    return None


def _migrate_board(src_house, dst_board, board_id):
    house = read_json(os.path.join(src_house, "house.json"), None)
    if house is None:
        return None

    board = default_board(board_id, name=house.get("name") or board_id)
    board["zoneLabel"] = {"one": "Room", "many": "Rooms"}
    board["subject"] = house.get("subject", "")
    board["stitch"] = house.get("stitch", board["stitch"])

    try:
        mtime = os.path.getmtime(os.path.join(src_house, "house.json"))
        board["created"] = board["updated"] = time.strftime(
            "%Y-%m-%dT%H:%M:%S", time.localtime(mtime))
    except OSError:
        pass

    # plan.<ext> -> background.<ext>
    plan = house.get("plan")
    if plan and plan.get("file"):
        src_plan = os.path.join(src_house, plan["file"])
        if os.path.exists(src_plan):
            ext = os.path.splitext(plan["file"])[1] or ".png"
            os.makedirs(dst_board, exist_ok=True)
            shutil.copy2(src_plan, os.path.join(dst_board, "background" + ext))
            board["background"] = {"file": "background" + ext,
                                   "w": plan.get("w", 0), "h": plan.get("h", 0)}

    # rooms[] -> zones[]; `counts` was a response-only field that leaked into
    # some saved files, so it is dropped rather than carried forward.
    zones = []
    for room in house.get("rooms", []):
        zones.append({
            "id": room["id"],
            "name": room.get("name", room["id"]),
            "rect": room.get("rect", {"x": 0, "y": 0, "w": 0.2, "h": 0.2}),
            "color": room.get("color", "#9c6f4a"),
            "notes": "",
        })
    board["zones"] = zones

    src_rooms = os.path.join(src_house, "rooms")
    copied_images = 0
    if os.path.isdir(src_rooms):
        for room_id in sorted(os.listdir(src_rooms)):
            src_room = os.path.join(src_rooms, room_id)
            if not os.path.isdir(src_room):
                continue
            dst_zone = os.path.join(dst_board, "zones", room_id)
            os.makedirs(dst_zone, exist_ok=True)
            room = read_json(os.path.join(src_room, "room.json"), None)
            if room is not None:
                room["id"] = room_id
                room.setdefault("bg", "#fff8ec")
                write_json(os.path.join(dst_zone, "zone.json"), room)
            src_images = os.path.join(src_room, "images")
            if os.path.isdir(src_images):
                dst_images = os.path.join(dst_zone, "images")
                os.makedirs(dst_images, exist_ok=True)
                for name in os.listdir(src_images):
                    shutil.copy2(os.path.join(src_images, name),
                                 os.path.join(dst_images, name))
                    copied_images += 1

    write_json(os.path.join(dst_board, "board.json"), board)
    return {"id": board_id, "zones": len(zones), "images": copied_images}


def migrate_if_needed(root):
    """Import a legacy install once. Returns a summary, or None if not needed."""
    marker = os.path.join(root, ".migrated-from")
    if os.path.exists(marker):
        return None
    if os.path.isdir(BOARDS) and os.listdir(BOARDS):
        return None
    legacy = find_legacy(root)
    if not legacy:
        return None

    log("migrating from %s (copy only; the source is not modified)" % legacy)
    results = []
    for house_id in sorted(os.listdir(legacy)):
        src_house = os.path.join(legacy, house_id)
        if not os.path.isdir(src_house):
            continue
        result = _migrate_board(src_house, os.path.join(BOARDS, house_id), house_id)
        if result:
            results.append(result)
            log("  board %-16s %d zones, %d images"
                % (result["id"], result["zones"], result["images"]))

    write_json(marker, {"source": legacy, "at": now(), "boards": results})
    log("migration done: %d board(s)" % len(results))
    return results
