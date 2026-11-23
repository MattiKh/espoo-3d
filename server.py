#!/usr/bin/env python3
"""Paikallinen palvelin Espoo 3D -kartalle.

Jakaa public/-kansion ja välittää HSY:n WMS-kuvat, koska HSY:n palvelin ei salli
selaimen suoria hakuja muista osoitteista (CORS).

Käyttö:  python3 server.py [--port 8765]
"""
import argparse
import http.server
import os
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
PROXIES = {"/proxy/hsy/wms": "https://kartta.hsy.fi/geoserver/wms"}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".pbf": "application/x-protobuf", ".geojson": "application/geo+json"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in PROXIES:
            return self.proxy(PROXIES[path] + "?" + query)
        return super().do_GET()

    def proxy(self, url):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "espoo3d-local-proxy/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "max-age=86400")
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, str(e.reason))
        except Exception as e:  # verkkovirhe tai aikakatkaisu
            self.send_error(502, str(e))

    def end_headers(self):
        path = self.path.split("?")[0]
        # Vektoritiilet ovat gzip-pakattuja, mutta selain purkaa ne itse (app.js), jotta
        # sama toimii tavallisilla staattisilla julkaisupalvelimilla.
        # Paikalliset tiedostot muuttuvat aineistojen päivityksessä, joten selain tarkistaa ne aina.
        if not path.startswith("/proxy/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_error(self, code, message=None, explain=None):
        # Puuttuva vektoritiili tarkoittaa tyhjää aluetta, ei virhettä.
        if code == 404 and self.path.split("?")[0].endswith(".pbf"):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            http.server.BaseHTTPRequestHandler.end_headers(self)
            return
        super().send_error(code, message, explain)

    def log_message(self, fmt, *args):
        if args and str(args[1])[0] in "45":  # vain virheet näkyviin
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Espoo 3D: http://localhost:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
