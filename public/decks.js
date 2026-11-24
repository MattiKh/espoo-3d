// Siltojen kannet yksinkertaisina 3D-laattoina joukkoliikenteen 3D-tasolla (transit.js). Kukin
// kansinauha (bridges.js) on tien tai raiteen keskilinjaa seuraava laatta (suora tai kaareva).
// Laatta piirretään sinne, missä nauha on korkeusmallin mukaan maanpinnan yläpuolella, ja sitä
// jatketaan OVERLONG metriä kummastakin päästä, jolloin se peittää sillan päiden kuopat (korkeusmallista
// on poistettu sillan mukana usein myös penkereen pää). Korkeusmallia ei muuteta, joten sillan
// alla kulkeva tie näkyy. Pinnassa on uusin ilmakuva (valaisematta, kuten maasto), reunat ja
// alapinta ovat betonin harmaita. Ilmakuvassa silta näkyy myös maassa laatan alla; se tummennetaan
// varjoksi (karttataso sillat-varjo ilmakuvan päällä). Lähekkäiset laatat kootaan samaan verkkoon.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import { getRibbons, ready } from "./bridges.js";

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const THICKNESS = 1.2; // m: kannen paksuus
const LIFT = 0.05; // m: laatta hieman maanpinnan yläpuolelle
const ELEVATED = 1.0; // m: nauha on maanpinnan yläpuolella
const OVERLONG = 15; // m: laattaa jatketaan maanpinnan yläpuolisen osan kummastakin päästä
const MAX_RADIUS = 2500; // m
const SAMPLE_BUDGET = 600; // maaston korkeuskyselyä piirtokertaa kohden
const SAMPLE_MAX_AGE = 4000; // ms: korkeus tarkistetaan uudelleen, kun korkeusmalli tarkentuu
const JOIN = 5; // m: näin lähellä toisiaan olevat laatat kootaan samaan verkkoon
const TEX_ZOOM = 17, TEX_TILES = 3, TILE_PX = 512; // ilmakuvaruudut: taso, enintään kpl kumpaankin suuntaan
const PLAIN = 0xc3c6c6; // pinta ilman ilmakuvaa
const SHADOW = "sillat-varjo";

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const lonOfX = (x) => x * 360 - 180;
const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

// orthoImage(z, x, y) → Promise<ImageBitmap | null>: ilmakuvaruutu (null, kun ilmakuva ei ole näkyvissä).
// ortho: onko ilmakuva näkyvissä (varjo tarvitaan vain sen päällä).
export function createDecks(map, { orthoImage, ortho = true }) {
  const group = new THREE.Group();
  const sideMaterial = new THREE.MeshLambertMaterial({ color: 0xbcb9b1, side: THREE.DoubleSide });
  const meshes = new Map(); // avain (nauhat ja niiden laatat) → { mesh, lon, lat, box, top, shadow }
  const ground = new Map(); // nauha → { h: maanpinta näytteittäin, at: aika }
  let area = null, dirty = true, orthoGen = 0, loaded = false;
  ready.then(() => { loaded = true; dirty = true; map.triggerRepaint(); });
  const layers = map.getStyle().layers, above = layers.findIndex((l) => l.id === "ortho");
  map.addSource(SHADOW, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: SHADOW, type: "fill", source: SHADOW, layout: { visibility: ortho ? "visible" : "none" },
    paint: { "fill-color": "#1b2024", "fill-opacity": 0.55 },
  }, layers[above + 1]?.id);

  const inArea = (r) => {
    if (!area) return false;
    const unit = EARTH_CIRC * Math.cos(area.lat * D2R);
    return Math.hypot((r.minX + r.maxX) / 2 - mercX(area.lon), (r.minY + r.maxY) / 2 - mercY(area.lat)) * unit < area.radius;
  };

  // Nauhan maanpinta näytteittäin (korostettu, absoluuttinen) ja siitä laatan kattamat näytteet:
  // maanpinnan yläpuoliset ja OVERLONG metriä niiden kummaltakin puolelta. Palauttaa true, jos
  // laatta muuttui.
  function sample(r, now) {
    const base = map.transform.elevation ?? 0, exag = map.getTerrain()?.exaggeration ?? 1;
    const h = new Float32Array(r.n);
    for (let k = 0; k < r.n; k++) {
      const q = map.queryTerrainElevation([lonOfX(r.x[k]), latOfY(r.y[k])]);
      h[k] = q == null ? NaN : (q + base) / exag;
    }
    ground.set(r, { h, at: now });
    const drawn = new Uint8Array(r.n);
    for (let k = 0; k < r.n; k++) {
      if (!(r.z[k] - h[k] > ELEVATED)) continue;
      for (let j = k; j >= 0 && r.s[k] - r.s[j] <= OVERLONG; j--) drawn[j] = 1;
      for (let j = k; j < r.n && r.s[j] - r.s[k] <= OVERLONG; j++) drawn[j] = 1;
    }
    const changed = drawn.some((v, k) => v !== r.drawn[k]);
    r.drawn = drawn;
    return changed;
  }

  // Rajallinen määrä korkeuskyselyjä piirtokertaa kohden: uudet nauhat ensin, sitten vanhentuneet.
  function refresh(now) {
    let budget = SAMPLE_BUDGET;
    for (const r of getRibbons()) {
      if (budget <= 0) break;
      if (!inArea(r)) continue;
      const g = ground.get(r);
      if (g && now - g.at < SAMPLE_MAX_AGE) continue;
      budget -= r.n;
      if (sample(r, now)) dirty = true;
    }
  }

  // Laatat ryhmittäin: piirretyt nauhat, joiden rajaukset ovat JOIN metrin päässä toisistaan.
  function clusters() {
    const items = [];
    for (const r of getRibbons()) {
      if (!inArea(r)) continue;
      const pad = JOIN / (EARTH_CIRC * Math.cos(r.lat * D2R)) + r.half, box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < r.n; k++) { // vain laatan kattama osa (raiteen nauha voi olla kilometrien pituinen)
        if (!r.drawn[k]) continue;
        box[0] = Math.min(box[0], r.x[k] - pad); box[1] = Math.min(box[1], r.y[k] - pad);
        box[2] = Math.max(box[2], r.x[k] + pad); box[3] = Math.max(box[3], r.y[k] + pad);
      }
      if (box[0] < Infinity) items.push({ r, box });
    }
    const parent = items.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    items.sort((a, b) => a.box[0] - b.box[0]);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length && items[j].box[0] <= items[i].box[2]; j++) {
        const a = items[i].box, b = items[j].box;
        if (b[1] <= a[3] && a[1] <= b[3]) parent[find(j)] = find(i);
      }
    }
    const groups = new Map();
    items.forEach((it, i) => {
      const k = find(i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it.r);
    });
    return [...groups.values()];
  }

  // Ryhmän verkko: kunkin nauhan piirretyt jaksot nauhana (yläpinta, reunat, alapinta ja päädyt).
  // Kärkipisteet metreinä ryhmän keskipisteestä, korkeus absoluuttisena korostus mukana.
  function buildMesh(rs) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rs) {
      for (let k = 0; k < r.n; k++) {
        if (r.drawn[k]) { x0 = Math.min(x0, r.x[k]); y0 = Math.min(y0, r.y[k]); x1 = Math.max(x1, r.x[k]); y1 = Math.max(y1, r.y[k]); }
      }
    }
    const refX = (x0 + x1) / 2, refY = (y0 + y1) / 2, lat = latOfY(refY), m = EARTH_CIRC * Math.cos(lat * D2R);
    const exag = map.getTerrain()?.exaggeration ?? 1;
    const top = [], topUv = [], sides = [], shadow = [];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const quad = (out, a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
    const local = ([x, y], z) => [(x - refX) * m, -(y - refY) * m, z];
    for (const r of rs) {
      // Reunat: keskilinjan normaali viereisten osien suunnasta.
      const L = [], R = [];
      for (let k = 0; k < r.n; k++) {
        const a = Math.max(0, k - 1), b = Math.min(r.n - 1, k + 1);
        const dx = r.x[b] - r.x[a], dy = r.y[b] - r.y[a], len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * r.half, ny = (dx / len) * r.half;
        L.push([r.x[k] + nx, r.y[k] + ny]);
        R.push([r.x[k] - nx, r.y[k] - ny]);
      }
      for (let k = 0; k < r.n - 1; k++) {
        if (!r.drawn[k] || !r.drawn[k + 1]) continue;
        const z0 = r.z[k] * exag + LIFT, z1 = r.z[k + 1] * exag + LIFT;
        const l0 = local(L[k], z0), l1 = local(L[k + 1], z1), r0 = local(R[k], z0), r1 = local(R[k + 1], z1);
        // Yläpinnan kolmiot ylöspäin (vastapäivään ylhäältä katsottuna).
        const up = (r0[0] - l0[0]) * (r1[1] - l0[1]) - (r0[1] - l0[1]) * (r1[0] - l0[0]) >= 0;
        if (up) quad(top, l0, r0, r1, l1); else quad(top, l0, l1, r1, r0);
        const uvs = up ? [L[k], R[k], R[k + 1], L[k], R[k + 1], L[k + 1]] : [L[k], L[k + 1], R[k + 1], L[k], R[k + 1], R[k]];
        for (const [x, y] of uvs) {
          topUv.push(x, y);
          box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
        }
        shadow.push([L[k], R[k], R[k + 1], L[k + 1], L[k]].map(([x, y]) => [lonOfX(x), latOfY(y)]));
        const down = (p) => [p[0], p[1], p[2] - THICKNESS];
        quad(sides, l0, l1, down(l1), down(l0)); // reunat
        quad(sides, r1, r0, down(r0), down(r1));
        quad(sides, down(l0), down(l1), down(r1), down(r0)); // alapinta
        if (k === 0 || !r.drawn[k - 1]) quad(sides, r0, l0, down(l0), down(r0)); // päädyt
        if (k + 1 === r.n - 1 || !r.drawn[k + 2]) quad(sides, l1, r1, down(r1), down(l1));
      }
    }
    const g = new THREE.BufferGeometry();
    const nTop = top.length / 3, uvs = new Float32Array(2 * (nTop + sides.length / 3));
    uvs.set(topUv);
    g.setAttribute("position", new THREE.Float32BufferAttribute([...top, ...sides], 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.computeVertexNormals(); // kärkipisteet eivät ole yhteisiä: pinnan normaali
    g.addGroup(0, nTop, 0);
    g.addGroup(nTop, sides.length / 3, 1);
    const topMaterial = new THREE.MeshBasicMaterial({ color: PLAIN });
    const mesh = new THREE.Mesh(g, [topMaterial, sideMaterial]);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    return { mesh, lon: lonOfX(refX), lat, box, top: topMaterial, gen: -1, shadow };
  }

  // Yläpinnan ilmakuva: ruudut kootaan kuvaksi, ja uv-koordinaatit (Web Mercator) muunnetaan sen
  // kuvan koordinaateiksi. Ilmakuvan voi ottaa pois ja takaisin, joten tekstuuri tehdään uudelleen.
  async function texture(entry) {
    const gen = (entry.gen = orthoGen);
    let z = TEX_ZOOM, n, tx0, ty0, nx, ny;
    for (;; z--) {
      n = 2 ** z;
      tx0 = Math.floor(entry.box[0] * n); ty0 = Math.floor(entry.box[1] * n);
      nx = Math.floor(entry.box[2] * n) - tx0 + 1; ny = Math.floor(entry.box[3] * n) - ty0 + 1;
      if ((nx <= TEX_TILES && ny <= TEX_TILES) || z <= 14) break;
    }
    const jobs = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) jobs.push(orthoImage(z, tx0 + i, ty0 + j).then((img) => [i, j, img]));
    const images = await Promise.all(jobs).catch(() => []);
    if (entry.gen !== gen || meshes.get(entry.key) !== entry) return; // vanhentunut
    if (!images.length || images.some(([, , img]) => !img)) {
      entry.top.map?.dispose();
      entry.top.map = null;
      entry.top.color.set(PLAIN);
      entry.top.needsUpdate = true;
      map.triggerRepaint();
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = nx * TILE_PX;
    canvas.height = ny * TILE_PX;
    const ctx = canvas.getContext("2d");
    for (const [i, j, img] of images) ctx.drawImage(img, i * TILE_PX, j * TILE_PX, TILE_PX, TILE_PX);
    // uv: Web Mercator → kuva. Mercator-koordinaatit muistetaan, sillä ruudukko voi vaihtua.
    const uv = entry.mesh.geometry.attributes.uv;
    if (!entry.merc) entry.merc = Float32Array.from(uv.array);
    for (let k = 0; k < uv.count; k++) {
      const mx = entry.merc[2 * k], my = entry.merc[2 * k + 1];
      if (!mx && !my) continue; // reunat ja alapinta
      uv.array[2 * k] = (mx * n - tx0) / nx;
      uv.array[2 * k + 1] = 1 - (my * n - ty0) / ny;
    }
    uv.needsUpdate = true;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    entry.top.map?.dispose();
    entry.top.map = tex;
    entry.top.color.set(0xffffff);
    entry.top.needsUpdate = true;
    map.triggerRepaint();
  }

  function dispose(entry) {
    group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.top.map?.dispose();
    entry.top.dispose();
    meshes.delete(entry.key);
  }

  function rebuild() {
    dirty = false;
    const keep = new Set();
    for (const rs of clusters()) {
      const key = rs.map((r) => `${r.id}:${r.drawn.join("")}`).sort().join("|");
      keep.add(key);
      if (meshes.has(key)) continue;
      const entry = buildMesh(rs);
      entry.key = key;
      meshes.set(key, entry);
      group.add(entry.mesh);
      texture(entry); // vasta, kun ryhmä on tallessa: valmistunut tekstuuri hylätään, jos ryhmä on jo poistettu
    }
    for (const [key, entry] of meshes) if (!keep.has(key)) dispose(entry);
    const polygons = [...meshes.values()].flatMap((e) => e.shadow);
    map.getSource(SHADOW)?.setData({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polygons.map((p) => [p]) } });
  }

  function draw(_, ctx) {
    group.visible = area != null;
    if (loaded && area) refresh(ctx.now);
    if (dirty) rebuild();
    if (!group.visible) return;
    for (const entry of meshes.values()) {
      const k = ctx.cosC / Math.cos(entry.lat * D2R);
      const wx = (mercX(entry.lon) - ctx.cmx) / ctx.sc, wy = -(mercY(entry.lat) - ctx.cmy) / ctx.sc;
      entry.mesh.matrix.set(k, 0, 0, wx, 0, k, 0, wy, 0, 0, k, -ctx.centerElev * k, 0, 0, 0, 1);
      entry.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  return {
    drawable: { object: group, draw, animating: () => false },
    // Alue, jolla laatat piirretään: { lon, lat, radius (m) } tai null.
    setArea(a) {
      area = a && { ...a, radius: Math.min(a.radius, MAX_RADIUS) };
      if (!area) for (const r of getRibbons()) r.drawn.fill(0); // ajoneuvot eivät ole laatoilla
      dirty = true;
      map.triggerRepaint();
    },
    // Ilmakuva otettiin pois tai näkyviin.
    setOrtho(on) {
      map.setLayoutProperty(SHADOW, "visibility", on ? "visible" : "none");
      orthoGen++;
      for (const entry of meshes.values()) texture(entry);
    },
  };
}
