// Sillat. Maaston korkeusmallista (Maanmittauslaitos 2 m) sillat on poistettu, joten ilmakuvan
// tie notkahtaisi sillan kohdalla alla olevan tien tai joen tasolle. scripts/build_data.py nostaa
// korkeusmallin tiilet kansien kohdalla valmiiksi kannen tasolle ja korjaa korkeusmallia uudempien
// teiden pinnan (public/tiles/korkeus), ja selain hakee näiden kohdalla nämä tiilet (app.js).
// Tarkimmista tiilistä on tallennettu myös nostettujen kohtien maanpinta, jotta sillan ali kulkeva
// ajoneuvo (transit.js) tai uoma (streams.js) voidaan pitää alla olevalla pinnalla. Espoon kantakartan siltojen reunaviivoista saadaan kannen
// korkeus ajoneuvoille.

const LON0 = 24.7, LAT0 = 60.2, KX = 55462, KY = 111415; // paikalliset metrit, kuten transit.js
const EDGE_CELL = 50; // m
const EDGE_REACH = 22; // m: leveälläkin sillalla keskikaista on näin lähellä reunaviivaa
const RAW_ZOOM = 15; // tämän tason tiilistä on tallennettu alkuperäinen maanpinta
const RAW_TILE_LIMIT = 300;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

let edgeGrid = null;
const lifted = new Set(); // nostetut tiilet "z/x/y"
const gameTiles = new Set(); // pelillisen maaston tiilet (korkeat jänteet auki, sillat 3D-malleina)
const gameOriginal = new Set(); // pelillisessä maastossa alkuperäiset (kaikki nostot avattu)
let gameMode = false;
let version = 0;

const ready = fetch("data/sillat.json").then((r) => r.json())
  .then(({ viivat, korkeus = {}, korkeus_peli = {}, korkeus_peli_alkup = {} }) => {
    edgeGrid = buildEdgeGrid(viivat);
    for (const [set, index] of [[lifted, korkeus], [gameTiles, korkeus_peli], [gameOriginal, korkeus_peli_alkup]]) {
      for (const [z, xy] of Object.entries(index)) {
        for (let i = 0; i < xy.length; i += 2) set.add(`${z}/${xy[i]}/${xy[i + 1]}`);
      }
    }
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

// Pelillisessä maastossa (pelimaasto.js) sillat ovat 3D-malleja, joten käytetään korkeusmallia,
// jossa korkeat jänteet ovat auki. Kannella kulkeva ajoneuvo pidetään silloin kannen tasolla (transit.js).
export function setGameMode(on) {
  gameMode = on;
}
export const isGameMode = () => gameMode;

// Valmiiksi nostetun korkeusmallin tiilen osoite, tai null, jos tiilessä ei ole siltaa (silloin
// käytetään alkuperäistä). version: aineistoversio, jotta selain ei käytä vanhoja tiiliä.
// Pelillisessä maastossa avattujen siltojen tiilet ovat erikseen; muut ovat kuten tavallisesti.
export async function liftedTileUrl(z, x, y, v) {
  await ready;
  const key = `${z}/${x}/${y}`;
  if (gameMode && gameTiles.has(key)) return `tiles/korkeus/peli/${key}.webp?v=${v}`;
  if (gameMode && gameOriginal.has(key)) return null;
  if (!lifted.has(key)) return null;
  version = v;
  if (z === RAW_ZOOM) loadRaw(x, y);
  return `tiles/korkeus/${z}/${x}/${y}.webp?v=${v}`;
}

// Alkuperäinen maanpinta nostetuissa pikseleissä (muualla musta): avain x/y → { W, idx, raw },
// idx: nostettujen pikselien indeksit järjestyksessä, raw: niiden maanpinnan korkeus.
const rawTiles = new Map();

function loadRaw(x, y) {
  const key = `${x}/${y}`;
  if (rawTiles.has(key)) return;
  rawTiles.set(key, null);
  if (rawTiles.size > RAW_TILE_LIMIT) rawTiles.delete(rawTiles.keys().next().value);
  fetch(`tiles/korkeus/maa/${x}/${y}.webp?v=${version}`)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
    .then((blob) => createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
    .then((bmp) => {
      const W = bmp.width, H = bmp.height, ctx = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, W, H).data, idx = [], raw = [];
      for (let k = 0, o = 0; k < W * H; k++, o += 4) {
        if (px[o] || px[o + 1] || px[o + 2]) {
          idx.push(k);
          raw.push(px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768);
        }
      }
      if (rawTiles.has(key)) rawTiles.set(key, { W, H, idx: Int32Array.from(idx), raw: Float32Array.from(raw) });
    })
    .catch((err) => {
      rawTiles.delete(key);
      console.warn("Sillan alustan korkeuksia ei saatu ladattua", err);
    });
}

// Alkuperäinen maanpinnan korkeus (m) pisteessä, jos korkeusmalli on siinä nostettu kannen
// tasolle; muuten null.
export function rawElevationAt(lon, lat) {
  const n = 2 ** RAW_ZOOM, X = mercX(lon) * n, Y = mercY(lat) * n, x = Math.floor(X), y = Math.floor(Y);
  if (!lifted.has(`${RAW_ZOOM}/${x}/${y}`)) return null;
  const tile = rawTiles.get(`${x}/${y}`);
  if (tile === undefined) loadRaw(x, y);
  if (!tile) return null;
  const k = Math.floor((Y - y) * tile.H) * tile.W + Math.floor((X - x) * tile.W);
  let lo = 0, hi = tile.idx.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tile.idx[mid] === k) return tile.raw[mid];
    if (tile.idx[mid] < k) lo = mid + 1;
    else hi = mid - 1;
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
