import {
  BUILDING_CLASSES, BUILDING_HEIGHT_STOPS, BUILDING_YEAR_STOPS, FIELD_LABELS, HIDDEN_FIELDS,
  KAUNIAINEN, LANDMARKS, LANDUSE_CLASSES, LAYERS, POPUP_TITLES, RADAR_STOPS, TERRAIN_EXAGGERATION,
  WMS_SERVICES, detailRadius,
} from "./layers.js";
import { liftedTileUrl } from "./bridges.js";

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

// Korkeusmallin tiilet. Sillat puuttuvat korkeusmallista, joten tie notkahtaisi sillan kohdalla.
// Siltojen kohdalla haetaan valmiiksi muokattu tiili (scripts/build_data.py, bridges.js: 3D-siltojen
// jänteet auki, muut kannet nostettu), muut suoraan Mapterhornista.
maplibregl.addProtocol("dem", async (params, abortController) => {
  const [z, x, y] = params.url.slice("dem://".length).split("?")[0].split("/").map(Number);
  const url = (await liftedTileUrl(z, x, y, TILE_VERSION)) ?? `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;
  const res = await fetch(url, { signal: abortController.signal });
  if (!res.ok) throw new Error(`Korkeusmallin tiili ${res.status}`);
  return { data: await res.arrayBuffer() };
});

// MapLibre (4.7) laskee korkeusmallin hakumatriisin väärin suurennetulle ruudulle (zoom yli tiilien
// tason 15), kun sen korkeusmalliruutu latautuu vielä ja tilalla käytetään yläruutua: haku kattaa
// koko yläruudun eikä vain ruudun omaa osaa. 3D-rakennukset (ja nimet) saivat silloin hetkeksi
// toisen kohdan korkeuden ja välähtivät kymmeniä metrejä ilmassa tai maan alla. Matriisi lasketaan
// uudelleen käytetyn yläruudun mukaan; MapLibre tekee sen joka kutsulla uutena, joten sen voi muuttaa.
const TILE_EXTENT = 8192; // vektoritiilen koordinaatit
function fixTerrainLookup(terrain) {
  const proto = Object.getPrototypeOf(terrain);
  if (proto.getTerrainData.fixed) return;
  const get = proto.getTerrainData;
  proto.getTerrainData = function (tileID) {
    const data = get.call(this, tileID);
    const src = data.tile?.tileID.canonical, c = tileID.canonical, dz = src ? c.z - src.z : 0;
    if (tileID.overscaledZ > c.z && dz > 0 && c.x >> dz === src.x && c.y >> dz === src.y) {
      const s = 1 / (TILE_EXTENT << dz);
      data.u_terrain_matrix.set([s, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 0,
        (c.x - (src.x << dz)) * TILE_EXTENT * s, (c.y - (src.y << dz)) * TILE_EXTENT * s, 0, 1]);
    }
    return data;
  };
  proto.getTerrainData.fixed = true;
}

// Maaston pinta on pelillinen maasto (pelimaasto.js). 3D-maastotilassa MapLibre jättää loitonnettaessa
// maastoruudun toisinaan yhdeksi kuvaksi ilman pintaa, joten tausta on maaston keskisävy, jottei
// aukko erotu vaaleana. Sama sävy on Espoon ulkopuolella (pelimaasto_worker.js).
const GROUND_BACKGROUND = "#6f8a5a";

// Sadetutka (sadetutka.js): Ilmatieteen laitoksen sateen voimakkuus (mm/h) pyöreäreunaisina alueina
// 50 m maanpinnan yläpuolella. Uusin kuva-aika luetaan tason ominaisuuksista kahden minuutin välein;
// aika on kuvan osoitteessa, joten selain ei näytä vanhaa kuvaa välimuistista.
const FMI_WMS = "https://openwms.fmi.fi/geoserver/Radar";
const ATTR_FMI = 'Sadetutka © <a href="https://www.ilmatieteenlaitos.fi/avoin-data" target="_blank" rel="noopener">Ilmatieteen laitos</a> (CC BY 4.0)';
let radarTime = null;
let radar = null;
let radarBusy = false;

async function refreshRadar() {
  const def = LAYERS.find((d) => d.radar);
  if (!def || radarBusy) return;
  radarBusy = true;
  try {
    const caps = await fetch(`${FMI_WMS}/${def.radar}/wms?service=WMS&request=GetCapabilities&version=1.3.0`, { cache: "no-store" }).then((r) => r.text());
    const times = caps.match(/<Dimension name="time"[^>]*>([^<]+)</)?.[1] ?? "";
    const latest = times.split(",").pop().split("/")[1] ?? times.split(",").pop();
    if (!latest || latest === radarTime) return;
    if (!radar) {
      const [{ createRadar }, { addExtra }] = await Promise.all([import("./sadetutka.js"), import("./transit.js")]);
      radar = createRadar(map, { layer: def.radar, visible: def.on, attribution: ATTR_FMI });
      addExtra(radar.drawable);
    }
    await radar.setTime(latest);
    radarTime = latest;
    renderLegends();
  } catch (err) {
    console.warn("Sadetutkaa ei saatu", err);
  } finally {
    radarBusy = false;
  }
}

let detail = null; // { lon, lat, radius }: 3D-rakennusten ja kattojen alue lähikuvassa (updateDetail)

const state = {
  trees: new URLSearchParams(location.search).get("puut") !== "0", // 3D-puut metsissä (pois: ?puut=0)
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

// Luonnolliset värit (scripts/build_data.py, build_building_colors): seinien ja kaltevien kattojen
// värit Espoon 3D-mallin valokuvista. Tasakatot ovat bitumikatteen harmaita, sillä kuvissa niiden
// väri vaihtelee valaistuksen ja likaisuuden mukaan. Rakennukset, joilla väriä ei ole (esim.
// rekisteristä täydennetyt), saavat yleisimmät sävyt.
const NATURAL_WALL = "#d6d1c6", NATURAL_ROOF = "#5d5f61", NATURAL_FLAT_ROOF = "#4a4b4d";
const NATURAL_ROOF_CAP = 0.3; // m: tasaisen katon värilaatan paksuus

function buildingColorExpr(mode) {
  if (mode === "luonnollinen") return ["coalesce", ["get", "seina"], NATURAL_WALL];
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
      type: "raster-dem", tiles: ["dem://{z}/{x}/{y}"],
      encoding: "terrarium", tileSize: 512, maxzoom: 15, attribution: ATTR_DEM,
    },
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
    { id: "tausta", type: "background", paint: { "background-color": GROUND_BACKGROUND } },
  ];

  // Aineistot: ensin karttakuvat listan järjestyksessä (alimmaiseksi), sitten alueet, viivat ja 3D.
  const order = { raster: 0, fill: 1, line: 2, circle: 3, "fill-extrusion": 4 };
  const overlay = [];
  for (const def of LAYERS) {
    if (def.radar) continue; // lisätään, kun uusin kuva-aika tiedetään (refreshRadar)
    if (def.labels) continue; // nimet lisätään kaiken päälle (alla)
    if (def.streams) continue; // lisätään, kun uomat on ladattu (initStreams)
    if (def.cameras) continue; // lisätään, kun kamerat on haettu (initCameras)
    if (def.wms) {
      sources[def.id] = {
        type: "raster", tiles: wmsTiles(def.wms, { service: def.service, extra: def.params }), tileSize: 512,
        attribution: ATTR_ESPOO,
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
  // MapLibren 3D-rakennuksella on yksi väri, joten luonnollisissa väreissä tasaisen katon väri on ohut
  // laatta yläpinnan päällä. Rakennuksella, jonka kalteva katto piirretään (roofs.js), laatta on
  // litteä ja rakennuksen sisällä 1 m korkeudessa: pohjan korkeus 0 jatkaisi sen seiniä MapLibressa
  // 10 m maan alle rakennuksen omien seinien kohdalle, jolloin seinien alaosa välkkyisi.
  const hasRoof = ["boolean", ["feature-state", "katto"], false];
  layers.push({
    id: "rakennukset-katto", type: "fill-extrusion", source: "rakennukset", "source-layer": "rakennukset", minzoom: 11,
    filter: buildingFilter(), layout: { visibility: visibility(state.buildingColor === "luonnollinen") },
    paint: {
      // Kaltevakattoinen rakennus (raystas) näkyy kaukaa ja lähialueen ulkopuolella laatikkona.
      "fill-extrusion-color": ["case", ["has", "raystas"], ["coalesce", ["get", "katto"], NATURAL_ROOF], NATURAL_FLAT_ROOF],
      "fill-extrusion-base": ["case", hasRoof, 1, ["get", "korkeus"]],
      "fill-extrusion-height": ["case", hasRoof, 1, ["+", ["get", "korkeus"], NATURAL_ROOF_CAP]],
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0, 12, 1],
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
    // Maastoon ei sumua (fog-ground-blend 1): MapLibren sumu koskisi vain maastoa, ei rakennuksia
    // eikä kulkuneuvoja.
    sky: {
      "sky-color": "#7fb6ea", "horizon-color": "#dcecfa", "fog-color": "#e8f0f7",
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
map.on("terrain", () => map.terrain && fixTerrainLookup(map.terrain));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

map.on("load", () => {
  updateDetail();
  initTransit();
  initStreams();
  initRoofs();
  initGround();
  initCameras();
  refreshRadar();
  setInterval(refreshRadar, 120000);
});
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
  } else if (def.cameras) {
    cameras?.setVisible(on);
  } else if (def.radar) {
    radar?.setVisible(on);
  } else if (def.labels) {
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

// Maaston pinta (pelimaasto.js): maanpeite tekstuureina, tiet viivoineen, 3D-sillat ja -puut.
let ground = null;

async function initGround() {
  try {
    const [{ createGameTerrain }, { addExtra }] = await Promise.all([import("./pelimaasto.js"), import("./transit.js")]);
    ground = await createGameTerrain(map, { base: BASE, version: TILE_VERSION });
    window.espooGame = ground; // selaimen konsolia varten (esim. espooGame.stats())
    addExtra(ground.drawable);
    ground.setTrees(state.trees);
    ground.setVisible(true);
  } catch (err) {
    console.warn("Maastoa ei saatu ladattua", err);
  }
}

// Maamerkkien rakennukset piilotetaan aina, koska niiden tilalla on oma 3D-malli.
function buildingFilter() {
  // Tunnus on tiilissä numero tai merkkijono, joten verrataan merkkijonoina.
  const filter = ["all", ...LANDMARKS.flatMap((l) => [l.building].flat().map((id) => ["!=", ["to-string", ["get", "tunnus"]], String(id)]))];
  if (detail) filter.push(["<", ["distance", { type: "Point", coordinates: [detail.lon, detail.lat] }], detail.radius]);
  return filter;
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
  for (const id of ["rakennukset", "rakennukset-katto"]) map.setFilter(id, buildingFilter());
  roofs?.setArea(detail);
}

function setOverlayOpacity(v) {
  state.overlayOpacity = v;
  for (const def of LAYERS) {
    if (def.wms) map.setPaintProperty(def.id, "raster-opacity", v);
  }
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
    state.buildingColor === "luonnollinen"
      ? el("p", { class: "hint" }, "Seinien ja kaltevien kattojen värit Espoon 3D-kaupunkimallin valokuvista (ilmakuvat 2024). "
        + "Väri on arvio, josta on jätetty pois varjot, ikkunat ja kasvillisuus. Tasakatot ovat bitumikatteen harmaita.")
      : state.buildingColor === "vuosi" ? gradientLegend(BUILDING_YEAR_STOPS, (v) => v)
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
    if (def.legend === "cameras") {
      slot.append(el("p", { class: "hint" }, cameras?.legendText() ?? "Haetaan kameroita…"));
    }
  }
}

function buildPanel() {
  const trees = document.getElementById("pelimaasto-puut");
  trees.checked = state.trees;
  trees.addEventListener("change", () => {
    state.trees = trees.checked;
    ground?.setTrees(state.trees);
  });

  const buildings = document.getElementById("buildings");
  const showBuildings = () => {
    map.setLayoutProperty("rakennukset", "visibility", buildings.checked ? "visible" : "none");
    map.setLayoutProperty("rakennukset-katto", "visibility", buildings.checked && state.buildingColor === "luonnollinen" ? "visible" : "none");
  };
  buildings.addEventListener("change", () => {
    showBuildings();
    roofs?.setVisible(buildings.checked);
    refreshLandmarks();
  });
  document.getElementById("building-color").addEventListener("change", (e) => {
    state.buildingColor = e.target.value;
    map.setPaintProperty("rakennukset", "fill-extrusion-color", buildingColorExpr(state.buildingColor));
    showBuildings();
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
      boundaryUrl: "data/espoo_raja.geojson", railsUrl: "data/raiteet.json", roadsUrl: "data/ajotiet.json",
      undergroundBeforeLayer: "rakennukset",
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

// ------------------------------------------------------------ kelikamerat

let cameras = null;

// Kelikamerat (kelikamerat.js): sijainnit Digitrafficista, kuvat vasta klikkauksesta.
async function initCameras() {
  const def = LAYERS.find((d) => d.cameras);
  if (!def) return;
  try {
    const { createCameras } = await import("./kelikamerat.js");
    cameras = await createCameras(map, { boundaryUrl: "data/espoo_raja.geojson", visible: def.on });
    cameras.onUpdate(renderLegends);
    renderLegends();
  } catch (err) {
    console.warn("Kelikameroita ei saatu haettua", err);
  }
}

// ------------------------------------------------------------ katot

let roofs = null;

// Katon ja räystään yläpuolisten seinien väri samoin kuin 3D-rakennuksissa (buildingColorExpr);
// luonnollisissa väreissä seinillä, katolla ja sen tasaisilla osilla on omat värinsä
// ({ seina, katto, tasakatto }).
function buildingColor(b) {
  if (state.buildingColor === "luonnollinen") {
    return { seina: b.seina ?? NATURAL_WALL, katto: b.katto ?? NATURAL_ROOF, tasakatto: NATURAL_FLAT_ROOF };
  }
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

// Sama ehto kuin buildingFilter: maamerkit piiloon.
const buildingShown = (b) => !LANDMARKS.some((l) => [l.building].flat().map(String).includes(b.tunnus));

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

// Katto ei kuulu MapLibren 3D-rakennuksiin, joten sen rakennus haetaan tunnuksella.
function pickRoof(point) {
  const b = roofs?.pick(point), p = b && buildingProps(b.tunnus);
  return p ? { properties: p, layer: { id: "rakennukset", type: "fill-extrusion" } } : null;
}

// Espoon 3D-kaupunkimallista piirretyt maamerkit väritetään ja suodatetaan kuten muut rakennukset
// (landmarks.js). Ne piilotetaan myös, kun 3D-rakennukset otetaan pois.
let landmarkModels = null;

const landmarkShown = () => document.getElementById("buildings").checked;

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
  const camera = cameras?.pick(e.point);
  if (camera) { popup.setLngLat(camera.lngLat).setDOMContent(camera.content).addTo(map); return; }
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
  const ids = ["rakennukset", "kelikamerat"].filter((id) => map.getLayer(id));
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ids }).length ? "pointer" : "";
});

buildPanel();
