import {
  BUILDING_CLASSES, BUILDING_HEIGHT_STOPS, BUILDING_YEAR_STOPS, ESPOO_BOUNDS, FIELD_LABELS, GROUPS,
  HIDDEN_FIELDS, LANDUSE_CLASSES, ORTHO_YEARS, PLACES, POPUP_TITLES, TERRAIN_EXAGGERATION, WMS_SERVICES,
} from "./layers.js";
import { patchDemTile } from "./bridges.js";

const ATTR_ESPOO = '© <a href="https://kartat.espoo.fi" target="_blank" rel="noopener">Espoon kaupunki</a>';
const ATTR_HSY = '© <a href="https://www.hsy.fi/avoindata" target="_blank" rel="noopener">HSY</a>';
const ATTR_GTK = '© <a href="https://www.gtk.fi" target="_blank" rel="noopener">GTK</a>';
const ATTR = { espoo: ATTR_ESPOO, hsy: ATTR_HSY, gtk: ATTR_GTK };
const ATTR_DEM = '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Mapterhorn</a> / © Maanmittauslaitos (CC BY 4.0)';

// Polut suhteessa sivuun, jotta kartta toimii myös alikansiossa (esim. GitHub Pages).
const BASE = new URL(".", location.href).href;

// Aineistoversio tiiliosoitteisiin (build_data.py päivittää), jotta selain ei käytä vanhoja tiiliä.
const manifest = await fetch("data/manifest.json").then((r) => r.json()).catch(() => ({}));
const TILE_VERSION = manifest.versio ?? 0;

// Vektoritiilet ovat gzip-pakattuja (tippecanoe). Staattiset palvelimet eivät kerro sitä
// selaimelle Content-Encoding-otsakkeella, joten paketti puretaan tarvittaessa itse.
maplibregl.addProtocol("gz", async (params, abortController) => {
  const res = await fetch(params.url.slice("gz://".length), { signal: abortController.signal });
  if (!res.ok) return { data: new ArrayBuffer(0) }; // puuttuva tiili = tyhjä alue
  let data = await res.arrayBuffer();
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  return { data };
});

// Korkeusmallin tiilet: sillat nostetaan kannen tasolle (bridges.js), koska ne puuttuvat
// korkeusmallista ja ilmakuvan tie muuten notkahtaisi sillan kohdalla.
maplibregl.addProtocol("dem", async (params, abortController) => {
  const url = "https://" + params.url.slice("dem://".length);
  const res = await fetch(url, { signal: abortController.signal });
  if (!res.ok) throw new Error(`Korkeusmallin tiili ${res.status}`);
  const [z, x, y] = url.match(/(\d+)\/(\d+)\/(\d+)\.webp$/).slice(1).map(Number);
  return { data: await patchDemTile(await res.arrayBuffer(), z, x, y) };
});

const state = {
  orthoIndex: 0,
  overlayOpacity: 0.75,
  buildingColor: "luokka",
};

// ------------------------------------------------------------ apufunktiot

function wmsTiles(layers, { service = "espoo", transparent = true } = {}) {
  const base = new URL(WMS_SERVICES[service], BASE).href;
  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: layers, STYLES: "",
    SRS: "EPSG:3857", WIDTH: "512", HEIGHT: "512", FORMAT: "image/png", TRANSPARENT: transparent ? "TRUE" : "FALSE",
  });
  // {bbox-epsg-3857} ei saa mennä URL-koodaukseen, joten se lisätään perään sellaisenaan.
  return [`${base}?${params}&BBOX={bbox-epsg-3857}`];
}

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};

// ------------------------------------------------------------ tyyli

function buildingColorExpr(mode) {
  if (mode === "vuosi") {
    return ["case", ["has", "vuosi"],
      ["interpolate", ["linear"], ["get", "vuosi"], ...BUILDING_YEAR_STOPS.flat()], "#9e9e9e"];
  }
  if (mode === "korkeus") {
    return ["interpolate", ["linear"], ["get", "korkeus"], ...BUILDING_HEIGHT_STOPS.flat()];
  }
  return ["match", ["get", "luokka"], ...BUILDING_CLASSES.flatMap(([k, , c]) => [k, c]), "#bdbdbd"];
}

function buildStyle() {
  const sources = {
    dem: {
      type: "raster-dem", tiles: ["dem://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],
      encoding: "terrarium", tileSize: 512, maxzoom: 15, attribution: ATTR_DEM,
    },
    // Läpinäkyvä tausta: kuvauksen ulkopuoliset alueet eivät näy valkoisina.
    ortho: { type: "raster", tiles: wmsTiles(ORTHO_YEARS[state.orthoIndex][1]), tileSize: 512, attribution: ATTR_ESPOO },
    kohteet: {
      type: "vector", tiles: [`gz://${BASE}tiles/kohteet/{z}/{x}/{y}.pbf?v=${TILE_VERSION}`],
      minzoom: 8, maxzoom: 15, attribution: ATTR_ESPOO + " · " + ATTR_HSY,
    },
    rakennukset: {
      type: "vector", tiles: [`gz://${BASE}tiles/rakennukset/{z}/{x}/{y}.pbf?v=${TILE_VERSION}`], minzoom: 11, maxzoom: 15,
    },
    nimet: { type: "geojson", data: "data/kaupunginosat_nimet.geojson" },
  };

  const layers = [
    { id: "tausta", type: "background", paint: { "background-color": "#dfe6e9" } },
    { id: "ortho", type: "raster", source: "ortho", paint: { "raster-fade-duration": 150 } },
  ];

  // Ryhmien tasot: ensin kaikki rasterit (alimmaiseksi), sitten alueet, viivat, pisteet ja 3D.
  const order = { raster: 0, fill: 1, line: 2, circle: 3, "fill-extrusion": 4 };
  const overlay = [];
  for (const group of GROUPS) {
    for (const def of group.layers) {
      if (def.wms) {
        sources[def.id] = {
          type: "raster", tiles: wmsTiles(def.wms, { service: def.service }), tileSize: 512,
          attribution: ATTR[def.service ?? "espoo"],
        };
        overlay.push({ id: def.id, type: "raster", source: def.id, layout: { visibility: "none" }, paint: { "raster-opacity": state.overlayOpacity } });
        continue;
      }
      const sourceLayers = [def.sourceLayer ?? def.id].flat();
      def.vector.forEach((spec, i) => sourceLayers.forEach((sl, j) => overlay.push({
        ...spec, id: `${def.id}__${i}_${j}`, source: "kohteet", "source-layer": sl,
        layout: { ...(spec.layout || {}), visibility: def.on ? "visible" : "none" },
      })));
    }
  }
  overlay.sort((a, b) => order[a.type] - order[b.type]);
  layers.push(...overlay.filter((l) => order[l.type] < 4));
  layers.push({
    id: "rakennukset", type: "fill-extrusion", source: "rakennukset", "source-layer": "rakennukset", minzoom: 11,
    paint: {
      "fill-extrusion-color": buildingColorExpr(state.buildingColor),
      "fill-extrusion-height": ["get", "korkeus"],
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12, 0.92],
      "fill-extrusion-vertical-gradient": true,
    },
  });
  layers.push(...overlay.filter((l) => order[l.type] === 4));
  layers.push({
    id: "kaupunginosat_nimet", type: "symbol", source: "nimet",
    layout: {
      "text-field": ["get", "nimi"], "text-font": ["Noto Sans Bold"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 15, 16], "text-letter-spacing": 0.04,
      "text-max-width": 8, visibility: "visible",
    },
    paint: { "text-color": "#1d2a35", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.6 },
  });

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources,
    layers,
    terrain: { source: "dem", exaggeration: TERRAIN_EXAGGERATION },
    sky: {
      "sky-color": "#7fb6ea", "horizon-color": "#dcecfa", "fog-color": "#e8f0f7",
      "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.35, "atmosphere-blend": 0.6,
    },
  };
}

// ------------------------------------------------------------ kartta

const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(),
  center: [24.8150, 60.1790],
  zoom: 14.2,
  pitch: 62,
  bearing: -28,
  maxPitch: 80,
  hash: true,
  maxBounds: [[23.9, 59.8], [25.4, 60.6]],
  attributionControl: {
    compact: true,
    customAttribution: '<a href="https://www.hsl.fi/avoindata" target="_blank" rel="noopener">HSL</a>, '
      + '<a href="https://www.digitraffic.fi" target="_blank" rel="noopener">Fintraffic / digitraffic.fi</a> (CC BY 4.0)'
      + ' · Metroradat © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  },
  antialias: true, // 3D-ajoneuvojen reunat
});
window.espooMap = map; // selaimen konsolia varten
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

map.on("load", () => {
  // Kaupunginosien rajojen näkyvyys seuraa myös nimiä.
  syncLabels();
  initTransit();
});

const busy = document.getElementById("busy");
// Ajoneuvojen vuoksi kartta piirtyy jatkuvasti, eikä idle-tapahtuma tule, joten latauksen
// päättyminen tarkistetaan tiilistä.
map.on("dataloading", () => busy.classList.add("on"));
map.on("data", () => { if (map.areTilesLoaded()) busy.classList.remove("on"); });
map.on("idle", () => busy.classList.remove("on"));

// ------------------------------------------------------------ paneeli

function setVisible(def, on) {
  if (def.wms) {
    map.setLayoutProperty(def.id, "visibility", on ? "visible" : "none");
  } else {
    for (const l of map.getStyle().layers) {
      if (l.id.startsWith(def.id + "__")) map.setLayoutProperty(l.id, "visibility", on ? "visible" : "none");
    }
  }
  def.on = on;
  if (def.id === "kaupunginosat") syncLabels();
  renderLegends();
}

function syncLabels() {
  const def = GROUPS.flatMap((g) => g.layers).find((d) => d.id === "kaupunginosat");
  map.setLayoutProperty("kaupunginosat_nimet", "visibility", def.on ? "visible" : "none");
}

function setOrthoYear(index) {
  state.orthoIndex = index;
  map.getSource("ortho").setTiles(wmsTiles(ORTHO_YEARS[index][1]));
  applyTimeFilter();
}

// Rakennuksista näytetään aina ne, jotka olivat valmiina ilmakuvan vuonna. Uusimmalla
// vuodella näytetään kaikki; vanhemmilla vuosilla rakennukset, joiden valmistumisvuotta
// ei tiedetä, jätetään pois.
function applyTimeFilter() {
  const year = ORTHO_YEARS[state.orthoIndex][0];
  const latest = Math.max(...ORTHO_YEARS.map(([y]) => y));
  map.setFilter("rakennukset", year >= latest ? null : ["all", ["has", "vuosi"], ["<=", ["get", "vuosi"], year]]);
}

function setOverlayOpacity(v) {
  state.overlayOpacity = v;
  for (const def of GROUPS.flatMap((g) => g.layers)) {
    if (def.wms) map.setPaintProperty(def.id, "raster-opacity", v);
  }
}

function flyTo(place) {
  if (!place) {
    map.fitBounds(ESPOO_BOUNDS, { pitch: 45, bearing: 0, padding: 40, duration: 2500 });
    return;
  }
  const [lon, lat, zoom] = place;
  map.flyTo({ center: [lon, lat], zoom, pitch: 62, bearing: map.getBearing(), duration: 2500, essential: true });
}

function legendRows(rows) {
  return el("ul", { class: "legend" }, rows.map(([, label, color]) =>
    el("li", {}, el("span", { class: "swatch", style: `background:${color}` }), label)));
}

function gradientLegend(stops, fmt) {
  const css = stops.map(([v, c], i) => `${c} ${(i / (stops.length - 1)) * 100}%`).join(",");
  return el("div", { class: "gradient" },
    el("div", { class: "bar", style: `background:linear-gradient(90deg,${css})` }),
    el("div", { class: "ticks" }, stops.map(([v]) => el("span", {}, fmt(v)))));
}

function renderLegends() {
  const b = document.getElementById("building-legend");
  b.replaceChildren(
    state.buildingColor === "vuosi" ? gradientLegend(BUILDING_YEAR_STOPS, (v) => v)
      : state.buildingColor === "korkeus" ? gradientLegend(BUILDING_HEIGHT_STOPS, (v) => v + " m")
        : legendRows(BUILDING_CLASSES),
  );
  for (const def of GROUPS.flatMap((g) => g.layers)) {
    const slot = document.querySelector(`[data-legend="${def.id}"]`);
    if (!slot) continue;
    slot.replaceChildren();
    if (!def.on) continue;
    if (def.legend === "landuse") slot.append(legendRows(LANDUSE_CLASSES));
    if (def.legend === "population") slot.append(gradientLegend([[0, "#ffffcc"], [200, "#a1dab4"], [600, "#41b6c4"], [1200, "#2c7fb8"], [2500, "#253494"]], (v) => v));
    if (def.legend === "traffic") slot.append(gradientLegend([[0, "#ffd166"], [10000, "#f77f00"], [30000, "#d62828"], [70000, "#6a040f"]], (v) => (v / 1000) + "k"));
  }
}

function buildPanel() {
  document.getElementById("places").append(...PLACES.map(([name, place]) =>
    el("button", { type: "button", class: "chip", onclick: () => flyTo(place) }, name)));

  document.getElementById("ortho-years").append(...ORTHO_YEARS.map(([year], i) => el("label", { class: "seg" },
    el("input", { type: "radio", name: "ortho-year", value: year, checked: i === state.orthoIndex, onchange: () => setOrthoYear(i) }),
    el("span", {}, String(year)))));

  document.getElementById("buildings").addEventListener("change", (e) =>
    map.setLayoutProperty("rakennukset", "visibility", e.target.checked ? "visible" : "none"));
  document.getElementById("building-color").addEventListener("change", (e) => {
    state.buildingColor = e.target.value;
    map.setPaintProperty("rakennukset", "fill-extrusion-color", buildingColorExpr(state.buildingColor));
    renderLegends();
  });

  const opacity = document.getElementById("overlay-opacity");
  opacity.value = state.overlayOpacity;
  opacity.addEventListener("input", () => setOverlayOpacity(+opacity.value));

  const groups = document.getElementById("groups");
  for (const group of GROUPS) {
    const active = group.layers.some((d) => d.on);
    groups.append(el("details", { class: "group", open: active },
      el("summary", {}, group.title, el("span", { class: "count" }, String(group.layers.length))),
      group.layers.map((def) => el("div", { class: "layer", "data-service": def.service ?? null },
        el("label", {},
          el("input", { type: "checkbox", checked: !!def.on, onchange: (e) => setVisible(def, e.target.checked) }),
          el("span", {}, def.title),
          def.wms ? el("span", { class: "tag" }, { hsy: "HSY", gtk: "GTK" }[def.service] ?? "kartta") : null),
        def.legend ? el("div", { "data-legend": def.id }) : null)),
    ));
  }

  document.getElementById("panel-toggle").addEventListener("click", () => document.body.classList.toggle("panel-closed"));
  renderLegends();
  checkHsyProxy();
}

// HSY:n karttakuvat tarvitsevat välityspalvelimen. Jos julkaisussa ei ole sellaista,
// tasot näytetään harmaina eikä niitä voi valita.
async function checkHsyProxy() {
  const probe = new URL(WMS_SERVICES.hsy, BASE);
  probe.search = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: "taustakartat_ja_aluejaot:Seutukartta",
    STYLES: "", SRS: "EPSG:3857", BBOX: "2760000,8437000,2760100,8437100", WIDTH: "1", HEIGHT: "1", FORMAT: "image/png",
  });
  const ok = await fetch(probe).then((r) => r.ok && (r.headers.get("content-type") || "").startsWith("image/")).catch(() => false);
  if (ok) return;
  for (const row of document.querySelectorAll('.layer[data-service="hsy"]')) {
    row.classList.add("unavailable");
    row.querySelector("input").disabled = true;
    row.title = "HSY:n karttakuvat vaativat välityspalvelimen, jota tässä julkaisussa ei ole.";
  }
}

// ------------------------------------------------------------ joukkoliikenne

let transit = null;

// Reaaliaikaiset ajoneuvot ladataan vasta kartan jälkeen, jotta kartta ei odota niitä.
async function initTransit() {
  const box = document.getElementById("transit-groups");
  const status = document.getElementById("transit-status");
  try {
    const { createTransit, TRANSIT_GROUPS } = await import("./transit.js");
    transit = await createTransit(map, {
      boundaryUrl: "data/espoo_raja.geojson", metroUrl: "data/metro.json",
      beforeLayer: "kaupunginosat_nimet", undergroundBeforeLayer: "rakennukset",
    });
    window.espooTransit = transit;
    const counts = {};
    box.append(...TRANSIT_GROUPS.map(([id, title, color]) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: true, onchange: (e) => transit.setGroup(id, e.target.checked) }),
      el("span", { class: "swatch", style: `background:${color}` }),
      el("span", {}, title),
      counts[id] = el("span", { class: "count" }, "–"))));
    transit.onStats((s) => {
      for (const [id, n] of Object.entries(s.counts)) counts[id].textContent = n.toLocaleString("fi-FI");
      status.textContent = s.message;
    });
  } catch (err) {
    console.error(err);
    status.textContent = "Reaaliaikaisia sijainteja ei saatu ladattua.";
  }
}

// ------------------------------------------------------------ ponnahdusikkuna

const popup = new maplibregl.Popup({ maxWidth: "340px", closeButton: true });

function layerKey(layerId) {
  return layerId === "rakennukset" ? "rakennukset" : layerId.split("__")[0];
}

function layerTitle(key) {
  if (key === "rakennukset") return "Rakennus";
  return GROUPS.flatMap((g) => g.layers).find((d) => d.id === key)?.title ?? key;
}

function formatValue(k, v) {
  if (typeof v === "string" && /^https:\/\//.test(v)) {
    return el("a", { href: v, target: "_blank", rel: "noopener" }, v.includes(".pdf") ? "Avaa PDF" : "Avaa sivu");
  }
  if (k === "korkeus" && typeof v === "number") return v.toFixed(1).replace(".", ",");
  if (typeof v === "number" && !Number.isInteger(v)) return v.toLocaleString("fi-FI", { maximumFractionDigits: 2 });
  if (typeof v === "number" && k !== "vuosi" && Math.abs(v) >= 10000) return v.toLocaleString("fi-FI");
  return String(v);
}

map.on("click", (e) => {
  if (transit?.click(e.point)) { popup.remove(); return; }
  const queryable = map.getStyle().layers
    .filter((l) => (l.id === "rakennukset" || l.id.includes("__")) && map.getLayoutProperty(l.id, "visibility") !== "none")
    .map((l) => l.id);
  const feats = map.queryRenderedFeatures(e.point, { layers: queryable });
  if (!feats.length) { popup.remove(); return; }
  // Rakennus tai pistemäinen kohde ennen sen alla olevia alueita.
  const rank = { "fill-extrusion": 0, circle: 1, line: 2, fill: 3 };
  feats.sort((a, b) => rank[a.layer.type] - rank[b.layer.type]);
  const f = feats[0];
  const key = layerKey(f.layer.id);
  const p = f.properties;
  const rows = Object.entries(p)
    .filter(([k, v]) => !HIDDEN_FIELDS.has(k) && v !== "" && v !== null && !(k.startsWith("Liikennemäärä") && v === 0))
    .map(([k, v]) => {
      // Rakennusrekisteristä täydennettyjen rakennusten korkeus on arvioitu kerrosluvusta.
      const label = k === "korkeus" && p.arvio ? "Korkeus (m, arvio)" : FIELD_LABELS[k] ?? k.replace(/_/g, " ");
      return el("tr", {}, el("th", {}, label), el("td", {}, formatValue(k, v)));
    });
  const title = POPUP_TITLES[key]?.(p) ?? p.Nimi ?? p.nimi ?? p.NIMI ?? layerTitle(key);
  const more = feats.length > 1 ? el("p", { class: "more" }, `+ ${feats.length - 1} muuta kohdetta tässä kohdassa`) : null;
  popup.setLngLat(e.lngLat)
    .setDOMContent(el("div", { class: "pop" }, el("div", { class: "kind" }, layerTitle(key)), el("h3", {}, String(title)), el("table", {}, rows), more))
    .addTo(map);
});

map.on("mousemove", (e) => {
  const ids = ["rakennukset"].filter((id) => map.getLayer(id));
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ids }).length ? "pointer" : "";
});

buildPanel();
