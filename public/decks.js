// Siltojen korkeat jänteet 3D-laattoina joukkoliikenteen 3D-tasolla (transit.js). Lähikuvan
// korkeusmallia ei nosteta jänteiden kohdalla (bridges.js), joten sillan alla kulkeva tie tai
// raide näkyy. Laatat tehdään tarkkojen korkeusmallin tiilten pikseleistä, joissa siltojen ja
// kaistaleiden yhteinen pinta on korkealla maanpinnan yläpuolella: kussakin kohdassa on yksi pinta
// (ja silta toisen yllä toisena tasona). Pinnassa on uusin ilmakuva (valaisematta, kuten maasto),
// reunat ja alapinta ovat betonin harmaita. Ilmakuvassa silta näkyy myös maassa laatan alla; se
// tummennetaan varjoksi (karttataso sillat-varjo ilmakuvan päällä).
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import { getSpanTiles, onDeckChange } from "./bridges.js";

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const THICKNESS = 1.2; // m: kannen paksuus
const LIFT = 0.05; // m: kauempana maasto on nostettu kannen tasolle, ja laatta pysyy sen päällä
const MAX_RADIUS = 2500; // m
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
  const meshes = new Map(); // korkeusmallin tiili z/x/y → { mesh, lon, lat, box, top, shadow, version }
  let area = null, dirty = true, orthoGen = 0;
  onDeckChange(() => { dirty = true; map.triggerRepaint(); });
  const layers = map.getStyle().layers, above = layers.findIndex((l) => l.id === "ortho");
  map.addSource(SHADOW, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: SHADOW, type: "fill", source: SHADOW, layout: { visibility: ortho ? "visible" : "none" },
    paint: { "fill-color": "#1b2024", "fill-opacity": 0.55 },
  }, layers[above + 1]?.id);

  // Tiilen laatat: kunkin tason jännepikselit yläpintana, reunoina (naapuri ei ole jänne, myös
  // viereisestä tiilestä katsottuna) ja alapintana. Kulmapisteen korkeus on sen ympärillä olevien
  // jännepikseleiden keskiarvo, joten pinta on yhtenäinen. Kärkipisteet metreinä tiilen
  // keskipisteestä, korkeus absoluuttisena korostus mukana.
  function buildMesh(t, tiles) {
    const n = 2 ** t.z, W = t.W, H = t.H;
    const refX = (t.x + 0.5) / n, refY = (t.y + 0.5) / n, lat = latOfY(refY), m = EARTH_CIRC * Math.cos(lat * D2R);
    const exag = map.getTerrain()?.exaggeration ?? 1;
    const top = [], topUv = [], sides = [], shadow = [];
    const quad = (out, a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const neighbour = (dx, dy) => tiles.get(`${t.z}/${t.x + dx}/${t.y + dy}`);
    for (const level of ["cells", "upper"]) {
      const cells = t[level];
      // Onko pikseli (i, j) jänne tällä tasolla; tiilen ulkopuolella katsotaan naapuritiilestä.
      const span = (i, j) => {
        if (i >= 0 && j >= 0 && i < W && j < H) return cells.has(j * W + i);
        const nb = neighbour(i < 0 ? -1 : i >= W ? 1 : 0, j < 0 ? -1 : j >= H ? 1 : 0);
        return !!nb && nb[level].has(((j + H) % H) * W + ((i + W) % W));
      };
      const node = new Map();
      const nodeZ = (i, j) => { // kulmapiste (i, j) = pikselien (i - 1 … i, j - 1 … j) kulma
        const key = j * (W + 1) + i;
        if (!node.has(key)) {
          let sum = 0, cnt = 0;
          for (const [a, b] of [[i - 1, j - 1], [i, j - 1], [i - 1, j], [i, j]]) {
            const z = a >= 0 && b >= 0 && a < W && b < H ? cells.get(b * W + a) : undefined;
            if (z != null) { sum += z; cnt++; }
          }
          node.set(key, (sum / cnt) * exag + LIFT);
        }
        return node.get(key);
      };
      const merc = (i, j) => [(t.x + i / W) / n, (t.y + j / H) / n];
      const v = (i, j, down) => {
        const [x, y] = merc(i, j);
        return [(x - refX) * m, -(y - refY) * m, nodeZ(i, j) - (down ? THICKNESS : 0)];
      };
      for (let j = 0; j < H; j++) {
        let run = -1;
        for (let i = 0; i <= W; i++) {
          const here = i < W && cells.has(j * W + i);
          if (here && run < 0) run = i;
          if (!here && run >= 0) { // varjo pikselirivin jaksoista
            shadow.push([merc(run, j), merc(i, j), merc(i, j + 1), merc(run, j + 1), merc(run, j)].map(([x, y]) => [lonOfX(x), latOfY(y)]));
            run = -1;
          }
          if (!here) continue;
          // Kulmat: luode, lounas, kaakko ja koillinen (vastapäivään ylhäältä katsottuna).
          const nw = v(i, j), sw = v(i, j + 1), se = v(i + 1, j + 1), ne = v(i + 1, j);
          quad(top, nw, sw, se, ne);
          const [x0, y0] = merc(i, j), [x1, y1] = merc(i + 1, j + 1);
          topUv.push(x0, y0, x0, y1, x1, y1, x0, y0, x1, y1, x1, y0);
          box[0] = Math.min(box[0], x0); box[1] = Math.min(box[1], y0); box[2] = Math.max(box[2], x1); box[3] = Math.max(box[3], y1);
          const dnw = v(i, j, true), dsw = v(i, j + 1, true), dse = v(i + 1, j + 1, true), dne = v(i + 1, j, true);
          quad(sides, dnw, dne, dse, dsw); // alapinta
          if (!span(i, j - 1)) quad(sides, nw, ne, dne, dnw); // reunat
          if (!span(i, j + 1)) quad(sides, se, sw, dsw, dse);
          if (!span(i - 1, j)) quad(sides, sw, nw, dnw, dsw);
          if (!span(i + 1, j)) quad(sides, ne, se, dse, dne);
        }
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

  // Tiilet tehdään uudelleen, kun niiden tai naapuritiilten jänteet muuttuivat (naapurin jänne
  // poistaa reunan tiilten rajalta).
  function rebuild() {
    dirty = false;
    const tiles = getSpanTiles(), keep = new Set();
    for (const [key, t] of tiles) {
      if (!area || (!t.cells.size && !t.upper.size)) continue;
      const n = 2 ** t.z, unit = EARTH_CIRC * Math.cos(area.lat * D2R);
      const d = Math.hypot((t.x + 0.5) / n - mercX(area.lon), (t.y + 0.5) / n - mercY(area.lat)) * unit;
      if (d > area.radius + unit / n) continue;
      keep.add(key);
      const nv = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => tiles.get(`${t.z}/${t.x + dx}/${t.y + dy}`)?.version ?? 0).join();
      const old = meshes.get(key);
      if (old && old.version === t.version && old.nv === nv) continue;
      if (old) dispose(old);
      const entry = buildMesh(t, tiles);
      Object.assign(entry, { key, version: t.version, nv });
      meshes.set(key, entry);
      group.add(entry.mesh);
      texture(entry); // vasta, kun tiili on tallessa: valmistunut tekstuuri hylätään, jos tiili on jo poistettu
    }
    for (const [key, entry] of meshes) if (!keep.has(key)) dispose(entry);
    const polygons = [...meshes.values()].flatMap((e) => e.shadow);
    map.getSource(SHADOW)?.setData({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: polygons.map((r) => [r]) } });
  }

  function draw(_, ctx) {
    group.visible = area != null;
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
