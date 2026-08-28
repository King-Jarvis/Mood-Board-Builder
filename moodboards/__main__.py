"""Entry point: python3 -m moodboards"""

import argparse
import mimetypes
import os
import threading
import webbrowser

from . import server, storage


def main():
    parser = argparse.ArgumentParser(
        prog="moodboards", description="Mood Board Builder")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="open a browser")
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="address to bind. Default 127.0.0.1 (this machine only). "
             "Use 0.0.0.0 to serve the local network -- there is no "
             "authentication; see the warning printed on startup.")
    parser.add_argument(
        "--data", default=None,
        help="where boards and images live. Default $MOODBOARDS_DATA, "
             "else ~/.moodboards. Never inside the repo.")
    args = parser.parse_args()

    root = storage.configure(storage.resolve_root(args.data))
    mimetypes.add_type("image/webp", ".webp")
    mimetypes.add_type("image/avif", ".avif")

    # One-time, copy-only import from the pre-repo house-only layout.
    storage.migrate_if_needed(root)

    httpd, port = server.bind(args.host, args.port)
    url = "http://127.0.0.1:%d/" % port
    storage.log("--- started on %s host=%s (pid %d) ---"
                % (url, args.host, os.getpid()))
    print("Mood Board Builder  ->  %s" % url)
    if args.host not in ("127.0.0.1", "localhost"):
        print("            also on  ->  http://%s:%d/" % (server.lan_address(), port))
        print("")
        print("  ! Bound to %s, so anyone who can reach this machine on the" % args.host)
        print("    network can open, edit and delete these boards. There is no")
        print("    password. Only do this on a network you trust.")
        print("")
    print("data: %s" % root)
    print("log:  %s" % storage.LOGFILE)
    print("Ctrl-C to stop.")

    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
