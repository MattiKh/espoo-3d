import {
  BUILDING_CLASSES, BUILDING_HEIGHT_STOPS, BUILDING_YEAR_STOPS, ESPOO_BOUNDS, FIELD_LABELS, HIDDEN_FIELDS,
  KAUNIAINEN, LANDMARKS, LANDUSE_CLASSES, LAYERS, ORTHO_YEARS, PLACES, POPUP_TITLES, RADAR_STOPS, TERRAIN_EXAGGERATION,
  WMS_SERVICES, detailRadius,
} from "./layers.js";
import { patchDemTile } from "./bridges.js";
import { addHaze } from "./haze.js";

const FOG_COLOR = "#e8f0f7"; // utu ja taivaan alaosa

const ATTR_ESPOO = '© <a href="https://kartat.espoo.fi" target="_blank" rel="noopener">Espoon kaupunki</a>';
const ATTR_HSY = '© <a href="https://www.hsy.fi/avoindata" target="_blank" rel="noopener">HSY</a>';
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

// Korkeusmallin tiilet: sillat puuttuvat korkeusmallista, ja ilmakuvan tie notkahtaisi sillan
// kohdalla. Lähikuvassa kannet piirretään 3D-laattoina (decks.js); karkeammissa tiilissä sillat
// nostetaan kannen tasolle (bridges.js).
maplibregl.addProtocol("dem", async (params, abortController) => {
  const url = "https://" + params.url.slice("dem://".length);
  const res = await fetch(url, { signal: abortController.signal });
  if (!res.ok) throw new Error(`Korkeusmallin tiili ${res.status}`);
  const [z, x, y] = url.match(/(\d+)\/(\d+)\/(\d+)\.webp$/).slice(1).map(Number);
  return { data: await patchDemTile(await res.arrayBuffer(), z, x, y) };
});

// Ilmakuva: Espoon karttapalvelu tekee jokaisen ruudun erikseen (PNG, noin 0,7 Mt, noin sekunti),
// mutta sallii vastausten tallentamisen selaimen välimuistiin. Ruudut haetaan oman protokollan
// kautta (ortho://taso/z/x/y), jolloin ruudun osoite on tiedossa, ja kartan pysähdyttyä näkymän
// ympäriltä haetaan valmiiksi naapuriruudut. Karttaa siirrettäessä ne tulevat välimuistista heti.
const ORTHO_PREFETCH_RADIUS = 2; // ruutua keskiruudun ympäriltä samalla tasolla (yksi karkeammalla)
// Karttapalvelu jättää toisinaan ruudun reunaan läpinäkyvän pikselirivin. Ilmakuvan alla tausta on
// siksi ilmakuvan keskisävyinen harmaa, jottei rako näy vaaleana (myös kuvauksen ulkopuoliset alueet).
const ORTHO_BACKGROUND = "#868b84";
const orthoInflight = new Map();
const orthoPrefetched = new Set();
let orthoQueue = [], orthoActive = 0;

function tileBBox(z, x, y) {
  const world = 2 * Math.PI * 6378137, size = world / 2 ** z, x0 = -world / 2 + x * size, y1 = world / 2 - y * size;
  return `${x0},${y1 - size},${x0 + size},${y1}`;
}

function orthoUrl(layer, z, x, y) {
  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: layer, STYLES: "", SRS: "EPSG:3857",
    WIDTH: "512", HEIGHT: "512", FORMAT: "image/png", TRANSPARENT: "TRUE", BBOX: tileBBox(z, x, y),
  });
  return `${WMS_SERVICES.espoo}?${params}`;
}

// Sama ruutu haetaan vain kerran, vaikka ennakkohaku ja kartta pyytäisivät sitä yhtä aikaa.
function fetchOrtho(url, priority) {
  let p = orthoInflight.get(url);
  if (!p) {
    p = fetch(url, { priority }).then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(0))).finally(() => orthoInflight.delete(url));
    orthoInflight.set(url, p);
  }
  return p;
}

maplibregl.addProtocol("ortho", async (params) => {
  const [layer, z, x, y] = params.url.slice("ortho://".length).split("/");
  return { data: await fetchOrtho(orthoUrl(layer, +z, +x, +y), "high") };
});

function prefetchOrtho() {
  orthoQueue = [];
  if (!state.ortho) return;
  const layer = ORTHO_YEARS[state.orthoIndex][1], c = map.getCenter(), zoom = Math.round(map.getZoom());
  const wanted = [];
  for (const [z, r, w] of [[zoom, ORTHO_PREFETCH_RADIUS, 1], [zoom - 1, 1, 2]]) {
    const n = 2 ** z, lat = (c.lat * Math.PI) / 180;
    const cx = Math.floor(((c.lng + 180) / 360) * n), cy = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const url = orthoUrl(layer, z, cx + dx, cy + dy);
        if (!orthoPrefetched.has(url)) wanted.push([Math.hypot(dx, dy) * w, url]);
      }
    }
  }
  // Lähimmät ruudut ensin; karkeamman tason ruudut kattavat nelinkertaisen alan.
  orthoQueue = wanted.sort((a, b) => a[0] - b[0]).map(([, url]) => url);
  pumpOrtho();
}

// Neljä ennakkohakua kerrallaan matalalla prioriteetilla, jottei näkyvien ruutujen lataus hidastu.
function pumpOrtho() {
  while (orthoActive < 4 && orthoQueue.length) {
    const url = orthoQueue.shift();
    orthoPrefetched.add(url);
    orthoActive++;
    fetchOrtho(url, "low").catch(() => orthoPrefetched.delete(url)).finally(() => { orthoActive--; pumpOrtho(); });
  }
}

const orthoTiles = (layer) => [`ortho://${layer}/{z}/{x}/{y}`];

// Sadetutka: Ilmatieteen laitoksen sateen voimakkuus (mm/h). Uusin kuva-aika luetaan tason
// ominaisuuksista viiden minuutin välein; aika on tiiliosoitteessa, joten selain ei näytä vanhaa kuvaa
// välimuistista.
const FMI_WMS = "https://openwms.fmi.fi/geoserver/Radar";
const ATTR_FMI = 'Sadetutka © <a href="https://www.ilmatieteenlaitos.fi/avoin-data" target="_blank" rel="noopener">Ilmatieteen laitos</a> (CC BY 4.0)';
let radarTime = null;

function radarTiles(layer, time) {
  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: layer, STYLES: "", SRS: "EPSG:3857",
    WIDTH: "512", HEIGHT: "512", FORMAT: "image/png", TRANSPARENT: "TRUE", TIME: time,
  });
  return [`${FMI_WMS}/wms?${params}&BBOX={bbox-epsg-3857}`];
}

async function refreshRadar() {
  const def = LAYERS.find((d) => d.radar);
  if (!def) return;
  try {
    const caps = await fetch(`${FMI_WMS}/${def.radar}/wms?service=WMS&request=GetCapabilities&version=1.3.0`, { cache: "no-store" }).then((r) => r.text());
    const times = caps.match(/<Dimension name="time"[^>]*>([^<]+)</)?.[1] ?? "";
    const latest = times.split(",").pop().split("/")[1] ?? times.split(",").pop();
    if (!latest || latest === radarTime) return;
    radarTime = latest;
    if (map.getSource(def.id)) {
      map.getSource(def.id).setTiles(radarTiles(def.radar, latest));
    } else {
      map.addSource(def.id, { type: "raster", tiles: radarTiles(def.radar, latest), tileSize: 512, attribution: ATTR_FMI });
      map.addLayer({
        id: def.id, type: "raster", source: def.id, layout: { visibility: def.on ? "visible" : "none" },
        paint: { "raster-opacity": 0.7, "raster-fade-duration": 0 },
      }, "rakennukset");
    }
    renderLegends();
  } catch (err) {
    console.warn("Sadetutkan kuva-aikaa ei saatu", err);
  }
}

let detail = null; // { lon, lat, radius }: 3D-rakennusten ja kattojen alue lähikuvassa (updateDetail)

const state = {
  ortho: true, // ilmakuva on oletuspohja, mutta sen voi ottaa pois
  orthoIndex: 0,
  overlayOpacity: 0.75,
  buildingColor: "luokka",
};

// ------------------------------------------------------------ apufunktiot

function wmsTiles(layers, { service = "espoo", transparent = true, extra = {} } = {}) {
  const base = new URL(WMS_SERVICES[service], BASE).href;
  const params = new URLSearchParams({
    SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: layers, STYLES: "",
    SRS: "EPSG:3857", WIDTH: "512", HEIGHT: "512", FORMAT: "image/png", TRANSPARENT: transparent ? "TRUE" : "FALSE", ...extra,
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
    ortho: { type: "raster", tiles: orthoTiles(ORTHO_YEARS[state.orthoIndex][1]), tileSize: 512, attribution: ATTR_ESPOO },
    kohteet: {
      type: "vector", tiles: [`gz://${BASE}tiles/kohteet/{z}/{x}/{y}.pbf?v=${TILE_VERSION}`],
      minzoom: 8, maxzoom: 15, attribution: ATTR_ESPOO + " · " + ATTR_HSY,
    },
    rakennukset: {
      type: "vector", tiles: [`gz://${BASE}tiles/rakennukset/{z}/{x}/{y}.pbf?v=${TILE_VERSION}`], minzoom: 11, maxzoom: 15,
      promoteId: "tunnus", // katot (roofs.js) merkitään rakennuksen tilaan tunnuksella
    },
  };

  const visibility = (on) => (on ? "visible" : "none");
  const layers = [
    { id: "tausta", type: "background", paint: { "background-color": state.ortho ? ORTHO_BACKGROUND : "#dfe6e9" } },
    { id: "ortho", type: "raster", source: "ortho", layout: { visibility: visibility(state.ortho) }, paint: { "raster-fade-duration": 150 } },
  ];

  // Aineistot: ensin karttakuvat listan järjestyksessä (alimmaiseksi), sitten alueet, viivat ja 3D.
  const order = { raster: 0, fill: 1, line: 2, circle: 3, "fill-extrusion": 4 };
  const overlay = [];
  for (const def of LAYERS) {
    if (def.radar) continue; // lisätään, kun uusin kuva-aika tiedetään (refreshRadar)
    if (def.labels) continue; // nimet lisätään kaiken päälle (alla)
    if (def.streams) continue; // lisätään, kun uomat on ladattu (initStreams)
    if (def.wms) {
      sources[def.id] = {
        type: "raster", tiles: wmsTiles(def.wms, { service: def.service, extra: def.params }), tileSize: 512,
        attribution: def.service === "hsy" ? ATTR_HSY : ATTR_ESPOO,
      };
      overlay.push({
        id: def.id, type: "raster", source: def.id, layout: { visibility: visibility(def.on) },
        paint: { "raster-opacity": state.overlayOpacity, ...def.paint },
      });
      continue;
    }
    def.vector.forEach((spec, i) => overlay.push({
      ...spec, id: `${def.id}__${i}`, source: "kohteet", "source-layer": def.id,
      layout: { ...(spec.layout || {}), visibility: visibility(def.on) },
    }));
  }
  overlay.sort((a, b) => order[a.type] - order[b.type]);
  layers.push(...overlay.filter((l) => order[l.type] < 4));
  // Kauniainen erottuu aina: läpikuultava tummennus ja katkoviivaraja 3D-rakennusten alla, nimi ylimpänä.
  sources.kauniainen = { type: "geojson", data: KAUNIAINEN, attribution: ATTR_HSY };
  const kauniainen = ["==", ["get", "nimi"], "Kauniainen"];
  layers.push(
    { id: "kauniainen-tausta", type: "fill", source: "kauniainen", filter: kauniainen,
      paint: { "fill-color": "#0b1a2a", "fill-opacity": 0.2 } },
    { id: "kauniainen-reuna-varjo", type: "line", source: "kauniainen", filter: kauniainen, layout: { "line-join": "round" },
      paint: { "line-color": "#0b1a2a", "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6] } },
    { id: "kauniainen-reuna", type: "line", source: "kauniainen", filter: kauniainen, layout: { "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.3, 16, 2.6], "line-dasharray": [3, 2] } },
  );
  layers.push({
    id: "rakennukset", type: "fill-extrusion", source: "rakennukset", "source-layer": "rakennukset", minzoom: 11,
    filter: buildingFilter(),
    paint: {
      "fill-extrusion-color": buildingColorExpr(state.buildingColor),
      // Kaltevakattoisen rakennuksen seinät räystääseen, kun sen katto on ladattu (roofs.js).
      "fill-extrusion-height": ["case", ["boolean", ["feature-state", "katto"], false],
        ["coalesce", ["get", "raystas"], ["get", "korkeus"]], ["get", "korkeus"]],
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12, 1], // läpinäkymättömät lähikuvassa
      "fill-extrusion-vertical-gradient": true,
    },
  });
  layers.push(...overlay.filter((l) => order[l.type] === 4));
  for (const def of LAYERS.filter((d) => d.labels)) {
    sources[def.id] = { type: "geojson", data: def.labels, attribution: ATTR_ESPOO };
    layers.push({
      id: def.id, type: "symbol", source: def.id, minzoom: 10,
      layout: {
        "text-field": ["get", "nimi"], "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 15, 16], "text-letter-spacing": 0.04,
        "text-max-width": 8, visibility: visibility(def.on),
      },
      paint: { "text-color": "#1d2a35", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.6 },
    });
  }
  layers.push({
    id: "kauniainen-nimi", type: "symbol", source: "kauniainen", filter: ["==", ["get", "nimi"], "KAUNIAINEN"], minzoom: 9,
    layout: {
      "text-field": ["get", "nimi"], "text-font": ["Noto Sans Bold"], "text-letter-spacing": 0.3,
      "text-size": ["interpolate", ["linear"], ["zoom"], 9, 12, 15, 22], "text-allow-overlap": true,
    },
    paint: { "text-color": "#ffffff", "text-halo-color": "rgba(11,26,42,0.85)", "text-halo-width": 2 },
  });

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources,
    layers,
    terrain: { source: "dem", exaggeration: TERRAIN_EXAGGERATION },
    // MapLibren sumu koskisi vain maastoa (fog-ground-blend 1: ei sumua), joten utu on kaiken päällä
    // oma liukuvärinsä (haze.js). Taivaan väri vaihtuu horisontissa udun väriin.
    sky: {
      "sky-color": "#7fb6ea", "horizon-color": "#dcecfa", "fog-color": FOG_COLOR,
      "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 1, "atmosphere-blend": 0.6,
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
      + ' · Raiteet ja pysäköintialueet © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  },
  antialias: true, // 3D-ajoneuvojen reunat
  // Nimet ilman häivytystä: koska ajoneuvojen vuoksi karttaa piirretään jatkuvasti, nimien
  // sijoittelu tehdään uudelleen ja häivytys pitäisi kartan piirtymässä täydellä nopeudella.
  fadeDuration: 0,
});
window.espooMap = map; // selaimen konsolia varten
addHaze(map, FOG_COLOR);
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

map.on("load", () => {
  updateDetail();
  initTransit();
  initStreams();
  initRoofs();
  initDecks();
  refreshRadar();
  setInterval(refreshRadar, 120000);
  prefetchOrtho();
});
map.on("moveend", () => setTimeout(prefetchOrtho, 400));
map.on("moveend", updateDetail);

const busy = document.getElementById("busy");
// Ajoneuvojen vuoksi kartta piirtyy jatkuvasti, eikä idle-tapahtuma tule, joten latauksen
// päättyminen tarkistetaan tiilistä.
map.on("dataloading", () => busy.classList.add("on"));
map.on("data", () => { if (map.areTilesLoaded()) busy.classList.remove("on"); });
map.on("idle", () => busy.classList.remove("on"));

// ------------------------------------------------------------ paneeli

function setVisible(def, on) {
  if (def.streams) {
    streams?.setVisible(on);
  } else if (def.radar || def.labels) {
    if (map.getLayer(def.id)) map.setLayoutProperty(def.id, "visibility", on ? "visible" : "none");
  } else if (def.wms) {
    map.setLayoutProperty(def.id, "visibility", on ? "visible" : "none");
  } else {
    for (const l of map.getStyle().layers) {
      if (l.id.startsWith(def.id + "__")) map.setLayoutProperty(l.id, "visibility", on ? "visible" : "none");
    }
  }
  def.on = on;
  renderLegends();
}

function setOrtho(on) {
  state.ortho = on;
  map.setLayoutProperty("ortho", "visibility", on ? "visible" : "none");
  map.setPaintProperty("tausta", "background-color", on ? ORTHO_BACKGROUND : "#dfe6e9");
  prefetchOrtho();
  document.getElementById("ortho-options").hidden = !on;
  applyTimeFilter();
  decks?.setOrtho(state.ortho);
}

function setOrthoYear(index) {
  state.orthoIndex = index;
  map.getSource("ortho").setTiles(orthoTiles(ORTHO_YEARS[index][1]));
  prefetchOrtho();
  applyTimeFilter();
}

// Kun ilmakuva on näkyvissä, rakennuksista näytetään ne, jotka olivat valmiina ilmakuvan
// vuonna. Uusimmalla vuodella ja ilman ilmakuvaa näytetään kaikki; vanhemmilla vuosilla
// rakennukset, joiden valmistumisvuotta ei tiedetä, jätetään pois. Maamerkkien rakennukset
// piilotetaan aina, koska niiden tilalla on oma 3D-malli.
function buildingFilter() {
  const year = ORTHO_YEARS[state.orthoIndex][0];
  const latest = Math.max(...ORTHO_YEARS.map(([y]) => y));
  // Tunnus on tiilissä numero tai merkkijono, joten verrataan merkkijonoina.
  const filter = ["all", ...LANDMARKS.flatMap((l) => [l.building].flat().map((id) => ["!=", ["to-string", ["get", "tunnus"]], String(id)]))];
  if (state.ortho && year < latest) filter.push(["has", "vuosi"], ["<=", ["get", "vuosi"], year]);
  if (detail) filter.push(["<", ["distance", { type: "Point", coordinates: [detail.lon, detail.lat] }], detail.radius]);
  return filter;
}

function applyTimeFilter() {
  map.setFilter("rakennukset", buildingFilter());
  roofs?.refresh();
  refreshLandmarks();
}

// Lähikuvassa 3D-rakennukset ja katot vain näkymän keskipisteen ympäriltä (layers.js, detailRadius).
// Suodatin vaihdetaan vasta, kun näkymä on siirtynyt selvästi, koska MapLibre käsittelee
// rakennustiilet silloin uudelleen.
function updateDetail() {
  const radius = detailRadius(map.getZoom()), c = map.getCenter();
  let next = null;
  if (radius != null) {
    const moved = detail ? Math.hypot((c.lng - detail.lon) * 111320 * Math.cos((c.lat * Math.PI) / 180), (c.lat - detail.lat) * 111320) : Infinity;
    next = detail && moved < detail.radius / 4 && Math.abs(radius / detail.radius - 1) < 0.2
      ? detail : { lon: c.lng, lat: c.lat, radius: Math.round(radius) };
  }
  if (next === detail) return;
  detail = next;
  map.setFilter("rakennukset", buildingFilter());
  roofs?.setArea(detail);
  decks?.setArea(detail);
}

function setOverlayOpacity(v) {
  state.overlayOpacity = v;
  for (const def of LAYERS) {
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
  for (const def of LAYERS) {
    const slot = document.querySelector(`[data-legend="${def.id}"]`);
    if (!slot) continue;
    slot.replaceChildren();
    if (!def.on) continue;
    if (def.legend === "landuse") slot.append(legendRows(LANDUSE_CLASSES));
    if (def.legend === "population") slot.append(gradientLegend([[0, "#ffffcc"], [200, "#a1dab4"], [600, "#41b6c4"], [1200, "#2c7fb8"], [2500, "#253494"]], (v) => v));
    if (def.legend === "traffic") slot.append(gradientLegend([[0, "#ffd166"], [10000, "#f77f00"], [30000, "#d62828"], [70000, "#6a040f"]], (v) => (v / 1000) + "k"));
    if (def.legend === "radar") {
      slot.append(gradientLegend(RADAR_STOPS.filter((_, i) => i % 2 === 0 || i === RADAR_STOPS.length - 1), (v) => String(v).replace(".", ",")));
      const t = radarTime ? new Date(radarTime).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : "…";
      slot.append(el("p", { class: "hint" }, `Sateen voimakkuus (mm/h), tutkakuva klo ${t}. Ilmatieteen laitos.`));
    }
    if (def.legend === "streams") slot.append(el("p", { class: "hint" }, streams?.legendText() ?? "Ladataan uomia…"));
  }
}

function buildPanel() {
  document.getElementById("places").append(...PLACES.map(([name, place]) =>
    el("button", { type: "button", class: "chip", onclick: () => flyTo(place) }, name)));

  const ortho = document.getElementById("ortho");
  ortho.checked = state.ortho;
  ortho.addEventListener("change", () => setOrtho(ortho.checked));
  document.getElementById("ortho-options").hidden = !state.ortho;
  document.getElementById("ortho-years").append(...ORTHO_YEARS.map(([year], i) => el("label", { class: "seg" },
    el("input", { type: "radio", name: "ortho-year", value: year, checked: i === state.orthoIndex, onchange: () => setOrthoYear(i) }),
    el("span", {}, String(year)))));

  document.getElementById("buildings").addEventListener("change", (e) => {
    map.setLayoutProperty("rakennukset", "visibility", e.target.checked ? "visible" : "none");
    roofs?.setVisible(e.target.checked);
    refreshLandmarks();
  });
  document.getElementById("building-color").addEventListener("change", (e) => {
    state.buildingColor = e.target.value;
    map.setPaintProperty("rakennukset", "fill-extrusion-color", buildingColorExpr(state.buildingColor));
    roofs?.refresh();
    refreshLandmarks();
    renderLegends();
  });

  const opacity = document.getElementById("overlay-opacity");
  opacity.value = state.overlayOpacity;
  opacity.addEventListener("input", () => setOverlayOpacity(+opacity.value));

  document.getElementById("layers").append(...LAYERS.map((def) => el("div", { class: "layer" },
    el("label", {},
      el("input", { type: "checkbox", checked: !!def.on, onchange: (e) => setVisible(def, e.target.checked) }),
      el("span", {}, def.title)),
    def.legend ? el("div", { "data-legend": def.id }) : null)));

  document.getElementById("panel-toggle").addEventListener("click", () => document.body.classList.toggle("panel-closed"));
  renderLegends();
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
      boundaryUrl: "data/espoo_raja.geojson", railsUrl: "data/raiteet.json", undergroundBeforeLayer: "rakennukset",
      beforeLayer: "kaupunginosat_nimet", // ajoneuvot nimien alle
      // adsb.fi ei salli selaimen suoria hakuja, joten haku kulkee välityspalvelimen kautta (server.py, netlify.toml).
      planesUrl: new URL("proxy/adsb/lat/60.21/lon/24.66/dist/25", BASE).href,
      chargingUrl: "data/lataus.json",
    });
    window.espooTransit = transit;
    landmarkModels = await import("./landmarks.js"); // sama moduuli, jonka transit.js on jo ladannut
    refreshLandmarks();
    // Liikenne näkyy aina; paneelissa vain ajoneuvojen määrät.
    const counts = {};
    box.append(...TRANSIT_GROUPS.map(([id, title, color]) => el("div", { class: "stat" },
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

// ------------------------------------------------------------ purot ja joet

let streams = null;

// Uomat ja virtaus (streams.js). Virtaviivat piirretään joukkoliikenteen 3D-tasolla (transit.js).
async function initStreams() {
  const def = LAYERS.find((d) => d.streams);
  if (!def) return;
  try {
    const [{ createStreams }, { addExtra }] = await Promise.all([import("./streams.js"), import("./transit.js")]);
    streams = await createStreams(map, { url: "data/purot.json", visible: def.on, beforeLayer: "rakennukset" });
    addExtra(streams.drawable);
    streams.onUpdate(renderLegends);
    renderLegends();
  } catch (err) {
    console.warn("Puroja ei saatu ladattua", err);
  }
}

// ------------------------------------------------------------ katot

let roofs = null;

// Katon ja räystään yläpuolisten seinien väri samoin kuin 3D-rakennuksissa (buildingColorExpr).
function buildingColor(b) {
  if (state.buildingColor === "vuosi") return b.vuosi ? interpolateColor(BUILDING_YEAR_STOPS, b.vuosi) : "#9e9e9e";
  if (state.buildingColor === "korkeus") return interpolateColor(BUILDING_HEIGHT_STOPS, b.korkeus);
  return BUILDING_CLASSES.find(([k]) => k === b.luokka)?.[2] ?? "#bdbdbd";
}

function interpolateColor(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (v > v1) continue;
    const [v0, c0] = stops[i - 1], t = (v - v0) / (v1 - v0);
    const a = parseInt(c0.slice(1), 16), b = parseInt(c1.slice(1), 16);
    const ch = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }
  return stops[stops.length - 1][1];
}

// Sama ehto kuin buildingFilter: maamerkit piiloon, vanhoilla ilmakuvilla vain silloin valmiit.
function buildingShown(b) {
  if (LANDMARKS.some((l) => [l.building].flat().map(String).includes(b.tunnus))) return false;
  const year = ORTHO_YEARS[state.orthoIndex][0], latest = Math.max(...ORTHO_YEARS.map(([y]) => y));
  return !(state.ortho && year < latest) || (b.vuosi != null && b.vuosi <= year);
}

// Katot 3D-mallista (roofs.js), piirretään joukkoliikenteen 3D-tasolla (transit.js).
async function initRoofs() {
  try {
    const [{ createRoofs }, { addExtra }] = await Promise.all([import("./roofs.js"), import("./transit.js")]);
    roofs = await createRoofs(map, {
      url: `${BASE}tiles/katot`, version: TILE_VERSION, colorOf: buildingColor, isVisible: buildingShown,
      visible: document.getElementById("buildings").checked,
    });
    addExtra(roofs.drawable);
    roofs.setArea(detail);
  } catch (err) {
    console.warn("Kattoja ei saatu ladattua", err);
  }
}

// Siltojen kannet 3D-laattoina lähialueella (decks.js). Siltatiedot ja korkeusmalli ovat nykyhetkestä,
// joten laatan pinnassa on uusin ilmakuva, vaikka kartalla olisi vanhempi.
let decks = null;

function orthoImage(z, x, y) {
  if (!state.ortho) return Promise.resolve(null);
  return fetchOrtho(orthoUrl(ORTHO_YEARS[0][1], z, x, y), "low")
    .then((buf) => (buf.byteLength ? createImageBitmap(new Blob([buf])) : null));
}

async function initDecks() {
  try {
    const [{ createDecks }, { addExtra }] = await Promise.all([import("./decks.js"), import("./transit.js")]);
    decks = createDecks(map, { orthoImage, ortho: state.ortho });
    addExtra(decks.drawable);
    decks.setArea(detail);
  } catch (err) {
    console.warn("Siltojen kansia ei saatu piirrettyä", err);
  }
}

// Katto ei kuulu MapLibren 3D-rakennuksiin, joten sen rakennus haetaan tunnuksella.
function pickRoof(point) {
  const b = roofs?.pick(point), p = b && buildingProps(b.tunnus);
  return p ? { properties: p, layer: { id: "rakennukset", type: "fill-extrusion" } } : null;
}

// Espoon 3D-kaupunkimallista piirretyt maamerkit väritetään ja suodatetaan kuten muut rakennukset
// (landmarks.js). Ne piilotetaan myös, kun 3D-rakennukset otetaan pois.
let landmarkModels = null;

function landmarkShown(b) {
  const year = ORTHO_YEARS[state.orthoIndex][0], latest = Math.max(...ORTHO_YEARS.map(([y]) => y));
  return document.getElementById("buildings").checked
    && (!(state.ortho && year < latest) || (b.vuosi != null && b.vuosi <= year));
}

function refreshLandmarks() {
  landmarkModels?.setLandmarkStyle({ colorOf: buildingColor, isVisible: landmarkShown });
}

// Ohut uomaviiva osuu helpommin, kun klikkauksen ympäriltä haetaan muutaman pikselin alue.
function pickStream(point) {
  if (!streams || !map.getLayer("purot") || map.getLayoutProperty("purot", "visibility") === "none") return null;
  const r = 6, [f] = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: ["purot"] });
  return f ? streams.popupContent(f.properties) : null;
}

// ------------------------------------------------------------ ponnahdusikkuna

const popup = new maplibregl.Popup({ maxWidth: "340px", closeButton: true });

function layerKey(layerId) {
  return layerId === "rakennukset" ? "rakennukset" : layerId.split("__")[0];
}

function layerTitle(key) {
  if (key === "rakennukset") return "Rakennus";
  return LAYERS.find((d) => d.id === key)?.title ?? key;
}

function formatValue(k, v) {
  if (typeof v === "string" && /^https:\/\//.test(v)) {
    return el("a", { href: v, target: "_blank", rel: "noopener" }, v.includes(".pdf") ? "Avaa PDF" : "Avaa sivu");
  }
  if (k === "korkeus" && typeof v === "number") return v.toFixed(1).replace(".", ",");
  if (typeof v === "number" && !Number.isInteger(v)) return v.toLocaleString("fi-FI", { maximumFractionDigits: 2 });
  if (typeof v === "number" && k !== "vuosi" && k !== "tunnus" && Math.abs(v) >= 10000) return v.toLocaleString("fi-FI");
  return String(v);
}

// Kohteen ominaisuudet ponnahdusikkunan riveiksi: [otsikko, arvo].
function featureRows(p) {
  return Object.entries(p)
    .filter(([k, v]) => !HIDDEN_FIELDS.has(k) && v !== "" && v !== null && !(k.startsWith("Liikennemäärä") && v === 0))
    .map(([k, v]) => {
      // Rakennusrekisteristä täydennettyjen rakennusten korkeus on arvioitu kerrosluvusta.
      const label = k === "korkeus" && p.osa ? "Korkeus (m, rakennuksen osa)"
        : k === "korkeus" && p.keski ? "Korkeus (m, kattojen keskikorkeus)"
          : k === "korkeus" && p.arvio ? "Korkeus (m, arvio)" : FIELD_LABELS[k] ?? k.replace(/_/g, " ");
      return [label, formatValue(k, v)];
    });
}

// Lisätiedot Espoon rakennusrekisteristä (avoin WFS GIS:Rakennukset) rakennustunnuksella. Haku
// tehdään vasta, kun rakennuksen tiedot avataan, ja vastaukset muistetaan.
const ESPOO_WFS = "https://kartat.espoo.fi/teklaogcweb/wfs.ashx";
const GIS_NS = "http://www.tekla.com/schemas/GIS";
const REGISTER_FIELDS = [
  ["KERROSALA", "Kerrosala (m²)", "ala"], ["KOKONAISALA", "Kokonaisala (m²)", "ala"], ["TILAVUUS", "Tilavuus (m³)", "ala"],
  ["KELLARINPINTAALA", "Kellarin pinta-ala (m²)", "ala"], ["HUONEISTOT", "Huoneistoja", "ala"],
  ["LAMMITYSTAPA", "Lämmitystapa"], ["POLTTOAINE", "Lämmön lähde"], ["KAYTOSSAOLOTILANNE", "Käyttötilanne"],
  ["VALMISTUNUT", "Valmistumispäivä"], ["SIJAINTIKIINTEISTO", "Kiinteistötunnus"], ["RAKENNUSTUNNUS", "Rakennustunnus (vanha)"],
];
const registerCache = new Map();

function registerDetails(tunnus) {
  if (!registerCache.has(tunnus)) {
    const filter = '<Filter xmlns="http://www.opengis.net/ogc"><PropertyIsEqualTo><PropertyName>PYSYVARAKENNUSTUNNUS</PropertyName>'
      + `<Literal>${String(tunnus).replace(/[^0-9A-Za-z-]/g, "")}</Literal></PropertyIsEqualTo></Filter>`;
    const params = new URLSearchParams({ service: "WFS", version: "1.1.0", request: "GetFeature", typeName: "GIS:Rakennukset", maxFeatures: "1", filter });
    registerCache.set(tunnus, fetch(`${ESPOO_WFS}?${params}`).then((r) => r.text()).then((xml) => {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      return REGISTER_FIELDS.map(([field, label, type]) => {
        const v = doc.getElementsByTagNameNS(GIS_NS, field)[0]?.textContent?.trim();
        if (!v || v === "Ei arvoa" || /1\.1\.1900$/.test(v)) return null;
        if (type !== "ala") return [label, v];
        const n = Number(v);
        return n > 0 ? [label, n.toLocaleString("fi-FI", { maximumFractionDigits: 0 })] : null;
      }).filter(Boolean);
    }).catch(() => null));
  }
  return registerCache.get(tunnus);
}

const rowsTable = (rows) => el("table", {}, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v))));

// Ponnahdusikkuna; rakennukselle (tunnus) haetaan lisäksi rekisterin tiedot.
function showPopup(lngLat, { kind, title, rows, more, tunnus }) {
  const register = tunnus ? el("div", { class: "register" }, el("p", { class: "more" }, "Haetaan lisätietoja Espoon rakennusrekisteristä…")) : null;
  popup.setLngLat(lngLat)
    .setDOMContent(el("div", { class: "pop" }, el("div", { class: "kind" }, kind), el("h3", {}, String(title)), rowsTable(rows), register, more))
    .addTo(map);
  if (!tunnus) return;
  registerDetails(tunnus).then((extra) => {
    const known = new Set(rows.map(([k]) => k));
    const fresh = (extra ?? []).filter(([k]) => !known.has(k));
    register.replaceChildren(fresh.length
      ? el("div", {}, el("div", { class: "kind" }, "Espoon rakennusrekisteri"), rowsTable(fresh))
      : el("p", { class: "more" }, extra ? "Rakennusrekisterissä ei ole lisätietoja." : "Rakennusrekisteriä ei juuri nyt saatu haettua."));
  });
}

// Rakennuksen ominaisuudet rakennustiilistä tunnuksella. Osiin jaetun rakennuksen korkeus on osien
// suurin korkeus.
function buildingProps(tunnus) {
  const parts = map.querySourceFeatures("rakennukset", {
    sourceLayer: "rakennukset", filter: ["==", ["to-string", ["get", "tunnus"]], String(tunnus)],
  });
  if (!parts.length) return null;
  const p = { ...parts[0].properties };
  if (parts.length > 1 || p.osa) {
    p.korkeus = Math.max(...parts.map((f) => f.properties.korkeus ?? 0));
    delete p.osa;
    delete p.keski;
  }
  return p;
}

// Maamerkki näytetään rakennuksena: rakennuksen tiedot, maamerkin omat tiedot ja rekisterin lisätiedot.
function showLandmark(lngLat, l) {
  const tunnus = String([l.building].flat()[0]), p = buildingProps(tunnus);
  const rows = p ? featureRows(p) : [];
  const known = new Set(rows.map(([k]) => k));
  rows.push(...l.rows.filter(([k]) => !known.has(k)));
  showPopup(lngLat, { kind: "Rakennus", title: l.name, rows, tunnus });
}

map.on("click", (e) => {
  if (transit?.click(e.point)) { popup.remove(); return; }
  const landmark = transit?.pickLandmark(e.point);
  if (landmark) { showLandmark(e.lngLat, landmark); return; }
  const queryable = map.getStyle().layers
    .filter((l) => (l.id === "rakennukset" || l.id.includes("__")) && map.getLayoutProperty(l.id, "visibility") !== "none")
    .map((l) => l.id);
  const feats = map.queryRenderedFeatures(e.point, { layers: queryable });
  const roof = pickRoof(e.point);
  if (roof) feats.unshift(roof);
  // Rakennus tai pistemäinen kohde ennen sen alla olevia alueita.
  const rank = { "fill-extrusion": 0, circle: 1, line: 2, fill: 3 };
  feats.sort((a, b) => rank[a.layer.type] - rank[b.layer.type]);
  // Uoma ennen alueita (esim. asemakaavan käyttötarkoitus).
  const stream = !feats.length || feats[0].layer.type === "fill" ? pickStream(e.point) : null;
  if (stream) { popup.setLngLat(e.lngLat).setDOMContent(stream).addTo(map); return; }
  if (!feats.length) { popup.remove(); return; }
  const f = feats[0], key = layerKey(f.layer.id), p = f.properties;
  const title = POPUP_TITLES[key]?.(p) ?? p.Nimi ?? p.nimi ?? p.NIMI ?? layerTitle(key);
  const more = feats.length > 1 ? el("p", { class: "more" }, `+ ${feats.length - 1} muuta kohdetta tässä kohdassa`) : null;
  showPopup(e.lngLat, { kind: layerTitle(key), title, rows: featureRows(p), more, tunnus: key === "rakennukset" ? p.tunnus : null });
});

map.on("mousemove", (e) => {
  const ids = ["rakennukset"].filter((id) => map.getLayer(id));
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ids }).length ? "pointer" : "";
});

buildPanel();
