#!/usr/bin/env python3
"""Lataa Espoon ja HSY:n avoimet paikkatietoaineistot ja muuntaa ne GeoJSONiksi.

Käyttö:  python3 scripts/build_data.py [aineisto ...]

Raakavastaukset tallentuvat kansioon cache/, joten ajon voi keskeyttää ja
jatkaa. Valmiit GeoJSON-tiedostot menevät kansioon data/, ja niistä tehdään
vektoritiilet kansioon public/tiles/ (tippecanoe). Selain tarvitsee kansiosta
public/data/ vain tiedostot manifest.json, espoo_raja.geojson, kaupunginosat_nimet.geojson,
sillat.json ja raiteet.json.
"""
import collections
import concurrent.futures as cf
import json
import math
import os
import shutil
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
    if want("kaupunginosat"):
        build_district_labels()  # rakennusten jälkeen: nimi sijoitetaan rakennusten keskelle
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
