// Joukkoliikenne reaaliajassa. Bussien, raitiovaunujen, lähijunien ja metron sijainnit tulevat
// HSL:n avoimesta HFP-syötteestä, kauko- ja tavarajunien sijainnit Digitrafficista. Ajoneuvot
// piirretään 3D-malleina MapLibren omalle tasolle three.js:llä, ja niiden liike lasketaan
// tasaiseksi vastaanotettujen sijaintien välillä.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import mqtt from "https://unpkg.com/mqtt@5.10.1/dist/mqtt.esm.js";
import { deckHeightAt, rawElevationAt } from "./bridges.js";
import { METRO, RAIL, TRAM, loadRails, metroLines, nextStop, pathBehind, signFor, snap, walk } from "./rails.js";

const HFP_URL = "wss://mqtt.hsl.fi:443/";
const RAIL_MQTT_URL = "wss://rata.digitraffic.fi:443/mqtt";
const RAIL_API = "https://rata.digitraffic.fi/api/v1";

// Ajoneuvot näytetään hieman todellista sijaintia jäljessä, jotta liike voidaan laskea tunnettujen
// sijaintien väliltä eikä reitti muutu, kun uusi sijainti saapuu. HSL lähettää sijainnin
// sekunnin, Digitraffic 2–5 sekunnin välein.
const HFP_DELAY = 2300;
const RAIL_DELAY = 9000;
const MAX_EXTRAPOLATE = 2500; // ms: jos seuraava sijainti viipyy, jatketaan entiseen suuntaan
const SMOOTH_MS = 160; // viimeisen pehmennyksen aikavakio
const HFP_TIMEOUT = 30000;
const RAIL_TIMEOUT = 120000; // raiteilla kulkevia jatketaan katkoksen yli, joten ne pidetään pidempään
const DEADRECKON_MAX = 90000; // ms: näin kauan raiteilla kulkevaa jatketaan ilman uutta sijaintia
const BRAKE = 0.8; // m/s²: jarrutus asemalle
const UNIT_STALE = 15000; // ms: kytketyn yksikön sijainti vanhenee
const REGION_MARGIN = 300; // m: ajoneuvot näkyvät vielä näin kaukana Espoon rajan takana
const MODEL_MINZOOM = 12.5; // tätä kauempaa ajoneuvot näytetään vain pisteinä
const MAX_ENLARGE = 2; // mallit näytetään kaukaa suurennettuina, jotta ne erottuvat
const LIFT = 0.15; // m maanpinnan yläpuolella
// Länsimetron raiteet ovat kallion sisällä noin 10–30 metriä merenpinnan alapuolella. Metro
// ja tunnelit piirretään yhdelle tasolle maanpinnan muodoista riippumatta.
const METRO_TUNNEL_Z = -15; // m (N2000)
const METRO_DELAY = 7000; // metron sijainti päivittyy noin 50 metrin askelin 2,5–3 s välein
const DOT_MAXZOOM = 14.8; // tätä lähempää ajoneuvot näytetään vain malleina
const ELEV_SMOOTH_MS = 250; // korkeuden muutosten pehmennys

export const TRANSIT_GROUPS = [
  ["bussit", "Bussit", "#007ac9"],
  ["ratikat", "Raitiovaunut", "#00985f"],
  ["junat", "Junat", "#8c4799"],
  ["metro", "Metro", "#ff6319"],
];

const COLORS = {
  bus: "#007ac9", tram: "#00985f", train: "#8c4799", train2: "#8c4799", train3: "#8c4799", metro: "#ff6319",
  intercity: "#3e9b3a", freight: "#b5462e", locomotive: "#b5462e",
};

// Vaunut keulasta taaksepäin: [malli, pituus (m), käännetty]. Takimmainen ohjaamovaunu on
// sama malli käännettynä, joten molemmissa päissä on keula. height on katon korkeus (m),
// jonka yläpuolelle linjanumero sijoitetaan. rail kertoo raideverkon (rails.js), ja stops,
// pysähtyykö ajoneuvo yleensä jokaisella asemalla tai pysäkillä.
const KINDS = {
  bus: { group: "bussit", label: "Bussi", cars: [["bus", 12]], gap: 0, height: 3.3 },
  tram: {
    group: "ratikat", label: "Raitiovaunu", gap: 0.5, height: 3.7, rail: TRAM, stops: true,
    cars: [["tramCab", 12.2], ["tramMid", 9.4], ["tramCab", 12.2, true]],
  },
  train: {
    group: "junat", label: "Lähijuna", gap: 0.6, height: 4.4, rail: RAIL, stops: true,
    cars: [["flirtCab", 19.6], ["flirtMid", 17.2], ["flirtMid", 17.2], ["flirtCab", 19.6, true]],
  },
  metro: {
    group: "metro", label: "Metro", gap: 0.6, height: 3.6, underground: true, delay: METRO_DELAY, rail: METRO, stops: true,
    cars: [["metroCab", 22.6], ["metroMid", 21.8], ["metroMid", 21.8], ["metroCab", 22.6, true]],
  },
  intercity: { group: "junat", label: "Kaukojuna", cars: [["loco", 19.6], ...Array(6).fill(["coach", 26.4])], gap: 0.8, height: 5.0, rail: RAIL },
  freight: {
    group: "junat", label: "Tavarajuna", gap: 0.9, height: 4.3, rail: RAIL,
    cars: [["cargoLoco", 19.6], ...Array.from({ length: 12 }, (_, i) => (i % 3 === 1 ? ["tankWagon", 14] : ["boxWagon", 15.5]))],
  },
  locomotive: { group: "junat", label: "Veturi", cars: [["cargoLoco", 19.6]], gap: 0, height: 4.3, rail: RAIL },
};
// Lähijunassa voi olla kaksi tai kolme yksikköä kytkettynä toisiinsa (ohjaamot vastakkain).
for (const n of [2, 3]) KINDS[`train${n}`] = { ...KINDS.train, cars: Array.from({ length: n }, () => KINDS.train.cars).flat() };
for (const k of Object.values(KINDS)) {
  // Kunkin vaunun keulan ja perän etäisyys ajoneuvon keulasta.
  k.ds = [];
  let d = 0;
  for (const [, len] of k.cars) { k.ds.push(d, d + len); d += len + k.gap; }
  k.length = d - k.gap;
}

const HFP_KINDS = { bus: "bus", ubus: "bus", robot: "bus", tram: "tram", train: "train", metro: "metro" };
// HSL:n lähijunat tulevat HFP-syötteestä, joten Digitrafficista otetaan vain muut junat.
const RAIL_KINDS = { "Long-distance": "intercity", Cargo: "freight", Locomotive: "locomotive" };

// ------------------------------------------------------------ koordinaatit

const D2R = Math.PI / 180;
const EARTH_CIRC = 40075016.686;
// Paikallinen metrikoordinaatisto Espoon keskellä; vääristymä koko Espoon alueella alle 1 %.
const ORIGIN_LON = 24.7, ORIGIN_LAT = 60.2;
const M_LON = 55462, M_LAT = 111415;
const toLocal = (lon, lat) => [(lon - ORIGIN_LON) * M_LON, (lat - ORIGIN_LAT) * M_LAT];
const lonOf = (x) => ORIGIN_LON + x / M_LON;
const latOf = (y) => ORIGIN_LAT + y / M_LAT;
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;

// Rantaradan yleissuunta Espoossa. Digitraffic ei kerro junan suuntaa, joten sitä käytetään,
// kunnes juna on liikkunut sen verran, että suunta selviää.
const RAIL_DEFAULT_DIR = [Math.sin(74 * D2R), Math.cos(74 * D2R)];

// ------------------------------------------------------------ 3D-mallit

const col = (hex) => new THREE.Color(hex); // muuntaa sRGB-värin lineaariseksi
const P = {
  glass: col("#1d2731"), dark: col("#2b2f33"), tire: col("#161616"), roof: col("#c3c9ce"),
  gear: col("#8e969d"), light: col("#fff4c2"), red: col("#c62828"), sign: col("#ffb21a"),
  white: col("#f1f2ef"), bellows: col("#3a3d40"),
};

// Kolmioverkko suorakulmaisista ja viistetyistä kappaleista. Jokaisen kolmion normaali
// käännetään osoittamaan kappaleen keskipisteestä poispäin, joten kulmien kiertosuunnalla
// ei ole väliä.
class Shape {
  pos = []; nor = []; col = [];

  tri(a, b, c, color, center) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    const mx = (a[0] + b[0] + c[0]) / 3 - center[0], my = (a[1] + b[1] + c[1]) / 3 - center[1], mz = (a[2] + b[2] + c[2]) / 3 - center[2];
    if (nx * mx + ny * my + nz * mz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(color.r, color.g, color.b);
    }
  }

  // Kahdeksan kulmaa: ensin pohjan neljä kulmaa kiertojärjestyksessä, sitten kannen samat kulmat.
  hexa(pts, color) {
    const center = [0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i], 0) / 8);
    for (const [a, b, c, d] of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      this.tri(pts[a], pts[b], pts[c], color, center);
      this.tri(pts[a], pts[c], pts[d], color, center);
    }
  }

  box(x0, x1, y0, y1, z0, z1, color) {
    this.hexa([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], color);
  }

  // Poikkileikkaukseltaan suorakulmainen tanko pisteestä a pisteeseen b (y–z-tasossa).
  bar(a, b, width, thick, color) {
    const dy = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dy, dz);
    const ny = (-dz / len) * thick / 2, nz = (dy / len) * thick / 2, w = width / 2;
    const end = ([y, z]) => [[-w, y - ny, z - nz], [w, y - ny, z - nz], [w, y + ny, z + nz], [-w, y + ny, z + nz]];
    this.hexa([...end(a), ...end(b)], color);
  }

  // Sylinteri x- tai y-akselin suuntaan (pyörät ja säiliöt).
  cyl(axis, cx, cy, cz, r, len, color, n = 12) {
    const center = [cx, cy, cz];
    const at = (i, side) => {
      const a = (i / n) * Math.PI * 2, u = r * Math.cos(a), v = cz + r * Math.sin(a);
      return axis === "x" ? [cx + side * len / 2, cy + u, v] : [cx + u, cy + side * len / 2, v];
    };
    const cap = (side) => (axis === "x" ? [cx + side * len / 2, cy, cz] : [cx, cy + side * len / 2, cz]);
    for (let i = 0; i < n; i++) {
      const a0 = at(i, -1), a1 = at(i + 1, -1), b0 = at(i, 1), b1 = at(i + 1, 1);
      this.tri(a0, a1, b1, color, center);
      this.tri(a0, b1, b0, color, center);
      this.tri(cap(-1), a0, a1, color, center);
      this.tri(cap(1), b0, b1, color, center);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

// Mallit: x poikittain, y pituussuunnassa (keula +y), z ylöspäin, origo pohjan keskellä.

function busModel() {
  const s = new Shape(), body = col(COLORS.bus), hl = 6, hw = 1.275;
  s.box(-hw, hw, -hl, hl, 0.3, 1.05, body);
  s.box(-hw + 0.03, hw - 0.03, -hl + 0.04, hl - 0.04, 1.05, 2.62, P.glass);
  for (let y = -hl + 0.9; y < hl - 1.6; y += 1.5) s.box(-hw, hw, y, y + 0.16, 1.05, 2.62, body);
  s.box(-hw, hw, -hl, hl, 2.62, 2.98, body);
  s.box(-0.85, 0.85, -2.2, 2.0, 2.98, 3.28, P.gear); // ilmastointi ja akut
  s.box(-hw + 0.05, hw - 0.05, hl - 0.04, hl + 0.03, 0.8, 2.55, P.glass); // tuulilasi
  s.box(-0.95, 0.95, hl - 0.02, hl + 0.05, 2.62, 2.9, P.sign); // linjakilpi
  s.box(-0.55, 0.55, -hl - 0.05, -hl + 0.02, 2.62, 2.88, P.sign);
  for (const sx of [-1, 1]) {
    s.box(sx * (hw - 0.55), sx * (hw - 0.12), hl - 0.02, hl + 0.05, 0.42, 0.62, P.light);
    s.box(sx * (hw - 0.45), sx * (hw - 0.12), -hl - 0.05, -hl + 0.02, 0.45, 0.85, P.red);
    for (const y of [hl - 2.7, -hl + 3.0]) s.cyl("x", sx * (hw - 0.13), y, 0.5, 0.5, 0.3, P.tire);
  }
  return s.geometry();
}

// Kiskoajoneuvon keula: kapeneva alaosa, viisto tuulilasi ja ohjaamon katto.
function cabNose(s, { hw, front, tip, z0, zGlass, zTop, zRoof, body, upper = body }) {
  const t = 0.35;
  const ring = (y0, y1, za, inset) => [[-hw, y0, za], [hw, y0, za], [hw - inset, y1, za], [-hw + inset, y1, za]];
  s.hexa([...ring(front, tip, z0, t), ...ring(front, tip, zGlass, t)], body);
  s.hexa([...ring(front, tip, zGlass, t), ...ring(front, tip - 0.5, zTop, t + 0.05)], P.glass);
  s.hexa([...ring(front, tip - 0.5, zTop, t + 0.05), ...ring(front, tip - 0.8, zRoof, t + 0.12)], upper);
  s.box(-0.7, 0.7, tip - 0.62, tip - 0.46, zTop + 0.05, zTop + 0.3, P.sign);
  for (const sx of [-1, 1]) s.box(sx * (hw - 0.75), sx * (hw - 0.45), tip - 0.02, tip + 0.03, z0 + 0.25, z0 + 0.42, P.light);
}

function pantograph(s, zBase) {
  s.box(-0.6, 0.6, -1.0, 1.0, zBase, zBase + 0.18, P.gear);
  s.bar([-0.7, zBase + 0.18], [0.5, zBase + 1.1], 0.9, 0.07, P.dark);
  s.bar([0.5, zBase + 1.1], [-0.3, zBase + 1.95], 0.1, 0.07, P.dark);
  s.box(-0.85, 0.85, -0.38, -0.22, zBase + 1.92, zBase + 2.02, P.dark);
}

function bogies(s, hl, inset, width, height = 0.4) {
  for (const y of [hl - inset, -hl + inset]) s.box(-width / 2, width / 2, y - 1.1, y + 1.1, 0.02, height, P.dark);
}

function bellows(s, y0, y1, w, z1) {
  s.box(-w / 2, w / 2, Math.min(y0, y1), Math.max(y0, y1), 0.4, z1, P.bellows);
}

function tramCar(cab) {
  const s = new Shape(), body = col(COLORS.tram), L = cab ? 12.2 : 9.4, hl = L / 2, hw = 1.2;
  const front = cab ? hl - 1.0 : hl;
  s.box(-hw, hw, -hl, front, 0.32, 1.0, body);
  s.box(-hw + 0.03, hw - 0.03, -hl, front, 1.0, 2.5, P.glass);
  for (let y = -hl + 0.7; y < front - 0.4; y += 1.35) s.box(-hw, hw, y, y + 0.18, 1.0, 2.5, body);
  s.box(-hw, hw, -hl, front, 2.5, 3.25, body);
  s.box(-hw + 0.05, hw - 0.05, -hl, front, 3.25, 3.36, P.roof);
  if (cab) {
    cabNose(s, { hw, front, tip: hl, z0: 0.32, zGlass: 1.0, zTop: 2.5, zRoof: 3.25, body });
    s.box(-0.8, 0.8, -hl + 1, -hl + 4, 3.36, 3.7, P.gear);
  } else {
    pantograph(s, 3.36);
    bellows(s, hl, hl + 0.28, 2.0, 3.0);
  }
  bellows(s, -hl, -hl - 0.28, 2.0, 3.0);
  bogies(s, hl, 2.2, 2.0, 0.32);
  return s.geometry();
}

function flirtCar(cab) {
  const s = new Shape(), accent = col(COLORS.train), L = cab ? 19.6 : 17.2, hl = L / 2, hw = 1.6;
  const front = cab ? hl - 2.2 : hl;
  s.box(-hw, hw, -hl, front, 0.45, 0.8, accent);
  s.box(-hw, hw, -hl, front, 0.8, 1.35, P.white);
  s.box(-hw + 0.03, hw - 0.03, -hl, front, 1.35, 2.45, P.glass);
  for (let y = -hl + 1.0; y < front - 0.5; y += 2.4) s.box(-hw, hw, y, y + 0.22, 1.35, 2.45, P.white);
  s.box(-hw, hw, -hl, front, 2.45, 3.75, P.white);
  s.box(-hw + 0.1, hw - 0.1, -hl, front, 3.75, 3.95, P.roof);
  for (const y of [-hl + 3.4, front - 3.4]) s.box(-hw - 0.02, hw + 0.02, y - 0.65, y + 0.65, 0.5, 2.6, accent); // ovet
  if (cab) {
    cabNose(s, { hw, front, tip: hl, z0: 0.45, zGlass: 1.35, zTop: 2.6, zRoof: 3.75, body: accent, upper: P.white });
    s.box(-0.9, 0.9, -hl + 2, -hl + 6, 3.95, 4.35, P.gear);
  } else {
    pantograph(s, 3.95);
    bellows(s, hl, hl + 0.33, 2.4, 3.5);
  }
  bellows(s, -hl, -hl - 0.33, 2.4, 3.5);
  bogies(s, hl, 2.6, 2.4, 0.45);
  return s.geometry();
}

function metroCar(cab) {
  const s = new Shape(), body = col(COLORS.metro), L = cab ? 22.6 : 21.8, hl = L / 2, hw = 1.6;
  const front = cab ? hl - 1.4 : hl;
  s.box(-hw, hw, -hl, front, 0.45, 1.3, body);
  s.box(-hw + 0.03, hw - 0.03, -hl, front, 1.3, 2.4, P.glass);
  s.box(-hw, hw, -hl, front, 2.4, 3.45, body);
  s.box(-hw + 0.1, hw - 0.1, -hl, front, 3.45, 3.62, P.roof);
  for (const y of [-hl + 4, (front - hl) / 2, front - 4]) s.box(-hw - 0.02, hw + 0.02, y - 0.7, y + 0.7, 0.5, 2.45, col("#d9531a"));
  if (cab) cabNose(s, { hw, front, tip: hl, z0: 0.45, zGlass: 1.3, zTop: 2.4, zRoof: 3.45, body });
  else bellows(s, hl, hl + 0.33, 2.4, 3.3);
  bellows(s, -hl, -hl - 0.33, 2.4, 3.3);
  bogies(s, hl, 2.8, 2.4, 0.45);
  return s.geometry();
}

function locoModel(accentHex, bodyHex) {
  const s = new Shape(), accent = col(accentHex), body = col(bodyHex), hl = 9.8, hw = 1.55;
  const front = hl - 1.6;
  s.box(-hw, hw, -front, front, 0.6, 1.5, accent);
  s.box(-hw, hw, -front, front, 1.5, 3.9, body);
  for (const y of [-4.5, -1.5, 1.5, 4.5]) s.box(-hw - 0.02, hw + 0.02, y - 1.0, y + 1.0, 2.4, 3.4, P.dark); // säleiköt
  s.box(-hw + 0.15, hw - 0.15, -front, front, 3.9, 4.15, P.roof);
  for (const dir of [1, -1]) {
    // Ohjaamo kummassakin päässä: rakennetaan +y-suuntaan ja peilataan tarvittaessa.
    const n = new Shape();
    cabNose(n, { hw, front, tip: hl, z0: 0.6, zGlass: 1.6, zTop: 2.7, zRoof: 3.9, body: accent, upper: body });
    // Peilaus kääntää kolmioiden kiertosuunnan, joten kärkien järjestys vaihdetaan.
    const order = dir === 1 ? [0, 1, 2] : [0, 2, 1];
    for (let t = 0; t < n.pos.length; t += 9) {
      for (const v of order) {
        const i = t + v * 3;
        s.pos.push(n.pos[i], dir * n.pos[i + 1], n.pos[i + 2]);
        s.nor.push(n.nor[i], dir * n.nor[i + 1], n.nor[i + 2]);
        s.col.push(n.col[i], n.col[i + 1], n.col[i + 2]);
      }
    }
  }
  pantograph(s, 4.15);
  bogies(s, hl, 3.6, 2.4, 0.6);
  return s.geometry();
}

function coachModel() {
  const s = new Shape(), green = col(COLORS.intercity), hl = 13.2, hw = 1.45;
  s.box(-hw, hw, -hl, hl, 0.35, 0.9, green);
  s.box(-hw, hw, -hl, hl, 0.9, 1.1, P.white);
  s.box(-hw + 0.03, hw - 0.03, -hl, hl, 1.1, 2.0, P.glass);
  s.box(-hw, hw, -hl, hl, 2.0, 2.6, P.white);
  s.box(-hw + 0.03, hw - 0.03, -hl, hl, 2.6, 3.6, P.glass);
  for (let y = -hl + 1.2; y < hl - 1; y += 2.0) {
    s.box(-hw, hw, y, y + 0.2, 1.1, 2.0, P.white);
    s.box(-hw, hw, y, y + 0.2, 2.6, 3.6, P.white);
  }
  s.box(-hw, hw, -hl, hl, 3.6, 4.6, P.white);
  s.hexa([[-hw, -hl, 4.6], [hw, -hl, 4.6], [hw, hl, 4.6], [-hw, hl, 4.6],
    [-hw + 0.5, -hl, 4.95], [hw - 0.5, -hl, 4.95], [hw - 0.5, hl, 4.95], [-hw + 0.5, hl, 4.95]], P.roof);
  for (const y of [-hl + 2.2, hl - 2.2]) s.box(-hw - 0.02, hw + 0.02, y - 0.6, y + 0.6, 0.4, 2.2, green); // ovet
  bellows(s, hl, hl + 0.45, 2.2, 4.2);
  bellows(s, -hl, -hl - 0.45, 2.2, 4.2);
  bogies(s, hl, 2.6, 2.4, 0.4);
  return s.geometry();
}

function boxWagonModel() {
  const s = new Shape(), brown = col("#7b4a32"), hl = 7.75, hw = 1.5;
  s.box(-hw + 0.1, hw - 0.1, -hl, hl, 0.75, 1.0, P.dark);
  s.box(-hw, hw, -hl + 0.3, hl - 0.3, 1.0, 3.9, brown);
  s.hexa([[-hw, -hl + 0.3, 3.9], [hw, -hl + 0.3, 3.9], [hw, hl - 0.3, 3.9], [-hw, hl - 0.3, 3.9],
    [-hw + 0.6, -hl + 0.3, 4.25], [hw - 0.6, -hl + 0.3, 4.25], [hw - 0.6, hl - 0.3, 4.25], [-hw + 0.6, hl - 0.3, 4.25]], col("#8a8f94"));
  for (const y of [-2.4, 2.4]) s.box(-hw - 0.02, hw + 0.02, y - 1.1, y + 1.1, 1.1, 3.7, col("#6a3e2a")); // liukuovet
  bogies(s, hl, 1.8, 2.2, 0.75);
  return s.geometry();
}

function tankWagonModel() {
  const s = new Shape(), tank = col("#5d646b"), hl = 7;
  s.box(-1.3, 1.3, -hl, hl, 0.75, 1.05, P.dark);
  s.cyl("y", 0, 0, 2.45, 1.4, 12.6, tank, 16);
  s.cyl("y", 0, 0, 3.9, 0.35, 0.8, P.dark, 10); // täyttöaukko
  bogies(s, hl, 1.8, 2.2, 0.75);
  return s.geometry();
}

// Mallin ja instanssien enimmäismäärä (koko Espoossa kulkee kerralla noin 300 bussia).
const MODELS = {
  bus: [busModel, 1500], tramCab: [() => tramCar(true), 200], tramMid: [() => tramCar(false), 100],
  flirtCab: [() => flirtCar(true), 200], flirtMid: [() => flirtCar(false), 200],
  metroCab: [() => metroCar(true), 100], metroMid: [() => metroCar(false), 100],
  loco: [() => locoModel(COLORS.intercity, "#f1f2ef"), 60], coach: [coachModel, 360],
  cargoLoco: [() => locoModel(COLORS.freight, "#e8e4da"), 60],
  boxWagon: [boxWagonModel, 600], tankWagon: [tankWagonModel, 300],
};

// ------------------------------------------------------------ Espoon raja

let region = null;

async function loadRegion(url) {
  const gj = await fetch(url).then((r) => r.json());
  const polys = [];
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of gj.features) {
    const g = f.geometry;
    for (const poly of g.type === "Polygon" ? [g.coordinates] : g.coordinates) {
      polys.push(poly.map((ring) => ring.map(([lon, lat]) => {
        const p = toLocal(lon, lat);
        box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])];
        return p;
      })));
    }
  }
  box = [box[0] - REGION_MARGIN, box[1] - REGION_MARGIN, box[2] + REGION_MARGIN, box[3] + REGION_MARGIN];
  // HFP-syötteen 0,1 asteen ruudut, jotka osuvat alueelle.
  const cells = [];
  for (let la = 0; la <= 9; la++) {
    for (let lo = 0; lo <= 9; lo++) {
      const [x0, y0] = toLocal(24 + lo / 10, 60 + la / 10), [x1, y1] = toLocal(24 + (lo + 1) / 10, 60 + (la + 1) / 10);
      if (x1 > box[0] && x0 < box[2] && y1 > box[1] && y0 < box[3]) cells.push(`${la}${lo}`);
    }
  }
  region = { polys, box, cells };
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearRing(x, y, ring, d2) {
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if ((ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2 < d2) return true;
  }
  return false;
}

function inBox(x, y) {
  const b = region.box;
  return x > b[0] && x < b[2] && y > b[1] && y < b[3];
}

function inRegion(x, y) {
  if (!inBox(x, y)) return false;
  // Monikulmion reiät (Kauniainen Espoon sisällä) käsitellään parillisuussäännöllä.
  if (region.polys.some((poly) => poly.reduce((acc, ring) => acc !== inRing(x, y, ring), false))) return true;
  return region.polys.some((poly) => poly.some((ring) => nearRing(x, y, ring, REGION_MARGIN ** 2)));
}

// ------------------------------------------------------------ liikkeen tasoitus

class Clock {
  constructor(delay) { this.delay = delay; this.offset = 0; this.n = 0; }
  // Ajoneuvojen kello ja selaimen kello eivät ole samassa ajassa, joten ero arvioidaan kaikista
  // viesteistä. Arvio muuttuu hitaasti: nopea muutos siirtäisi kaikkia ajoneuvoja nykäyksellä.
  seen(t) {
    const a = this.n < 100 ? 1 / ++this.n : 0.002;
    this.offset += a * (Date.now() - t - this.offset);
  }
  renderTime(wall, delay = this.delay) { return wall - this.offset - delay; }
}

const hfpClock = new Clock(HFP_DELAY);
const railClock = new Clock(RAIL_DELAY);

const vehicles = new Map();
let vehicleSeq = 0;

function newVehicle(id, kind, clock) {
  return {
    id, kind, clock, num: ++vehicleSeq, samples: [], trail: [], x: null, y: null,
    dir: null, guessed: true, seedAt: null, info: {}, lastRx: Date.now(), outAt: null,
    elev: null, elevShown: null, elevAt: 0, screen: null, drawnAt: 0, cell: null,
    delay: KINDS[kind].delay ?? clock.delay, headElev: null, headElevAt: 0, dot: null,
    way: -1, pos: null, heading: null, units: null, lead: null, headShift: 0,
  };
}

function addSample(v, s, inside) {
  const S = v.samples, last = S[S.length - 1], rail = KINDS[v.kind].rail;
  v.lastRx = Date.now();
  if (rail != null) {
    // Sijainti raiteelle; raidekohta tarvitaan, jos liikettä pitää jatkaa ilman uutta sijaintia.
    const p = snap(s.x, s.y, rail, v.way);
    if (p) { s.x = p.x; s.y = p.y; s.pos = p; v.way = p.way; }
  }
  if (last) {
    if (s.t <= last.t) return; // kaksoiskappale tai myöhässä saapunut viesti
    const d = Math.hypot(s.x - last.x, s.y - last.y);
    // Liikkuva ajoneuvo samassa paikassa: sijainti ei ole päivittynyt (metro toistaa edellistä
    // sijaintia, kunnes juna on edennyt seuraavaan kohtaan), joten viesti ohitetaan.
    if (d < 0.5 && s.spd > 1) return;
    if (d > 500 && s.t - last.t < 20000) S.length = 0; // sijainti hyppäsi: aloitetaan alusta
    else if (d < 2.5 && s.spd < 0.8) { s.x = last.x; s.y = last.y; } // paikallaan: GPS-kohina pois
  }
  if (inside) v.outAt = null;
  else if (v.outAt == null) v.outAt = s.t;
  S.push(s);
  if (S.length > 6) S.shift();
}

function slope(S, i, k) {
  return (S[i + 1][k] - S[i][k]) / (S[i + 1].t - S[i].t);
}

// Monotoninen kuutiollinen interpolaatio (Fritsch–Butland) akseleittain: liike on pehmeää,
// mutta ajoneuvo ei heilahda pysähtyessään pysäkin ohi ja takaisin.
function tangent(S, i, k) {
  if (i === 0) return slope(S, 0, k);
  if (i === S.length - 1) return slope(S, i - 1, k);
  const d0 = slope(S, i - 1, k), d1 = slope(S, i, k);
  return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
}

function hermite(S, i, k, u, h) {
  const p0 = S[i][k], p1 = S[i + 1][k], m0 = tangent(S, i, k) * h, m1 = tangent(S, i + 1, k) * h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
}

function targetAt(S, tr) {
  const n = S.length, last = S[n - 1];
  if (n === 1 || tr <= S[0].t) return [S[0].x, S[0].y];
  if (tr >= last.t) {
    const prev = S[n - 2], h = last.t - prev.t, e = Math.min(tr - last.t, MAX_EXTRAPOLATE);
    return [last.x + ((last.x - prev.x) / h) * e, last.y + ((last.y - prev.y) / h) * e];
  }
  let i = n - 2;
  while (S[i].t > tr) i--;
  const h = S[i + 1].t - S[i].t, u = (tr - S[i].t) / h;
  return [hermite(S, i, "x", u, h), hermite(S, i, "y", u, h)];
}

// Vaunut seuraavat keulan kulkemaa reittiä, joten pitkät junat ja nivelraitiovaunut
// kaartavat kuten oikeat.
function seedTrail(v, [ux, uy]) {
  const back = KINDS[v.kind].length * MAX_ENLARGE + 30;
  // Raiteella reitti aloitetaan raidetta pitkin, joten vaunut ovat heti raiteilla myös kaarteissa.
  v.trail = v.pos ? pathBehind(v.pos.e, v.pos.u, signFor(v.pos.e, ux, uy), back)
    : [[v.x - ux * back, v.y - uy * back], [v.x, v.y]];
  v.seedAt = [v.x, v.y];
}

function updateTrail(v) {
  const T = v.trail;
  if (T.length === 0) { seedTrail(v, v.dir ?? [0, 1]); return; }
  const last = T[T.length - 1], dx = v.x - last[0], dy = v.y - last[1], d = Math.hypot(dx, dy);
  if (d < 1) return;
  const prev = T[T.length - 2], px = last[0] - prev[0], py = last[1] - prev[1], pd = Math.hypot(px, py);
  if (pd > 0.5 && (dx * px + dy * py) / (d * pd) < -0.6) { seedTrail(v, [dx / d, dy / d]); return; } // suunta vaihtui
  if (v.guessed) {
    // Suunta oli arvaus: kun ajoneuvo on liikkunut tarpeeksi, reitti aloitetaan oikeasta suunnasta.
    const sx = v.x - v.seedAt[0], sy = v.y - v.seedAt[1], sd = Math.hypot(sx, sy);
    if (sd > 25) { v.guessed = false; seedTrail(v, [sx / sd, sy / sd]); }
    return;
  }
  T.push([v.x, v.y]);
  if (T.length % 32 === 0) {
    const need = KINDS[v.kind].length * MAX_ENLARGE + 30;
    let acc = 0;
    for (let i = T.length - 1; i > 0; i--) {
      acc += Math.hypot(T[i][0] - T[i - 1][0], T[i][1] - T[i - 1][1]);
      if (acc > need) { T.splice(0, i - 1); break; }
    }
  }
}

// Pisteet reitiltä annetuilla etäisyyksillä keulasta (etäisyydet kasvavassa järjestyksessä).
function walkTrail(v, ds, scale, out) {
  const T = v.trail;
  let ax = v.x, ay = v.y, acc = 0, j = T.length - 1, k = 0;
  let ux = 0, uy = -1;
  if (T.length >= 2) {
    const a = T[T.length - 1], b = T[0], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    ux = (b[0] - a[0]) / d; uy = (b[1] - a[1]) / d;
  }
  while (k < ds.length) {
    const want = ds[k] * scale;
    if (j < 0) { // reitti loppui: jatketaan suoraan
      out[2 * k] = ax + ux * (want - acc); out[2 * k + 1] = ay + uy * (want - acc); k++;
      continue;
    }
    const bx = T[j][0], by = T[j][1], seg = Math.hypot(bx - ax, by - ay);
    if (acc + seg >= want) {
      const f = seg > 1e-6 ? (want - acc) / seg : 0;
      out[2 * k] = ax + (bx - ax) * f; out[2 * k + 1] = ay + (by - ay) * f; k++;
    } else {
      if (seg > 1e-6) { ux = (bx - ax) / seg; uy = (by - ay) / seg; }
      acc += seg; ax = bx; ay = by; j--;
    }
  }
}

function advance(v, wall, k) {
  const tr = v.clock.renderTime(wall, v.delay);
  if (v.outAt != null && tr >= v.outAt) { removeVehicle(v); return; } // ajoi Espoon ulkopuolelle
  if (!v.samples.length) return;
  const rail = KINDS[v.kind].rail;
  let [tx, ty] = rail != null ? railTarget(v, tr) : targetAt(v.samples, tr);
  if (v.x == null || Math.hypot(tx - v.x, ty - v.y) > 150) {
    v.x = tx; v.y = ty; v.trail = [];
  } else {
    if (rail != null && !mayMove(v, tx, ty)) { tx = v.x; ty = v.y; }
    v.x += (tx - v.x) * k; v.y += (ty - v.y) * k;
  }
  if (rail != null) {
    const p = snap(v.x, v.y, rail, v.way);
    if (p) { v.x = p.x; v.y = p.y; v.pos = p; v.way = p.way; }
  }
  updateTrail(v);
  const T = v.trail, a = T[T.length - 2], b = T[T.length - 1];
  const d = a && Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d > 0.1) v.heading = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

// ------------------------------------------------------------ raiteilla kulkevat

// Raiteilla kulkevan ajoneuvon tavoitesijainti. Jos uutta sijaintia ei ole tullut, liikettä
// jatketaan raidetta pitkin viimeisellä nopeudella: junat ja metrot eivät pysähdy asemien
// välillä, mutta pysähtyvät yleensä jokaiselle asemalle, joten seuraavalle asemalle jarrutetaan.
// Kytketyn junan keula on johtavan yksikön edellä headShift metriä.
function railTarget(v, tr) {
  const S = v.samples, last = S[S.length - 1], kind = KINDS[v.kind], h = v.heading ?? v.dir;
  let [tx, ty] = targetAt(S, tr);
  if (tr > last.t && last.pos && h) {
    const sign = signFor(last.pos.e, h[0], h[1]);
    const p = walk(last.pos.e, last.pos.u, sign, travelled(kind, last, sign, Math.min(tr - last.t, DEADRECKON_MAX) / 1000));
    tx = p.x; ty = p.y;
  }
  if (v.headShift > 1 && h) {
    const p = snap(tx, ty, kind.rail, v.way);
    if (p) {
      const q = walk(p.e, p.u, signFor(p.e, h[0], h[1]), v.headShift);
      tx = q.x; ty = q.y;
    }
  }
  return [tx, ty];
}

// Matka (m), jonka ajoneuvo kulkee t sekunnissa viimeisestä sijainnista, kun se jarruttaa
// seuraavalle asemalle (jos se pysähtyy kaikilla asemilla).
function travelled(kind, last, sign, t) {
  const v0 = last.spd ?? 0;
  if (v0 < 1) return 0;
  if (!kind.stops) return v0 * t;
  const ds = nextStop(last.pos.e, last.pos.u, sign, v0 * t + (v0 * v0) / (2 * BRAKE) + 10);
  if (ds == null) return v0 * t;
  const a = Math.max(BRAKE, (v0 * v0) / (2 * Math.max(ds, 1)));
  const brakeDist = (v0 * v0) / (2 * a), t1 = (ds - brakeDist) / v0;
  if (t <= t1) return v0 * t;
  const tau = Math.min(t - t1, v0 / a);
  return ds - brakeDist + v0 * tau - (a * tau * tau) / 2;
}

// Juna ei peruuta myöhässä saapuneen sijainnin takia, vaan odottaa, kunnes tavoite on taas edellä.
// Taaksepäin liikutaan vain, jos sijainnit todella kulkevat taaksepäin (pääteasemalla).
function mayMove(v, tx, ty) {
  const h = v.heading;
  if (!h) return true;
  const along = (tx - v.x) * h[0] + (ty - v.y) * h[1];
  if (along >= 0 || along < -80) return true;
  const S = v.samples, n = S.length;
  if (n < 2) return false;
  const mx = S[n - 1].x - S[n - 2].x, my = S[n - 1].y - S[n - 2].y;
  return Math.hypot(mx, my) > 3 && mx * h[0] + my * h[1] < 0;
}

// Kytketyt lähijunan yksiköt ilmoittavat kukin oman sijaintinsa samalla vuorolla. Ne näytetään
// yhtenä junana, jonka sijainnit tulevat yhdeltä (johtavalta) yksiköltä; muiden yksiköiden
// sijainneista päätellään yksiköiden määrä ja se, kuinka paljon keula on johtavan edellä.
function updateUnits(v, unit, x, y, hdg) {
  const now = Date.now();
  v.units.set(unit, { x, y, at: now });
  for (const [u, r] of v.units) if (now - r.at > 4 * UNIT_STALE) v.units.delete(u);
  const lead = v.units.get(v.lead);
  if (unit !== v.lead) {
    if (lead && now - lead.at < UNIT_STALE) return false;
    v.lead = unit; // johtava yksikkö on vaiennut: vaihdetaan
    v.samples.length = 0;
    v.headShift = 0;
  }
  const fresh = [...v.units.entries()].filter(([, r]) => now - r.at < UNIT_STALE);
  const kind = fresh.length >= 3 ? "train3" : fresh.length === 2 ? "train2" : "train";
  if (kind !== v.kind) { v.kind = kind; v.trail = []; v.elev = null; }
  const h = v.heading ?? (hdg != null ? [Math.sin(hdg * D2R), Math.cos(hdg * D2R)] : null);
  if (h) {
    const ahead = Math.max(0, ...fresh.map(([, r]) => (r.x - x) * h[0] + (r.y - y) * h[1]));
    v.headShift += (ahead - v.headShift) * 0.3;
  }
  v.unitList = fresh.map(([u]) => u);
  return true;
}

// ------------------------------------------------------------ syötteet

const groupOn = Object.fromEntries(TRANSIT_GROUPS.map(([id]) => [id, true]));
const hfp = { client: null, ok: false, cells: new Set() };
const rail = { client: null, ok: false };
let mapRef = null;

function onHfp(topic, payload) {
  const p = topic.split("/");
  const kind = HFP_KINDS[p[6]];
  if (!kind) return;
  let vp;
  try { vp = JSON.parse(payload).VP; } catch { return; }
  // Metron perään kytketty toinen yksikkö (seq 2) ilmoittaa saman sijainnin kuin ensimmäinen.
  if (!vp || vp.lat == null || vp.long == null || vp.seq > 1) return;
  const t = Date.parse(vp.tst);
  if (!t) return;
  // Metron (kulunvalvonnasta saatu sijainti) toistoviestien aikaleima on katkaistu sekunteihin,
  // joten kelloero arvioidaan GPS-sijainneista.
  if (vp.loc === "GPS") hfpClock.seen(t);
  const [x, y] = toLocal(vp.long, vp.lat);
  const inside = inRegion(x, y);
  const unit = `${+p[7]}/${+p[8]}`;
  // Lähijunan kytketyt yksiköt ovat samaa vuoroa (linja, suunta, lähtöaika, päivä): yksi juna.
  const id = kind === "train" ? `hsl/juna/${p[9]}/${p[10]}/${p[12]}/${vp.oday}` : `hsl/${p[7]}/${p[8]}`;
  let v = vehicles.get(id);
  if (!v) {
    if (!inside) return;
    v = newVehicle(id, kind, hfpClock);
    if (vp.hdg != null) { v.dir = [Math.sin(vp.hdg * D2R), Math.cos(vp.hdg * D2R)]; v.guessed = false; }
    if (kind === "train") { v.units = new Map(); v.lead = unit; }
    vehicles.set(id, v);
  }
  if (v.units && !updateUnits(v, unit, x, y, vp.hdg)) return;
  v.cell = p[16];
  v.info = { line: vp.desi, headsign: p[11], dl: vp.dl, spd: vp.spd, veh: v.unitList?.join(" + ") ?? unit };
  addSample(v, { t, x, y, spd: vp.spd ?? 0 }, inside);
}

const railInfo = new Map();
let stationsPromise = null;

function stationNames() {
  stationsPromise ??= fetch(`${RAIL_API}/metadata/stations`).then((r) => r.json())
    .then((list) => {
      const names = new Map(list.map((s) => [s.stationShortCode, s.stationName.replace(/ asema$/, "")]));
      return (code) => names.get(code) ?? code;
    })
    .catch(() => (code) => code);
  return stationsPromise;
}

// Junan laji ja reitti haetaan kerran junaa kohden. Palauttaa null, kun tietoa vielä haetaan.
function railTrain(date, num) {
  const key = `${date}/${num}`;
  if (railInfo.has(key)) return railInfo.get(key);
  railInfo.set(key, null);
  fetch(`${RAIL_API}/trains/${date}/${num}`).then((r) => r.json())
    .then(async ([t]) => {
      const kind = t && RAIL_KINDS[t.trainCategory];
      if (!kind) { railInfo.set(key, { kind: null }); return; }
      const name = await stationNames(), rows = t.timeTableRows ?? [];
      railInfo.set(key, {
        kind, line: `${t.trainType} ${t.trainNumber}`,
        from: name(rows[0]?.stationShortCode), to: name(rows[rows.length - 1]?.stationShortCode),
      });
    })
    .catch(() => setTimeout(() => railInfo.delete(key), 30000));
  return null;
}

function onRail(topic, payload) {
  let d;
  try { d = JSON.parse(payload); } catch { return; }
  const t = Date.parse(d.timestamp);
  if (!(Date.now() - t < 120000)) return; // palvelimen säilyttämät vanhat sijainnit pois
  const [lon, lat] = d.location?.coordinates ?? [];
  if (lon == null) return;
  const [x, y] = toLocal(lon, lat);
  if (!inBox(x, y)) return;
  const info = railTrain(d.departureDate, d.trainNumber);
  if (!info?.kind) return;
  railClock.seen(t);
  const inside = inRegion(x, y);
  const id = `vr/${d.departureDate}/${d.trainNumber}`;
  let v = vehicles.get(id);
  if (!v) {
    if (!inside) return;
    v = newVehicle(id, info.kind, railClock);
    v.dir = RAIL_DEFAULT_DIR;
    vehicles.set(id, v);
  }
  const spd = (d.speed ?? 0) / 3.6;
  v.info = { line: info.line, headsign: info.to, from: info.from, spd };
  addSample(v, { t, x, y, spd }, inside);
}

const cellTopic = (cell) => `/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/+/60;24/${cell}/#`;

// Lähellä tilataan vain näkymän ympärillä olevat ruudut, jotta dataa siirtyy vähemmän.
function wantedCells() {
  const map = mapRef, z = map.getZoom();
  if (z < MODEL_MINZOOM + 0.5) return new Set(region.cells);
  const b = map.getBounds(), c = map.getCenter(), r = Math.min(30000, 2500 * 2 ** (15 - z));
  const w = Math.max(b.getWest(), c.lng - r / M_LON), e = Math.min(b.getEast(), c.lng + r / M_LON);
  const s = Math.max(b.getSouth(), c.lat - r / M_LAT), n = Math.min(b.getNorth(), c.lat + r / M_LAT);
  return new Set(region.cells.filter((cell) => {
    const la = 60 + +cell[0] / 10, lo = 24 + +cell[1] / 10;
    return lo < e && lo + 0.1 > w && la < n && la + 0.1 > s;
  }));
}

function syncCells() {
  if (!hfp.client?.connected) return;
  const want = wantedCells();
  const add = [...want].filter((c) => !hfp.cells.has(c)), drop = [...hfp.cells].filter((c) => !want.has(c));
  if (add.length) hfp.client.subscribe(add.map(cellTopic));
  if (drop.length) {
    hfp.client.unsubscribe(drop.map(cellTopic));
    for (const v of vehicles.values()) if (v.cell && !want.has(v.cell)) removeVehicle(v);
  }
  hfp.cells = want;
}

function connect(url, onMessage, state, onConnect) {
  const client = mqtt.connect(url, { reconnectPeriod: 5000, connectTimeout: 15000, resubscribe: false });
  client.on("connect", () => { state.ok = true; onConnect(client); });
  client.on("close", () => { state.ok = false; });
  client.on("message", onMessage);
  return client;
}

// Taustalle jääneen välilehden yhteydet suljetaan, jottei dataa siirry turhaan. Lyhyt
// käynti toisessa välilehdessä ei kuitenkaan katkaise yhteyttä.
let hiddenTimer = null;

function onVisibility() {
  clearTimeout(hiddenTimer);
  if (document.hidden) hiddenTimer = setTimeout(syncConnections, 30000);
  else syncConnections();
}

function syncConnections() {
  const active = !document.hidden;
  const wantHfp = active && Object.values(groupOn).some(Boolean);
  const wantRail = active && groupOn.junat;
  if (wantHfp && !hfp.client) {
    hfp.client = connect(HFP_URL, onHfp, hfp, () => { hfp.cells = new Set(); syncCells(); });
  } else if (!wantHfp && hfp.client) {
    hfp.client.end(true); hfp.client = null; hfp.ok = false; dropVehicles("hsl/");
  }
  if (wantRail && !rail.client) {
    rail.client = connect(RAIL_MQTT_URL, onRail, rail, (c) => c.subscribe("train-locations/#"));
  } else if (!wantRail && rail.client) {
    rail.client.end(true); rail.client = null; rail.ok = false; dropVehicles("vr/");
  }
}

function dropVehicles(prefix) {
  for (const v of vehicles.values()) if (v.id.startsWith(prefix)) removeVehicle(v);
}

function removeVehicle(v) {
  vehicles.delete(v.id);
  if (selected === v) { selected = null; popup.remove(); }
}

// ------------------------------------------------------------ piirto

// Maan alla kulkeva metro ja tunnelit ovat omassa näkymässään, joka piirretään ennen rakennuksia:
// ne näkyvät maaston läpi, mutta rakennukset peittävät ne.
const scene = new THREE.Scene();
const undergroundScene = new THREE.Scene();
const camera = new THREE.Camera();
const meshes = {};
const matT = new THREE.Matrix4(), matS = new THREE.Matrix4();
let renderer = null;

{
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Metro kulkee Espoossa koko matkan tunnelissa. Se piirretään maan alle läpikuultavana ja
  // maaston läpi näkyvänä (syvyystestiä ei tehdä), tunnelin sisään.
  const underground = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false });
  for (const [key, [build, cap]] of Object.entries(MODELS)) {
    const metro = key.startsWith("metro");
    const mesh = new THREE.InstancedMesh(build(), metro ? underground : solid, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    if (metro) mesh.renderOrder = 2; // tunnelin jälkeen
    meshes[key] = mesh;
    (metro ? undergroundScene : scene).add(mesh);
  }
  for (const sc of [scene, undergroundScene]) {
    sc.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-0.5, -0.8, 1.6);
    sc.add(sun);
  }
}

// Metrotunnelit: raiteita seuraavat putket maan alla. Kärkipisteet ovat Web Mercator -yksiköitä
// suhteessa paikallisen koordinaatiston origoon, joten kartan siirtyessä riittää muuttaa
// kappaleen siirtoa ja mittakaavaa.
const TUNNEL_WIDTH = 6, TUNNEL_HEIGHT = 6.5; // m
let tunnelMesh = null;

function buildTunnels() {
  const s = new Shape(), rock = col("#7d8fa1"), hw = TUNNEL_WIDTH / 2;
  for (const pts of metroLines()) {
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5) continue;
      const nx = (-(by - ay) / len) * hw, ny = ((bx - ax) / len) * hw;
      const ring = (z) => [[ax - nx, ay - ny, z], [ax + nx, ay + ny, z], [bx + nx, by + ny, z], [bx - nx, by - ny, z]];
      s.hexa([...ring(-0.8), ...ring(TUNNEL_HEIGHT - 0.8)], rock);
    }
  }
  const ox = mercX(ORIGIN_LON), oy = mercY(ORIGIN_LAT), n = s.pos.length / 3;
  const pos = new Float32Array(n * 3), colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const lon = lonOf(s.pos[3 * i]), lat = latOf(s.pos[3 * i + 1]);
    pos[3 * i] = mercX(lon) - ox;
    pos[3 * i + 1] = mercY(lat) - oy;
    pos[3 * i + 2] = s.pos[3 * i + 2] / (EARTH_CIRC * Math.cos(lat * D2R));
    // Valaistus väreihin: katto vaaleampi kuin seinät.
    const shade = 0.55 + 0.45 * Math.max(0, s.nor[3 * i + 2]) + 0.15 * Math.abs(s.nor[3 * i]);
    for (let c = 0; c < 3; c++) colors[3 * i + c] = s.col[3 * i + c] * shade;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  tunnelMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    // Molemmat puolet: putken takaseinäkin näkyy, ja Mercator-muunnoksen peilaus ei piilota pintoja.
    vertexColors: true, transparent: true, opacity: 0.18, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  }));
  tunnelMesh.matrixAutoUpdate = false;
  tunnelMesh.frustumCulled = false;
  tunnelMesh.renderOrder = 1;
  undergroundScene.add(tunnelMesh);
}

// Yleiskuvan pisteet: ympyrä, jolla on valkoinen reuna. Piirretään joka ruudussa ajoneuvon
// tasoitetusta sijainnista, joten pisteetkin liikkuvat pehmeästi.
const DOT_CAP = 3000;
const dotPos = new Float32Array(DOT_CAP * 3), dotCol = new Float32Array(DOT_CAP * 3);
const dotColors = Object.fromEntries(Object.entries(COLORS).map(([k, hex]) => [k, col(hex)]));
const dots = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(dotPos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("color", new THREE.BufferAttribute(dotCol, 3).setUsage(THREE.DynamicDrawUsage));
  const m = new THREE.ShaderMaterial({
    uniforms: { uRadius: { value: 5 }, uStroke: { value: 1.2 }, uOpacity: { value: 1 }, uPixelRatio: { value: 1 } },
    vertexShader: `
      uniform float uRadius, uStroke, uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 2.0 * (uRadius + uStroke + 1.0) * uPixelRatio;
      }`,
    fragmentShader: `
      uniform float uRadius, uStroke, uOpacity;
      varying vec3 vColor;
      void main() {
        float r = length(gl_PointCoord * 2.0 - 1.0) * (uRadius + uStroke + 1.0);
        float outer = 1.0 - smoothstep(uRadius + uStroke - 0.5, uRadius + uStroke + 0.5, r);
        if (outer <= 0.0) discard;
        float fill = 1.0 - smoothstep(uRadius - 0.5, uRadius + 0.5, r);
        gl_FragColor = vec4(mix(vec3(1.0), vColor, fill), outer * uOpacity);
        #include <colorspace_fragment>
      }`,
    vertexColors: true, transparent: true, depthTest: false, depthWrite: false,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  points.renderOrder = 3;
  scene.add(points);
  return points;
})();

function putInstance(mesh, wx, wy, wz, yaw, pitch, k) {
  const i = mesh.count;
  if (i >= mesh.instanceMatrix.count) return;
  mesh.count = i + 1;
  const a = mesh.instanceMatrix.array, o = i * 16;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  a[o] = cy * k; a[o + 1] = sy * k; a[o + 2] = 0; a[o + 3] = 0;
  a[o + 4] = -sy * cp * k; a[o + 5] = cy * cp * k; a[o + 6] = sp * k; a[o + 7] = 0;
  a[o + 8] = sy * sp * k; a[o + 9] = -cy * sp * k; a[o + 10] = cp * k; a[o + 11] = 0;
  a[o + 12] = wx; a[o + 13] = wy; a[o + 14] = wz; a[o + 15] = 1;
}

let lastTick = performance.now();
let lastRender = 0;
let repaintTimer = null;
let lastDt = 16;

function tick() {
  const now = performance.now(), dt = Math.min(now - lastTick, 500);
  lastTick = now;
  lastDt = dt;
  const k = 1 - Math.exp(-dt / SMOOTH_MS), wall = Date.now();
  for (const v of vehicles.values()) advance(v, wall, k);
  if (selected?.x != null) {
    // Maan alla kulkevan metron kohdalla ikkuna osoittaa maanpinnan kohtaan, jonka läpi juna näkyy.
    const scr = KINDS[selected.kind].underground && selected.drawnAt > now - 500 ? selected.screen : null;
    const n = scr ? scr.length / 2 : 0;
    popup.setLngLat(n ? mapRef.unproject([scr[2 * (n >> 1)], scr[2 * (n >> 1) + 1]]) : [lonOf(selected.x), latOf(selected.y)]);
  }
}

const pts = new Float64Array(64);

// Ajoneuvon korkeus pisteessä absoluuttisena, maaston korostus mukana. Sillan kohdalla
// korkeusmalli on nostettu kannen tasolle (bridges.js). Ajoneuvo pysyy kannella, jos se tuli
// sillalle kannen korkeudelta (esimerkiksi penkereeltä), ja sillan ali kulkeva ajoneuvo pysyy
// alla olevan tien tasolla. prev on saman kohdan edellinen korkeus.
function groundAt(v, x, y, prev, centerElev, exag) {
  const lon = lonOf(x), lat = latOf(y);
  const dem = (mapRef.queryTerrainElevation([lon, lat]) ?? 0) + centerElev;
  if (KINDS[v.kind].underground) return dem;
  const deck = deckHeightAt(lon, lat);
  if (deck == null) return dem;
  const rawM = rawElevationAt(lon, lat), raw = rawM == null ? dem : rawM * exag, top = deck * exag;
  if (top < raw + 0.5) return dem; // silta ei ole maanpinnan yläpuolella
  const from = prev ?? approachElevation(v, centerElev);
  if (Math.abs(from - top) >= Math.abs(from - raw)) return raw; // sillan alla
  return rawM == null ? Math.max(dem, top) : dem; // kannella (nostettu maasto on kannen pinta)
}

// Maanpinnan korkeus siinä reitin kohdassa, josta ajoneuvo tuli sillalle.
function approachElevation(v, centerElev) {
  const T = v.trail;
  for (let i = T.length - 1; i >= 0; i--) {
    if (deckHeightAt(lonOf(T[i][0]), latOf(T[i][1])) == null || i === 0) {
      return (mapRef.queryTerrainElevation([lonOf(T[i][0]), latOf(T[i][1])]) ?? 0) + centerElev;
    }
  }
  return (mapRef.queryTerrainElevation([lonOf(v.x), latOf(v.y)]) ?? 0) + centerElev;
}

// Maailmankoordinaatit näytön pikseleiksi (null, jos piste on kameran takana).
function toScreen(e, wx, wy, wz, W, H) {
  const w = e[3] * wx + e[7] * wy + e[11] * wz + e[15];
  if (w <= 0) return null;
  const x = (e[0] * wx + e[4] * wy + e[8] * wz + e[12]) / w, y = (e[1] * wx + e[5] * wy + e[9] * wz + e[13]) / w;
  return [((x + 1) / 2) * W, ((1 - y) / 2) * H];
}

// ------------------------------------------------------------ linjanumerot

// Linjanumerot ovat karttakuvan päällä olevia elementtejä, joita siirretään joka ruudussa
// ajoneuvon mukana, joten ne liikkuvat yhtä tasaisesti kuin mallit.
let labelLayer = null;
const labels = new Map();
let frameNo = 0;

function placeLabel(v, sx, sy) {
  let el = labels.get(v.id);
  if (!el) {
    el = document.createElement("div");
    el.className = KINDS[v.kind].underground ? "vlabel underground" : "vlabel";
    el.style.background = COLORS[v.kind];
    labelLayer.append(el);
    labels.set(v.id, el);
  }
  const text = v.info.line ?? "";
  if (el.textContent !== text) el.textContent = text;
  el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  el.hidden = false;
  el.frame = frameNo;
}

function hideStaleLabels() {
  for (const [id, el] of labels) {
    if (el.frame === frameNo) continue;
    if (vehicles.has(id)) el.hidden = true;
    else { el.remove(); labels.delete(id); }
  }
}

function draw(gl, matrix) {
  const map = mapRef;
  for (const mesh of Object.values(meshes)) mesh.count = 0;
  const zoom = map.getZoom();
  frameNo++;
  const c = map.getCenter(), cmx = mercX(c.lng), cmy = mercY(c.lat);
  const sc = 1 / (EARTH_CIRC * Math.cos(c.lat * D2R)), cosC = Math.cos(c.lat * D2R);
  // Maailmankoordinaatit: metrejä kartan keskipisteestä (x itään, y pohjoiseen, z ylös).
  camera.projectionMatrix.fromArray(matrix)
    .multiply(matT.makeTranslation(cmx, cmy, 0))
    .multiply(matS.makeScale(sc, -sc, sc));
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  const centerElev = map.transform.elevation ?? 0;
  const exag = map.getTerrain()?.exaggeration ?? 1;
  const tunnelZ = METRO_TUNNEL_Z * exag - centerElev; // metron raiteiden taso näkymässä
  const b = map.getBounds(), [vx0, vy0] = toLocal(b.getWest(), b.getSouth()), [vx1, vy1] = toLocal(b.getEast(), b.getNorth());
  const e = camera.projectionMatrix.elements, W = map.transform.width, H = map.transform.height;
  const now = performance.now();
  const inView = (v, margin) => v.x > vx0 - margin && v.x < vx1 + margin && v.y > vy0 - margin && v.y < vy1 + margin;

  if (tunnelMesh) {
    tunnelMesh.visible = groupOn.metro;
    const ox = mercX(ORIGIN_LON), oy = mercY(ORIGIN_LAT);
    tunnelMesh.matrix.set(
      1 / sc, 0, 0, (ox - cmx) / sc,
      0, -1 / sc, 0, -(oy - cmy) / sc,
      0, 0, 1 / sc, tunnelZ,
      0, 0, 0, 1);
    tunnelMesh.matrixWorldNeedsUpdate = true;
  }

  // Pisteet kaukaa katsottaessa; ne häivytetään, kun mallit tulevat näkyviin.
  let nDots = 0;
  if (zoom < DOT_MAXZOOM) {
    for (const v of vehicles.values()) {
      if (v.x == null || !groupOn[KINDS[v.kind].group] || !inView(v, 100) || nDots >= DOT_CAP) continue;
      const lon = lonOf(v.x), lat = latOf(v.y), k = cosC / Math.cos(lat * D2R);
      let z;
      if (KINDS[v.kind].underground) z = tunnelZ;
      else {
        if (v.headElev == null || now - v.headElevAt > 500) {
          v.headElev = (map.queryTerrainElevation([lon, lat]) ?? 0) + centerElev;
          v.headElevAt = now + Math.random() * 100;
        }
        z = (v.headElev - centerElev) * k;
      }
      const wx = (mercX(lon) - cmx) / sc, wy = -(mercY(lat) - cmy) / sc;
      dotPos[3 * nDots] = wx; dotPos[3 * nDots + 1] = wy; dotPos[3 * nDots + 2] = z;
      const colr = dotColors[v.kind];
      dotCol[3 * nDots] = colr.r; dotCol[3 * nDots + 1] = colr.g; dotCol[3 * nDots + 2] = colr.b;
      v.dot = toScreen(e, wx, wy, z, W, H);
      v.dotAt = now;
      nDots++;
    }
    const u = dots.material.uniforms;
    u.uRadius.value = Math.min(5.5, Math.max(2.5, 2.5 + ((zoom - 9) / 5) * 3));
    u.uOpacity.value = Math.min(1, Math.max(0, (DOT_MAXZOOM - zoom) / 1));
    u.uPixelRatio.value = gl.drawingBufferWidth / W;
  }
  dots.geometry.setDrawRange(0, nDots);
  dots.geometry.attributes.position.needsUpdate = true;
  dots.geometry.attributes.color.needsUpdate = true;

  if (zoom >= MODEL_MINZOOM) {
    const scale = Math.min(MAX_ENLARGE, Math.max(1, 2 ** ((15 - zoom) * 0.6)));
    const ke = 1 - Math.exp(-lastDt / ELEV_SMOOTH_MS);
    for (const v of vehicles.values()) {
      const kind = KINDS[v.kind];
      if (v.x == null || !groupOn[kind.group] || !inView(v, 400)) continue;
      const n = kind.cars.length;
      walkTrail(v, kind.ds, scale, pts);
      if (kind.underground) {
        // Tunnelissa raiteet ovat yhdellä tasolla maanpinnan muodoista riippumatta.
        v.elev = v.elevShown = new Float64Array(2 * n).fill(tunnelZ + centerElev);
      } else if (!v.elev || v.elev.length !== 2 * n || now - v.elevAt > 300) {
        // Korkeus haetaan harvemmin kuin piirretään ja tallennetaan absoluuttisena.
        const prev = v.elev?.length === 2 * n ? v.elev : null;
        v.elev = new Float64Array(2 * n);
        for (let j = 0; j < 2 * n; j++) v.elev[j] = groundAt(v, pts[2 * j], pts[2 * j + 1], prev?.[j], centerElev, exag);
        v.elevAt = now + Math.random() * 100;
      }
      // Näytetty korkeus seuraa haettua pehmeästi, jottei ajoneuvo hypi pystysuunnassa.
      if (!v.elevShown || v.elevShown.length !== v.elev.length) v.elevShown = Float64Array.from(v.elev);
      for (let j = 0; j < v.elev.length; j++) {
        const d = v.elev[j] - v.elevShown[j];
        v.elevShown[j] = Math.abs(d) > 40 ? v.elev[j] : v.elevShown[j] + d * ke;
      }
      const base = kind.underground ? 0 : LIFT;
      v.screen ??= [];
      v.screen.length = 0;
      for (let i = 0; i < n; i++) {
        const [model, len, flip] = kind.cars[i];
        const fx = pts[4 * i], fy = pts[4 * i + 1], bx = pts[4 * i + 2], by = pts[4 * i + 3];
        const lon = lonOf((fx + bx) / 2), lat = latOf((fy + by) / 2);
        const k = cosC / Math.cos(lat * D2R);
        const zf = v.elevShown[2 * i] - centerElev, zb = v.elevShown[2 * i + 1] - centerElev;
        const yaw = Math.atan2(-(fx - bx), fy - by) + (flip ? Math.PI : 0);
        const pitch = Math.atan2(flip ? zb - zf : zf - zb, len * scale);
        const wx = (mercX(lon) - cmx) / sc, wy = -(mercY(lat) - cmy) / sc, wz = ((zf + zb) / 2 + base) * k;
        putInstance(meshes[model], wx, wy, wz, yaw, pitch, k * scale);
        const mid = toScreen(e, wx, wy, wz + (kind.height / 2) * k * scale, W, H);
        if (mid) v.screen.push(mid[0], mid[1]);
        if (i === n >> 1) {
          const top = toScreen(e, wx, wy, wz + (kind.height * scale + 1.2) * k, W, H);
          if (top && top[0] > -60 && top[0] < W + 60 && top[1] > -30 && top[1] < H + 60) placeLabel(v, top[0], top[1]);
        }
      }
      v.drawnAt = now;
    }
  }
  labelLayer.hidden = zoom < MODEL_MINZOOM;
  hideStaleLabels();
  for (const mesh of Object.values(meshes)) mesh.instanceMatrix.needsUpdate = true;
}

function renderScene(gl, sc) {
  renderer.resetState();
  renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  renderer.render(sc, camera);
}

// ------------------------------------------------------------ yleiskuva, valinta ja tilastot

const popup = new maplibregl.Popup({ maxWidth: "300px", closeButton: true, offset: 12 });
let selected = null;
popup.on("close", () => { selected = null; });

const node = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...children.flat().filter((c) => c != null));
  return n;
};

function delayText(dl) {
  if (dl == null) return null;
  const min = Math.round(Math.abs(dl) / 60);
  if (min === 0) return "aikataulussa";
  return `${min} min ${dl < 0 ? "myöhässä" : "etuajassa"}`;
}

function popupContent(v) {
  const kind = KINDS[v.kind], i = v.info;
  const rows = [
    ["Nopeus", `${Math.round((i.spd ?? 0) * 3.6)} km/h`],
    ["Aikataulu", delayText(i.dl)],
    ["Lähtöasema", i.from],
    ["Ajoneuvo", i.veh],
  ].filter(([, val]) => val != null);
  return node("div", { class: "pop" },
    node("div", { class: "kind" }, kind.label),
    node("h3", {}, [i.line, i.headsign].filter(Boolean).join(" → ")),
    node("table", {}, rows.map(([k, val]) => node("tr", {}, node("th", {}, k), node("td", {}, val)))),
    v.kind === "metro" ? node("p", { class: "more" }, "Metro kulkee Espoossa kallion sisällä tunnelissa.") : null);
}

// Lähikuvassa verrataan piirrettyjen vaunujen näyttösijainteihin (myös maan alla kulkeva metro
// ja sillalla kulkevat ajoneuvot osuvat oikein), kaukaa ajoneuvon pisteeseen.
function pick(point) {
  const map = mapRef, recent = performance.now() - 500;
  let best = null, bestD = 22 * 22;
  for (const v of vehicles.values()) {
    if (v.x == null || !groupOn[KINDS[v.kind].group]) continue;
    let probes = v.drawnAt > recent && v.screen?.length ? v.screen : v.dotAt > recent ? v.dot : null;
    if (!probes) {
      const p = map.project([lonOf(v.x), latOf(v.y)]);
      probes = [p.x, p.y];
    }
    for (let i = 0; i < probes.length; i += 2) {
      const d = (probes[i] - point.x) ** 2 + (probes[i + 1] - point.y) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
  }
  return best;
}

function stats() {
  const counts = Object.fromEntries(TRANSIT_GROUPS.map(([id]) => [id, 0]));
  for (const v of vehicles.values()) if (v.x != null) counts[KINDS[v.kind].group]++;
  let message = "Sijainnit päivittyvät sekunnin välein. Lähennä karttaa, niin näet ajoneuvot 3D-malleina.";
  if (document.hidden) message = "";
  else if (hfp.client && !hfp.ok) message = "Yhdistetään HSL:n reaaliaikapalveluun…";
  else if (rail.client && !rail.ok) message = "Kaukojunien sijainnit (Digitraffic) eivät juuri nyt päivity.";
  return { counts, message };
}

// ------------------------------------------------------------ julkinen rajapinta

export async function createTransit(map, { boundaryUrl, railsUrl, beforeLayer, undergroundBeforeLayer }) {
  mapRef = map;
  await loadRegion(boundaryUrl);
  // Ilman raiteita metro kulkee ilmoitetuissa sijainneissa ilman tunnelia.
  // Ilman raiteita junat kulkevat ilmoitetuissa sijainneissa, eikä metrotunneleita piirretä.
  loadRails(railsUrl).then(buildTunnels).catch((err) => console.warn("Raiteita ei saatu ladattua", err));
  labelLayer = document.createElement("div");
  labelLayer.className = "vehicle-labels";
  map.getContainer().append(labelLayer);

  const onAdd = (m, gl) => {
    renderer ??= new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    renderer.autoClear = false;
  };
  // Maan alla oleva taso piirretään ruudussa ensin, joten ajoneuvojen sijainnit lasketaan siinä.
  map.addLayer({
    id: "joukkoliikenne-maan-alla", type: "custom", renderingMode: "3d", onAdd,
    render(gl, matrix) {
      lastRender = performance.now();
      tick();
      draw(gl, matrix);
      renderScene(gl, undergroundScene);
    },
  }, undergroundBeforeLayer);
  map.addLayer({
    id: "joukkoliikenne", type: "custom", renderingMode: "3d", onAdd,
    render(gl) {
      renderScene(gl, scene);
      // Ajoneuvot liikkuvat koko ajan, joten kartta piirretään jatkuvasti. Kaukaa katsottaessa
      // liike on ruudulla hidasta, joten silloin riittää harvempi tahti.
      if (!Object.values(groupOn).some(Boolean)) return;
      if (map.getZoom() >= 11) map.triggerRepaint();
      else repaintTimer ??= setTimeout(() => { repaintTimer = null; map.triggerRepaint(); }, 50);
    },
  }, beforeLayer);

  map.on("moveend", syncCells);
  document.addEventListener("visibilitychange", onVisibility);

  // Varmistus: jos piirtosilmukka on pysähtynyt (esim. kaikki ryhmät olivat pois), käynnistetään se.
  setInterval(() => {
    if (performance.now() - lastRender > 1000 && Object.values(groupOn).some(Boolean)) map.triggerRepaint();
  }, 1000);

  const listeners = [];
  setInterval(() => {
    const wall = Date.now();
    for (const v of vehicles.values()) {
      if (wall - v.lastRx > (KINDS[v.kind].rail != null ? RAIL_TIMEOUT : HFP_TIMEOUT)) removeVehicle(v);
    }
    if (selected) popup.setDOMContent(popupContent(selected));
    const s = stats();
    for (const fn of listeners) fn(s);
  }, 1000);

  syncConnections();

  return {
    vehicles, scene, // selaimen konsolia varten
    setGroup(id, on) {
      groupOn[id] = on;
      if (selected && !groupOn[KINDS[selected.kind].group]) popup.remove();
      syncConnections();
      map.triggerRepaint();
    },
    onStats(fn) { listeners.push(fn); fn(stats()); },
    // Palauttaa true, jos klikkaus osui ajoneuvoon (ja sen tiedot avattiin).
    click(point) {
      const v = pick(point);
      if (!v) { popup.remove(); return false; }
      // addTo sulkee aiemman ikkunan (ja nollaa valinnan), joten valinta asetetaan vasta sen jälkeen.
      popup.setLngLat([lonOf(v.x), latOf(v.y)]).setDOMContent(popupContent(v)).addTo(map);
      selected = v;
      return true;
    },
  };
}
