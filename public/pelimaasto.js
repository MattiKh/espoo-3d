// Pelillinen maasto (kokeilu, Otaniemi–Laajalahti). HSY:n maanpeiteaineiston luokat (metsät
// korkeusluokittain, pellot, tiet, vesi, ...) ovat valmiina rasteriruutuina (scripts/build_data.py,
// public/tiles/maanpeite). Selain maalaa niistä työsäikeessä (pelimaasto_worker.js) tekstuurit, ja
// MapLibre levittää ne maaston päälle kuten ilmakuvan; rinnevarjostus antaa maastolle muodot.
// Päällä ovat kantakartan teiden ja polkujen reunaviivat, kadunnimet kantakartan sijainnein ja
// suunnin sekä OpenStreetMapista kaistaviivat, suojatiet ja raiteet (public/data/pelimaasto_kanta.geojson).
// Metsiin sijoitellaan kameran ympärille matalapolygonisia 3D-puita joukkoliikenteen 3D-tasolle
// (transit.js): lehtipuilla pyöreä latvus, havupuilla kartio.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const TREE_MINZOOM = 15;
const TREE_RADIUS = 600; // m: puut näin kaukana kartan keskipisteestä
const TREE_MOVE = 150; // m: puut sijoitellaan uudelleen, kun keskipiste siirtyy näin paljon
const TREE_MAX = 40000;
const HEIGHT_BUDGET = 2500; // maaston korkeuskyselyä piirtokertaa kohden
const HEIGHT_RECHECK = 5000; // ms: korkeudet tarkistetaan kerran uudelleen (korkeusmalli tarkentuu)
const LAYER_IDS = ["pelimaasto", "pelimaasto-varjostus", "pelimaasto-reunat", "pelimaasto-polut", "pelimaasto-keskiviivat",
  "pelimaasto-kaistaviivat", "pelimaasto-suojatiet", "pelimaasto-pyorajatke-v", "pelimaasto-pyorajatke-o", "pelimaasto-raidepohja",
  "pelimaasto-ratapolkyt", "pelimaasto-kisko-v", "pelimaasto-kisko-o", "pelimaasto-nimet"];
// Leveys metreinä karttapikseleiksi zoomaustason mukaan (512 px:n ruudut, Espoon leveysaste).
const M_PER_PX0 = 78271.517 * Math.cos(60.185 * D2R);
const meters = (m) => ["interpolate", ["exponential", 2], ["zoom"], 12, (m * 2 ** 12) / M_PER_PX0, 22, (m * 2 ** 22) / M_PER_PX0];

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const lonOfX = (x) => x * 360 - 180;
const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

const worker = new Worker(new URL("./pelimaasto_worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let seq = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (p) data.error ? p.reject(new Error(data.error)) : p.resolve(data);
};
const ask = (msg) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id });
});

maplibregl.addProtocol("peli", async (params) => {
  const [z, x, y] = params.url.slice("peli://".length).split("/").map(Number);
  return { data: (await ask({ type: "tile", z, x, y })).buffer };
});

// 3D-sillat (scripts/build_data.py, game_bridges): kansi, reunakaiteet ja pilarit matalapolygonisina.
// Pelillisen maaston korkeusmallissa korkeat jänteet ovat auki, joten sillan alta kulkeva tie näkyy.
const DECK = 1.0, RAIL_H = 0.9, RAIL_T = 0.25; // m: kannen paksuus, kaiteen korkeus ja paksuus
const PIER_STEP = 24, PIER_DEPTH = 40, END_EXTRA = 2; // m: pilarien väli ja syvyys, kantta jatketaan päistä
// Värit ovat tummia, sillä 3D-tason valaistus on kirkas (kannen pinta vastaa maaston asfalttia).
const BRIDGE_TOP = { tie: [0.12, 0.125, 0.14], kevyt: [0.4, 0.37, 0.32], raide: [0.22, 0.2, 0.18] };
const CONCRETE = [0.46, 0.45, 0.43], RAILING = [0.3, 0.33, 0.36], MARKING = [0.92, 0.92, 0.9];
const DASH = 3, DASH_GAP = 9, DASH_HALF = 0.175; // m: kaistaviivat kannella kuten maassa (3 m viiva, 9 m väli)
const EDGE_HALF = 0.125, EDGE = [0.88, 0.86, 0.8]; // m: ajoradan reunaviiva kannella (kuten kantakartan reunat maassa)

function bridgeMesh(list, ref, exag) {
  const pos = [], col = [];
  const tri = (a, b, c, color) => {
    pos.push(...a, ...b, ...c);
    col.push(...color, ...color, ...color);
  };
  const quad = (a, b, c, d, color) => {
    tri(a, b, c, color);
    tri(a, c, d, color);
  };
  // Laatikko: pohjan nelikulmio [p0, p1, p2, p3] (x, y) ja korkeudet z0–z1.
  const box = (ring, z0, z1, color) => {
    const lo = ring.map(([x, y]) => [x, y, z0]), hi = ring.map(([x, y]) => [x, y, z1]);
    quad(hi[0], hi[1], hi[2], hi[3], color);
    quad(lo[0], lo[3], lo[2], lo[1], color);
    for (let i = 0; i < 4; i++) quad(lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i], color);
  };
  for (const { p, w, k, v } of list) {
    const P = [];
    for (let i = 0; i < p.length; i += 3) {
      P.push([(mercX(p[i]) - mercX(ref.lon)) * ref.unit, -(mercY(p[i + 1]) - mercY(ref.lat)) * ref.unit, p[i + 2] * exag + 0.15]);
    }
    if (P.length < 2) continue;
    for (const [a, b] of [[0, 1], [P.length - 1, P.length - 2]]) { // päät hieman penkereen päälle
      const dx = P[a][0] - P[b][0], dy = P[a][1] - P[b][1], ln = Math.hypot(dx, dy) || 1;
      P[a] = [P[a][0] + (dx / ln) * END_EXTRA, P[a][1] + (dy / ln) * END_EXTRA, P[a][2]];
    }
    const N = P.map((_, i) => { // vasen normaali, kulmissa keskiarvo
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], ln = Math.hypot(dx, dy) || 1;
      return [-dy / ln, dx / ln];
    });
    const at = (i, d, z) => [P[i][0] + N[i][0] * d, P[i][1] + N[i][1] * d, z];
    const top = BRIDGE_TOP[k] ?? BRIDGE_TOP.tie;
    for (let i = 0; i < P.length - 1; i++) {
      const z0 = P[i][2], z1 = P[i + 1][2];
      quad(at(i, w, z0), at(i, -w, z0), at(i + 1, -w, z1), at(i + 1, w, z1), top);
      quad(at(i, w, z0 - DECK), at(i + 1, w, z1 - DECK), at(i + 1, -w, z1 - DECK), at(i, -w, z0 - DECK), CONCRETE);
      for (const side of [w, -w]) {
        quad(at(i, side, z0), at(i + 1, side, z1), at(i + 1, side, z1 - DECK), at(i, side, z0 - DECK), CONCRETE);
        // Kaide reunalla: ulkopinta, sisäpinta ja yläpinta.
        const inner = side - Math.sign(side) * RAIL_T;
        quad(at(i, side, z0), at(i + 1, side, z1), at(i + 1, side, z1 + RAIL_H), at(i, side, z0 + RAIL_H), RAILING);
        quad(at(i, inner, z0), at(i + 1, inner, z1), at(i + 1, inner, z1 + RAIL_H), at(i, inner, z0 + RAIL_H), RAILING);
        quad(at(i, side, z0 + RAIL_H), at(i + 1, side, z1 + RAIL_H), at(i + 1, inner, z1 + RAIL_H), at(i, inner, z0 + RAIL_H), RAILING);
      }
    }
    for (const i of [0, P.length - 1]) quad(at(i, w, P[i][2]), at(i, -w, P[i][2]), at(i, -w, P[i][2] - DECK), at(i, w, P[i][2] - DECK), CONCRETE);
    // Kaistaviivat kannen pintaan (v: siirrot oikealle kulkusuuntaan nähden, m).
    const S = [0];
    for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const along = (t, d) => { // piste matkalla t, d metriä oikealle
      let i = 0;
      while (i < P.length - 2 && S[i + 1] < t) i++;
      const f = Math.min(1, Math.max(0, (t - S[i]) / (S[i + 1] - S[i] || 1)));
      const nx = N[i][0] + (N[i + 1][0] - N[i][0]) * f, ny = N[i][1] + (N[i + 1][1] - N[i][1]) * f;
      return [P[i][0] + (P[i + 1][0] - P[i][0]) * f - nx * d, P[i][1] + (P[i + 1][1] - P[i][1]) * f - ny * d,
        P[i][2] + (P[i + 1][2] - P[i][2]) * f + 0.03];
    };
    // Ajotiesillalla ajoradan reunaviivat (kannen reuna on 1 m ajoradan reunan ulkopuolella).
    for (const d of k === "tie" ? [w - 1, 1 - w] : []) {
      for (let i = 0; i < P.length - 1; i++) {
        quad(along(S[i], d - EDGE_HALF), along(S[i], d + EDGE_HALF), along(S[i + 1], d + EDGE_HALF), along(S[i + 1], d - EDGE_HALF), EDGE);
      }
    }
    for (const d of v ?? []) {
      for (let t = 0; t < S.at(-1); t += DASH + DASH_GAP) {
        const t1 = Math.min(S.at(-1), t + DASH);
        quad(along(t, d - DASH_HALF), along(t, d + DASH_HALF), along(t1, d + DASH_HALF), along(t1, d - DASH_HALF), MARKING);
      }
    }
    // Pilarit tasavälein (ei päissä); maan alle jäävä osa peittyy maastoon.
    let s = 0;
    for (let i = 1; i < P.length - 1; i++) {
      s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      if (s < PIER_STEP) continue;
      s = 0;
      const [x, y, z] = P[i], [nx, ny] = N[i], ax = -ny * 0.6, ay = nx * 0.6, cw = w * 0.7;
      box([[x + nx * cw + ax, y + ny * cw + ay], [x - nx * cw + ax, y - ny * cw + ay], [x - nx * cw - ax, y - ny * cw - ay],
        [x + nx * cw - ax, y + ny * cw - ay]], z - DECK - PIER_DEPTH, z - DECK, CONCRETE);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }));
  mesh.frustumCulled = false;
  return mesh;
}

// Matalapolygoninen puu: runko ja latvus (pyöreä tai kartio) yksikkökokoisina, akseli pystyssä (z).
function treeMeshes() {
  const up = (g) => g.rotateX(Math.PI / 2);
  const mat = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const make = (geometry, material) => {
    const mesh = new THREE.InstancedMesh(geometry, material, TREE_MAX);
    mesh.frustumCulled = false; // ilmentymät ovat laajalla alueella
    mesh.count = 0;
    return mesh;
  };
  return {
    trunk: make(up(new THREE.CylinderGeometry(0.5, 0.6, 1, 5)), mat(0x3d2a1b)),
    cone: make(up(new THREE.ConeGeometry(1, 1, 7)), mat(0xffffff)),
    round: make(new THREE.IcosahedronGeometry(1, 0), mat(0xffffff)),
  };
}

export async function createGameTerrain(map, { base, version }) {
  const info = await fetch(`${base}data/maanpeite.json?v=${version}`).then((r) => r.json());
  worker.postMessage({ type: "init", base, version });
  const layers = map.getStyle().layers, before = layers[layers.findIndex((l) => l.id === "ortho") + 1]?.id;
  map.addSource("pelimaasto", {
    type: "raster", tiles: ["peli://{z}/{x}/{y}"], tileSize: 512, minzoom: 14, maxzoom: 19, bounds: info.alue,
    attribution: "Maanpeite © HSY",
  });
  map.addSource("pelimaasto-dem", {
    // Pelillisen tilan korkeusmalli (sillat auki, bridges.js), sillä varjostus näkyy vain siinä.
    type: "raster-dem", tiles: ["dem://{z}/{x}/{y}?peli"], encoding: "terrarium", tileSize: 512, maxzoom: 15, bounds: info.alue,
  });
  map.addLayer({ id: "pelimaasto", type: "raster", source: "pelimaasto", layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } }, before);
  map.addLayer({
    id: "pelimaasto-varjostus", type: "hillshade", source: "pelimaasto-dem", layout: { visibility: "none" },
    paint: {
      "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#1d2b1c", "hillshade-highlight-color": "#fff6d8",
      "hillshade-accent-color": "#263524",
    },
  }, before);
  map.addSource("pelimaasto-kanta", { type: "geojson", data: `${base}data/pelimaasto_kanta.geojson?v=${version}`, attribution: "Kantakartta © Espoon kaupunki" });
  const edgeWidth = ["interpolate", ["exponential", 2], ["zoom"], 15, 0.5, 18, 2, 20, 5];
  map.addLayer({
    id: "pelimaasto-reunat", type: "line", source: "pelimaasto-kanta", minzoom: 15,
    filter: ["in", ["get", "k"], ["literal", ["ajorata", "kevyt"]]],
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "k"], "ajorata", "#f3f0e4", "#e2d9c0"], "line-width": edgeWidth, "line-opacity": 0.9 },
  }, before);
  map.addLayer({
    id: "pelimaasto-polut", type: "line", source: "pelimaasto-kanta", minzoom: 15,
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "k"], "polku"]],
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#d9c9a0", "line-width": edgeWidth, "line-dasharray": [2, 2], "line-opacity": 0.9 },
  }, before);
  // Kaistaviivat: keskiviiva vastakkaisten suuntien välissä ja kaistaviivat saman suunnan kaistojen
  // välissä, valkoisia (3 m viiva, 9 m väli; katkoviivan mitat ovat viivan leveyden kerrannaisia).
  for (const [id, k] of [["pelimaasto-keskiviivat", "keski"], ["pelimaasto-kaistaviivat", "kaista"]]) {
    map.addLayer({
      id, type: "line", source: "pelimaasto-kanta", minzoom: 16, filter: ["==", ["get", "k"], k],
      layout: { visibility: "none", "line-join": "round" },
      paint: { "line-color": "#f6f5ef", "line-width": meters(0.35), "line-dasharray": [3 / 0.35, 9 / 0.35] },
    }, before);
  }
  // Suojatie: ylityksen suuntainen 3 m leveä katkoviiva, jonka viivat (0,5 m, väli 0,5 m) ovat
  // ajoradan suuntaisia raitoja. Pyörätien jatke: kaksi riviä 0,5 m neliöitä ylityksen reunoilla.
  map.addLayer({
    id: "pelimaasto-suojatiet", type: "line", source: "pelimaasto-kanta", minzoom: 16, filter: ["==", ["get", "k"], "suojatie"],
    layout: { visibility: "none" },
    paint: { "line-color": "#f8f7f2", "line-width": meters(3), "line-dasharray": [0.5 / 3, 0.5 / 3] },
  }, before);
  for (const [id, side] of [["pelimaasto-pyorajatke-v", -1], ["pelimaasto-pyorajatke-o", 1]]) {
    map.addLayer({
      id, type: "line", source: "pelimaasto-kanta", minzoom: 16.5, filter: ["==", ["get", "k"], "pyorajatke"],
      layout: { visibility: "none" },
      paint: { "line-color": "#f8f7f2", "line-width": meters(0.5), "line-dasharray": [1, 1], "line-offset": meters(side * 1.2) },
    }, before);
  }
  // Raiteet: sepelipohja, ratapölkyt ja kaksi kiskoa (raideleveys noin 1,5 m).
  const rails = ["in", ["get", "k"], ["literal", ["rata", "ratikka"]]];
  map.addLayer({
    id: "pelimaasto-raidepohja", type: "line", source: "pelimaasto-kanta", minzoom: 14, filter: rails,
    layout: { visibility: "none", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "k"], "rata", "#8a7f71", "#76716a"], "line-width": meters(3.2) },
  }, before);
  map.addLayer({
    id: "pelimaasto-ratapolkyt", type: "line", source: "pelimaasto-kanta", minzoom: 16.5, filter: rails,
    layout: { visibility: "none" },
    paint: { "line-color": "#4e3b2a", "line-width": meters(2.5), "line-dasharray": [0.22 / 2.5, 0.38 / 2.5] },
  }, before);
  for (const [id, side] of [["pelimaasto-kisko-v", -1], ["pelimaasto-kisko-o", 1]]) {
    map.addLayer({
      id, type: "line", source: "pelimaasto-kanta", minzoom: 15.5, filter: rails,
      layout: { visibility: "none", "line-join": "round" },
      paint: { "line-color": "#dfe3e6", "line-width": meters(0.18), "line-offset": meters(side * 0.75) },
    }, before);
  }
  // Nimet maaston pintaan kuten kantakartassa; rakennukset peittävät ne, joten ne ovat rakennusten alla.
  const size = (small, medium, large) => ["match", ["get", "koko"], "suuri", large, "keskikokoinen", medium, small];
  map.addLayer({
    id: "pelimaasto-nimet", type: "symbol", source: "pelimaasto-kanta", minzoom: 15.5,
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      visibility: "none", "text-field": ["get", "nimi"], "text-font": ["Noto Sans Bold"], "text-letter-spacing": 0.04,
      "text-size": ["interpolate", ["exponential", 2], ["zoom"], 16, size(9, 11, 13), 19, size(24, 30, 36)],
      "text-rotate": ["get", "kulma"], "text-rotation-alignment": "map", "text-pitch-alignment": "map",
    },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(28, 38, 28, 0.85)", "text-halo-width": 1.4 },
  }, before);

  const root = new THREE.Group(), group = new THREE.Group(), bridges = new THREE.Group();
  group.matrixAutoUpdate = bridges.matrixAutoUpdate = false;
  root.add(group, bridges);
  const meshes = treeMeshes();
  group.add(meshes.trunk, meshes.cone, meshes.round);
  const center = [(info.alue[0] + info.alue[2]) / 2, (info.alue[1] + info.alue[3]) / 2];
  const bridgeRef = { lon: center[0], lat: center[1], unit: EARTH_CIRC * Math.cos(center[1] * D2R) };
  fetch(`${base}data/pelimaasto_sillat.json?v=${version}`).then((r) => (r.ok ? r.json() : { sillat: [] }))
    .then(({ sillat }) => {
      bridges.add(bridgeMesh(sillat, bridgeRef, map.getTerrain()?.exaggeration ?? 1));
      map.triggerRepaint();
    })
    .catch((err) => console.warn("Siltoja ei saatu ladattua", err));
  let visible = false, trees = null, ref = null, heights = null, next = 0, passAt = 0, passes = 0, asking = false;

  function inArea([lon, lat]) {
    const [w, s, e, n] = info.alue;
    return lon > w && lon < e && lat > s && lat < n;
  }

  // Uudet puut keskipisteen ympäriltä (työsäie), korkeudet haetaan vähitellen.
  async function plant(c) {
    asking = true;
    try {
      const { trees: t } = await ask({ type: "trees", x: mercX(c.lng), y: mercY(c.lat), radius: TREE_RADIUS });
      trees = t;
      ref = { lon: c.lng, lat: c.lat, unit: EARTH_CIRC * Math.cos(c.lat * D2R) };
      heights = new Float32Array(trees.length / 5).fill(NaN);
      next = 0;
      passes = 0;
      for (const mesh of Object.values(meshes)) mesh.count = Math.min(TREE_MAX, heights.length);
      const hide = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < Math.min(TREE_MAX, heights.length); i++) {
        for (const mesh of Object.values(meshes)) mesh.setMatrixAt(i, hide);
      }
    } finally {
      asking = false;
      map.triggerRepaint();
    }
  }

  const m4 = new THREE.Matrix4(), color = new THREE.Color();
  function placeTree(i, ground) {
    const X = trees[5 * i], Y = trees[5 * i + 1], h = trees[5 * i + 2], conifer = trees[5 * i + 3] === 1, rnd = trees[5 * i + 4];
    const x = (X - mercX(ref.lon)) * ref.unit, y = -(Y - mercY(ref.lat)) * ref.unit;
    const trunkH = h * (conifer ? 0.2 : 0.3), crownH = h - trunkH, r = Math.max(1.2, h * (conifer ? 0.22 : 0.3));
    m4.makeScale(r * 0.35, r * 0.35, trunkH).setPosition(x, y, ground + trunkH / 2);
    meshes.trunk.setMatrixAt(i, m4);
    const crown = conifer ? meshes.cone : meshes.round, other = conifer ? meshes.round : meshes.cone;
    m4.makeScale(r, r, conifer ? crownH : crownH / 2).setPosition(x, y, ground + trunkH + (conifer ? crownH / 2 : crownH * 0.45));
    crown.setMatrixAt(i, m4);
    other.setMatrixAt(i, m4.makeScale(0, 0, 0));
    // 3D-tason valaistus on kirkas, joten perusvärit ovat tummia.
    color.setRGB(...(conifer ? [0.06 + 0.03 * rnd, 0.17 + 0.05 * rnd, 0.08] : [0.13 + 0.08 * rnd, 0.28 + 0.08 * rnd, 0.08]));
    crown.setColorAt(i, color);
  }

  // Korkeudet maastosta piirtokerroittain (HEIGHT_BUDGET); yksi uusintakierros, kun korkeusmalli tarkentuu.
  function fillHeights(now) {
    if (!heights || next >= heights.length && (passes > 1 || now - passAt < HEIGHT_RECHECK)) return false;
    if (next >= heights.length) {
      next = 0;
      passes++;
    }
    const base = map.transform.elevation ?? 0, n = Math.min(heights.length, TREE_MAX);
    let used = 0;
    for (; next < n && used < HEIGHT_BUDGET; next++, used++) {
      const q = map.queryTerrainElevation([lonOfX(trees[5 * next]), latOfY(trees[5 * next + 1])]);
      if (q == null) continue;
      heights[next] = q + base;
      placeTree(next, heights[next]);
    }
    if (next >= n) {
      next = heights.length;
      passAt = now;
      passes = Math.max(passes, 1);
    }
    for (const mesh of Object.values(meshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return true;
  }

  function draw(_, ctx) {
    bridges.visible = visible && ctx.zoom >= 14;
    if (bridges.visible) {
      const k = ctx.cosC / Math.cos(bridgeRef.lat * D2R);
      const wx = (mercX(bridgeRef.lon) - ctx.cmx) / ctx.sc, wy = -(mercY(bridgeRef.lat) - ctx.cmy) / ctx.sc;
      bridges.matrix.set(k, 0, 0, wx, 0, k, 0, wy, 0, 0, k, -ctx.centerElev * k, 0, 0, 0, 1);
    }
    const on = visible && ctx.zoom >= TREE_MINZOOM;
    group.visible = on && !!ref;
    if (!on) return;
    const c = map.getCenter();
    const moved = ref ? Math.hypot((c.lng - ref.lon) * Math.cos(c.lat * D2R), c.lat - ref.lat) * 111320 : Infinity;
    if (!asking && moved > TREE_MOVE && inArea([c.lng, c.lat])) plant(c);
    if (!ref) return;
    fillHeights(ctx.now);
    const k = ctx.cosC / Math.cos(ref.lat * D2R);
    const wx = (mercX(ref.lon) - ctx.cmx) / ctx.sc, wy = -(mercY(ref.lat) - ctx.cmy) / ctx.sc;
    group.matrix.set(k, 0, 0, wx, 0, k, 0, wy, 0, 0, k, -ctx.centerElev * k, 0, 0, 0, 1);
  }

  function setVisible(on) {
    visible = on;
    for (const id of LAYER_IDS) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    // Lähemmäs, jotta tekstuurit ja puut (TREE_MINZOOM) näkyvät heti.
    const here = map.getCenter().toArray(), inside = inArea(here);
    if (on && (!inside || map.getZoom() < TREE_MINZOOM + 0.5)) {
      map.flyTo({ center: inside ? here : center, zoom: 16.4, pitch: 60, bearing: map.getBearing(), duration: 2000 });
    }
    map.triggerRepaint();
  }

  const animating = () => visible && (asking || (heights != null && next < Math.min(heights.length, TREE_MAX)));
  return { drawable: { object: root, draw, animating }, setVisible };
}
