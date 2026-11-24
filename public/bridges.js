// Sillat. Maaston korkeusmallista (Maanmittauslaitos 2 m) sillat on poistettu, joten ilmakuvan
// tie notkahtaa sillan kohdalla alla olevan tien tai joen tasolle. Kukin silta on kansinauha
// (scripts/build_data.py): OpenStreetMapin tien tai raiteen keskilinja kannen korkeuksineen
// (Espoon kantakartan siltojen, ajoväylien ja raiteiden mitatuista korkeuksista) ja puolileveys.
// decks.js piirtää nauhasta yksinkertaisen laatan sinne, missä se on maanpinnan yläpuolella, ja
// jatkaa sitä kummastakin päästä, jolloin laatta peittää sillan päiden kuopat. Korkeusmallia ei
// muuteta. Ajoneuvot ohjataan laatalle tai sen alle (transit.js).

const LON0 = 24.7, LAT0 = 60.2, KX = 55462, KY = 111415; // paikalliset metrit, kuten transit.js
const EDGE_CELL = 50; // m
const EDGE_REACH = 22; // m: leveälläkin sillalla keskikaista on näin lähellä reunaviivaa
const SAMPLE_STEP = 3; // m: nauhan näytteiden väli
const GRID_Z = 15; // nauhojen hakuruudukko (Web Mercator -tiilet, noin 600 m)
const EARTH_CIRC = 40075016.686;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

let edgeGrid = null;
let ribbons = [];
const ribbonGrid = new Map();

export const ready = fetch("data/sillat.json").then((r) => r.json())
  .then(({ viivat, nauhat = [] }) => {
    edgeGrid = buildEdgeGrid(viivat);
    ribbons = nauhat.map(buildRibbon);
    const n = 2 ** GRID_Z;
    for (const r of ribbons) {
      for (let x = Math.floor(r.minX * n); x <= Math.floor(r.maxX * n); x++) {
        for (let y = Math.floor(r.minY * n); y <= Math.floor(r.maxY * n); y++) {
          const key = cellKey(x, y);
          if (!ribbonGrid.has(key)) ribbonGrid.set(key, []);
          ribbonGrid.get(key).push(r);
        }
      }
    }
  })
  .catch((err) => console.warn("Siltoja ei saatu ladattua", err));

export const getRibbons = () => ribbons;

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

// Nauha Web Mercator -yksiköissä: näytteet tasavälein (x, y, korkeus z, matka s metreinä),
// puolileveys half ja drawn: mitkä näytteet laatta kattaa (decks.js).
function buildRibbon({ p, w }, id) {
  const lat = p[1], unit = EARTH_CIRC * Math.cos((lat * Math.PI) / 180); // m Web Mercator -yksikköä kohden
  const px = [], py = [], pz = [], ps = [0];
  for (let i = 0; i < p.length; i += 3) {
    px.push(mercX(p[i])); py.push(mercY(p[i + 1])); pz.push(p[i + 2]);
    if (i) ps.push(ps[ps.length - 1] + Math.hypot(px.at(-1) - px.at(-2), py.at(-1) - py.at(-2)) * unit);
  }
  const total = ps.at(-1), n = Math.max(2, Math.ceil(total / SAMPLE_STEP) + 1);
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float32Array(n), s = new Float32Array(n);
  for (let k = 0, i = 0; k < n; k++) {
    const t = (total * k) / (n - 1);
    while (i < ps.length - 2 && ps[i + 1] < t) i++;
    const f = ps[i + 1] > ps[i] ? Math.min(1, Math.max(0, (t - ps[i]) / (ps[i + 1] - ps[i]))) : 0;
    x[k] = px[i] + (px[i + 1] - px[i]) * f;
    y[k] = py[i] + (py[i + 1] - py[i]) * f;
    z[k] = pz[i] + (pz[i + 1] - pz[i]) * f;
    s[k] = t;
  }
  const half = w / unit;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    minX = Math.min(minX, x[k] - half); maxX = Math.max(maxX, x[k] + half);
    minY = Math.min(minY, y[k] - half); maxY = Math.max(maxY, y[k] + half);
  }
  return { id, x, y, z, s, n, w, half, lat, minX, minY, maxX, maxY, drawn: new Uint8Array(n) };
}

// Laattojen pinnan korkeudet (N2000, m) pisteessä: kaikki piirretyt nauhat, joiden kohdalla piste on.
export function deckLevelsAt(lon, lat) {
  const X = mercX(lon), Y = mercY(lat), n = 2 ** GRID_Z, out = [];
  for (const r of ribbonGrid.get(cellKey(Math.floor(X * n), Math.floor(Y * n))) ?? []) {
    if (X < r.minX || X > r.maxX || Y < r.minY || Y > r.maxY) continue;
    let best = r.half, z = null;
    for (let k = 0; k < r.n - 1; k++) {
      if (!r.drawn[k] || !r.drawn[k + 1]) continue;
      const dx = r.x[k + 1] - r.x[k], dy = r.y[k + 1] - r.y[k], len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((X - r.x[k]) * dx + (Y - r.y[k]) * dy) / len2)) : 0;
      const d = Math.hypot(r.x[k] + t * dx - X, r.y[k] + t * dy - Y);
      if (d <= best) { best = d; z = r.z[k] + (r.z[k + 1] - r.z[k]) * t; }
    }
    if (z != null) out.push(z);
  }
  return out;
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
