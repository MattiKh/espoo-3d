// Karttatasojen määrittelyt. Vektoritasot tulevat paikallisista tiilistä
// (scripts/build_data.py), WMS-tasot suoraan Espoon tai HSY:n palvelimelta.

// Kaikki tässä käytetyt WMS-tasot on tarkistettu avoimiksi; osa Espoon tasoista
// (esim. maaperäkartta, yleiskaava, johtokartta) vaatii tunnukset eikä ole mukana.
// GTK:n palvelua ei tällä hetkellä käytetä.
export const WMS_SERVICES = {
  espoo: "https://kartat.espoo.fi/teklaogcweb/wms.ashx",
  hsy: "proxy/hsy/wms", // välityspalvelin (server.py tai julkaisualusta), koska HSY ei salli CORSia
  gtk: "https://gtkdata.gtk.fi/arcgis/services/Rajapinnat/GTK_Maapera_WMS/MapServer/WMSServer",
};
export const ESPOO_WMS = WMS_SERVICES.espoo;

// Pohjana on oletuksena vuoden 2024 ilmakuva; sen voi ottaa pois. Ensimmäinen vuosi on oletus.
// Espoon WMS:ssä on myös vuodet 1950, 1969, 2001, 2007–2013 ja 2017–2023 (tasot Ortokartta_VVVV)
// sekä uusin kuva (Ortokartta).
export const ORTHO_YEARS = [
  [2024, "Ortokartta_2024"], [2015, "Ortokartta_2015"], [2005, "Ortokartta_2005"], [1996, "Ortokartta_1996"],
  [1976, "Ortokartta_1976"],
];

// Maaston korostus; korkeusmalli on aina käytössä ilman rinnevarjostusta.
export const TERRAIN_EXAGGERATION = 1.5;

// Lähikuvassa 3D-rakennukset, katot ja latausten salamat piirretään vain näkymän keskipisteen
// ympäriltä, jotta kartta pysyy sujuvana; kauempana näkyy ilmakuva. Säde (m) zoomaustason
// mukaan: 4 km tasolla 14, 2,8 km tasolla 15 ja 2 km lähempää; null = ei rajausta.
export const DETAIL_MINZOOM = 14;
export const detailRadius = (zoom) => (zoom < DETAIL_MINZOOM ? null : Math.max(2000, 4000 * 2 ** ((DETAIL_MINZOOM - zoom) / 2)));

export const PLACES = [
  ["Koko Espoo", null],
  ["Tapiola", [24.8055, 60.1757, 15.2]],
  ["Keilaniemi", [24.8285, 60.1770, 15.6]],
  ["Otaniemi", [24.8290, 60.1865, 15.2]],
  ["Leppävaara", [24.8130, 60.2185, 15.2]],
  ["Matinkylä", [24.7385, 60.1600, 15.2]],
  ["Espoon keskus", [24.6570, 60.2050, 15.2]],
  ["Nuuksio", [24.5750, 60.2950, 13]],
];

export const ESPOO_BOUNDS = [[24.48, 60.05], [24.88, 60.37]];

// ---------------------------------------------------------------- värit

export const BUILDING_CLASSES = [
  ["pientalo", "Pientalo", "#e9c46a"],
  ["rivitalo", "Rivi- tai ketjutalo", "#f4a261"],
  ["kerrostalo", "Kerrostalo", "#e76f51"],
  ["asuin_muu", "Muu asuinrakennus", "#d4a373"],
  ["liike", "Liike tai toimisto", "#4f8fd6"],
  ["julkinen", "Julkinen palvelu", "#9b6fd6"],
  ["teollisuus", "Teollisuus tai varasto", "#8d99ae"],
  ["liikenne", "Liikenne tai pysäköinti", "#6c7a89"],
  ["vapaa_aika", "Vapaa-ajan asunto", "#90be6d"],
  ["talous", "Talousrakennus", "#cbbfa8"],
  ["muu", "Muu tai tuntematon", "#bdbdbd"],
];

export const BUILDING_YEAR_STOPS = [
  [1900, "#3b0f70"], [1940, "#8c2981"], [1960, "#de4968"], [1980, "#fe9f6d"], [2000, "#fcfdbf"], [2025, "#ffffff"],
];
export const BUILDING_HEIGHT_STOPS = [[3, "#d9ed92"], [10, "#76c893"], [20, "#34a0a4"], [40, "#1a759f"], [80, "#184e77"]];

export const LANDUSE_CLASSES = [
  ["asuminen", "Asuminen (A)", "#f6c26b"],
  ["keskusta", "Keskusta (C)", "#c9184a"],
  ["liike", "Liike ja toimisto (K)", "#e05a5a"],
  ["palvelu", "Palvelut (P)", "#f28fad"],
  ["julkinen", "Julkiset palvelut (Y)", "#b185db"],
  ["teollisuus", "Teollisuus ja varasto (T)", "#9a8c98"],
  ["liikenne", "Liikenne (L)", "#c0c4c8"],
  ["erityis", "Erityisalueet (E)", "#7d8597"],
  ["virkistys", "Virkistys (V)", "#74c69d"],
  ["suojelu", "Suojelu (S)", "#2d6a4f"],
  ["maa_metsa", "Maa- ja metsätalous (M)", "#b7e4c7"],
  ["loma", "Loma ja matkailu (R)", "#ffe5b4"],
  ["vesi", "Vesialue (W)", "#4ea8de"],
  ["muu", "Muu", "#dddddd"],
];

const match = (prop, classes, fallback) => ["match", ["get", prop], ...classes.flatMap(([k, , c]) => [k, c]), fallback];

export const landuseColor = match("luokka", LANDUSE_CLASSES, "#dddddd");

const trafficVolume = ["max",
  ["to-number", ["get", "Liikennemäärä_KAVL_2025"], 0], ["to-number", ["get", "Liikennemäärä_KAVL_2024"], 0],
  ["to-number", ["get", "Liikennemäärä_KAVL_2023"], 0], ["to-number", ["get", "Liikennemäärä_KAVL_2022"], 0],
  ["to-number", ["get", "Liikennemäärä_KAVL_2021"], 0]];

// ---------------------------------------------------------------- tasot
//
// Valittavat aineistot paneelin järjestyksessä. Karttakuvat (WMS) piirretään tässä järjestyksessä
// alimmasta ylimpään, ja vektoritasot niiden päälle. on = päällä oletuksena.
//
// Vektoritaso: { id, title, vector: [MapLibre-tasomäärittelyt ilman id:tä ja lähdettä] }
//   source-layer on oletuksena id.
// WMS-taso:   { id, title, wms: "TASO", service: "espoo" | "hsy", params: {...}, paint: {...} }
//   service on oletuksena Espoon karttapalvelu; params lisää kyselyyn palvelukohtaisia
//   parametreja, ja paint täydentää karttakuvan tyyliä.
// Nimitaso:   { id, title, labels: "data/TIEDOSTO.geojson" }
//   pisteiden nimi (kenttä nimi) näytetään tekstinä kaiken muun päällä.

export const LAYERS = [
  // Nimi on kaupunginosan rakennusten keskellä, koska rajat ulottuvat usein merelle (build_data.py).
  { id: "kaupunginosat_nimet", title: "Kaupunginosien nimet", on: true, labels: "data/kaupunginosat_nimet.geojson" },
  {
    id: "maankaytto", title: "Asemakaavan käyttötarkoitukset", legend: "landuse",
    vector: [
      { type: "fill", paint: { "fill-color": landuseColor, "fill-opacity": 0.55 } },
      { type: "line", minzoom: 13, paint: { "line-color": "#5a4a3a", "line-width": 0.4, "line-opacity": 0.6 } },
    ],
  },
  {
    id: "kaavahankkeet", title: "Vireillä olevat kaavat",
    vector: [
      { type: "fill", paint: { "fill-color": "#ff006e", "fill-opacity": 0.18 } },
      { type: "line", paint: { "line-color": "#ff006e", "line-width": 2, "line-dasharray": [2, 1.5] } },
    ],
  },
  { id: "wms_ajantasa", title: "Ajantasa-asemakaava", wms: "Ajantasa_asemakaava_vektori" },
  { id: "wms_maankayttokartta", title: "Maankäyttökartta", wms: "Maankayttokartta" },
  // Espoon omista vesiaineistoista (WFS GIS:Vesialueet ja WMS Vesistot) puuttuu paloja
  // merialueesta, esim. Haukilahden lahdelta. HSY:n maanpeiteaineistossa meri ja sisävedet ovat
  // kokonaisina. HSY:n oletussininen vaalennetaan, ja reunojen pehmennys otetaan pois, jottei
  // karttaruutujen rajoille jää vaaleita saumoja.
  {
    id: "wms_vesialueet", title: "Vesialueet", on: true, service: "hsy",
    wms: "asuminen_ja_maankaytto:maanpeite_merialue_2024,asuminen_ja_maankaytto:maanpeite_vesi_2024",
    params: { FORMAT_OPTIONS: "antialias:none" },
    paint: { "raster-brightness-min": 0.3, "raster-saturation": -0.15 },
  },
  // Purot ja joet (streams.js, data/purot.json): uomat maaston pinnalla ja lähikuvassa alavirtaan
  // liikkuva virtaus. Virtaama mitataan Espoonjoesta; muiden uomien virtaama on arvio.
  { id: "purot", title: "Purot ja joet", streams: true, on: true, legend: "streams" },
  {
    id: "vaesto", title: "Asukkaat 250 m ruuduissa (3D)", legend: "population",
    vector: [{
      type: "fill-extrusion",
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["get", "asukkaita"],
          0, "#ffffcc", 200, "#a1dab4", 600, "#41b6c4", 1200, "#2c7fb8", 2500, "#253494"],
        "fill-extrusion-height": ["*", ["get", "asukkaita"], 0.2],
        "fill-extrusion-opacity": 0.85,
      },
    }],
  },
  {
    id: "autoliikenne", title: "Autoliikenne (ajon./vrk)", legend: "traffic",
    vector: [{
      type: "line",
      layout: { "line-cap": "round" },
      paint: {
        "line-color": ["interpolate", ["linear"], trafficVolume, 0, "#ffd166", 10000, "#f77f00", 30000, "#d62828", 70000, "#6a040f"],
        "line-width": ["interpolate", ["linear"], trafficVolume, 0, 1.5, 10000, 3, 30000, 6, 70000, 10],
      },
    }],
  },
  { id: "wms_melu_tie", title: "Tieliikenteen melu (Lden)", wms: "Espoo_tieliikenne Lden_EU (kadut ja maantiet)" },
  { id: "wms_melu_raide", title: "Raideliikenteen melu (Lden)", wms: "Espoo_rautatieliikenne Lden_EU (juna)" },
  { id: "wms_kiinteistot", title: "Kiinteistörajat", wms: "PKSkiinteistokartta" },
  { id: "wms_kantakartta", title: "Kantakartan maastotiedot", wms: "KantakartanMaastotiedot" },
  // Ilmatieteen laitoksen sadetutka: sateen voimakkuus (mm/h), päivittyy viiden minuutin välein.
  { id: "sadetutka", title: "Sadetutka", radar: "suomi_rr_eureffin", on: true, legend: "radar" },
];

// Sadetutkan selite: Ilmatieteen laitoksen värit sateen voimakkuuden (mm/h) mukaan.
export const RADAR_STOPS = [
  [0.1, "#7fdcef"], [0.3, "#3fa86a"], [0.9, "#c6dd55"], [2.2, "#f2e33a"],
  [4, "#f5a623"], [10, "#ef5a28"], [25, "#d0021b"], [50, "#6b0f3c"],
];

// Maamerkit, jotka näytetään omana 3D-mallinaan (landmarks.js), koska rakennusaineiston pohja ei
// kuvaa niiden muotoa. building on korvattavan rakennuksen tunnus, joka piilotetaan 3D-rakennuksista.
export const LANDMARKS = [
  {
    id: "haukilahden_vesitorni", name: "Haukilahden vesitorni", lon: 24.764875, lat: 60.161524, building: 1023766320,
    rows: [["Valmistunut", "1968"], ["Korkeus", "45,3 m (76,3 m merenpinnasta)"], ["Huipulla", "Ravintola Haikaranpesä"]],
  },
  {
    id: "otaniemen_vesitorni", name: "Otaniemen vesitorni", lon: 24.819906, lat: 60.181197, building: "101572394U",
    rows: [["Valmistunut", "1972"], ["Arkkitehti", "Alvar Aalto"], ["Korkeus", "52 m"], ["Vesisäiliöt", "6 000 m³"]],
  },
];

// Ponnahdusikkunan otsikot ja kenttien nimet tutuimmille tasoille.
export const POPUP_TITLES = {
  rakennukset: (p) => p.osoite || "Rakennus",
  maankaytto: (p) => `Käyttötarkoitus ${p.KAYTTOTARKOITUS ?? ""}`,
  kaavahankkeet: (p) => p.KaavanNimi || "Kaavahanke",
  vaesto: (p) => `${p.asukkaita} asukasta`,
  autoliikenne: (p) => p.Nimi || "Liikennemäärä",
};

export const FIELD_LABELS = {
  korkeus: "Korkeus (m)", raystas: "Räystäs (m)", kerrokset: "Kerroksia", vuosi: "Valmistunut", kaytto: "Käyttötarkoitus",
  asunnot: "Asuntoja", rakenne: "Kantava rakenne", tunnus: "Rakennustunnus", osoite: "Osoite",
  asukkaita: "Asukkaita", asumisvaljyys: "Asumisväljyys (m²/as.)",
  ika0_9: "0–9-vuotiaat", ika10_19: "10–19-vuotiaat", ika20_29: "20–29-vuotiaat", ika30_39: "30–39-vuotiaat",
  ika40_49: "40–49-vuotiaat", ika50_59: "50–59-vuotiaat", ika60_69: "60–69-vuotiaat", ika70_79: "70–79-vuotiaat",
  ika_yli80: "Yli 80-vuotiaat",
};

export const HIDDEN_FIELDS = new Set(["luokka", "arvio", "osa", "keski", "ClassId", "KARTTALAJI", "selvitys_id", "_Type", "ID", "VALUE"]);
