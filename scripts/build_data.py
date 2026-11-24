#!/usr/bin/env python3
"""Lataa Espoon ja HSY:n avoimet paikkatietoaineistot ja muuntaa ne GeoJSONiksi.

Käyttö:  python3 scripts/build_data.py [aineisto ...]

Raakavastaukset tallentuvat kansioon cache/, joten ajon voi keskeyttää ja
jatkaa. Valmiit GeoJSON-tiedostot menevät kansioon data/, ja niistä tehdään
vektoritiilet kansioon public/tiles/ (tippecanoe); rakennusten katot ovat kansiossa
public/tiles/katot. Selain tarvitsee kansiosta
public/data/ vain tiedostot manifest.json, espoo_raja.geojson, kaupunginosat_nimet.geojson,
sillat.json, raiteet.json ja lataus.json.
"""
import collections
import concurrent.futures as cf
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
OUT = os.path.join(ROOT, "data")  # välivaiheen GeoJSONit, ei julkaista
PUBLIC_DATA = os.path.join(ROOT, "public", "data")
TILES = os.path.join(ROOT, "public", "tiles")

ESPOO_WFS = "https://kartat.espoo.fi/teklaogcweb/wfs.ashx"
HSY_WFS = "https://kartta.hsy.fi/geoserver/wfs"
STATFI_WFS = "https://geo.stat.fi/geoserver/tilastointialueet/wfs"
OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "espoo3d-data-builder/1.0 (paikallinen avoimen datan katselin)"

# Espoon alue (lon/lat), hieman WMS-palvelun ilmoittamaa laajuutta väljempänä.
ESPOO_LONLAT = (24.47, 60.04, 24.90, 60.42)

GML = "{http://www.opengis.net/gml}"
R = 6378137.0

# id, WFS-tyyppi, kuvaus. Kaikki Espoon avoimesta WFS-rajapinnasta.
ESPOO_DATASETS = [
    ("maankaytto", "GIS:Maankayttoalueet", "Asemakaavan käyttötarkoitusalueet"),
    ("asemakaavat", "GIS:Asemakaavat", "Asemakaava-alueiden rajat"),
    ("kaavahankkeet", "GIS:Kaavoitushankkeet", "Vireillä olevat kaavahankkeet"),
    ("kaupunginosat", "GIS:Kaupunginosat", "Kaupunginosat"),
    ("pienalueet", "GIS:Tilastoalueet", "Tilastolliset alueet"),
    ("postinumerot", "GIS:Postinumeroalueet", "Postinumeroalueet"),
    ("vesialueet", "GIS:Vesialueet", "Vesialueet"),
    ("norot", "GIS:Norot", "Norot"),
    ("lahteet", "GIS:Lahteita", "Lähteet"),
    ("virtavedet", "GIS:ArvokkaatVirtavedet", "Arvokkaat virtavedet"),
    ("herkat_vesikohteet", "GIS:Herkat_vesikohteet", "Herkät vesikohteet"),
    ("pohjavesialueet", "GIS:Pohjavesialueet", "Pohjavesialueet"),
    ("luontokohteet", "GIS:ArvokkaatLuontokohteet", "Arvokkaat luontokohteet"),
    ("luonnonsuojelu", "GIS:LuonnonsuojelunToimenpideohjelma", "Luonnonsuojelun toimenpideohjelma"),
    ("lintualueet_valtak", "GIS:Valtakunnallisesti_tarkeat_lintualueet", "Valtakunnallisesti tärkeät lintualueet"),
    ("lintualueet_maak", "GIS:Maakunnallisesti_tarkeat_lintualueet", "Maakunnallisesti tärkeät lintualueet"),
    ("luonnonmuistomerkit", "GIS:Luonnonmuistomerkit", "Luonnonmuistomerkit"),
    ("geologiset", "GIS:Geologiset_kohteet", "Geologiset kohteet"),
    ("perinneymparistot", "GIS:Perinneymparistot", "Perinneympäristöt"),
    ("metsaverkosto", "GIS:Ekologinen_verkosto_Metsaverkosto", "Ekologinen metsäverkosto"),
    ("sulfaattimaat", "GIS:Potentiaaliset_happamat_sulfaattimaat", "Potentiaaliset happamat sulfaattimaat"),
    ("luontopolut", "GIS:Luontopolut", "Luontopolut"),
    ("rantaraitti", "GIS:Rantaraitti", "Rantaraitti"),
    ("autoliikenne", "GIS:Autoliikennemaarat", "Autoliikennemäärät"),
]

BUILDING_TYPE = "bldg:building_lod0"
# Espoo jaetaan ruutuihin, jotta yksittäiset kyselyt pysyvät pieninä. Mercator-metreinä;
# 60. leveyspiirillä 6000 m on maastossa noin 3 km.
BUILDING_TILE = 6000
# Rakennusrekisteri: kattavampi kuin 3D-malli, mutta ilman mitattua korkeutta.
REGISTER_TYPE = "GIS:Rakennukset"
# Kantakartan sillat: reunaviivat, joiden jokaisella pisteellä on mitattu korkeus (N2000).
BRIDGE_TYPE = "kanta:Silta"
# 3D-malli kattomuotoineen. Raskas, joten sitä haetaan vain rakennuksille, joiden korkeus
# LOD0-mallissa on epäilyttävä (ks. fix_heights).
LOD2_TYPE = "bldg:building_lod2"
BLDG = "{http://www.opengis.net/citygml/building/2.0}"
GEN = "{http://www.opengis.net/citygml/generics/2.0}"


def log(*a):
    print(*a, flush=True)


def http_get(url, params, dest, timeout=300, retries=3):
    """Hakee URL:n välimuistitiedostoon, ellei se jo ole siellä."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r, open(dest + ".part", "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            os.replace(dest + ".part", dest)
            return dest
        except Exception as e:  # verkko- tai palvelinvirhe: yritä uudelleen
            log(f"  virhe ({attempt + 1}/{retries}): {e}")
            if "SSL" in str(e) and shutil.which("curl"):
                # macOS:n järjestelmä-Pythonin TLS ei kelpaa kaikille palvelimille; curl kelpaa.
                subprocess.run(["curl", "-sf", "-A", UA, "-o", dest + ".part", full], check=True, timeout=timeout)
                os.replace(dest + ".part", dest)
                return dest
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Lataus epäonnistui: {full}")


def bbox_filter(minx, miny, maxx, maxy):
    # Palvelin tulkitsee rajauksen aina samassa koordinaatistossa kuin srsName-tulosteen,
    # joten Envelope annetaan Web Mercatorina.
    return (
        '<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc" xmlns:gml="http://www.opengis.net/gml">'
        "<ogc:BBOX><ogc:PropertyName>Geometry</ogc:PropertyName>"
        f'<gml:Envelope srsName="EPSG:3857"><gml:lowerCorner>{minx} {miny}</gml:lowerCorner>'
        f"<gml:upperCorner>{maxx} {maxy}</gml:upperCorner></gml:Envelope></ogc:BBOX></ogc:Filter>"
    )


def espoo_params(type_name, flt=None):
    # Koordinaatit pyydetään Web Mercatorina (EPSG:3857): se on konforminen, joten
    # kaavojen kaarisegmentit voi tihentää ympyränkaariksi metreissä.
    p = {
        "service": "WFS",
        "version": "1.1.0",
        "request": "GetFeature",
        "typeName": type_name,
        "srsName": "EPSG:3857",
    }
    if flt:
        p["filter"] = flt
    return p


# ---------------------------------------------------------------- geometria


def lonlat_to_merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def merc_to_lonlat(x, y):
    lon = math.degrees(x / R)
    lat = math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return [round(lon, 7), round(lat, 7)]


def local(tag):
    return tag.rsplit("}", 1)[-1]


def read_positions(el):
    """Palauttaa elementin suorat pos/posList-koordinaatit [(x, y), ...] (z jätetään pois)."""
    pts = []
    for c in el:
        t = local(c.tag)
        if t == "pos":
            v = c.text.split()
            pts.append((float(v[0]), float(v[1])))
        elif t == "posList":
            dim = int(c.get("srsDimension") or el.get("srsDimension") or 2)
            v = [float(s) for s in c.text.split()]
            pts.extend((v[i], v[i + 1]) for i in range(0, len(v), dim))
        elif t == "pointProperty":
            pts.extend(read_positions(c.find(GML + "Point")))
    return [q for q in (fix_position(p) for p in pts) if q]


def fix_position(p):
    """Korjaa Espoon WFS:n muunnosvirheet. Pyydetyssä EPSG:3857-tulosteessa osa pisteistä
    jää ETRS-GK25-koordinaateiksi (yleensä renkaan ensimmäinen piste), ja osa on roskaa
    (INF tai lähellä nollaa). GK25-pisteet muunnetaan itse, roskat jätetään pois."""
    x, y = p
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    if 25_000_000 < x < 26_000_000 and 6_500_000 < y < 6_900_000:
        return lonlat_to_merc(*gk25_to_lonlat(x, y))
    if abs(x) < 1_000_000 and abs(y) < 1_000_000:
        return None
    return p


def gk25_to_lonlat(e, n_):
    """ETRS-GK25 (EPSG:3879) → ETRS89-maantieteelliset koordinaatit, JHS 154 -kaavat."""
    f = 1 / 298.257222101
    a = 6378137.0
    n = f / (2 - f)
    a1 = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    ecc = math.sqrt(2 * f - f * f)
    h = (
        n / 2 - 2 * n ** 2 / 3 + 37 * n ** 3 / 96 - n ** 4 / 360,
        n ** 2 / 48 + n ** 3 / 15 - 437 * n ** 4 / 1440,
        17 * n ** 3 / 480 - 37 * n ** 4 / 840,
        4397 * n ** 4 / 161280,
    )
    xi = n_ / a1
    eta = (e - 25_500_000) / a1
    xi_p = xi - sum(h[i] * math.sin(2 * (i + 1) * xi) * math.cosh(2 * (i + 1) * eta) for i in range(4))
    eta_p = eta - sum(h[i] * math.cos(2 * (i + 1) * xi) * math.sinh(2 * (i + 1) * eta) for i in range(4))
    beta = math.asin(math.sin(xi_p) / math.cosh(eta_p))
    l = math.asin(math.tanh(eta_p) / math.cos(beta))
    q = math.asinh(math.tan(beta))
    qp = q + ecc * math.atanh(ecc * math.tanh(q))
    for _ in range(5):
        qp = q + ecc * math.atanh(ecc * math.tanh(qp))
    return 25 + math.degrees(l), math.degrees(math.atan(math.sinh(qp)))


def densify_arc(p1, p2, p3, step=1.5):
    """Kolmen pisteen kautta kulkeva ympyränkaari pisteiksi (metreinä)."""
    (x1, y1), (x2, y2), (x3, y3) = p1, p2, p3
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-9:
        return [p1, p2, p3]
    ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d
    uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1 = math.atan2(y1 - uy, x1 - ux)
    a2 = math.atan2(y2 - uy, x2 - ux)
    a3 = math.atan2(y3 - uy, x3 - ux)
    tau = 2 * math.pi
    ccw = (a2 - a1) % tau < (a3 - a1) % tau  # kulkeeko kaari vastapäivään p2:n kautta
    sweep = (a3 - a1) % tau if ccw else -((a1 - a3) % tau)
    n = max(4, min(128, int(abs(sweep) * r / step)))
    return [(ux + r * math.cos(a1 + sweep * i / n), uy + r * math.sin(a1 + sweep * i / n)) for i in range(n + 1)]


def curve_points(el):
    t = local(el.tag)
    if t in ("LineString", "LineStringSegment", "LinearRing"):
        return read_positions(el)
    if t in ("Arc", "ArcString"):
        p = read_positions(el)
        out = []
        for i in range(0, len(p) - 2, 2):
            seg = densify_arc(p[i], p[i + 1], p[i + 2])
            out.extend(seg if not out else seg[1:])
        return out
    if t == "Curve":
        out = []
        for seg in el.find(GML + "segments"):
            pts = curve_points(seg)
            out.extend(pts if not out else pts[1:])
        return out
    if t == "Ring":
        out = []
        for cm in el.findall(GML + "curveMember"):
            for c in cm:
                pts = curve_points(c)
                out.extend(pts if not out else pts[1:])
        return out
    if t == "CompositeCurve":
        out = []
        for cm in el.findall(GML + "curveMember"):
            for c in cm:
                pts = curve_points(c)
                out.extend(pts if not out else pts[1:])
        return out
    return []


def signed_area(ring):
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2


def to_ring(pts, outer):
    if len(pts) < 3:
        return None
    if pts[0] != pts[-1]:
        pts = pts + [pts[0]]
    if len(pts) < 4:
        return None
    # GeoJSON (RFC 7946): ulkoreuna vastapäivään, reiät myötäpäivään.
    a = signed_area(pts)
    if (outer and a < 0) or (not outer and a > 0):
        pts = pts[::-1]
    return [merc_to_lonlat(x, y) for x, y in pts]


def polygon_coords(el):
    rings = []
    for part, outer in (("exterior", True), ("outerBoundaryIs", True), ("interior", False), ("innerBoundaryIs", False)):
        for b in el.findall(GML + part):
            for ring_el in b:
                ring = to_ring(curve_points(ring_el), outer)
                if ring:
                    rings.append(ring)
    return rings if rings and rings[0] else None


def to_geojson(el):
    """GML-geometria → (tyyppi, koordinaatit) tai None."""
    t = local(el.tag)
    if t == "Point":
        p = read_positions(el)
        return ("Point", merc_to_lonlat(*p[0])) if p else None
    if t in ("LineString", "Curve", "CompositeCurve"):
        pts = curve_points(el)
        return ("LineString", [merc_to_lonlat(x, y) for x, y in pts]) if len(pts) > 1 else None
    if t in ("Polygon", "PolygonPatch"):
        rings = polygon_coords(el)
        return ("Polygon", rings) if rings else None
    if t in ("Surface", "MultiSurface", "MultiPolygon", "PolyhedralSurface", "CompositeSurface"):
        polys = []
        for p in el.iter():
            if local(p.tag) in ("Polygon", "PolygonPatch"):
                c = polygon_coords(p)
                if c:
                    polys.append(c)
        return ("MultiPolygon", polys) if polys else None
    if t in ("MultiCurve", "MultiLineString"):
        lines = []
        for m in el:
            for c in m:
                pts = curve_points(c)
                if len(pts) > 1:
                    lines.append([merc_to_lonlat(x, y) for x, y in pts])
        return ("MultiLineString", lines) if lines else None
    if t == "MultiPoint":
        pts = [merc_to_lonlat(*p) for m in el for c in m for p in read_positions(c)]
        return ("MultiPoint", pts) if pts else None
    return None


GEOM_TAGS = {
    "Point", "LineString", "Curve", "CompositeCurve", "Polygon", "Surface", "MultiSurface", "MultiPolygon",
    "PolyhedralSurface", "CompositeSurface", "MultiCurve", "MultiLineString", "MultiPoint",
}


def merge_geoms(geoms):
    """Yhdistää saman kohteen useat geometriat (esim. viiva + alue) yhdeksi."""
    if len(geoms) == 1:
        return {"type": geoms[0][0], "coordinates": geoms[0][1]}
    polys, lines, points = [], [], []
    for t, c in geoms:
        if t == "Polygon":
            polys.append(c)
        elif t == "MultiPolygon":
            polys.extend(c)
        elif t == "LineString":
            lines.append(c)
        elif t == "MultiLineString":
            lines.extend(c)
        elif t == "Point":
            points.append(c)
        elif t == "MultiPoint":
            points.extend(c)
    # Alue riittää karttaesitykseen; viivat ovat usein vain sen rajoja.
    if polys:
        return {"type": "MultiPolygon", "coordinates": polys} if len(polys) > 1 else {"type": "Polygon", "coordinates": polys[0]}
    if lines:
        return {"type": "MultiLineString", "coordinates": lines}
    return {"type": "MultiPoint", "coordinates": points}


def convert_value(v):
    v = v.strip()
    if len(v) > 300:
        v = v[:300] + "…"
    try:
        if v and (v.lstrip("-").replace(".", "", 1).isdigit()) and not (len(v) > 1 and v[0] == "0" and v[1] != "."):
            f = float(v)
            return int(f) if f.is_integer() and "." not in v else round(f, 3)
    except ValueError:
        pass
    return v


def parse_features(path, geom_prefer=None):
    """Lukee Espoon WFS:n GML-vastauksen ja palauttaa GeoJSON-kohteet."""
    feats = []
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag != GML + "featureMember":
            continue
        for f in el:
            props, geoms = {}, []
            fid = f.get(GML + "id")
            for c in f:
                name = local(c.tag)
                if name.endswith("Attribute") and c.get("name"):
                    v = c.find("{http://www.opengis.net/citygml/generics/1.0}value")
                    if v is None:
                        v = next(iter(c), None)
                    if v is not None and v.text:
                        props[c.get("name")] = convert_value(v.text)
                    continue
                gchild = next((g for g in c.iter() if g.tag.startswith(GML) and local(g.tag) in GEOM_TAGS), None)
                if gchild is not None:
                    if geom_prefer and name not in geom_prefer:
                        continue
                    g = to_geojson(gchild)
                    if g:
                        geoms.append(g)
                elif len(c) == 0 and c.text and c.text.strip() and not name.startswith("_"):
                    props[name] = convert_value(c.text)
            if geoms:
                feat = {"type": "Feature", "properties": props, "geometry": merge_geoms(geoms)}
                if fid:
                    feat["id_gml"] = fid
                feats.append(feat)
        el.clear()
    return feats


def write_geojson(name, feats, folder=OUT):
    path = os.path.join(folder, name + ".geojson")
    for f in feats:
        f.pop("id_gml", None)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh, ensure_ascii=False, separators=(",", ":"))
    log(f"  → {name}.geojson: {len(feats)} kohdetta, {os.path.getsize(path) / 1e6:.1f} Mt")
    return path


# ------------------------------------------------------------- aineistot


def build_simple(ds_id, type_name):
    log(f"{ds_id} ({type_name})")
    raw = http_get(ESPOO_WFS, espoo_params(type_name), os.path.join(CACHE, ds_id + ".xml"))
    feats = parse_features(raw)
    if ds_id == "maankaytto":
        for f in feats:
            f["properties"]["luokka"] = landuse_class(str(f["properties"].get("KAYTTOTARKOITUS", "")))
    return write_geojson(ds_id, feats)


LANDUSE = [  # asemakaavamerkinnän alkukirjaimet → pääluokka
    ("W", "vesi"), ("SL", "suojelu"), ("S", "suojelu"), ("V", "virkistys"), ("E", "erityis"),
    ("L", "liikenne"), ("T", "teollisuus"), ("Y", "julkinen"), ("P", "palvelu"), ("K", "liike"),
    ("A", "asuminen"), ("M", "maa_metsa"), ("R", "loma"), ("C", "keskusta"),
]


def landuse_class(code):
    code = code.strip().upper()
    for prefix, cls in LANDUSE:
        if code.startswith(prefix):
            return cls
    return "muu"


def fetch_tiled(type_name, subdir):
    """Lataa aineiston Espoon alueelta ruuduittain välimuistiin ja palauttaa tiedostopolut."""
    minx, miny = (int(v) for v in lonlat_to_merc(ESPOO_LONLAT[0], ESPOO_LONLAT[1]))
    maxx, maxy = (int(v) + 1 for v in lonlat_to_merc(ESPOO_LONLAT[2], ESPOO_LONLAT[3]))
    tiles = [
        (x, y, min(x + BUILDING_TILE, maxx), min(y + BUILDING_TILE, maxy))
        for x in range(minx, maxx, BUILDING_TILE)
        for y in range(miny, maxy, BUILDING_TILE)
    ]

    def fetch(t):
        dest = os.path.join(CACHE, subdir, f"{t[0]}_{t[1]}.xml")
        return http_get(ESPOO_WFS, espoo_params(type_name, bbox_filter(*t)), dest, timeout=600)

    os.makedirs(os.path.join(CACHE, subdir), exist_ok=True)
    paths, done = [], 0
    with cf.ThreadPoolExecutor(max_workers=3) as ex:  # maltillinen rinnakkaisuus palvelimen takia
        for p in ex.map(fetch, tiles):
            paths.append(p)
            done += 1
            if done % 20 == 0 or done == len(tiles):
                log(f"  {type_name}: ladattu {done}/{len(tiles)} ruutua")
    return paths


def build_buildings():
    log(f"rakennukset ({BUILDING_TYPE} + {REGISTER_TYPE}), ruudut {BUILDING_TILE} m")
    seen, feats = set(), []
    for p in fetch_tiled(BUILDING_TYPE, "rakennukset"):
        for f in parse_features(p, geom_prefer={"lod0FootPrint"}):
            if f.get("id_gml") in seen:
                continue  # ruutujen rajalla olevat rakennukset tulevat kahdesti
            seen.add(f.get("id_gml"))
            feats.append(building_props(f))
    register, seen = [], set()
    for p in fetch_tiled(REGISTER_TYPE, "rakennusrekisteri"):
        for f in parse_features(p):
            key = f["properties"].get("PYSYVARAKENNUSTUNNUS") or f.get("id_gml")
            if key in seen:
                continue
            seen.add(key)
            register.append(f)
    feats += register_supplement(feats, register)
    feats = fix_heights(feats)
    path = write_geojson("rakennukset", feats)
    make_building_tiles(path)


def suspicious_height(p):
    """LOD0-mallissa rakennuksella on vain yksi korkeus: korkein mitattu kohta. Kirkon torni,
    jalustan päällä oleva tornitalo tai mittausvirhe (esim. nosturi) nostaa silloin koko
    rakennuksen liian korkeaksi. Epäilyttävä on rakennus, joka on selvästi korkeampi kuin
    kerrosluku antaa olettaa, tai yli 25 m korkea rakennus ilman kerroslukua."""
    h, floors = p.get("korkeus") or 0, p.get("kerrokset") or 0
    return (floors >= 1 and h > 4.5 * floors + 8) or (floors < 1 and h > 25)


def lod2_roof_parts(f):
    """Rakennuksen osat LOD2-mallin kattopinnoista: kukin kattopinta nostetaan omaan
    korkeuteensa maanpinnasta (kattopinnan keskikorkeus). Mukaan otetaan vain kattopinnat,
    joiden keskipiste on LOD0-pohjan sisällä, koska LOD2-rakennus voi kattaa useamman
    LOD0-rakennuksen. Palauttaa [(rengas, korkeus), ...] tai None, jos LOD2-mallista ei löydy
    samaa rakennusta (rakennustunnus)."""
    tunnus = str(f["properties"].get("tunnus") or "")
    if not tunnus:
        return None
    merc = [lonlat_to_merc(*q) for poly in geom_polygons(f["geometry"]) for q in poly[0]]
    box = (min(p[0] for p in merc) - 2, min(p[1] for p in merc) - 2, max(p[0] for p in merc) + 2, max(p[1] for p in merc) + 2)
    raw = http_get(ESPOO_WFS, espoo_params(LOD2_TYPE, bbox_filter(*box)), os.path.join(CACHE, "lod2", tunnus + ".xml"), timeout=300)
    building = None
    for _, el in ET.iterparse(raw):
        if el.tag == BLDG + "Building":
            attrs = {a.get("name"): a.findtext(GEN + "value") for a in el.iter(GEN + "stringAttribute")}
            if attrs.get("rakennustunnus") == tunnus:
                building = el
                break
    if building is None:
        return None
    walls = [z for w in building.iter(BLDG + "WallSurface") for r in w.iter(GML + "LinearRing") for _, _, z in read_positions_3d(r)]
    if not walls:
        return None
    footprint = geom_polygons(f["geometry"])
    ground, parts = min(walls), []
    for roof in building.iter(BLDG + "RoofSurface"):
        for ring in roof.iter(GML + "LinearRing"):
            pts = read_positions_3d(ring)
            if len(pts) < 3:
                continue
            lonlat = [merc_to_lonlat(x, y) for x, y, _ in pts]
            if lonlat[0] != lonlat[-1]:
                lonlat.append(lonlat[0])
            x0, y0 = lonlat[0]  # pinta-ala metreinä ensimmäisen pisteen suhteen (tarkkuus)
            if abs(signed_area([((x - x0) * 55462, (y - y0) * 111415) for x, y in lonlat])) < 0.5:
                continue  # pystysuora tai olematon pinta
            cx, cy = sum(x for x, _ in lonlat[:-1]) / (len(lonlat) - 1), sum(y for _, y in lonlat[:-1]) / (len(lonlat) - 1)
            if not any(point_in_polygon(cx, cy, poly) for poly in footprint):
                continue
            parts.append((lonlat, max(1.0, sum(z for _, _, z in pts) / len(pts) - ground)))
    return parts or None


def fix_heights(feats):
    """Epäilyttävät korkeudet korjataan LOD2-mallista: rakennus jaetaan kattopintojensa
    mukaisiin osiin, joilla kullakin on oma korkeutensa. Jos LOD2-mallia ei löydy, korkeus
    rajataan kerrosluvun mukaiseksi."""
    cands = [i for i, f in enumerate(feats) if not f["properties"].get("arvio") and suspicious_height(f["properties"])]
    log(f"  korjataan {len(cands)} epäilyttävää korkeutta LOD2-mallin kattopinnoista")
    os.makedirs(os.path.join(CACHE, "lod2"), exist_ok=True)
    with cf.ThreadPoolExecutor(max_workers=3) as ex:
        parts = dict(zip(cands, ex.map(lambda i: lod2_roof_parts(feats[i]), cands)))
    out, split, capped = [], 0, 0
    for i, f in enumerate(feats):
        if i not in parts:
            out.append(f)
        elif parts[i]:
            split += 1
            for ring, h in parts[i]:
                props = {**f["properties"], "korkeus": round(h, 1), "osa": 1}
                out.append({"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}})
        else:
            floors = f["properties"].get("kerrokset") or 0
            if floors >= 1:
                f["properties"]["korkeus"] = round(floors * 3.5 + 4, 1)
                f["properties"]["arvio"] = 1
                capped += 1
            out.append(f)
    log(f"  LOD2-osiin jaettu {split}, kerrosluvun mukaan rajattu {capped}")
    return out


def register_supplement(lod0, register):
    """3D-mallista (LOD0) puuttuu kokonaisia alueita, esim. Etelä-Leppävaaran pientaloalue.
    Rakennusrekisterin rakennukset, joita ei löydy mallista tunnuksen eikä sijainnin
    perusteella, lisätään. Niiden korkeus arvioidaan kerrosluvusta: arvo on mallissa
    olevien saman kerrosluvun rakennusten mitattujen korkeuksien mediaani."""
    ids = {f["properties"].get("tunnus") for f in lod0}
    cell = lambda x, y: (int(x * 200), int(y * 400))  # noin 250 m ruudut
    grid = collections.defaultdict(list)
    for f in lod0:
        polys = geom_polygons(f["geometry"])
        xs = [p[0] for poly in polys for p in poly[0]]
        ys = [p[1] for poly in polys for p in poly[0]]
        for cx in range(cell(min(xs), 0)[0], cell(max(xs), 0)[0] + 1):
            for cy in range(cell(0, min(ys))[1], cell(0, max(ys))[1] + 1):
                grid[(cx, cy)].append(polys)

    heights = collections.defaultdict(list)
    for f in lod0:
        p = f["properties"]
        if isinstance(p.get("kerrokset"), (int, float)) and p["kerrokset"] > 0:
            heights[min(int(p["kerrokset"]), 30)].append(p["korkeus"])
    median = {k: sorted(v)[len(v) // 2] for k, v in heights.items() if len(v) >= 5}
    all_h = sorted(h for v in heights.values() for h in v)
    fallback = all_h[len(all_h) // 2] if all_h else 6.0

    added = []
    for f in register:
        p = f["properties"]
        polys = geom_polygons(f["geometry"])
        if not polys or p.get("PYSYVARAKENNUSTUNNUS") in ids:
            continue
        ring = polys[0][0]
        x = sum(q[0] for q in ring[:-1]) / (len(ring) - 1)
        y = sum(q[1] for q in ring[:-1]) / (len(ring) - 1)
        if any(point_in_polygon(x, y, poly) for polys in grid.get(cell(x, y), []) for poly in polys):
            continue
        floors = p.get("KERROSLUKU") if isinstance(p.get("KERROSLUKU"), (int, float)) and p["KERROSLUKU"] > 0 else None
        height = median.get(min(int(floors), 30), floors * 3.2) if floors else fallback
        year = p.get("VALMISTUNUTYYYYMMDD")
        year = year // 10000 if isinstance(year, int) and year > 10000 else None
        number = p.get("OSOITENUMERO2") or p.get("OSOITENUMERO")
        address = f"{p['OSOITE']} {number}, {p.get('POSTINUMERO', '')} ESPOO" if p.get("OSOITE") else None
        props = {
            "korkeus": round(float(height), 1),
            "arvio": 1,
            "kerrokset": floors,
            "vuosi": None if year == 1900 else year,
            "kaytto": p.get("KAYTTOTARKOITUS"),
            "osoite": address,
            "asunnot": int(p["HUONEISTOT"]) if isinstance(p.get("HUONEISTOT"), (int, float)) else None,
            "rakenne": p.get("KANTAVARAKENNE"),
            "tunnus": p.get("PYSYVARAKENNUSTUNNUS"),
        }
        props = {k: v for k, v in props.items() if v not in (None, "", "Ei arvoa")}
        props["luokka"] = building_class(str(props.get("kaytto", "")))
        added.append({"type": "Feature", "properties": props, "geometry": f["geometry"]})
    log(f"  rekisteristä lisätty {len(added)} rakennusta, joita 3D-mallissa ei ole (korkeus arvioitu)")
    return added


def geom_polygons(g):
    return [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []


def building_props(f):
    p = f["properties"]
    height = p.get("measuredHeight")
    floors = p.get("kerrosluku") if isinstance(p.get("kerrosluku"), (int, float)) else p.get("storeysAboveGround")
    if not isinstance(height, (int, float)) or height <= 0:
        height = (floors * 3.2) if isinstance(floors, (int, float)) and floors > 0 else 4.0
    # Valmistumispäivä on muotoa pp.kk.vvvv tai vvvv-kk-pp. CityGML:n yearOfConstruction
    # on 1900 silloinkin, kun vuotta ei tiedetä, joten sitä ei käytetä.
    # Myös valmistumispäivissä vuosi 1900 on lähes aina tuntemattoman vuoden paikka-arvo.
    year = None
    v = str(p.get("valmistumispvm", ""))
    if len(v) >= 4 and v[-4:].isdigit():
        year = int(v[-4:])
    elif v[:4].isdigit():
        year = int(v[:4])
    if year == 1900:
        year = None
    f["properties"] = {
        k: v for k, v in {
            "korkeus": round(float(height), 1),
            "kerrokset": floors if isinstance(floors, (int, float)) else None,
            "vuosi": year,
            "kaytto": p.get("kayttotarkoitus"),
            "osoite": p.get("osoite"),
            "asunnot": p.get("asunnot"),
            "rakenne": p.get("kantavarakenne"),
            "tunnus": p.get("rakennustunnus"),
        }.items() if v not in (None, "", "Ei arvoa")
    }
    f["properties"]["luokka"] = building_class(str(f["properties"].get("kaytto", "")))
    return f


def building_class(use):
    u = use.lower()
    for keys, cls in (
        (("kerrostalo",), "kerrostalo"),
        (("rivitalo", "ketjutalo"), "rivitalo"),
        (("pientalo", "omakotitalo", "erillinen", "paritalo", "yhden asunnon", "kahden asunnon"), "pientalo"),
        (("vapaa-ajan", "loma"), "vapaa_aika"),
        (("liike", "toimisto", "myymälä", "kauppa", "hotelli", "ravintola"), "liike"),
        (("teollisuus", "varasto", "tuotanto", "energia", "huolto", "kierrätys"), "teollisuus"),
        (("pysäköinti", "liikenne", "asema", "autotalli", "autosuoja", "kulkuneuvo"), "liikenne"),
        (("koulu", "opetus", "oppilaitos", "päiväkod", "terveys", "hoito", "sairaala", "laitos", "avopalvelu",
          "kuntoutus", "kirkko", "seurakunta", "uskonno", "seura-", "kokoontumis", "kirjasto", "museo",
          "teatteri", "näyttely", "urheilu", "liikunta", "halli", "julkinen"), "julkinen"),
        (("talous", "sauna", "maatalous", "maa- metsä", "talli", "karja", "sikala", "lantala", "kasvihuone", "eläin"), "talous"),
        (("asuin", "asunto"), "asuin_muu"),
    ):
        if any(k in u for k in keys):
            return cls
    return "muu"


def make_building_tiles(geojson_path):
    exe = shutil.which("tippecanoe")
    if not exe:
        log("  tippecanoe puuttuu – rakennukset näytetään suoraan GeoJSONista")
        return
    shutil.rmtree(os.path.join(TILES, "rakennukset"), ignore_errors=True)
    # Tiilet jäävät gzip-pakatuiksi; server.py lisää niihin Content-Encoding-otsakkeen.
    cmd = [
        exe, "--output-to-directory", "public/tiles/rakennukset", "--force",
        "-l", "rakennukset", "-Z", "11", "-z", "15", "--no-feature-limit", "--no-tile-size-limit",
        "--no-simplification-of-shared-nodes", "--simplification", "2", "--quiet",
        os.path.relpath(geojson_path, ROOT),
    ]
    run_tippecanoe(cmd)
    log("  → tiles/rakennukset (z11–15)")


# ---------------------------------------------------------------- katot

# LOD0-mallissa rakennuksella on vain yksi korkeus, joten kaikki katot piirtyisivät tasakattoina.
# Kaltevakattoisten rakennusten seinät piirretään räystään korkeuteen (ominaisuus raystas), ja
# 3D-mallin (LOD2) kattopinnat sekä räystään yläpuoliset seinänosat (päätykolmiot, korkeampien
# osien seinät) piirretään niiden päälle kolmioina (public/roofs.js).
ROOF_CELL = 1500  # mercator-m (noin 750 m maastossa): 3D-malli haetaan näin suurissa ruuduissa
ROOF_TILE_ZOOM = 14  # selaimen kattotiedostojen ruutujako (Web Mercator -tiilet, noin 1,2 km)
ROOF_FLAT_NZ = math.cos(math.radians(10))  # tätä loivempi kattopinta on tasainen
ROOF_MIN_PITCHED = 0.15  # katto piirretään, jos vähintään tämä osuus sen alasta on kaltevaa
ROOF_MIN_AREA = 0.05  # m²: pienemmät kolmiot jätetään pois
# Selain nostaa katon maastoon hieman eri tavalla kuin MapLibre 3D-rakennuksen (keskipiste ja
# korkeusmallin tarkkuus), joten seinät jatkuvat räystään alle, jottei väliin jää rakoa. Jatke on
# hieman sisempänä, jottei se välky 3D-rakennuksen seinän kanssa.
ROOF_SKIRT = 2.0  # m
ROOF_INSET = 0.03  # m
# Tasakattoinen rakennus, jonka LOD0-korkeus (korkein kohta) on selvästi kattojen keskikorkeutta
# suurempi, on monitasoinen (esim. matala osa ja korkeampi osa) ja piirtyisi liian korkeaksi. Se
# jaetaan kattopintojen mukaisiin osiin, jos osat kattavat vähintään tämän osuuden pohjasta;
# muuten korkeudeksi otetaan kattojen pinta-alalla painotettu keskikorkeus.
ROOF_PART_COVER = 0.8


def build_roofs():
    """Kaltevat katot 3D-mallista. Rakennus tunnistetaan rakennustunnuksesta. LOD2-pinnat on
    CityGML:n tapaan kierretty ulospäin, joten kolmioiden kiertosuunta säilytetään (katot
    käännetään silti aina ylöspäin). Tiedostot public/tiles/katot/14/x/y.bin (gzip) jakavat
    rakennukset keskipisteen mukaan, ja index.json luettelee ne. Rakennusaineistoon lisätään
    räystään korkeus, monitasoiset tasakattoiset rakennukset korjataan (overtall_fix), ja
    rakennustiilet tehdään uudelleen."""
    log(f"katot ({LOD2_TYPE}), ruudut {ROOF_CELL} m")
    path = os.path.join(OUT, "rakennukset.geojson")
    with open(path, encoding="utf-8") as fh:
        feats = json.load(fh)["features"]
    targets = roof_targets(feats)
    # Korjattavat: 3D-mallissa olevat, joita ei ole jo jaettu osiin (fix_heights tai aiempi ajo).
    split = {str(f["properties"].get("tunnus")) for f in feats if f["properties"].get("osa")}
    footprints = collections.defaultdict(list)
    for f in feats:
        p = f["properties"]
        if p.get("tunnus") and not p.get("arvio") and str(p["tunnus"]) not in split:
            footprints[str(p["tunnus"])].extend(geom_polygons(f["geometry"]))
    cells = sorted({(int(t["mx"] // ROOF_CELL), int(t["my"] // ROOF_CELL)) for t in targets.values()})
    os.makedirs(os.path.join(CACHE, "lod2_ruudut"), exist_ok=True)

    def fetch(cell):
        x0, y0 = cell[0] * ROOF_CELL, cell[1] * ROOF_CELL
        dest = os.path.join(CACHE, "lod2_ruudut", f"{cell[0]}_{cell[1]}.xml")
        return http_get(ESPOO_WFS, espoo_params(LOD2_TYPE, bbox_filter(x0, y0, x0 + ROOF_CELL, y0 + ROOF_CELL)), dest, timeout=900)

    roofs, flat, fixes = {}, set(), {}
    with cf.ThreadPoolExecutor(max_workers=3) as ex:  # maltillinen rinnakkaisuus palvelimen takia
        for i, raw in enumerate(ex.map(fetch, cells), 1):
            for tunnus, roof, fix in parse_roofs(raw, targets, footprints):
                if roof:
                    roofs.setdefault(tunnus, roof)  # ruutujen rajalla olevat rakennukset tulevat kahdesti
                else:
                    flat.add(tunnus)
                if fix:
                    fixes.setdefault(tunnus, fix)
            if i % 25 == 0 or i == len(cells):
                log(f"  {i}/{len(cells)} ruutua: kaltevia kattoja {len(roofs)}, tasakattoja tai ilman kattopintoja {len(flat - set(roofs))}")
    feats = apply_height_fixes(feats, fixes)
    for f in feats:
        roof = roofs.get(str(f["properties"].get("tunnus")))
        if roof:
            f["properties"]["raystas"] = roof["raystas"]
    write_roof_tiles(roofs, targets)
    make_building_tiles(write_geojson("rakennukset", feats))


def roof_targets(feats):
    """LOD0-rakennukset tunnuksittain: kärkipisteiden keskipiste (MapLibre nostaa 3D-rakennuksen
    katon sen maastokorkeudelle), suurin korkeus, luokka ja valmistumisvuosi. Rekisteristä
    täydennetyt rakennukset (arvio) puuttuvat 3D-mallista."""
    acc = {}
    for f in feats:
        p = f["properties"]
        if not p.get("tunnus") or p.get("arvio"):
            continue
        a = acc.setdefault(str(p["tunnus"]), {"sx": 0.0, "sy": 0.0, "n": 0, "korkeus": 0.0, "luokka": p.get("luokka"), "vuosi": p.get("vuosi")})
        for poly in geom_polygons(f["geometry"]):
            for x, y in poly[0][:-1]:
                a["sx"] += x
                a["sy"] += y
                a["n"] += 1
        a["korkeus"] = max(a["korkeus"], p.get("korkeus") or 0)
    out = {}
    for tunnus, a in acc.items():
        if a["n"]:
            lon, lat = a["sx"] / a["n"], a["sy"] / a["n"]
            mx, my = lonlat_to_merc(lon, lat)
            out[tunnus] = {"lon": lon, "lat": lat, "mx": mx, "my": my, "korkeus": a["korkeus"],
                           "luokka": a["luokka"] or "muu", "vuosi": a["vuosi"]}
    return out


def parse_roofs(path, targets, footprints):
    """Ruudun LOD2-tiedoston rakennukset: (tunnus, katto tai None tasakatolle, korkeuden korjaus
    tai None). Korjaus haetaan vain tasakattoisille rakennuksille, joiden LOD0-pohja on annettu."""
    for _, el in ET.iterparse(path):
        if el.tag != BLDG + "Building":
            continue
        attrs = {a.get("name"): a.findtext(GEN + "value") for a in el.iter(GEN + "stringAttribute")}
        tunnus = attrs.get("rakennustunnus")
        if tunnus in targets:
            roof = roof_mesh(el, targets[tunnus])
            fix = overtall_fix(el, targets[tunnus], footprints[tunnus]) if not roof and tunnus in footprints else None
            yield tunnus, roof, fix
        el.clear()


def overtall_fix(el, t, polys):
    """Monitasoisen tasakattoisen rakennuksen korjaus: ("osat", [(rengas, korkeus), ...]) tai
    ("keski", korkeus), tai None, jos LOD0-korkeus vastaa kattoja. Kukin kattopinta on osa, jonka
    korkeus on pinnan keskikorkeus maanpinnasta (kuten lod2_roof_parts); mukaan otetaan pinnat,
    joiden keskipiste on LOD0-pohjan sisällä."""
    roofs, walls = surface_rings(el, "RoofSurface", t), surface_rings(el, "WallSurface", t)
    if not roofs or not walls:
        return None
    ground = min(z for r in walls for _, _, z in r)
    parts, area, hsum = [], 0.0, 0.0
    for r in roofs:
        a = abs(newell(r)[2]) / 2  # vaakaprojektion ala (m²)
        if a < 0.5:
            continue
        h = sum(z for _, _, z in r) / len(r) - ground
        area += a
        hsum += a * h
        parts.append((r, max(1.0, h), a))
    if not area:
        return None
    mean = hsum / area
    if t["korkeus"] - mean <= max(3.0, 0.25 * t["korkeus"]):
        return None
    k = math.cos(math.radians(t["lat"]))
    kept, kept_area = [], 0.0
    for r, h, a in parts:
        ring = [merc_to_lonlat(t["mx"] + x / k, t["my"] + y / k) for x, y, _ in r]
        cx, cy = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
        if any(point_in_polygon(cx, cy, poly) for poly in polys):
            kept.append((ring + [ring[0]], round(h, 1)))
            kept_area += a
    foot = sum(abs(signed_area([((x - t["lon"]) * 111320 * k, (y - t["lat"]) * 111320) for x, y in poly[0]])) for poly in polys)
    if kept and kept_area >= ROOF_PART_COVER * foot:
        return ("osat", kept)
    return ("keski", round(max(1.0, mean), 1))


def apply_height_fixes(feats, fixes):
    """Korvaa monitasoisten rakennusten LOD0-pohjat kattopintojen mukaisilla osilla tai laskee
    korkeuden kattojen keskikorkeuteen (overtall_fix)."""
    out, done = [], set()
    for f in feats:
        p = f["properties"]
        tunnus = str(p.get("tunnus"))
        fix = fixes.get(tunnus)
        if not fix:
            out.append(f)
        elif fix[0] == "keski":
            p["korkeus"], p["keski"] = fix[1], 1
            out.append(f)
        elif tunnus not in done:  # saman rakennuksen muut LOD0-pohjat jäävät pois
            done.add(tunnus)
            for ring, h in fix[1]:
                out.append({"type": "Feature", "properties": {**p, "korkeus": h, "osa": 1},
                            "geometry": {"type": "Polygon", "coordinates": [ring]}})
    kinds = collections.Counter(fix[0] for fix in fixes.values())
    log(f"  monitasoisia tasakattoisia: osiin jaettu {kinds['osat']}, keskikorkeuteen laskettu {kinds['keski']}")
    return out


def surface_rings(el, kind, t):
    """Pintojen ulkoreunat metreinä rakennuksen keskipisteestä (x itään, y pohjoiseen, z N2000)."""
    k = math.cos(math.radians(t["lat"]))  # Web Mercatorin metrit maaston metreiksi
    out = []
    for surface in el.iter(BLDG + kind):
        for poly in surface.iter(GML + "Polygon"):
            ring = poly.find(f"{GML}exterior/{GML}LinearRing")
            pts = read_positions_3d(ring) if ring is not None else []
            if len(pts) > 3 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) >= 3:
                out.append([((x - t["mx"]) * k, (y - t["my"]) * k, z) for x, y, z in pts])
    return out


def roof_mesh(el, t):
    """Räystään yläpuolinen osa rakennuksesta kolmioina tai None, jos katto on tasainen.
    Kärkipisteet ovat desimetreinä (x, y keskipisteestä, z maanpinnasta), ja kukin pinta saa omat
    kärkipisteensä, jotta selain voi varjostaa pinnat erikseen."""
    roofs, walls = surface_rings(el, "RoofSurface", t), surface_rings(el, "WallSurface", t)
    if not roofs or not walls:
        return None
    ground = min(z for r in surface_rings(el, "GroundSurface", t) or walls for _, _, z in r)
    flat = slope = 0.0
    for i, r in enumerate(roofs):
        nx, ny, nz = newell(r)
        if nz < 0:
            roofs[i] = r[::-1]
            nz = -nz
        area = math.sqrt(nx * nx + ny * ny + nz * nz) / 2
        if nz >= ROOF_FLAT_NZ * 2 * area:
            flat += area
        else:
            slope += area
    if slope < ROOF_MIN_PITCHED * (flat + slope):
        return None
    eave = min(z for r in roofs for _, _, z in r)
    ground = min(ground, eave)  # esim. maanalaisen pysäköintitilan katto maanpinnan tasolla
    if eave - ground > t["korkeus"] - 0.3:
        return None  # LOD0-mallin mukaan räystään yläpuolella ei ole mitään
    verts, tris = [], ([], [])
    skirt = max(ground, eave - ROOF_SKIRT)
    for kind, rings in ((0, roofs), (1, [clip_above(inset(r, ROOF_INSET), skirt) for r in walls])):
        for ring in rings:
            index = {}
            for tri in triangulate(ring):
                if triangle_area(*tri) < ROOF_MIN_AREA:
                    continue
                ids = []
                for x, y, z in tri:
                    key = (round(x * 10), round(y * 10), round((z - ground) * 10))
                    if key not in index:
                        index[key] = len(verts)
                        verts.append(key)
                    ids.append(index[key])
                tris[kind].append(ids)
    if not tris[0] or len(verts) > 65535 or any(abs(v) > 32767 for p in verts for v in p):
        return None
    return {"raystas": round(eave - ground, 1), "verts": verts, "katto": tris[0], "seinat": tris[1]}


def newell(pts):
    """Monikulmion normaali (pituus = kaksi kertaa pinta-ala)."""
    nx = ny = nz = 0.0
    for (x1, y1, z1), (x2, y2, z2) in zip(pts, pts[1:] + pts[:1]):
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return nx, ny, nz


def inset(poly, d):
    """Monikulmio siirrettynä matkan d normaalinsa vastaiseen suuntaan (ulospäin kierretty pinta: sisään)."""
    nx, ny, nz = newell(poly)
    n = math.sqrt(nx * nx + ny * ny + nz * nz) or 1
    return [(x - nx / n * d, y - ny / n * d, z - nz / n * d) for x, y, z in poly]


def triangle_area(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    return math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2) / 2


def clip_above(poly, zc):
    """Monikulmion osa tason z = zc yläpuolella (Sutherland–Hodgman, kiertosuunta säilyy)."""
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        if a[2] >= zc:
            out.append(a)
        if (a[2] >= zc) != (b[2] >= zc):
            s = (zc - a[2]) / (b[2] - a[2])
            out.append((a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), zc))
    return out if len(out) >= 3 else []


def triangulate(poly):
    """Tasomaisen monikulmion kolmiot korvanleikkauksella. Monikulmio projisoidaan tasoon, jonka
    normaalin suuntaa se on lähimpänä, niin että kolmioiden kiertosuunta säilyy."""
    n = newell(poly)
    ax = max(range(3), key=lambda i: abs(n[i]))
    u, v = ((1, 2), (2, 0), (0, 1))[ax]
    if n[ax] < 0:
        u, v = v, u
    p = [(q[u], q[v]) for q in poly]
    cross = lambda a, b, c: (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0])

    def inside(q, a, b, c):
        return cross(a, b, q) >= 0 and cross(b, c, q) >= 0 and cross(c, a, q) >= 0

    # Samalla suoralla olevat ja toistuvat pisteet pois (m²: kolmion ala lähes nolla).
    idx = list(range(len(poly)))
    i = 0
    while len(idx) > 3 and i < len(idx):
        if abs(cross(idx[i - 1], idx[i], idx[(i + 1) % len(idx)])) < 1e-4:
            idx.pop(i)
            i = max(0, i - 1)
        else:
            i += 1
    tris = []
    while len(idx) > 3:
        reflex = [idx[i] for i in range(len(idx)) if cross(idx[i - 1], idx[i], idx[(i + 1) % len(idx)]) < 0]
        for i in range(len(idx)):
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % len(idx)]
            if cross(a, b, c) <= 0 or any(inside(q, a, b, c) for q in reflex if q not in (a, b, c)):
                continue
            tris.append((a, b, c))
            idx.pop(i)
            break
        else:
            break  # rappeutunut monikulmio: loput jätetään pois
    if len(idx) == 3 and cross(*idx) > 0:
        tris.append(tuple(idx))
    return [(poly[a], poly[b], poly[c]) for a, b, c in tris]


def write_roof_tiles(roofs, targets):
    """Katot tiilittäin pakattuina binääritiedostoina. Rakennus: tunnus (u8 pituus + UTF-8),
    luokka (u8, index.json:n luokat), valmistumisvuosi (u16, 0 = ei tiedossa), keskipiste
    (i32 lon, lat × 10⁷), korkeus ja räystäs (u16 dm), kärkipisteiden, kattokolmioiden ja
    seinäkolmioiden määrät (u16), kärkipisteet (i16 x, y, z dm) ja kolmiot (u16)."""
    root = os.path.join(TILES, "katot")
    shutil.rmtree(root, ignore_errors=True)
    n = 2 ** ROOF_TILE_ZOOM
    classes = sorted({t["luokka"] for t in targets.values()})
    groups = collections.defaultdict(list)
    for tunnus, r in roofs.items():
        t = targets[tunnus]
        lat = math.radians(t["lat"])
        tx = int((t["lon"] + 180) / 360 * n)
        ty = int((1 - math.log(math.tan(lat) + 1 / math.cos(lat)) / math.pi) / 2 * n)
        groups[(tx, ty)].append((tunnus, t, r))
    size = 0
    for (tx, ty), items in groups.items():
        buf = bytearray(b"KAT1") + struct.pack("<I", len(items))
        for tunnus, t, r in items:
            name = tunnus.encode("utf-8")
            buf += struct.pack("<B", len(name)) + name
            dm = lambda v: min(65535, max(0, round(v * 10)))
            buf += struct.pack("<BHiiHHHHH", classes.index(t["luokka"]), min(65535, max(0, t["vuosi"] or 0)),
                               round(t["lon"] * 1e7), round(t["lat"] * 1e7), dm(t["korkeus"]),
                               dm(r["raystas"]), len(r["verts"]), len(r["katto"]), len(r["seinat"]))
            buf += struct.pack(f"<{3 * len(r['verts'])}h", *(v for p in r["verts"] for v in p))
            buf += struct.pack(f"<{3 * (len(r['katto']) + len(r['seinat']))}H", *(i for tri in r["katto"] + r["seinat"] for i in tri))
        path = os.path.join(root, str(ROOF_TILE_ZOOM), str(tx), f"{ty}.bin")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(gzip.compress(bytes(buf), 9, mtime=0))  # sama sisältö = sama tiedosto (versionhallinta)
        size += os.path.getsize(path)
    with open(os.path.join(root, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"zoom": ROOF_TILE_ZOOM, "luokat": classes, "tiilet": sorted(f"{x}/{y}" for x, y in groups)}, fh)
    log(f"  → tiles/katot: {len(roofs)} kattoa, {len(groups)} tiiltä, {size / 1e6:.1f} Mt")


def build_population():
    log("vaesto (HSY väestötietoruudukko 2025, 250 m)")
    params = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": "asuminen_ja_maankaytto:Vaestotietoruudukko_2025",
        "outputFormat": "application/json", "srsName": "EPSG:4326",
        "bbox": ",".join(map(str, (ESPOO_LONLAT[1], ESPOO_LONLAT[0], ESPOO_LONLAT[3], ESPOO_LONLAT[2]))) + ",urn:ogc:def:crs:EPSG::4326",
    }
    raw = http_get(HSY_WFS, params, os.path.join(CACHE, "vaesto.json"))
    with open(raw, encoding="utf-8") as fh:
        data = json.load(fh)
    espoo = espoo_polygons()
    feats = []
    for f in data["features"]:
        ring = f["geometry"]["coordinates"][0]
        cx = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
        cy = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
        if espoo and not any(point_in_polygon(cx, cy, poly) for poly in espoo):
            continue  # ruudun keskipiste naapurikunnassa
        p = f["properties"]
        ages = {k: v for k, v in p.items() if k.startswith("ika") and v != 99}  # 99 = suojattu pieni luku
        f["properties"] = {"asukkaita": p.get("asukkaita"), "asumisvaljyys": p.get("asvaljyys"), **ages}
        feats.append(f)
    return write_geojson("vaesto", feats)


def build_boundary():
    """Espoon ja Kauniaisen rajat, joiden avulla kartalle otetaan vain Espoon alueella
    kulkevat joukkoliikenteen ajoneuvot. Kauniainen on mukana, koska se on Espoon sisällä."""
    log("raja (Tilastokeskus, kunnat 1:1 000 000)")
    params = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeName": "tilastointialueet:kunta1000k", "outputFormat": "application/json",
        "srsName": "EPSG:4326", "CQL_FILTER": "nimi IN ('Espoo','Kauniainen')",
    }
    raw = http_get(STATFI_WFS, params, os.path.join(CACHE, "kuntarajat.json"))
    with open(raw, encoding="utf-8") as fh:
        data = json.load(fh)
    feats = []
    for f in data["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        coords = [[[[round(x, 5), round(y, 5)] for x, y in ring] for ring in poly] for poly in polys]
        feats.append({"type": "Feature", "properties": {"nimi": f["properties"]["nimi"]},
                      "geometry": {"type": "MultiPolygon", "coordinates": coords}})
    write_geojson("espoo_raja", feats, PUBLIC_DATA)


def build_bridges():
    """Siltojen reunaviivat korkeuksineen. Korkeusmallista sillat puuttuvat, joten selain
    nostaa niiden avulla silloilla kulkevat ajoneuvot kannen tasolle."""
    log(f"sillat ({BRIDGE_TYPE})")
    lines = {}
    for path in fetch_tiled(BRIDGE_TYPE, "sillat"):
        for _, el in ET.iterparse(path):
            if local(el.tag) != "Silta":
                continue
            fid = el.get(GML + "id")  # sama silta voi tulla useasta ruudusta
            for ls in el.iter(GML + "LineString"):
                pts = read_positions_3d(ls)
                if len(pts) >= 2 and any(z for _, _, z in pts):  # korkeus 0 = korkeus puuttuu
                    lines.setdefault(fid, []).append(
                        [v for x, y, z in pts for v in (*merc_to_lonlat(x, y), round(z, 2))])
            el.clear()
    viivat = [line for group in lines.values() for line in group]
    for line in viivat:
        line[:] = [round(v, 6) for v in line]
    kannet = bridge_decks(viivat)
    path = os.path.join(PUBLIC_DATA, "sillat.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"lahde": "Espoon kantakartta (kanta:Silta)", "viivat": viivat, "kannet": kannet}, fh, separators=(",", ":"))
    log(f"  → sillat.json: {len(viivat)} reunaviivaa, {len(kannet)} kantta, {os.path.getsize(path) / 1e6:.2f} Mt")


def bridge_decks(viivat):
    """Kansialueet reunaviivapareista. Aineistossa ei kerrota, mitkä viivat ovat saman kannen
    reunoja, joten kannen reunoiksi tulkitaan kaksi samansuuntaista, samalla korkeudella
    olevaa viivaa 3–40 metrin päässä toisistaan. Kullekin viivalle otetaan lähin pari
    kummaltakin puolelta. Selain nostaa maaston kannen tasolle vain siellä, missä maasto
    on kantta alempana, joten tasaisella maalla väärä pari ei muuta mitään."""
    lon0, lat0, kx, ky = 24.7, 60.2, 55462.0, 111415.0
    edges = []
    for line in viivat:
        pts = [((line[i] - lon0) * kx, (line[i + 1] - lat0) * ky, line[i + 2]) for i in range(0, len(line), 3)]
        (x0, y0, _), (x1, y1, _) = pts[0], pts[-1]
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 6:  # tukipilarit ja muut suljetut tai lyhyet viivat
            continue
        edges.append({"line": line, "pts": pts, "x0": x0, "y0": y0, "ux": (x1 - x0) / length, "uy": (y1 - y0) / length,
                      "len": length, "z": sum(p[2] for p in pts) / len(pts),
                      "mx": sum(p[0] for p in pts) / len(pts), "my": sum(p[1] for p in pts) / len(pts)})
    grid = collections.defaultdict(list)
    for i, e in enumerate(edges):
        grid[(int(e["mx"] // 100), int(e["my"] // 100))].append(i)
    pairs = set()
    for i, a in enumerate(edges):
        best = {}
        cx, cy = int(a["mx"] // 100), int(a["my"] // 100)
        for j in (j for gx in range(cx - 2, cx + 3) for gy in range(cy - 2, cy + 3) for j in grid[(gx, gy)]):
            b = edges[j]
            if j == i or abs(a["ux"] * b["ux"] + a["uy"] * b["uy"]) < 0.966 or abs(a["z"] - b["z"]) > 1.5:  # 15°
                continue
            across = [(x - a["x0"]) * -a["uy"] + (y - a["y0"]) * a["ux"] for x, y, _ in b["pts"]]
            along = [(x - a["x0"]) * a["ux"] + (y - a["y0"]) * a["uy"] for x, y, _ in b["pts"]]
            t = sum(across) / len(across)
            overlap = min(a["len"], max(along)) - max(0.0, min(along))
            if not 3 <= abs(t) <= 40 or max(across) - min(across) > 8 or overlap < 0.5 * min(a["len"], b["len"]):
                continue
            side = t > 0
            if side not in best or abs(t) < best[side][0]:
                best[side] = (abs(t), j)
        for _, j in best.values():
            pairs.add((min(i, j), max(i, j)))
    decks = []
    for i, j in sorted(pairs):
        a, b = edges[i]["line"], edges[j]["line"]
        if edges[i]["ux"] * edges[j]["ux"] + edges[i]["uy"] * edges[j]["uy"] < 0:  # sama kulkusuunta
            b = [v for k in range(len(b) - 3, -1, -3) for v in b[k:k + 3]]
        decks.append([a, b])
    return decks


def read_positions_3d(el):
    """Kuten read_positions, mutta palauttaa myös korkeuden: [(x, y, z), ...]."""
    out = []
    for c in el:
        t = local(c.tag)
        dim = int(c.get("srsDimension") or el.get("srsDimension") or 2)
        if dim < 3 or t not in ("pos", "posList"):
            continue
        v = [float(s) for s in c.text.split()]
        for i in range(0, len(v) - 2, 3):
            q = fix_position((v[i], v[i + 1]))
            if q and math.isfinite(v[i + 2]):
                out.append((q[0], q[1], v[i + 2]))
    return out


def build_rails():
    """Junien, metron ja raitiovaunujen raiteet sekä pysähtymispaikat (OpenStreetMap).
    Selain pitää junat ja vaunut raiteilla, jatkaa niiden liikettä raidetta pitkin, jos
    sijainti katkeaa, ja pysäyttää ne asemille. Varikko- ja ratapiharaiteet jätetään pois.

    Tiedosto: solmut [lon, lat, ...], raiteet [[laji, solmuindeksi, ...], ...] (laji 0 =
    rautatie, 1 = metro, 2 = raitiotie), pysakit [solmuindeksi, ...]."""
    log("raiteet (OpenStreetMap)")
    bbox = "60.04,24.45,60.41,24.90"
    query = (f'[out:json][timeout:180];way["railway"~"^(rail|subway|tram|light_rail)$"]({bbox})->.t;'
             '.t out body geom;(node(w.t)["public_transport"="stop_position"];'
             'node(w.t)["railway"~"^(stop|tram_stop|halt)$"];);out body;')
    raw = http_get(OVERPASS, {"data": query}, os.path.join(CACHE, "raiteet_osm.json"))
    with open(raw, encoding="utf-8") as fh:
        elements = json.load(fh)["elements"]
    kinds = {"rail": 0, "subway": 1, "tram": 2, "light_rail": 2}
    index, solmut, raiteet = {}, [], []
    for w in (e for e in elements if e["type"] == "way"):
        if w["tags"].get("service") in ("yard", "spur"):
            continue
        refs = []
        for node_id, pt in zip(w["nodes"], w["geometry"]):
            if node_id not in index:
                index[node_id] = len(solmut) // 2
                solmut += [round(pt["lon"], 6), round(pt["lat"], 6)]
            refs.append(index[node_id])
        raiteet.append([kinds[w["tags"]["railway"]], *refs])
    pysakit = sorted({index[e["id"]] for e in elements if e["type"] == "node" and e["id"] in index})
    path = os.path.join(PUBLIC_DATA, "raiteet.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"lahde": "© OpenStreetMap-tekijät (ODbL)", "solmut": solmut, "raiteet": raiteet, "pysakit": pysakit},
                  fh, separators=(",", ":"))
    log(f"  → raiteet.json: {len(raiteet)} raidetta, {len(solmut) // 2} solmua, {len(pysakit)} pysähtymispaikkaa, "
        f"{os.path.getsize(path) / 1e3:.0f} kt")


def build_district_labels():
    """Kaupunginosien nimille yksi piste kunkin alueen sisältä. Rajat ulottuvat usein
    merelle, joten nimi sijoitetaan alueen rakennusten keskelle, kun rakennukset on ladattu."""
    log("kaupunginosien nimet")
    path = os.path.join(OUT, "kaupunginosat.geojson")
    with open(path, encoding="utf-8") as fh:
        src = json.load(fh)["features"]
    buildings = building_points()
    feats = []
    for f in src:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        poly = max(polys, key=lambda p: abs(signed_area(p[0])))
        point = building_center(polys, buildings) or label_point(poly)
        feats.append({
            "type": "Feature",
            "properties": {"nimi": district_name(f["properties"].get("KAUPUNGINOSANNIMI_FI"))},
            "geometry": {"type": "Point", "coordinates": point},
        })
    write_geojson("kaupunginosat_nimet", feats, PUBLIC_DATA)


def district_name(s):
    # ESPOON KESKUS → Espoon keskus, POHJOIS-TAPIOLA → Pohjois-Tapiola
    return "-".join(part[:1].upper() + part[1:] for part in str(s or "").lower().split("-"))


def building_points():
    path = os.path.join(OUT, "rakennukset.geojson")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        pts = []
        for f in json.load(fh)["features"]:
            g = f["geometry"]
            ring = (g["coordinates"] if g["type"] == "Polygon" else g["coordinates"][0])[0]
            pts.append((ring[0][0], ring[0][1]))
    return pts


def building_center(polys, pts):
    """Alueen sisällä olevista rakennuksista se, joka on lähimpänä niiden keskipistettä."""
    coarse = [[r[:: max(1, len(r) // 200)] + [r[-1]] for r in poly] for poly in polys]
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    inside = [p for p in pts if minx <= p[0] <= maxx and miny <= p[1] <= maxy
              and any(point_in_polygon(p[0], p[1], c) for c in coarse)]
    if len(inside) < 5:
        return None
    mx = sum(p[0] for p in inside) / len(inside)
    my = sum(p[1] for p in inside) / len(inside)
    best = min(inside, key=lambda p: ((p[0] - mx) * 0.5) ** 2 + (p[1] - my) ** 2)
    return [round(best[0], 6), round(best[1], 6)]


def label_point(poly):
    """Karkea 'kauimpana reunoista' -piste: ruudukkohaku monikulmion sisältä.
    Etäisyys lasketaan harvennettuun reunaan, sillä tarkkuudeksi riittää nimen sijoitus."""
    ring = poly[0]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    step = max(1, len(ring) // 150)
    coarse = [r[::step] + [r[-1]] for r in poly]
    best, best_d = None, -1.0
    n = 16
    for i in range(1, n):
        for j in range(1, n):
            x = min(xs) + (max(xs) - min(xs)) * i / n
            y = min(ys) + (max(ys) - min(ys)) * j / n
            if not point_in_polygon(x, y, poly):
                continue
            d = min(seg_dist(x, y, r[k], r[k + 1]) for r in coarse for k in range(len(r) - 1))
            if d > best_d:
                best, best_d = [round(x, 6), round(y, 6)], d
    return best or ring[0]


def seg_dist(x, y, a, b):
    # Leveyspiirillä 60° pituusaste on noin puolet leveysasteesta, joten x skaalataan.
    k = 0.5
    ax, ay, bx, by = a[0] * k, a[1], b[0] * k, b[1]
    px, py = x * k, y
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def espoo_polygons():
    """Espoon kaupunginosat polygonilistana (rajaukseen); tyhjä, jos aineistoa ei vielä ole."""
    path = os.path.join(OUT, "kaupunginosat.geojson")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        polys = []
        for f in json.load(fh)["features"]:
            g = f["geometry"]
            polys.extend([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"])
    return polys


def point_in_polygon(x, y, poly):
    inside = False
    for ring in poly:  # reiät kääntävät tuloksen takaisin
        for i in range(len(ring) - 1):
            (x1, y1), (x2, y2) = ring[i], ring[i + 1]
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


# ---------------------------------------------------------------- purot ja joet

SYKE_HY_WFS = "https://paikkatiedot.ymparisto.fi/geoserver/inspire_hy/wfs"
HYDRO_API = "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata"
# Syken jatkuvasti mittaava virtaama-asema Espoonjoessa. Muiden uomien virtaama arvioidaan sen avulla.
STREAM_STATION = {"id": 3006, "nimi": "Espoonjoki", "lon": 24.5967, "lat": 60.1856}
# Uomat ja valuma-alueet haetaan Espoota laajemmalta alueelta (lat, lon, lat, lon), jotta Espoon
# läpi virtaavien uomien yläjuoksun valuma-ala tulee mukaan.
STREAM_OSM_BBOX = (60.0, 24.30, 60.50, 25.0)
STREAM_SYKE_BBOX = (60.0, 24.25, 60.55, 25.1)
STREAM_MARGIN = 500  # m: näin kaukana Espoon rajan takana olevat uomat ovat mukana
STREAM_SIMPLIFY = 0.7  # m


def stream_xy(lon, lat):
    """Paikalliset metrit kuten selaimessa (transit.js, bridges.js)."""
    return (lon - 24.7) * 55462.0, (lat - 60.2) * 111415.0


def build_streams():
    """Purot ja joet virtaussuuntineen ja yläpuolisine valuma-aloineen sekä Espoonjoen
    virtaaman kuukausitilastot. Selain arvioi muiden uomien virtaaman valuma-alan suhteessa
    Espoonjoen mittaukseen ja näyttää virtauksen lähikuvassa (streams.js).

    Uomat ovat OpenStreetMapista (waterway=river/stream/canal). Viivat on piirretty
    virtaussuuntaan (Espoossa Syken uomaverkoston kanssa päällekkäisistä uomista 99,9 %
    samaan suuntaan), ja rummut on merkitty. Yläpuolinen valuma-ala kertyy alavirtaan Syken
    valuma-aluejaon pienimmistä alueista: kunkin alueen oma pinta-ala jaetaan sen sisällä
    kulkeville uomille pituuksien suhteessa. Järvien kohdalla OSM:n uomat katkeavat, joten
    alueiden purkupisteissä kertymä nostetaan vähintään Syken laskemaan yläpuoliseen valuma-alaan.

    Tiedosto: asema {id, nimi, lon, lat, ala, kuukaudet [[mediaani, p10, p90] × 12], jakso},
    uomat [{p: [lon, lat, ...] alavirtaan, o: [[alkupiste, valuma-ala km², rumpu, nimi], ...]}],
    jossa o:n rivi kuvaa ketjun osuutta pisteestä alkupiste seuraavan osuuden alkuun."""
    log("purot (OpenStreetMap, Syke)")
    s, w, n, e = STREAM_OSM_BBOX
    query = f'[out:json][timeout:240];way["waterway"~"^(river|stream|canal)$"]({s},{w},{n},{e});out body geom;'
    raw = http_get(OVERPASS, {"data": query}, os.path.join(CACHE, "purot_osm.json"))
    with open(raw, encoding="utf-8") as fh:
        data = json.load(fh)
    if "error" in data.get("remark", ""):  # Overpass voi keskeyttää haun ja palauttaa vain osan
        os.remove(raw)
        raise RuntimeError(f"Overpass: {data['remark']}")
    pieces = stream_pieces([el for el in data["elements"] if el["type"] == "way"])

    def syke(type_name, name):
        s, w, n, e = STREAM_SYKE_BBOX
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": "inspire_hy:" + type_name,
                  "outputFormat": "application/json", "srsName": "EPSG:4326",
                  "bbox": f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326"}  # WFS 2.0: leveysaste ensin
        with open(http_get(SYKE_HY_WFS, params, os.path.join(CACHE, name)), encoding="utf-8") as fh:
            return json.load(fh)["features"]

    areas = syke("HY.ValumaAluejakoTaso5", "valuma_taso5.json")
    outlets = syke("HY.ValumaAluejakoPurkupisteet", "valuma_purkupisteet.json")
    stream_local_areas(pieces, areas)
    acc = stream_accumulate(pieces, {})
    for _ in range(3):  # yhtymäkohtien parit tarkentuvat, kun yläjuoksun kertymät tarkentuvat
        acc = stream_accumulate(pieces, stream_outlet_anchors(pieces, areas, outlets, acc))

    keep = stream_region_filter(pieces)
    uomat = []
    for chain in stream_chains(pieces, acc, keep):
        verts, osat = [], []
        for i in chain:
            p = pieces[i]
            ll = [p["ll"][k] for k in simplify_indices(p["xy"], STREAM_SIMPLIFY)]
            start = max(len(verts) - 1, 0)  # osuus alkaa edellisen osuuden loppupisteestä
            verts += ll if not verts else ll[1:]
            osat.append([start, round(acc[i], 3), int(p["culvert"]), p["name"]])
        uomat.append({"p": [round(v, 6) for q in verts for v in q], "o": osat})

    station = dict(STREAM_STATION)
    sx, sy = stream_xy(station["lon"], station["lat"])
    near = [i for i in range(len(pieces)) if keep[i] and point_line_distance(sx, sy, pieces[i]["xy"]) < 150]
    station["ala"] = round(max(acc[i] for i in near), 2)
    station.update(stream_station_stats(station["id"]))
    path = os.path.join(PUBLIC_DATA, "purot.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"lahde": "Uomat © OpenStreetMap-tekijät (ODbL), valuma-alueet ja virtaama © Syke (CC BY 4.0)",
                   "asema": station, "uomat": uomat}, fh, ensure_ascii=False, separators=(",", ":"))
    kept = [p for p, k in zip(pieces, keep) if k]
    log(f"  → purot.json: {len(uomat)} ketjua, {len(kept)} osuutta, {sum(p['len'] for p in kept) / 1000:.0f} km "
        f"(rumpuja {sum(p['len'] for p in kept if p['culvert']) / 1000:.0f} km), Espoonjoen valuma-ala asemalla "
        f"{station['ala']} km², {os.path.getsize(path) / 1e3:.0f} kt")


def stream_pieces(ways):
    """OSM:n uomaviivat osuuksiksi risteyskohdista: alku- ja loppusolmu, pisteet, nimi ja rumpu."""
    use = collections.Counter(nd for w in ways for nd in w["nodes"])
    pieces = []
    for w in ways:
        t, nodes, geom = w["tags"], w["nodes"], w["geometry"]
        name = t.get("name") or t.get("name:fi") or t.get("name:sv") or ""
        culvert = t.get("tunnel") in ("culvert", "yes", "flooded", "pipe") or t.get("culvert") == "yes"
        start = 0
        for i in range(1, len(nodes)):
            if i == len(nodes) - 1 or use[nodes[i]] > 1:
                ll = [(geom[k]["lon"], geom[k]["lat"]) for k in range(start, i + 1)]
                xy = [stream_xy(*q) for q in ll]
                length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(xy, xy[1:]))
                pieces.append({"a": nodes[start], "b": nodes[i], "ll": ll, "xy": xy, "len": length,
                               "name": name, "culvert": culvert, "river": t["waterway"] == "river"})
                start = i
    return pieces


def stream_main_branches(pieces):
    """Haarautumissa (esim. myllykanava tai sivu-uoma, joka on piirretty joesta poispäin) vesi jatkaa
    päähaaraan: sama nimi kuin tulevalla uomalla, joki ennen puroa, avouoma ennen rumpua, pisin."""
    outs, names = collections.defaultdict(list), collections.defaultdict(set)
    for i, p in enumerate(pieces):
        outs[p["a"]].append(i)
        if p["name"]:
            names[p["b"]].add(p["name"])
    rank = lambda node: lambda i: (pieces[i]["name"] in names[node], pieces[i]["river"], not pieces[i]["culvert"], pieces[i]["len"])
    return {node: max(idx, key=rank(node)) for node, idx in outs.items() if len(idx) > 1}


def stream_local_areas(pieces, areas):
    """Valuma-alueen oma pinta-ala (km²) jaetaan alueella kulkeville uomille pituuksien suhteessa.
    Osuus kuuluu alueeseen, jolla sen keskimmäinen piste on."""
    cells, polys = collections.defaultdict(list), []
    for f in areas:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            rings = [[stream_xy(x, y) for x, y, *_ in ring] for ring in poly]
            xs, ys = [x for x, _ in rings[0]], [y for _, y in rings[0]]
            for cx in range(int(min(xs) // 2000), int(max(xs) // 2000) + 1):
                for cy in range(int(min(ys) // 2000), int(max(ys) // 2000) + 1):
                    cells[(cx, cy)].append(len(polys))
            polys.append((rings, f["properties"]))
    members = collections.defaultdict(list)
    for i, p in enumerate(pieces):
        p["local"] = 0.0
        mx, my = p["xy"][len(p["xy"]) // 2]
        for k in cells.get((int(mx // 2000), int(my // 2000)), []):
            if point_in_polygon(mx, my, polys[k][0]):
                members[polys[k][1]["objectid"]].append((i, polys[k][1]))
                break
    for group in members.values():
        total = sum(pieces[i]["len"] for i, _ in group)
        area = (group[0][1]["osavalu_pa_ha"] or 0) / 100
        for i, _ in group:
            pieces[i]["local"] = area * (pieces[i]["len"] / total if total else 1 / len(group))


def stream_accumulate(pieces, anchors):
    """Yläpuolinen valuma-ala osuuden alapäässä (km²): yläpuolisten osuuksien kertymä ja osuuden oma
    osa. anchors[i] = (ala, tarkka): tarkka ala korvaa yläpuolisten kertymän, muuten se on alaraja.
    Haarautumassa kertymä jatkuu vain päähaaraan. Silmukat (esim. virheellisesti piirretyt uomat)
    puretaan käsittelemällä jokin niiden osuuksista ensin."""
    outs, ins = collections.defaultdict(list), collections.defaultdict(list)
    for i, p in enumerate(pieces):
        outs[p["a"]].append(i)
        ins[p["b"]].append(i)
    main = stream_main_branches(pieces)
    indeg = [len(ins[p["a"]]) for p in pieces]
    queue = collections.deque(i for i, d in enumerate(indeg) if d == 0)
    acc = [None] * len(pieces)
    pending = 0
    while True:
        while queue:
            i = queue.popleft()
            if acc[i] is not None:
                continue
            p = pieces[i]
            inflow = sum(acc[j] for j in ins[p["a"]] if acc[j] is not None) if main.get(p["a"], i) == i else 0.0
            area, exact = anchors.get(i, (0, False))
            acc[i] = area + p["local"] if exact else max(inflow + p["local"], area)
            for k in outs[p["b"]]:
                indeg[k] -= 1
                if indeg[k] == 0:
                    queue.append(k)
        while pending < len(pieces) and acc[pending] is not None:
            pending += 1
        if pending == len(pieces):
            return acc
        queue.append(pending)


def stream_outlet_anchors(pieces, areas, outlets, acc):
    """Valuma-alueiden purkupisteet uomaosuuksille: purkupisteen yläpuolinen valuma-ala on Syken
    laskema. Purkupiste on alueen alapäässä, joten sen kohdalle päättyvä tai sen ohi kulkeva osuus
    saa alueen yläpuolisen valuma-alan alarajaksi. Samassa pisteessä olevat purkupisteet ovat
    yhtymäkohtaan laskevia uomia: suurin valuma-ala annetaan osuudelle, jonka kertymä on suurin,
    ja pisteestä alavirtaan lähtevän pääuoman ala on tarkalleen niiden summa. Yksittäiselle
    purkupisteelle valitaan lähellä (40 m) olevista osuuksista se, jonka kertymä on lähimpänä
    Syken arvoa."""
    upstream = {f["properties"]["taso5_id"]: f["properties"]["ylavalu_pa_km2"] for f in areas}
    grid = collections.defaultdict(set)
    for i, p in enumerate(pieces):
        for x, y in p["xy"]:
            grid[(int(x // 50), int(y // 50))].add(i)
    groups = collections.defaultdict(list)
    for o in outlets:
        area = upstream.get(o["properties"]["taso5_id"])
        g = o["geometry"]
        if area:
            x, y = stream_xy(*(g["coordinates"][0] if g["type"] == "MultiPoint" else g["coordinates"])[:2])
            groups[(round(x), round(y))].append(area)
    main = stream_main_branches(pieces)
    anchors = {}

    def raise_to(i, area):
        if not anchors.get(i, (0, False))[1]:
            anchors[i] = (max(anchors.get(i, (0, False))[0], area), False)

    for (x, y), group in groups.items():
        cands = {i for cx in range(int(x // 50) - 1, int(x // 50) + 2) for cy in range(int(y // 50) - 1, int(y // 50) + 2)
                 for i in grid.get((cx, cy), ())}
        cands = [i for i in cands if point_line_distance(x, y, pieces[i]["xy"]) < 40]
        near = lambda q: math.hypot(q[0] - x, q[1] - y) < 40
        leaving = [i for i in cands if near(pieces[i]["xy"][0]) and not near(pieces[i]["xy"][-1])]
        arriving = [i for i in cands if i not in leaving]
        if len(group) == 1:
            pool = arriving or leaving
            if pool:
                raise_to(min(pool, key=lambda i: abs(math.log((acc[i] + 0.01) / group[0]))), group[0])
            continue
        for area, i in zip(sorted(group, reverse=True), sorted(arriving, key=lambda i: -acc[i])):
            raise_to(i, area)
        if leaving:
            mains = [i for i in leaving if main.get(pieces[i]["a"], i) == i]
            anchors[max(mains or leaving, key=lambda i: (pieces[i]["river"], pieces[i]["len"]))] = (sum(group), True)
    return anchors


def stream_region_filter(pieces):
    """Osuudet Espoon (ja Kauniaisten) alueella tai enintään STREAM_MARGIN metrin päässä rajasta."""
    with open(os.path.join(PUBLIC_DATA, "espoo_raja.geojson"), encoding="utf-8") as fh:
        polys = [[[stream_xy(x, y) for x, y in ring] for ring in poly]
                 for f in json.load(fh)["features"] for poly in f["geometry"]["coordinates"]]
    edges = [(a, b) for poly in polys for ring in poly for a, b in zip(ring, ring[1:])]

    def near(x, y):
        if any(point_in_polygon(x, y, poly) for poly in polys):
            return True
        return any(point_line_distance(x, y, [a, b]) < STREAM_MARGIN for a, b in edges
                   if min(a[0], b[0]) - STREAM_MARGIN < x < max(a[0], b[0]) + STREAM_MARGIN
                   and min(a[1], b[1]) - STREAM_MARGIN < y < max(a[1], b[1]) + STREAM_MARGIN)

    return [near(*p["xy"][0]) or near(*p["xy"][-1]) for p in pieces]


def stream_chains(pieces, acc, keep):
    """Osuudet ketjuiksi lähteeltä alavirtaan. Risteyksessä ketju jatkuu suurimmasta yläpuolisesta
    uomasta; sivu-uoman ketju päättyy risteykseen. Selain kuljettaa virtaviivoja ketjua pitkin."""
    ins = collections.defaultdict(list)
    for i, p in enumerate(pieces):
        if keep[i]:
            ins[p["b"]].append(i)
    parent, nxt = {}, {}
    for i, p in enumerate(pieces):
        ups = ins.get(p["a"]) if keep[i] else None
        if ups:
            parent[i] = max(ups, key=lambda j: acc[j])
    for i, j in parent.items():
        if j not in nxt or acc[i] > acc[nxt[j]]:
            nxt[j] = i
    used, chains = set(), []
    # Ensin ketjut lähteiltä ja sivu-uomista, sitten silmukoihin jääneet osuudet.
    starts = [i for i in range(len(pieces)) if keep[i] and nxt.get(parent.get(i)) != i]
    for i in starts + [i for i in range(len(pieces)) if keep[i]]:
        if i in used:
            continue
        chain = []
        while i is not None and i not in used:
            used.add(i)
            chain.append(i)
            i = nxt.get(i)
        chains.append(chain)
    return chains


def point_line_distance(x, y, pts):
    best = math.inf
    for (ax, ay), (bx, by) in zip(pts, pts[1:]) if len(pts) > 1 else [(pts[0], pts[0])]:
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / len2)) if len2 else 0.0
        best = min(best, math.hypot(ax + t * dx - x, ay + t * dy - y))
    return best


def simplify_indices(pts, tol):
    """Douglas–Peucker: säilytettävien pisteiden indeksit (päätepisteet aina mukana)."""
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = pts[i], pts[j]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        best, k = tol, None
        for m in range(i + 1, j):
            px, py = pts[m]
            d = abs((px - ax) * dy - (py - ay) * dx) / length if length else math.hypot(px - ax, py - ay)
            if d > best:
                best, k = d, m
        if k is not None:
            keep.add(k)
            stack += [(i, k), (k, j)]
    return sorted(keep)


def stream_station_stats(station_id):
    """Aseman päivävirtaamien kuukausittainen mediaani sekä 10 % ja 90 % fraktiilit (m³/s).
    Hydrologiarajapinta palauttaa JSONia vain Accept-otsakkeella, ja sivulla on enintään 500 riviä."""
    dest = os.path.join(CACHE, f"virtaama_{station_id}.json")
    if not os.path.exists(dest):
        rows, skip = [], 0
        while True:
            q = urllib.parse.urlencode({"$filter": f"Paikka_Id eq {station_id}", "$orderby": "Aika",
                                        "$select": "Aika,Arvo", "$top": 500, "$skip": skip})
            req = urllib.request.Request(f"{HYDRO_API}/Virtaama?{q}", headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                page = json.load(r)["value"]
            rows += page
            if len(page) < 500:
                break
            skip += 500
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(rows, fh)
    with open(dest, encoding="utf-8") as fh:
        rows = [r for r in json.load(fh) if r["Arvo"] is not None]
    by_month = collections.defaultdict(list)
    for r in rows:
        by_month[int(r["Aika"][5:7])].append(float(r["Arvo"]))
    quantile = lambda v, f: v[min(len(v) - 1, int(f * len(v)))]
    months = []
    for m in range(1, 13):
        v = sorted(by_month[m])
        months.append([round(quantile(v, f), 3) for f in (0.5, 0.1, 0.9)])
    return {"kuukaudet": months, "jakso": f"{rows[0]['Aika'][:4]}–{rows[-1]['Aika'][:4]}"}


# ---------------------------------------------------------------- sähköautojen lataus

AFIR_API = "https://afir.digitraffic.fi/api/charging-network/v1"
OVERPASS_MIRRORS = [OVERPASS, "https://overpass.kumi.systems/api/interpreter",
                    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
# Latauksessa olevat autot sijoitetaan latauspaikan ympärille rinnakkain. Teiden ja rakennusten
# suhteen henkilöauto (4,6 × 1,9 m) on kapseli: keskiakselin puolipituus ja säde. Autojen
# keskinäinen väli tarkistetaan suorakulmioina (puolikkaat mitat, pieni väli mukana).
CAR_AXIS, CAR_R, CAR_HALF = 1.35, 0.95, (2.4, 1.05)
SLOT_PITCH = 2.7  # m: rinnakkain pysäköityjen autojen väli
ROW_PITCH = 6.0  # m: rivien väli
SLOT_REACH = 90  # m: ruudut enintään näin kaukana latauspaikasta
SLOT_MAX = 40  # ruutuja enintään yhdelle latauspaikalle
SLOT_CELL = 8.0  # m: esteiden hakuruudukko
CHARGE_OSM_REACH = 250  # m: OpenStreetMap-kohteet näin kaukaa latauspaikoista
# Tien puolileveys (m) tyypin mukaan. Kevyen liikenteen väylätkin pidetään vapaina.
ROAD_HALF = {
    "motorway": 7.5, "trunk": 7.0, "primary": 5.5, "secondary": 5.0, "tertiary": 4.5,
    "motorway_link": 4.5, "trunk_link": 4.5, "primary_link": 4.0, "secondary_link": 4.0, "tertiary_link": 3.5,
    "unclassified": 3.5, "residential": 3.5, "living_street": 3.0, "busway": 3.5, "road": 3.5,
    "service": 2.8, "pedestrian": 2.5, "track": 1.8, "cycleway": 1.5, "footway": 1.3, "path": 1.2,
    "steps": 1.2, "bridleway": 1.2, "platform": 1.5,
}
PLUGS = {"IEC_62196_T2": "Type 2", "IEC_62196_T2_COMBO": "CCS", "CHADEMO": "CHAdeMO", "DOMESTIC_F": "Schuko",
         "IEC_62196_T1": "Type 1", "IEC_62196_T1_COMBO": "CCS1", "TESLA_S": "Tesla", "TESLA_R": "Tesla", "MCS": "MCS"}
# Latausmerkit nimen, operaattorin, merkin tai verkon tekstistä (AFIR ja OpenStreetMap kirjoittavat
# ne eri tavoin). Virta on monen merkin taustajärjestelmä, joten se ei yksin erota merkkejä.
CHARGE_BRANDS = [
    ("virta", "virta"), ("k auto", "k"), ("k-lataus", "k"), ("k lataus", "k"), ("kesko", "k"), ("k-market", "k"),
    ("k-supermarket", "k"), ("k-citymarket", "k"), ("k-rauta", "k"), ("plugit", "plugit"), ("aimo", "aimo"),
    ("abc", "abc"), ("s-market", "abc"), ("prisma", "abc"), ("alepa", "abc"), ("lidl", "lidl"), ("eparking", "eparking"),
    ("evenli", "evenli"), ("helen", "helen"), ("tesla", "tesla"), ("st1", "st1"), ("recharge", "recharge"),
    ("fortum", "recharge"), ("neste", "neste"), ("wattery", "wattery"), ("faast", "faast"), ("porsche", "porsche"),
    ("ionity", "ionity"), ("allego", "allego"),
]
# Nimen sanat, jotka eivät erota latauspaikkoja toisistaan.
CHARGE_STOP = {"lataus", "latausasema", "latauspiste", "charging", "charge", "station", "espoo", "finland", "oy", "ab", "oyj",
               "ltd", "the", "market", "supermarket", "citymarket", "kauppakeskus", "pysäköinti", "parkki", "parking",
               "sähköauto", "auto", "areena"}
STATION_REACH = 300  # m: OpenStreetMapin latausasema enintään näin kaukana operaattorin sijainnista


def local_xy(lon, lat):
    # Paikallinen metrikoordinaatisto kuten selaimessa (transit.js); vääristymä Espoossa alle 1 %.
    return (lon - 24.7) * 55462.0, (lat - 60.2) * 111415.0


def local_lonlat(x, y):
    return round(24.7 + x / 55462.0, 6), round(60.2 + y / 111415.0, 6)


def overpass_post(query, dest, timeout=360):
    """Pitkä Overpass-kysely POST-pyyntönä välimuistiin. Ruuhkaisen palvelimen tilalla
    kokeillaan seuraavaa. Varapalvelinten aineisto voi olla kuukausia vanha (esim. puolet
    pysäköintiruuduista puuttui), joten yli viikon vanha vastaus kelpaa vain, jos tuoreempaa ei saada."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    body = urllib.parse.urlencode({"data": query}).encode()
    week_ago = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7 * 86400))
    stale = None
    for attempt in range(3):
        for url in OVERPASS_MIRRORS:
            try:
                try:
                    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=timeout) as r:
                        data = r.read()
                except Exception as e:
                    if "SSL" not in str(e) or not shutil.which("curl"):
                        raise
                    # macOS:n järjestelmä-Pythonin TLS ei kelpaa kaikille palvelimille; curl kelpaa.
                    data = subprocess.run(["curl", "-sf", "-A", UA, "--data-binary", "@-", url], input=body,
                                          capture_output=True, check=True, timeout=timeout).stdout
                parsed = json.loads(data)  # ruuhkainen palvelin vastaa HTML-sivulla
                if "runtime error" in parsed.get("remark", ""):
                    raise RuntimeError(parsed["remark"][:200])
                base = parsed.get("osm3s", {}).get("timestamp_osm_base", "")
                if base < week_ago:
                    log(f"  Overpass {url.split('/')[2]}: aineisto {base[:10]}, haetaan tuoreempaa")
                    if stale is None or base > stale[0]:
                        stale = (base, data)
                    continue
                stale = (base, data)
                break
            except Exception as e:
                log(f"  Overpass {url.split('/')[2]}: {str(e)[:120]}")
        else:
            time.sleep(30)
            continue
        break
    if stale is None:
        raise RuntimeError("Overpass-kysely epäonnistui")
    with open(dest + ".part", "wb") as fh:
        fh.write(stale[1])
    os.replace(dest + ".part", dest)
    return dest


def join_rings(lines):
    """Relaation ulkoreunat yhtenäisiksi renkaiksi (jäsenet voivat olla paloina)."""
    rings, rest = [], [list(l) for l in lines if len(l) >= 2]
    while rest:
        cur = rest.pop()
        joined = True
        while cur[0] != cur[-1] and joined:
            joined = False
            for i, l in enumerate(rest):
                if l[0] == cur[-1]:
                    cur += l[1:]
                elif l[-1] == cur[-1]:
                    cur += l[::-1][1:]
                elif l[-1] == cur[0]:
                    cur = l[:-1] + cur
                elif l[0] == cur[0]:
                    cur = l[::-1][:-1] + cur
                else:
                    continue
                rest.pop(i)
                joined = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def seg_seg_dist(ax, ay, bx, by, cx, cy, dx, dy):
    """Janojen AB ja CD lyhin etäisyys (metreinä)."""
    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)

    if orient(ax, ay, bx, by, cx, cy) * orient(ax, ay, bx, by, dx, dy) < 0 \
            and orient(cx, cy, dx, dy, ax, ay) * orient(cx, cy, dx, dy, bx, by) < 0:
        return 0.0

    def pt(px, py, qx, qy, rx, ry):
        vx, vy = rx - qx, ry - qy
        l2 = vx * vx + vy * vy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - qx) * vx + (py - qy) * vy) / l2))
        return math.hypot(qx + t * vx - px, qy + t * vy - py)

    return min(pt(ax, ay, cx, cy, dx, dy), pt(bx, by, cx, cy, dx, dy), pt(cx, cy, ax, ay, bx, by), pt(dx, dy, ax, ay, bx, by))


def road_half(tags):
    """Tien puolileveys (m) tai None, jos väylä ei ole maan pinnalla autojen tiellä."""
    kind = tags.get("highway")
    if tags.get("area") == "yes" or tags.get("indoor") == "yes" or tags.get("tunnel") in ("yes", "building_passage", "culvert"):
        return None
    if tags.get("layer", "0").startswith("-"):
        return None
    half = ROAD_HALF.get(kind) or (3.5 if kind and kind.endswith("_link") else None)
    if half is None:
        return None
    if tags.get("service") == "parking_aisle":
        half = 2.6
    elif tags.get("service") == "driveway":
        half = 2.0
    try:
        half = max(half, float(tags.get("width", "0").replace(",", ".").split()[0]) / 2)
    except (ValueError, IndexError):
        pass
    if tags.get("lanes", "").isdigit():
        half = max(half, int(tags["lanes"]) * 1.6)
    return half


def slot_axis(cx, cy, hx, hy):
    return cx + hx * CAR_AXIS, cy + hy * CAR_AXIS, cx - hx * CAR_AXIS, cy - hy * CAR_AXIS


def cars_overlap(a, b):
    """Menevätkö kaksi autoa (keskipiste ja suuntavektori) päällekkäin (erottava akseli)."""
    (ax, ay, ahx, ahy), (bx, by, bhx, bhy) = a, b
    L, W = CAR_HALF
    for ux, uy in ((ahx, ahy), (-ahy, ahx), (bhx, bhy), (-bhy, bhx)):
        ra = L * abs(ahx * ux + ahy * uy) + W * abs(ahx * uy - ahy * ux)
        rb = L * abs(bhx * ux + bhy * uy) + W * abs(bhx * uy - bhy * ux)
        if abs((bx - ax) * ux + (by - ay) * uy) > ra + rb:
            return False
    return True


class SlotObstacles:
    """Tiet, rakennukset ja jo valitut ruudut ruudukossa. Tie ja seinä tallennetaan jokaiseen
    ruutuun, johon niiden vaatima vapaa tila ulottuu, joten ehdokkaan kohdalla riittää
    tarkistaa ehdokkaan omat ruudut."""

    def __init__(self):
        self.segs = collections.defaultdict(list)
        self.buildings = collections.defaultdict(list)
        self.rings = []
        self.cars = collections.defaultdict(list)

    @staticmethod
    def cells(x0, y0, x1, y1):
        return [(gx, gy) for gx in range(math.floor(x0 / SLOT_CELL), math.floor(x1 / SLOT_CELL) + 1)
                for gy in range(math.floor(y0 / SLOT_CELL), math.floor(y1 / SLOT_CELL) + 1)]

    def add_seg(self, ax, ay, bx, by, clear):
        for c in self.cells(min(ax, bx) - clear, min(ay, by) - clear, max(ax, bx) + clear, max(ay, by) + clear):
            self.segs[c].append((ax, ay, bx, by, clear))

    def add_building(self, rings):
        xs, ys = [p[0] for p in rings[0]], [p[1] for p in rings[0]]
        for c in self.cells(min(xs), min(ys), max(xs), max(ys)):
            self.buildings[c].append(len(self.rings))
        self.rings.append(rings)
        for ring in rings:
            for (ax, ay), (bx, by) in zip(ring, ring[1:]):
                self.add_seg(ax, ay, bx, by, CAR_R + 0.25)

    def in_building(self, x, y):
        return any(point_in_polygon(x, y, self.rings[i])
                   for i in self.buildings.get((math.floor(x / SLOT_CELL), math.floor(y / SLOT_CELL)), ()))

    def free(self, car, cars=True):
        """Mahtuuko auto (keskipiste ja suunta) tiestä, rakennuksista ja (cars) muista autoista."""
        cx, cy, hx, hy = car
        px, py, qx, qy = slot_axis(cx, cy, hx, hy)
        for c in self.cells(min(px, qx) - CAR_R, min(py, qy) - CAR_R, max(px, qx) + CAR_R, max(py, qy) + CAR_R):
            for ax, ay, bx, by, clear in self.segs.get(c, ()):
                if seg_seg_dist(px, py, qx, qy, ax, ay, bx, by) < clear:
                    return False
        if cars and any(cars_overlap(car, other) for c in self.cells(cx - 2.7, cy - 2.7, cx + 2.7, cy + 2.7)
                        for other in self.cars.get(c, ())):
            return False
        return not any(self.in_building(x, y) for x, y in ((px, py), (qx, qy), (cx, cy)))

    def take(self, car):
        cx, cy = car[0], car[1]
        for c in self.cells(cx - 2.7, cy - 2.7, cx + 2.7, cy + 2.7):
            self.cars[c].append(car)


def ring_dirs(ring, anchor):
    """Pysäköintialueen rivisuunnat: reunojen kaksi pääsuuntaa ja latauspaikkaa lähimmän
    suoran reunan suunta (kaarevalla tai vinolla alueella se on paikallisesti parempi)."""
    s = c = 0.0
    near = None
    for (ax, ay), (bx, by) in zip(ring, ring[1:]):
        L = math.hypot(bx - ax, by - ay)
        a = math.atan2(by - ay, bx - ax)
        s += L * math.sin(4 * a)
        c += L * math.cos(4 * a)
        d = seg_seg_dist(anchor[0], anchor[1], anchor[0], anchor[1], ax, ay, bx, by)
        if L >= 8 and (near is None or d < near[0]):
            near = (d, (bx - ax) / L, (by - ay) / L)
    phi = math.atan2(s, c) / 4
    dirs = [(math.cos(phi), math.sin(phi)), (-math.sin(phi), math.cos(phi))]
    if near and all(abs(near[1] * ux + near[2] * uy) < 0.985 for ux, uy in dirs):  # yli 10° poikkeama
        dirs += [(near[1], near[2]), (-near[2], near[1])]
    return dirs


def grid_slots(anchor, rings, u, obst, penalty, kind):
    """Rinnakkaiset ruudut riveissä suuntaan u. Pysäköintialueella (rings) ensimmäinen rivi on
    latauspaikkaa lähimmän samansuuntaisen reunan vieressä keula reunaa kohti ja seuraavat
    sisempänä. Ilman aluetta (rings None) rivit ovat latauspaikan kohdalla molemmin puolin."""
    ax, ay = anchor
    ux, uy = u
    nx, ny = -uy, ux
    out, edges = [], []
    if rings is not None:
        best = None
        for (px, py), (qx, qy) in zip(rings[0], rings[0][1:]):
            L = math.hypot(qx - px, qy - py)
            if L < 3 or abs((qx - px) / L * ux + (qy - py) / L * uy) < 0.94:  # ei samansuuntainen (20°)
                continue
            d = seg_seg_dist(ax, ay, ax, ay, px, py, qx, qy)
            if best is None or d < best[0]:
                best = (d, px, py, qx, qy)
        if best is None:
            return out
        _, px, py, qx, qy = best
        if not point_in_polygon((px + qx) / 2 + nx * 0.5, (py + qy) / 2 + ny * 0.5, rings):
            nx, ny = -nx, -ny  # normaali alueen sisään
        t = (ax - px) * ux + (ay - py) * uy
        ox, oy = px + ux * t + nx * 2.45, py + uy * t + ny * 2.45
        edges = [(e1, e2) for ring in rings for e1, e2 in zip(ring, ring[1:])]
        rows = range(0, int(SLOT_REACH / ROW_PITCH) + 1)
    else:
        ox, oy = ax, ay
        rows = range(-int(SLOT_REACH / ROW_PITCH), int(SLOT_REACH / ROW_PITCH) + 1)
    imax = int(SLOT_REACH / SLOT_PITCH)
    for j in rows:
        for i in range(-imax, imax + 1):
            cx, cy = ox + (ux * i * SLOT_PITCH + nx * j * ROW_PITCH), oy + (uy * i * SLOT_PITCH + ny * j * ROW_PITCH)
            if math.hypot(cx - ax, cy - ay) > SLOT_REACH:
                continue
            dv = (cx - ax) * nx + (cy - ay) * ny
            hx, hy = (-nx, -ny) if rings is not None or dv > 0 else (nx, ny)  # keula reunaa tai latauspaikkaa kohti
            px, py, qx, qy = slot_axis(cx, cy, hx, hy)
            if rings is not None:
                if not all(point_in_polygon(x, y, rings) for x, y in ((cx, cy), (px, py), (qx, qy))):
                    continue
                if any(seg_seg_dist(px, py, qx, qy, e1[0], e1[1], e2[0], e2[1]) < CAR_R - 0.4 for e1, e2 in edges):
                    continue
            if not obst.free((cx, cy, hx, hy), cars=False):
                continue
            # Alueella etäisyys mitataan latauspaikasta reunan viereiseen riviin, jotta lähellä oleva
            # pysäköintialue voittaa latauspaikan ympäristön; samaa riviä suositaan.
            if rings is not None:
                score = math.hypot(ox - ax, oy - ay) + abs(i) * SLOT_PITCH + 2.2 * j * ROW_PITCH
            else:
                score = abs((cx - ax) * ux + (cy - ay) * uy) + 2.2 * abs(dv)
            out.append((score + penalty, (cx, cy, hx, hy), kind))
    return out


def pool_candidates(anchor, env, obst, own=None, area=None):
    """Latauspaikan ehdokasruudut paremmuusjärjestyksessä: latauspisteen oma sijainti,
    ruudut latausaseman alueella (area, jos asema on kartoitettu alueena), OpenStreetMapin
    pysäköintiruudut, ruudut pysäköintialueilla ja varalla rivit latauspaikan kohdalla lähimmän
    tien suuntaisesti."""
    ax, ay = anchor
    cands = [(-100, own, "oma")] if own else []
    for u in ring_dirs(area[0], anchor) if area else ():
        cands += grid_slots(anchor, area, u, obst, -40, "asema")
    for cx, cy, hx, hy, charging in env["stalls"]:
        d = math.hypot(cx - ax, cy - ay)
        if d > SLOT_REACH:
            continue
        if hx * (ax - cx) + hy * (ay - cy) < 0:  # keula latauspaikan puolelle
            hx, hy = -hx, -hy
        if obst.free((cx, cy, hx, hy), cars=False):
            cands.append((d - 4 - (15 if charging else 0), (cx, cy, hx, hy), "ruutu"))
    for rings in env["parking"]:
        xs, ys = [p[0] for p in rings[0]], [p[1] for p in rings[0]]
        if min(xs) - SLOT_REACH > ax or max(xs) + SLOT_REACH < ax or min(ys) - SLOT_REACH > ay or max(ys) + SLOT_REACH < ay:
            continue
        for u in ring_dirs(rings[0], anchor):
            cands += grid_slots(anchor, rings, u, obst, 0, "alue")
    road = min(((seg_seg_dist(ax, ay, ax, ay, *r[:4]), r) for r in env["roads"]
                if abs(r[0] - ax) < 80 and abs(r[1] - ay) < 80 and math.hypot(r[2] - r[0], r[3] - r[1]) > 1),
               default=None, key=lambda t: t[0])
    if road and road[0] < 60:
        x1, y1, x2, y2 = road[1][:4]
        L = math.hypot(x2 - x1, y2 - y1)
        u = ((x2 - x1) / L, (y2 - y1) / L)
    else:
        u = (1.0, 0.0)
    cands += grid_slots(anchor, None, u, obst, 35, "vara")
    cands.sort(key=lambda c: c[0])
    return cands


def charging_osm(points):
    """Tiet, pysäköintialueet ja -ruudut sekä pysäköintilaitosten sisäänkäynnit latauspaikkojen
    ympäriltä (OpenStreetMap)."""
    r = CHARGE_OSM_REACH
    query = "[out:json][timeout:300];(" + "".join(
        f'way(around:{r},{lat:.6f},{lon:.6f})[~"^(highway|amenity)$"~"."];'
        f'relation(around:{r},{lat:.6f},{lon:.6f})["amenity"="parking"];'
        f'node(around:{r},{lat:.6f},{lon:.6f})["amenity"="parking_entrance"];'
        for lon, lat in sorted(set(points))) + ");out tags geom;"
    # Välimuistin nimessä on kyselyn tiiviste, jotta muuttuneet latauspaikat haetaan uudelleen.
    dest = os.path.join(CACHE, f"lataus_osm_{hashlib.md5(query.encode()).hexdigest()[:10]}.json")
    with open(overpass_post(query, dest), encoding="utf-8") as fh:
        elements = json.load(fh)["elements"]
    obst = SlotObstacles()
    env = {"roads": [], "parking": [], "stalls": [], "entrances": []}
    covered = ("underground", "multi-storey", "rooftop")  # pysäköintilaitokset: autot viereen
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node":
            env["entrances"].append(local_xy(el["lon"], el["lat"]))
        elif el["type"] == "relation":
            if tags.get("parking") not in covered:
                outer = [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in el.get("members", [])
                         if m["type"] == "way" and m.get("role") == "outer" and m.get("geometry")]
                env["parking"] += [[[local_xy(*p) for p in ring]] for ring in join_rings(outer)]
        elif len(el.get("geometry", [])) >= 2:
            pts = [local_xy(p["lon"], p["lat"]) for p in el["geometry"]]
            closed = len(pts) >= 4 and pts[0] == pts[-1]
            if "highway" in tags:
                half = road_half(tags)
                if half is None:
                    continue
                for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                    env["roads"].append((ax, ay, bx, by, half))
                    obst.add_seg(ax, ay, bx, by, half + CAR_R + 0.3)
            elif tags.get("amenity") == "parking" and closed and tags.get("parking") not in covered:
                env["parking"].append([pts])
            elif tags.get("amenity") == "parking_space" and closed:
                # Ruudun pitkä sivu on auton suunta.
                (x1, y1), (x2, y2) = max(zip(pts, pts[1:]), key=lambda e: math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]))
                L = math.hypot(x2 - x1, y2 - y1)
                if L >= 3:
                    charging = tags.get("parking_space") == "charging" or any(k.startswith(("socket", "capacity:charging")) for k in tags)
                    env["stalls"].append((sum(p[0] for p in pts[:-1]) / (len(pts) - 1), sum(p[1] for p in pts[:-1]) / (len(pts) - 1),
                                          (x2 - x1) / L, (y2 - y1) / L, charging))
    log(f"  OSM: {len(env['roads'])} tienpätkää, {len(env['parking'])} pysäköintialuetta, "
        f"{len(env['stalls'])} pysäköintiruutua, {len(env['entrances'])} sisäänkäyntiä")
    return env, obst


def charge_brands(*texts):
    t = " ".join(x.lower() for x in texts if x)
    return {b for key, b in CHARGE_BRANDS if key in t}


def charge_words(*texts):
    return {w for x in texts if x for w in re.findall(r"[0-9a-zåäö]+", x.lower()) if len(w) >= 4 and w not in CHARGE_STOP}


def charging_stations():
    """OpenStreetMapin latausasemat Espoon alueelta: sijainti, alue (jos asema on kartoitettu
    alueena) ja tägit."""
    lon0, lat0, lon1, lat1 = ESPOO_LONLAT
    box = f"{lat0},{lon0},{lat1},{lon1}"
    query = f'[out:json][timeout:180];(node["amenity"="charging_station"]({box});way["amenity"="charging_station"]({box}););out tags geom;'
    with open(overpass_post(query, os.path.join(CACHE, "latausasemat_osm.json")), encoding="utf-8") as fh:
        elements = json.load(fh)["elements"]
    stations = []
    for el in elements:
        if el["type"] == "node":
            stations.append({"lon": el["lon"], "lat": el["lat"], "ring": None, "tags": el.get("tags", {})})
        elif el.get("geometry"):
            pts = [(q["lon"], q["lat"]) for q in el["geometry"]]
            closed = len(pts) >= 4 and pts[0] == pts[-1]
            body = pts[:-1] if closed else pts
            stations.append({"lon": sum(q[0] for q in body) / len(body), "lat": sum(q[1] for q in body) / len(body),
                             "ring": pts if closed else None, "tags": el.get("tags", {})})
    return stations


def match_stations(locs, stations):
    """Latauspaikkojen vastineet OpenStreetMapin latausasemista. Operaattorin ilmoittama sijainti on
    joskus kaupan tai osoitteen kohdalla, jopa satojen metrien päässä latauspisteistä (esim.
    K-Market Maarinsolmu 125 m), kun taas OpenStreetMapissa asema on kartoitettu pisteiden kohdalle.

    Asema vastaa latauspaikkaa, kun se on enintään 300 metrin päässä ja ainakin kaksi seuraavista
    täsmää: nimi (latauspaikan nimen erottavat sanat), merkki tai operaattori, latauspisteiden
    määrä. Yksi peruste riittää 100 metriin asti. Virta on monen merkin taustajärjestelmä, joten se
    on vain puolikas peruste ja yksinään riittää 60 metriin. Eri merkki (esim. St1 ja Lidl) hylkää
    aseman, ja likimääräiseksi merkittyjä asemia ei käytetä. Kukin asema vastaa vain yhtä
    latauspaikkaa, ellei nimi täsmää kaikille. Palauttaa {latauspaikan indeksi: (aseman indeksi, etäisyys m)}."""
    pairs = []
    for i, f in enumerate(locs):
        p = f["properties"]
        name, op = p.get("name") or "", ((p.get("operator") or {}).get("details") or {}).get("name") or ""
        a_brands, a_words = charge_brands(name, op), charge_words(name or (p.get("address") or {}).get("street"))
        lx, ly = local_xy(*f["geometry"]["coordinates"][:2])
        for j, s in enumerate(stations):
            t = s["tags"]
            sx, sy = local_xy(s["lon"], s["lat"])
            d = math.hypot(sx - lx, sy - ly)
            if d > STATION_REACH or t.get("accuracy") == "approximate":
                continue
            own = charge_brands(t.get("name"), t.get("operator"), t.get("brand")) - {"virta"}
            o_brands = charge_brands(t.get("name"), t.get("operator"), t.get("brand"), t.get("network"))
            a_own = a_brands - {"virta"}
            # Eri merkki; Virran kautta ilmoitettu paikka ei ole toisen merkin asema, ellei asema ole Virran verkossa.
            if own and (not own & a_own if a_own else "virta" in a_brands and "virta" not in o_brands):
                continue
            name_hit = bool(a_words) and len(a_words & charge_words(t.get("name"), t.get("addr:street"))) >= 0.75 * len(a_words)
            brand_hit = bool((a_brands - {"virta"}) & o_brands)
            virta_hit = "virta" in a_brands & o_brands
            cap = t.get("capacity", "")
            cap_hit = cap.isdigit() and abs(int(cap) - len(p["evses"])) <= max(1, 0.3 * len(p["evses"]))
            strength = name_hit + brand_hit + cap_hit + (0.5 if virta_hit and not brand_hit else 0)
            limit = STATION_REACH if strength >= 2 else 100 if name_hit or brand_hit else 60 if virta_hit else 0
            if d <= limit:
                pairs.append((-strength, d, i, j, name_hit))
    match, named = {}, {}
    for _, d, i, j, name_hit in sorted(pairs):
        if i in match or (j in named and not (named[j] and name_hit)):
            continue
        match[i] = (j, d)
        named[j] = named.get(j, True) and name_hit
    return match


def charging_buildings(obst, points):
    """Rakennusten pohjat latauspaikkojen ympäriltä (samat kuin kartan 3D-rakennukset)."""
    near = set()
    for lon, lat in points:
        x, y = local_xy(lon, lat)
        near.update((gx, gy) for gx in range(int((x - 200) // 100), int((x + 200) // 100) + 1)
                    for gy in range(int((y - 200) // 100), int((y + 200) // 100) + 1))
    n = 0
    with open(os.path.join(OUT, "rakennukset.geojson"), encoding="utf-8") as fh:
        for f in json.load(fh)["features"]:
            for poly in geom_polygons(f["geometry"]):
                x, y = local_xy(*poly[0][0])
                if (int(x // 100), int(y // 100)) in near:
                    obst.add_building([[local_xy(*p) for p in ring] for ring in poly])
                    n += 1
    log(f"  rakennuksia latauspaikkojen ympärillä: {n}")


def build_charging():
    """Sähköautojen latauspaikat ja pysäköintiruudut latauksessa oleville autoille.

    Latauspaikat ja latauspisteet tulevat Fintrafficin AFIR-aineistosta (Digitraffic); selain
    hakee pisteiden tilan minuutin välein. Latauspaikan sijainniksi otetaan vastaava
    OpenStreetMapin latausasema, jos sellainen löytyy (match_stations). Jokaiselle latauspaikalle
    lasketaan rinnakkaiset pysäköintiruudut, jotka eivät ole tiellä eivätkä rakennuksen sisällä:
    ensisijaisesti latausaseman alueelle, OpenStreetMapin pysäköintiruutuihin tai -alueille,
    muuten latauspaikan kohdalle tien viereen.
    Pysäköintilaitoksen latauspaikan autot sijoitetaan sisäänkäynnin luo. Latauspisteet, joilla on
    oma, muista erillinen sijainti, saavat ruutunsa sen ympäriltä (pooli). Ruudut jaetaan
    paikkojen kesken vuorotellen, jotta vierekkäisillä paikoilla kummallakin on lähimmät ruutunsa.

    Tiedosto: paikat [{nimi, osoite, operaattori, ruudut: [[[lon, lat, suunta°], ...] pooleittain],
    pisteet: [[tunnus, kW, liitin, numero, pooli], ...]}]."""
    log("lataus (Fintraffic AFIR, OpenStreetMap)")
    raw = http_get(f"{AFIR_API}/locations/all", {}, os.path.join(CACHE, "afir_paikat.json"))
    with open(os.path.join(PUBLIC_DATA, "espoo_raja.geojson"), encoding="utf-8") as fh:
        region = [p for f in json.load(fh)["features"] for p in geom_polygons(f["geometry"])]
    with open(raw, encoding="utf-8") as fh:
        locs = [f for f in json.load(fh)["features"]
                if any(point_in_polygon(*f["geometry"]["coordinates"][:2], poly) for poly in region)]
    log(f"  {len(locs)} latauspaikkaa, {sum(len(f['properties']['evses']) for f in locs)} latauspistettä")
    stations = charging_stations()
    # Alle 10 metrin ero ei muuta sijoittelua, joten silloin pidetään operaattorin sijainti.
    match = {i: stations[j] for i, (j, d) in match_stations(locs, stations).items() if d > 10}
    moved = sorted(math.hypot(*(a - b for a, b in zip(local_xy(s["lon"], s["lat"]), local_xy(*locs[i]["geometry"]["coordinates"][:2]))))
                   for i, s in match.items())
    log(f"  OpenStreetMapin latausasemista korjattu {len(moved)} sijaintia (yli 50 m: {sum(d > 50 for d in moved)}, "
        f"suurin {max(moved, default=0):.0f} m)")
    # Ympäristö haetaan latauspaikkojen ympäriltä (CHARGE_OSM_REACH). Se kattaa korjatun sijainnin
    # ruudut, jos siirto on alle 150 m; kauemmas siirtyneen aseman ympäristö haetaan lisäksi.
    points = [tuple(f["geometry"]["coordinates"][:2]) for f in locs]
    points += [(s["lon"], s["lat"]) for i, s in match.items()
               if math.hypot(*(a - b for a, b in zip(local_xy(s["lon"], s["lat"]), local_xy(*points[i])))) > CHARGE_OSM_REACH - SLOT_REACH - 10]
    env, obst = charging_osm(points)
    charging_buildings(obst, points)

    pools, sites = [], []
    for i, f in enumerate(locs):
        p = f["properties"]
        lx, ly = local_xy(*f["geometry"]["coordinates"][:2])
        station, area = match.get(i), None
        if station:
            lx, ly = local_xy(station["lon"], station["lat"])
            area = [[local_xy(*q) for q in station["ring"]]] if station["ring"] else None
        anchor = (lx, ly)
        if obst.in_building(lx, ly) or p.get("parkingType") == "PARKING_GARAGE":
            ent = min(env["entrances"], key=lambda q: math.hypot(q[0] - lx, q[1] - ly), default=None)
            if ent and math.hypot(ent[0] - lx, ent[1] - ly) < 100:
                anchor = ent
        groups = {}
        for e in sorted(p["evses"], key=lambda e: (e.get("physicalReference") or "", e["id"])):
            g, key = e.get("geometry"), None
            # Korjatun latauspaikan pisteiden omat sijainnit ovat yleensä samaa virheellistä paikkaa.
            if not station and isinstance(g, dict) and g.get("coordinates"):
                qx, qy = local_xy(*g["coordinates"][:2])
                if math.hypot(qx - lx, qy - ly) > 3:
                    key = (round(qx * 2) / 2, round(qy * 2) / 2)
            groups.setdefault(key, []).append(e)
        site = []
        for key, evses in groups.items():
            pool = {"anchor": anchor if key is None else key, "need": min(len(evses), SLOT_MAX), "evses": evses, "slots": []}
            own = None
            if key is not None:
                hx, hy = 0.0, 1.0
                stall = min(env["stalls"], key=lambda s: math.hypot(s[0] - key[0], s[1] - key[1]), default=None)
                if stall and math.hypot(stall[0] - key[0], stall[1] - key[1]) < 3:
                    hx, hy = stall[2], stall[3]
                if obst.free((key[0], key[1], hx, hy), cars=False):
                    own = (key[0], key[1], hx, hy)
            pool["cands"], pool["next"] = pool_candidates(pool["anchor"], env, obst, own, area if key is None else None), 0
            site.append(pool)
            pools.append(pool)
        sites.append((f, site))

    for _ in range(SLOT_MAX):
        active = [q for q in sorted(pools, key=lambda q: q["need"]) if len(q["slots"]) < q["need"]]
        if not active:
            break
        for q in active:
            while q["next"] < len(q["cands"]):
                _, car, _ = q["cands"][q["next"]]
                q["next"] += 1
                if obst.free(car):
                    obst.take(car)
                    q["slots"].append(car)
                    break

    paikat = []
    for f, site in sites:
        p = f["properties"]
        addr = p.get("address") or {}
        street = ", ".join(s for s in (addr.get("street"), addr.get("city")) if s)
        pisteet = []
        for k, pool in enumerate(site):
            for e in pool["evses"]:
                kw = max((c.get("maxElectricPower") or 0 for c in e["connectors"]), default=0) / 1000
                plugs = " / ".join(dict.fromkeys(PLUGS.get(c.get("standard"), c.get("standard") or "?") for c in e["connectors"]))
                ref = e.get("physicalReference") or e["id"].split("*")[-1]
                pisteet.append([e["id"], round(kw) if kw else None, plugs, ref, k])
        paikat.append({
            "nimi": p.get("name") or addr.get("street") or "Latauspaikka", "osoite": street,
            "operaattori": ((p.get("operator") or {}).get("details") or {}).get("name"),
            "ruudut": [[[*local_lonlat(cx, cy), round(math.degrees(math.atan2(hx, hy))) % 360]
                        for cx, cy, hx, hy in pool["slots"]] for pool in site],
            "pisteet": pisteet,
        })
    short = sum(1 for q in pools if len(q["slots"]) < q["need"])
    path = os.path.join(PUBLIC_DATA, "lataus.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"lahde": "Fintraffic / digitraffic.fi (AFIR), pysäköintialueet © OpenStreetMap-tekijät (ODbL)",
                   "paikat": paikat}, fh, ensure_ascii=False, separators=(",", ":"))
    log(f"  → lataus.json: {len(paikat)} latauspaikkaa, {sum(len(q['slots']) for q in pools)} ruutua"
        f"{f', {short} poolista puuttuu ruutuja' if short else ''}, {os.path.getsize(path) / 1e3:.0f} kt")


def make_overlay_tiles():
    """Kaikki muut aineistot yhdeksi monitasoiseksi vektoritiilistöksi."""
    exe = shutil.which("tippecanoe")
    if not exe:
        log("tippecanoe puuttuu – aineistot luetaan suoraan GeoJSONeista")
        return
    layers = [d[0] for d in ESPOO_DATASETS] + ["vaesto"]
    args = []
    for name in layers:
        if os.path.exists(os.path.join(OUT, name + ".geojson")):
            args += ["-L", f"{name}:data/{name}.geojson"]
    shutil.rmtree(os.path.join(TILES, "kohteet"), ignore_errors=True)
    run_tippecanoe(
        [exe, "--output-to-directory", "public/tiles/kohteet", "--force", "-Z", "8", "-z", "15",
         "--no-feature-limit", "--no-tile-size-limit", "--detect-shared-borders", "--quiet", *args]
    )
    log("→ tiles/kohteet (z8–15)")


def run_tippecanoe(cmd):
    # tippecanoe ei luo tulostekansion yläkansioita eikä käsittele välilyöntejä sisältäviä
    # polkuja oikein, joten se ajetaan projektikansiossa suhteellisilla poluilla.
    os.makedirs(TILES, exist_ok=True)
    subprocess.run(cmd, check=True, cwd=ROOT)


def main():
    for folder in (CACHE, OUT, PUBLIC_DATA):
        os.makedirs(folder, exist_ok=True)
    only = set(sys.argv[1:])
    want = lambda k: not only or k in only
    manifest = []
    for ds_id, type_name, title in ESPOO_DATASETS:
        if want(ds_id):
            build_simple(ds_id, type_name)
    if want("vaesto"):
        build_population()
    if want("raja"):
        build_boundary()
    if want("sillat"):
        build_bridges()
    if want("raiteet"):
        build_rails()
    if want("purot"):
        build_streams()
    if want("rakennukset"):
        build_buildings()
    if want("rakennukset") or want("katot"):
        build_roofs()  # lisää rakennuksiin räystään korkeuden ja tekee rakennustiilet uudelleen
    if want("kaupunginosat"):
        build_district_labels()  # rakennusten jälkeen: nimi sijoitetaan rakennusten keskelle
    if want("lataus"):
        build_charging()  # rakennusten jälkeen: autot eivät saa osua rakennuksiin
    if want("tiilet"):
        make_overlay_tiles()
    for ds_id, type_name, title in ESPOO_DATASETS + [("vaesto", "HSY", "Väestö"), ("rakennukset", BUILDING_TYPE, "Rakennukset")]:
        path = os.path.join(OUT, ds_id + ".geojson")
        if os.path.exists(path):
            manifest.append({"id": ds_id, "lahde": type_name, "nimi": title, "koko": os.path.getsize(path)})
    # Versio lisätään tiiliosoitteisiin, jotta selain ei käytä vanhoja tiiliä välimuistista.
    with open(os.path.join(PUBLIC_DATA, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"versio": int(time.time()), "aineistot": manifest}, fh, ensure_ascii=False, indent=1)
    log("valmis")


if __name__ == "__main__":
    main()
