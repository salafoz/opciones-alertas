"""Servidor estático para probar la app en local: http://localhost:8787/docs/"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".webmanifest": "application/manifest+json"}

    def do_GET(self):
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/docs/")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    print("http://localhost:8787/docs/")
    ThreadingHTTPServer(("127.0.0.1", 8787), partial(Handler, directory=str(ROOT))).serve_forever()
