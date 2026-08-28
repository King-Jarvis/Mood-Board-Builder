"""Reading image bytes: intrinsic size, fetching, and safe ingest.

Everything here was bug-fixed the hard way and is carried over unchanged in
behaviour:

* ``image_size`` parses PNG/GIF/JPEG/WebP headers so no imaging library is
  needed anywhere in the project.
* ``_SafeRedirect`` follows HTTP 308 (Python only learned to in 3.11, and
  Pinterest's ``pin.it`` share links answer 308, so without it every shared pin
  fails) and re-checks *every* hop of a redirect chain, closing the hole where
  a public URL redirects into private address space.
* ``store_image`` dedupes by content hash, so re-pasting the same pin is a
  no-op rather than a duplicate.
"""

import hashlib
import html
import ipaddress
import mimetypes
import os
import re
import socket
import struct
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

from . import storage

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

MAX_IMAGE_BYTES = 40 * 1024 * 1024

EXT_BY_TYPE = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
}


class FetchError(Exception):
    pass


def image_size(data):
    """Return (width, height) from raw image bytes, or (0, 0) if unknown.

    The browser recomputes this on load and patches anything we miss, so an
    unrecognised format degrades gracefully rather than failing ingest.
    """
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)

        if data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", data[6:10])
            return int(w), int(h)

        if data[:2] == b"\xff\xd8":  # JPEG: walk the marker chain to a SOF
            i = 2
            end = len(data)
            while i + 9 < end:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
                    i += 2
                    continue
                seglen = struct.unpack(">H", data[i + 2:i + 4])[0]
                # SOF0..SOF15, skipping DHT/JPG/DAC which share the range
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return int(w), int(h)
                i += 2 + seglen
            return 0, 0

        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X":
                w = int.from_bytes(data[24:27], "little") + 1
                h = int.from_bytes(data[27:30], "little") + 1
                return w, h
            if chunk == b"VP8 ":
                w = struct.unpack("<H", data[26:28])[0] & 0x3FFF
                h = struct.unpack("<H", data[28:30])[0] & 0x3FFF
                return int(w), int(h)
            if chunk == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    except (struct.error, IndexError, ValueError):
        pass
    return 0, 0


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Follow HTTP 308, and re-check every hop of a redirect chain.

    Pinterest's "Copy link" button hands out pin.it short URLs, and those
    answer 308 Permanent Redirect. Python only grew a built-in 308 handler in
    3.11, so on anything older every single pin.it link fails outright.

    Validating each hop also closes the hole where a public URL redirects into
    private address space -- checking only the URL the user pasted isn't enough.
    """

    def http_error_308(self, req, fp, code, msg, headers):
        return self.http_error_301(req, fp, 301, msg, headers)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        assert_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirect)


def assert_public_url(url):
    """Only http(s), and never a host that resolves into private space.

    This endpoint fetches URLs the user pastes, so a pasted (or pin-page
    embedded) link must not be usable to probe the local network.
    """
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError("only http/https URLs are allowed")
    if not parts.hostname:
        raise FetchError("no host in URL")
    try:
        infos = socket.getaddrinfo(parts.hostname, None)
    except socket.gaierror:
        raise FetchError("could not resolve %s" % parts.hostname)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise FetchError("refusing to fetch a private address (%s)" % ip)


def fetch(url, accept, limit):
    assert_public_url(url)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with _opener.open(req, timeout=25) as resp:
            body = resp.read(limit + 1)
            if len(body) > limit:
                raise FetchError("response too large")
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            return body, ctype, resp.geturl()
    except urllib.error.HTTPError as exc:
        raise FetchError("HTTP %s from %s" % (exc.code, url))
    except urllib.error.URLError as exc:
        raise FetchError("could not reach %s (%s)" % (url, exc.reason))
    except socket.timeout:
        raise FetchError("timed out fetching %s" % url)


_META_KEYS = r'(?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)'
META_PATTERNS = [
    re.compile(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']+)["\']'
               % _META_KEYS, re.I),
    re.compile(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']%s["\']'
               % _META_KEYS, re.I),
    # Last resort: Pinterest embeds the full-size pin in its JSON payload.
    re.compile(r'["\'](https://i\.pinimg\.com/(?:originals|\d+x)/[^"\'\\]+)["\']', re.I),
]


def resolve_image_url(url):
    """A pin page URL becomes its og:image; an image URL passes through."""
    parts = urllib.parse.urlsplit(url)
    path = parts.path.lower()
    looks_like_image = any(path.endswith(e) for e in
                           (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"))
    if looks_like_image:
        return url

    body, ctype, final = fetch(url, "text/html,application/xhtml+xml", 3 * 1024 * 1024)
    if ctype.startswith("image/"):
        return final

    text = body.decode("utf-8", "ignore")
    for pattern in META_PATTERNS:
        match = pattern.search(text)
        if match:
            found = html.unescape(match.group(1))
            return urllib.parse.urljoin(final, found)
    raise FetchError("no image found on that page -- right-click the pin, "
                     "Copy Image, and paste it here instead")


def store_image(board_id, zone_id, data, ctype, src):
    """Write bytes into the zone, deduped by content hash. Returns metadata."""
    if not ctype.startswith("image/"):
        raise FetchError("that URL is not an image (got %s)" % (ctype or "unknown"))
    sha = hashlib.sha256(data).hexdigest()
    ext = EXT_BY_TYPE.get(ctype) or mimetypes.guess_extension(ctype) or ".jpg"
    images = os.path.join(storage.zone_dir(board_id, zone_id), "images")
    os.makedirs(images, exist_ok=True)
    filename = sha + ext
    path = os.path.join(images, filename)
    if not os.path.exists(path):
        fd, tmp = tempfile.mkstemp(dir=images, suffix=".tmp")
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    width, height = image_size(data)
    return {"sha": sha, "file": filename, "w": width, "h": height,
            "src": src, "color": None}


def ingest_urls(board_id, zone_id, urls):
    zone = storage.load_zone(board_id, zone_id)
    added, skipped, errors = [], [], []
    for raw in urls:
        raw = raw.strip()
        if not raw:
            continue
        started = time.time()
        try:
            image_url = resolve_image_url(raw)
            data, ctype, final = fetch(image_url, "image/*", MAX_IMAGE_BYTES)
            if not ctype.startswith("image/"):
                ctype = mimetypes.guess_type(final)[0] or ""
            meta = store_image(board_id, zone_id, data, ctype, raw)
            storage.log("ingest %s ok %.1fs %sx%s <- %s"
                % (zone_id, time.time() - started, meta["w"], meta["h"], raw))
        except FetchError as exc:
            storage.log("ingest %s FAILED %.1fs: %s <- %s"
                % (zone_id, time.time() - started, exc, raw))
            errors.append({"url": raw, "error": str(exc)})
            continue
        except Exception as exc:  # noqa: BLE001 - surface, never crash ingest
            storage.log("ingest %s CRASHED <- %s\n%s" % (zone_id, raw, traceback.format_exc()))
            errors.append({"url": raw, "error": "%s: %s" % (type(exc).__name__, exc)})
            continue

        sha = meta["sha"]
        if sha in zone["images"]:
            skipped.append(sha)
            continue
        zone["images"][sha] = meta
        zone["candidates"].insert(0, sha)
        added.append(meta)

    if added:
        storage.save_zone(board_id, zone_id, zone)
    return {"added": added, "skipped": skipped, "errors": errors, "zone": zone}

