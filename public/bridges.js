// Sillat. Maaston korkeusmallista (Maanmittauslaitos 2 m) sillat on poistettu, joten ilmakuvan
// tie notkahtaa sillan kohdalla alla olevan tien tai joen tasolle. Espoon kantakartan siltojen
// reunaviivoissa on kannen mitattu korkeus (N2000), ja niistä on muodostettu kansialueet
// (scripts/build_data.py). Siltaviivoista puuttuu usein toinen reuna, joten siltojen lähellä
// kansia täydentävät ajoväylien reunaviivojen väliset kaistaleet. Korkeusmallin tiilet
// nostetaan kansialueilla kannen tasolle, ja ajoneuvot ohjataan kannelle tai sen alle (transit.js).

const LON0 = 24.7, LAT0 = 60.2, KX = 55462, KY = 111415; // paikalliset metrit, kuten transit.js
const EDGE_CELL = 50; // m
const EDGE_REACH = 22; // m: leveälläkin sillalla keskikaista on näin lähellä reunaviivaa
const PATCH_MINZOOM = 13; // karkeammissa tiilissä kansi on vain muutama pikseli
const RAW_TILE_LIMIT = 400;
// Kaistaleita on myös tasaisella maalla tien kohdalla, joten ne nostavat maastoa vain, jos se on
// selvästi kaistaletta alempana (m). Siltaviivojen kansilla riittää pieni ero.
const STRIP_MIN = 0.5, DECK_MIN = 0.05;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

let edgeGrid = null;
let decks = [];

const ready = fetch("data/sillat.json").then((r) => r.json())
  .then(({ viivat, kannet, kaistat = [] }) => {
    edgeGrid = buildEdgeGrid(viivat);
    decks = [...kannet.map(buildDeck), ...kaistat.map((k) => ({ ...buildDeck(k), min: STRIP_MIN, strip: true }))];
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

// Kansi Web Mercator -yksiköissä: reunat A ja B sekä niiden rajaama monikulmio. min: kuinka paljon
// maaston on oltava kantta alempana, jotta se nostetaan.
function buildDeck([a, b]) {
  const toM = (line) => {
    const out = [];
    for (let i = 0; i < line.length; i += 3) out.push(mercX(line[i]), mercY(line[i + 1]), line[i + 2]);
    return out;
  };
  const A = toM(a), B = toM(b), ring = [];
  for (let i = 0; i < A.length; i += 3) ring.push(A[i], A[i + 1]);
  for (let i = B.length - 3; i >= 0; i -= 3) ring.push(B[i], B[i + 1]);
  const xs = ring.filter((_, i) => i % 2 === 0), ys = ring.filter((_, i) => i % 2 === 1);
  return { A, B, ring, min: DECK_MIN, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Etäisyys reunaviivaan ja reunan korkeus lähimmässä kohdassa.
function nearestOnEdge(P, x, y) {
  let best = Infinity, z = P[2];
  for (let i = 3; i < P.length; i += 3) {
    const ax = P[i - 3], ay = P[i - 2], dx = P[i] - ax, dy = P[i + 1] - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) { best = d; z = P[i - 1] + (P[i + 2] - P[i - 1]) * t; }
  }
  return [best, z];
}

// Kannen korkeus kansialueen pisteessä: reunojen korkeuksien välissä etäisyyksien suhteessa.
function deckZ(d, x, y) {
  const [da, za] = nearestOnEdge(d.A, x, y), [db, zb] = nearestOnEdge(d.B, x, y);
  return da + db > 0 ? (za * db + zb * da) / (da + db) : za;
}

// Nostetuista pikseleistä muistetaan alkuperäinen maanpinnan korkeus, jotta sillan ali
// kulkeva ajoneuvo voidaan pitää alla olevan tien tasolla.
const rawTiles = new Map();

// Korkeusmallin tiili (Terrarium-koodaus) kansialueet nostettuina. Tiili palautetaan
// sellaisenaan, jos siinä ei ole siltaa.
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
  const raw = new Map(), strip = new Map(); // pikseli → maanpinta / kaistaleen korkeus
  const lift = (k, deck) => {
    const o = k * 4, v = deck + 32768;
    if (!raw.has(k)) raw.set(k, px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768);
    px[o] = Math.floor(v / 256);
    px[o + 1] = Math.floor(v) % 256;
    px[o + 2] = Math.floor((v - Math.floor(v)) * 256);
  };
  for (const d of hits) {
    const i0 = Math.max(0, Math.floor(((d.minX - tx0) / size) * W)), i1 = Math.min(W - 1, Math.floor(((d.maxX - tx0) / size) * W));
    const j0 = Math.max(0, Math.floor(((d.minY - ty0) / size) * H)), j1 = Math.min(H - 1, Math.floor(((d.maxY - ty0) / size) * H));
    for (let j = j0; j <= j1; j++) {
      const Y = ty0 + ((j + 0.5) / H) * size;
      for (let i = i0; i <= i1; i++) {
        const X = tx0 + ((i + 0.5) / W) * size;
        if (!inRing(X, Y, d.ring)) continue;
        const k = j * W + i, o = k * 4;
        const elev = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
        const deck = deckZ(d, X, Y);
        if (elev >= deck - d.min) continue; // maasto ei ole kantta alempana (esim. penger)
        if (d.strip) strip.set(k, Math.max(strip.get(k) ?? -Infinity, deck));
        else lift(k, deck);
      }
    }
  }
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
  for (let z = 15; z >= PATCH_MINZOOM; z--) {
    const n = 2 ** z, x = Math.floor(X * n), y = Math.floor(Y * n);
    const tile = rawTiles.get(`${z}/${x}/${y}`);
    if (!tile) continue;
    const i = Math.floor((X * n - x) * tile.W), j = Math.floor((Y * n - y) * tile.H);
    return tile.raw.get(j * tile.W + i) ?? null;
  }
  return null;
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
