// Katot Espoon 3D-mallista (LOD2). LOD0-mallissa rakennuksella on vain yksi korkeus, joten
// MapLibren 3D-rakennukset ovat tasakattoisia laatikoita. Kaltevakattoisen rakennuksen seinät
// piirretään räystään korkeuteen (ominaisuus raystas, kun rakennuksen tilana on katto, ks. app.js),
// ja kattopinnat sekä räystään yläpuoliset seinänosat (päätykolmiot, korkeampien osien seinät)
// piirretään niiden päälle three.js:llä joukkoliikenteen 3D-tasolla (transit.js).
//
// Katot ovat tiilinä public/tiles/katot/14/x/y.bin (scripts/build_data.py, build_roofs). Ne
// ladataan lähikuvassa vain näkymän ympäriltä (setArea, säde layers.js:n detailRadius), ja vain
// piirrettyjen kattojen rakennusten seinät lasketaan räystääseen; muut näkyvät LOD0-korkeudessaan.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";

const PARALLEL = 4;
const ELEV_BUDGET = 150; // rakennusta piirtokertaa kohden: korkeus tarkistetaan maastosta
const ELEV_MAX_AGE = 4000; // ms: korkeusmalli tarkentuu, kun karttaa lähennetään
const ROOF_SHADE = 0.78; // katto hieman seiniä tummempi
// Katto nostetaan hieman, jottei 3D-rakennuksen tasainen yläpinta pistä räystäiden kohdalla katon
// läpi; seinien jatke räystään alla (build_data.py, ROOF_SKIRT) peittää raon.
const ROOF_LIFT = 0.25; // m
const PICK_RADIUS = 14; // px katon keskikohdasta
// Kauempana katot eivät juuri erotu, joten niitä piirretään enintään tämän säteen päähän
// (rakennukset näkyvät kauempanakin LOD0-korkeudessaan).
const MAX_RADIUS = 2500; // m

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;
const metersBetween = (lon, lat, a) => Math.hypot((lon - a.lon) * 111320 * Math.cos(a.lat * D2R), (lat - a.lat) * 111320);

// Värin tavut "#rrggbb"-muodossa; musta = ei tiedossa.
function hexColor(dv, o) {
  const v = (dv.getUint8(o) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o + 2);
  return v ? "#" + v.toString(16).padStart(6, "0") : null;
}

// Tiilen rakennukset (muoto: build_data.py, write_roof_tiles; KAT2: seinän ja katon väri,
// color_roof_tiles).
function parseTile(buf, classes) {
  const dv = new DataView(buf), dec = new TextDecoder(), magic = dec.decode(new Uint8Array(buf, 0, 4));
  if (magic !== "KAT1" && magic !== "KAT2") throw new Error("Tuntematon kattotiedosto");
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
    let seina = null, katto = null;
    if (magic === "KAT2") {
      seina = hexColor(dv, o);
      katto = hexColor(dv, o + 3);
      o += 6;
    }
    const verts = new Float32Array(3 * nv);
    for (let i = 0; i < verts.length; i++, o += 2) verts[i] = dv.getInt16(o, true) / 10;
    const tris = new Uint16Array(3 * (nRoof + nWall));
    for (let i = 0; i < tris.length; i++, o += 2) tris[i] = dv.getUint16(o, true);
    out.push({ tunnus, luokka, vuosi, lon, lat, korkeus, raystas, seina, katto, verts, tris, nRoof, base: null, baseAt: 0, range: null, state: false });
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
  let queue = [], active = 0, shown = visible, area = null, lastCtx = null;

  // Rakennuksen tila "katto" laskee sen seinät räystääseen (app.js), joten se on päällä vain,
  // kun katto todella piirretään.
  function featureState(b, on) {
    if (b.state === on) return;
    b.state = on;
    map.setFeatureState({ source: "rakennukset", sourceLayer: "rakennukset", id: b.tunnus }, { katto: on });
  }

  // Rakennuksen pohjan korkeus: maaston korkeus keskipisteessä (absoluuttinen, korostettu), kuten
  // MapLibre nostaa 3D-rakennuksen katon keskipisteen maastokorkeudelle. Palauttaa "uusi", "muuttui"
  // tai null.
  function sampleBase(b, centerElev, now) {
    const e = map.queryTerrainElevation([b.lon, b.lat]);
    b.baseAt = now;
    if (e == null) return null;
    const abs = e + centerElev;
    if (b.base != null && Math.abs(abs - b.base) < 0.1) return null;
    const first = b.base == null;
    b.base = abs;
    return first ? "uusi" : "muuttui";
  }

  // Tiilen kolmioverkko: kärkipisteet metreinä tiilen keskipisteestä (x itään, y pohjoiseen) ja
  // korkeus absoluuttisena. Jokaisella kolmiolla on omat kärkipisteensä ja normaalinaan kolmion
  // normaali. Tiedostossa pinnan kolmiot jakavat kärkipisteitä, ja pinnoissa on paikoin pieniä
  // vinoja kolmioita: yhteisen kärkipisteen normaali vääristäisi koko lappeen varjostuksen niin,
  // että harjakatto näyttäisi kuopalta.
  function buildMesh(t) {
    const shownB = [];
    for (const b of t.buildings) {
      const on = shown && area != null && b.base != null && isVisible(b) && metersBetween(b.lon, b.lat, area) < area.radius;
      featureState(b, on);
      b.range = null;
      if (on) shownB.push(b);
    }
    let nv = 0;
    for (const b of shownB) nv += b.tris.length;
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
    if (!nv) return;
    const pos = new Float32Array(3 * nv), nor = new Float32Array(3 * nv), col = new Float32Array(3 * nv);
    const refX = mercX(t.lon), refY = mercY(t.lat), m = EARTH_CIRC * Math.cos(t.lat * D2R);
    const wall = new THREE.Color(), roof = new THREE.Color();
    let v0 = 0;
    for (const b of shownB) {
      const dx = (mercX(b.lon) - refX) * m, dy = -(mercY(b.lat) - refY) * m;
      b.range = [v0, b.tris.length];
      // Yksi väri (katto hieman tummempi) tai seinille ja katolle omat ({ seina, katto }).
      const color = colorOf(b);
      wall.set(color.seina ?? color); // sRGB → lineaarinen
      if (color.katto) roof.set(color.katto);
      else roof.copy(wall).multiplyScalar(ROOF_SHADE);
      for (let j = 0; j < b.tris.length; j++) {
        const q = 3 * (v0 + j), i = 3 * b.tris[j];
        pos[q] = b.verts[i] + dx;
        pos[q + 1] = b.verts[i + 1] + dy;
        pos[q + 2] = b.verts[i + 2] + b.base + ROOF_LIFT;
      }
      for (let j = 0; j < b.tris.length; j += 3) {
        const a = 3 * (v0 + j);
        const ux = pos[a + 3] - pos[a], uy = pos[a + 4] - pos[a + 1], uz = pos[a + 5] - pos[a + 2];
        const wx = pos[a + 6] - pos[a], wy = pos[a + 7] - pos[a + 1], wz = pos[a + 8] - pos[a + 2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const c = j < 3 * b.nRoof ? roof : wall;
        for (let q = a; q < a + 9; q += 3) {
          nor[q] = nx; nor[q + 1] = ny; nor[q + 2] = nz;
          col[q] = c.r; col[q + 1] = c.g; col[q + 2] = c.b;
        }
      }
      v0 += b.tris.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    t.mesh = new THREE.Mesh(g, material);
    t.mesh.matrixAutoUpdate = false;
    t.mesh.frustumCulled = false;
    group.add(t.mesh);
  }

  // Maaston tarkentuessa rakennuksen korkeus päivitetään paikallaan.
  function moveBuilding(t, b) {
    if (!t.mesh || !b.range) return;
    const pos = t.mesh.geometry.attributes.position, [v0, n] = b.range;
    for (let j = 0; j < n; j++) pos.array[3 * (v0 + j) + 2] = b.verts[3 * b.tris[j] + 2] + b.base + ROOF_LIFT;
    pos.needsUpdate = true;
  }

  function dropTile(key, t) {
    for (const b of t.buildings) featureState(b, false);
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); }
    tiles.delete(key);
  }

  // Tiilet, jotka leikkaavat alueen ympyrää, lähimmät ensin.
  function wantedTiles() {
    if (!area || !shown) return [];
    const n = 2 ** Z, dLat = area.radius / 111320, dLon = area.radius / (111320 * Math.cos(area.lat * D2R));
    const x0 = Math.floor(mercX(area.lon - dLon) * n), x1 = Math.floor(mercX(area.lon + dLon) * n);
    const y0 = Math.floor(mercY(area.lat + dLat) * n), y1 = Math.floor(mercY(area.lat - dLat) * n);
    const cx = mercX(area.lon) * n, cy = mercY(area.lat) * n, out = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (available.has(`${x}/${y}`)) out.push([Math.hypot(x + 0.5 - cx, y + 0.5 - cy), `${x}/${y}`, x, y]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  function update() {
    const wanted = wantedTiles(), keys = new Set(wanted.map(([, key]) => key));
    for (const [key, t] of tiles) if (!keys.has(key)) dropTile(key, t);
    queue = [];
    for (const [, key, x, y] of wanted) {
      const t = tiles.get(key);
      if (t) { if (t.buildings.length) buildMesh(t); continue; }
      tiles.set(key, { x, y, lon: tileLon(x + 0.5, Z), lat: tileLat(y + 0.5, Z), buildings: [], mesh: null });
      queue.push(key);
    }
    pump();
    map.triggerRepaint();
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

  // Rajallinen määrä rakennuksia piirtokertaa kohden: korkeus tarkistetaan maastosta uudelleen,
  // koska korkeusmallin tarkemmat tiilet latautuvat vasta lähennettäessä.
  function refreshElevations(ctx) {
    let budget = ELEV_BUDGET;
    for (const t of tiles.values()) {
      let fresh = false;
      for (const b of t.buildings) {
        if (ctx.now - b.baseAt < ELEV_MAX_AGE || budget-- <= 0) continue;
        const change = sampleBase(b, ctx.centerElev, ctx.now);
        if (change === "uusi") fresh = true;
        else if (change === "muuttui") moveBuilding(t, b);
      }
      if (fresh) buildMesh(t); // pohja selvisi vasta nyt
      if (budget <= 0) return;
    }
  }

  function draw(_, ctx) {
    lastCtx = ctx;
    group.visible = shown && area != null;
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

  return {
    drawable: { object: group, draw, animating: () => false },
    // Alue, jolta katot piirretään: { lon, lat, radius (m) } tai null (ei kattoja).
    setArea(a) {
      area = a && { ...a, radius: Math.min(a.radius, MAX_RADIUS) };
      update();
    },
    setVisible(on) {
      shown = on;
      update();
    },
    // Väritys tai suodatus muuttui: verkot tehdään uudelleen.
    refresh() {
      for (const t of tiles.values()) if (t.buildings.length) buildMesh(t);
      map.triggerRepaint();
    },
    // Rakennus, jonka katon keskikohta on lähimpänä klikkausta (näytön pikseleissä), tai null.
    pick(point) {
      if (!group.visible || !lastCtx) return null;
      const { e, W, H, cmx, cmy, sc, cosC, centerElev } = lastCtx;
      let best = null, bestD = PICK_RADIUS ** 2;
      for (const t of tiles.values()) {
        for (const b of t.buildings) {
          if (!b.range) continue;
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
