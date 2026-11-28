// Maastoeditori (editori.py, vain paikallisesti). Kartan päälle tulee paneeli, jolla korkeusmallia
// korjataan siveltimellä: nosta, laske, tasoita, pehmennä ja palauta. Jokainen veto lähetetään
// palvelimelle, joka tallentaa lopputuloksen erotustiiliksi (korjaukset/maasto) ja leipoo korjatut tiilet
// (scripts/maastokorjaus.py). Kartta hakee sen jälkeen korjatut korkeusmallin tiilet uudelleen.
// bridges.js on sama moduuli kuin kartalla (sama osoite), joten hakemiston päivitys koskee karttaa.
import { setTerrainFixes } from "../bridges.js";

const D2R = Math.PI / 180;
// Leveys metreinä karttapikseleiksi zoomaustason mukaan (512 px:n ruudut, Espoon leveysaste; kuten pelimaasto.js).
const M_PER_PX0 = 78271.517 * Math.cos(60.185 * D2R);
const meters = (m) => ["interpolate", ["exponential", 2], ["zoom"], 10, ["*", m, 2 ** 10 / M_PER_PX0], 22, ["*", m, 2 ** 22 / M_PER_PX0]];

const TOOLS = [
  { id: "liiku", name: "Liiku", key: "1", color: "#8a97a3", hint: "Kartta liikkuu ja kohteita voi klikata kuten tavallisesti." },
  { id: "nosta", name: "Nosta", key: "2", color: "#e8a33d", hint: "Nostaa maata määrän verran. Klikkaus tekee kohouman, veto penkereen." },
  { id: "laske", name: "Laske", key: "3", color: "#3d8be8", hint: "Laskee maata määrän verran. Klikkaus tekee kuopan, veto uoman." },
  { id: "tasoita", name: "Tasoita", key: "4", color: "#9b6be8", hint: "Tasoittaa maan vedon alkukohdan korkeudelle tai kiinteään tasoon. <kbd>Alt</kbd>+klikkaus poimii tason kartalta." },
  { id: "pehmenna", name: "Pehmennä", key: "5", color: "#2fb37f", hint: "Pehmentää piikit ja kuopat ympäristön keskiarvoon. Rinne säilyy rinteenä." },
  { id: "palauta", name: "Palauta", key: "6", color: "#e05555", hint: "Palauttaa alkuperäisen maanpinnan siveltimen alueelta (kumoaa korjaukset paikallisesti)." },
  { id: "silta", name: "Silta", key: "7", color: "#5b8fd6", hint: "Klikkaa 3D-siltaa valitaksesi siltaosan. Osan voi poistaa (<kbd>Delete</kbd>), sen päitä voi jatkaa tai lyhentää ja päätuet ottaa pois." },
];
const BRIDGE_KINDS = { tie: "Ajoneuvosilta", kevyt: "Kevyen liikenteen silta", raide: "Ratasilta" };
const EARTH_CIRC = 40075016.686;
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const latOfY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;
const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const colorExpr = ["match", ["get", "tyyppi"], ...TOOLS.flatMap((t) => [t.id, t.color]), "#888888"];

const fmt = (v, d = 1) => v.toLocaleString("fi-FI", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtR = (r) => fmt(r, r < 10 && r % 1 ? 1 : 0);
const round7 = (v) => Math.round(v * 1e7) / 1e7;
const distM = ([a, b], [c, d]) => Math.hypot((c - a) * 111320 * Math.cos(b * D2R), (d - b) * 110574);

// --- Asetukset (muistetaan selaimessa) --------------------------------------------------------------

const SETTINGS_KEY = "espoo3d-maastoeditori";
const state = {
  tool: "liiku", sade: 6, kovuus: 0.5, maara: 0.5, voimakkuus: 0.7, taso: null, kiinteaTaso: false,
  korosta: true, alueet: false,
};
try {
  // Korjausten rajat ovat aina aluksi piilossa, jotta ne eivät jää kasaksi korjattavan kohdan päälle.
  Object.assign(state, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"), { tool: "liiku", alueet: false });
} catch { /* ei tallennettuja asetuksia */ }
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state));
  } catch { /* yksityinen ikkuna tms. */ }
};

// history: tämän istunnon vedot (palvelin pitää kumoamista varten), canRedo: uudelleen tehtävien määrä.
let history = [], canRedo = 0, index = { versio: 0, tiilet: {} }, gitInfo = {}, bridgeEdits = [];
// Silta-työkalu: osoitettu ja valittu siltaosa ({ id, raw, piece, edit } pelimaasto.js:n bridgePieces-luettelosta).
let hoverBridge = null, selBridge = null, selId = null, lookupAt = 0;
const game = () => window.espooGame;
const pendingStrokes = [];
let stroke = null, space = false, suppressClick = false, cursorAt = null;

// --- Kartta -----------------------------------------------------------------------------------------

const map = await new Promise((resolve) => {
  const t = setInterval(() => window.espooMap && (clearInterval(t), resolve(window.espooMap)), 50);
});
if (!map.style?._loaded) await new Promise((r) => map.once("style.load", r));
document.body.classList.add("editori");

const empty = { type: "FeatureCollection", features: [] };
for (const id of ["ed-alueet", "ed-veto", "ed-sivellin"]) map.addSource(id, { type: "geojson", data: empty });
const isLine = ["==", ["geometry-type"], "LineString"], isArea = ["==", ["geometry-type"], "Polygon"];
const lineLayout = { "line-cap": "round", "line-join": "round" };
// Tehtyjen korjausten rajat (valinnainen): vain ohut reunaviiva, jotta päällekkäiset korjaukset eivät
// peitä maastoa. Nauhan reunat (line-gap-width = nauhan leveys) ja ympyrän kehä.
map.addLayer({ id: "ed-alueet-reuna", type: "line", source: "ed-alueet", filter: isLine, layout: lineLayout, paint: { "line-color": colorExpr, "line-width": 1, "line-gap-width": meters(["*", 2, ["get", "sade"]]), "line-opacity": 0.6 } });
map.addLayer({ id: "ed-alueet-kaari", type: "line", source: "ed-alueet", filter: isArea, paint: { "line-color": colorExpr, "line-width": 1, "line-opacity": 0.6 } });
// Korjauslistassa osoitettu korjaus näkyy aina (myös, kun rajat ovat piilossa).
map.addLayer({ id: "ed-korostus-ala", type: "fill", source: "ed-alueet", filter: ["all", isArea, ["==", ["get", "id"], ""]], paint: { "fill-color": colorExpr, "fill-opacity": 0.55 } });
map.addLayer({ id: "ed-korostus", type: "line", source: "ed-alueet", filter: ["all", isLine, ["==", ["get", "id"], ""]], layout: lineLayout, paint: { "line-color": colorExpr, "line-width": meters(["*", 2, ["get", "sade"]]), "line-opacity": 0.55 } });
map.addLayer({ id: "ed-veto-ala", type: "fill", source: "ed-veto", filter: isArea, paint: { "fill-color": colorExpr, "fill-opacity": 0.45 } });
map.addLayer({ id: "ed-veto", type: "line", source: "ed-veto", filter: isLine, layout: lineLayout, paint: { "line-color": colorExpr, "line-width": meters(["*", 2, ["get", "sade"]]), "line-opacity": 0.45 } });
map.addLayer({ id: "ed-sivellin-varjo", type: "line", source: "ed-sivellin", paint: { "line-color": "rgba(10, 20, 25, 0.6)", "line-width": 3.5 } });
map.addLayer({ id: "ed-sivellin", type: "line", source: "ed-sivellin", filter: ["==", ["get", "osa"], "ulko"], paint: { "line-color": "#ffffff", "line-width": 1.6 } });
map.addLayer({ id: "ed-sivellin-sisa", type: "line", source: "ed-sivellin", filter: ["==", ["get", "osa"], "sisa"], paint: { "line-color": "#ffffff", "line-width": 1.2, "line-dasharray": [2, 2] } });

function ring([lon, lat], r, n = 56) {
  const dx = r / (111320 * Math.cos(lat * D2R)), dy = r / 110574, out = [];
  for (let i = 0; i <= n; i++) out.push([lon + dx * Math.cos((i / n) * 2 * Math.PI), lat + dy * Math.sin((i / n) * 2 * Math.PI)]);
  return out;
}

// Veto kartalle: yksittäinen piste ympyränä, viiva pyöreäpäisenä nauhana (leveys 2 × säde).
function strokeFeature(e) {
  const props = { id: e.id ?? "", tyyppi: e.tyyppi, sade: e.sade };
  const geometry = e.pisteet.length === 1
    ? { type: "Polygon", coordinates: [ring(e.pisteet[0], e.sade)] }
    : { type: "LineString", coordinates: e.pisteet };
  return { type: "Feature", properties: props, geometry };
}

function drawAreas() {
  map.getSource("ed-alueet").setData({ type: "FeatureCollection", features: history.map(strokeFeature) });
}

function drawPreview() {
  const list = [...pendingStrokes];
  if (stroke) list.push({ tyyppi: stroke.tool, sade: state.sade, pisteet: stroke.pts });
  map.getSource("ed-veto").setData({ type: "FeatureCollection", features: list.filter((e) => e.pisteet.length).map(strokeFeature) });
}

function drawCursor() {
  const show = brushing() && cursorAt;
  const features = !show ? [] : [
    { type: "Feature", properties: { osa: "ulko" }, geometry: { type: "LineString", coordinates: ring(cursorAt, state.sade) } },
    ...(state.kovuus > 0.02 && state.kovuus < 0.98
      ? [{ type: "Feature", properties: { osa: "sisa" }, geometry: { type: "LineString", coordinates: ring(cursorAt, state.sade * state.kovuus) } }]
      : []),
  ];
  map.getSource("ed-sivellin").setData({ type: "FeatureCollection", features });
}

// Korjattujen tiilten korkeusmalli haetaan uudelleen (myös välimuistissa odottavat), kun hakemisto muuttuu.
// MapLibre (4.7) purkaa korkeusmallin tiilen uudelleen vain tilassa "expired" (kuten app.js:n reloadErroredTiles).
const fixedKeys = (idx) => new Set(Object.entries(idx.tiilet ?? {}).flatMap(([z, xy]) => xy.filter((_, i) => i % 2 === 0).map((x, i) => `${z}/${x}/${xy[2 * i + 1]}`)));
function reloadDem(keys) {
  if (!keys.size) return;
  for (const id of ["dem", "pelimaasto-dem"]) {
    const cache = map.style?.sourceCaches?.[id];
    if (!cache) continue;
    const hit = (tile) => {
      const c = tile.tileID.canonical;
      return keys.has(`${c.z}/${c.x}/${c.y}`);
    };
    cache._cache?.filter?.((tile) => !hit(tile));
    for (const [key, tile] of Object.entries(cache._tiles)) if (hit(tile)) cache._reloadTile(key, "expired");
  }
  map.triggerRepaint();
}

// Rinnevarjostus korostettuna pienetkin kuopat ja kohoumat erottuvat. Varjostus syntyy pelillisen
// maaston mukana (pelimaasto.js), joten sitä odotetaan.
function applyHighlight() {
  if (!map.getLayer("pelimaasto-varjostus")) return setTimeout(applyHighlight, 500);
  map.setPaintProperty("pelimaasto-varjostus", "hillshade-exaggeration", state.korosta ? 1 : 0.45);
}

// --- Rajapinta --------------------------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ virhe: `Editorin palvelin vastasi ${res.status}` }));
  if (!res.ok || data.virhe) throw new Error(data.virhe || `Virhe ${res.status}`);
  return data;
}

let queue = Promise.resolve(), busy = 0, lastError = null;
function enqueue(label, fn) {
  busy++;
  setStatus(label, "busy");
  queue = queue.then(fn).then(() => {
    lastError = null;
  }, (err) => {
    lastError = err;
    console.warn("Maastoeditori:", err);
  }).finally(() => {
    busy--;
    if (lastError) setStatus(lastError.message, "error");
    else if (!busy) setStatus(idleText());
  });
  return queue;
}

function applyState(res, reload = true) {
  const before = fixedKeys(index);
  history = res.historia ?? [];
  canRedo = res.voi_tehda ?? 0;
  index = res.hakemisto;
  gitInfo = res.git ?? {};
  setTerrainFixes(index);
  if (reload) reloadDem(new Set([...before, ...fixedKeys(index)]));
  const bridgesChanged = JSON.stringify(res.sillat ?? []) !== JSON.stringify(bridgeEdits);
  bridgeEdits = res.sillat ?? [];
  if (reload && bridgesChanged) {
    game()?.setBridgeEdits(bridgeEdits);
    refreshSelection();
  }
  drawAreas();
  renderList();
  renderBridges();
  renderPublish();
}

// --- Siveltimen käyttö ------------------------------------------------------------------------------

const painting = () => state.tool !== "liiku" && !space; // hiiren vasen painike editorille
const brushing = () => painting() && state.tool !== "silta";
const container = map.getContainer(), canvasBox = map.getCanvasContainer();
const overCanvas = (e) => e.target instanceof Element && canvasBox.contains(e.target);
const toLngLat = (e) => {
  const r = canvasBox.getBoundingClientRect();
  const ll = map.unproject([e.clientX - r.left, e.clientY - r.top]);
  return [round7(ll.lng), round7(ll.lat)];
};

function addPoint(p, force = false) {
  const last = stroke.pts.at(-1);
  const gap = last ? distM(last, p) : Infinity;
  if (gap >= Math.max(0.3, state.sade / 4) || (force && gap > 0.05)) stroke.pts.push(p);
}

// Hiiren vasen painike maalaa, kun työkalu on valittu: kartta ei saa painallusta (ei siirtoa eikä
// kohteen klikkausta). Oikea painike (kääntö ja kallistus) ja rulla toimivat kuten ennenkin.
container.addEventListener("mousedown", (e) => {
  if (!painting() || e.button !== 0 || !overCanvas(e)) return;
  e.stopPropagation();
  e.preventDefault();
  suppressClick = true;
  if (state.tool === "silta") return selectBridge(pickBridge(...canvasPoint(e)));
  const p = toLngLat(e);
  if (state.tool === "tasoita" && e.altKey) return pickLevel(p);
  stroke = { tool: state.tool, pts: [p] };
  drawPreview();
}, true);
for (const type of ["click", "dblclick"]) {
  container.addEventListener(type, (e) => {
    if ((painting() || suppressClick) && overCanvas(e)) {
      e.stopPropagation();
      e.preventDefault();
    }
    suppressClick = false;
  }, true);
}

let readoutQueued = false;
window.addEventListener("mousemove", (e) => {
  if (!stroke && !overCanvas(e)) {
    if (cursorAt) {
      cursorAt = null;
      drawCursor();
    }
    return;
  }
  cursorAt = toLngLat(e);
  if (state.tool === "silta" && !space) {
    const [x, y] = canvasPoint(e);
    const hit = pickBridge(x, y);
    if (hit?.id !== hoverBridge?.id) {
      hoverBridge = hit;
      map.triggerRepaint();
    }
  }
  if (stroke) {
    addPoint(cursorAt);
    drawPreview();
  }
  drawCursor();
  if (!readoutQueued) {
    readoutQueued = true;
    requestAnimationFrame(() => {
      readoutQueued = false;
      showReadout();
    });
  }
});

window.addEventListener("mouseup", (e) => {
  if (!stroke || e.button !== 0) return;
  addPoint(toLngLat(e), true);
  finishStroke();
});

function finishStroke() {
  const s = stroke;
  stroke = null;
  const edit = { id: `k${Date.now()}${Math.random().toString(36).slice(2, 6)}`, tyyppi: s.tool, sade: state.sade, kovuus: state.kovuus, pisteet: s.pts };
  if (s.tool === "nosta" || s.tool === "laske") edit.maara = state.maara;
  if (s.tool === "tasoita" && state.kiinteaTaso && Number.isFinite(state.taso)) edit.taso = state.taso;
  if (s.tool === "pehmenna" || s.tool === "palauta") edit.voimakkuus = state.voimakkuus;
  pendingStrokes.push(edit);
  drawPreview();
  enqueue("Lasketaan korjausta…", async () => {
    try {
      const res = await api("/api/lisaa", edit);
      applyState(res);
      if (res.lisatty?.tyyppi === "tasoita" && !state.kiinteaTaso) {
        state.taso = res.lisatty.taso;
        renderTools();
      }
    } finally {
      pendingStrokes.splice(pendingStrokes.indexOf(edit), 1);
      drawPreview();
    }
  });
}

function pickLevel([lon, lat]) {
  enqueue("Luetaan maanpinnan korkeutta…", async () => {
    const { korkeus } = await api(`/api/korkeus?lon=${lon}&lat=${lat}`);
    Object.assign(state, { taso: korkeus, kiinteaTaso: true });
    saveSettings();
    renderTools();
  });
}

// Kumoa ja tee uudelleen palvelimen istuntohistoriasta (erotukset ennen ja jälkeen vedon). Jonossa,
// jotta keskeneräinen veto ehtii tallentua ensin.
function undo() {
  if (!history.length && !pendingStrokes.length) return;
  enqueue("Kumotaan…", async () => {
    if (history.length) applyState(await api("/api/kumoa", {}));
  });
}

function redoLast() {
  if (!canRedo) return;
  enqueue("Tehdään uudelleen…", async () => applyState(await api("/api/tee-uudelleen", {})));
}

function setTool(id) {
  state.tool = id;
  if (stroke) {
    stroke = null;
    drawPreview();
  }
  if (id !== "silta") {
    hoverBridge = null;
    selectBridge(null);
  }
  updateMode();
  renderTools();
}

function updateMode() {
  document.body.classList.toggle("ed-paint", painting());
  drawCursor();
}

// Pikanäppäimet eivät koske tekstikenttiä (valintaruudun tai liukusäätimen jälkeen ne toimivat).
const typing = (e) => e.target instanceof Element
  && e.target.closest("input[type=text], input[type=number], input[type=search], input:not([type]), select, textarea, [contenteditable]");
window.addEventListener("keydown", (e) => {
  if (typing(e)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === "Space") {
    e.preventDefault();
    if (!space) {
      space = true;
      updateMode();
    }
  } else if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redoLast() : undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redoLast();
  } else if (!mod && TOOLS.some((t) => t.key === e.key)) {
    setTool(TOOLS.find((t) => t.key === e.key).id);
  } else if (e.key === "Escape") {
    if (selId) selectBridge(null);
    else setTool("liiku");
  } else if ((e.key === "Delete" || e.key === "Backspace") && state.tool === "silta" && selBridge?.piece) {
    e.preventDefault();
    sendBridge({ poista: true });
  } else if (!mod && (e.key === "[" || e.key === "]")) {
    state.sade = clampRadius(state.sade * (e.key === "]" ? 1.25 : 0.8));
    saveSettings();
    renderTools();
    drawCursor();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && space) {
    space = false;
    updateMode();
  }
});
window.addEventListener("blur", () => {
  space = false;
  updateMode();
});
window.addEventListener("beforeunload", (e) => {
  if (busy) e.preventDefault();
});

// --- Sillat -----------------------------------------------------------------------------------------
// 3D-sillat ovat three.js-tasolla, joten valinta tehdään projisoimalla siltaosien kannet näytölle samalla
// matriisilla kuin piirrossa (transit.js: merkaattorikoordinaatit, korkeus kartan keskipisteen suhteen).

function canvasPoint(e) {
  const r = canvasBox.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function projector() {
  const tr = map.transform, M = tr.customLayerMatrix ? tr.customLayerMatrix() : tr.mercatorMatrix;
  const exag = map.terrain?.exaggeration ?? 1, ce = tr.elevation ?? 0, W = tr.width, H = tr.height;
  return (lon, lat, z) => {
    const x = mercX(lon), y = mercY(lat), zz = (z * exag + 0.15 - ce) / (EARTH_CIRC * Math.cos(lat * D2R));
    const cx = M[0] * x + M[4] * y + M[8] * zz + M[12], cy = M[1] * x + M[5] * y + M[9] * zz + M[13];
    const cw = M[3] * x + M[7] * y + M[11] * zz + M[15];
    return cw > 1e-9 ? [((cx / cw + 1) / 2) * W, ((1 - cy / cw) / 2) * H, cw] : null;
  };
}

// Kannen reunat ja keskilinja ([lon, lat, z]) kuten pelimaasto.js:n bridgeMesh piirtää ne.
function deckEdges({ p, w }) {
  const mx0 = mercX(p[0]), my0 = mercY(p[1]), unit = EARTH_CIRC * Math.cos(p[1] * D2R), P = [];
  for (let i = 0; i < p.length; i += 3) P.push([(mercX(p[i]) - mx0) * unit, (mercY(p[i + 1]) - my0) * unit, p[i + 2]]);
  const back = (x, y, z) => [(mx0 + x / unit) * 360 - 180, latOfY(my0 + y / unit), z];
  const left = [], right = [], center = [];
  P.forEach((q, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], ln = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / ln, ny = (b[0] - a[0]) / ln;
    left.push(back(q[0] + nx * w, q[1] + ny * w, q[2]));
    right.push(back(q[0] - nx * w, q[1] - ny * w, q[2]));
    center.push(back(q[0], q[1], q[2]));
  });
  return { left, right, center };
}

function insidePoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Lähin (kamerasta) siltaosa, jonka kansi on näytön pisteen kohdalla; poistetut osat eivät näy.
function pickBridge(x, y) {
  const list = game()?.bridgePieces?.() ?? [];
  const proj = projector();
  let best = null, bestW = Infinity;
  for (const b of list) {
    if (!b.piece) continue;
    const { left, right } = deckEdges(b.piece);
    const L = left.map((q) => proj(...q)), R = right.map((q) => proj(...q));
    for (let i = 0; i < L.length - 1; i++) {
      const quad = [L[i], L[i + 1], R[i + 1], R[i]];
      if (quad.some((q) => !q)) continue;
      if (!insidePoly(x, y, quad)) continue;
      const wDepth = (quad[0][2] + quad[1][2] + quad[2][2] + quad[3][2]) / 4;
      if (wDepth < bestW) {
        bestW = wDepth;
        best = b;
      }
    }
  }
  return best;
}

function selectBridge(b) {
  selBridge = b;
  selId = b?.id ?? null;
  renderBridgePanel();
  map.triggerRepaint();
}

// Valinta uudelleen luettelosta korjauksen jälkeen (korjattu muoto) tai kun sillan ruutu latautuu.
function refreshSelection() {
  if (!selId) return;
  selBridge = game()?.bridgePieces?.().find((b) => b.id === selId) ?? selBridge;
  renderBridgePanel();
  map.triggerRepaint();
}

// Korostus näytön päällä (SVG): osoitettu siltaosa katkoviivalla, valittu täytettynä ja päät merkittyinä
// (A = alku, L = loppu). Poistetun osan paikka näkyy punaisena.
const SVG_NS = "http://www.w3.org/2000/svg";
const overlay = document.createElementNS(SVG_NS, "svg");
overlay.setAttribute("class", "ed-bridge-overlay");
container.append(overlay);
function svg(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text) el.textContent = text;
  return el;
}

function drawOverlay() {
  const items = [];
  if (state.tool === "silta" || selId) {
    if (selId && !selBridge && performance.now() - lookupAt > 500) {
      lookupAt = performance.now();
      refreshSelection();
    }
    const proj = projector();
    const outline = (piece) => {
      const { left, right } = deckEdges(piece);
      const pts = [...left, ...right.reverse()].map((q) => proj(...q));
      return pts.some((q) => !q) ? null : pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
    };
    if (hoverBridge?.piece && hoverBridge.id !== selId && state.tool === "silta") {
      const pts = outline(hoverBridge.piece);
      if (pts) items.push(svg("polygon", { points: pts, class: "hover" }));
    }
    if (selBridge) {
      const removed = !selBridge.piece, piece = selBridge.piece ?? selBridge.raw, pts = outline(piece);
      if (pts) items.push(svg("polygon", { points: pts, class: removed ? "sel removed" : "sel" }));
      const { center } = deckEdges(piece);
      for (const [q, label] of [[center[0], "A"], [center.at(-1), "L"]]) {
        const s = proj(...q);
        if (!s) continue;
        items.push(svg("circle", { cx: s[0].toFixed(1), cy: s[1].toFixed(1), r: 10, class: "end" }),
          svg("text", { x: s[0].toFixed(1), y: (s[1] + 4).toFixed(1), class: "end" }, label));
      }
    }
  }
  overlay.replaceChildren(...items);
}
map.on("render", drawOverlay);

const lengthOf = (p) => {
  let len = 0;
  for (let i = 3; i < p.length; i += 3) len += distM([p[i - 3], p[i - 2]], [p[i], p[i + 1]]);
  return len;
};

// Siltaosan korjaus palvelimelle: muutos nykyiseen korjaukseen (poista, alku, loppu, tu).
function sendBridge(change) {
  const b = selBridge;
  if (!b) return;
  const cur = b.edit ?? {};
  const next = { alku: cur.alku ?? 0, loppu: cur.loppu ?? 0, tu: cur.tu ?? null, poista: !!cur.poista, ...change };
  const raw = b.raw, n = raw.p.length, rawTu = raw.tu ?? [0, 0];
  if (next.tu && next.tu[0] === rawTu[0] && next.tu[1] === rawTu[1]) next.tu = null;
  const body = {
    id: b.id, ...next, tu: next.tu ?? undefined, laji: raw.k, pituus: lengthOf(raw.p),
    keskipiste: [(raw.p[0] + raw.p[n - 3]) / 2, (raw.p[1] + raw.p[n - 2]) / 2],
  };
  enqueue("Tallennetaan siltaa…", async () => applyState(await api("/api/silta", body)));
}

function restoreBridge(id) {
  enqueue("Palautetaan siltaa…", async () => applyState(await api("/api/silta/palauta", { id })));
}

function describeBridge(e) {
  if (e.poista) return "poistettu";
  const parts = [];
  if (e.alku) parts.push(`alku ${e.alku > 0 ? "+" : "−"}${fmt(Math.abs(e.alku))} m`);
  if (e.loppu) parts.push(`loppu ${e.loppu > 0 ? "+" : "−"}${fmt(Math.abs(e.loppu))} m`);
  if (e.tu) parts.push(`päätuet ${e.tu[0] ? "A" : "–"}/${e.tu[1] ? "L" : "–"}`);
  return parts.join(", ") || "muutettu";
}

// --- Paneeli ----------------------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// Säde liukusäätimellä logaritmisesti (1–100 m), jotta pienetkin säteet ovat helppoja valita.
const clampRadius = (r) => Math.min(100, Math.max(1, Math.round(r * 2) / 2));
const rangeOf = (r) => Math.log10(r);

const els = {};
const panel = h("aside", { id: "editori", "aria-label": "Maastoeditori" },
  h("header", {}, h("h1", {}, "Maastoeditori"), h("p", {}, "Korjaa korkeusmallin kuoppia ja kohoumia. Jokainen veto tallentuu heti.")),
  h("div", { class: "scroll" },
    h("section", {},
      h("h2", {}, "Työkalu"),
      els.tools = h("div", { class: "ed-tools", role: "toolbar" }, TOOLS.map((t) => h("button", {
        type: "button", "data-tool": t.id, style: `--tool:${t.color}`, title: `${t.name} (${t.key})`, onclick: () => setTool(t.id),
      }, h("span", { class: "sw" }), t.name, h("kbd", {}, t.key)))),
      els.hint = h("p", { class: "hint ed-hint" })),
    els.settings = h("section", {},
      h("h2", {}, "Sivellin"),
      field("sade", "Säde", h("input", { type: "range", min: 0, max: 2, step: 0.01, oninput: (e) => setSetting("sade", clampRadius(10 ** +e.target.value)) })),
      field("kovuus", "Kovuus", h("input", { type: "range", min: 0, max: 1, step: 0.05, oninput: (e) => setSetting("kovuus", +e.target.value) })),
      field("maara", "Määrä", h("input", { type: "range", min: 0.1, max: 5, step: 0.1, oninput: (e) => setSetting("maara", +e.target.value) })),
      field("voimakkuus", "Voimakkuus", h("input", { type: "range", min: 0.1, max: 1, step: 0.05, oninput: (e) => setSetting("voimakkuus", +e.target.value) })),
      els.level = h("div", { class: "ed-field", "data-for": "tasoita" },
        h("div", { class: "row between" }, h("span", {}, "Taso")),
        h("div", { class: "ed-level" },
          h("label", { class: "check" }, els.fixed = h("input", { type: "checkbox", onchange: (e) => setSetting("kiinteaTaso", e.target.checked) }), "Kiinteä"),
          els.levelInput = h("input", { type: "number", step: 0.1, "aria-label": "Taso metreinä", onchange: (e) => setSetting("taso", e.target.value === "" ? null : +e.target.value) }),
          h("span", {}, "m")))),
    els.bridge = h("section", {},
      h("h2", {}, "Siltaosa"),
      els.bridgeBody = h("div", { class: "ed-bridge" })),
    h("section", {},
      h("div", { class: "ed-readout" }, els.height = h("span", {}, "Maanpinta –"), els.zoom = h("span", {})),
      h("p", { class: "ed-keys", html: "<kbd>1</kbd>–<kbd>7</kbd> työkalu · <kbd>[</kbd> <kbd>]</kbd> säde · <kbd>välilyönti</kbd> pohjassa siirtää karttaa · oikea painike kääntää ja kallistaa · <kbd>Ctrl</kbd>+<kbd>Z</kbd> kumoaa" })),
    h("section", {},
      h("h2", {}, "Näkymä"),
      h("label", { class: "check" }, els.highlight = h("input", { type: "checkbox", onchange: (e) => setSetting("korosta", e.target.checked) }), "Korosta pinnanmuodot (varjostus)"),
      h("label", { class: "check" }, els.areas = h("input", { type: "checkbox", onchange: (e) => setSetting("alueet", e.target.checked) }), "Näytä tämän istunnon vedot"),
      h("p", { class: "hint" }, "Vedon alue näkyy myös, kun viet hiiren sen kohdalle listassa.")),
    h("section", {},
      h("div", { class: "ed-head" },
        els.count = h("h2", {}, "Korjaukset"),
        h("span", {},
          els.undo = h("button", { type: "button", class: "ed-btn", title: "Kumoa (Ctrl+Z)", onclick: undo }, "Kumoa"), " ",
          els.redo = h("button", { type: "button", class: "ed-btn", title: "Tee uudelleen (Ctrl+Shift+Z)", onclick: redoLast }, "Tee uudelleen"))),
      els.list = h("ul", { class: "ed-list" })),
    els.bridgeListSec = h("section", { hidden: true },
      els.bridgeCount = h("h2", {}, "Siltakorjaukset"),
      els.bridgeList = h("ul", { class: "ed-list" })),
    els.publish = h("section", { class: "ed-publish" },
      h("h2", {}, "Julkaisu"),
      els.gitText = h("p", {}),
      els.publishBtn = h("button", { type: "button", class: "ed-btn primary", onclick: publish }, "Vie GitHubiin"),
      els.publishMsg = h("p", { class: "msg", hidden: true }))),
  els.status = h("div", { class: "ed-status", role: "status" }, h("span", { class: "dot" }), els.statusText = h("span", {}, "Ladataan korjauksia…")));
document.body.append(panel);

function field(key, label, input) {
  els[key] = input;
  input.setAttribute("aria-label", label);
  return h("div", { class: "ed-field", "data-key": key },
    h("div", { class: "row between" }, h("label", {}, label), els[`${key}Out`] = h("output", {})), input);
}

const FIELD_TOOLS = { sade: null, kovuus: null, maara: ["nosta", "laske"], voimakkuus: ["pehmenna", "palauta"] };
function renderTools() {
  for (const b of els.tools.children) b.setAttribute("aria-pressed", String(b.dataset.tool === state.tool));
  els.hint.innerHTML = TOOL[state.tool].hint;
  els.settings.hidden = state.tool === "liiku" || state.tool === "silta";
  els.bridge.hidden = state.tool !== "silta";
  for (const [key, tools] of Object.entries(FIELD_TOOLS)) {
    els[key].closest(".ed-field").hidden = tools !== null && !tools.includes(state.tool);
  }
  els.level.hidden = state.tool !== "tasoita";
  els.sade.value = rangeOf(state.sade);
  els.sadeOut.textContent = `${fmtR(state.sade)} m`;
  els.kovuus.value = state.kovuus;
  els.kovuusOut.textContent = `${Math.round(state.kovuus * 100)} %`;
  els.maara.value = state.maara;
  els.maaraOut.textContent = `${fmt(state.maara)} m`;
  els.voimakkuus.value = state.voimakkuus;
  els.voimakkuusOut.textContent = `${Math.round(state.voimakkuus * 100)} %`;
  els.fixed.checked = state.kiinteaTaso;
  els.levelInput.disabled = !state.kiinteaTaso;
  if (document.activeElement !== els.levelInput) els.levelInput.value = Number.isFinite(state.taso) ? state.taso.toFixed(2) : "";
  els.highlight.checked = state.korosta;
  els.areas.checked = state.alueet;
  renderBridgePanel();
}

function setSetting(key, value) {
  state[key] = value;
  saveSettings();
  if (key === "korosta") applyHighlight();
  if (key === "alueet") {
    for (const id of ["ed-alueet-reuna", "ed-alueet-kaari"]) map.setLayoutProperty(id, "visibility", value ? "visible" : "none");
  }
  renderTools();
  drawCursor();
}

function describe(e) {
  if (e.tyyppi === "nosta") return `+${fmt(e.maara, 2)} m`;
  if (e.tyyppi === "laske") return `−${fmt(e.maara, 2)} m`;
  if (e.tyyppi === "tasoita") return `tasolle ${fmt(e.taso, 2)} m`;
  return `${Math.round((e.voimakkuus ?? 1) * 100)} %`;
}

function strokeLength(e) {
  let len = 0;
  for (let i = 1; i < e.pisteet.length; i++) len += distM(e.pisteet[i - 1], e.pisteet[i]);
  return len;
}

function highlight(id) {
  map.setFilter("ed-korostus", ["all", isLine, ["==", ["get", "id"], id ?? ""]]);
  map.setFilter("ed-korostus-ala", ["all", isArea, ["==", ["get", "id"], id ?? ""]]);
}

function show(e) {
  const lons = e.pisteet.map((p) => p[0]), lats = e.pisteet.map((p) => p[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = e.sade / (111320 * Math.cos(lat * D2R)), dLat = e.sade / 110574;
  map.fitBounds([[Math.min(...lons) - dLon, Math.min(...lats) - dLat], [Math.max(...lons) + dLon, Math.max(...lats) + dLat]],
    { padding: { top: 80, bottom: 80, left: 360, right: 340 }, maxZoom: 18.5, pitch: map.getPitch(), bearing: map.getBearing(), duration: 800 });
}

const ICON_SHOW = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Tämän istunnon vedot (uusin ensin). Lopputulos on tallessa erotuksina, joten aiempien istuntojen
// vetoja ei ole; vanhan korjauksen saa pois Palauta-työkalulla.
function renderList() {
  els.count.textContent = `Tämän istunnon vedot (${history.length})`;
  els.undo.disabled = !history.length;
  els.redo.disabled = !canRedo;
  els.list.replaceChildren(...(!history.length ? [h("li", {}, h("p", { class: "ed-empty" }, "Ei vielä vetoja tässä istunnossa. Valitse työkalu ja maalaa maastoon. Aiemmat korjaukset ovat tallessa; ne saa pois Palauta-työkalulla."))]
    : [...history].reverse().map((e) => {
      const t = TOOL[e.tyyppi], len = strokeLength(e);
      const time = e.aika ? new Date(e.aika).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : "";
      return h("li", { onmouseenter: () => highlight(e.id), onmouseleave: () => highlight(null) },
        h("span", { class: "dot", style: `--tool:${t?.color ?? "#888"}` }),
        h("div", { class: "what" }, h("b", {}, t?.name ?? e.tyyppi), ` ${describe(e)}`,
          h("span", {}, [`säde ${fmtR(e.sade)} m`, len > 0.5 ? `veto ${Math.round(len)} m` : null, time ? `klo ${time}` : null].filter(Boolean).join(" · "))),
        h("button", { type: "button", title: "Näytä kartalla", "aria-label": "Näytä kartalla", html: ICON_SHOW, onclick: () => show(e) }));
    })));
}

const round1 = (v) => Math.round(v * 10) / 10;
function renderBridgePanel() {
  if (!els.bridgeBody) return;
  const b = selBridge;
  if (!b) {
    els.bridgeBody.replaceChildren(h("p", { class: "ed-empty" },
      selId ? "Valittu siltaosa latautuu…" : "Klikkaa siltaa kartalla. Osoitettu osa näkyy katkoviivalla."));
    return;
  }
  const e = b.edit ?? {}, raw = b.raw, tu = e.tu ?? raw.tu ?? [0, 0], off = !!e.poista;
  const stepper = (key, label) => h("div", { class: "ed-step" }, h("span", {}, label),
    ...[-5, -1].map((d) => h("button", { type: "button", class: "ed-btn", disabled: off, onclick: () => sendBridge({ [key]: round1((e[key] ?? 0) + d) }) }, `−${-d}`)),
    h("output", {}, `${(e[key] ?? 0) > 0 ? "+" : (e[key] ?? 0) < 0 ? "−" : ""}${fmt(Math.abs(e[key] ?? 0))} m`),
    ...[1, 5].map((d) => h("button", { type: "button", class: "ed-btn", disabled: off, onclick: () => sendBridge({ [key]: round1((e[key] ?? 0) + d) }) }, `+${d}`)));
  const support = (i, label) => h("label", { class: "check" }, h("input", {
    type: "checkbox", checked: !!tu[i], disabled: off,
    onchange: (ev) => sendBridge({ tu: i === 0 ? [ev.target.checked ? 1 : 0, tu[1]] : [tu[0], ev.target.checked ? 1 : 0] }),
  }), label);
  els.bridgeBody.replaceChildren(
    h("p", { class: "ed-bridge-title" }, h("b", {}, BRIDGE_KINDS[raw.k] ?? raw.k),
      ` · ${Math.round(lengthOf((b.piece ?? raw).p))} m · leveys ${fmtR(2 * raw.w)} m`),
    h("p", { class: "hint" }, b.edit ? `Korjattu: ${describeBridge(b.edit)}.` : "Alkuperäinen. Päät on merkitty kartalle: A = alku, L = loppu."),
    stepper("alku", "Alku (A)"),
    stepper("loppu", "Loppu (L)"),
    h("p", { class: "hint" }, "Plus jatkaa päätä samalla korkeudella, miinus lyhentää."),
    support(0, "Päätuki alussa"),
    support(1, "Päätuki lopussa"),
    h("div", { class: "row" },
      off ? null : h("button", { type: "button", class: "ed-btn danger", onclick: () => sendBridge({ poista: true }) }, "Poista siltaosa"),
      b.edit ? h("button", { type: "button", class: "ed-btn", onclick: () => restoreBridge(b.id) }, "Palauta alkuperäinen") : null));
}

function renderBridges() {
  els.bridgeListSec.hidden = !bridgeEdits.length;
  els.bridgeCount.textContent = `Siltakorjaukset (${bridgeEdits.length})`;
  els.bridgeList.replaceChildren(...[...bridgeEdits].reverse().map((e) => {
    const time = e.aika ? new Date(e.aika).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : "";
    return h("li", {},
      h("span", { class: "dot", style: `--tool:${e.poista ? "#e05555" : "#5b8fd6"}` }),
      h("div", { class: "what" }, h("b", {}, BRIDGE_KINDS[e.laji] ?? "Silta"), ` ${describeBridge(e)}`,
        h("span", {}, [e.pituus ? `${Math.round(e.pituus)} m` : null, time ? `klo ${time}` : null].filter(Boolean).join(" · "))),
      h("button", { type: "button", title: "Näytä kartalla", "aria-label": "Näytä kartalla", html: ICON_SHOW, onclick: () => showBridge(e) }),
      h("button", { type: "button", title: "Palauta alkuperäinen", "aria-label": "Palauta alkuperäinen", html: ICON_DEL, onclick: () => restoreBridge(e.id) }));
  }));
}

function showBridge(e) {
  setTool("silta");
  selId = e.id;
  selBridge = null;
  lookupAt = 0;
  renderBridgePanel();
  if (e.keskipiste?.[0]) map.easeTo({ center: e.keskipiste, zoom: Math.max(map.getZoom(), 17.5), duration: 800 });
}

const fineTiles = () => (index.tiilet?.["15"]?.length ?? 0) / 2;
const idleText = () => `Tallennettu · ${fineTiles()} korjattu${fineTiles() === 1 ? " tiili" : "a tiiltä"} · istunnossa ${history.length} veto${history.length === 1 ? "" : "a"}`;

function setStatus(text, kind = "") {
  els.status.className = `ed-status ${kind}`;
  els.statusText.textContent = text;
}

function renderPublish() {
  const g = gitInfo;
  if (g.virhe) {
    els.gitText.textContent = `Git ei ole käytettävissä: ${g.virhe}`;
    els.publishBtn.disabled = true;
    return;
  }
  const parts = [`Haara ${g.haara || "?"}.`];
  if (g.muuttuneet) parts.push(`${g.muuttuneet} korjaustiedosto${g.muuttuneet === 1 ? "" : "a"} julkaisematta.`);
  else if (g.viemattomat) parts.push(`${g.viemattomat} commit${g.viemattomat === 1 ? "" : "ia"} viemättä GitHubiin.`);
  else if (g.viemattomat === null) parts.push("Haaraa ei ole vielä viety GitHubiin.");
  else parts.push("Korjaukset ovat GitHubissa.");
  if (g.haara && g.haara !== "main") parts.push("Netlify julkaisee korjaukset, kun haara yhdistetään main-haaraan.");
  els.gitText.textContent = parts.join(" ");
  els.publishBtn.disabled = !(g.muuttuneet || g.viemattomat || (g.viemattomat === null && fineTiles()));
}

function publish() {
  const g = gitInfo;
  const where = g.haara === "main" ? "Netlify julkaisee ne heti." : `Ne menevät haaraan ${g.haara}; Netlify julkaisee ne, kun haara yhdistetään main-haaraan.`;
  if (!confirm(`Viedäänkö maastokorjaukset GitHubiin (commit ja push)?\n${where}`)) return;
  els.publishMsg.hidden = true;
  enqueue("Viedään GitHubiin…", async () => {
    try {
      const res = await api("/api/julkaise", {});
      applyState(res, false);
      showPublishMsg(res.julkaisu);
    } catch (err) {
      showPublishMsg(err.message, true);
      throw err;
    }
  });
}

function showPublishMsg(text, error = false) {
  els.publishMsg.hidden = false;
  els.publishMsg.textContent = text;
  els.publishMsg.classList.toggle("error", error);
}

function showReadout() {
  els.zoom.textContent = `zoom ${fmt(map.getZoom())}`;
  const q = cursorAt && map.queryTerrainElevation(cursorAt);
  if (q == null) {
    els.height.textContent = "Maanpinta –";
    return;
  }
  // queryTerrainElevation on korostettu ja suhteessa kartan keskipisteeseen.
  const exag = map.terrain?.exaggeration || 1;
  els.height.textContent = `Maanpinta ≈ ${fmt((q + (map.transform.elevation ?? 0)) / exag)} m`;
}
map.on("zoom", () => (els.zoom.textContent = `zoom ${fmt(map.getZoom())}`));

// --- Käynnistys -------------------------------------------------------------------------------------

renderTools();
applyHighlight();
setSetting("alueet", state.alueet);
try {
  applyState(await api("/api/tila"), false);
  setStatus(idleText());
} catch (err) {
  setStatus(`Editorin palvelin ei vastaa: ${err.message}`, "error");
}
