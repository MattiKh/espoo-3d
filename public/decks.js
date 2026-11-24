// Siltojen kannet 3D-laattoina joukkoliikenteen 3D-tasolla (transit.js). Lähikuvan
// korkeusmallia ei nosteta kannen tasolle (bridges.js), joten sillan alla kulkeva tie tai uoma
// näkyy. Laatat tehdään niistä kansialueiden osista, joissa kansi on korkeusmallin mukaan
// maanpinnan yläpuolella. Pinnassa on ilmakuva samasta kohdasta (valaisematta, kuten maasto),
// reunat ja alapinta ovat betonin harmaita. Vierekkäiset kannet kootaan yhdeksi verkoksi, jolla
// on yksi ilmakuvatekstuuri. Ilmakuvassa silta näkyy myös maassa laatan alla; se tummennetaan
// varjoksi (karttataso sillat-varjo ilmakuvan päällä).
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import { deckSurfaceAt, elevatedDecks, onDeckChange } from "./bridges.js";

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const THICKNESS = 1.2; // m: kannen paksuus
const LIFT = 0.05; // m: kauempana maasto on nostettu kannen tasolle, ja laatta pysyy sen päällä
const MAX_RADIUS = 2500; // m
const TEX_ZOOM = 17, TEX_TILES = 3, TILE_PX = 512; // ilmakuvaruudut: taso, enintään kpl kumpaankin suuntaan
const PLAIN = 0xc3c6c6; // pinta ilman ilmakuvaa
const JOIN = 3; // m: näin lähellä toisiaan olevat kannet kootaan samaan verkkoon
const SHADOW = "sillat-varjo";
// Ramppi kannen päästä maanpinnalle: kaltevuus, näytteiden väli ja enimmäispituus (m).
const RAMP_GRADE = 0.08, RAMP_STEP = 2, RAMP_MAX = 80;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const lonOfX = (x) => x * 360 - 180;
const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

// orthoImage(z, x, y) → Promise<ImageBitmap | null>: ilmakuvaruutu (null, kun ilmakuva ei ole näkyvissä).
// ortho: onko ilmakuva näkyvissä (varjo tarvitaan vain sen päällä).
export function createDecks(map, { orthoImage, ortho = true }) {
  const group = new THREE.Group();
  const sideMaterial = new THREE.MeshLambertMaterial({ color: 0xbcb9b1, side: THREE.DoubleSide });
  const meshes = new Map(); // avain (kannet ja niiden osat) → { mesh, lon, lat, box, top }
  let area = null, dirty = true, orthoGen = 0;
  onDeckChange(() => { dirty = true; map.triggerRepaint(); });
  const layers = map.getStyle().layers, above = layers.findIndex((l) => l.id === "ortho");
  map.addSource(SHADOW, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: SHADOW, type: "fill", source: SHADOW, layout: { visibility: ortho ? "visible" : "none" },
    paint: { "fill-color": "#1b2024", "fill-opacity": 0.55 },
  }, layers[above + 1]?.id);

  // Alueen kannet ryhmiksi: kannet, joiden rajaukset ovat JOIN metrin päässä toisistaan.
  function clusters() {
    if (!area) return [];
    const cx = mercX(area.lon), cy = mercY(area.lat), unit = EARTH_CIRC * Math.cos(area.lat * D2R);
    const pad = JOIN / unit, items = [];
    for (const d of elevatedDecks()) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const P of [d.A, d.B]) {
        for (let i = 0; i < P.length; i += 3) {
          x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
        }
      }
      if (Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) * unit > area.radius) continue;
      items.push({ d, box: [x0 - pad, y0 - pad, x1 + pad, y1 + pad] });
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
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(it.d);
    });
    return [...groups.values()];
  }

  // Ryhmän verkko: kansien maanpinnan yläpuoliset osat (yläpinta, reunat, päädyt ja alapinta).
  // Kärkipisteet metreinä ryhmän keskipisteestä, korkeus absoluuttisena korostus mukana.
  function buildMesh(ds) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of ds) {
      for (const P of [d.A, d.B]) {
        for (let i = 0; i < P.length; i += 3) {
          x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
        }
      }
    }
    const refX = (x0 + x1) / 2, refY = (y0 + y1) / 2, lat = latOfY(refY), m = EARTH_CIRC * Math.cos(lat * D2R);
    const exag = map.getTerrain()?.exaggeration ?? 1;
    const top = [], topUv = [], sides = [], shadow = [];
    let pending = false; // maaston korkeutta ei vielä tiedetty rampin kohdalla
    const quad = (out, a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
    // Laatan pala nelikulmiosta a0–a1–b1–b0: p = [x, y, z] (Web Mercator, korkeus korostettuna).
    // start ja end: piirretäänkö pääty alku- ja loppureunaan.
    const piece = (pa0, pa1, pb0, pb1, start, end) => {
      const v = (p) => [(p[0] - refX) * m, -(p[1] - refY) * m, p[2]];
      let [a0, a1, b0, b1] = [pa0, pa1, pb0, pb1].map(v), [ua0, ua1, ub0, ub1] = [pa0, pa1, pb0, pb1];
      // Yläpinnan kolmiot ylöspäin (vastapäivään ylhäältä katsottuna).
      if ((b0[0] - a0[0]) * (b1[1] - a0[1]) - (b0[1] - a0[1]) * (b1[0] - a0[0]) < 0) {
        [a0, b0, a1, b1, ua0, ub0, ua1, ub1] = [b0, a0, b1, a1, ub0, ua0, ub1, ua1];
      }
      quad(top, a0, b0, b1, a1);
      quad(topUv, ...[ua0, ub0, ub1, ua1].map((p) => p.slice(0, 2)));
      shadow.push([ua0, ub0, ub1, ua1, ua0].map(([x, y]) => [lonOfX(x), latOfY(y)]));
      const down = (p) => [p[0], p[1], p[2] - THICKNESS];
      const [da0, da1, db0, db1] = [a0, a1, b0, b1].map(down);
      quad(sides, a0, a1, da1, da0); // reunat
      quad(sides, b1, b0, db0, db1);
      quad(sides, da0, da1, db1, db0); // alapinta
      if (start) quad(sides, b0, a0, da0, db0); // päädyt
      if (end) quad(sides, a1, b1, db1, da1);
    };
    const at = (P, i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2] * exag + LIFT];
    for (const d of ds) {
      const { A, B, up } = d, last = up.length - 1;
      for (let q = 0; q <= last; q++) {
        if (up[q]) piece(at(A, q), at(A, q + 1), at(B, q), at(B, q + 1), q === 0 || !up[q - 1], q === last || !up[q + 1]);
      }
      // Korkeusmallista on usein poistettu sillan mukana myös penkereen pää, joten kannen pää jää
      // maanpinnan yläpuolelle. Pää jatketaan rampiksi, kunnes se kohtaa maanpinnan.
      if (up[0]) ramp(at(A, 0), at(B, 0), at(A, 1), at(B, 1));
      if (up[last]) ramp(at(A, last + 1), at(B, last + 1), at(A, last), at(B, last));
    }

    // Ramppi kannen päästä (a, b) poispäin kannesta (sisempänä ia, ib), RAMP_GRADE kaltevuudella.
    // Ei rampia, jos pää on jo maan tasolla, sitä jatkaa toinen kansi tai maanpintaa ei kohdata.
    function ramp(a, b, ia, ib) {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      let ux = mx - (ia[0] + ib[0]) / 2, uy = my - (ia[1] + ib[1]) / 2;
      const len = Math.hypot(ux, uy) * m;
      if (!len) return;
      ux /= len; uy /= len; // Web Mercator -yksikköä metriä kohden
      const z0 = Math.min(a[2], b[2]), base = map.transform.elevation ?? 0;
      for (let s = RAMP_STEP; s <= RAMP_MAX; s += RAMP_STEP) {
        const lon = lonOfX(mx + ux * s), lat = latOfY(my + uy * s);
        if (s === RAMP_STEP && deckSurfaceAt(lon, lat) != null) return; // toinen kansi jatkaa
        const q = map.queryTerrainElevation([lon, lat]);
        if (q == null) { pending = true; return; }
        const drop = RAMP_GRADE * s * exag;
        if (q + base < z0 - drop - 0.2) continue;
        if (s === RAMP_STEP) return; // pää on jo maan tasolla
        const out = (p) => [p[0] + ux * s, p[1] + uy * s, p[2] - drop];
        piece(a, out(a), b, out(b), false, false);
        return;
      }
    }
    const g = new THREE.BufferGeometry();
    const nTop = top.length / 3, uvs = new Float32Array(2 * (nTop + sides.length / 3));
    for (let i = 0; i < nTop; i++) {
      uvs[2 * i] = topUv[2 * i];
      uvs[2 * i + 1] = topUv[2 * i + 1];
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute([...top, ...sides], 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.computeVertexNormals(); // kärkipisteet eivät ole yhteisiä: pinnan normaali
    g.addGroup(0, nTop, 0);
    g.addGroup(nTop, sides.length / 3, 1);
    const topMaterial = new THREE.MeshBasicMaterial({ color: PLAIN });
    const mesh = new THREE.Mesh(g, [topMaterial, sideMaterial]);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    // Tekstuurin rajaus yläpinnasta (rampit ulottuvat kannen ulkopuolelle).
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < topUv.length; i += 2) {
      box[0] = Math.min(box[0], topUv[i]); box[2] = Math.max(box[2], topUv[i]);
      box[1] = Math.min(box[1], topUv[i + 1]); box[3] = Math.max(box[3], topUv[i + 1]);
    }
    return { mesh, lon: lonOfX(refX), lat, box, top: topMaterial, gen: -1, shadow, pending };
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
    if (entry.gen !== gen || !meshes.has(entry.key)) return; // vanhentunut
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
    const keep = new Map();
    for (const ds of clusters()) {
      const key = ds.map((d) => `${d.id}:${d.up.map(Number).join("")}:${d.off}`).sort().join("|");
      let entry = meshes.get(key), tries = 0;
      if (entry?.pending && entry.tries < 3) { // ramppien maasto selvisi ehkä nyt
        tries = entry.tries + 1;
        dispose(entry);
        entry = null;
      }
      if (!entry) {
        entry = buildMesh(ds);
        entry.key = key;
        entry.tries = tries;
        meshes.set(key, entry);
        group.add(entry.mesh);
        texture(entry); // vasta, kun ryhmä on tallessa: valmistunut tekstuuri hylätään, jos ryhmä on jo poistettu
      }
      keep.set(key, entry);
    }
    for (const [key, entry] of meshes) if (!keep.has(key)) dispose(entry);
    if ([...meshes.values()].some((e) => e.pending && e.tries < 3)) setTimeout(() => { dirty = true; map.triggerRepaint(); }, 2000);
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
    // Alue, jolla kannet piirretään: { lon, lat, radius (m) } tai null.
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
