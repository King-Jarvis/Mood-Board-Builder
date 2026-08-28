"""HTTP layer: routing, request handling, static and data serving."""

import json
import mimetypes
import os
import re
import shutil
import socket
import sys
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import storage
from .images import EXT_BY_TYPE, MAX_IMAGE_BYTES, FetchError, image_size, \
    ingest_urls, store_image

PACKAGE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(PACKAGE, "static")

ROUTES = [
    ("boards", re.compile(r"^/api/boards$")),
    ("board", re.compile(r"^/api/boards/([^/]+)$")),
    ("background", re.compile(r"^/api/boards/([^/]+)/background$")),
    ("cover", re.compile(r"^/api/boards/([^/]+)/cover$")),
    ("rename_id", re.compile(r"^/api/boards/([^/]+)/zones/([^/]+)/rename-id$")),
    ("ingest", re.compile(r"^/api/boards/([^/]+)/zones/([^/]+)/ingest$")),
    ("upload", re.compile(r"^/api/boards/([^/]+)/zones/([^/]+)/upload$")),
    ("image", re.compile(r"^/api/boards/([^/]+)/zones/([^/]+)/images/([^/]+)$")),
    ("zone", re.compile(r"^/api/boards/([^/]+)/zones/([^/]+)$")),
    ("export", re.compile(r"^/api/export$")),
]


class Handler(BaseHTTPRequestHandler):
    server_version = "MoodBoardBuilder/2.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt, *args):
        if os.environ.get("MOODBOARDS_VERBOSE"):
            storage.log(fmt % args)

    def log_error(self, fmt, *args):
        storage.log("http error: %s" % (fmt % args))

    def handle_one_request(self):
        # A handler thread that dies takes its connection with it, which the
        # browser sees as the page hanging. Log it instead of losing it.
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            storage.log("handler crashed:\n%s" % traceback.format_exc())
            self.close_connection = True

    def _send(self, code, body=b"", ctype="application/octet-stream", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def json_out(self, payload, code=200):
        body = json.dumps(payload).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def fail(self, code, message):
        storage.log("%s %s -> %s %s" % (self.command, self.path, code, message))
        # An unread request body would be parsed as the next request on a
        # keep-alive connection, desynchronising it and hanging the page.
        self.drain_body()
        self.json_out({"error": message}, code)

    def drain_body(self):
        if getattr(self, "_body_read", False):
            return
        remaining = int(self.headers.get("Content-Length") or 0)
        self._body_read = True
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            remaining -= len(chunk)

    def body_bytes(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._body_read = True
            return b""
        if length > MAX_IMAGE_BYTES:
            self.drain_body()
            raise FetchError("payload too large (%.0f MB, limit %.0f MB)"
                             % (length / 1e6, MAX_IMAGE_BYTES / 1e6))
        data = self.rfile.read(length)
        self._body_read = True
        return data

    def body_json(self):
        raw = self.body_bytes()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def query(self):
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)

    def match(self):
        path = urllib.parse.urlsplit(self.path).path
        for name, pattern in ROUTES:
            found = pattern.match(path)
            if found:
                return name, found.groups()
        return None, ()

    # -- verbs ------------------------------------------------------------

    def do_GET(self):
        try:
            name, args = self.match()
            if name:
                return self.api(name, args)
            return self.serve_static()
        except ValueError as exc:
            return self.fail(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            storage.log("GET %s failed:\n%s" % (self.path, traceback.format_exc()))
            return self.fail(500, "%s: %s" % (type(exc).__name__, exc))

    do_HEAD = do_GET

    def _mutate(self):
        try:
            name, args = self.match()
            if not name:
                return self.fail(404, "no such endpoint")
            return self.api(name, args)
        except (ValueError, FetchError) as exc:
            return self.fail(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            storage.log("%s %s failed:\n%s" % (self.command, self.path,
                                               traceback.format_exc()))
            return self.fail(500, "%s: %s" % (type(exc).__name__, exc))

    do_POST = _mutate
    do_PUT = _mutate
    do_DELETE = _mutate

    # -- api --------------------------------------------------------------

    def api(self, name, args):
        method = "GET" if self.command == "HEAD" else self.command
        handler = getattr(self, "api_" + name, None)
        if handler is None:
            return self.fail(404, "no such endpoint")
        return handler(method, args)

    def api_boards(self, method, args):
        if method == "GET":
            return self.json_out({"boards": storage.list_boards()})
        if method == "POST":
            payload = self.body_json()
            name = (payload.get("name") or "Untitled board").strip()
            taken = {b["id"] for b in storage.list_boards()}
            board_id = storage.unique_id(name, taken, "board")
            label = payload.get("zoneLabel") or {}
            board = storage.default_board(
                board_id, name=name,
                subject=(payload.get("subject") or "").strip(),
                zone_one=(label.get("one") or "Zone").strip(),
                zone_many=(label.get("many") or "Zones").strip())
            if payload.get("canvas"):
                board["canvas"] = payload["canvas"]
            storage.save_board(board_id, board)
            storage.log("created board %s (%s)" % (board_id, name))
            return self.json_out(board, 201)
        return self.fail(405, "%s not allowed" % self.command)

    def api_board(self, method, args):
        board_id = storage.safe_id(args[0])
        if method == "GET":
            board = storage.load_board(board_id, create=False)
            if board is None:
                return self.fail(404, "no board %r" % board_id)
            out = dict(board)
            out["counts"] = storage.counts_for(board_id, board)
            return self.json_out(out)
        if method == "PUT":
            incoming = self.body_json()
            existing = storage.load_board(board_id, create=True)
            # Response-only fields must never be written back to disk.
            for key in ("counts",):
                incoming.pop(key, None)
            existing.update(incoming)
            storage.save_board(board_id, existing)
            out = dict(existing)
            out["counts"] = storage.counts_for(board_id, existing)
            return self.json_out(out)
        if method == "DELETE":
            board = storage.load_board(board_id)
            if board is None:
                return self.fail(404, "no board %r" % board_id)
            confirm = (self.query().get("confirm") or [""])[0]
            if confirm != board.get("name"):
                return self.fail(400, "deleting a board requires ?confirm=<its exact name>")
            storage.delete_board(board_id)
            storage.log("deleted board %s" % board_id)
            return self.json_out({"deleted": board_id})
        return self.fail(405, "%s not allowed" % self.command)

    def api_background(self, method, args):
        board_id = storage.safe_id(args[0])
        board = storage.load_board(board_id, create=True)
        directory = storage.board_dir(board_id)
        if method == "POST":
            data = self.body_bytes()
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].lower()
            if not ctype.startswith("image/"):
                return self.fail(400, "background must be an image")
            ext = EXT_BY_TYPE.get(ctype, ".png")
            os.makedirs(directory, exist_ok=True)
            for old in os.listdir(directory):
                if old.startswith("background."):
                    os.unlink(os.path.join(directory, old))
            filename = "background" + ext
            with open(os.path.join(directory, filename), "wb") as fh:
                fh.write(data)
            width, height = image_size(data)
            board["background"] = {"file": filename, "w": width, "h": height}
            storage.save_board(board_id, board)
            return self.json_out(board)
        if method == "DELETE":
            if os.path.isdir(directory):
                for old in os.listdir(directory):
                    if old.startswith("background."):
                        os.unlink(os.path.join(directory, old))
            board["background"] = None
            storage.save_board(board_id, board)
            return self.json_out(board)
        return self.fail(405, "%s not allowed" % self.command)

    def api_cover(self, method, args):
        """Stream a board's cover image, so dashboard cards need one request."""
        board_id = storage.safe_id(args[0])
        board = storage.load_board(board_id)
        if board is None:
            return self.fail(404, "no board")
        cover = storage.pick_cover(board_id, board)
        if not cover:
            return self.fail(404, "no cover")
        return self.send_file(os.path.join(
            storage.images_dir(board_id, cover["zone"]), cover["file"]))

    def api_zone(self, method, args):
        board_id, zone_id = storage.safe_id(args[0]), storage.safe_id(args[1])
        if method == "GET":
            return self.json_out(storage.load_zone(board_id, zone_id))
        if method == "PUT":
            storage.save_zone(board_id, zone_id, self.body_json())
            storage.save_board(board_id, storage.load_board(board_id, create=True))
            return self.json_out(storage.load_zone(board_id, zone_id))
        return self.fail(405, "%s not allowed" % self.command)

    def api_rename_id(self, method, args):
        """Move a zone's folder so a typo made at creation isn't permanent."""
        if method != "POST":
            return self.fail(405, "%s not allowed" % self.command)
        board_id, zone_id = storage.safe_id(args[0]), storage.safe_id(args[1])
        board = storage.load_board(board_id)
        if board is None:
            return self.fail(404, "no board")
        payload = self.body_json()
        raw = (payload.get("newId") or "").strip()
        taken = {z["id"] for z in board.get("zones", []) if z["id"] != zone_id}
        new_id = storage.safe_id(storage.unique_id(raw or zone_id, taken))
        if new_id == zone_id:
            return self.json_out(board)

        src, dst = storage.zone_dir(board_id, zone_id), storage.zone_dir(board_id, new_id)
        if os.path.exists(dst):
            return self.fail(409, "a zone folder named %r already exists" % new_id)
        if os.path.isdir(src):
            shutil.move(src, dst)
        for zone in board.get("zones", []):
            if zone["id"] == zone_id:
                zone["id"] = new_id
        cover = board.get("cover")
        if cover and cover.get("zone") == zone_id:
            cover["zone"] = new_id
        storage.save_board(board_id, board)
        storage.log("renamed zone folder %s -> %s on %s" % (zone_id, new_id, board_id))
        out = dict(board)
        out["counts"] = storage.counts_for(board_id, board)
        out["newId"] = new_id
        return self.json_out(out)

    def api_ingest(self, method, args):
        if method != "POST":
            return self.fail(405, "%s not allowed" % self.command)
        board_id, zone_id = storage.safe_id(args[0]), storage.safe_id(args[1])
        payload = self.body_json()
        urls = payload.get("urls") or []
        if isinstance(urls, str):
            urls = re.split(r"\s+", urls)
        if len(urls) > 60:
            return self.fail(400, "too many URLs at once (max 60)")
        result = ingest_urls(board_id, zone_id, urls)
        result["zone"] = result.pop("zone", result.get("zone"))
        return self.json_out(result)

    def api_upload(self, method, args):
        if method != "POST":
            return self.fail(405, "%s not allowed" % self.command)
        board_id, zone_id = storage.safe_id(args[0]), storage.safe_id(args[1])
        data = self.body_bytes()
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].lower()
        src = self.headers.get("X-Source") or "pasted"
        meta = store_image(board_id, zone_id, data, ctype, src)
        zone = storage.load_zone(board_id, zone_id)
        if meta["sha"] in zone["images"]:
            return self.json_out({"added": [], "skipped": [meta["sha"]],
                                  "errors": [], "zone": zone})
        zone["images"][meta["sha"]] = meta
        zone["candidates"].insert(0, meta["sha"])
        storage.save_zone(board_id, zone_id, zone)
        return self.json_out({"added": [meta], "skipped": [],
                              "errors": [], "zone": zone})

    def api_image(self, method, args):
        if method != "DELETE":
            return self.fail(405, "%s not allowed" % self.command)
        board_id, zone_id, sha = (storage.safe_id(args[0]),
                                  storage.safe_id(args[1]), args[2])
        if not storage.SAFE_SHA.match(sha):
            return self.fail(400, "bad image id")
        zone = storage.load_zone(board_id, zone_id)
        meta = zone["images"].pop(sha, None)
        zone["candidates"] = [s for s in zone["candidates"] if s != sha]
        zone["selected"] = [s for s in zone["selected"] if s.get("sha") != sha]
        if meta:
            path = os.path.join(storage.images_dir(board_id, zone_id), meta["file"])
            if os.path.exists(path):
                os.unlink(path)
        storage.save_zone(board_id, zone_id, zone)
        return self.json_out(zone)

    def api_export(self, method, args):
        if method != "POST":
            return self.fail(405, "%s not allowed" % self.command)
        data = self.body_bytes()
        filename = os.path.basename(self.headers.get("X-Filename") or "board.png")
        filename = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "board.png"
        os.makedirs(storage.EXPORTS, exist_ok=True)
        target = os.path.join(storage.EXPORTS, filename)
        with open(target, "wb") as fh:
            fh.write(data)
        return self.json_out({"saved": target})

    # -- static -----------------------------------------------------------

    def serve_static(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path in ("/", "/index.html"):
            return self.send_file(os.path.join(STATIC, "index.html"))
        if path == "/favicon.ico":
            # The page supplies its own inline favicon; answer the browser's
            # automatic probe quietly so it doesn't clutter the log.
            return self._send(204)

        if path.startswith("/static/"):
            base, rel = STATIC, path[len("/static/"):]
        elif path.startswith("/data/"):
            base, rel = storage.ROOT, path[len("/data/"):]
        else:
            return self.fail(404, "not found")

        target = os.path.normpath(os.path.join(base, rel.lstrip("/")))
        real_base = os.path.realpath(base)
        if not (target.startswith(real_base + os.sep) or target.startswith(base + os.sep)):
            return self.fail(403, "forbidden")
        return self.send_file(target)

    def send_file(self, path):
        if not os.path.isfile(path):
            return self.fail(404, "not found")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif path.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        with open(path, "rb") as fh:
            body = fh.read()
        self._send(200, body, ctype)


def bind(host, preferred):
    for port in range(preferred, preferred + 25):
        try:
            server = ThreadingHTTPServer((host, port), Handler)
            server.daemon_threads = True
            return server, port
        except OSError:
            continue
    raise SystemExit("no free port in range %d-%d" % (preferred, preferred + 24))


def lan_address():
    """Best guess at this machine's address on the LAN, for the banner."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "this-machine"
    finally:
        probe.close()
