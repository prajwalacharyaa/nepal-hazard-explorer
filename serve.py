#!/usr/bin/env python3
"""Serve the explorer locally, from the correct root.

    python serve.py

Serves the project root and opens the map. Double-clicking index.html will not
work: the browser blocks a file:// page from reading the data alongside it.
"""
from __future__ import annotations

import argparse
import http.server
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # never serve a stale build while iterating
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            sys.stderr.write("  404  %s\n" % (args[0] if args else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-p", "--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    data = ROOT / "data" / "processed" / "events.geojson"
    if not data.exists():
        print("! data/processed/events.geojson is missing — the map will show an error.")
        print("  Build it first:  cd pipeline && python clean_merge.py && python aggregate.py\n")

    url = f"http://localhost:{args.port}/"
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("127.0.0.1", args.port), Handler) as httpd:
            print(f"Serving {ROOT}")
            print(f"Open {url}   (Ctrl+C to stop)")
            if not args.no_browser:
                threading.Timer(0.6, lambda: webbrowser.open(url)).start()
            httpd.serve_forever()
    except OSError as e:
        raise SystemExit(f"Could not bind port {args.port}: {e}\nTry: python serve.py -p 8001")
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
