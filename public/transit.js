// Liikenne reaaliajassa. Bussien, raitiovaunujen, lähijunien ja metron sijainnit tulevat
// HSL:n avoimesta HFP-syötteestä, kauko- ja tavarajunien ja Espoon merialueen alusten sijainnit
// Digitrafficista ja Espoon yllä lentävät koneet adsb.fi:stä. Ajoneuvot piirretään 3D-malleina MapLibren omalle tasolle
// three.js:llä, ja niiden liike lasketaan tasaiseksi vastaanotettujen sijaintien välillä.
// Samalle tasolle piirretään myös maamerkkien 3D-mallit (landmarks.js).
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import mqtt from "https://unpkg.com/mqtt@5.10.1/dist/mqtt.esm.js";
import { deckHeightAt, gameDecksAt, rawElevationAt } from "./bridges.js";
import { METRO, RAIL, TRAM, loadRails, metroLines, nextStop, pathBehind, signFor, snap, walk } from "./rails.js";
import { buildTunnelInterior } from "./metrotunnel.js";
import { LANDMARKS, detailRadius } from "./layers.js";
import { LANDMARK_MODELS, lod2Landmark } from "./landmarks.js";
import { createRide } from "./ride.js";

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
// Jatkuvan piirron tahti: noin 30 kertaa sekunnissa riittää tasaiseen liikkeeseen ja puolittaa
// näytönohjaimen kuorman. Karttaa liikutettaessa MapLibre piirtää silti täydellä nopeudella.
const FRAME_INTERVAL = 28; // ms (ajastin ja näytön virkistys venyttävät välin noin 33 ms:iin)

export const TRANSIT_GROUPS = [
  ["bussit", "Bussit", "#007ac9"],
  ["ratikat", "Raitiovaunut", "#00985f"],
  ["junat", "Junat", "#8c4799"],
  ["metro", "Metro", "#ff6319"],
  ["laivat", "Laivat ja veneet", "#1d6fa5"],
  ["lentokoneet", "Lentokoneet", "#e63946"],
  ["lataus", "Sähköautot latauksessa", "#f5b700"],
];

const COLORS = {
  bus: "#007ac9", tram: "#00985f", train: "#8c4799", train2: "#8c4799", train3: "#8c4799", metro: "#ff6319",
  intercity: "#3e9b3a", freight: "#b5462e", locomotive: "#b5462e",
};

// Vaunut keulasta taaksepäin: [malli, pituus (m), käännetty]. Takimmainen ohjaamovaunu on
// sama malli käännettynä, joten molemmissa päissä on keula. height on katon korkeus (m),
// jonka yläpuolelle linjanumero sijoitetaan. rail kertoo raideverkon (rails.js), stops,
// pysähtyykö ajoneuvo yleensä jokaisella asemalla tai pysäkillä, ja grade radan suurimman
// kaltevuuden (korkeuden muutos metriä metrillä). eye on kuljettajan silmien korkeus maasta (m);
// ajoneuvoihin, joilta se puuttuu (tavarajunat), ei voi hypätä kyytiin (ride.js).
const KINDS = {
  bus: { group: "bussit", label: "Bussi", cars: [["bus", 12]], gap: 0, height: 3.3, eye: 2.5 },
  tram: {
    group: "ratikat", label: "Raitiovaunu", gap: 0.5, height: 3.7, eye: 2.7, rail: TRAM, stops: true, grade: 0.07,
    cars: [["tramCab", 12.2], ["tramMid", 9.4], ["tramCab", 12.2, true]],
  },
  train: {
    group: "junat", label: "Lähijuna", gap: 0.6, height: 4.4, eye: 3.0, rail: RAIL, stops: true, grade: 0.025,
    cars: [["flirtCab", 19.6], ["flirtMid", 17.2], ["flirtMid", 17.2], ["flirtCab", 19.6, true]],
  },
  // Metrotunnelien sisäpuoli (metrotunnel.js) piirretään, kun kamera on metron kyydissä maan alla.
  metro: {
    group: "metro", label: "Metro", gap: 0.6, height: 3.6, eye: 2.2, underground: true, delay: METRO_DELAY, rail: METRO, stops: true,
    cars: [["metroCab", 22.6], ["metroMid", 21.8], ["metroMid", 21.8], ["metroCab", 22.6, true]],
  },
  intercity: {
    group: "junat", label: "Kaukojuna", gap: 0.8, height: 5.0, eye: 3.3, rail: RAIL, grade: 0.025,
    cars: [["loco", 19.6], ...Array(6).fill(["coach", 26.4])],
  },
  freight: {
    group: "junat", label: "Tavarajuna", gap: 0.9, height: 4.3, rail: RAIL, grade: 0.025,
    cars: [["cargoLoco", 19.6], ...Array.from({ length: 12 }, (_, i) => (i % 3 === 1 ? ["tankWagon", 14] : ["boxWagon", 15.5]))],
  },
  locomotive: { group: "junat", label: "Veturi", cars: [["cargoLoco", 19.6]], gap: 0, height: 4.3, rail: RAIL, grade: 0.025 },
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

// Onko piste Espoossa tai Kauniaisissa tai enintään margin metrin päässä niistä.
function nearRegion(x, y, margin) {
  const b = region.box;
  if (x < b[0] - margin || x > b[2] + margin || y < b[1] - margin || y > b[3] + margin) return false;
  if (region.polys.some((poly) => poly.reduce((acc, ring) => acc !== inRing(x, y, ring), false))) return true;
  return region.polys.some((poly) => poly.some((ring) => nearRing(x, y, ring, margin ** 2)));
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
  // Raiteilla kulkevan reitin pisteisiin tallennetaan keulan korkeus (ks. updateRailZ).
  if (v.railZ != null) v.trail = v.trail.map(([x, y]) => [x, y, v.railZ]);
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
  T.push(v.railZ != null ? [v.x, v.y, v.railZ] : [v.x, v.y]);
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
// Jos outZ annetaan, siihen tulevat reitille tallennetut korkeudet samoista kohdista.
function walkTrail(v, ds, scale, out, outZ = null) {
  const T = v.trail;
  let ax = v.x, ay = v.y, az = v.railZ, acc = 0, j = T.length - 1, k = 0;
  let ux = 0, uy = -1;
  if (T.length >= 2) {
    const a = T[T.length - 1], b = T[0], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    ux = (b[0] - a[0]) / d; uy = (b[1] - a[1]) / d;
  }
  while (k < ds.length) {
    const want = ds[k] * scale;
    if (j < 0) { // reitti loppui: jatketaan suoraan
      out[2 * k] = ax + ux * (want - acc); out[2 * k + 1] = ay + uy * (want - acc);
      if (outZ) outZ[k] = az;
      k++;
      continue;
    }
    const bx = T[j][0], by = T[j][1], bz = T[j][2] ?? az, seg = Math.hypot(bx - ax, by - ay);
    if (acc + seg >= want) {
      const f = seg > 1e-6 ? (want - acc) / seg : 0;
      out[2 * k] = ax + (bx - ax) * f; out[2 * k + 1] = ay + (by - ay) * f;
      if (outZ) outZ[k] = az + (bz - az) * f;
      k++;
    } else {
      if (seg > 1e-6) { ux = (bx - ax) / seg; uy = (by - ay) / seg; }
      acc += seg; ax = bx; ay = by; az = bz; j--;
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
    v.x = tx; v.y = ty; v.trail = []; v.railZ = null;
  } else {
    if (rail != null && !mayMove(v, tx, ty)) { tx = v.x; ty = v.y; }
    v.x += (tx - v.x) * k; v.y += (ty - v.y) * k;
  }
  if (rail != null) {
    const p = snap(v.x, v.y, rail, v.way);
    if (p) { v.x = p.x; v.y = p.y; v.pos = p; v.way = p.way; }
  }
  if (KINDS[v.kind].grade) updateRailZ(v);
  updateTrail(v);
  const T = v.trail, a = T[T.length - 2], b = T[T.length - 1];
  const d = a && Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d > 0.1) v.heading = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

// ------------------------------------------------------------ raiteilla kulkevat

// Junan korkeus: radan kaltevuus on rajallinen (rautatiellä enintään noin 2,5 %), joten keulan
// korkeus saa muuttua kuljettuun matkaan nähden vain sen verran. Korkeusmallin äkkinäiset
// muutokset (esim. tukimuurit, siltojen reunat, karkea maastotiili) ovat siksi virheitä eivätkä
// heiluta junaa. Lisäksi sallitaan hidas liukuma, jotta korkeus asettuu kohdalleen, kun
// tarkempi maastotiili latautuu tai juna seisoo. Vaunut käyttävät reitille tallennettuja
// keulan korkeuksia, joten koko juna kulkee samaa tasaista profiilia.
function updateRailZ(v) {
  const exag = mapRef.getTerrain()?.exaggeration ?? 1, centerElev = mapRef.transform.elevation ?? 0;
  const ground = groundAt(v, v.x, v.y, v.railZ, centerElev, exag);
  if (v.railZ == null) { v.railZ = ground; v.railAt = [v.x, v.y]; return; }
  const moved = Math.hypot(v.x - v.railAt[0], v.y - v.railAt[1]);
  v.railAt = [v.x, v.y];
  const allowed = KINDS[v.kind].grade * exag * moved + 0.3 * (lastDt / 1000);
  v.railZ += Math.max(-allowed, Math.min(allowed, ground - v.railZ));
}

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
  if (riding?.cell) want.add(riding.cell); // kyydissä oleva ajoneuvo ei katoa ruudun vaihtuessa
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
const overlayScene = new THREE.Scene(); // yleiskuvan pisteet kaiken päällä
const tunnelScene = new THREE.Scene(); // metron kyydissä tunnelin sisäpuoli ja metrot (metrotunnel.js)
const camera = new THREE.Camera();
// Maan alla olevat kohteet ja pisteet piirretään ilman syvyystestiä. Niille käytetään kameraa,
// jolta syvyysrajaus puuttuu: suoraan ylhäältä katsottaessa kartan kaukotaso on heti maanpinnan
// alla, ja tunnelissa kulkeva metro jäisi muuten sen taakse näkymättömiin.
const flatCamera = new THREE.Camera();
const meshes = {};
const matT = new THREE.Matrix4(), matS = new THREE.Matrix4();
let renderer = null;

const solidMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
// Metro kulkee Espoossa koko matkan tunnelissa. Se piirretään maan alle läpikuultavana ja
// maaston läpi näkyvänä (syvyystestiä ei tehdä), tunnelin sisään.
const undergroundMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, depthTest: false });

{
  for (const [key, [build, cap]] of Object.entries(MODELS)) {
    const metro = key.startsWith("metro");
    const mesh = new THREE.InstancedMesh(build(), metro ? undergroundMaterial : solidMaterial, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    if (metro) mesh.renderOrder = 2; // tunnelin jälkeen
    meshes[key] = mesh;
    (metro ? undergroundScene : scene).add(mesh);
  }
  for (const sc of [scene, undergroundScene, tunnelScene]) {
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
  const n = s.pos.length / 3, colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Valaistus väreihin: katto vaaleampi kuin seinät.
    const shade = 0.55 + 0.45 * Math.max(0, s.nor[3 * i + 2]) + 0.15 * Math.abs(s.nor[3 * i]);
    for (let c = 0; c < 3; c++) colors[3 * i + c] = s.col[3 * i + c] * shade;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mercatorPositions(s.pos), 3));
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

// Paikalliset metrit (z ylös raiteen tasosta) Web Mercator -yksiköiksi suhteessa paikallisen
// koordinaatiston origoon.
function mercatorPositions(local) {
  const ox = mercX(ORIGIN_LON), oy = mercY(ORIGIN_LAT), out = new Float32Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const lon = lonOf(local[i]), lat = latOf(local[i + 1]);
    out[i] = mercX(lon) - ox;
    out[i + 1] = mercY(lat) - oy;
    out[i + 2] = local[i + 2] / (EARTH_CIRC * Math.cos(lat * D2R));
  }
  return out;
}

// Maanalaisen kappaleen siirto ja mittakaava kartan mukaan: z on metron raiteiden taso näkymässä.
function placeUnderground(obj, cmx, cmy, sc, z) {
  const ox = mercX(ORIGIN_LON), oy = mercY(ORIGIN_LAT);
  obj.matrix.set(
    1 / sc, 0, 0, (ox - cmx) / sc,
    0, -1 / sc, 0, -(oy - cmy) / sc,
    0, 0, 1 / sc, z,
    0, 0, 0, 1);
  obj.matrixWorldNeedsUpdate = true;
}

// Metron kyydissä tunnelissa (ride.js) piirretään kartan sijaan tunnelin sisäpuoli
// (metrotunnel.js) ja metrot tavallisina malleina. Sisäpuoli tummuu etäisyyden mukaan kallion
// väriin, jolla myös tausta täytetään, joten putkien päät ja asemahallien päädyt näkyvät kalliona.
const ROCK = col("#121416");
const tunnelFog = { value: 1 }; // metriä syvyysyksikköä (MapLibren pikseliä) kohden
let tunnelInterior = null, tunnelView = false;

// Kärkipisteiden y-akseli on Mercator-yksiköissä peilattu, ja kappaleen siirto (placeUnderground)
// peilaa sen takaisin. three.js kääntää peilatun kappaleen etupuolen, joten sisäpinnat ovat sen
// silmissä takapuolia (BackSide).
function tunnelMaterial(far) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uMeters: tunnelFog, uFar: { value: far }, uFog: { value: ROCK } },
    vertexShader: `
      uniform float uMeters;
      varying vec3 vColor;
      varying float vDist;
      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vDist = gl_Position.w * uMeters;
      }`,
    fragmentShader: `
      uniform float uFar;
      uniform vec3 uFog;
      varying vec3 vColor;
      varying float vDist;
      void main() {
        gl_FragColor = vec4(mix(vColor, uFog, smoothstep(uFar * 0.1, uFar, vDist)), 1.0);
        #include <colorspace_fragment>
      }`,
    vertexColors: true,
  });
}

function buildInterior() {
  const parts = buildTunnelInterior();
  if (!parts) return null;
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  for (const [part, far] of [[parts.walls, 260], [parts.lights, 520]]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mercatorPositions(part.pos), 3));
    g.setAttribute("color", new THREE.BufferAttribute(part.col, 3));
    const mesh = new THREE.Mesh(g, tunnelMaterial(far));
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  tunnelScene.add(group);
  return group;
}

function setTunnelView(on) {
  if (on === tunnelView) return;
  if (on) tunnelInterior ??= buildInterior();
  if (on && !tunnelInterior) return; // raiteita ei ole vielä ladattu
  tunnelView = on;
  for (const [key, mesh] of Object.entries(meshes)) {
    if (!key.startsWith("metro")) continue;
    mesh.material = on ? solidMaterial : undergroundMaterial;
    mesh.renderOrder = on ? 0 : 2;
    (on ? tunnelScene : undergroundScene).add(mesh);
  }
  labelLayer.hidden = on; // maanpäällisten ajoneuvojen linjanumerot pois
}

// Onko kamera maanpinnan alla.
function cameraUnderground(map, centerElev) {
  const cp = map.transform.getCameraPosition();
  return cp.altitude < (map.queryTerrainElevation(cp.lngLat) ?? 0) + centerElev - 1;
}

// Yleiskuvan pisteet: ympyrä, jolla on valkoinen reuna. Piirretään joka ruudussa ajoneuvon
// tasoitetusta sijainnista, joten pisteetkin liikkuvat pehmeästi.
const DOT_CAP = 3000;
const dotPos = new Float32Array(DOT_CAP * 3), dotCol = new Float32Array(DOT_CAP * 3);
const dotColors = Object.fromEntries(Object.entries({ ...COLORS, ship: "#1d6fa5", lataus: "#f5b700" }).map(([k, hex]) => [k, col(hex)]));
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
  overlayScene.add(points);
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

// ------------------------------------------------------------ lentokoneet

// Espoon yllä lentävät koneet. Sijainnit tulevat adsb.fi:n avoimesta ADS-B-rajapinnasta
// (välityspalvelimen kautta) ja reitit adsbdb.comista lentotunnuksen perusteella. Kone
// näytetään ilmoittamassaan korkeudessa, ja hakujen välissä sen liikettä jatketaan nopeuden,
// suunnan ja nousunopeuden mukaan; uuden sijainnin tuoma korjaus häivytetään pehmeästi.
const PLANE_POLL = 4000; // ms
const PLANE_TIMEOUT = 25000;
const PLANE_MARGIN = 5000; // m: koneet näkyvät vielä näin kaukana Espoon rajan takana
const PLANE_CORRECT_MS = 1500;
const PLANE_CAP = 300;
const FT = 0.3048, KT = 1852 / 3600;
const GEOID = 19; // m: GNSS-korkeus on ellipsoidista; geoidi on Etelä-Suomessa noin 19 m sen yläpuolella
const planes = new Map();
const planeState = { url: null, ok: true };
const routes = new Map();

// Lentoyhtiö ja pyrstön väri ICAO-tunnuksen mukaan (lentotunnuksen kolme ensimmäistä kirjainta).
const AIRLINES = {
  FIN: ["Finnair", "#0b2265"], SAS: ["SAS", "#000b6b"], NOZ: ["Norwegian", "#d81939"], NSZ: ["Norwegian", "#d81939"],
  NAX: ["Norwegian", "#d81939"], DLH: ["Lufthansa", "#05164d"], KLM: ["KLM", "#00a1de"], BTI: ["airBaltic", "#a7c62f"],
  RYR: ["Ryanair", "#073590"], WZZ: ["Wizz Air", "#c6007e"], EZY: ["easyJet", "#ff6600"], THY: ["Turkish Airlines", "#c70a0c"],
  QTR: ["Qatar Airways", "#5c0632"], BAW: ["British Airways", "#2a5caa"], AFR: ["Air France", "#002157"],
  AEE: ["Aegean", "#1f4e8c"], LOT: ["LOT", "#0b3d91"], SWR: ["Swiss", "#e2001a"], AUA: ["Austrian", "#e3001b"],
  ICE: ["Icelandair", "#1a3d7c"], UAE: ["Emirates", "#c8102e"], FDX: ["FedEx", "#4d148c"], UPS: ["UPS", "#351c15"],
  DHK: ["DHL", "#ffcc00"], BCS: ["DHL", "#ffcc00"], ETD: ["Etihad", "#bd8b13"], CPA: ["Cathay Pacific", "#006564"],
  JAL: ["Japan Airlines", "#c8102e"], KAL: ["Korean Air", "#5aa7de"], TAP: ["TAP", "#00a650"], IBE: ["Iberia", "#d7192d"],
};
const PLANE_COLOR = "#7b8794";
const airlineOf = (callsign) => (/^[A-Z]{3}\d/.test(callsign ?? "") ? AIRLINES[callsign.slice(0, 3)] : null);

// Kartio y-akselin suuntaan (rungon nokka ja pyrstö).
function coneY(s, cx, cz, y0, r0, y1, r1, color, n = 14) {
  const center = [cx, (y0 + y1) / 2, cz];
  const at = (i, y, r) => [cx + r * Math.cos((i / n) * Math.PI * 2), y, cz + r * Math.sin((i / n) * Math.PI * 2)];
  for (let i = 0; i < n; i++) {
    const a0 = at(i, y0, r0), a1 = at(i + 1, y0, r0), b0 = at(i, y1, r1), b1 = at(i + 1, y1, r1);
    s.tri(a0, a1, b1, color, center);
    s.tri(a0, b1, b0, color, center);
  }
}

// Matkustajakone (A320-kokoluokka, 38 m): origo painopisteessä, keula +y.
function planeBodyModel() {
  const s = new Shape(), white = col("#f3f5f7"), grey = col("#aeb6bf"), dark = col("#36414b");
  s.cyl("y", 0, -2, 0, 2.0, 30, white, 16);
  coneY(s, 0, 0, 13, 2.0, 18.5, 0.25, white);
  coneY(s, 0, 0.4, -17, 2.0, -21, 0.45, white);
  s.box(-1.0, 1.0, 14.6, 15.4, 0.7, 1.25, dark); // ohjaamon ikkunat
  for (const sx of [-1, 1]) {
    s.hexa([[sx * 1.8, 3, -1.4], [sx * 1.8, -4.5, -1.4], [sx * 17.5, -10, -0.5], [sx * 17.5, -7.5, -0.5],
      [sx * 1.8, 3, -0.8], [sx * 1.8, -4.5, -0.8], [sx * 17.5, -10, -0.25], [sx * 17.5, -7.5, -0.25]], white);
    s.hexa([[sx * 0.8, -15, 0.6], [sx * 0.8, -19, 0.6], [sx * 6.5, -21, 0.9], [sx * 6.5, -19.3, 0.9],
      [sx * 0.8, -15, 0.9], [sx * 0.8, -19, 0.9], [sx * 6.5, -21, 1.1], [sx * 6.5, -19.3, 1.1]], white);
    s.cyl("y", sx * 5.8, 2.2, -2.3, 1.05, 4.2, grey, 12); // moottori
  }
  return s.geometry();
}

// Sivuvakaaja erikseen: se väritetään lentoyhtiön värillä.
function planeTailModel() {
  const s = new Shape(), w = col("#ffffff");
  s.hexa([[-0.25, -12, 1.6], [-0.25, -19.5, 1.6], [0.25, -19.5, 1.6], [0.25, -12, 1.6],
    [-0.15, -17.2, 8.5], [-0.15, -20.5, 8.5], [0.15, -20.5, 8.5], [0.15, -17.2, 8.5]], w);
  return s.geometry();
}

function heliModel() {
  const s = new Shape(), body = col("#d64541"), dark = col("#2b2f33");
  s.cyl("y", 0, 0.5, 0, 1.3, 5, body, 14);
  coneY(s, 0, 0, 3, 1.3, 4.6, 0.45, body);
  s.box(-0.25, 0.25, -7.5, -2, -0.3, 0.3, body); // pyrstöpuomi
  s.box(-0.1, 0.1, -7.9, -7.0, 0, 1.7, body);
  s.box(-0.15, 0.15, -0.15, 0.15, 1.2, 1.9, dark);
  s.box(-5.2, 5.2, -0.15, 0.15, 1.9, 1.98, dark); // roottori
  s.box(-0.15, 0.15, -5.2, 5.2, 1.9, 1.98, dark);
  for (const sx of [-1, 1]) s.box(sx * 0.85, sx * 1.0, -2, 2.5, -1.65, -1.5, dark); // jalakset
  return s.geometry();
}

// ADS-B:n kokoluokka (category) mallin kokona.
const PLANE_SIZE = { A1: 0.35, A2: 0.75, A3: 1, A4: 1.15, A5: 1.65, A6: 0.5, B1: 0.4, B4: 0.4, B6: 0.3 };

const planeMeshes = (() => {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const make = (geometry) => {
    const mesh = new THREE.InstancedMesh(geometry, material, PLANE_CAP);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);
    return mesh;
  };
  const tail = make(planeTailModel());
  tail.setColorAt(0, new THREE.Color(PLANE_COLOR)); // instanssivärit käyttöön heti
  return { body: make(planeBodyModel()), tail, heli: make(heliModel()) };
})();

// Pystyviiva koneesta maahan havainnollistaa korkeutta.
const dropPos = new Float32Array(PLANE_CAP * 6);
const dropLines = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(dropPos, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
  lines.frustumCulled = false;
  scene.add(lines);
  return lines;
})();
const planeDummy = new THREE.Object3D();
planeDummy.rotation.order = "ZXY";

const place = (a) => (a ? `${a.municipality || a.name}${a.iata_code ? ` (${a.iata_code})` : ""}` : null);

// Reitti haetaan kerran lentotunnusta kohden. Palauttaa null, kun tietoa haetaan tai sitä ei ole.
function routeFor(callsign) {
  if (!callsign) return null;
  if (routes.has(callsign)) return routes.get(callsign) || null;
  routes.set(callsign, null);
  fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const fr = j?.response?.flightroute;
      routes.set(callsign, fr ? {
        airline: fr.airline?.name, flight: fr.callsign_iata, from: place(fr.origin), to: place(fr.destination),
        icaos: [fr.origin?.icao_code, fr.destination?.icao_code],
      } : false);
    })
    .catch(() => routes.set(callsign, false));
  return null;
}

async function pollPlanes() {
  if (!planeState.url || document.hidden) return;
  try {
    const r = await fetch(planeState.url, { cache: "no-store" });
    if (!r.ok) throw new Error(`adsb.fi ${r.status}`);
    const data = await r.json(), now = Date.now();
    for (const a of data.aircraft ?? []) updatePlane(a, now);
    planeState.ok = true;
  } catch {
    planeState.ok = false;
  }
}

const angleDiff = (a, b) => ((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;

function predictFix(f, t) {
  const dt = Math.min(Math.max((t - f.t) / 1000, 0), 20);
  return [f.x + f.vx * dt, f.y + f.vy * dt, f.alt + f.vz * dt];
}

function predictPlane(p, t) {
  const q = predictFix(p.fix, t), d = Math.exp(-(t - p.errAt) / PLANE_CORRECT_MS);
  return [q[0] + p.err[0] * d, q[1] + p.err[1] * d, q[2] + p.err[2] * d];
}

function updatePlane(a, now) {
  const geom = typeof a.alt_geom === "number", baro = typeof a.alt_baro === "number";
  if (a.lat == null || a.lon == null || (!geom && !baro)) return; // maassa tai ilman korkeutta
  const id = `plane/${a.hex}`;
  const [x, y] = toLocal(a.lon, a.lat);
  let p = planes.get(id);
  if (!nearRegion(x, y, PLANE_MARGIN)) { if (p) removePlane(p); return; }
  const v = (a.gs ?? 0) * KT, track = (a.track ?? a.true_heading ?? 0) * D2R;
  const fix = {
    t: now - (a.seen_pos ?? 0) * 1000, x, y, track,
    alt: geom ? a.alt_geom * FT - GEOID : a.alt_baro * FT,
    vx: v * Math.sin(track), vy: v * Math.cos(track), vz: ((a.geom_rate ?? a.baro_rate ?? 0) * FT) / 60,
  };
  if (!p) {
    p = { isPlane: true, id, hex: a.hex, fix, err: [0, 0, 0], errAt: now, heading: track, roll: 0, turn: 0, info: {} };
    planes.set(id, p);
  } else if (fix.t > p.fix.t) {
    // Uusi sijainti: ero vanhan ja uuden ennusteen välillä häivytetään, jottei kone hyppää.
    const old = predictPlane(p, now), nu = predictFix(fix, now);
    p.err = Math.hypot(old[0] - nu[0], old[1] - nu[1]) < 2000 ? [old[0] - nu[0], old[1] - nu[1], old[2] - nu[2]] : [0, 0, 0];
    p.errAt = now;
    p.turn = angleDiff(track, p.fix.track) / Math.max((fix.t - p.fix.t) / 1000, 0.5);
    p.fix = fix;
  }
  p.lastRx = now;
  const callsign = (a.flight ?? "").trim();
  const route = routeFor(callsign), airline = airlineOf(callsign);
  // Kaupallisten reittien tietokanta voi olla vanhentunut: matalalla Espoon yllä lentävä kone on
  // lähes aina menossa Helsinki-Vantaalle tai tulossa sieltä.
  const uncertain = route && fix.alt < 3000 && !route.icaos.includes("EFHK");
  p.info = {
    callsign, reg: a.r, type: a.desc ?? a.t, category: a.category, alt: fix.alt, spd: v, vz: fix.vz,
    airline: route?.airline ?? airline?.[0], flight: route?.flight, route: route?.from && route?.to ? `${route.from} → ${route.to}` : null, uncertain,
  };
  p.color = new THREE.Color(airline?.[1] ?? PLANE_COLOR);
  p.colorHex = airline?.[1] ?? PLANE_COLOR;
  p.label = route?.flight || callsign || a.r || a.hex.toUpperCase();
  p.roll0 = typeof a.roll === "number" ? a.roll * D2R : null;
}

function removePlane(p) {
  planes.delete(p.id);
  if (selected === p) { selected = null; popup.remove(); }
}

// Koneet piirretään kaikilla zoomaustasoilla; kaukaa katsottaessa suurennettuina.
function drawPlanes(map, ctx) {
  const { zoom, cmx, cmy, sc, cosC, centerElev, e, W, H, now } = ctx;
  const wall = Date.now(), kh = 1 - Math.exp(-lastDt / 400);
  const enlarge = Math.min(14, Math.max(1, 2 ** ((14 - zoom) * 0.85)));
  let nb = 0, nh = 0, nl = 0;
  for (const p of planes.values()) {
    const [x, y, alt] = predictPlane(p, wall);
    p.x = x; p.y = y;
    const lon = lonOf(x), lat = latOf(y), k = cosC / Math.cos(lat * D2R);
    p.heading += angleDiff(p.fix.track, p.heading) * kh;
    // Kallistus ilmoitetusta arvosta tai kääntymisnopeudesta (koordinoitu kaarto).
    const rollTarget = p.roll0 ?? Math.max(-0.5, Math.min(0.5, Math.atan((Math.hypot(p.fix.vx, p.fix.vy) * p.turn) / 9.81)));
    p.roll += (rollTarget - p.roll) * kh;
    const pitch = Math.max(-0.25, Math.min(0.25, Math.atan2(p.fix.vz, Math.max(Math.hypot(p.fix.vx, p.fix.vy), 30))));
    if (p.groundAt == null || now - p.groundAt > 1000) {
      p.ground = (map.queryTerrainElevation([lon, lat]) ?? 0) + centerElev;
      p.groundAt = now + Math.random() * 200;
    }
    const ground = (p.ground - centerElev) * k;
    const wx = (mercX(lon) - cmx) / sc, wy = -(mercY(lat) - cmy) / sc;
    const wz = Math.max((alt - centerElev) * k, ground + 2 * k);
    const size = k * enlarge * (PLANE_SIZE[p.info.category] ?? 1);
    planeDummy.position.set(wx, wy, wz);
    planeDummy.rotation.set(pitch, p.roll, -p.heading);
    planeDummy.scale.setScalar(size);
    planeDummy.updateMatrix();
    if (p.info.category === "A7") {
      if (nh < PLANE_CAP) planeMeshes.heli.setMatrixAt(nh++, planeDummy.matrix);
    } else if (nb < PLANE_CAP) {
      planeMeshes.body.setMatrixAt(nb, planeDummy.matrix);
      planeMeshes.tail.setMatrixAt(nb, planeDummy.matrix);
      planeMeshes.tail.setColorAt(nb, p.color);
      nb++;
    }
    if (nl < PLANE_CAP) {
      dropPos.set([wx, wy, wz, wx, wy, ground], nl * 6);
      nl++;
    }
    p.screen = toScreen(e, wx, wy, wz, W, H);
    p.screenAt = now;
    const top = toScreen(e, wx, wy, wz + 10 * size, W, H);
    if (top && top[0] > -60 && top[0] < W + 60 && top[1] > -30 && top[1] < H + 60) {
      placeLabel(p.id, p.label, p.colorHex, "vlabel plane", top[0], top[1]);
    }
  }
  for (const [name, n] of [["body", nb], ["tail", nb], ["heli", nh]]) {
    planeMeshes[name].count = n;
    planeMeshes[name].instanceMatrix.needsUpdate = true;
  }
  if (planeMeshes.tail.instanceColor) planeMeshes.tail.instanceColor.needsUpdate = true;
  dropLines.geometry.setDrawRange(0, nl * 2);
  dropLines.geometry.attributes.position.needsUpdate = true;
}

function planeContent(p) {
  const i = p.info, fmt = (n) => Math.round(n).toLocaleString("fi-FI");
  const climb = Math.abs(i.vz) < 0.5 ? "vaakalento" : `${i.vz > 0 ? "nousee" : "laskeutuu"} ${Math.abs(i.vz).toFixed(1).replace(".", ",")} m/s`;
  const rows = [
    ["Yhtiö", i.airline],
    ["Reitti", i.route && (i.uncertain ? `${i.route} (tieto voi olla vanhentunut)` : i.route)],
    ["Lentotunnus", i.callsign && i.callsign !== p.label ? i.callsign : null],
    ["Kone", [i.type, i.reg].filter(Boolean).join(", ") || null],
    ["Korkeus", `${fmt(i.alt)} m`],
    ["Nopeus", `${fmt(i.spd * 3.6)} km/h`],
    ["Pystysuunta", climb],
  ].filter(([, val]) => val);
  return node("div", { class: "pop" },
    node("div", { class: "kind" }, i.category === "A7" ? "Helikopteri" : "Lentokone"),
    node("h3", {}, p.label),
    node("table", {}, rows.map(([k, val]) => node("tr", {}, node("th", {}, k), node("td", {}, val)))));
}

// ------------------------------------------------------------ laivat ja veneet

// Espoon merialueen alukset Digitrafficin AIS-sijainneista. Sijainnit haetaan kymmenen sekunnin
// välein, ja välissä alusta liikutetaan nopeuden ja kurssin mukaan. Nimi, tyyppi, määränpää ja
// mitat haetaan kerran alusta kohden; mittojen avulla malli on oikean kokoinen ja oikeassa
// kohdassa (AIS-sijainti on GPS-antennin paikka, ei aluksen keskikohta).
const SHIP_API = "https://meri.digitraffic.fi/api/ais/v1";
const SHIP_AREA = "latitude=60.12&longitude=24.70&radius=25"; // km
const SHIP_POLL = 10000; // ms
const SHIP_MAX_AGE = 30 * 60000; // tätä vanhempia sijainteja ei näytetä
const SHIP_MARGIN = 2000; // m: alukset näkyvät vielä näin kaukana Espoon rajan takana
const SHIP_HEADERS = { "Digitraffic-User": "Espoo3D" };
const SHIP_COLOR = "#1d6fa5";
const SHIP_LAND = 5; // m: paikallaan oleva lähetin tätä korkeammalla maalla ei ole vesillä
const ships = new Map();
const shipMeta = new Map();
const shipState = { ok: true };

// AIS:n alustyyppi mallin ja kuvauksen mukaan.
function shipClass(type, length) {
  if (type === 36) return ["sail", "Purjevene"];
  if (type === 37) return ["motor", "Huvivene"];
  if (type === 30) return ["work", "Kalastusalus"];
  if (type === 31 || type === 32 || type === 52) return ["work", "Hinaaja"];
  if (type === 35) return ["work", "Sotilasalus"];
  if (type === 50) return ["work", "Luotsivene"];
  if (type === 51) return ["work", "Meripelastusalus"];
  if (type === 55) return ["work", "Viranomaisalus"];
  if ((type >= 33 && type <= 34) || (type >= 53 && type <= 59)) return ["work", "Työalus"];
  if (type >= 40 && type <= 49) return ["passenger", "Pika-alus"];
  if (type >= 60 && type <= 69) return ["passenger", "Matkustaja-alus"];
  if (type >= 70 && type <= 79) return ["cargo", "Rahtialus"];
  if (type >= 80 && type <= 89) return ["tanker", "Säiliöalus"];
  if (length >= 60) return ["tanker", "Alus"];
  if (length >= 15) return ["work", "Alus"];
  return ["motor", "Vene"];
}

const NAV_STATUS = {
  0: "Konevoimalla matkalla", 1: "Ankkurissa", 2: "Ei ohjattavissa", 3: "Rajoitettu ohjailukyky",
  4: "Syväyksen rajoittama", 5: "Kiinnitettynä", 6: "Karilla", 7: "Kalastamassa", 8: "Purjeilla matkalla",
};
// Lippuvaltio MMSI-numeron kolmesta ensimmäisestä numerosta (yleisimmät).
const FLAGS = {
  230: "Suomi", 276: "Viro", 265: "Ruotsi", 266: "Ruotsi", 257: "Norja", 258: "Norja", 259: "Norja",
  211: "Saksa", 218: "Saksa", 219: "Tanska", 220: "Tanska", 273: "Venäjä", 275: "Latvia", 277: "Liettua",
  244: "Alankomaat", 245: "Alankomaat", 246: "Alankomaat", 305: "Antigua ja Barbuda", 209: "Kypros",
  210: "Kypros", 212: "Kypros", 248: "Malta", 249: "Malta", 256: "Malta", 636: "Liberia", 538: "Marshallinsaaret",
};

// Runko: perä suora, keula suippenee. Pohja on hieman vesirajan alla.
function hullShape(s, L, W, top, color, bow = 0.2) {
  const hl = L / 2, hw = W / 2, yb = hl - L * bow, rise = top * 0.15;
  s.box(-hw, hw, -hl, yb, -0.6, top, color);
  s.hexa([[-hw, yb, -0.6], [hw, yb, -0.6], [hw * 0.08, hl, -0.6], [-hw * 0.08, hl, -0.6],
    [-hw, yb, top], [hw, yb, top], [hw * 0.08, hl, top + rise], [-hw * 0.08, hl, top + rise]], color);
}

// Mallit: x poikittain, y pituussuunnassa (keula +y), z ylöspäin, origo keskellä vesirajassa.
function cargoShipModel() {
  const s = new Shape(), white = col("#eef0f2");
  hullShape(s, 100, 16, 7, col("#2f3e4e"));
  s.box(-7.6, 7.6, -48, 28, 7, 7.3, col("#5d4037"));
  const boxes = ["#c0392b", "#2c7bb6", "#e67e22", "#7f8c8d", "#27ae60", "#8e44ad"].map(col);
  let c = 0;
  for (let y = -28; y < 26; y += 6.5) {
    for (const x of [-5, 0, 5]) { // kontit kahdessa tai yhdessä kerroksessa
      s.box(x - 2.3, x + 2.3, y, y + 6, 7.3, 7.3 + ((c * 7) % 3 ? 5.2 : 2.6), boxes[c % boxes.length]);
      c++;
    }
  }
  s.box(-7, 7, -46, -36, 7.3, 19, white); // komentosilta
  s.box(-7.6, 7.6, -40, -36.5, 17, 19.5, white);
  s.box(-6.6, 6.6, -36.1, -35.8, 16, 18, P.glass);
  s.box(-1.6, 1.6, -45, -42, 19, 24, col("#c0392b")); // savupiippu
  return s.geometry();
}

function tankerModel() {
  const s = new Shape(), white = col("#eef0f2");
  hullShape(s, 100, 16, 7, col("#5b1f1f"));
  s.box(-7.6, 7.6, -48, 42, 7, 7.3, col("#8a3b2e"));
  s.box(-0.6, 0.6, -34, 38, 7.3, 8.3, col("#b0b6bb")); // putkisto
  s.box(-7, 7, -46, -36, 7.3, 19, white);
  s.box(-6.6, 6.6, -36.1, -35.8, 16, 18, P.glass);
  s.box(-1.6, 1.6, -45, -42, 19, 24, col("#1f2d3a"));
  return s.geometry();
}

function passengerModel() {
  const s = new Shape(), white = col("#f4f5f6"), blue = col("#1f5fa8");
  hullShape(s, 40, 9, 3.2, white, 0.22);
  s.box(-4.55, 4.55, -20, 11, 0.8, 1.3, blue); // vyö
  s.box(-4, 4, -17, 8, 3.2, 5.6, white);
  s.box(-4.05, 4.05, -16, 7, 4.0, 5.0, P.glass);
  s.box(-3.4, 3.4, -12, 4, 5.6, 7.8, white);
  s.box(-3.45, 3.45, -11, 3.5, 6.3, 7.2, P.glass);
  s.box(-2.6, 2.6, 0, 3, 7.8, 9.2, white); // komentosilta
  s.box(-0.8, 0.8, -9, -7, 7.8, 10, blue); // savupiippu
  return s.geometry();
}

function workboatModel() {
  const s = new Shape(), white = col("#f2f2ef");
  hullShape(s, 20, 6, 2.2, col("#c0392b"), 0.25);
  s.box(-2.3, 2.3, -3, 4, 2.2, 5.0, white); // ohjaamo
  s.box(-2.35, 2.35, 1, 3.8, 3.8, 4.7, P.glass);
  s.box(-0.15, 0.15, 0, 0.3, 5.0, 8.5, P.dark); // masto
  s.box(-1.0, 1.0, -9.5, -5, 2.2, 2.6, P.dark);
  return s.geometry();
}

function sailboatModel() {
  const s = new Shape(), white = col("#f6f6f3"), sail = col("#fbfbf8");
  hullShape(s, 11, 3.6, 1.2, white, 0.3);
  s.box(-1.1, 1.1, -2.5, 1.5, 1.2, 2.0, white); // kajuutta
  s.box(-0.08, 0.08, 0.8, 1.0, 1.2, 15, P.dark); // masto
  s.hexa([[-0.03, 0.8, 1.9], [0.03, 0.8, 1.9], [0.03, -3.6, 1.9], [-0.03, -3.6, 1.9], // isopurje
    [-0.03, 0.8, 14.5], [0.03, 0.8, 14.5], [0.03, 0.6, 14.5], [-0.03, 0.6, 14.5]], sail);
  s.hexa([[-0.03, 5.2, 1.3], [0.03, 5.2, 1.3], [0.03, 1.0, 1.6], [-0.03, 1.0, 1.6], // keulapurje
    [-0.03, 1.05, 13], [0.03, 1.05, 13], [0.03, 1.0, 13], [-0.03, 1.0, 13]], sail);
  return s.geometry();
}

function motorboatModel() {
  const s = new Shape(), white = col("#f4f4f1");
  hullShape(s, 9, 3, 1.0, white, 0.3);
  s.box(-1.2, 1.2, -1, 1.2, 1.0, 1.9, white);
  s.box(-1.25, 1.25, 0.9, 1.3, 1.2, 1.8, P.glass); // tuulilasi
  return s.geometry();
}

// Malli, sen luonnollinen pituus ja leveys (m) sekä instanssien enimmäismäärä.
const SHIP_MODELS = {
  cargo: [cargoShipModel, 100, 16, 60], tanker: [tankerModel, 100, 16, 60], passenger: [passengerModel, 40, 9, 80],
  work: [workboatModel, 20, 6, 150], sail: [sailboatModel, 11, 3.6, 300], motor: [motorboatModel, 9, 3, 300],
};
const shipMeshes = Object.fromEntries(Object.entries(SHIP_MODELS).map(([key, [build, , , cap]]) => {
  const mesh = new THREE.InstancedMesh(build(), new THREE.MeshLambertMaterial({ vertexColors: true }), cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  return [key, mesh];
}));
const shipDummy = new THREE.Object3D();

// Aluksen tiedot haetaan kerran. Palauttaa null, kun tietoa vielä haetaan tai sitä ei ole.
function metaFor(mmsi) {
  if (shipMeta.has(mmsi)) return shipMeta.get(mmsi) || null;
  shipMeta.set(mmsi, null);
  fetch(`${SHIP_API}/vessels/${mmsi}`, { headers: SHIP_HEADERS })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => shipMeta.set(mmsi, m || false))
    .catch(() => shipMeta.set(mmsi, false));
  return null;
}

async function pollShips() {
  if (document.hidden) return;
  try {
    const r = await fetch(`${SHIP_API}/locations?${SHIP_AREA}`, { headers: SHIP_HEADERS });
    if (!r.ok) throw new Error(`Digitraffic ${r.status}`);
    const data = await r.json(), now = Date.now();
    for (const f of data.features ?? []) updateShip(f, now);
    shipState.ok = true;
  } catch {
    shipState.ok = false;
  }
}

function predictShipFix(f, t) {
  const dt = Math.min(Math.max((t - f.t) / 1000, 0), 90);
  return [f.x + f.vx * dt, f.y + f.vy * dt];
}

function predictShip(sh, t) {
  const q = predictShipFix(sh.fix, t), d = Math.exp(-(t - sh.errAt) / 2000);
  return [q[0] + sh.err[0] * d, q[1] + sh.err[1] * d];
}

function updateShip(f, now) {
  const p = f.properties, [lon, lat] = f.geometry.coordinates, t = p.timestampExternal;
  if (!(now - t < SHIP_MAX_AGE)) return; // vanha sijainti (lähetin ollut pitkään pois päältä)
  const id = `ship/${p.mmsi}`, [x, y] = toLocal(lon, lat);
  let sh = ships.get(id);
  if (!nearRegion(x, y, SHIP_MARGIN)) { if (sh) removeShip(sh); return; }
  const v = (p.sog ?? 0) >= 0.3 ? p.sog * KT : 0, cog = (p.cog ?? 0) * D2R;
  const fix = { t, x, y, vx: v * Math.sin(cog), vy: v * Math.cos(cog) };
  // Keulan suunta: ilmoitettu keulasuunta (511 = ei tiedossa) tai liikkuvan aluksen kurssi.
  const heading = p.heading != null && p.heading !== 511 ? p.heading * D2R : v > 0.5 ? cog : null;
  if (!sh) {
    sh = { isShip: true, id, mmsi: p.mmsi, fix, err: [0, 0], errAt: now, heading: heading ?? cog, targetHeading: heading };
    ships.set(id, sh);
  } else if (t > sh.fix.t) {
    const old = predictShip(sh, now), nu = predictShipFix(fix, now);
    sh.err = Math.hypot(old[0] - nu[0], old[1] - nu[1]) < 300 ? [old[0] - nu[0], old[1] - nu[1]] : [0, 0];
    sh.errAt = now;
    sh.fix = fix;
  }
  if (heading != null) sh.targetHeading = heading;
  sh.sog = p.sog ?? 0;
  sh.navStat = p.navStat;
  sh.lastSeen = now;
  sh.meta = metaFor(p.mmsi);
}

function removeShip(sh) {
  ships.delete(sh.id);
  if (selected === sh) { selected = null; popup.remove(); }
}

function advanceShips(wall, dt) {
  const kh = 1 - Math.exp(-dt / 600);
  for (const sh of ships.values()) {
    [sh.x, sh.y] = predictShip(sh, wall);
    if (sh.targetHeading != null) sh.heading += angleDiff(sh.targetHeading, sh.heading) * kh;
  }
}

// AIS-lähettimiä on myös maalla (esim. tukiasemat ja laitevalmistajien testilaitteet). Paikallaan
// oleva lähetin, jonka kohdalla maasto on selvästi merenpintaa korkeammalla, jätetään pois.
function onLand(sh, centerElev, exag, now) {
  if (sh.sog >= 0.5) return false;
  if (sh.landAt == null || now - sh.landAt > 5000) {
    sh.land = ((mapRef.queryTerrainElevation([lonOf(sh.x), latOf(sh.y)]) ?? 0) + centerElev) / exag > SHIP_LAND;
    sh.landAt = now;
  }
  return sh.land;
}

// Aluksen mitat: pituus, leveys ja antennin paikka keskikohdasta (eteen, oikealle).
function shipDims(sh) {
  const m = sh.meta, a = m?.referencePointA ?? 0, b = m?.referencePointB ?? 0, c = m?.referencePointC ?? 0, d = m?.referencePointD ?? 0;
  const [cls, label] = shipClass(m?.shipType ?? 0, a + b);
  const [, mL, mW] = SHIP_MODELS[cls];
  const known = a + b > 1 && c + d > 0.5;
  return { cls, label, L: known ? a + b : mL, W: known ? c + d : mW, ahead: known ? (a - b) / 2 : 0, right: known ? (d - c) / 2 : 0, known };
}

function drawShips(map, ctx) {
  const { zoom, cmx, cmy, sc, cosC, centerElev, exag, e, W, H, now } = ctx;
  for (const mesh of Object.values(shipMeshes)) mesh.count = 0;
  if (zoom < MODEL_MINZOOM) return; // kaukaa pisteinä
  const enlarge = Math.min(MAX_ENLARGE, Math.max(1, 2 ** ((15 - zoom) * 0.6)));
  for (const sh of ships.values()) {
    if (sh.x == null || onLand(sh, centerElev, exag, now)) continue;
    const dim = shipDims(sh), [, mL, mW] = SHIP_MODELS[dim.cls], mesh = shipMeshes[dim.cls];
    if (mesh.count >= mesh.instanceMatrix.count) continue;
    // Mallin keskikohta antennin paikasta aluksen mittojen mukaan.
    const fx = Math.sin(sh.heading), fy = Math.cos(sh.heading);
    const cx = sh.x + fx * dim.ahead + fy * dim.right, cy = sh.y + fy * dim.ahead - fx * dim.right;
    const lon = lonOf(cx), lat = latOf(cy), k = cosC / Math.cos(lat * D2R);
    const wx = (mercX(lon) - cmx) / sc, wy = -(mercY(lat) - cmy) / sc, wz = -centerElev * k; // merenpinta
    const sx = dim.W / mW, sy = dim.L / mL, sz = Math.min(2, Math.max(0.5, Math.sqrt(sx * sy)));
    shipDummy.position.set(wx, wy, wz);
    shipDummy.rotation.set(0, 0, -sh.heading);
    shipDummy.scale.set(sx * k * enlarge, sy * k * enlarge, sz * k * enlarge);
    shipDummy.updateMatrix();
    mesh.setMatrixAt(mesh.count++, shipDummy.matrix);
    sh.screen = toScreen(e, wx, wy, wz + 3 * k * enlarge, W, H);
    sh.screenAt = now;
    // Nimi liikkuvien ja isojen alusten yllä; laitureissa olevat veneet ilman nimeä.
    if (sh.meta?.name && (sh.sog > 1 || dim.L >= 40)) {
      const top = toScreen(e, wx, wy, wz + (8 + dim.L * 0.12) * sz * k * enlarge, W, H);
      if (top && top[0] > -60 && top[0] < W + 60 && top[1] > -30 && top[1] < H + 60) {
        placeLabel(sh.id, sh.meta.name.trim(), SHIP_COLOR, "vlabel ship", top[0], top[1]);
      }
    }
  }
  for (const mesh of Object.values(shipMeshes)) mesh.instanceMatrix.needsUpdate = true;
}

function shipSpeed(sh) {
  const knots = sh.sog ?? 0;
  return knots < 0.3 ? "paikallaan" : `${knots.toFixed(1).replace(".", ",")} solmua (${Math.round(knots * KT * 3.6)} km/h)`;
}

function shipContent(sh) {
  const m = sh.meta, dim = shipDims(sh);
  const rows = [
    ["Määränpää", m?.destination?.trim() || null],
    ["Nopeus", shipSpeed(sh)],
    ["Tila", NAV_STATUS[sh.navStat] ?? null],
    ["Pituus", dim.known ? `${Math.round(dim.L)} m` : null],
    ["Syväys", m?.draught ? `${(m.draught / 10).toFixed(1).replace(".", ",")} m` : null],
    ["Lippu", FLAGS[Math.floor(sh.mmsi / 1e6)] ?? null],
    ["MMSI", String(sh.mmsi)],
  ].filter(([, val]) => val);
  return node("div", { class: "pop" },
    node("div", { class: "kind" }, dim.label),
    node("h3", {}, m?.name?.trim() || `MMSI ${sh.mmsi}`),
    node("table", {}, rows.map(([k, val]) => node("tr", {}, node("th", {}, k), node("td", {}, val)))));
}

// ------------------------------------------------------------ sähköautot latauksessa

// Latauspisteiden tila tulee Fintrafficin AFIR-rajapinnasta (Digitraffic), joka kokoaa
// latausoperaattorien tiedot ja päivittää koosteen minuutin välein. Jokainen latauksessa oleva
// piste näytetään autona latauspaikan pysäköintiruudussa (ruudut: scripts/build_data.py, lataus.json).
// Ruudut täytetään järjestyksessä, joten autot ovat rinnakkain latauspaikan vieressä, ja auto pysyy
// samassa ruudussa koko latauksen ajan. Auton yllä välkkyy salama.
const CHARGE_API = "https://afir.digitraffic.fi/api/charging-network/v1/locations/statuses/all";
const CHARGE_POLL = 60000; // ms
const CHARGE_COLOR = "#f5b700";
const CHARGE_LABEL_MINZOOM = 14; // salama näkyy tätä lähempää
const BOLT_MAX_DIST = 1500; // m näkymän keskipisteestä (lähempää layers.js:n detailRadius)
const BOLT_SIZE = 22; // px
const CHARGE_CAP = 600;
const CAR_COLORS = ["#f2f3f1", "#1f2326", "#b9bec3", "#6e757b", "#2f5d8a", "#a8302c", "#1f3550", "#4d6b57", "#d9d4c7"].map(col);
const chargePoints = new Map(); // latauspisteen tunnus → { site, ref, kw, plug, pool, status, since }
const chargeCars = new Map(); // "charge/tunnus" → latauksessa oleva auto
const chargeState = { ok: true };

// Henkilöauto: x poikittain, y pituussuunnassa (keula +y), z ylöspäin, origo pohjan keskellä.
// Kori on valkoinen, ja sen väri tulee instanssin väristä; lasit, renkaat ja valot ovat omassa
// mallissaan, jotta niiden väri pysyy.
function carBodyModel() {
  const s = new Shape(), body = col("#ffffff"), hl = 2.3, hw = 0.92;
  s.box(-hw, hw, -hl, hl, 0.22, 0.78, body);
  s.hexa([[-hw, 1.0, 0.78], [hw, 1.0, 0.78], [hw, hl, 0.78], [-hw, hl, 0.78], // konepelti
    [-hw, 1.0, 0.98], [hw, 1.0, 0.98], [hw, hl - 0.05, 0.86], [-hw, hl - 0.05, 0.86]], body);
  s.hexa([[-hw, -hl, 0.78], [hw, -hl, 0.78], [hw, -1.4, 0.78], [-hw, -1.4, 0.78], // takaluukun alaosa
    [-hw, -hl + 0.05, 0.95], [hw, -hl + 0.05, 0.95], [hw, -1.4, 0.98], [-hw, -1.4, 0.98]], body);
  s.box(-0.7, 0.7, -1.15, 0.3, 1.47, 1.53, body); // katto
  return s.geometry();
}

function carTrimModel() {
  const s = new Shape(), hl = 2.3, hw = 0.92;
  s.hexa([[-hw + 0.06, -1.45, 0.98], [hw - 0.06, -1.45, 0.98], [hw - 0.06, 1.0, 0.98], [-hw + 0.06, 1.0, 0.98], // ikkunat
    [-0.72, -1.2, 1.48], [0.72, -1.2, 1.48], [0.72, 0.35, 1.48], [-0.72, 0.35, 1.48]], P.glass);
  for (const sx of [-1, 1]) {
    for (const y of [-1.45, 1.45]) s.cyl("x", sx * (hw - 0.1), y, 0.33, 0.33, 0.24, P.tire);
    s.box(sx * 0.42, sx * 0.8, hl - 0.02, hl + 0.03, 0.56, 0.7, P.light);
    s.box(sx * 0.45, sx * 0.86, -hl - 0.03, -hl + 0.02, 0.62, 0.74, P.red);
  }
  return s.geometry();
}

const carBody = new THREE.InstancedMesh(carBodyModel(), new THREE.MeshLambertMaterial({ vertexColors: true }), CHARGE_CAP);
const carTrim = new THREE.InstancedMesh(carTrimModel(), new THREE.MeshLambertMaterial({ vertexColors: true }), CHARGE_CAP);
for (const mesh of [carBody, carTrim]) {
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
}
carBody.setColorAt(0, CAR_COLORS[0]); // luo instanssien värit

// Salama on 3D-tason piste, jonka rakennukset ja maasto peittävät (syvyystesti). Se näkyy vain
// näkymän keskipisteen lähellä ja himmenee reunaa kohti; välkkyminen tulee materiaalin läpinäkyvyydestä.
function boltTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), h = 54, w = (h * 13) / 19, x0 = (64 - w) / 2, y0 = 5;
  g.beginPath();
  for (const [i, [px, py]] of [[62, 0], [6, 58], [44, 58], [30, 100], [96, 38], [57, 38], [78, 0]].entries()) {
    g[i ? "lineTo" : "moveTo"](x0 + (px / 100) * w, y0 + (py / 100) * h);
  }
  g.closePath();
  g.shadowColor = "rgba(255, 200, 0, 0.9)";
  g.shadowBlur = 8;
  g.fillStyle = "#ffd21f";
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 2.5;
  g.strokeStyle = "rgba(0, 0, 0, 0.6)";
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const boltPos = new Float32Array(CHARGE_CAP * 3), boltCol = new Float32Array(CHARGE_CAP * 4).fill(1);
const bolts = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(boltPos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute("color", new THREE.BufferAttribute(boltCol, 4).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(g, new THREE.PointsMaterial({
    map: boltTexture(), size: BOLT_SIZE, sizeAttenuation: false, vertexColors: true,
    transparent: true, depthWrite: false, alphaTest: 0.02,
  }));
  points.frustumCulled = false;
  scene.add(points);
  return points;
})();

const hashOf = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7) >>> 0;

async function loadCharging(url) {
  const data = await fetch(url).then((r) => r.json());
  for (const p of data.paikat) {
    const site = { name: p.nimi, address: p.osoite, operator: p.operaattori, points: [],
      pools: p.ruudut.map((slots) => ({ slots, used: new Array(slots.length).fill(null) })) };
    for (const [id, kw, plug, ref, pool] of p.pisteet) {
      const pt = { id, site, kw, plug, ref, pool, status: null, since: null };
      site.points.push(pt);
      chargePoints.set(id, pt);
    }
  }
}

async function pollCharging() {
  if (document.hidden || !groupOn.lataus || !chargePoints.size) return;
  try {
    // Kooste päivittyy minuutin välein; välimuistissa oleva tarkistetaan palvelimelta.
    const r = await fetch(CHARGE_API, { cache: "no-cache" });
    if (!r.ok) throw new Error(`AFIR ${r.status}`);
    for (const st of (await r.json()).statuses ?? []) {
      const pt = chargePoints.get(st.evseId);
      if (!pt) continue;
      pt.status = st.status;
      pt.since = st.modifiedAt ? Date.parse(st.modifiedAt) : null;
    }
    chargeState.ok = true;
    syncChargeCars();
  } catch {
    chargeState.ok = false;
  }
}

function syncChargeCars() {
  for (const car of chargeCars.values()) {
    if (car.point.status === "CHARGING") continue;
    car.pool.used[car.slot] = null;
    chargeCars.delete(car.id);
    if (selected === car) { selected = null; popup.remove(); }
  }
  // Uudet lataukset alkamisjärjestyksessä: pisimpään ladanneet ovat lähimmissä ruuduissa.
  const fresh = [...chargePoints.values()]
    .filter((pt) => pt.status === "CHARGING" && !chargeCars.has(`charge/${pt.id}`))
    .sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  for (const pt of fresh) {
    const pool = pt.site.pools[pt.pool], slot = pool ? pool.used.indexOf(null) : -1;
    if (slot < 0) continue; // ruudut täynnä
    const id = `charge/${pt.id}`, [lon, lat, bearing] = pool.slots[slot], [x, y] = toLocal(lon, lat);
    pool.used[slot] = id;
    chargeCars.set(id, {
      isCharge: true, id, point: pt, pool, slot, lon, lat, x, y, yaw: -bearing * D2R,
      color: CAR_COLORS[hashOf(pt.id) % CAR_COLORS.length], elev: null, elevAt: 0, screen: null, screenAt: 0, dot: null, dotAt: 0,
    });
  }
}

function drawCharging(map, ctx) {
  const { zoom, cmx, cmy, sc, cosC, centerElev, e, W, H, now } = ctx;
  carBody.count = carTrim.count = 0;
  const c = map.getCenter(), boltR = zoom >= CHARGE_LABEL_MINZOOM ? Math.min(detailRadius(zoom) ?? 0, BOLT_MAX_DIST) : 0;
  let nBolts = 0;
  if (groupOn.lataus && zoom >= MODEL_MINZOOM) {
    for (const car of chargeCars.values()) {
      if (carBody.count >= CHARGE_CAP) break;
      if (car.elev == null || now - car.elevAt > 1000) {
        car.elev = (map.queryTerrainElevation([car.lon, car.lat]) ?? 0) + centerElev;
        car.elevAt = now + Math.random() * 200;
      }
      const k = cosC / Math.cos(car.lat * D2R);
      const wx = (mercX(car.lon) - cmx) / sc, wy = -(mercY(car.lat) - cmy) / sc, wz = (car.elev - centerElev + LIFT) * k;
      putInstance(carBody, wx, wy, wz, car.yaw, 0, k);
      carBody.setColorAt(carBody.count - 1, car.color);
      putInstance(carTrim, wx, wy, wz, car.yaw, 0, k);
      car.screen = toScreen(e, wx, wy, wz + 0.8 * k, W, H);
      car.screenAt = now;
      const dist = Math.hypot((car.lon - c.lng) * 111320 * Math.cos(c.lat * D2R), (car.lat - c.lat) * 111320);
      if (dist >= boltR) continue;
      boltPos[3 * nBolts] = wx; boltPos[3 * nBolts + 1] = wy; boltPos[3 * nBolts + 2] = wz + 2.6 * k;
      boltCol[4 * nBolts + 3] = Math.min(1, (boltR - dist) / (0.25 * boltR)); // himmenee reunaa kohti
      nBolts++;
    }
  }
  carBody.instanceMatrix.needsUpdate = carTrim.instanceMatrix.needsUpdate = true;
  carBody.instanceColor.needsUpdate = true;
  const g = bolts.geometry;
  g.setDrawRange(0, nBolts);
  g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
  bolts.material.size = BOLT_SIZE * (renderer ? renderer.getContext().drawingBufferWidth / W : 1);
  bolts.material.opacity = 0.3 + 0.7 * (0.5 + 0.5 * Math.cos((2 * Math.PI * now) / 1400));
}

const timeText = (t) => new Date(t).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });

function durationText(ms) {
  const min = Math.max(0, Math.round(ms / 60000)), h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} vrk`;
  return h ? `${h} h ${min % 60} min` : `${min} min`;
}

function chargeContent(car) {
  const pt = car.point, site = pt.site, count = (...st) => site.points.filter((p) => st.includes(p.status)).length;
  const busy = count("CHARGING", "BLOCKED", "RESERVED"), free = count("AVAILABLE"), down = count("OUTOFORDER", "INOPERATIVE");
  const since = pt.since == null ? null
    : `${new Date(pt.since).toDateString() === new Date().toDateString() ? "" : new Date(pt.since).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" }) + " "}`
      + `klo ${timeText(pt.since)} alkaen (${durationText(Date.now() - pt.since)})`;
  const rows = [
    ["Operaattori", site.operator],
    ["Osoite", site.address],
    ["Latauspiste", [pt.plug, pt.kw ? `${pt.kw} kW` : null].filter(Boolean).join(", ") || null],
    ["Latauksessa", since],
    ["Latauspaikalla", `${site.points.length} pistettä: ${busy} käytössä, ${free} vapaana${down ? `, ${down} pois käytöstä` : ""}`],
  ].filter(([, val]) => val);
  return node("div", { class: "pop" },
    node("div", { class: "kind" }, "Sähköauto latauksessa"),
    node("h3", {}, site.name),
    node("table", {}, rows.map(([k, val]) => node("tr", {}, node("th", {}, k), node("td", {}, val)))),
    node("p", { class: "more" }, "Latausoperaattori kertoo vain latauspisteen tilan, joten auton paikka ja ulkonäkö ovat havainnollisia."));
}

// ------------------------------------------------------------ maamerkit

// Maamerkin malli on joko käsin tehty (landmarks.js) tai Espoon 3D-kaupunkimallista (lod2), jolloin
// malli voi päivittää maamerkin paikan ladattuaan.
const landmarks = LANDMARKS.map((l) => {
  const build = LANDMARK_MODELS[l.id] ?? (l.lod2 ? lod2Landmark : null);
  if (!build) return null;
  const entry = { ...l, obj: null, screen: null, rect: null };
  entry.obj = build(entry);
  entry.obj.matrixAutoUpdate = false;
  scene.add(entry.obj);
  return entry;
}).filter(Boolean);

// Maamerkit näkyvät samalta etäisyydeltä kuin 3D-rakennukset. Klikkausta varten lasketaan mallin
// rajauslaatikon ala näytöllä (rect: [x0, y0, x1, y1]).
function drawLandmarks(map, ctx) {
  const { zoom, cmx, cmy, sc, cosC, e, W, H } = ctx;
  for (const l of landmarks) {
    l.obj.visible = zoom >= 11;
    l.screen = l.rect = null;
    if (!l.obj.visible) continue;
    if (!l.obj.userData.box && l.obj.children.length) {
      l.obj.matrix.identity();
      l.obj.updateMatrixWorld(true);
      l.obj.userData.box = new THREE.Box3().setFromObject(l.obj);
    }
    const k = cosC / Math.cos(l.lat * D2R);
    const wx = (mercX(l.lon) - cmx) / sc, wy = -(mercY(l.lat) - cmy) / sc;
    const wz = (map.queryTerrainElevation([l.lon, l.lat]) ?? 0) * k;
    l.obj.matrix.makeScale(k, k, k).setPosition(wx, wy, wz);
    l.obj.matrixWorldNeedsUpdate = true;
    l.screen = toScreen(e, wx, wy, wz + (l.obj.userData.anchor ?? 40) * k, W, H);
    const box = l.obj.userData.box;
    if (!box) continue;
    const rect = [Infinity, Infinity, -Infinity, -Infinity];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const s = toScreen(e, wx + x * k, wy + y * k, wz + z * k, W, H);
          if (!s) { rect[0] = NaN; continue; }
          rect[0] = Math.min(rect[0], s[0]); rect[1] = Math.min(rect[1], s[1]);
          rect[2] = Math.max(rect[2], s[0]); rect[3] = Math.max(rect[3], s[1]);
        }
      }
    }
    if (!Number.isNaN(rect[0])) l.rect = rect;
  }
}

// Muiden moduulien 3D-kohteet samalle tasolle (esim. purojen virtaus, streams.js):
// { object, draw(map, ctx), animating() }. object lisätään näkymään, draw kutsutaan joka ruudussa,
// ja kartta piirretään jatkuvasti, kun animating() on tosi.
const extras = [];
const extrasAnimating = () => extras.some((x) => x.animating());

export function addExtra(extra) {
  extras.push(extra);
  scene.add(extra.object);
  mapRef?.triggerRepaint();
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
  advanceShips(wall, dt);
  if (selected) popup.setLngLat(anchorOf(selected, now));
}

// Ikkunan kohta kartalla. Maan alla kulkevan metron ja ilmassa olevan koneen kohdalla ikkuna
// kiinnitetään maanpinnan kohtaan, jonka edessä kohde näkyy ruudulla.
function anchorOf(sel, now) {
  let scr = null;
  if (sel.isPlane) scr = sel.screenAt > now - 500 ? sel.screen : null;
  else if (KINDS[sel.kind]?.underground && sel.drawnAt > now - 500 && sel.screen?.length) {
    const n = sel.screen.length / 2;
    scr = [sel.screen[2 * (n >> 1)], sel.screen[2 * (n >> 1) + 1]];
  }
  const own = [lonOf(sel.x), latOf(sel.y)];
  if (!scr) return own;
  const ll = mapRef.unproject(scr);
  // Taivasta vasten näkyvän kohdan maanpinta voi olla kaukana; silloin käytetään kohteen omaa paikkaa.
  return Math.abs(ll.lng - own[0]) < 0.5 && Math.abs(ll.lat - own[1]) < 0.25 ? ll : own;
}

const pts = new Float64Array(64), ptsZ = new Float64Array(32);

// Ajoneuvon korkeus pisteessä absoluuttisena, maaston korostus mukana. 3D-siltojen (pelimaasto.js)
// kohdalla korkeusmallin jänne on auki, joten kannen korkeus tulee sillasta; muiden siltojen kohdalla
// korkeusmalli on nostettu kannen tasolle ja kannen korkeus tulee kantakartan siltaviivoista
// (bridges.js). Raidesillalla juna tai raitiovaunu on aina kannella. Muuten ajoneuvo pysyy kannella,
// jos se tuli sillalle kannen korkeudelta (esimerkiksi penkereeltä), ja sillan ali kulkeva ajoneuvo
// pysyy alla olevan tien tasolla. prev on saman kohdan edellinen korkeus.
function groundAt(v, x, y, prev, centerElev, exag) {
  const lon = lonOf(x), lat = latOf(y);
  const dem = (mapRef.queryTerrainElevation([lon, lat]) ?? 0) + centerElev;
  const kind = KINDS[v.kind];
  if (kind.underground) return dem;
  const decks = gameDecksAt(lon, lat);
  const nearest = (list, h) => list.reduce((a, d) => (a == null || Math.abs(d.z * exag - h) < Math.abs(a * exag - h) ? d.z : a), null);
  const rails = kind.rail != null && decks.filter((d) => d.k === "raide");
  if (rails?.length) return Math.max(dem, nearest(rails, prev ?? dem) * exag);
  let approach = null;
  const from = () => (approach ??= prev ?? approachElevation(v, centerElev));
  const deck = decks.length ? nearest(decks, from()) : deckHeightAt(lon, lat);
  if (deck == null) return dem;
  const rawM = rawElevationAt(lon, lat), raw = rawM == null ? dem : rawM * exag, top = deck * exag;
  if (top < raw + 0.5) return dem; // silta ei ole maanpinnan yläpuolella
  if (Math.abs(from() - top) >= Math.abs(from() - raw)) return raw; // sillan alla
  // Kannella: jänne on 3D-silta (pelimaasto.js), ja maasto on sen alla.
  return Math.max(dem, top);
}

// Maanpinnan korkeus siinä reitin kohdassa, josta ajoneuvo tuli sillalle.
function approachElevation(v, centerElev) {
  const T = v.trail;
  for (let i = T.length - 1; i >= 0; i--) {
    const lon = lonOf(T[i][0]), lat = latOf(T[i][1]);
    if ((!gameDecksAt(lon, lat).length && deckHeightAt(lon, lat) == null) || i === 0) {
      return (mapRef.queryTerrainElevation([lon, lat]) ?? 0) + centerElev;
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

function placeLabel(id, text, color, className, sx, sy) {
  let el = labels.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = className;
    labelLayer.append(el);
    labels.set(id, el);
  }
  if (el.style.background !== color) el.style.background = color;
  if (el.textContent !== text) el.textContent = text;
  el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  el.hidden = false;
  el.frame = frameNo;
}

function hideStaleLabels() {
  for (const [id, el] of labels) {
    if (el.frame === frameNo) continue;
    if (vehicles.has(id) || planes.has(id) || ships.has(id)) el.hidden = true;
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
  flatCamera.projectionMatrix.copy(camera.projectionMatrix);
  const f = flatCamera.projectionMatrix.elements;
  f[2] = f[6] = f[10] = f[14] = 0; // syvyys aina näkyvällä välillä
  const centerElev = map.transform.elevation ?? 0;
  const exag = map.getTerrain()?.exaggeration ?? 1;
  const tunnelZ = METRO_TUNNEL_Z * exag - centerElev; // metron raiteiden taso näkymässä
  const b = map.getBounds(), [vx0, vy0] = toLocal(b.getWest(), b.getSouth()), [vx1, vy1] = toLocal(b.getEast(), b.getNorth());
  const e = camera.projectionMatrix.elements, W = map.transform.width, H = map.transform.height;
  const now = performance.now();
  const inView = (v, margin) => v.x > vx0 - margin && v.x < vx1 + margin && v.y > vy0 - margin && v.y < vy1 + margin;

  if (tunnelMesh) {
    tunnelMesh.visible = groupOn.metro;
    placeUnderground(tunnelMesh, cmx, cmy, sc, tunnelZ);
  }
  setTunnelView(!!riding && !!KINDS[riding.kind]?.underground && cameraUnderground(map, centerElev));
  if (tunnelInterior) {
    tunnelInterior.visible = tunnelView;
    placeUnderground(tunnelInterior, cmx, cmy, sc, tunnelZ);
    tunnelFog.value = 1 / (map.transform.worldSize * sc);
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
    const shipDot = dotColors.ship;
    for (const sh of ships.values()) {
      if (sh.x == null || nDots >= DOT_CAP || onLand(sh, centerElev, exag, now)) continue;
      const lat = latOf(sh.y), wx = (mercX(lonOf(sh.x)) - cmx) / sc, wy = -(mercY(lat) - cmy) / sc;
      const z = -centerElev * (cosC / Math.cos(lat * D2R));
      dotPos[3 * nDots] = wx; dotPos[3 * nDots + 1] = wy; dotPos[3 * nDots + 2] = z;
      dotCol[3 * nDots] = shipDot.r; dotCol[3 * nDots + 1] = shipDot.g; dotCol[3 * nDots + 2] = shipDot.b;
      sh.dot = toScreen(e, wx, wy, z, W, H);
      sh.dotAt = now;
      nDots++;
    }
    const chargeDot = dotColors.lataus;
    for (const car of groupOn.lataus ? chargeCars.values() : []) {
      if (nDots >= DOT_CAP || !inView(car, 100)) continue;
      if (car.elev == null || now - car.elevAt > 1000) {
        car.elev = (map.queryTerrainElevation([car.lon, car.lat]) ?? 0) + centerElev;
        car.elevAt = now + Math.random() * 200;
      }
      const wx = (mercX(car.lon) - cmx) / sc, wy = -(mercY(car.lat) - cmy) / sc;
      const z = (car.elev - centerElev) * (cosC / Math.cos(car.lat * D2R));
      dotPos[3 * nDots] = wx; dotPos[3 * nDots + 1] = wy; dotPos[3 * nDots + 2] = z;
      dotCol[3 * nDots] = chargeDot.r; dotCol[3 * nDots + 1] = chargeDot.g; dotCol[3 * nDots + 2] = chargeDot.b;
      car.dot = toScreen(e, wx, wy, z, W, H);
      car.dotAt = now;
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
      const onRailZ = kind.grade && v.railZ != null;
      walkTrail(v, kind.ds, scale, pts, onRailZ ? ptsZ : null);
      if (onRailZ) {
        // Raiteilla kulkevan korkeus tulee reitiltä (kaltevuus rajattu, ks. updateRailZ).
        v.elev = v.elevShown = Float64Array.from(ptsZ.subarray(0, 2 * n));
      } else if (kind.underground) {
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
          if (top && top[0] > -60 && top[0] < W + 60 && top[1] > -30 && top[1] < H + 60) {
            placeLabel(v.id, v.info.line ?? "", COLORS[v.kind], kind.underground ? "vlabel underground" : "vlabel", top[0], top[1]);
          }
        }
      }
      v.drawnAt = now;
    }
  }
  const ctx = { zoom, cmx, cmy, sc, cosC, centerElev, exag, e, W, H, now };
  drawPlanes(map, ctx);
  drawShips(map, ctx);
  drawCharging(map, ctx);
  drawLandmarks(map, ctx);
  for (const x of extras) x.draw(map, ctx);
  hideStaleLabels();
  for (const mesh of Object.values(meshes)) mesh.instanceMatrix.needsUpdate = true;
}

function renderScene(gl, sc, cam = camera) {
  renderer.resetState();
  renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  renderer.render(sc, cam);
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
  if (v.isPlane) return planeContent(v);
  if (v.isShip) return shipContent(v);
  if (v.isCharge) return chargeContent(v);
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
  for (const p of planes.values()) {
    if (!p.screen || p.screenAt < recent) continue;
    const d = (p.screen[0] - point.x) ** 2 + (p.screen[1] - point.y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  for (const sh of ships.values()) {
    if (sh.land) continue;
    const probe = sh.screenAt > recent ? sh.screen : sh.dotAt > recent ? sh.dot : null;
    if (!probe) continue;
    const d = (probe[0] - point.x) ** 2 + (probe[1] - point.y) ** 2;
    if (d < bestD) { bestD = d; best = sh; }
  }
  for (const car of groupOn.lataus ? chargeCars.values() : []) {
    const probe = car.screenAt > recent ? car.screen : car.dotAt > recent ? car.dot : null;
    if (!probe) continue;
    const d = (probe[0] - point.x) ** 2 + (probe[1] - point.y) ** 2;
    if (d < bestD) { bestD = d; best = car; }
  }
  return best;
}

function stats() {
  const counts = Object.fromEntries(TRANSIT_GROUPS.map(([id]) => [id, 0]));
  for (const v of vehicles.values()) if (v.x != null) counts[KINDS[v.kind].group]++;
  counts.lentokoneet = planes.size;
  counts.laivat = [...ships.values()].filter((sh) => sh.x != null && !sh.land).length;
  counts.lataus = chargeCars.size;
  let message = "Sijainnit päivittyvät sekunnin välein. Lähennä karttaa, niin näet ajoneuvot 3D-malleina.";
  if (document.hidden) message = "";
  else if (hfp.client && !hfp.ok) message = "Yhdistetään HSL:n reaaliaikapalveluun…";
  else if (rail.client && !rail.ok) message = "Kaukojunien sijainnit (Digitraffic) eivät juuri nyt päivity.";
  else if (!planeState.ok) message = "Lentokoneiden sijainnit (adsb.fi) eivät juuri nyt päivity.";
  else if (!shipState.ok) message = "Alusten sijainnit (Digitraffic) eivät juuri nyt päivity.";
  else if (!chargeState.ok) message = "Latauspisteiden tilat (Fintraffic) eivät juuri nyt päivity.";
  return { counts, message };
}

// ------------------------------------------------------------ kyytinäkymä

let ride = null; // kyytinäkymä (ride.js)
let riding = null; // kulkuneuvo, jonka kyydissä ollaan

// Julkiset kulkuneuvot, joiden kyytiin voi hypätä: bussit, raitiovaunut, junat (ei tavarajunia),
// metro ja matkustaja-alukset.
const rideable = (v) => (v.isShip ? shipDims(v).cls === "passenger" : !v.isPlane && !v.isCharge && KINDS[v.kind]?.eye != null);

// Seurattavan kulkuneuvon kohta ja kulkusuunta (ride.js). null, kun kulkuneuvo on kadonnut datasta.
function poseOf(v) {
  if (v.isShip) return ships.get(v.id) !== v || v.x == null ? null : { lon: lonOf(v.x), lat: latOf(v.y), heading: v.heading };
  if (vehicles.get(v.id) !== v || v.x == null) return null;
  const h = v.heading ?? v.dir ?? [0, 1];
  return { lon: lonOf(v.x), lat: latOf(v.y), heading: Math.atan2(h[0], h[1]) };
}

// Kyytipalkin tiedot: laji, linja ja määränpää sekä nopeus ja aikataulu.
function rideInfo(v) {
  let kind, title, rows;
  if (v.isShip) {
    kind = shipDims(v).label;
    title = v.meta?.name?.trim() || `MMSI ${v.mmsi}`;
    rows = [shipSpeed(v), v.meta?.destination?.trim() ? `määränpää ${v.meta.destination.trim()}` : null];
  } else {
    const k = KINDS[v.kind], i = v.info;
    kind = k.label;
    title = [i.line, i.headsign].filter(Boolean).join(" → ") || k.label;
    rows = [`${Math.round((i.spd ?? 0) * 3.6)} km/h`, delayText(i.dl)];
  }
  return node("div", {}, node("div", { class: "kind" }, kind), node("h3", {}, title),
    node("div", { class: "meta" }, rows.filter(Boolean).join(" · ")));
}

function board(v) {
  const p = poseOf(v);
  if (!p) return;
  popup.remove();
  riding = v;
  ride.start(p, rideInfo(v));
}

// Seurannassa ajoneuvot siirretään ja näkymä asetetaan ennen ruudun piirtoa, jotta seurattava
// kulkuneuvo pysyy paikallaan näkymässä.
function rideFrame() {
  tick();
  ride.update(riding && poseOf(riding));
}

const nextFrame = () => (ride.active ? rideFrame() : mapRef.triggerRepaint());

// ------------------------------------------------------------ julkinen rajapinta

export async function createTransit(map, { boundaryUrl, railsUrl, planesUrl, chargingUrl, beforeLayer, undergroundBeforeLayer }) {
  mapRef = map;
  ride = createRide(map, { onEnd: () => { riding = null; } });
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
      if (!ride.active) tick(); // kyydissä ajoneuvot siirretään ennen kameraa (rideFrame)
      draw(gl, matrix);
      if (!tunnelView) renderScene(gl, undergroundScene, flatCamera);
    },
  }, undergroundBeforeLayer);
  map.addLayer({
    id: "joukkoliikenne", type: "custom", renderingMode: "3d", onAdd,
    render(gl) {
      if (!tunnelView) {
        renderScene(gl, scene);
        renderScene(gl, overlayScene, flatCamera);
      }
      // Ajoneuvot liikkuvat koko ajan, joten kartta piirretään jatkuvasti (FRAME_INTERVAL). Kaukaa
      // katsottaessa liike on ruudulla hidasta, joten silloin riittää harvempi tahti.
      if (!ride.active && !Object.values(groupOn).some(Boolean) && !extrasAnimating()) return;
      const interval = map.getZoom() >= 11 ? FRAME_INTERVAL : 50;
      repaintTimer ??= setTimeout(() => { repaintTimer = null; nextFrame(); },
        Math.max(0, interval - (performance.now() - lastRender)));
    },
  }, beforeLayer);
  // Metron kyydissä tunnelissa kaikki muu peitetään: kallion värinen tausta ja tunnelin sisäpuoli
  // piirretään viimeisenä, nimienkin päälle.
  map.addLayer({
    id: "joukkoliikenne-tunneli", type: "custom", renderingMode: "3d", onAdd,
    render(gl) {
      if (!tunnelView) return;
      renderer.resetState();
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.setClearColor(ROCK, 1);
      renderer.clear(true, true, false);
      renderer.render(tunnelScene, camera);
    },
  });

  map.on("moveend", syncCells);
  document.addEventListener("visibilitychange", onVisibility);

  // Varmistus: jos piirtosilmukka on pysähtynyt (esim. kaikki ryhmät olivat pois), käynnistetään se.
  setInterval(() => {
    if (performance.now() - lastRender > 1000 && (ride.active || Object.values(groupOn).some(Boolean) || extrasAnimating())) nextFrame();
  }, 1000);

  const listeners = [];
  setInterval(() => {
    const wall = Date.now();
    for (const v of vehicles.values()) {
      if (wall - v.lastRx > (KINDS[v.kind].rail != null ? RAIL_TIMEOUT : HFP_TIMEOUT)) removeVehicle(v);
    }
    for (const p of planes.values()) if (wall - p.lastRx > PLANE_TIMEOUT) removePlane(p);
    for (const sh of ships.values()) if (wall - sh.lastSeen > 3 * SHIP_POLL) removeShip(sh);
    if (selected) popup.setDOMContent(popupContent(selected));
    if (riding) ride.setInfo(rideInfo(riding));
    const s = stats();
    for (const fn of listeners) fn(s);
  }, 1000);

  syncConnections();
  planeState.url = planesUrl;
  pollPlanes();
  setInterval(pollPlanes, PLANE_POLL);
  pollShips();
  setInterval(pollShips, SHIP_POLL);
  loadCharging(chargingUrl).then(pollCharging).catch((err) => { chargeState.ok = false; console.warn("Latauspaikkoja ei saatu ladattua", err); });
  setInterval(pollCharging, CHARGE_POLL);

  return {
    vehicles, planes, ships, chargeCars, scene, tunnelScene, // selaimen konsolia varten
    setGroup(id, on) {
      groupOn[id] = on;
      if (selected?.kind && !groupOn[KINDS[selected.kind].group]) popup.remove();
      if (id === "lataus") { if (!on && selected?.isCharge) popup.remove(); else if (on) pollCharging(); }
      syncConnections();
      map.triggerRepaint();
    },
    onStats(fn) { listeners.push(fn); fn(stats()); },
    // Pois kyydistä heti, esimerkiksi ennen kuin kartta lennätetään toiseen paikkaan.
    leaveRide() { ride.stop(); },
    // Palauttaa true, jos klikkaus osui ajoneuvoon, koneeseen tai alukseen (ja tiedot avattiin
    // tai kulkuneuvon kyytiin hypättiin). Kyydissä toisen julkisen kulkuneuvon klikkaus vaihtaa sen
    // kyytiin, ja muut kohteet (rakennukset ym., app.js) avautuvat kuten muutenkin.
    click(point) {
      const v = pick(point);
      if (ride.active && v && rideable(v)) {
        if (v !== riding) board(v);
        return true;
      }
      if (!v) { popup.remove(); return false; }
      if (rideable(v)) { board(v); return true; }
      // addTo sulkee aiemman ikkunan (ja nollaa valinnan), joten valinta asetetaan vasta sen jälkeen.
      popup.setLngLat(anchorOf(v, performance.now())).setDOMContent(popupContent(v)).addTo(map);
      selected = v;
      return true;
    },
    // Maamerkki, jonka mallin kohdalle klikattiin, tai null. Tiedot näytetään rakennuksen tietoina
    // (app.js); päällekkäisistä valitaan näytöllä pienin.
    pickLandmark(point) {
      let best = null, bestArea = Infinity;
      for (const l of landmarks) {
        const r = l.rect;
        if (!r || point.x < r[0] || point.x > r[2] || point.y < r[1] || point.y > r[3]) continue;
        const area = (r[2] - r[0]) * (r[3] - r[1]);
        if (area < bestArea) { bestArea = area; best = l; }
      }
      return best && { id: best.id, name: best.name, building: best.building, rows: best.rows };
    },
  };
}
