// Raideverkko: junien, metron ja raitiovaunujen raiteet ja pysähtymispaikat (OpenStreetMap,
// scripts/build_data.py). Ajoneuvot pidetään raiteilla, vaunut asetetaan raidetta pitkin, ja
// jos sijainti katkeaa, liikettä jatketaan raidetta pitkin seuraavalle asemalle asti.

const LON0 = 24.7, LAT0 = 60.2, KX = 55462, KY = 111415; // paikalliset metrit, kuten transit.js
export const RAIL = 0, METRO = 1, TRAM = 2;
const CELL = 100; // m
const REACH = 40; // m: tätä kauempana raiteesta olevaa sijaintia ei siirretä raiteelle
const WAY_PENALTY = 3; // m: edellisellä raiteella pysymistä suositaan rinnakkaisten raiteiden välillä
const MIN_TURN = 0.5; // vaihteessa jatketaan vain raiteelle, joka kääntyy alle 60°

let net = null;

const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

export async function loadRails(url) {
  const d = await fetch(url).then((r) => r.json());
  const n = d.solmut.length / 2;
  const x = new Float64Array(n), y = new Float64Array(n), stop = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (d.solmut[2 * i] - LON0) * KX;
    y[i] = (d.solmut[2 * i + 1] - LAT0) * KY;
  }
  for (const i of d.pysakit) stop[i] = 1;
  const ea = [], eb = [], kind = [], way = [], len = [];
  const adj = Array.from({ length: n }, () => []);
  const grid = new Map();
  d.raiteet.forEach(([k, ...refs], w) => {
    for (let j = 1; j < refs.length; j++) {
      const a = refs[j - 1], b = refs[j], l = Math.hypot(x[b] - x[a], y[b] - y[a]);
      if (l < 0.01) continue;
      const e = ea.length;
      ea.push(a); eb.push(b); kind.push(k); way.push(w); len.push(l);
      adj[a].push(e); adj[b].push(e);
      for (let cx = Math.floor((Math.min(x[a], x[b]) - REACH) / CELL); cx <= Math.floor((Math.max(x[a], x[b]) + REACH) / CELL); cx++) {
        for (let cy = Math.floor((Math.min(y[a], y[b]) - REACH) / CELL); cy <= Math.floor((Math.max(y[a], y[b]) + REACH) / CELL); cy++) {
          const key = cellKey(cx, cy);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(e);
        }
      }
    }
  });
  net = { x, y, stop, ea, eb, kind, way, len, adj, grid, ways: d.raiteet };
}

export const railsReady = () => net != null;

// Lähin kohta annetun lajin raiteella: { e, u, x, y, way } (u = osuus raideosuuden alusta), tai
// null. Edellistä raidetta suositaan, jottei juna hypi rinnakkaisten raiteiden välillä.
export function snap(px, py, k, prevWay = -1) {
  const edges = net?.grid.get(cellKey(Math.floor(px / CELL), Math.floor(py / CELL)));
  if (!edges) return null;
  let best = null, bestScore = REACH;
  for (const e of edges) {
    if (net.kind[e] !== k) continue;
    const a = net.ea[e], b = net.eb[e], ax = net.x[a], ay = net.y[a], dx = net.x[b] - ax, dy = net.y[b] - ay;
    const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const qx = ax + u * dx, qy = ay + u * dy;
    const score = Math.hypot(qx - px, qy - py) + (net.way[e] === prevWay ? 0 : WAY_PENALTY);
    if (score < bestScore) { bestScore = score; best = { e, u, x: qx, y: qy, way: net.way[e] }; }
  }
  return best;
}

// Raideosuuden suunta (yksikkövektori alusta loppuun).
export function edgeDir(e) {
  const a = net.ea[e], b = net.eb[e];
  return [(net.x[b] - net.x[a]) / net.len[e], (net.y[b] - net.y[a]) / net.len[e]];
}

// Kulkusuunta raideosuudella: +1 alusta loppuun, -1 toisinpäin.
export function signFor(e, hx, hy) {
  const [dx, dy] = edgeDir(e);
  return dx * hx + dy * hy >= 0 ? 1 : -1;
}

// Seuraava raideosuus solmussa: suorin jatko samanlajisella raiteella. Palauttaa [e, sign] tai null.
function nextEdge(e, node, dx, dy) {
  let best = null, bestDot = MIN_TURN;
  for (const c of net.adj[node]) {
    if (c === e || net.kind[c] !== net.kind[e]) continue;
    const sign = net.ea[c] === node ? 1 : -1;
    const [cx, cy] = edgeDir(c);
    const dot = (cx * dx + cy * dy) * sign;
    if (dot > bestDot) { bestDot = dot; best = [c, sign]; }
  }
  return best;
}

// Kulkee raidetta pitkin matkan dist suuntaan sign. Vaihteissa valitaan suorin jatko.
// onNode(node, distance) kutsutaan jokaisessa ohitetussa solmussa; jos se palauttaa true,
// kulku pysähtyy solmuun. Palauttaa { e, u, sign, x, y, moved }.
export function walk(e, u, sign, dist, onNode) {
  let moved = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const l = net.len[e], left = (sign > 0 ? 1 - u : u) * l;
    if (dist - moved <= left) {
      u += (sign * (dist - moved)) / l;
      moved = dist;
      break;
    }
    moved += left;
    const node = sign > 0 ? net.eb[e] : net.ea[e];
    u = sign > 0 ? 1 : 0;
    if (onNode?.(node, moved)) break;
    const [dx, dy] = edgeDir(e);
    const next = nextEdge(e, node, dx * sign, dy * sign);
    if (!next) break; // raide päättyy
    [e, sign] = next;
    u = sign > 0 ? 0 : 1;
  }
  const a = net.ea[e], b = net.eb[e];
  return { e, u, sign, x: net.x[a] + (net.x[b] - net.x[a]) * u, y: net.y[a] + (net.y[b] - net.y[a]) * u, moved };
}

// Etäisyys seuraavaan pysähtymispaikkaan kulkusuunnassa (enintään maxDist), tai null.
export function nextStop(e, u, sign, maxDist) {
  let found = null;
  walk(e, u, sign, maxDist, (node, d) => {
    if (net.stop[node]) { found = d; return true; }
    return false;
  });
  return found;
}

// Pisteet raidetta pitkin taaksepäin kulkusuunnasta: vanhin ensin, viimeisenä lähtöpiste.
export function pathBehind(e, u, sign, total, step = 5) {
  const pts = [];
  for (let d = 0; d <= total; d += step) {
    const p = walk(e, u, -sign, d);
    pts.push([p.x, p.y]);
    if (p.moved < d) break; // raide päättyi
  }
  return pts.reverse();
}

// Metroradat murtoviivoina (tunneleiden piirtämiseen): [x, y, pysähtymispaikka].
export function metroLines() {
  if (!net) return [];
  return net.ways.filter(([k]) => k === METRO).map(([, ...refs]) => refs.map((i) => [net.x[i], net.y[i], net.stop[i] === 1]));
}
