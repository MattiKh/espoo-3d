#!/usr/bin/env python3
"""Maastoeditori: paikallinen työkalu korkeusmallin korjaamiseen (ei julkaista Netlifyyn).

Avaa saman kartan kuin server.py, mutta sivulle tulee lisäksi editorin paneeli (editori/), jolla
maastoa voi nostaa, laskea, tasoittaa ja pehmentää siveltimellä. Korjaukset tallentuvat tiedostoon
korjaukset/maasto.json, ja ne leivotaan heti korkeusmallin tiiliin (scripts/maastokorjaus.py):
public/tiles/korkeuskorjaus ja public/data/maastokorjaukset.json. Ne julkaistaan kuten muukin
aineisto viemällä ne GitHubiin (editorin Julkaise-nappi tai git), jolloin Netlify julkaisee ne.

Käyttö:  python3 editori.py [--port 8766]
Tarvitsee numpyn ja Pillowin; jos ne ovat vain kansion .venv ympäristössä, editori käyttää sitä.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))

try:
    import numpy  # noqa: F401
    import PIL  # noqa: F401
except ImportError:
    venv = os.path.join(HERE, ".venv", "bin", "python")
    # Ympäristön python on linkki samaan tulkkiin, joten ympäristö tunnistetaan sys.prefixistä.
    if os.path.exists(venv) and os.path.realpath(sys.prefix) != os.path.realpath(os.path.join(HERE, ".venv")):
        os.execv(venv, [venv, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit("Maastoeditori tarvitsee Pythonin kirjastot numpy ja Pillow. Asenna ne omaan ympäristöön:\n"
             "  python3 -m venv .venv && .venv/bin/pip install numpy pillow\n"
             "ja käynnistä editori uudelleen:  python3 editori.py")

sys.path.insert(0, os.path.join(HERE, "scripts"))
import maastokorjaus as mk  # noqa: E402
from server import Handler as MapHandler  # noqa: E402

EDITOR = os.path.join(HERE, "editori")
# Siltakorjaukset: kartta (pelimaasto.js) lukee ne suoraan, joten erillistä leipomista ei ole.
BRIDGE_EDITS = os.path.join(HERE, "public", "data", "siltakorjaukset.json")
# Julkaistavat tiedostot: korjausten lähde, selaimen hakemisto, leivotut tiilet ja siltakorjaukset.
PUBLISH = [os.path.relpath(p, HERE) for p in (os.path.dirname(mk.EDITS), mk.INDEX, mk.OUT, BRIDGE_EDITS)]
LOCK = threading.Lock()


def load_bridges():
    if not os.path.exists(BRIDGE_EDITS):
        return []
    with open(BRIDGE_EDITS, encoding="utf-8") as fh:
        return json.load(fh).get("korjaukset", [])


def save_bridges(edits):
    rows = ",\n".join("  " + json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in edits)
    with open(BRIDGE_EDITS + ".tmp", "w", encoding="utf-8") as fh:
        fh.write('{\n "lahde": "Maastoeditorilla tehdyt siltakorjaukset (editori.py, pelimaasto.js)",\n "korjaukset": [\n'
                 + rows + ("\n" if rows else "") + " ]\n}\n")
    os.replace(BRIDGE_EDITS + ".tmp", BRIDGE_EDITS)


class State:
    """Korjaukset ja pohjatiilet muistissa; kaikki muutokset LOCKin alla."""

    def __init__(self):
        self.edits = mk.load_edits()
        self.bridges = load_bridges()
        self.bases, self.bases_mtime = None, None

    def get_bases(self):
        # sillat.json muuttuu, kun build_data.py ajetaan uudelleen; silloin pohjatiilet luetaan alusta.
        mtime = os.path.getmtime(mk.BRIDGES) if os.path.exists(mk.BRIDGES) else 0
        if self.bases is None or mtime != self.bases_mtime:
            self.bases, self.bases_mtime = mk.Bases(), mtime
        return self.bases


STATE = State()


def git(*args, check=True):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    r = subprocess.run(["git", *args], cwd=HERE, capture_output=True, text=True, env=env, timeout=120)
    if check and r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"git {args[0]} epäonnistui")
    return r


def publish_paths():
    """Julkaistavat polut, jotka ovat levyllä tai versionhallinnassa (git ei hyväksy muita polkuja)."""
    tracked = set(git("ls-files", "--", *PUBLISH).stdout.splitlines())
    return [p for p in PUBLISH if os.path.exists(os.path.join(HERE, p)) or any(t.startswith(p) for t in tracked)]


def git_status():
    """Haara ja julkaisemattomat maastokorjaukset (muuttuneet tiedostot ja GitHubiin viemättömät commitit)."""
    try:
        branch = git("branch", "--show-current").stdout.strip()
        changed = [l for l in git("status", "--porcelain", "--untracked-files=all", "--", *PUBLISH).stdout.splitlines() if l]
        ahead = git("rev-list", "--count", "@{u}..HEAD", check=False)
        return {"haara": branch, "muuttuneet": len(changed),
                "viemattomat": int(ahead.stdout.strip()) if ahead.returncode == 0 else None}
    except Exception as e:  # git puuttuu tai kansio ei ole repo
        return {"virhe": str(e)}


def snapshot(**extra):
    index = mk.load_index()
    tiles = {str(z): [v for xy in sorted(s) for v in xy] for z, s in index.items() if s}
    versio = 0
    if os.path.exists(mk.INDEX):
        with open(mk.INDEX, encoding="utf-8") as fh:
            versio = json.load(fh).get("versio", 0)
    return {"korjaukset": STATE.edits, "hakemisto": {"versio": versio, "tiilet": tiles}, "sillat": STATE.bridges,
            "git": git_status(), **extra}


def set_bridge(body):
    """Siltaosan korjaus (poisto, päiden jatko tai lyhennys, päätuet). Ilman muutoksia korjaus poistetaan."""
    bid = str(body.get("id") or "")
    if not bid or len(bid) > 200:
        raise ValueError("Siltaosan tunnus puuttuu")
    e = {"id": bid}
    if body.get("poista"):
        e["poista"] = True
    for key in ("alku", "loppu"):
        v = round(min(200.0, max(-200.0, float(body.get(key) or 0))), 1)
        if v and not e.get("poista"):
            e[key] = v
    tu = body.get("tu")
    if tu is not None and not e.get("poista"):
        e["tu"] = [1 if tu[0] else 0, 1 if tu[1] else 0]
    keep = len(e) > 1
    if keep:
        e["laji"] = str(body.get("laji") or "")[:20]
        e["keskipiste"] = [round(float(v), 6) for v in (body.get("keskipiste") or [0, 0])[:2]]
        e["pituus"] = round(float(body.get("pituus") or 0), 1)
        e["aika"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with LOCK:
        bridges = [b for b in STATE.bridges if b["id"] != bid] + ([e] if keep else [])
        save_bridges(bridges)
        STATE.bridges = bridges
    return snapshot()


def restore_bridge(body):
    return set_bridge({"id": body.get("id")})


def add_edit(body):
    e = mk.clean_edit(body)
    with LOCK:
        if any(x["id"] == e["id"] for x in STATE.edits):
            raise ValueError("Korjaus on jo tallennettu")
        bases = STATE.get_bases()
        if e["tyyppi"] == "tasoita" and "taso" not in e:
            # Taso on maanpinta vedon alussa aiempien korjausten jälkeen.
            e["taso"] = round(mk.height_at(*e["pisteet"][0], STATE.edits, bases), 3)
            e = {k: e[k] for k in ("id", "tyyppi", "sade", "kovuus", "taso", "pisteet", "aika")}
        edits = STATE.edits + [e]
        mk.bake(edits, [e], bases)
        mk.save_edits(edits)
        STATE.edits = edits
    return snapshot(lisatty=e)


def remove_edit(body):
    with LOCK:
        gone = [e for e in STATE.edits if e["id"] == body.get("id")]
        if not gone:
            raise ValueError("Korjausta ei löytynyt")
        edits = [e for e in STATE.edits if e["id"] != body["id"]]
        mk.bake(edits, gone, STATE.get_bases())
        mk.save_edits(edits)
        STATE.edits = edits
    return snapshot(poistettu=gone[0])


def height(query):
    q = urllib.parse.parse_qs(query)
    lon, lat = float(q["lon"][0]), float(q["lat"][0])
    with LOCK:
        return {"korkeus": round(mk.height_at(lon, lat, STATE.edits, STATE.get_bases()), 3)}


def publish(_body):
    """Vie korjaukset GitHubiin: commit vain korjausten tiedostoista ja push nykyiseen haaraan."""
    with LOCK:
        paths = publish_paths()
        if paths:
            git("add", "-A", "--", *paths)
        staged = bool(paths) and git("diff", "--cached", "--quiet", "--", *paths, check=False).returncode != 0
        log = []
        if staged:
            n, b = len(STATE.edits), len(STATE.bridges)
            msg = f"Maastokorjaukset: {n} korjaus{'ta' if n != 1 else ''}, {b} siltakorjaus{'ta' if b != 1 else ''} (maastoeditori)"
            log.append(git("commit", "-m", msg, "--", *paths).stdout.strip().splitlines()[0])
        status = git_status()
        if not staged and status.get("viemattomat") == 0:
            return snapshot(julkaisu="Ei julkaistavaa: korjaukset ovat jo GitHubissa.")
        push = git("push", "-u", "origin", "HEAD", check=False)
        if push.returncode:
            err = (push.stderr or push.stdout).strip()
            hint = " GitHubissa on uudempia muutoksia: aja ensin git pull ja julkaise sitten uudelleen." if "rejected" in err else ""
            raise RuntimeError(f"Vienti GitHubiin epäonnistui.{hint}\n{err}")
        branch = status.get("haara")
        note = "Netlify julkaisee ne hetken päästä." if branch == "main" else \
            f"Ne ovat haarassa {branch}; Netlify julkaisee ne, kun haara yhdistetään main-haaraan."
        return snapshot(julkaisu=f"Korjaukset viety GitHubiin. {note}", loki=log)


class Handler(MapHandler):
    """Kartta kuten server.py, lisäksi editorin tiedostot (/editori/) ja rajapinta (/api/)."""

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in ("/", "/index.html"):
            return self.send_page()
        if path == "/api/tila":
            return self.send_json(snapshot())
        if path == "/api/korkeus":
            return self.run(height, query)
        return super().do_GET()

    def do_POST(self):
        path = self.path.partition("?")[0]
        routes = {"/api/lisaa": add_edit, "/api/poista": remove_edit, "/api/julkaise": publish,
                  "/api/silta": set_bridge, "/api/silta/palauta": restore_bridge}
        if path not in routes:
            return self.send_error(404)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.send_json({"virhe": "Virheellinen pyyntö"}, 400)
        return self.run(routes[path], body)

    def run(self, fn, arg):
        try:
            self.send_json(fn(arg))
        except (ValueError, KeyError) as e:
            self.send_json({"virhe": str(e)}, 400)
        except Exception as e:  # leipominen, verkko tai git
            self.log_error("%s", e)
            self.send_json({"virhe": str(e)}, 500)

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_page(self):
        # Kartan oma sivu, johon lisätään editorin tyylit ja skripti.
        with open(os.path.join(self.directory, "index.html"), encoding="utf-8") as fh:
            page = fh.read()
        page = page.replace("<title>Espoo 3D</title>", "<title>Espoo 3D – maastoeditori</title>")
        page = page.replace("</head>", '  <link rel="stylesheet" href="editori/editori.css">\n</head>')
        page = page.replace("</body>", '  <script type="module" src="editori/editori.js"></script>\n</body>')
        body = page.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path):
        clean = urllib.parse.unquote(path.split("?")[0].split("#")[0])
        if clean.startswith("/editori/"):
            rel = os.path.normpath(clean[len("/editori/"):]).lstrip("/")
            if rel.startswith(".."):
                return os.path.join(EDITOR, "__ei__")
            return os.path.join(EDITOR, rel)
        return super().translate_path(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()
    import http.server
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Maastoeditori: http://localhost:{args.port}  ({len(STATE.edits)} korjausta)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
