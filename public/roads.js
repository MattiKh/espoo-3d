// Ajotiet bussien kohdistukseen (OpenStreetMap, scripts/build_data.py). HFP:n sijainti on GPS:n
// mukainen eikä kerro kaistaa, joten bussi siirretään sivusuunnassa lähimmälle menosuuntaan sopivalle
// tielle menosuunnan oikeanpuoleisimman kaistan keskelle (oikeanpuoleinen liikenne). Kaistan paikka
// keskilinjasta on laskettu valmiiksi kummallekin suunnalle; yksisuuntaisella tiellä vastasuuntaa ei ole.
// Rampin tai ajoradan päässä kaistan paikka voi olla eri (pääväylän kaista), ja se muuttuu tasaisesti.

const CELL = 60; // m: hakuruutu; haku katsoo ympäröivät 3 × 3 ruutua
const EDGE = 1.8; // m: ajoradan reuna on näin kaukana uloimman kaistan keskeltä
const FULL = 4; // m: ajoradalla tai enintään näin kaukana sen reunasta oleva sijainti kohdistetaan kokonaan,
const REACH = 12; // m: ... ja tätä kauempana olevaa ei lainkaan (esim. tie, jota ei ole aineistossa)
const SEARCH = 30; // m: tiet näin kaukaa keskilinjasta
const END_EASE = 80; // m: rampin tai ajoradan päässä kaistan paikka muuttuu näin pitkällä matkalla
const TURN_PENALTY = 15; // m: poikittain menosuuntaan nähden olevan tien haitta (risteävät tiet)
const JOIN_PENALTY = 1.5; // m: tien vaihto toiseen, joka yhtyy edelliseen
const SWITCH_PENALTY = 5; // m: tien vaihto muuhun tiehen (rinnakkaiset tiet ja ajoradat)

let net = null;

const cellKey = (cx, cy) => (cx + 10000) * 20000 + (cy + 10000);

export async function loadRoads(url) {
  const d = await fetch(url).then((r) => r.json());
  const nw = d.tiet.length, nv = d.tiet.reduce((a, row) => a + (row.length - 4) / 2, 0);
  const x = new Float64Array(nv), y = new Float64Array(nv), nx = new Float32Array(nv), ny = new Float32Array(nv);
  const fwd = new Float32Array(nw), back = new Float32Array(nw), start = new Float32Array(nw), end = new Float32Array(nw);
  const len = new Float32Array(nw), along = new Float32Array(nv), way = new Uint32Array(nv);
  const at = new Map(); // pisteen paikka (dm) → tiet, jotka kulkevat sen kautta
  const grid = new Map();
  let i = 0;
  const dm = (v) => (v == null ? NaN : v / 10);
  d.tiet.forEach(([f, b, s0, s1, ...xy], w) => {
    fwd[w] = dm(f); back[w] = dm(b); start[w] = dm(s0); end[w] = dm(s1);
    const n = xy.length / 2;
    let px = 0, py = 0;
    for (let j = 0; j < n; j++) {
      px += xy[2 * j]; py += xy[2 * j + 1];
      x[i + j] = px / 10; y[i + j] = py / 10; way[i + j] = w;
      along[i + j] = j ? along[i + j - 1] + Math.hypot(x[i + j] - x[i + j - 1], y[i + j] - y[i + j - 1]) : 0;
      const key = px * 1e6 + py;
      if (!at.has(key)) at.set(key, []);
      at.get(key).push(w);
    }
    // Pisteiden normaalit (oikealle tien suuntaan nähden) viisteellä kuten offset_line
    // (scripts/build_data.py), jotta kaistan paikka jatkuu taitekohdan yli katkeamatta.
    const seg = (j) => {
      const dx = x[i + j + 1] - x[i + j], dy = y[i + j + 1] - y[i + j], l = Math.hypot(dx, dy) || 1;
      return [dy / l, -dx / l];
    };
    for (let j = 0; j < n; j++) {
      const n1 = seg(Math.max(0, j - 1)), n2 = seg(Math.min(n - 2, j));
      let sx = n1[0] + n2[0], sy = n1[1] + n2[1];
      const l = Math.hypot(sx, sy) || 1, k = 1 / Math.max(0.5, (sx * n2[0] + sy * n2[1]) / l);
      nx[i + j] = (sx / l) * k; ny[i + j] = (sy / l) * k;
    }
    for (let j = 0; j < n - 1; j++) {
      const a = i + j;
      for (let cx = Math.floor(Math.min(x[a], x[a + 1]) / CELL); cx <= Math.floor(Math.max(x[a], x[a + 1]) / CELL); cx++) {
        for (let cy = Math.floor(Math.min(y[a], y[a + 1]) / CELL); cy <= Math.floor(Math.max(y[a], y[a + 1]) / CELL); cy++) {
          const key = cellKey(cx, cy);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(a);
        }
      }
    }
    len[w] = along[i + n - 1];
    i += n;
  });
  const joins = Array.from({ length: nw }, () => new Set());
  for (const list of at.values()) for (const a of list) for (const b of list) if (a !== b) joins[a].add(b);
  net = { x, y, nx, ny, fwd, back, start, end, len, along, way, joins, grid };
}

// Kaistan paikka tien suuntaan ajettaessa matkan s (m) kohdalla tien alusta: tien päiden lähellä
// siirrytään pehmeästi (smoothstep) päässä olevaan paikkaan, jos se on eri.
function forwardAt(w, s) {
  const { fwd, start, end, len } = net, ease = Math.min(END_EASE, len[w] / 2);
  const near = (d) => (d >= ease ? 0 : 1 - (d / ease) ** 2 * (3 - 2 * d / ease));
  let off = fwd[w];
  if (!Number.isNaN(start[w])) off += (start[w] - fwd[w]) * near(s);
  if (!Number.isNaN(end[w])) off += (end[w] - fwd[w]) * near(len[w] - s);
  return off;
}

// Lähin menosuuntaan sopiva tie sijainnin (px, py) kohdalla tai null. h on menosuunta (yksikkövektori)
// tai null, jolloin kokeillaan kumpaakin suuntaa; prev on edellinen tulos, jonka tiellä pysymistä
// suositaan. Palauttaa { way, dir: menosuunta, nx, ny: oikea yksikkönormaali, lat: sijainnin etäisyys
// keskilinjasta oikealle, off: kaistan paikka keskilinjasta oikealle (viisteen kerroin k mukana
// tuloon off * k), gap: sijainnin etäisyys kaistan kohdasta, weight: kohdistuksen osuus 0–1 (etäisyys
// ajoradasta), stay: sama edellisen tien kohdalla tai null }.
export function onRoad(px, py, h, prev) {
  if (!net) return null;
  const { x, y, nx, ny, back, along, way, joins, grid } = net;
  const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
  let best = null, bestScore = Infinity, stay = null, stayDist = Infinity;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const a of grid.get(cellKey(gx, gy)) ?? []) {
        const ax = x[a], ay = y[a], dx = x[a + 1] - ax, dy = y[a + 1] - ay, l2 = dx * dx + dy * dy;
        if (l2 < 1e-4) continue;
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        const qx = ax + u * dx, qy = ay + u * dy, d = Math.hypot(px - qx, py - qy);
        if (d > SEARCH) continue;
        const w = way[a], l = Math.sqrt(l2), tx = dx / l, ty = dy / l;
        const mx = nx[a] + (nx[a + 1] - nx[a]) * u, my = ny[a] + (ny[a + 1] - ny[a]) * u;
        const offOf = (s) => (s > 0 ? forwardAt(w, along[a] + u * l) : back[w]);
        // Kaistan kohta suunnassa s (null, jos sijainti on liian kaukana ajoradasta). Ajorata ulottuu
        // menosuunnan uloimmasta kaistasta vastasuunnan uloimpaan (yksisuuntaisella yhtä kauas kumpaankin).
        const place = (s, off) => {
          const lat = s * ((px - qx) * ty - (py - qy) * tx), k = mx * ty - my * tx, opp = offOf(-s);
          const right = off * k + EDGE, left = -((Number.isNaN(opp) ? off : opp) * k + EDGE);
          const side = lat > right ? lat - right : lat < left ? left - lat : 0;
          const out = Math.hypot(side, Math.sqrt(Math.max(0, d * d - lat * lat))); // myös tien pään ohi
          return out > REACH ? null : {
            way: w, dir: [s * tx, s * ty], nx: s * ty, ny: -s * tx, lat, off, k,
            gap: Math.hypot(px - qx - s * off * mx, py - qy - s * off * my), weight: Math.min(1, (REACH - out) / (REACH - FULL)),
          };
        };
        if (prev?.way === w && d < stayDist) {
          const s = tx * prev.dir[0] + ty * prev.dir[1] >= 0 ? 1 : -1, off = offOf(s);
          if (!Number.isNaN(off)) { stayDist = d; stay = place(s, off) ?? stay; }
        }
        const cos = h ? tx * h[0] + ty * h[1] : 0;
        const score = (h ? TURN_PENALTY * (1 - Math.abs(cos)) : 0)
          + (!prev || prev.way === w ? 0 : joins[prev.way].has(w) ? JOIN_PENALTY : SWITCH_PENALTY);
        if (score >= bestScore) continue;
        for (const s of h ? [cos >= 0 ? 1 : -1] : [1, -1]) {
          const off = offOf(s);
          if (Number.isNaN(off)) continue; // yksisuuntainen tie väärään suuntaan
          // Etäisyys kaistan kohdasta: väärän ajoradan ja vastaantulevien kaistan tiet jäävät huonommiksi.
          const p = place(s, off);
          if (!p || score + p.gap >= bestScore) continue;
          bestScore = score + p.gap;
          best = p;
        }
      }
    }
  }
  if (best) best.stay = stay;
  return best;
}
