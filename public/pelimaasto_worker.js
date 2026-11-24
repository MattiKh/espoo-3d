// Pelillisen maaston työsäie (pelimaasto.js). Maanpeiteluokista (HSY, public/tiles/maanpeite) maalataan
// karttaruutujen pintakuvat: jokaisella luokalla on oma tekstuurinsa (metsissä latvukset, pelloilla
// vaot, vedessä aallot), ja kuviot lasketaan maailman koordinaateista, joten ne jatkuvat ruudusta
// toiseen. Lisäksi metsiin sijoitellaan puut tasavälisestä ruudukosta satunnaisesti siirtäen.

const LC_ZOOM = 16; // luokkaruutujen taso
const EARTH_CIRC = 40075016.686;
const M = EARTH_CIRC * Math.cos((60.18 * Math.PI) / 180); // m Web Mercator -yksikköä kohden Espoossa
const TILE_PX = 512;
const CACHE = 64; // luokkaruutuja muistissa
const TREE_STEP = 4.5; // m: puiden ruudukko
// Luokat kuten maanpeite.json (arvo = indeksi + 1): 1 vesi, 2 pellot, 3 matala kasvillisuus, 4 paljas maa,
// 5 avokalliot, 6–9 puusto 2–10, 10–15, 15–20 ja yli 20 m, 10 muu päällystetty, 11 päällystämätön tie,
// 12 päällystetty tie, 13 rakennus.
const TREE_HEIGHT = [0, 0, 0, 0, 0, 0, 6, 12, 17, 22]; // m luokittain

let base = "", version = 0;
const tiles = new Map(); // "x/y" → Promise<{ px, data } | null>

function classTile(x, y) {
  const key = `${x}/${y}`;
  let p = tiles.get(key);
  if (p) {
    tiles.delete(key);
    tiles.set(key, p);
    return p;
  }
  p = fetch(`${base}tiles/maanpeite/${LC_ZOOM}/${x}/${y}.png?v=${version}`)
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => blob && createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
    .then((bmp) => {
      if (!bmp) return null;
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data, data = new Uint8Array(bmp.width * bmp.height);
      for (let i = 0; i < data.length; i++) data[i] = rgba[4 * i];
      return { px: bmp.width, data };
    })
    .catch(() => null);
  tiles.set(key, p);
  if (tiles.size > CACHE) tiles.delete(tiles.keys().next().value);
  return p;
}

// Luokkaruudut, jotka kattavat Web Mercator -alueen; luokka pisteessä (0, jos ei tietoa).
async function classSampler(X0, Y0, X1, Y1) {
  const n = 2 ** LC_ZOOM, got = new Map();
  const tx0 = Math.floor(X0 * n), tx1 = Math.floor(X1 * n - 1e-12), ty0 = Math.floor(Y0 * n), ty1 = Math.floor(Y1 * n - 1e-12);
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) jobs.push(classTile(tx, ty).then((t) => got.set(tx * 100000 + ty, t)));
  }
  await Promise.all(jobs);
  let lastKey = -1, last = null;
  return (X, Y) => {
    const fx = X * n, fy = Y * n, tx = Math.floor(fx), ty = Math.floor(fy), key = tx * 100000 + ty;
    if (key !== lastKey) {
      lastKey = key;
      last = got.get(key) ?? null;
    }
    if (!last) return 0;
    const u = Math.min(last.px - 1, Math.floor((fx - tx) * last.px)), v = Math.min(last.px - 1, Math.floor((fy - ty) * last.px));
    return last.data[v * last.px + u];
  };
}

function hash(ix, iy) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Arvokohina 0–1 (pehmeä, jatkuva).
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// Luokan väri ja tekstuuri pisteessä (wx, wy metreinä): [r, g, b].
const out = [0, 0, 0];
function shade(c, wx, wy) {
  let r, g, b, k;
  switch (c) {
    case 1: { // vesi: aallot
      k = 0.9 + 0.12 * vnoise(wx / 7, wy / 3) + 0.06 * vnoise(wx / 1.6, wy / 0.9);
      r = 58; g = 132; b = 196;
      break;
    }
    case 2: { // pelto: vaot
      const row = 0.5 + 0.5 * Math.sin(((wx * 0.94 + wy * 0.34) * 2 * Math.PI) / 2.4);
      k = 0.84 + 0.12 * row + 0.08 * vnoise(wx / 9, wy / 9);
      r = 214; g = 188; b = 92;
      break;
    }
    case 3: // matala kasvillisuus: nurmi
      k = 0.86 + 0.1 * vnoise(wx / 0.8, wy / 0.8) + 0.1 * vnoise(wx / 7, wy / 7);
      r = 132; g = 184; b = 78;
      break;
    case 4: // paljas maa: hiekka
      k = 0.86 + 0.16 * vnoise(wx / 0.5, wy / 0.5) + 0.06 * vnoise(wx / 5, wy / 5);
      r = 200; g = 164; b = 112;
      break;
    case 5: { // kallio: halkeamat
      const ridge = 1 - Math.abs(2 * vnoise(wx / 3.2, wy / 3.2) - 1);
      k = 0.8 + 0.18 * vnoise(wx / 1.1, wy / 1.1) - (ridge > 0.9 ? 0.22 : 0);
      r = 156; g = 154; b = 148;
      break;
    }
    case 6: case 7: case 8: case 9: { // puusto: latvukset, korkeammassa suuremmat ja tummemmat
      const s = [2.2, 3, 3.8, 4.6][c - 6];
      const v = 0.62 * vnoise(wx / s, wy / s) + 0.38 * vnoise(wx / (s * 0.42), wy / (s * 0.42));
      k = v < 0.32 ? 0.5 : 0.62 + 0.62 * v;
      [r, g, b] = [[96, 158, 60], [74, 138, 52], [58, 118, 46], [44, 98, 42]][c - 6];
      break;
    }
    case 10: { // muu päällystetty: laatoitus
      const gx = ((wx % 2) + 2) % 2, gy = ((wy % 2) + 2) % 2;
      k = (gx < 0.1 || gy < 0.1 ? 0.9 : 1) * (0.95 + 0.06 * vnoise(wx / 0.7, wy / 0.7));
      r = 176; g = 174; b = 168;
      break;
    }
    case 11: // päällystämätön tie: sora
      k = 0.9 + 0.12 * vnoise(wx / 0.4, wy / 0.4);
      r = 186; g = 156; b = 110;
      break;
    case 12: // päällystetty tie: asfaltti
      k = 0.94 + 0.08 * vnoise(wx / 0.35, wy / 0.35);
      r = 82; g = 86; b = 94;
      break;
    case 13: // rakennus (3D-rakennukset peittävät)
      k = 1;
      r = 196; g = 120; b = 98;
      break;
    default:
      k = 1;
      r = 150; g = 158; b = 138;
  }
  out[0] = Math.min(255, r * k);
  out[1] = Math.min(255, g * k);
  out[2] = Math.min(255, b * k);
  return out;
}

// Ruudun pintakuva pakkaamattomana 24-bittisenä BMP:nä (PNG:n pakkaus olisi hidasta).
async function paintTile(z, x, y) {
  const n = 2 ** z, span = 1 / n, X0 = x / n, Y0 = y / n, S = TILE_PX;
  const classAt = await classSampler(X0, Y0, X0 + span, Y0 + span);
  const pxM = (span * M) / S, outline = pxM < 0.7, d = 0.35 / M;
  const row = Math.ceil((S * 3) / 4) * 4, size = 54 + row * S, buf = new ArrayBuffer(size), dv = new DataView(buf), px = new Uint8Array(buf);
  dv.setUint16(0, 0x4d42, true);
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, S, true);
  dv.setInt32(22, -S, true); // ylhäältä alas
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, row * S, true);
  for (let j = 0; j < S; j++) {
    const Y = Y0 + ((j + 0.5) / S) * span, wy = Y * M;
    for (let i = 0, o = 54 + j * row; i < S; i++, o += 3) {
      const X = X0 + ((i + 0.5) / S) * span, wx = X * M;
      // Luokkarajat hieman epäsäännöllisiksi (käsin piirretty vaikutelma).
      const jx = ((vnoise(wx * 0.8, wy * 0.8) - 0.5) * 0.5) / M, jy = ((vnoise(wx * 0.8 + 31.7, wy * 0.8) - 0.5) * 0.5) / M;
      const c = classAt(X + jx, Y + jy);
      const [r, g, b] = shade(c, wx, wy);
      // Luokkien rajoille tumma ääriviiva lähikuvassa.
      const e = outline && (classAt(X + jx + d, Y + jy) !== c || classAt(X + jx, Y + jy + d) !== c) ? 0.74 : 1;
      px[o] = b * e;
      px[o + 1] = g * e;
      px[o + 2] = r * e;
    }
  }
  return buf;
}

// Puut metsäluokissa ympyrän (keskipiste Web Mercator -yksiköissä, säde metreinä) sisällä:
// [X, Y, korkeus (m), havupuu (0/1), satunnaisluku 0–1, ...].
async function plantTrees(cx, cy, radius) {
  const r = radius / M, classAt = await classSampler(cx - r, cy - r, cx + r, cy + r);
  const out = [], s = TREE_STEP, wx0 = cx * M, wy0 = cy * M;
  for (let gx = Math.floor((wx0 - radius) / s); gx <= Math.ceil((wx0 + radius) / s); gx++) {
    for (let gy = Math.floor((wy0 - radius) / s); gy <= Math.ceil((wy0 + radius) / s); gy++) {
      const h1 = hash(gx, gy), h2 = hash(gy + 7919, gx), h3 = hash(gx * 3 + 1, gy * 5 + 2);
      const wx = (gx + 0.1 + 0.8 * h1) * s, wy = (gy + 0.1 + 0.8 * h2) * s;
      if ((wx - wx0) ** 2 + (wy - wy0) ** 2 > radius * radius) continue;
      const c = classAt(wx / M, wy / M);
      if (c < 6 || c > 9) continue;
      const conifer = c >= 8 ? h3 < 0.75 : h3 < 0.3;
      out.push(wx / M, wy / M, TREE_HEIGHT[c] * (0.75 + 0.5 * hash(gx + 13, gy + 17)), conifer ? 1 : 0, h3);
    }
  }
  return Float64Array.from(out);
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === "init") {
      ({ base, version } = msg);
    } else if (msg.type === "tile") {
      const buffer = await paintTile(msg.z, msg.x, msg.y);
      self.postMessage({ id: msg.id, buffer }, [buffer]);
    } else if (msg.type === "trees") {
      const trees = await plantTrees(msg.x, msg.y, msg.radius);
      self.postMessage({ id: msg.id, trees }, [trees.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err) });
  }
};
