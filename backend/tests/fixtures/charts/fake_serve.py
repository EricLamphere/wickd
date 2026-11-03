"""Stands in for `dct serve`: prints the URL line dct prints, then serves 200s on that port."""

import http.server
import sys

port = int(sys.argv[sys.argv.index("--port") + 1])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args: object) -> None:
        pass


server = http.server.HTTPServer(("127.0.0.1", port), Handler)
print(f"   URL: http://127.0.0.1:{port}", flush=True)
server.serve_forever()
