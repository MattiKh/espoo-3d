// Pelillisen maaston työsäie (pelimaasto.js). Maanpeiteluokista (HSY, public/tiles/maanpeite) maalataan
// karttaruutujen pintakuvat: jokaisella luokalla on oma tekstuurinsa (metsissä latvukset, pelloilla
// vaot, vedessä aallot), ja kuviot lasketaan maailman koordinaateista, joten ne jatkuvat ruudusta
// toiseen. Lisäksi metsiin sijoitellaan puut tasavälisestä ruudukosta satunnaisesti siirtäen.
// Luokkaruutujen tasot (maanpeite.json: tasot): tarkat 0,3 m (16) koko Espoosta, niistä koottu
// välitaso 1,2 m (14) kauempana näkyville ruuduille ja yleiskuva (12 ja 9) loitonnettaessa ja Espoon
// ulkopuolella. Yhden luokan ruudut ovat vain luettelossa (tasaiset). Ruutuja haetaan vain
// maalattavien karttaruutujen kohdalta, ja muistissa pidetään viimeksi käytetyt (CACHE_BYTES).

const LC_ZOOM = 16; // tarkkojen luokkaruutujen taso
const MID_ZOOM = 14; // välitaso: maalataan karttaruudut tasoilla 14–15
const EARTH_CIRC = 40075016.686;
const M = EARTH_CIRC * Math.cos((60.18 * Math.PI) / 180); // m Web Mercator -yksikköä kohden Espoossa
const TILE_PX = 512;
const CACHE_BYTES = 40e6; // purettuja luokkaruutuja muistissa (tarkka ruutu 1 Mt)
const TREE_STEP = 4.5; // m: puiden ruudukko
// Luokat kuten maanpeite.json (arvo = indeksi + 1): 1 vesi, 2 pellot, 3 matala kasvillisuus, 4 paljas maa,
// 5 avokalliot, 6–9 puusto 2–10, 10–15, 15–20 ja yli 20 m, 10 muu päällystetty, 11 päällystämätön tie,
// 12 päällystetty tie, 13 rakennus.
const TREE_HEIGHT = [0, 0, 0, 0, 0, 0, 6, 12, 17, 22]; // m luokittain

let base = "", version = 0;
let levels = []; // luokkaruutujen tasot tarkimmasta alkaen
let fine = []; // tarkoista luokista tehdyt tasot (16, 14); muut ovat yleiskuvaa
const index = new Map(); // "z/x/y" → true (kuva) tai luokka (tasainen ruutu)
const tiles = new Map(); // "z/x/y" → Promise<{ px, data } | null>, viimeksi käytetty viimeisenä
const sizes = new Map(); // "z/x/y" → purettu koko (tavua)
let cached = 0;
const cancelled = new Set(); // perutut maalaukset (MapLibre ei enää tarvitse ruutua)

// Viimeksi käytetyt luokkaruudut muistiin enintään CACHE_BYTES; vanhimmat pois.
function remember(key, p) {
  tiles.set(key, p);
  p.then((t) => {
    if (tiles.get(key) !== p || !t) return;
    sizes.set(key, t.data.length);
    cached += t.data.length;
    for (const old of tiles.keys()) {
      if (cached <= CACHE_BYTES || old === key) break;
      tiles.delete(old);
      cached -= sizes.get(old) ?? 0;
      sizes.delete(old);
    }
  });
}

function classTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let p = tiles.get(key);
  if (p) {
    tiles.delete(key);
    tiles.set(key, p);
    return p;
  }
  const entry = index.get(key);
  if (entry === undefined) return Promise.resolve(null);
  if (entry !== true) return Promise.resolve({ px: 1, data: Uint8Array.of(entry) });
  p = fetch(`${base}tiles/maanpeite/${z}/${x}/${y}.webp?v=${version}`)
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
  remember(key, p);
  return p;
}

// Tason z luokkaruudut, jotka kattavat Web Mercator -alueen; luokka pisteessä (0, jos ei tietoa).
async function classSampler(z, X0, Y0, X1, Y1) {
  const n = 2 ** z, got = new Map();
  const tx0 = Math.floor(X0 * n), tx1 = Math.floor(X1 * n - 1e-12), ty0 = Math.floor(Y0 * n), ty1 = Math.floor(Y1 * n - 1e-12);
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) jobs.push(classTile(z, tx, ty).then((t) => got.set(tx * 100000 + ty, t)));
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
    default: // ei tietoa (Espoon ulkopuolella): kartan taustaväri pelillisessä tilassa (app.js)
      k = 1;
      r = 111; g = 138; b = 90;
  }
  out[0] = Math.min(255, r * k);
  out[1] = Math.min(255, g * k);
  out[2] = Math.min(255, b * k);
  return out;
}

// Luokan keskiväri (tekstuurin keskiarvo) loitonnettuun kuvaan, jossa tekstuurin hienot kuviot
// sekoittuisivat kohinaksi.
const MEAN = Array.from({ length: 14 }, (_, c) => {
  const sum = [0, 0, 0];
  for (let i = 0; i < 4000; i++) {
    const [r, g, b] = shade(c, hash(i, c) * 997, hash(c, i) * 991);
    sum[0] += r; sum[1] += g; sum[2] += b;
  }
  return sum.map((v) => v / 4000);
});

// Luokkaruutujen tasot maalattavan tason mukaan tarkimmasta alkaen: lähellä (16–) tarkat ruudut,
// kauempana (14–15) välitaso, jolloin ruudun maalaukseen riittää yksi luokkaruutu, ja niiden
// ulkopuolella (Espoon ulkopuolella luokka 0) yleiskuva. Loitonnettaessa yleiskuvan tasot, joista
// tarkin kattaa ruudun enintään neljällä luokkaruudulla. Karkein taso on viimeisenä, sillä sen meri
// ulottuu laajimmalle.
function levelsFor(z) {
  const coarse = levels.filter((l) => !fine.includes(l));
  if (z >= LC_ZOOM) return [LC_ZOOM, ...coarse];
  if (z >= MID_ZOOM) return [MID_ZOOM, ...coarse];
  const i = coarse.findIndex((l) => l <= z + 1);
  return coarse.slice(i < 0 ? -1 : i);
}

// Ruudun pintakuva pakkaamattomana 24-bittisenä BMP:nä (PNG:n pakkaus olisi hidasta).
async function paintTile(z, x, y, id) {
  const n = 2 ** z, span = 1 / n, X0 = x / n, Y0 = y / n, S = TILE_PX;
  // Luokkarajojen epäsäännöllisyys (r) kasvaa yleiskuvan pikselin koon mukaan. Tarkoissa (0,3 m) ja
  // välitasolla, jota käytetään vain, kun sen pikseli (1,2 m) on enintään maalattavan kokoinen, se on 1.
  const samplers = await Promise.all(levelsFor(z).map(async (l) => ({
    at: await classSampler(l, X0, Y0, X0 + span, Y0 + span), r: fine.includes(l) ? 1 : Math.max(1, M / 2 ** l / 1024 / 0.3),
  })));
  if (cancelled.delete(id)) return null; // ruutua ei enää tarvita (karttaa siirretty)
  const pxM = (span * M) / S, outline = pxM < 0.7, flat = pxM > 3, d = 0.35 / M;
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
      let c = 0, e = 1;
      for (const { at, r } of samplers) {
        // Luokkarajat hieman epäsäännöllisiksi (käsin piirretty vaikutelma). Karkeassa luokkaruudussa
        // lisäksi pikselin kokoinen vaihtelu, jottei pikselien porrastus näy lähikuvassa.
        let jx = (vnoise((wx * 0.8) / r, (wy * 0.8) / r) - 0.5) * 0.5 * r;
        let jy = (vnoise((wx * 0.8) / r + 31.7, (wy * 0.8) / r) - 0.5) * 0.5 * r;
        if (r > 1) {
          jx += (vnoise((wx * 4) / r, (wy * 4) / r + 57.3) - 0.5) * 0.6 * r;
          jy += (vnoise((wx * 4) / r + 91.1, (wy * 4) / r) - 0.5) * 0.6 * r;
        }
        jx /= M;
        jy /= M;
        c = at(X + jx, Y + jy);
        if (!c) continue;
        // Luokkien rajoille tumma ääriviiva lähikuvassa.
        if (outline && (at(X + jx + d, Y + jy) !== c || at(X + jx, Y + jy + d) !== c)) e = 0.74;
        break;
      }
      let r, g, b;
      if (flat) { // keskiväri ja loiva vaihtelu
        const v = 0.96 + 0.08 * vnoise(wx / (pxM * 20), wy / (pxM * 20));
        [r, g, b] = MEAN[c];
        r *= v; g *= v; b *= v;
      } else {
        [r, g, b] = shade(c, wx, wy);
      }
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
  const r = radius / M, classAt = await classSampler(LC_ZOOM, cx - r, cy - r, cx + r, cy + r);
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
      const { tasot = {}, tasaiset = {}, tarkat = [] } = msg.info;
      for (const [l, xy] of Object.entries(tasot)) for (let i = 0; i < xy.length; i += 2) index.set(`${l}/${xy[i]}/${xy[i + 1]}`, true);
      for (const [l, xyc] of Object.entries(tasaiset)) for (let i = 0; i < xyc.length; i += 3) index.set(`${l}/${xyc[i]}/${xyc[i + 1]}`, xyc[i + 2]);
      levels = Object.keys(tasot).map(Number).sort((a, b) => b - a);
      fine = tarkat;
    } else if (msg.type === "cancel") {
      if (cancelled.size > 500) cancelled.clear(); // jo valmiiksi maalattujen perumiset
      cancelled.add(msg.cancel);
    } else if (msg.type === "tile") {
      const buffer = await paintTile(msg.z, msg.x, msg.y, msg.id);
      cancelled.delete(msg.id);
      if (!buffer) self.postMessage({ id: msg.id, error: "peruttu" });
      else self.postMessage({ id: msg.id, buffer }, [buffer]);
    } else if (msg.type === "trees") {
      const trees = await plantTrees(msg.x, msg.y, msg.radius);
      self.postMessage({ id: msg.id, trees }, [trees.buffer]);
    } else if (msg.type === "stats") {
      self.postMessage({ id: msg.id, luokkaruutuja: tiles.size, muisti_Mt: Math.round(cached / 1e5) / 10 });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err) });
  }
};
