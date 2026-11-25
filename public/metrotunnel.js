// Metrotunnelien sisäpuoli kyytinäkymää varten (transit.js). Kun metron kyydissä kamera on
// tunnelissa, kartan sijaan piirretään tunnelit, asemat ja metrot. Tunnelit seuraavat raiteita
// (rails.js): jokaisella raiteella on oma putki, jossa on lattia, seinät, holvikatto, kiskot ja
// seinävalot. Asemalla molemmat raiteet ovat samassa valoisassa hallissa, ja niiden välissä on
// laituri. Aseman paikka saadaan pysähtymispaikoista: vastakkaisiin suuntiin kulkevat junat
// pysähtyvät laiturin eri päihin, joten asema on eri raiteiden lähimpien pysähtymispaikkojen
// puolivälissä.
//
// Koordinaatit ovat paikallisia metrejä (x itään, y pohjoiseen, z ylös kiskon yläpinnasta).
// Värit ovat lineaarisia, ja valaistus on laskettu valmiiksi väreihin.

import { metroLines } from "./rails.js";

const PIECE = 24; // m: putken pätkän enimmäispituus suoralla (sumu lasketaan kärjissä)
const PIECE_NEAR = 3; // m: aseman lähellä, jotta putki päättyy hallin reunaan
const LIGHT_STEP = 30; // m: valot vuorotellen kummallakin seinällä
const RAIL = 0.72; // m: kiskon etäisyys raiteen keskeltä
const STOP_PAIR = 140; // m: eri raiteiden pysähtymispaikat tätä lähempänä ovat samaa asemaa
const HALL_HALF = 55; // m: asemahallin puolikas pituus
const HALL_SIDE = 3.2; // m: raiteen keskeltä hallin seinään
const HALL_WALL = 4.5, HALL_CROWN = 8.5; // m: hallin seinän ja holvin korkeus
const PLATFORM_HALF = 45;
const PLATFORM_Z = 1.1; // m: laiturin korkeus kiskon yläpinnasta
const PLATFORM_EDGE = 1.65; // m: raiteen keskeltä laiturin reunaan
const FLOOR = -0.2;

const lin = (hex) => [1, 3, 5].map((i) => {
  const c = parseInt(hex.slice(i, i + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const C = {
  floor: lin("#2f2d2a"), wall: lin("#6f7377"), cable: lin("#2a2e32"), vault: lin("#5f6468"),
  rail: lin("#c9ccd0"), railSide: lin("#5b5e61"), lamp: lin("#fff0c8"),
  hallWall: lin("#d6d8da"), stripe: lin("#ff6319"), hallVault: lin("#b5babf"), strip: lin("#ffffff"),
  platform: lin("#bdb8ae"), platformSide: lin("#6b6861"), safety: lin("#f2c100"),
};

// Putken poikkileikkaus kulkusuuntaan katsottuna vasemmalta oikealle ja takaisin holvia pitkin:
// [sivusiirtymä (m, oikealle), korkeus (m), seuraavan reunan väri].
const PROFILE = [
  [-2.9, FLOOR, C.floor], [2.9, FLOOR, C.wall], [2.9, 1.6, C.cable], [2.9, 1.9, C.wall], [2.9, 3.4, C.vault],
  [2.4, 4.6, C.vault], [1.4, 5.3, C.vault], [0, 5.6, C.vault], [-1.4, 5.3, C.vault], [-2.4, 4.6, C.vault],
  [-2.9, 3.4, C.wall], [-2.9, 1.9, C.cable], [-2.9, 1.6, C.wall], [-2.9, FLOOR, null],
];

class Builder {
  pos = []; col = [];

  // Nelikulmio, jonka etupuoli on kohti pistettä toward. shade: valaistus pinnan suunnan mukaan.
  quad(a, b, c, d, color, toward, shade = true) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    if (nx * (toward[0] - a[0]) + ny * (toward[1] - a[1]) + nz * (toward[2] - a[2]) < 0) {
      [b, d] = [d, b];
      nx = -nx; ny = -ny; nz = -nz;
    }
    // Lattia tummempi, holvi hieman; seinien sävy vaihtelee suunnan mukaan, jotta kaarteet erottuvat.
    const k = !shade ? 1 : nz > 0.6 ? 0.7 : nz < -0.3 ? 0.8 : 0.78 + 0.22 * Math.abs(nx * 0.6 + ny * 0.8);
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(color[0] * k, color[1] * k, color[2] * k);
    }
  }

  arrays() {
    return { pos: Float32Array.from(this.pos), col: Float32Array.from(this.col) };
  }
}

// Asemahallit: { x, y, ux, uy (raiteen suunta), nx, ny (vasemmalle), la, lb (raiteiden
// sivusiirtymät), lo, hi (hallin seinät) }.
function findStations(lines) {
  const stops = [];
  for (const pts of lines) {
    pts.forEach(([x, y, stop], i) => {
      if (!stop || stops.some((s) => Math.hypot(s.x - x, s.y - y) < 1)) return;
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      stops.push({ x, y, ux: (b[0] - a[0]) / l, uy: (b[1] - a[1]) / l });
    });
  }
  const nearest = stops.map((s) => {
    let best = null, bestD = STOP_PAIR;
    for (const t of stops) {
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      if (t !== s && d > 5 && d < bestD) { bestD = d; best = t; }
    }
    return best;
  });
  const halls = [];
  stops.forEach((s, i) => {
    const t = nearest[i];
    if (!t || nearest[stops.indexOf(t)] !== s || stops.indexOf(t) < i) return;
    const x = (s.x + t.x) / 2, y = (s.y + t.y) / 2, nx = -s.uy, ny = s.ux;
    const la = (s.x - x) * nx + (s.y - y) * ny, lb = (t.x - x) * nx + (t.y - y) * ny;
    halls.push({ x, y, ux: s.ux, uy: s.uy, nx, ny, la, lb, lo: Math.min(la, lb) - HALL_SIDE, hi: Math.max(la, lb) + HALL_SIDE });
  });
  return halls;
}

function inHall(h, x, y) {
  const along = (x - h.x) * h.ux + (y - h.y) * h.uy, lat = (x - h.x) * h.nx + (y - h.y) * h.ny;
  return Math.abs(along) < HALL_HALF && lat > h.lo && lat < h.hi;
}

// Putki yhden raiteen murtoviivaa pitkin. Kulmissa rengas on suuntien puolivälissä ja levenee,
// jotta putki pysyy yhtä leveänä. Asemahallin sisällä putken seiniä ei piirretä, vain kiskot.
function tube(pts, halls, walls, lights) {
  const rings = [];
  let dist = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = Math.hypot(bx - ax, by - ay);
    if (len < 0.01) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len, last = rings[rings.length - 1];
    if (last) {
      const mx = last.ux + ux, my = last.uy + uy, ml = Math.hypot(mx, my) || 1;
      last.ux = mx / ml;
      last.uy = my / ml;
      last.w = Math.min(2, 1 / Math.max(0.5, last.ux * ux + last.uy * uy));
    } else rings.push({ x: ax, y: ay, ux, uy, w: 1, d: 0 });
    for (let t = 0; t < len;) {
      const x = ax + ux * t, y = ay + uy * t;
      const step = halls.some((h) => Math.hypot(h.x - x, h.y - y) < HALL_HALF + 20) ? PIECE_NEAR : PIECE;
      t = len - t < step * 1.5 ? len : t + step;
      rings.push({ x: ax + ux * t, y: ay + uy * t, ux, uy, w: 1, d: dist + t });
    }
    dist += len;
  }
  // Renkaan piste: sivusiirtymä oikealle (kulkusuuntaan katsottuna) ja korkeus.
  const at = (r, u, z) => [r.x + r.uy * u * r.w, r.y - r.ux * u * r.w, z];
  for (let i = 1; i < rings.length; i++) {
    const r0 = rings[i - 1], r1 = rings[i], mx = (r0.x + r1.x) / 2, my = (r0.y + r1.y) / 2;
    for (const s of [-1, 1]) { // kiskot: yläpinta ja sisäkylki
      const u = s * RAIL;
      walls.quad(at(r0, u - 0.035, 0), at(r0, u + 0.035, 0), at(r1, u + 0.035, 0), at(r1, u - 0.035, 0), C.rail, [mx, my, 10], false);
      const ui = u - s * 0.035;
      walls.quad(at(r0, ui, -0.15), at(r0, ui, 0), at(r1, ui, 0), at(r1, ui, -0.15), C.railSide, [...at(r0, 0, 0).slice(0, 2), 0], false);
    }
    if (halls.some((h) => inHall(h, mx, my))) continue;
    const axis = [mx, my, 2.5];
    for (let j = 0; j < PROFILE.length - 1; j++) {
      const [u0, z0, color] = PROFILE[j], [u1, z1] = PROFILE[j + 1];
      walls.quad(at(r0, u0, z0), at(r0, u1, z1), at(r1, u1, z1), at(r1, u0, z0), color, axis);
    }
    // Seinävalo jokaisen LIGHT_STEP-välin kohdalla, vuorotellen oikealla ja vasemmalla.
    for (let d = Math.ceil(r0.d / LIGHT_STEP) * LIGHT_STEP; d < r1.d; d += LIGHT_STEP) {
      const f = (d - r0.d) / (r1.d - r0.d), side = Math.round(d / LIGHT_STEP) % 2 ? 1 : -1;
      const c = { x: r0.x + (r1.x - r0.x) * f, y: r0.y + (r1.y - r0.y) * f, ux: r1.ux, uy: r1.uy, w: 1 };
      const a = { ...c, x: c.x - c.ux * 0.5, y: c.y - c.uy * 0.5 }, b = { ...c, x: c.x + c.ux * 0.5, y: c.y + c.uy * 0.5 };
      const u = side * 2.84;
      lights.quad(at(a, u, 2.9), at(b, u, 2.9), at(b, u, 3.1), at(a, u, 3.1), C.lamp, [c.x, c.y, 2.5], false);
    }
  }
}

// Asemahalli: molemmat raiteet samassa holvissa, laituri niiden välissä ja valonauhat katossa.
function hall(h, walls, lights) {
  const at = (a, l, z) => [h.x + h.ux * a + h.nx * l, h.y + h.uy * a + h.ny * l, z];
  const mid = (h.lo + h.hi) / 2, half = (h.hi - h.lo) / 2;
  const vault = (l) => HALL_WALL + (HALL_CROWN - HALL_WALL) * Math.sqrt(Math.max(0, 1 - ((l - mid) / half) ** 2));
  // Poikkileikkaus: lattia, oikea seinä (raidasta), holvi ja vasen seinä.
  const prof = [[h.lo, FLOOR, C.floor], [h.hi, FLOOR, C.hallWall], [h.hi, 2.9, C.stripe], [h.hi, 3.3, C.hallWall]];
  for (let k = 0; k <= 10; k++) {
    const l = h.hi - ((h.hi - h.lo) * k) / 10;
    prof.push([l, vault(l), k < 10 ? C.hallVault : C.hallWall]);
  }
  prof.push([h.lo, 3.3, C.stripe], [h.lo, 2.9, C.hallWall], [h.lo, FLOOR, null]);
  const step = 10;
  for (let a = -HALL_HALF; a < HALL_HALF; a += step) {
    const toward = at(a + step / 2, mid, 3);
    for (let j = 0; j < prof.length - 1; j++) {
      const [l0, z0, color] = prof[j], [l1, z1] = prof[j + 1];
      walls.quad(at(a, l0, z0), at(a, l1, z1), at(a + step, l1, z1), at(a + step, l0, z0), color, toward);
    }
  }
  // Laituri: yläpinta turvaviivoineen, reunat raiteiden puolelle ja päädyt.
  const p0 = Math.min(h.la, h.lb) + PLATFORM_EDGE, p1 = Math.max(h.la, h.lb) - PLATFORM_EDGE, A = PLATFORM_HALF;
  const bands = [[p0, p0 + 0.35, C.platform], [p0 + 0.35, p0 + 0.5, C.safety], [p0 + 0.5, p1 - 0.5, C.platform], [p1 - 0.5, p1 - 0.35, C.safety], [p1 - 0.35, p1, C.platform]];
  for (const [l0, l1, color] of bands) walls.quad(at(-A, l0, PLATFORM_Z), at(-A, l1, PLATFORM_Z), at(A, l1, PLATFORM_Z), at(A, l0, PLATFORM_Z), color, at(0, (l0 + l1) / 2, 10));
  for (const [l, out] of [[p0, p0 - 5], [p1, p1 + 5]]) walls.quad(at(-A, l, FLOOR), at(A, l, FLOOR), at(A, l, PLATFORM_Z), at(-A, l, PLATFORM_Z), C.platformSide, at(0, out, 0.5));
  for (const [a, out] of [[-A, -A - 5], [A, A + 5]]) walls.quad(at(a, p0, FLOOR), at(a, p1, FLOOR), at(a, p1, PLATFORM_Z), at(a, p0, PLATFORM_Z), C.platformSide, at(out, (p0 + p1) / 2, 0.5));
  // Valonauhat laiturin reunojen yläpuolella.
  for (const l of [p0 + 1.2, p1 - 1.2]) {
    const z = vault(l) - 0.1;
    lights.quad(at(-HALL_HALF + 5, l - 0.25, z), at(-HALL_HALF + 5, l + 0.25, z), at(HALL_HALF - 5, l + 0.25, z), at(HALL_HALF - 5, l - 0.25, z), C.strip, at(0, l, 0), false);
  }
}

// Tunnelien ja asemien kolmiot: { walls, lights } (kumpikin { pos, col }), tai null, jos
// raiteita ei ole ladattu.
export function buildTunnelInterior() {
  const lines = metroLines();
  if (!lines.length) return null;
  const halls = findStations(lines), walls = new Builder(), lights = new Builder();
  for (const pts of lines) tube(pts, halls, walls, lights);
  for (const h of halls) hall(h, walls, lights);
  return { walls: walls.arrays(), lights: lights.arrays() };
}
