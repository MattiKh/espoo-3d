#!/usr/bin/env python3
"""Maastokorjaukset: käsin tehdyt korkeusmallin korjaukset (maastoeditori, editori.py).

Korjaukset ovat tiedostossa korjaukset/maasto.json siveltimen vetoina: nosta, laske, tasoita,
pehmennä ja palauta. Ne leivotaan korkeusmallin tiiliin kansioon public/tiles/korkeuskorjaus, ja
public/data/maastokorjaukset.json kertoo selaimelle (bridges.js), mitkä tiilet on korjattu.

Pohjana on sama tiili, jonka kartta muuten hakisi: siltojen kohdalla build_data.py:n nostama tai
pelillinen tiili (public/tiles/korkeus, sillat.json), muualla Mapterhornin alkuperäinen. Vedot
lasketaan tarkimmille tiilille (taso 15, noin 1,2 m pikseli), ja karkeampien tasojen (14 ja 13)
korjaus on tarkimpien korjausten keskiarvo, joten pinta on sama kaikilla tasoilla.

Korjaukset ovat erillään build_data.py:n tiilistä, joten aineistojen päivitys ei hävitä niitä:
build_data.py leipoo ne uudelleen siltojen jälkeen uusien pohjatiilten päälle.

Käyttö:  python3 scripts/maastokorjaus.py   (leipoo kaikki korjaukset uudelleen)
"""
import json
import math
import os
import shutil
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
EDITS = os.path.join(ROOT, "korjaukset", "maasto.json")  # lähde: ei julkaista, mutta on versionhallinnassa
INDEX = os.path.join(PUBLIC, "data", "maastokorjaukset.json")
OUT = os.path.join(PUBLIC, "tiles", "korkeuskorjaus")
BRIDGES = os.path.join(PUBLIC, "data", "sillat.json")
LIFTED = os.path.join(PUBLIC, "tiles", "korkeus")
CACHE = os.path.join(ROOT, "cache", "korkeus")  # sama välimuisti kuin build_data.py:n dem_tile
DEM_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
UA = "espoo3d-maastoeditori/1.0"

ZOOM = 15  # vedot lasketaan tälle tasolle
COARSE = (14, 13)  # nämä kootaan tarkemman tason korjauksista
SIZE = 512  # korkeusmallin tiilen leveys (px)
EARTH_CIRC = 40075016.686
TYPES = ("nosta", "laske", "tasoita", "pehmenna", "palauta")
BOUNDS = (23.9, 59.8, 25.4, 60.6)  # kartan maxBounds (app.js)
CHANGED = 1e-6  # m: tätä pienempi ero ei ole muutos


def merc(lon, lat):
    """Web Mercator -yksiköt 0–1 kuten karttatiilissä."""
    return (lon + 180) / 360, (1 - math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi) / 2


def lat_of(y):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y))))


def terrarium(h):
    v = np.clip(h + 32768, 0, 65535.996)
    return np.stack([v // 256, np.floor(v) % 256, np.floor((v - np.floor(v)) * 256)], axis=-1).astype(np.uint8)


def read_tile(path):
    """Tiilen RGB-taulukko ja korkeudet metreinä (Terrarium)."""
    rgb = np.array(Image.open(path).convert("RGB"))
    if rgb.shape[:2] != (SIZE, SIZE):
        raise ValueError(f"Odottamaton tiilen koko {rgb.shape[:2]}: {path}")
    return rgb, rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def tile_path(z, x, y):
    return os.path.join(OUT, str(z), str(x), f"{y}.webp")


# --- Korjaukset -------------------------------------------------------------------------------------

def load_edits():
    if not os.path.exists(EDITS):
        return []
    with open(EDITS, encoding="utf-8") as fh:
        return json.load(fh).get("korjaukset", [])


def save_edits(edits):
    """Yksi korjaus riviä kohden, jotta muutokset näkyvät versionhallinnassa selkeinä."""
    os.makedirs(os.path.dirname(EDITS), exist_ok=True)
    rows = ",\n".join("  " + json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in edits)
    tmp = EDITS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write('{\n "korjaukset": [\n' + rows + ("\n" if rows else "") + " ]\n}\n")
    os.replace(tmp, EDITS)


def clean_edit(e):
    """Tarkistettu ja siistitty korjaus (editorin lähettämä); virheestä ValueError."""
    t = e.get("tyyppi")
    if t not in TYPES:
        raise ValueError(f"Tuntematon työkalu: {t}")
    pts = e.get("pisteet") or []
    if not 1 <= len(pts) <= 5000:
        raise ValueError("Vedossa ei ole pisteitä")
    out_pts = []
    for p in pts:
        lon, lat = float(p[0]), float(p[1])
        if not (BOUNDS[0] < lon < BOUNDS[2] and BOUNDS[1] < lat < BOUNDS[3]):
            raise ValueError("Veto on kartan alueen ulkopuolella")
        out_pts.append([round(lon, 7), round(lat, 7)])
    out = {"id": str(e.get("id") or f"k{time.time_ns()}"), "tyyppi": t,
           "sade": round(min(200.0, max(0.5, float(e.get("sade", 5)))), 2),
           "kovuus": round(min(1.0, max(0.0, float(e.get("kovuus", 0.5)))), 2)}
    if t in ("nosta", "laske"):
        out["maara"] = round(min(50.0, max(0.01, float(e.get("maara", 1)))), 3)
    elif t == "tasoita" and e.get("taso") is not None:
        out["taso"] = round(min(500.0, max(-100.0, float(e["taso"]))), 3)
    elif t in ("pehmenna", "palauta"):
        out["voimakkuus"] = round(min(1.0, max(0.05, float(e.get("voimakkuus", 1)))), 2)
    out["pisteet"] = out_pts
    out["aika"] = e.get("aika") or time.strftime("%Y-%m-%dT%H:%M:%S")
    return out


class Stroke:
    """Veto Web Mercator -yksiköissä: pisteet, säde ja ulottuma (pehmennys lukee säteen verran kauempaa)."""

    def __init__(self, e):
        self.e = e
        pts = np.array([merc(lon, lat) for lon, lat in e["pisteet"]], float)
        lat0 = e["pisteet"][0][1]
        self.unit = EARTH_CIRC * math.cos(math.radians(lat0))  # m / Mercator-yksikkö tällä leveysasteella
        self.pts = pts
        self.r = e["sade"] / self.unit
        reach = self.r * (2 if e["tyyppi"] == "pehmenna" else 1)
        self.box = (pts[:, 0].min() - reach, pts[:, 1].min() - reach, pts[:, 0].max() + reach, pts[:, 1].max() + reach)

    def tiles(self, z):
        n = 2 ** z
        x0, y0, x1, y1 = self.box
        return {(tx, ty) for tx in range(int(x0 * n), int(x1 * n) + 1) for ty in range(int(y0 * n), int(y1 * n) + 1)}

    def weights(self, X, Y):
        """Siveltimen paino ruudukon pikseleille (X: sarakkeiden, Y: rivien keskipisteet Mercator-yksiköissä):
        (r0, r1, c0, c1, w) tai None, jos veto ei osu ruudukkoon. Paino on 1 vedon keskilinjan lähellä
        (kovuus × säde) ja laskee pehmeästi nollaan säteen etäisyydellä."""
        x0, y0, x1, y1 = self.pts[:, 0].min() - self.r, self.pts[:, 1].min() - self.r, self.pts[:, 0].max() + self.r, self.pts[:, 1].max() + self.r
        c0, c1 = np.searchsorted(X, x0), np.searchsorted(X, x1, side="right")
        r0, r1 = np.searchsorted(Y, y0), np.searchsorted(Y, y1, side="right")
        if c0 >= c1 or r0 >= r1:
            return None
        gx = (X[c0:c1] - self.pts[0, 0]) * self.unit  # m itään
        gy = (Y[r0:r1] - self.pts[0, 1]) * self.unit  # m etelään
        p = (self.pts - self.pts[0]) * self.unit
        R = self.e["sade"]
        d2 = np.full((r1 - r0, c1 - c0), np.inf)
        segs = [(p[0], p[0])] if len(p) == 1 else list(zip(p[:-1], p[1:]))
        for a, b in segs:
            # Vain janan ympäristö, jotta pitkä veto ei laske jokaista janaa koko alueelle.
            sc0, sc1 = np.searchsorted(gx, min(a[0], b[0]) - R), np.searchsorted(gx, max(a[0], b[0]) + R, side="right")
            sr0, sr1 = np.searchsorted(gy, min(a[1], b[1]) - R), np.searchsorted(gy, max(a[1], b[1]) + R, side="right")
            if sc0 >= sc1 or sr0 >= sr1:
                continue
            px, py = gx[None, sc0:sc1], gy[sr0:sr1, None]
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy
            t = np.clip(((px - a[0]) * dx + (py - a[1]) * dy) / L2, 0, 1) if L2 > 0 else 0.0
            d = (px - a[0] - t * dx) ** 2 + (py - a[1] - t * dy) ** 2
            np.minimum(d2[sr0:sr1, sc0:sc1], d, out=d2[sr0:sr1, sc0:sc1])
        d = np.sqrt(d2)
        inner = R * self.e["kovuus"]
        if inner >= R:
            w = (d <= R).astype(float)
        else:
            t = np.clip((R - d) / (R - inner), 0, 1)
            w = t * t * (3 - 2 * t)
        if not w.any():
            return None
        return r0, r1, c0, c1, w


def box_blur(a, rad, axis):
    """Liukuva keskiarvo (2 × rad + 1 pikseliä) akselin suuntaan; reunoilla toistetaan reunan arvoa."""
    pad = [(0, 0), (0, 0)]
    pad[axis] = (rad + 1, rad)
    c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
    n, k = a.shape[axis], 2 * rad + 1
    return (c[k:k + n] - c[:n]) / k if axis == 0 else (c[:, k:k + n] - c[:, :n]) / k


def blur(a, sigma_px):
    """Gaussin sumennuksen likiarvo kolmella liukuvalla keskiarvolla."""
    rad = max(1, int(round(sigma_px)))
    for _ in range(3):
        a = box_blur(box_blur(a, rad, 0), rad, 1)
    return a


# --- Pohjatiilet ------------------------------------------------------------------------------------

class Bases:
    """Tiili, jonka kartta hakisi ilman korjauksia (sama päättely kuin bridges.js:n liftedTileUrl)."""

    def __init__(self):
        idx = {}
        if os.path.exists(BRIDGES):
            with open(BRIDGES, encoding="utf-8") as fh:
                idx = json.load(fh)
        keys = lambda d: {(int(z), xy[i], xy[i + 1]) for z, xy in d.items() for i in range(0, len(xy), 2)}
        self.lifted = keys(idx.get("korkeus", {}))
        self.game = keys(idx.get("korkeus_peli", {}))
        self.game_orig = keys(idx.get("korkeus_peli_alkup", {}))
        self.cache = {}

    def path(self, z, x, y):
        k = (z, x, y)
        if k in self.game:
            return os.path.join(LIFTED, "peli", str(z), str(x), f"{y}.webp")
        if k in self.lifted and k not in self.game_orig:
            return os.path.join(LIFTED, str(z), str(x), f"{y}.webp")
        return mapterhorn(z, x, y)

    def read(self, z, x, y):
        k = (z, x, y)
        if k not in self.cache:
            if len(self.cache) > 64:
                self.cache.pop(next(iter(self.cache)))
            self.cache[k] = read_tile(self.path(z, x, y))
        return self.cache[k]


def mapterhorn(z, x, y):
    path = os.path.join(CACHE, str(z), f"{x}_{y}.webp")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = DEM_URL.format(z=z, x=x, y=y)
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(path + ".part", "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(path + ".part", path)
            return path
        except Exception as e:  # verkkovirhe: yritetään uudelleen
            if attempt == 2:
                raise RuntimeError(f"Korkeusmallin tiiltä ei saatu: {url} ({e})")
            time.sleep(2 * (attempt + 1))


# --- Leipominen -------------------------------------------------------------------------------------

def apply_strokes(z, tx, ty, strokes, bases):
    """Tiilen korkeudet vetojen jälkeen: (pohjan rgb, pohja, uusi). Pehmennys lukee ympäristöä, joten
    silloin tiilen ympärille otetaan naapuritiilistä reunus, jottei tiilten saumaan jää porrasta."""
    n = 2 ** z
    rgb, base = bases.read(z, tx, ty)
    px_m = EARTH_CIRC * math.cos(math.radians(lat_of((ty + 0.5) / n))) / (n * SIZE)

    def touches(s, margin=0.0):
        return (s.box[0] <= (tx + 1) / n + margin and s.box[2] >= tx / n - margin
                and s.box[1] <= (ty + 1) / n + margin and s.box[3] >= ty / n - margin)

    pad = 0
    for s in strokes:
        if s.e["tyyppi"] == "pehmenna" and touches(s):
            pad = max(pad, int(math.ceil(2 * s.e["sade"] / px_m)) + 2)
    pad = min(pad, SIZE)
    # Myös reunukseen osuvat vedot, jotta pehmennys lukee naapuritiilen korjatun pinnan.
    strokes = [s for s in strokes if touches(s, pad / (n * SIZE))]
    if pad:
        ground = np.empty((SIZE + 2 * pad, SIZE + 2 * pad))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                h = base if dx == dy == 0 else bases.read(z, tx + dx, ty + dy)[1]
                ys, xs = slice(max(0, SIZE - pad) if dy < 0 else 0, pad if dy > 0 else SIZE), slice(max(0, SIZE - pad) if dx < 0 else 0, pad if dx > 0 else SIZE)
                oy, ox = (0 if dy < 0 else pad if dy == 0 else pad + SIZE), (0 if dx < 0 else pad if dx == 0 else pad + SIZE)
                part = h[ys, xs]
                ground[oy:oy + part.shape[0], ox:ox + part.shape[1]] = part
    else:
        ground = base.copy()
    orig = ground.copy()
    idx = np.arange(-pad, SIZE + pad) + 0.5
    X, Y = (tx + idx / SIZE) / n, (ty + idx / SIZE) / n
    for s in strokes:
        hit = s.weights(X, Y)
        if hit is None:
            continue
        r0, r1, c0, c1, w = hit
        e, cur = s.e, ground[r0:r1, c0:c1]
        if e["tyyppi"] == "nosta":
            cur += e["maara"] * w
        elif e["tyyppi"] == "laske":
            cur -= e["maara"] * w
        elif e["tyyppi"] == "tasoita":
            cur += (e["taso"] - cur) * w
        elif e["tyyppi"] == "palauta":
            cur += (orig[r0:r1, c0:c1] - cur) * w * e.get("voimakkuus", 1)
        elif e["tyyppi"] == "pehmenna":
            # Sumennus vedon ympäristöstä (säteen verran lisää), jotta reunalla on oikeat naapurit.
            sig = e["sade"] / 3 / px_m
            m = int(math.ceil(3 * max(1, round(sig))))
            a0, a1, b0, b1 = max(0, r0 - m), min(ground.shape[0], r1 + m), max(0, c0 - m), min(ground.shape[1], c1 + m)
            soft = blur(ground[a0:a1, b0:b1], sig)[r0 - a0:r1 - a0, c0 - b0:c1 - b0]
            cur += (soft - cur) * w * e.get("voimakkuus", 1)
    return rgb, base, ground[pad:pad + SIZE, pad:pad + SIZE]


def write_tile(z, x, y, rgb, base, new):
    """Tallentaa tiilen, jos se poikkeaa pohjasta; palauttaa korjauksen (uusi − pohja) tai None."""
    path = tile_path(z, x, y)
    changed = np.abs(new - base) > CHANGED
    if not changed.any():
        if os.path.exists(path):
            os.remove(path)
            try:
                os.removedirs(os.path.dirname(path))  # tyhjät kansiot pois (pysähtyy ensimmäiseen ei-tyhjään)
            except OSError:
                pass
        return None
    out = rgb.copy()
    out[changed] = terrarium(new[changed])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(out).save(path + ".part", "WEBP", lossless=True, method=4)
    os.replace(path + ".part", path)
    return np.where(changed, new - base, 0.0)


def load_index():
    if not os.path.exists(INDEX):
        return {}
    with open(INDEX, encoding="utf-8") as fh:
        d = json.load(fh).get("tiilet", {})
    return {int(z): {(xy[i], xy[i + 1]) for i in range(0, len(xy), 2)} for z, xy in d.items()}


def save_index(index):
    tiles = {str(z): [v for xy in sorted(index.get(z, ())) for v in xy] for z in sorted(index, reverse=True) if index.get(z)}
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    data = {"lahde": "Maastoeditorilla tehdyt korjaukset (korjaukset/maasto.json, scripts/maastokorjaus.py)",
            "versio": int(time.time() * 1000), "tiilet": tiles}
    with open(INDEX + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    os.replace(INDEX + ".tmp", INDEX)
    return data


def bake(edits, changed=None, bases=None, log=print):
    """Leipoo korjaukset tiiliin. changed: korjaukset, joiden tiilet lasketaan uudelleen (lisätyt tai
    poistetut); None = kaikki alusta. Palauttaa hakemiston (public/data/maastokorjaukset.json)."""
    t0 = time.time()
    bases = bases or Bases()
    strokes = [Stroke(e) for e in edits]
    if changed is None:
        shutil.rmtree(OUT, ignore_errors=True)
        index = {}
        todo = set().union(*(s.tiles(ZOOM) for s in strokes)) if strokes else set()
    else:
        index = load_index()
        todo = set().union(*(Stroke(e).tiles(ZOOM) for e in changed)) if changed else set()
    index.setdefault(ZOOM, set())
    deltas = {}
    for tx, ty in sorted(todo):
        rgb, base, new = apply_strokes(ZOOM, tx, ty, strokes, bases)
        deltas[(tx, ty)] = write_tile(ZOOM, tx, ty, rgb, base, new)
        (index[ZOOM].add if deltas[(tx, ty)] is not None else index[ZOOM].discard)((tx, ty))
    # Karkeammat tasot: korjaus on neljän tarkemman pikselin korjausten keskiarvo.
    z_child = ZOOM
    for z in COARSE:
        index.setdefault(z, set())
        parents = {(x >> 1, y >> 1) for x, y in deltas}
        coarse = {}
        for px, py in sorted(parents):
            full = np.zeros((2 * SIZE, 2 * SIZE))
            for j in (0, 1):
                for i in (0, 1):
                    c = (2 * px + i, 2 * py + j)
                    if c in deltas:
                        d = deltas[c]
                    elif c in index[z_child] and os.path.exists(tile_path(z_child, *c)):
                        d = read_tile(tile_path(z_child, *c))[1] - bases.read(z_child, *c)[1]
                    else:
                        d = None
                    if d is not None:
                        full[j * SIZE:(j + 1) * SIZE, i * SIZE:(i + 1) * SIZE] = d
            delta = full.reshape(SIZE, 2, SIZE, 2).mean(axis=(1, 3))
            rgb, base = bases.read(z, px, py)
            coarse[(px, py)] = write_tile(z, px, py, rgb, base, base + delta)
            (index[z].add if coarse[(px, py)] is not None else index[z].discard)((px, py))
        deltas, z_child = coarse, z
    data = save_index(index)
    count = sum(len(v) // 2 for v in data["tiilet"].values())
    log(f"  maastokorjaukset: {len(edits)} korjausta, {len(todo)} tarkkaa tiiltä laskettu, {count} korjattua tiiltä "
        f"({time.time() - t0:.1f} s)")
    return data


def height_at(lon, lat, edits, bases=None):
    """Maanpinnan korkeus (m) pisteessä korjausten jälkeen (tarkin taso, lähin pikseli)."""
    bases = bases or Bases()
    n = 2 ** ZOOM
    X, Y = merc(lon, lat)
    tx, ty = int(X * n), int(Y * n)
    h = apply_strokes(ZOOM, tx, ty, [Stroke(e) for e in edits], bases)[2]
    return float(h[min(SIZE - 1, int((Y * n - ty) * SIZE)), min(SIZE - 1, int((X * n - tx) * SIZE))])


def main():
    edits = load_edits()
    if not edits and not os.path.exists(INDEX):
        print("Ei maastokorjauksia (korjaukset/maasto.json).")
        return
    bake(edits)


if __name__ == "__main__":
    sys.exit(main())
