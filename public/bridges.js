// Sillat. Maaston korkeusmallista (Maanmittauslaitos 2 m) sillat on poistettu, joten ilmakuvan
// tie notkahtaa sillan kohdalla alla olevan tien tai joen tasolle. Espoon kantakartan siltojen
// reunaviivoissa on kannen mitattu korkeus (N2000), ja niistä on muodostettu kansialueet
// (scripts/build_data.py). Siltaviivoista puuttuu usein toinen reuna, joten siltojen lähellä
// kansia täydentävät ajoväylien reunaviivojen väliset kaistaleet.
//
// Lähikuvassa kannet piirretään 3D-laattoina (decks.js), jolloin sillan alla kulkeva tie näkyy.
// Tarkimpia korkeusmallin tiiliä ei siksi muuteta, vaan niistä katsotaan, missä kansi on
// maanpinnan yläpuolella. Karkeammissa tiilissä (kaukana) maasto nostetaan kannen tasolle kuten
// ennenkin. Ajoneuvot ohjataan kannelle tai sen alle (transit.js).

const LON0 = 24.7, LAT0 = 60.2, KX = 55462, KY = 111415; // paikalliset metrit, kuten transit.js
const EDGE_CELL = 50; // m
const EDGE_REACH = 22; // m: leveälläkin sillalla keskikaista on näin lähellä reunaviivaa
const PATCH_MINZOOM = 13; // karkeammissa tiilissä kansi on vain muutama pikseli
const PATCH_MAXZOOM = 14; // tarkemmissa tiilissä kannet ovat 3D-laattoja, eikä maastoa nosteta
const RAW_TILE_LIMIT = 400;
// Kaistaleita on myös tasaisella maalla tien kohdalla, joten ne nostavat maastoa vain, jos se on
// selvästi kaistaletta alempana (m). Siltaviivojen kansilla riittää pieni ero.
const STRIP_MIN = 0.5, DECK_MIN = 0.05;
// 3D-laatat: kansi jaetaan noin QUAD_LEN metrin osiin, ja osa piirretään, jos vähintään UP_SHARE
// sen korkeusmallin pikseleistä on yli ELEVATED metriä kantta alempana.
const QUAD_LEN = 4, ELEVATED = 0.5, UP_SHARE = 0.4;
// Siltaviivan korkeus on usein reunapalkin päältä, metrin tai puolitoista ajorataa ylempää.
// Kannen päässä (penkereellä) maanpinta on ajoradan tasolla, joten pään keskimääräinen ero
// maanpintaan laskee kantta, jos se on välillä END_OFFSET (m). Pikselit lasketaan siksi
// usealla kynnyksellä (ELEVATED + DROP_STEP · k).
const END_OFFSET = [-2.5, 0], DROP_BINS = 4, DROP_STEP = 1;
const EARTH_CIRC = 40075016.686;
const GRID_Z = 14; // kansien hakuruudukko (Web Mercator -tiilet)

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const latOfY = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

let edgeGrid = null;
let decks = [];
const deckGrid = new Map();

const ready = fetch("data/sillat.json").then((r) => r.json())
  .then(({ viivat, kannet, kaistat = [] }) => {
    edgeGrid = buildEdgeGrid(viivat);
    decks = [...kannet.map(buildDeck), ...kaistat.map((k) => ({ ...buildDeck(k), min: STRIP_MIN, strip: true }))];
    const n = 2 ** GRID_Z;
    decks.forEach((d, id) => {
      d.id = id;
      for (let x = Math.floor(d.minX * n); x <= Math.floor(d.maxX * n); x++) {
        for (let y = Math.floor(d.minY * n); y <= Math.floor(d.maxY * n); y++) {
          const key = cellKey(x, y);
          if (!deckGrid.has(key)) deckGrid.set(key, []);
          deckGrid.get(key).push(d);
        }
      }
    });
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
// rajaama monikulmio. min: kuinka paljon maaston on oltava kantta alempana, jotta se nostetaan.
// tot ja up: kunkin osan korkeusmallin pikselit ja niistä kantta selvästi alempana olevat.
function buildDeck([a, b]) {
  const toM = (line) => {
    const out = [];
    for (let i = 0; i < line.length; i += 3) out.push(mercX(line[i]), mercY(line[i + 1]), line[i + 2]);
    return out;
  };
  const a0 = toM(a), b0 = toM(b), mPerUnit = EARTH_CIRC * Math.cos((a[1] * Math.PI) / 180);
  const len = (P) => { let l = 0; for (let i = 3; i < P.length; i += 3) l += Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2]); return l; };
  const N = Math.max(2, Math.ceil((Math.max(len(a0), len(b0)) * mPerUnit) / QUAD_LEN) + 1);
  const A = resample(a0, N), B = resample(b0, N), ring = [];
  for (let i = 0; i < A.length; i += 3) ring.push(A[i], A[i + 1]);
  for (let i = B.length - 3; i >= 0; i -= 3) ring.push(B[i], B[i + 1]);
  const xs = ring.filter((_, i) => i % 2 === 0), ys = ring.filter((_, i) => i % 2 === 1);
  return {
    A, B, ring, min: DECK_MIN, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
    tot: new Uint32Array(N - 1), drop: new Uint32Array((N - 1) * DROP_BINS), sum: new Float64Array(N - 1),
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

// Kannen korkeus kansialueen pisteessä (reunojen korkeuksien välissä etäisyyksien suhteessa) ja
// pisteen osa. near: viereisen pisteen osa, jonka ympäriltä haetaan.
function deckAt(d, x, y, near = -1) {
  const [da, za, seg] = nearestOnEdge(d.A, x, y, near), [db, zb] = nearestOnEdge(d.B, x, y, near < 0 ? -1 : seg);
  return [da + db > 0 ? (za * db + zb * da) / (da + db) : za, seg];
}

// Kannen korkeuden korjaus (m, ≤ 0) osan q kohdalla: päiden erot maanpintaan, välissä lineaarisesti.
function endOffset(d, q) {
  if (d.tot[q] < 3) return null;
  const o = d.sum[q] / d.tot[q];
  return o >= END_OFFSET[0] && o <= END_OFFSET[1] + 0.5 ? Math.min(o, 0) : null;
}
function offsets(d) {
  const last = d.tot.length - 1, o0 = endOffset(d, 0), o1 = endOffset(d, last);
  return [o0 ?? o1 ?? 0, o1 ?? o0 ?? 0];
}
const offsetAt = ([o0, o1], t) => o0 + (o1 - o0) * t; // t: 0 kannen alussa, 1 lopussa

function isUp(d, q, off = offsets(d)) {
  const t = d.tot.length > 1 ? (q + 0.5) / d.tot.length : 0.5;
  const bin = Math.min(DROP_BINS - 1, Math.max(0, Math.round(-offsetAt(off, t) / DROP_STEP)));
  const up = d.drop[q * DROP_BINS + bin];
  return up >= 2 && up >= UP_SHARE * d.tot[q];
}

// 3D-laattojen muutokset (uusia maanpinnan yläpuolisia osia) ilmoitetaan kuuntelijoille koottuina.
const listeners = [];
let notifyTimer = null;
export function onDeckChange(fn) { listeners.push(fn); }
function changed() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; for (const fn of listeners) fn(); }, 300);
}

// Kannet, joista jokin osa on maanpinnan yläpuolella: { id, A, B (korkeus korjattuna), up: [osa
// piirretään], off: päiden korjaukset }.
export function elevatedDecks() {
  const out = [];
  for (const d of decks) {
    if (!d.tot.some((v) => v)) continue;
    const off = offsets(d), up = [];
    let any = false;
    for (let q = 0; q < d.tot.length; q++) any = (up[q] = isUp(d, q, off)) || any;
    if (!any) continue;
    const fix = (P) => P.map((v, i) => (i % 3 === 2 ? v + offsetAt(off, Math.floor(i / 3) / (P.length / 3 - 1)) : v));
    out.push({ id: d.id, A: fix(d.A), B: fix(d.B), up, off: off.map((o) => Math.round(o * 10) / 10) });
  }
  return out;
}

// Nostetuista pikseleistä muistetaan alkuperäinen maanpinnan korkeus, jotta sillan ali
// kulkeva ajoneuvo voidaan pitää alla olevan tien tasolla.
const rawTiles = new Map();

// Korkeusmallin tiili (Terrarium-koodaus). Kansialueilta lasketaan, missä kansi on maanpinnan
// yläpuolella (3D-laatat). Karkeissa tiilissä kansialueet nostetaan kannen tasolle; tiili
// palautetaan sellaisenaan, jos siinä ei ole siltaa tai se on tarkka.
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
  const img = ctx.getImageData(0, 0, W, H), px = img.data, patch = z <= PATCH_MAXZOOM;
  const raw = new Map(), strip = new Map(); // pikseli → maanpinta / kaistaleen korkeus
  const lift = (k, deck) => {
    const o = k * 4, v = deck + 32768;
    if (!raw.has(k)) raw.set(k, px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768);
    px[o] = Math.floor(v / 256);
    px[o + 1] = Math.floor(v) % 256;
    px[o + 2] = Math.floor((v - Math.floor(v)) * 256);
  };
  let seen = false;
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
          const X = tx0 + ((i + 0.5) / W) * size;
          const k = j * W + i, o = k * 4;
          const elev = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
          const [deck, q] = deckAt(d, X, Y, near);
          near = q;
          d.tot[q]++;
          d.sum[q] += elev - deck;
          for (let b = 0; b < DROP_BINS && elev < deck - ELEVATED - b * DROP_STEP; b++) d.drop[q * DROP_BINS + b]++;
          seen = true;
          if (!patch || elev >= deck - d.min) continue; // tarkka tiili tai maasto ei ole kantta alempana (esim. penger)
          if (d.strip) strip.set(k, Math.max(strip.get(k) ?? -Infinity, deck));
          else lift(k, deck);
        }
      }
    }
  }
  if (seen) changed();
  if (!patch) return buffer;
  // Kaistaleiden nostot siistitään avauksella (kuroutus ja laajennus 3 × 3 -ikkunassa): tukimuurin
  // tai luiskan reunalle osuvat 1–2 pikselin kaistat jäävät pois, mutta kansi säilyy. Tiilen
  // ulkopuoli lasketaan nostetuksi, jottei tiilten rajoille jää uria.
  const lifted = (i, j) => i < 0 || j < 0 || i >= W || j >= H || strip.has(j * W + i) || raw.has(j * W + i);
  const core = (i, j) => {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (!lifted(i + di, j + dj)) return false;
    return true;
  };
  const keep = [];
  for (const [k, deck] of strip) {
    if (raw.has(k)) continue;
    const i = k % W, j = (k - i) / W;
    let ok = false;
    for (let dj = -1; dj <= 1 && !ok; dj++) {
      for (let di = -1; di <= 1 && !ok; di++) {
        const ii = i + di, jj = j + dj;
        ok = ii >= 0 && jj >= 0 && ii < W && jj < H && (strip.has(jj * W + ii) || raw.has(jj * W + ii)) && core(ii, jj);
      }
    }
    if (ok) keep.push([k, deck]);
  }
  for (const [k, deck] of keep) lift(k, deck);
  if (!raw.size) return buffer;
  rawTiles.set(`${z}/${x}/${y}`, { raw, W, H });
  if (rawTiles.size > RAW_TILE_LIMIT) rawTiles.delete(rawTiles.keys().next().value);
  ctx.putImageData(img, 0, 0);
  return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
}

// Alkuperäinen maanpinnan korkeus (m) pisteessä, jos korkeusmalli on siinä nostettu
// kannen tasolle; muuten null.
export function rawElevationAt(lon, lat) {
  const X = mercX(lon), Y = mercY(lat);
  for (let z = PATCH_MAXZOOM; z >= PATCH_MINZOOM; z--) {
    const n = 2 ** z, x = Math.floor(X * n), y = Math.floor(Y * n);
    const tile = rawTiles.get(`${z}/${x}/${y}`);
    if (!tile) continue;
    const i = Math.floor((X * n - x) * tile.W), j = Math.floor((Y * n - y) * tile.H);
    return tile.raw.get(j * tile.W + i) ?? null;
  }
  return null;
}

// 3D-laatan pinnan korkeus (N2000, m) pisteessä, tai null, jos pisteessä ei ole laattaa.
export function deckSurfaceAt(lon, lat) {
  const X = mercX(lon), Y = mercY(lat), n = 2 ** GRID_Z;
  let best = null;
  for (const d of deckGrid.get(cellKey(Math.floor(X * n), Math.floor(Y * n))) ?? []) {
    if (X < d.minX || X > d.maxX || Y < d.minY || Y > d.maxY || !inRing(X, Y, d.ring)) continue;
    const [z, q] = deckAt(d, X, Y), off = offsets(d);
    const fixed = z + offsetAt(off, d.tot.length > 1 ? (q + 0.5) / d.tot.length : 0.5);
    if (isUp(d, q, off) && (best == null || fixed > best)) best = fixed;
  }
  return best;
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
