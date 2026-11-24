// Pelillinen maasto (kokeilu, Otaniemi–Laajalahti). HSY:n maanpeiteaineiston luokat (metsät
// korkeusluokittain, pellot, tiet, vesi, ...) ovat valmiina rasteriruutuina (scripts/build_data.py,
// public/tiles/maanpeite). Selain maalaa niistä työsäikeessä (pelimaasto_worker.js) tekstuurit, ja
// MapLibre levittää ne maaston päälle kuten ilmakuvan; rinnevarjostus antaa maastolle muodot.
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
    type: "raster-dem", tiles: ["dem://{z}/{x}/{y}"], encoding: "terrarium", tileSize: 512, maxzoom: 15, bounds: info.alue,
  });
  map.addLayer({ id: "pelimaasto", type: "raster", source: "pelimaasto", layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } }, before);
  map.addLayer({
    id: "pelimaasto-varjostus", type: "hillshade", source: "pelimaasto-dem", layout: { visibility: "none" },
    paint: {
      "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#1d2b1c", "hillshade-highlight-color": "#fff6d8",
      "hillshade-accent-color": "#263524",
    },
  }, before);

  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const meshes = treeMeshes();
  group.add(meshes.trunk, meshes.cone, meshes.round);
  const center = [(info.alue[0] + info.alue[2]) / 2, (info.alue[1] + info.alue[3]) / 2];
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
    for (const id of ["pelimaasto", "pelimaasto-varjostus"]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    // Lähemmäs, jotta tekstuurit ja puut (TREE_MINZOOM) näkyvät heti.
    const here = map.getCenter().toArray(), inside = inArea(here);
    if (on && (!inside || map.getZoom() < TREE_MINZOOM + 0.5)) {
      map.flyTo({ center: inside ? here : center, zoom: 16.4, pitch: 60, bearing: map.getBearing(), duration: 2000 });
    }
    map.triggerRepaint();
  }

  const animating = () => visible && (asking || (heights != null && next < Math.min(heights.length, TREE_MAX)));
  return { drawable: { object: group, draw, animating }, setVisible };
}
