// Maaston pinta (pelillinen maasto). HSY:n maanpeiteaineiston luokat (metsät korkeusluokittain, pellot,
// tiet, vesi, ...) ovat valmiina rasteriruutuina (scripts/build_data.py, public/tiles/maanpeite):
// koko Espoo tarkkoina (0,3 m), niistä koottuna välitasona (1,2 m) ja yleiskuvana (noin 5 ja 38 m).
// Selain maalaa niistä työsäikeessä (pelimaasto_worker.js) tekstuurit, ja MapLibre levittää ne
// maaston päälle rasteriruutuina; rinnevarjostus antaa maastolle muodot.
// Päällä ovat kantakartan teiden ja polkujen reunaviivat, kadunnimet kantakartan sijainnein ja
// suunnin sekä OpenStreetMapista kaistaviivat, suojatiet ja raiteet (vektoritiilet public/tiles/pelimaasto)
// ja 3D-sillat (public/tiles/pelisillat). Kaikki ladataan ruuduittain vain näkymän ympäriltä.
// Metsissä on kameran ympärillä matalapolygonisia 3D-puita joukkoliikenteen 3D-tasolla
// (transit.js): lehtipuilla pyöreä latvus, havupuilla kartio. Puut ovat maaston raskain osa
// (korkeuskyselyt ja kymmenet tuhannet ilmentymät), joten ne voi ottaa paneelista pois.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import { setGameDecks } from "./bridges.js";

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

// Ruudun maalaus työsäikeessä. Jos MapLibre ei enää tarvitse ruutua (kartta siirtyi), maalaus perutaan.
maplibregl.addProtocol("peli", async (params, abortController) => {
  const [z, x, y] = params.url.slice("peli://".length).split("/").map(Number);
  const id = seq + 1;
  abortController.signal.addEventListener("abort", () => pending.has(id) && worker.postMessage({ type: "cancel", cancel: id }));
  return { data: (await ask({ type: "tile", z, x, y })).buffer };
});

// 3D-sillat (scripts/build_data.py, game_bridges): kansi, reunakaiteet ja pilarit matalapolygonisina.
// Pelillisen maaston korkeusmallissa korkeat jänteet ovat auki, joten sillan alta kulkeva tie näkyy.
// Sillat ovat ruuduittain (taso 14, noin 1,2 km), ja ne ladataan kameran ympäriltä: lähellä täysi malli,
// kauempana pelkkä kansi (kaiteet, viivat ja pilarit jäävät alle pikselin), ja kaukaiset vapautetaan.
const BRIDGE_NEAR = 1500; // m: täysi malli näin lähellä kamerasta
const BRIDGE_FAR = 6000; // m: kansi näin kauas (kauempana jänne näkyy maastossa vain kapeana aukkona)
const BRIDGE_RELEASE = 1.25; // malli vapautetaan, kun ruutu on näin paljon rajaa kauempana
const BRIDGE_CHECK = 300; // ms: tarvittavat ruudut tarkistetaan näin usein
const BRIDGE_BUILDS = 2; // malleja rakennetaan enintään näin monta piirtokertaa kohden
const DECK_REACH = 1.0; // m: ajoneuvo on kannella näin kaukana kannen reunasta (sijainnin epätarkkuus)
const DECK = 1.0, RAIL_H = 0.9, RAIL_T = 0.25; // m: kannen paksuus, kaiteen korkeus ja paksuus
const PIER_STEP = 24, PIER_DEPTH = 40, END_EXTRA = 2; // m: pilarien väli ja syvyys, kantta jatketaan päistä
// Värit ovat tummia, sillä 3D-tason valaistus on kirkas (kannen pinta vastaa maaston asfalttia).
const BRIDGE_TOP = { tie: [0.12, 0.125, 0.14], kevyt: [0.4, 0.37, 0.32], raide: [0.22, 0.2, 0.18] };
const CONCRETE = [0.46, 0.45, 0.43], RAILING = [0.3, 0.33, 0.36], MARKING = [0.92, 0.92, 0.9];
const DASH = 3, DASH_GAP = 9, DASH_HALF = 0.175; // m: kaistaviivat kannella kuten maassa (3 m viiva, 9 m väli)
const EDGE_HALF = 0.125, EDGE = [0.88, 0.86, 0.8]; // m: ajoradan reunaviiva kannella (kuten kantakartan reunat maassa)
// Raide raidesillan kannella kuten maassa (pelimaasto-raidepohja, -ratapolkyt ja -kisko-tasot): sepelipohja
// 3,2 m, ratapölkyt 2,5 m pitkiä ja 0,22 m leveitä 0,6 m välein sekä kiskot 0,75 m keskilinjasta.
// Raitiotien (ra: ratikka, build_data.py) sepeli on tummempi kuten maassa.
const BALLAST = { rata: [0.4, 0.36, 0.31], ratikka: [0.34, 0.32, 0.3] }, SLEEPER = [0.22, 0.15, 0.09], RAIL_TOP = [0.8, 0.82, 0.84];
const BALLAST_HALF = 1.6, SLEEPER_HALF = 1.25, SLEEPER_W = 0.22, SLEEPER_STEP = 0.6, GAUGE_HALF = 0.75, RAIL_HALF = 0.09;
const BALLAST_Z = 0.05, SLEEPER_Z = 0.12, RAIL_Z = 0.22, RAIL_FOOT = 0.13; // m kannen yläpuolella

let bridgeMaterial = null;

// Maastoeditorilla (editori.py) tehdyt siltakorjaukset (public/data/siltakorjaukset.json): siltaosan
// voi poistaa, sen päitä voi jatkaa tai lyhentää ja päätuet ottaa pois tai lisätä. Osa tunnistetaan
// lajista ja alkuperäisten päiden sijainnista, joten tunnus säilyy, kun sillat tehdään uudelleen.
export function bridgeId({ p, k }) {
  const n = p.length;
  return `${k}:${p[0].toFixed(5)},${p[1].toFixed(5)}:${p[n - 3].toFixed(5)},${p[n - 2].toFixed(5)}`;
}

// Siltaosa korjauksen jälkeen, tai null, jos osa on poistettu. alku/loppu (m): positiivinen jatkaa
// pään suuntaan samalla korkeudella, negatiivinen lyhentää (osaa jää vähintään metri).
export function editedBridge(s, e) {
  if (!e) return s;
  if (e.poista) return null;
  if (!e.alku && !e.loppu && !e.tu) return s;
  const lon0 = s.p[0], lat0 = s.p[1], unit = EARTH_CIRC * Math.cos(lat0 * D2R);
  let pts = [];
  for (let i = 0; i < s.p.length; i += 3) pts.push([(mercX(s.p[i]) - mercX(lon0)) * unit, (mercY(s.p[i + 1]) - mercY(lat0)) * unit, s.p[i + 2]]);
  let ka = s.ka ? [...s.ka] : null;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const fromStart = (d) => {
    if (!d || pts.length < 2) return;
    if (d > 0) {
      const [a, b] = pts, ln = dist(a, b) || 1;
      pts = [[a[0] + ((a[0] - b[0]) / ln) * d, a[1] + ((a[1] - b[1]) / ln) * d, a[2]], ...pts];
      if (ka) ka = [ka[0], ...ka];
      return;
    }
    let left = -d;
    while (pts.length > 2 && dist(pts[0], pts[1]) <= left) {
      left -= dist(pts[0], pts[1]);
      pts = pts.slice(1);
      if (ka) ka = ka.slice(1);
    }
    const seg = dist(pts[0], pts[1]), t = Math.max(0, Math.min(left, seg - 1)) / (seg || 1);
    pts[0] = pts[0].map((v, j) => v + (pts[1][j] - v) * t);
  };
  fromStart(e.alku);
  pts.reverse();
  ka?.reverse();
  fromStart(e.loppu);
  pts.reverse();
  ka?.reverse();
  const p = pts.flatMap(([x, y, z]) => [lonOfX(mercX(lon0) + x / unit), latOfY(mercY(lat0) + y / unit), z]);
  return { ...s, p, ...(ka ? { ka: ka.join("") } : {}), ...(e.tu ? { tu: e.tu } : {}) };
}

// Siltojen malli ruudulle (full: kaiteet, ajoradan viivat ja pilarit; muuten pelkkä kansi).
function bridgeMesh(list, ref, exag, full) {
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
  for (const { p, w, k, v, r, ka, tu, ra } of list) {
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
        // Kaide reunalla: ulkopinta, sisäpinta ja yläpinta. Ei toisen sillan kannella (ka: bitti 1 vasen, 2 oikea).
        if (!full || (ka && !(+ka[i] & (side > 0 ? 1 : 2)))) continue;
        const inner = side - Math.sign(side) * RAIL_T;
        quad(at(i, side, z0), at(i + 1, side, z1), at(i + 1, side, z1 + RAIL_H), at(i, side, z0 + RAIL_H), RAILING);
        quad(at(i, inner, z0), at(i + 1, inner, z1), at(i + 1, inner, z1 + RAIL_H), at(i, inner, z0 + RAIL_H), RAILING);
        quad(at(i, side, z0 + RAIL_H), at(i + 1, side, z1 + RAIL_H), at(i + 1, inner, z1 + RAIL_H), at(i, inner, z0 + RAIL_H), RAILING);
      }
    }
    for (const i of [0, P.length - 1]) quad(at(i, w, P[i][2]), at(i, -w, P[i][2]), at(i, -w, P[i][2] - DECK), at(i, w, P[i][2] - DECK), CONCRETE);
    // Päätytuet vapaisiin päihin, jotka ovat maaston yläpuolella (tu, build_data.py): esim. portaisiin
    // tai rakennukseen päättyvä kevyen liikenteen silta ei jää ilmaan.
    for (const [i, j] of [[0, 1], [P.length - 1, P.length - 2]].filter((_, e) => tu?.[e])) {
      const dx = P[j][0] - P[i][0], dy = P[j][1] - P[i][1], ln = Math.hypot(dx, dy) || 1, ux = dx / ln, uy = dy / ln;
      const x = P[i][0] + ux * (END_EXTRA + 0.6), y = P[i][1] + uy * (END_EXTRA + 0.6), z = P[i][2], [nx, ny] = N[i], cw = w * 0.9;
      box([[x + nx * cw - ux * 0.6, y + ny * cw - uy * 0.6], [x - nx * cw - ux * 0.6, y - ny * cw - uy * 0.6],
        [x - nx * cw + ux * 0.6, y - ny * cw + uy * 0.6], [x + nx * cw + ux * 0.6, y + ny * cw + uy * 0.6]], z - DECK - PIER_DEPTH, z - DECK, CONCRETE);
    }
    if (!full) continue;
    // Kaistaviivat kannen pintaan (v: siirrot oikealle kulkusuuntaan nähden, m).
    const S = [0];
    for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const along = (t, d, dz = 0.03) => { // piste matkalla t, d metriä oikealle, dz metriä kannen yläpuolella
      let i = 0;
      while (i < P.length - 2 && S[i + 1] < t) i++;
      const f = Math.min(1, Math.max(0, (t - S[i]) / (S[i + 1] - S[i] || 1)));
      const nx = N[i][0] + (N[i + 1][0] - N[i][0]) * f, ny = N[i][1] + (N[i + 1][1] - N[i][1]) * f;
      return [P[i][0] + (P[i + 1][0] - P[i][0]) * f - nx * d, P[i][1] + (P[i + 1][1] - P[i][1]) * f - ny * d,
        P[i][2] + (P[i + 1][2] - P[i][2]) * f + dz];
    };
    // Kaistale kannen pinnalla matkalta t0–t1 sivusiirtojen d0–d1 välissä korkeudella dz.
    const strip = (t0, t1, d0, d1, dz, color) => quad(along(t0, d0, dz), along(t0, d1, dz), along(t1, d1, dz), along(t1, d0, dz), color);
    if (k === "raide") {
      const len = S.at(-1);
      for (let i = 0; i < P.length - 1; i++) strip(S[i], S[i + 1], -BALLAST_HALF, BALLAST_HALF, BALLAST_Z, BALLAST[ra] ?? BALLAST.rata);
      for (let t = SLEEPER_STEP / 2; t + SLEEPER_W < len; t += SLEEPER_STEP) {
        strip(t, t + SLEEPER_W, -SLEEPER_HALF, SLEEPER_HALF, SLEEPER_Z, SLEEPER);
      }
      // Kiskot: yläpinta ja kyljet, jotta kisko erottuu pölkkyjen päältä myös viistosti katsottuna.
      for (const c of [-GAUGE_HALF, GAUGE_HALF]) {
        for (let i = 0; i < P.length - 1; i++) {
          strip(S[i], S[i + 1], c - RAIL_HALF, c + RAIL_HALF, RAIL_Z, RAIL_TOP);
          for (const d of [c - RAIL_HALF, c + RAIL_HALF]) {
            quad(along(S[i], d, RAIL_FOOT), along(S[i + 1], d, RAIL_FOOT), along(S[i + 1], d, RAIL_Z), along(S[i], d, RAIL_Z), RAILING);
          }
        }
      }
    }
    // Ajoradan reunaviivat: sivusiirrot maanpinnan reunaviivoista sillan päistä (r: [alussa, lopussa]),
    // jolloin ne jatkavat tien reunaviivoja; välissä siirto vaihtuu tasaisesti. Ilman niitä ajoradan
    // reuna on metrin päässä kannen reunasta.
    const edges = r?.length ? r : k === "tie" ? [[w - 1, w - 1], [1 - w, 1 - w]] : [];
    for (const [d0, d1] of edges) {
      const d = (t) => d0 + ((d1 - d0) * t) / (S.at(-1) || 1);
      for (let i = 0; i < P.length - 1; i++) {
        const a = d(S[i]), b = d(S[i + 1]);
        quad(along(S[i], a - EDGE_HALF), along(S[i], a + EDGE_HALF), along(S[i + 1], b + EDGE_HALF), along(S[i + 1], b - EDGE_HALF), EDGE);
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
  bridgeMaterial ??= new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true });
  const mesh = new THREE.Mesh(geometry, bridgeMaterial);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
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

// MapLibre (4.7) korvaa 3D-maastotilassa puuttuvan rasteriruudun vain neljällä alaruudulla tai
// ladatulla yläruudulla ja piilottaa muut ladatut ruudut; välimuistiin siirrettyjä ruutuja se ei
// ota takaisin. Loitonnettaessa maastoruutu jäi siksi toisinaan yhdeksi kuvaksi ilman pintaa, ja
// kartta välähti. Pelillisen maaston pinnalle, varjostukselle ja viivoille käytetään tavallista (2D) säilytystä,
// ja puuttuvan ruudun ladatut ylä- ja alaruudut (kaksi tasoa) pidetään näkyvissä myös välimuistista,
// kunnes ruutu on valmis. Päällekkäiset ruudut rajataan stensiilillä kuten 2D-kartassa (tarkin päällä).
function keepLoadedTiles(map, ids) {
  for (const id of ids) {
    const cache = map.style?.sourceCaches?.[id], update = cache && Object.getPrototypeOf(cache)._updateCoveredAndRetainedTiles;
    if (!update) continue;
    cache._updateCoveredAndRetainedTiles = function (retain, minZoom, maxZoom, zoom, ideal) {
      update.call(this, retain, minZoom, maxZoom, zoom, ideal, undefined);
      const keep = (tileID) => {
        this._addTile(tileID);
        retain[tileID.key] = tileID;
        delete this._coveredTiles[tileID.key];
      };
      for (const tileID of ideal) {
        if (this._tiles[tileID.key]?.hasData()) continue;
        const parent = this.findLoadedParent(tileID, this._source.minzoom);
        if (parent) keep(parent.tileID);
        for (const child of tileID.children(this._source.maxzoom)) {
          for (const c of [child, ...(child.overscaledZ < this._source.maxzoom ? child.children(this._source.maxzoom) : [])]) {
            const tile = this._tiles[c.key] ?? this._cache.getByKey(c.wrapped().key);
            if (tile?.hasData()) keep(c);
          }
        }
      }
    };
  }
}

export async function createGameTerrain(map, { base, version }) {
  const info = await fetch(`${base}data/maanpeite.json?v=${version}`).then((r) => r.json());
  worker.postMessage({ type: "init", base, version, info });
  const layers = map.getStyle().layers, before = layers[layers.findIndex((l) => l.id === "tausta") + 1]?.id;
  // Yleiskuvan ansiosta pinta näkyy myös loitonnettaessa koko Espoon näkymään asti.
  const bounds = info.alue;
  map.addSource("pelimaasto", {
    type: "raster", tiles: ["peli://{z}/{x}/{y}"], tileSize: 512, minzoom: 8, maxzoom: 19, bounds,
    attribution: "Maanpeite © HSY",
  });
  map.addSource("pelimaasto-dem", {
    // Pelillisen tilan korkeusmalli (sillat auki, bridges.js), sillä varjostus näkyy vain siinä.
    // Varjostus koko näkymään, jottei yleiskuvan reuna erotu taustasta.
    type: "raster-dem", tiles: ["dem://{z}/{x}/{y}?peli"], encoding: "terrarium", tileSize: 512, maxzoom: 15,
  });
  keepLoadedTiles(map, ["pelimaasto", "pelimaasto-dem"]);
  map.addLayer({ id: "pelimaasto", type: "raster", source: "pelimaasto", layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } }, before);
  map.addLayer({
    id: "pelimaasto-varjostus", type: "hillshade", source: "pelimaasto-dem", layout: { visibility: "none" },
    paint: {
      "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#1d2b1c", "hillshade-highlight-color": "#fff6d8",
      "hillshade-accent-color": "#263524",
    },
  }, before);
  // Viivat ja nimet vektoritiilinä (tasot 12–15, build_data.py): kaukaiset tiilet ovat karkeampia, ja niissä
  // on vähemmän kohteita (kauimpana vain raiteet). Lähempänä tason 15 tiiliä suurennetaan.
  map.addSource("pelimaasto-kanta", {
    type: "vector", tiles: [`gz://${base}tiles/pelimaasto/{z}/{x}/{y}.pbf?v=${version}`], minzoom: 12, maxzoom: 15, bounds,
    attribution: "Kantakartta © Espoon kaupunki",
  });
  keepLoadedTiles(map, ["pelimaasto-kanta"]); // vektoritiilet tulevat verkosta, joten puuttuva tiili näkyisi pidempään
  const edgeWidth = ["interpolate", ["exponential", 2], ["zoom"], 15, 0.5, 18, 2, 20, 5];
  map.addLayer({
    id: "pelimaasto-reunat", type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 15,
    filter: ["in", ["get", "k"], ["literal", ["ajorata", "kevyt"]]],
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "k"], "ajorata", "#f3f0e4", "#e2d9c0"], "line-width": edgeWidth, "line-opacity": 0.9 },
  }, before);
  map.addLayer({
    id: "pelimaasto-polut", type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 15,
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "k"], "polku"]],
    layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": "#d9c9a0", "line-width": edgeWidth, "line-dasharray": [2, 2], "line-opacity": 0.9 },
  }, before);
  // Kaistaviivat: keskiviiva vastakkaisten suuntien välissä ja kaistaviivat saman suunnan kaistojen
  // välissä, valkoisia (3 m viiva, 9 m väli; katkoviivan mitat ovat viivan leveyden kerrannaisia).
  for (const [id, k] of [["pelimaasto-keskiviivat", "keski"], ["pelimaasto-kaistaviivat", "kaista"]]) {
    map.addLayer({
      id, type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 16, filter: ["==", ["get", "k"], k],
      layout: { visibility: "none", "line-join": "round" },
      paint: { "line-color": "#f6f5ef", "line-width": meters(0.35), "line-dasharray": [3 / 0.35, 9 / 0.35] },
    }, before);
  }
  // Suojatie: ylityksen suuntainen 3 m leveä katkoviiva, jonka viivat (0,5 m, väli 0,5 m) ovat
  // ajoradan suuntaisia raitoja. Pyörätien jatke: kaksi riviä 0,5 m neliöitä ylityksen reunoilla.
  map.addLayer({
    id: "pelimaasto-suojatiet", type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 16, filter: ["==", ["get", "k"], "suojatie"],
    layout: { visibility: "none" },
    paint: { "line-color": "#f8f7f2", "line-width": meters(3), "line-dasharray": [0.5 / 3, 0.5 / 3] },
  }, before);
  for (const [id, side] of [["pelimaasto-pyorajatke-v", -1], ["pelimaasto-pyorajatke-o", 1]]) {
    map.addLayer({
      id, type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 16.5, filter: ["==", ["get", "k"], "pyorajatke"],
      layout: { visibility: "none" },
      paint: { "line-color": "#f8f7f2", "line-width": meters(0.5), "line-dasharray": [1, 1], "line-offset": meters(side * 1.2) },
    }, before);
  }
  // Raiteet: sepelipohja, ratapölkyt ja kaksi kiskoa (raideleveys noin 1,5 m).
  const rails = ["in", ["get", "k"], ["literal", ["rata", "ratikka"]]];
  map.addLayer({
    id: "pelimaasto-raidepohja", type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 14, filter: rails,
    layout: { visibility: "none", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "k"], "rata", "#8a7f71", "#76716a"], "line-width": meters(3.2) },
  }, before);
  map.addLayer({
    id: "pelimaasto-ratapolkyt", type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 16.5, filter: rails,
    layout: { visibility: "none" },
    paint: { "line-color": "#4e3b2a", "line-width": meters(2.5), "line-dasharray": [0.22 / 2.5, 0.38 / 2.5] },
  }, before);
  for (const [id, side] of [["pelimaasto-kisko-v", -1], ["pelimaasto-kisko-o", 1]]) {
    map.addLayer({
      id, type: "line", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 15.5, filter: rails,
      layout: { visibility: "none", "line-join": "round" },
      paint: { "line-color": "#dfe3e6", "line-width": meters(0.18), "line-offset": meters(side * 0.75) },
    }, before);
  }
  // Nimet maaston pintaan kuten kantakartassa; rakennukset peittävät ne, joten ne ovat rakennusten alla.
  const size = (small, medium, large) => ["match", ["get", "koko"], "suuri", large, "keskikokoinen", medium, small];
  map.addLayer({
    id: "pelimaasto-nimet", type: "symbol", source: "pelimaasto-kanta", "source-layer": "kanta", minzoom: 15.5,
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      visibility: "none", "text-field": ["get", "nimi"], "text-font": ["Noto Sans Bold"], "text-letter-spacing": 0.04,
      "text-size": ["interpolate", ["exponential", 2], ["zoom"], 16, size(9, 11, 13), 19, size(24, 30, 36)],
      "text-rotate": ["get", "kulma"], "text-rotation-alignment": "map", "text-pitch-alignment": "map",
    },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(28, 38, 28, 0.85)", "text-halo-width": 1.4 },
  }, before);

  const root = new THREE.Group(), group = new THREE.Group(), bridges = new THREE.Group();
  group.matrixAutoUpdate = false;
  root.add(group, bridges);
  // Siltaruudut: "x/y" → { x, y, ref, list (ladattu data), want (full | deck | null), full, deck (mallit) }.
  let bridgeZoom = 14, bridgeCheck = 0;
  const bridgeIndex = [], chunks = new Map();
  let bridgeEdits = new Map(); // siltakorjaukset tunnuksittain (editedBridge)
  const editsReady = fetch(`${base}data/siltakorjaukset.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      bridgeEdits = new Map((d?.korjaukset ?? []).map((e) => [e.id, e]));
    })
    .catch(() => {}); // ei korjauksia
  const applyEdits = (c) => {
    c.list = c.raw.map((s) => editedBridge(s, bridgeEdits.get(bridgeId(s)))).filter(Boolean);
    c.decks = c.list.map(deckOf);
  };
  fetch(`${base}data/pelimaasto_sillat.json?v=${version}`).then((r) => (r.ok ? r.json() : { ruudut: [] }))
    .then(({ taso = 14, ruudut }) => {
      bridgeZoom = taso;
      for (let i = 0; i < ruudut.length; i += 2) bridgeIndex.push([ruudut[i], ruudut[i + 1]]);
      map.triggerRepaint();
    })
    .catch((err) => console.warn("Siltoja ei saatu ladattua", err));
  let visible = false, treesOn = false, meshes = null;
  let trees = null, ref = null, heights = null, next = 0, passAt = 0, passes = 0, asking = false;

  function inArea([lon, lat]) {
    const [w, s, e, n] = info.alue;
    return lon > w && lon < e && lat > s && lat < n;
  }

  // Uudet puut keskipisteen ympäriltä (työsäie), korkeudet haetaan vähitellen. Puut ovat kiinteässä
  // ruudukossa maailman koordinaateissa, joten edelliseltä kerralta tutut puut sijoitetaan heti
  // samalle korkeudelle ja maastosta haetaan vain uusien korkeus; muuten metsä välähtäisi, kun
  // kaikki puut piilotettaisiin ja palautettaisiin vähitellen.
  async function plant(c) {
    asking = true;
    try {
      const { trees: t } = await ask({ type: "trees", x: mercX(c.lng), y: mercY(c.lat), radius: TREE_RADIUS });
      if (!treesOn) return;
      const known = new Map();
      for (let i = 0; heights && i < heights.length; i++) {
        if (!Number.isNaN(heights[i])) known.set(`${trees[5 * i]},${trees[5 * i + 1]}`, heights[i]);
      }
      trees = t;
      ref = { lon: c.lng, lat: c.lat, unit: EARTH_CIRC * Math.cos(c.lat * D2R) };
      heights = new Float32Array(trees.length / 5);
      next = 0;
      passes = 0;
      const n = Math.min(TREE_MAX, heights.length), hide = new THREE.Matrix4().makeScale(0, 0, 0);
      for (const mesh of Object.values(meshes)) mesh.count = n;
      for (let i = 0; i < heights.length; i++) {
        heights[i] = known.get(`${trees[5 * i]},${trees[5 * i + 1]}`) ?? NaN;
        if (i >= n) continue;
        if (Number.isNaN(heights[i])) for (const mesh of Object.values(meshes)) mesh.setMatrixAt(i, hide);
        else placeTree(i, heights[i]);
      }
      for (const mesh of Object.values(meshes)) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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

  // Korkeudet maastosta piirtokerroittain (HEIGHT_BUDGET); ensimmäisellä kierroksella vain uusille
  // puille, ja yksi uusintakierros kaikille, kun korkeusmalli tarkentuu.
  function fillHeights(now) {
    if (!heights || next >= heights.length && (passes > 1 || now - passAt < HEIGHT_RECHECK)) return false;
    if (next >= heights.length) {
      next = 0;
      passes++;
    }
    const base = map.transform.elevation ?? 0, n = Math.min(heights.length, TREE_MAX);
    let used = 0;
    for (; next < n && used < HEIGHT_BUDGET; next++) {
      if (passes === 0 && !Number.isNaN(heights[next])) continue; // tuttu puu, jo paikallaan
      used++;
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

  // Siltaruutujen tarve kameran etäisyyden mukaan: ruudut BRIDGE_FARin sisällä ladataan, ja kaukaiset
  // vapautetaan (BRIDGE_RELEASE, jottei rajalla ladata ja vapauteta jatkuvasti). Täysi malli
  // vapautetaan, kun kansi on valmis, jottei silta katoa välillä.
  function updateBridges(now) {
    if (now - bridgeCheck < BRIDGE_CHECK) return;
    bridgeCheck = now;
    const { lng, lat: camLat } = map.transform.getCameraPosition().lngLat, n = 2 ** bridgeZoom;
    const cx = mercX(lng), cy = mercY(camLat), unit = EARTH_CIRC * Math.cos(camLat * D2R);
    for (const [x, y] of bridgeIndex) {
      const dx = Math.max(x / n - cx, 0, cx - (x + 1) / n), dy = Math.max(y / n - cy, 0, cy - (y + 1) / n);
      const d = Math.hypot(dx, dy) * unit, key = `${x}/${y}`;
      let c = chunks.get(key);
      if (!c) {
        if (d > BRIDGE_FAR) continue;
        const lon = lonOfX((x + 0.5) / n), lat = latOfY((y + 0.5) / n);
        c = { ref: { lon, lat, unit: EARTH_CIRC * Math.cos(lat * D2R) }, list: null, full: null, deck: null, d };
        chunks.set(key, c);
        const chunk = c;
        fetch(`${base}tiles/pelisillat/${bridgeZoom}/${x}/${y}.json?v=${version}`).then((r) => (r.ok ? r.json() : { sillat: [] }))
          .then(async ({ sillat }) => {
            await editsReady;
            chunk.raw = sillat;
            applyEdits(chunk);
            map.triggerRepaint();
          })
          .catch((err) => console.warn("Siltaruutua ei saatu ladattua", key, err));
      }
      c.d = d;
      if (d > BRIDGE_FAR * BRIDGE_RELEASE) {
        dropMesh(c, "full");
        dropMesh(c, "deck");
        chunks.delete(key);
      } else if (d > BRIDGE_NEAR * BRIDGE_RELEASE && c.deck) {
        dropMesh(c, "full");
      }
    }
  }

  // Ajoneuvot kannelle (bridges.js, transit.js): kannet paikallisina metreinä kuten transit.js.
  const local = (lon, lat) => [(lon - 24.7) * 55462, (lat - 60.2) * 111415];
  function deckOf({ p, w, k }) {
    const pts = [];
    for (let i = 0; i < p.length; i += 3) pts.push([...local(p[i], p[i + 1]), p[i + 2]]);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]), m = w + DECK_REACH;
    return { pts, w, k, box: [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m] };
  }
  setGameDecks((lon, lat) => {
    const n = 2 ** bridgeZoom, cx = Math.floor(mercX(lon) * n), cy = Math.floor(mercY(lat) * n), [x, y] = local(lon, lat), out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const d of chunks.get(`${cx + dx}/${cy + dy}`)?.decks ?? []) {
          if (x < d.box[0] || y < d.box[1] || x > d.box[2] || y > d.box[3]) continue;
          let best = Infinity, z = null, u = null;
          for (let i = 1; i < d.pts.length; i++) {
            const [ax, ay, az] = d.pts[i - 1], [bx, by, bz] = d.pts[i], ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
            const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0;
            const dist = Math.hypot(ax + ex * t - x, ay + ey * t - y);
            if (dist < best && l2) { best = dist; z = az + (bz - az) * t; u = [ex / Math.sqrt(l2), ey / Math.sqrt(l2)]; }
          }
          if (best <= d.w + DECK_REACH) out.push({ z, k: d.k, u });
        }
      }
    }
    return out;
  });

  function dropMesh(c, lod) {
    if (!c[lod]) return;
    bridges.remove(c[lod]);
    c[lod].geometry.dispose();
    c[lod] = null;
  }

  // Puuttuvat mallit lähimmästä ruudusta alkaen, enintään BRIDGE_BUILDS piirtokertaa kohden.
  function buildBridges() {
    const exag = map.getTerrain()?.exaggeration ?? 1;
    const todo = [...chunks.values()].filter((c) => c.list?.length && (c.d < BRIDGE_NEAR ? !c.full : !c.deck));
    todo.sort((a, b) => a.d - b.d);
    for (const c of todo.slice(0, BRIDGE_BUILDS)) {
      const lod = c.d < BRIDGE_NEAR ? "full" : "deck";
      c[lod] = bridgeMesh(c.list, c.ref, exag, lod === "full");
      bridges.add(c[lod]);
    }
    return todo.length > BRIDGE_BUILDS;
  }

  let bridgesBusy = false;
  function draw(_, ctx) {
    bridges.visible = visible && ctx.zoom >= 14;
    if (bridges.visible) {
      updateBridges(ctx.now);
      bridgesBusy = buildBridges() || [...chunks.values()].some((c) => !c.list);
      for (const c of chunks.values()) {
        const full = !!c.full && (c.d < BRIDGE_NEAR * BRIDGE_RELEASE || !c.deck);
        if (c.full) c.full.visible = full;
        if (c.deck) c.deck.visible = !full;
        const mesh = full ? c.full : c.deck;
        if (!mesh) continue;
        const k = ctx.cosC / Math.cos(c.ref.lat * D2R);
        const wx = (mercX(c.ref.lon) - ctx.cmx) / ctx.sc, wy = -(mercY(c.ref.lat) - ctx.cmy) / ctx.sc;
        mesh.matrix.set(k, 0, 0, wx, 0, k, 0, wy, 0, 0, k, -ctx.centerElev * k, 0, 0, 0, 1);
      }
    }
    const on = visible && treesOn && ctx.zoom >= TREE_MINZOOM;
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
    map.triggerRepaint();
  }

  // Puut mukaan tai pois; mallit luodaan vasta, kun puut valitaan ensimmäisen kerran.
  function setTrees(on) {
    treesOn = on;
    if (on && !meshes) {
      meshes = treeMeshes();
      group.add(meshes.trunk, meshes.cone, meshes.round);
    }
    if (!on) {
      trees = ref = heights = null;
      next = 0;
      for (const mesh of Object.values(meshes ?? {})) mesh.count = 0;
    }
    map.triggerRepaint();
  }

  const animating = () => visible && (bridgesBusy || treesOn && (asking || (heights != null && next < Math.min(heights.length, TREE_MAX))));

  // Mittauksia varten (selaimen konsoli): ladatut siltaruudut ja kolmiot sekä työsäikeen luokkaruudut.
  async function stats() {
    let full = 0, triangles = 0;
    for (const c of chunks.values()) {
      full += c.full ? 1 : 0;
      for (const mesh of [c.full, c.deck]) triangles += mesh ? mesh.geometry.attributes.position.count / 3 : 0;
    }
    const { id, ...worker } = await ask({ type: "stats" });
    return { siltaruutuja: chunks.size, luettelossa: bridgeIndex.length, taysia: full, siltakolmioita: triangles, ...worker };
  }
  // Maastoeditoria varten: ladatut siltaosat ({ id, raw: alkuperäinen, piece: korjattu tai null, edit })
  // ja korjausten vaihto (mallit tehdään uudelleen seuraavilla piirtokerroilla).
  function bridgePieces() {
    const out = [];
    for (const c of chunks.values()) {
      for (const s of c.raw ?? []) {
        const id = bridgeId(s), edit = bridgeEdits.get(id);
        out.push({ id, raw: s, piece: editedBridge(s, edit), edit });
      }
    }
    return out;
  }
  function setBridgeEdits(list) {
    bridgeEdits = new Map(list.map((e) => [e.id, e]));
    for (const c of chunks.values()) {
      if (!c.raw) continue;
      applyEdits(c);
      dropMesh(c, "full");
      dropMesh(c, "deck");
    }
    map.triggerRepaint();
  }

  return { drawable: { object: root, draw, animating }, setVisible, setTrees, stats, bridgePieces, setBridgeEdits };
}
