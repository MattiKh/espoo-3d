// Katot Espoon 3D-mallista (LOD2). LOD0-mallissa rakennuksella on vain yksi korkeus, joten
// MapLibren 3D-rakennukset ovat tasakattoisia laatikoita. Kaltevakattoisen rakennuksen seinät
// piirretään räystään korkeuteen (ominaisuus raystas, kun rakennuksen tilana on katto, ks. app.js),
// ja kattopinnat sekä räystään yläpuoliset seinänosat (päätykolmiot, korkeampien osien seinät)
// piirretään niiden päälle three.js:llä joukkoliikenteen 3D-tasolla (transit.js).
//
// Katot ovat tiilinä public/tiles/katot/14/x/y.bin (scripts/build_data.py, build_roofs). Ne
// ladataan lähikuvassa näkymän ympäriltä, ja vain ladattujen rakennusten seinät lasketaan
// räystääseen; muut näkyvät LOD0-korkeudessaan.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";

export const ROOF_MINZOOM = 13.5; // tätä kauempaa katsottaessa uusia kattoja ei ladata
const LOAD_RADIUS = 2500; // m näkymän keskipisteestä zoomaustasolla 14 (lähempää pienempi)
const MAX_TILES = 40; // muistissa pidettävät tiilet; kaukaisimmat poistetaan
const PARALLEL = 4;
const ELEV_BUDGET = 300; // rakennusta piirtokertaa kohden: korkeus tarkistetaan maastosta
const ELEV_MAX_AGE = 4000; // ms: korkeusmalli tarkentuu, kun karttaa lähennetään
const MIN_ZOOM_DRAWN = 11.5; // kauempaa 3D-rakennukset ovat lähes näkymättömiä (app.js)
const ROOF_SHADE = 0.78; // katto hieman seiniä tummempi
const PICK_RADIUS = 14; // px katon keskikohdasta

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;

// Tiilen rakennukset (muoto: build_data.py, write_roof_tiles).
function parseTile(buf, classes) {
  const dv = new DataView(buf), dec = new TextDecoder();
  if (dec.decode(new Uint8Array(buf, 0, 4)) !== "KAT1") throw new Error("Tuntematon kattotiedosto");
  const n = dv.getUint32(4, true), out = [];
  let o = 8;
  for (let b = 0; b < n; b++) {
    const len = dv.getUint8(o);
    const tunnus = dec.decode(new Uint8Array(buf, o + 1, len));
    o += 1 + len;
    const luokka = classes[dv.getUint8(o)], vuosi = dv.getUint16(o + 1, true) || null;
    const lon = dv.getInt32(o + 3, true) / 1e7, lat = dv.getInt32(o + 7, true) / 1e7;
    const korkeus = dv.getUint16(o + 11, true) / 10, raystas = dv.getUint16(o + 13, true) / 10;
    const nv = dv.getUint16(o + 15, true), nRoof = dv.getUint16(o + 17, true), nWall = dv.getUint16(o + 19, true);
    o += 21;
    const verts = new Float32Array(3 * nv);
    for (let i = 0; i < verts.length; i++, o += 2) verts[i] = dv.getInt16(o, true) / 10;
    const tris = new Uint16Array(3 * (nRoof + nWall));
    for (let i = 0; i < tris.length; i++, o += 2) tris[i] = dv.getUint16(o, true);
    out.push({ tunnus, luokka, vuosi, lon, lat, korkeus, raystas, verts, tris, nRoof, base: null, baseAt: 0 });
  }
  return out;
}

async function fetchTile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kattotiili ${res.status}`);
  let data = await res.arrayBuffer();
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  return data;
}

export async function createRoofs(map, { url, version, colorOf, isVisible, visible = true }) {
  const index = await fetch(`${url}/index.json?v=${version}`).then((r) => r.json());
  const Z = index.zoom, available = new Set(index.tiilet);
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const tiles = new Map(); // "x/y" → { x, y, lon, lat, buildings, mesh }
  const queue = [];
  let active = 0, shown = visible, lastCtx = null;

  const featureState = (b, on) =>
    map.setFeatureState({ source: "rakennukset", sourceLayer: "rakennukset", id: b.tunnus }, { katto: on });

  // Rakennuksen pohjan korkeus: maaston korkeus keskipisteessä (absoluuttinen, korostettu), kuten
  // MapLibre nostaa 3D-rakennuksen katon keskipisteen maastokorkeudelle.
  function sampleBase(b, centerElev, now) {
    const e = map.queryTerrainElevation([b.lon, b.lat]);
    b.baseAt = now;
    if (e == null) return false;
    const abs = e + centerElev;
    if (b.base != null && Math.abs(abs - b.base) < 0.1) return false;
    const first = b.base == null;
    b.base = abs;
    if (first) featureState(b, true);
    return true;
  }

  // Tiilen kolmioverkko: kärkipisteet metreinä tiilen keskipisteestä (x itään, y pohjoiseen) ja
  // korkeus absoluuttisena. Kullakin pinnalla on omat kärkipisteensä, joten normaali on pinnan normaali.
  function buildMesh(t) {
    for (const b of t.buildings) b.range = null;
    const shownB = t.buildings.filter((b) => b.base != null && isVisible(b));
    let nv = 0, ni = 0;
    for (const b of shownB) { nv += b.verts.length / 3; ni += b.tris.length; }
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
    if (!ni) return;
    const pos = new Float32Array(3 * nv), nor = new Float32Array(3 * nv), col = new Float32Array(3 * nv);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    const refX = mercX(t.lon), refY = mercY(t.lat), m = EARTH_CIRC * Math.cos(t.lat * D2R);
    const c = new THREE.Color();
    let v0 = 0, i0 = 0;
    for (const b of shownB) {
      const dx = (mercX(b.lon) - refX) * m, dy = -(mercY(b.lat) - refY) * m;
      const n = b.verts.length / 3;
      for (let i = 0; i < n; i++) {
        pos[3 * (v0 + i)] = b.verts[3 * i] + dx;
        pos[3 * (v0 + i) + 1] = b.verts[3 * i + 1] + dy;
        pos[3 * (v0 + i) + 2] = b.verts[3 * i + 2] + b.base;
      }
      b.range = [v0, n];
      c.set(colorOf(b)); // sRGB → lineaarinen
      for (let j = 0; j < b.tris.length; j += 3) {
        const a = v0 + b.tris[j], bb = v0 + b.tris[j + 1], cc = v0 + b.tris[j + 2];
        idx[i0 + j] = a; idx[i0 + j + 1] = bb; idx[i0 + j + 2] = cc;
        const ux = pos[3 * bb] - pos[3 * a], uy = pos[3 * bb + 1] - pos[3 * a + 1], uz = pos[3 * bb + 2] - pos[3 * a + 2];
        const wx = pos[3 * cc] - pos[3 * a], wy = pos[3 * cc + 1] - pos[3 * a + 1], wz = pos[3 * cc + 2] - pos[3 * a + 2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const shade = j < 3 * b.nRoof ? ROOF_SHADE : 1;
        for (const q of [a, bb, cc]) {
          nor[3 * q] = nx; nor[3 * q + 1] = ny; nor[3 * q + 2] = nz;
          col[3 * q] = c.r * shade; col[3 * q + 1] = c.g * shade; col[3 * q + 2] = c.b * shade;
        }
      }
      v0 += n;
      i0 += b.tris.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    t.mesh = new THREE.Mesh(g, material);
    t.mesh.matrixAutoUpdate = false;
    t.mesh.frustumCulled = false;
    group.add(t.mesh);
  }

  // Maaston tarkentuessa rakennuksen korkeus päivitetään paikallaan.
  function moveBuilding(t, b) {
    if (!t.mesh || !b.range) return;
    const pos = t.mesh.geometry.attributes.position, [v0, n] = b.range;
    for (let i = 0; i < n; i++) pos.array[3 * (v0 + i) + 2] = b.verts[3 * i + 2] + b.base;
    pos.needsUpdate = true;
  }

  function wantedTiles() {
    const zoom = map.getZoom();
    if (zoom < ROOF_MINZOOM || !shown) return [];
    const c = map.getCenter(), n = 2 ** Z;
    const R = Math.max(600, Math.min(LOAD_RADIUS, LOAD_RADIUS * 2 ** (14 - zoom)));
    const dLat = R / 111415, dLon = R / (111320 * Math.cos(c.lat * D2R));
    const x0 = Math.floor(mercX(c.lng - dLon) * n), x1 = Math.floor(mercX(c.lng + dLon) * n);
    const y0 = Math.floor(mercY(c.lat + dLat) * n), y1 = Math.floor(mercY(c.lat - dLat) * n);
    const cx = mercX(c.lng) * n, cy = mercY(c.lat) * n, out = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (available.has(`${x}/${y}`)) out.push([Math.hypot(x + 0.5 - cx, y + 0.5 - cy), x, y]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]).map(([, x, y]) => [x, y]);
  }

  function update() {
    for (const [x, y] of wantedTiles()) {
      const key = `${x}/${y}`;
      if (tiles.has(key)) continue;
      tiles.set(key, { x, y, lon: tileLon(x + 0.5, Z), lat: tileLat(y + 0.5, Z), buildings: [], mesh: null });
      queue.push(key);
    }
    pump();
    evict();
  }

  function pump() {
    while (active < PARALLEL && queue.length) {
      const key = queue.shift(), t = tiles.get(key);
      if (!t) continue;
      active++;
      fetchTile(`${url}/${Z}/${key}.bin?v=${version}`)
        .then((buf) => {
          if (tiles.get(key) !== t) return;
          t.buildings = parseTile(buf, index.luokat);
          const centerElev = map.transform.elevation ?? 0, now = performance.now();
          for (const b of t.buildings) sampleBase(b, centerElev, now);
          buildMesh(t);
          map.triggerRepaint();
        })
        .catch((err) => { console.warn("Kattoja ei saatu ladattua", key, err); tiles.delete(key); })
        .finally(() => { active--; pump(); });
    }
  }

  function evict() {
    if (tiles.size <= MAX_TILES) return;
    const c = map.getCenter(), n = 2 ** Z, cx = mercX(c.lng) * n, cy = mercY(c.lat) * n;
    const far = [...tiles.entries()].sort((a, b) => Math.hypot(b[1].x - cx, b[1].y - cy) - Math.hypot(a[1].x - cx, a[1].y - cy));
    for (const [key, t] of far.slice(0, tiles.size - MAX_TILES)) {
      for (const b of t.buildings) if (b.base != null) featureState(b, false);
      if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); }
      tiles.delete(key);
    }
  }

  // Muutama sata rakennusta piirtokertaa kohden: korkeus tarkistetaan maastosta uudelleen, koska
  // korkeusmallin tarkemmat tiilet latautuvat vasta lähennettäessä.
  function refreshElevations(ctx) {
    let budget = ELEV_BUDGET;
    for (const t of tiles.values()) {
      let fresh = 0;
      for (const b of t.buildings) {
        if (ctx.now - b.baseAt < ELEV_MAX_AGE || budget-- <= 0) continue;
        const first = b.base == null;
        if (sampleBase(b, ctx.centerElev, ctx.now)) {
          if (first) fresh++;
          else moveBuilding(t, b);
        }
      }
      if (fresh) buildMesh(t); // pohja selvisi vasta nyt
      if (budget <= 0) return;
    }
  }

  function draw(map, ctx) {
    lastCtx = ctx;
    group.visible = shown && ctx.zoom >= MIN_ZOOM_DRAWN;
    if (!group.visible) return;
    for (const t of tiles.values()) {
      if (!t.mesh) continue;
      const k = ctx.cosC / Math.cos(t.lat * D2R);
      const wx = (mercX(t.lon) - ctx.cmx) / ctx.sc, wy = -(mercY(t.lat) - ctx.cmy) / ctx.sc;
      t.mesh.matrix.set(k, 0, 0, wx, 0, k, 0, wy, 0, 0, k, -ctx.centerElev * k, 0, 0, 0, 1);
      t.mesh.matrixWorldNeedsUpdate = true;
    }
    refreshElevations(ctx);
  }

  map.on("moveend", update);
  update();

  return {
    drawable: { object: group, draw, animating: () => false },
    setVisible(on) {
      shown = on;
      update();
      map.triggerRepaint();
    },
    // Väritys tai suodatus (ilmakuvan vuosi) muuttui: verkot tehdään uudelleen.
    refresh() {
      for (const t of tiles.values()) buildMesh(t);
      map.triggerRepaint();
    },
    // Rakennus, jonka katon keskikohta on lähimpänä klikkausta (näytön pikseleissä), tai null.
    pick(point) {
      if (!group.visible || !lastCtx) return null;
      const { e, W, H, cmx, cmy, sc, cosC, centerElev } = lastCtx;
      let best = null, bestD = PICK_RADIUS ** 2;
      for (const t of tiles.values()) {
        if (!t.mesh) continue;
        for (const b of t.buildings) {
          if (b.base == null || !isVisible(b)) continue;
          const k = cosC / Math.cos(b.lat * D2R);
          const wx = (mercX(b.lon) - cmx) / sc, wy = -(mercY(b.lat) - cmy) / sc;
          const wz = (b.base - centerElev + (b.raystas + b.korkeus) / 2) * k;
          const w = e[3] * wx + e[7] * wy + e[11] * wz + e[15];
          if (w <= 0) continue;
          const sx = (((e[0] * wx + e[4] * wy + e[8] * wz + e[12]) / w + 1) / 2) * W;
          const sy = ((1 - (e[1] * wx + e[5] * wy + e[9] * wz + e[13]) / w) / 2) * H;
          const d = (sx - point.x) ** 2 + (sy - point.y) ** 2;
          if (d < bestD) { bestD = d; best = b; }
        }
      }
      return best;
    },
  };
}
