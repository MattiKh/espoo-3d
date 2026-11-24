// Sillat. Maaston korkeusmallista (Maanmittauslaitos 2 m) sillat on poistettu, joten ilmakuvan
// tie notkahtaa sillan kohdalla alla olevan tien tai joen tasolle. Espoon kantakartan siltojen
// reunaviivoissa on kannen mitattu korkeus (N2000), ja niistä on muodostettu kansialueet
// (scripts/build_data.py). Siltaviivoista puuttuu usein toinen reuna, joten siltojen lähellä
// kansia täydentävät ajoväylien reunaviivojen väliset kaistaleet ja raiteilla raiteen kaistaleet.
//
// Kansista ja kaistaleista tehdään yksi pinta: korkeusmallin kussakin pikselissä pinta on alin
// niistä, jotka ovat maanpinnan yläpuolella (päällekkäiset kansit ja kaistaleet ovat samaa
// ajorataa; alempi on ajoradan pinta, ylempi esim. siltaviivan reunapalkki). Matalat kohdat
// (enintään PIT_MAX, esim. sillan päät, joista on poistettu penkereen pää, ja alikulut) täytetään
// korkeusmalliin. Korkeat jänteet, joiden alta kulkee tie tai raide, ovat lähikuvassa 3D-laattoja
// (decks.js), jolloin alla oleva tie näkyy; kaukana nekin nostetaan korkeusmalliin. Ajoneuvot
// ohjataan pinnalle tai sen alle (transit.js).

const LON0 = 24.7, LAT0 = 60.2, KX = 55462, KY = 111415; // paikalliset metrit, kuten transit.js
const EDGE_CELL = 50; // m
const EDGE_REACH = 22; // m: leveälläkin sillalla keskikaista on näin lähellä reunaviivaa
const PATCH_MINZOOM = 13; // karkeammissa tiilissä kansi on vain muutama pikseli
const SLAB_MINZOOM = 15; // tässä ja tarkemmissa tiilissä korkeat jänteet ovat 3D-laattoja
const RAW_TILE_LIMIT = 400, SPAN_TILE_LIMIT = 300;
// Kaistaleita on myös tasaisella maalla tien kohdalla, joten ne ovat maanpinnan yläpuolella vasta,
// jos maasto on selvästi alempana (m). Siltaviivojen kansilla riittää pieni ero.
const STRIP_MIN = 0.5, DECK_MIN = 0.05;
const PIT_MAX = 4.5; // m: tätä matalammat kohdat täytetään, korkeammat ovat jänteitä
// Raiteen kaistale on raiteen kohdalla (RAIL_CORE keskilinjasta) mitatulla korkeudella; sen ulkopuolella
// maasto laskee penkereen luiskana (RAIL_SLOPE m/m) maanpintaan. Luiska täyttää vain kuoppia, eikä se
// peitä muita kansia (korkeusmalli voi olla ajalta ennen raidetta, jolloin raide on maata ylempänä).
const RAIL_CORE = 1.6, RAIL_SLOPE = 0.3, SLOPE_MIN = 0.1;
const LEVEL_GAP = 3; // m: näin paljon ylempänä oleva pinta on eri taso (silta toisen yllä)
const QUAD_LEN = 4; // m: kannen reunat jaetaan tasavälein (lähimmän osan haku)
const PIECE_QUADS = 40; // pitkät kaistaleet (raiteet) paloiksi, jotta tiiliin osuu vain lähellä oleva osa
const EARTH_CIRC = 40075016.686;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

let edgeGrid = null;
let decks = [];

const ready = fetch("data/sillat.json").then((r) => r.json())
  .then(({ viivat, kannet, kaistat = [], raiteet = [] }) => {
    edgeGrid = buildEdgeGrid(viivat);
    // Raiteet ovat kapeita kaistaleita raiteen keskilinjalta (ei reunaviivoja), joten niitä ei siistitä.
    const strips = (list, extra) => list.map((k) => buildDeck(k)).flatMap(pieces).map((d) => ({ ...d, min: STRIP_MIN, ...extra }));
    decks = [...kannet.map(buildDeck).flatMap(pieces), ...strips(kaistat, { strip: true }), ...strips(raiteet, { rail: true })];
  })
  .catch((err) => console.warn("Siltoja ei saatu ladattua", err));

function buildEdgeGrid(viivat) {
  const grid = new Map();
  for (const line of viivat) {
    for (let i = 3; i < line.length; i += 3) {
      const ax = (line[i - 3] - LON0) * KX, ay = (line[i - 2] - LAT0) * KY;
      const bx = (line[i] - LON0) * KX, by = (line[i + 1] - LAT0) * KY;
      const seg = [ax, ay, line[i - 1], bx, by, line[i + 2]];
      const cx0 = Math.floor((Math.min(ax, bx) - EDGE_REACH) / EDGE_CELL), cx1 = Math.floor((Math.max(ax, bx) + EDGE_REACH) / EDGE_CELL);
      const cy0 = Math.floor((Math.min(ay, by) - EDGE_REACH) / EDGE_CELL), cy1 = Math.floor((Math.max(ay, by) + EDGE_REACH) / EDGE_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(seg);
        }
      }
    }
  }
  return grid;
}

// Reunaviiva [x, y, z, ...] tasavälein N pisteeseen (osuudet pituuden suhteessa), jotta reunat A
// ja B voidaan jakaa vastakkaisiksi osiksi.
function resample(P, N) {
  const n = P.length / 3, s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(P[3 * i] - P[3 * i - 3], P[3 * i + 1] - P[3 * i - 2]));
  const total = s[n - 1], out = [];
  for (let k = 0, i = 0; k < N; k++) {
    const t = total ? (total * k) / (N - 1) : 0;
    while (i < n - 2 && s[i + 1] < t) i++;
    const f = s[i + 1] > s[i] ? Math.min(1, Math.max(0, (t - s[i]) / (s[i + 1] - s[i]))) : 0;
    for (let c = 0; c < 3; c++) out.push(P[3 * i + c] + (P[3 * i + 3 + c] - P[3 * i + c]) * f);
  }
  return out;
}

// Kansi Web Mercator -yksiköissä: reunat A ja B samaan määrään pisteitä jaettuina sekä niiden
// rajaama monikulmio. min: kuinka paljon maaston on oltava kantta alempana, jotta kansi on sen yläpuolella.
function buildDeck([a, b]) {
  const toM = (line) => {
    const out = [];
    for (let i = 0; i < line.length; i += 3) out.push(mercX(line[i]), mercY(line[i + 1]), line[i + 2]);
    return out;
  };
  const a0 = toM(a), b0 = toM(b), mPerUnit = EARTH_CIRC * Math.cos((a[1] * Math.PI) / 180);
  const len = (P) => { let l = 0; for (let i = 3; i < P.length; i += 3) l += Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2]); return l; };
  const N = Math.max(2, Math.ceil((Math.max(len(a0), len(b0)) * mPerUnit) / QUAD_LEN) + 1);
  return deckOf(resample(a0, N), resample(b0, N));
}

function deckOf(A, B) {
  const ring = [];
  for (let i = 0; i < A.length; i += 3) ring.push(A[i], A[i + 1]);
  for (let i = B.length - 3; i >= 0; i -= 3) ring.push(B[i], B[i + 1]);
  const xs = ring.filter((_, i) => i % 2 === 0), ys = ring.filter((_, i) => i % 2 === 1);
  return {
    A, B, ring, min: DECK_MIN, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// Vaakasuoran y-suoran ja monikulmion reunan leikkauskohdat järjestyksessä: sisällä parien välissä.
function crossings(y, ring) {
  const xs = [];
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
  }
  return xs.sort((a, b) => a - b);
}

// Pitkä kansi paloiksi (PIECE_QUADS osaa, palat jatkuvat toisistaan).
function pieces(d) {
  const N = d.A.length / 3;
  if (N <= PIECE_QUADS + 1) return [d];
  const out = [];
  for (let s = 0; s < N - 1; s += PIECE_QUADS) {
    const e = Math.min(N - 1, s + PIECE_QUADS);
    out.push(deckOf(d.A.slice(3 * s, 3 * e + 3), d.B.slice(3 * s, 3 * e + 3)));
  }
  return out;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Etäisyys reunaviivaan, reunan korkeus lähimmässä kohdassa ja sen osan indeksi. near: haetaan vain
// tämän osan ympäriltä (viereisillä pikseleillä lähin osa vaihtuu vähän).
const NEAR_SEGS = 3;
function nearestOnEdge(P, x, y, near = -1) {
  let best = Infinity, z = P[2], seg = 0;
  const from = near < 0 ? 3 : Math.max(3, 3 * (near - NEAR_SEGS + 1));
  const to = near < 0 ? P.length : Math.min(P.length, 3 * (near + NEAR_SEGS + 2));
  for (let i = from; i < to; i += 3) {
    const ax = P[i - 3], ay = P[i - 2], dx = P[i] - ax, dy = P[i + 1] - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) { best = d; z = P[i - 1] + (P[i + 2] - P[i - 1]) * t; seg = i / 3 - 1; }
  }
  return [best, z, seg];
}

// Kannen korkeus kansialueen pisteessä (reunojen korkeuksien välissä etäisyyksien suhteessa), pisteen
// osa ja etäisyyksien erotus (Web Mercator; keskilinjalla 0). near: viereisen pisteen osa, jonka ympäriltä haetaan.
function deckAt(d, x, y, near = -1) {
  const [da, za, seg] = nearestOnEdge(d.A, x, y, near), [db, zb] = nearestOnEdge(d.B, x, y, near < 0 ? -1 : seg);
  return [da + db > 0 ? (za * db + zb * da) / (da + db) : za, seg, Math.abs(da - db)];
}

// Jänteiden muutokset (uusi tarkka korkeusmallin tiili) ilmoitetaan kuuntelijoille koottuina.
const listeners = [];
let notifyTimer = null;
export function onDeckChange(fn) { listeners.push(fn); }
function changed() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; for (const fn of listeners) fn(); }, 300);
}

// Täytetyistä pikseleistä muistetaan alkuperäinen maanpinnan korkeus, jotta sillan ali
// kulkeva ajoneuvo tai uoma voidaan pitää alla olevalla pinnalla.
const rawTiles = new Map();
// Tarkkojen tiilten jänteet 3D-laattoja varten: avain z/x/y → { z, x, y, W, H, cells, upper, version },
// cells ja upper: pikseli → pinnan korkeus (alin taso ja sen yllä oleva toinen taso).
const spanTiles = new Map();
let spanVersion = 0;
export const getSpanTiles = () => spanTiles;

// Korkeusmallin tiili (Terrarium-koodaus). Kansialueilta haetaan pikselin pinta; matalat kohdat
// täytetään, ja tarkoissa tiilissä korkeat jänteet jätetään 3D-laatoille. Tiili palautetaan
// sellaisenaan, jos siinä ei ole siltaa tai mitään ei täytetty.
export async function patchDemTile(buffer, z, x, y) {
  if (z < PATCH_MINZOOM) return buffer;
  await ready;
  const n = 2 ** z, tx0 = x / n, ty0 = y / n, size = 1 / n;
  const hits = decks.filter((d) => d.maxX > tx0 && d.minX < tx0 + size && d.maxY > ty0 && d.minY < ty0 + size);
  if (!hits.length) return buffer;
  const bmp = await createImageBitmap(new Blob([buffer]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, W, H), px = img.data;
  const elevAt = (k) => px[4 * k] * 256 + px[4 * k + 1] + px[4 * k + 2] / 256 - 32768;
  // Pikselin pinta (alin maanpinnan yläpuolella oleva), sen yllä oleva toinen taso ja tuliko pinta
  // kaistaleesta. touched: pikselit, joilla on pinta.
  const surf = new Float32Array(W * H).fill(NaN), upper = new Float32Array(W * H).fill(NaN);
  const slope = new Float32Array(W * H).fill(NaN); // raiteen penkereen luiska (vain kuoppiin)
  const fromStrip = new Uint8Array(W * H), seen = new Uint8Array(W * H), touched = [];
  const touch = (k) => { if (!seen[k]) { seen[k] = 1; touched.push(k); } };
  const mPerUnit = EARTH_CIRC * Math.cos(Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty0 + size / 2))))); // m Web Mercator -yksikköä kohden
  for (const d of hits) {
    const i0 = Math.max(0, Math.floor(((d.minX - tx0) / size) * W)), i1 = Math.min(W - 1, Math.floor(((d.maxX - tx0) / size) * W));
    const j0 = Math.max(0, Math.floor(((d.minY - ty0) / size) * H)), j1 = Math.min(H - 1, Math.floor(((d.maxY - ty0) / size) * H));
    for (let j = j0; j <= j1; j++) {
      const Y = ty0 + ((j + 0.5) / H) * size;
      const xs = crossings(Y, d.ring);
      for (let c = 0; c + 1 < xs.length; c += 2) {
        let near = -1; // jakson ensimmäiselle pikselille haetaan koko reunalta
        const ia = Math.max(i0, Math.ceil(((xs[c] - tx0) / size) * W - 0.5));
        const ib = Math.min(i1, Math.floor(((xs[c + 1] - tx0) / size) * W - 0.5));
        for (let i = ia; i <= ib; i++) {
          const X = tx0 + ((i + 0.5) / W) * size, k = j * W + i;
          let [zd, q, diff] = deckAt(d, X, Y, near);
          near = q;
          if (d.rail) {
            const off = (diff * mPerUnit) / 2 - RAIL_CORE; // m raiteen ulkopuolella
            if (off > 0) {
              zd -= off * RAIL_SLOPE;
              if (zd > elevAt(k) + SLOPE_MIN && !(zd <= slope[k])) {
                touch(k);
                slope[k] = zd;
              }
              continue;
            }
          }
          if (zd <= elevAt(k) + d.min) continue; // ei maanpinnan yläpuolella (esim. penger)
          const cur = surf[k];
          touch(k);
          if (Number.isNaN(cur) || zd < cur) {
            if (zd < cur - LEVEL_GAP) upper[k] = Number.isNaN(upper[k]) ? cur : Math.min(upper[k], cur);
            surf[k] = zd;
            fromStrip[k] = d.strip ? 1 : 0;
          } else if (zd > cur + LEVEL_GAP) {
            upper[k] = Number.isNaN(upper[k]) ? zd : Math.min(upper[k], zd);
          }
        }
      }
    }
  }
  if (!touched.length) return buffer;
  // Luiska vain sinne, missä ei ole muuta pintaa, eikä siitä tule jännettä.
  for (const k of touched) {
    if (Number.isNaN(surf[k]) && !Number.isNaN(slope[k]) && slope[k] - elevAt(k) <= PIT_MAX) surf[k] = slope[k];
  }
  // Kaistaleiden pikselit siistitään avauksella (kuroutus ja laajennus 3 × 3 -ikkunassa): tukimuurin
  // tai luiskan reunalle osuvat 1–2 pikselin kaistat jäävät pois, mutta kansi säilyy. Tiilen
  // ulkopuoli lasketaan pinnaksi, jottei tiilten rajoille jää uria.
  const on = (i, j) => i < 0 || j < 0 || i >= W || j >= H || !Number.isNaN(surf[j * W + i]);
  const core = (i, j) => {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (!on(i + di, j + dj)) return false;
    return true;
  };
  const kept = (k) => {
    if (!fromStrip[k]) return true;
    const i = k % W, j = (k - i) / W;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < W && jj < H && !Number.isNaN(surf[jj * W + ii]) && core(ii, jj)) return true;
      }
    }
    return false;
  };
  const raw = new Map(), cells = new Map(), slabs = z >= SLAB_MINZOOM;
  for (const k of touched) {
    const zs = surf[k];
    if (Number.isNaN(zs) || !kept(k)) continue;
    const elev = elevAt(k);
    if (slabs && zs - elev > PIT_MAX) { // jänne: 3D-laatta, maasto ennallaan
      cells.set(k, zs);
      continue;
    }
    raw.set(k, elev);
    const o = 4 * k, v = zs + 32768;
    px[o] = Math.floor(v / 256);
    px[o + 1] = Math.floor(v) % 256;
    px[o + 2] = Math.floor((v - Math.floor(v)) * 256);
  }
  const key = `${z}/${x}/${y}`;
  if (slabs) {
    const up = new Map();
    for (const k of touched) if (!Number.isNaN(upper[k]) && (cells.has(k) || raw.has(k))) up.set(k, upper[k]);
    if (cells.size || up.size || spanTiles.has(key)) {
      spanTiles.delete(key);
      spanTiles.set(key, { z, x, y, W, H, cells, upper: up, version: ++spanVersion });
      if (spanTiles.size > SPAN_TILE_LIMIT) spanTiles.delete(spanTiles.keys().next().value);
      changed();
    }
  }
  if (!raw.size) return buffer;
  rawTiles.set(key, { raw, W, H });
  if (rawTiles.size > RAW_TILE_LIMIT) rawTiles.delete(rawTiles.keys().next().value);
  return bmp24(px, W, H);
}

// Pakkaamaton 24-bittinen BMP (Terrarium-arvot RGB-kanavissa). Selaimen PNG-pakkaus vie tiileltä
// jopa sekunnin, BMP:n koostaminen millisekunteja; MapLibre purkaa kummankin samalla tavalla.
function bmp24(px, W, H) {
  const row = Math.ceil((W * 3) / 4) * 4, size = 54 + row * H, buf = new ArrayBuffer(size), dv = new DataView(buf), out = new Uint8Array(buf);
  dv.setUint16(0, 0x4d42, true); // "BM"
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, W, true);
  dv.setInt32(22, -H, true); // ylhäältä alas
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, row * H, true);
  for (let j = 0; j < H; j++) {
    for (let i = 0, k = j * W * 4, o = 54 + j * row; i < W; i++, k += 4, o += 3) {
      out[o] = px[k + 2];
      out[o + 1] = px[k + 1];
      out[o + 2] = px[k];
    }
  }
  return buf;
}

// Pikseli tarkimmasta tiilestä, jossa on tietoa: [tiili, pikselin indeksi] tai null.
function tileAt(tiles, lon, lat) {
  const X = mercX(lon), Y = mercY(lat);
  for (let z = 15; z >= PATCH_MINZOOM; z--) {
    const n = 2 ** z, x = Math.floor(X * n), y = Math.floor(Y * n);
    const tile = tiles.get(`${z}/${x}/${y}`);
    if (tile) return [tile, Math.floor((Y * n - y) * tile.H) * tile.W + Math.floor((X * n - x) * tile.W)];
  }
  return null;
}

// Alkuperäinen maanpinnan korkeus (m) pisteessä, jos korkeusmalli on siinä täytetty tai nostettu
// kannen tasolle; muuten null.
export function rawElevationAt(lon, lat) {
  const hit = tileAt(rawTiles, lon, lat);
  return hit ? hit[0].raw.get(hit[1]) ?? null : null;
}

// 3D-laatan (jänteen) pinnan korkeus (N2000, m) pisteessä, tai null, jos pisteessä ei ole laattaa.
export function deckSurfaceAt(lon, lat) {
  const hit = tileAt(spanTiles, lon, lat);
  return hit ? hit[0].cells.get(hit[1]) ?? null : null;
}

// Lähimmän sillan reunan korkeus (N2000, m) pisteessä, tai null, jos siltaa ei ole lähellä.
export function deckHeightAt(lon, lat) {
  const x = (lon - LON0) * KX, y = (lat - LAT0) * KY;
  const segs = edgeGrid?.get(cellKey(Math.floor(x / EDGE_CELL), Math.floor(y / EDGE_CELL)));
  if (!segs) return null;
  let best = EDGE_REACH ** 2, z = null;
  for (const [ax, ay, az, bx, by, bz] of segs) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d2 = (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
    if (d2 < best) { best = d2; z = az + (bz - az) * t; }
  }
  return z;
}
