# Tiny static dev server with correct MIME types.
# (Plain `python -m http.server` reads MIME types from the Windows registry,
# which frequently maps .js to text/plain — ES modules then refuse to load.)
#
# Usage:  python serve.py [port]      (default 8917)

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        # Dev helper: POST /__shot?name=foo saves the request body (a JPEG)
        # to _shots/foo.jpg — handy for headless visual checks.
        if self.path.startswith("/__shot"):
            import os
            from urllib.parse import urlparse, parse_qs
            name = parse_qs(urlparse(self.path).query).get("name", ["shot"])[0]
            name = "".join(ch for ch in name if ch.isalnum() or ch in "-_") or "shot"
            os.makedirs("_shots", exist_ok=True)
            length = int(self.headers.get("Content-Length", 0))
            with open(os.path.join("_shots", f"{name}.jpg"), "wb") as f:
                f.write(self.rfile.read(length))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8917
    print(f"particletoy dev server at http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
