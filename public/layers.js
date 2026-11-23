// Karttatasojen määrittelyt. Vektoritasot tulevat paikallisista tiilistä
// (scripts/build_data.py), WMS-tasot suoraan Espoon tai HSY:n palvelimelta.

// Kaikki tässä käytetyt WMS-tasot on tarkistettu avoimiksi; osa Espoon tasoista
// (esim. maaperäkartta, yleiskaava, johtokartta) vaatii tunnukset eikä ole mukana.
export const WMS_SERVICES = {
  espoo: "https://kartat.espoo.fi/teklaogcweb/wms.ashx",
  hsy: "proxy/hsy/wms", // välityspalvelin (server.py tai julkaisualusta), koska HSY ei salli CORSia
  gtk: "https://gtkdata.gtk.fi/arcgis/services/Rajapinnat/GTK_Maapera_WMS/MapServer/WMSServer",
};
export const ESPOO_WMS = WMS_SERVICES.espoo;

export const ORTHO_YEARS = [
  [1950, "Ortokartta_1950"], [1969, "Ortokartta_1969"], [1976, "Ortokartta_1976"], [1996, "Ortokartta_1996"],
  [2001, "Ortokartta_2001"], [2005, "Ortokartta_2005"], [2007, "Ortokartta_2007"], [2009, "Ortokartta_2009"],
  [2011, "Ortokartta_2011"], [2013, "Ortokartta_2013"], [2015, "Ortokartta_2015"], [2017, "Ortokartta_2017"],
  [2019, "Ortokartta_2019"], [2021, "Ortokartta_2021"], [2023, "Ortokartta_2023"], [2024, "Ortokartta_2024"],
  [2026, "Ortokartta"],
];

export const BASEMAPS = {
  ortho: { title: "Ilmakuva" },
  opas: { title: "Opaskartta", wms: "Opaskartta" },
  harmaa: { title: "Harmaa kartta", wms: "PKS_Opaskartta_harmaa" },
  ei: { title: "Vain maasto" },
};

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
// Vektoritaso: { id, title, vector: [MapLibre-tasomäärittelyt ilman id:tä ja lähdettä] }
//   source-layer on oletuksena id; sourceLayer korvaa sen.
// WMS-taso:   { id, title, wms: "TASO1,TASO2", service: "espoo" | "hsy" }

export const GROUPS = [
  {
    title: "Kaavoitus",
    layers: [
      {
        id: "maankaytto", title: "Asemakaavan käyttötarkoitukset", legend: "landuse",
        vector: [
          { type: "fill", paint: { "fill-color": landuseColor, "fill-opacity": 0.55 } },
          { type: "line", minzoom: 13, paint: { "line-color": "#5a4a3a", "line-width": 0.4, "line-opacity": 0.6 } },
        ],
      },
      {
        id: "asemakaavat", title: "Asemakaava-alueiden rajat",
        vector: [{ type: "line", paint: { "line-color": "#7b2cbf", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 2] } }],
      },
      {
        id: "kaavahankkeet", title: "Vireillä olevat kaavat",
        vector: [
          { type: "fill", paint: { "fill-color": "#ff006e", "fill-opacity": 0.18 } },
          { type: "line", paint: { "line-color": "#ff006e", "line-width": 2, "line-dasharray": [2, 1.5] } },
        ],
      },
      { id: "wms_ajantasa", title: "Ajantasa-asemakaava (kartta)", wms: "Ajantasa_asemakaava_vektori" },
      { id: "wms_maankayttokartta", title: "Maankäyttökartta", wms: "Maankayttokartta" },
      { id: "wms_maanomistus", title: "Kaupungin maanomistus", wms: "Kaupungin_maanomistus" },
    ],
  },
  {
    title: "Vedet",
    layers: [
      {
        id: "vesialueet", title: "Vesialueet",
        vector: [{ type: "fill", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#2f80ed", "fill-opacity": 0.45 } }],
      },
      {
        id: "virtavedet", title: "Arvokkaat virtavedet",
        vector: [
          { type: "fill", paint: { "fill-color": "#00b4d8", "fill-opacity": 0.35 } },
          { type: "line", paint: { "line-color": "#0077b6", "line-width": 1.5 } },
        ],
      },
      { id: "norot", title: "Norot", vector: [{ type: "line", paint: { "line-color": "#00a6fb", "line-width": 2.5 } }] },
      {
        id: "lahteet", title: "Lähteet",
        vector: [{ type: "circle", paint: { "circle-color": "#00b4d8", "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }],
      },
      {
        id: "herkat_vesikohteet", title: "Herkät vesikohteet",
        vector: [{ type: "fill", paint: { "fill-color": "#48cae4", "fill-opacity": 0.3, "fill-outline-color": "#0096c7" } }],
      },
      {
        id: "pohjavesialueet", title: "Pohjavesialueet",
        vector: [
          { type: "fill", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#4361ee", "fill-opacity": 0.2 } },
          { type: "line", paint: { "line-color": "#3a0ca3", "line-width": 1.5, "line-dasharray": [3, 2] } },
        ],
      },
      {
        id: "rantaraitti", title: "Rantaraitti",
        vector: [{ type: "line", paint: { "line-color": "#f72585", "line-width": 2.5 } }],
      },
    ],
  },
  {
    title: "Maaperä ja energia",
    layers: [
      { id: "wms_maapera20k", title: "Maalajit 1:20 000", wms: "maapera_20k_pohjamaalajit", service: "gtk" },
      { id: "wms_maapera200k", title: "Maalajit 1:200 000", wms: "maapera_200k_maalajit", service: "gtk" },
      {
        id: "sulfaattimaat", title: "Happamat sulfaattimaat",
        vector: [{ type: "fill", paint: { "fill-color": "#bc6c25", "fill-opacity": 0.4, "fill-outline-color": "#7f4f24" } }],
      },
      { id: "wms_geoenergia", title: "Geoenergiapotentiaali", wms: "Geoenergiakartta" },
      { id: "wms_aurinko", title: "Kattojen aurinkosähköpotentiaali", wms: "ilmasto_ja_energia:aurinkosahko_pks", service: "hsy" },
    ],
  },
  {
    title: "Luonto",
    layers: [
      {
        id: "luonnonsuojelu", title: "Luonnonsuojelun kohteet",
        vector: [
          { type: "fill", paint: { "fill-color": "#2d6a4f", "fill-opacity": 0.3 } },
          { type: "line", paint: { "line-color": "#1b4332", "line-width": 1.5 } },
        ],
      },
      {
        id: "luontokohteet", title: "Arvokkaat luontokohteet",
        vector: [{ type: "fill", paint: { "fill-color": "#52b788", "fill-opacity": 0.45, "fill-outline-color": "#1b4332" } }],
      },
      {
        id: "metsaverkosto", title: "Ekologinen metsäverkosto",
        vector: [{ type: "fill", paint: { "fill-color": "#40916c", "fill-opacity": 0.3 } }],
      },
      {
        id: "lintualueet", title: "Tärkeät lintualueet", sourceLayer: ["lintualueet_valtak", "lintualueet_maak"],
        vector: [
          { type: "fill", paint: { "fill-color": "#ffb703", "fill-opacity": 0.2 } },
          { type: "line", paint: { "line-color": "#fb8500", "line-width": 1.5 } },
        ],
      },
      {
        id: "perinneymparistot", title: "Perinneympäristöt",
        vector: [{ type: "fill", paint: { "fill-color": "#d4a373", "fill-opacity": 0.5, "fill-outline-color": "#8a5a44" } }],
      },
      { id: "wms_arvorasteri", title: "Ekologisen verkoston arvot", wms: "Arvorasteri" },
      {
        id: "luonnonmuistomerkit", title: "Luonnonmuistomerkit",
        vector: [{ type: "circle", paint: { "circle-color": "#2b9348", "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }],
      },
      {
        id: "geologiset", title: "Geologiset kohteet",
        vector: [{ type: "circle", paint: { "circle-color": "#6c584c", "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }],
      },
      {
        id: "luontopolut", title: "Luontopolut",
        vector: [{ type: "line", paint: { "line-color": "#386641", "line-width": 2.5, "line-dasharray": [1.5, 1] } }],
      },
    ],
  },
  {
    title: "Väestö ja liikenne",
    layers: [
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
    ],
  },
  {
    title: "Maanpeite (HSY)",
    layers: [
      {
        id: "wms_maanpeite", title: "Maanpeite 2024", service: "hsy",
        wms: ["avokalliot", "merialue", "muu_avoin_matala_kasvillisuus", "muu_vetta_lapaisematon_pinta",
          "paallystamaton_tie", "paallystetty_tie", "paljas_maa", "pellot", "puusto_2_10m", "puusto_10_15m",
          "puusto_15_20m", "puusto_yli20m", "rakennus", "vesi"].map((k) => `asuminen_ja_maankaytto:maanpeite_${k}_2024`).join(","),
      },
      { id: "wms_hiilinielu", title: "Hiilinielut", wms: "ilmasto_ja_energia:hiilinieluselvitys_espoo", service: "hsy" },
    ],
  },
  {
    title: "Kiinteistöt ja kantakartta",
    layers: [
      { id: "wms_kiinteistot", title: "Kiinteistörajat", wms: "PKSkiinteistokartta" },
      { id: "wms_kantakartta", title: "Kantakartan maastotiedot", wms: "KantakartanMaastotiedot" },
    ],
  },
  {
    title: "Vanhat kartat",
    layers: [
      { id: "wms_kartta1958", title: "Espoon kartta 1958", wms: "Kartta_1958" },
      { id: "wms_opas1973", title: "Opaskartta 1973", wms: "Opaskartta_1973" },
      { id: "wms_opas1976", title: "Opaskartta 1976", wms: "Opaskartta_1976" },
    ],
  },
  {
    title: "Aluejaot",
    layers: [
      {
        id: "kaupunginosat", title: "Kaupunginosat", on: true,
        vector: [{ type: "line", paint: { "line-color": "#ffffff", "line-width": 1.6, "line-opacity": 0.85 } }],
        labels: true,
      },
      {
        id: "pienalueet", title: "Tilastolliset pienalueet",
        vector: [{ type: "line", paint: { "line-color": "#ffd60a", "line-width": 1.2, "line-dasharray": [2, 2] } }],
      },
      {
        id: "postinumerot", title: "Postinumeroalueet",
        vector: [{ type: "line", paint: { "line-color": "#fca311", "line-width": 1.2 } }],
      },
    ],
  },
];

// Ponnahdusikkunan otsikot ja kenttien nimet tutuimmille tasoille.
export const POPUP_TITLES = {
  rakennukset: (p) => p.osoite || "Rakennus",
  maankaytto: (p) => `Käyttötarkoitus ${p.KAYTTOTARKOITUS ?? ""}`,
  asemakaavat: (p) => p.KAAVANNIMI || "Asemakaava",
  kaavahankkeet: (p) => p.KaavanNimi || "Kaavahanke",
  kaupunginosat: (p) => p.KAUPUNGINOSANNIMI_FI,
  pienalueet: (p) => p.NIMI,
  postinumerot: (p) => p.Postinumero_fi,
  vaesto: (p) => `${p.asukkaita} asukasta`,
  autoliikenne: (p) => p.Nimi || "Liikennemäärä",
};

export const FIELD_LABELS = {
  korkeus: "Korkeus (m)", kerrokset: "Kerroksia", vuosi: "Valmistunut", kaytto: "Käyttötarkoitus",
  asunnot: "Asuntoja", rakenne: "Kantava rakenne", tunnus: "Rakennustunnus", osoite: "Osoite",
  asukkaita: "Asukkaita", asumisvaljyys: "Asumisväljyys (m²/as.)",
  ika0_9: "0–9-vuotiaat", ika10_19: "10–19-vuotiaat", ika20_29: "20–29-vuotiaat", ika30_39: "30–39-vuotiaat",
  ika40_49: "40–49-vuotiaat", ika50_59: "50–59-vuotiaat", ika60_69: "60–69-vuotiaat", ika70_79: "70–79-vuotiaat",
  ika_yli80: "Yli 80-vuotiaat",
};

export const HIDDEN_FIELDS = new Set(["luokka", "arvio", "ClassId", "KARTTALAJI", "selvitys_id", "_Type", "ID", "VALUE"]);
