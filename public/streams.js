// Purot ja joet: uomat virtaussuuntineen ja virtaus lähikuvassa.
//
// Uomat ja niiden yläpuolinen valuma-ala tulevat tiedostosta purot.json (scripts/build_data.py:
// OpenStreetMapin uomat ja Syken valuma-aluejako). Virtaamaa mitataan Espoossa vain Espoonjoesta
// (Syken hydrologiarajapinta, päiväarvo). Muiden uomien virtaama arvioidaan olettamalla, että
// neliökilometriltä valuu yhtä paljon vettä kuin Espoonjoen valuma-alueelta: Q = Q_asema · A / A_asema.
//
// Uomat tasoitetaan (mutkat pyöreiksi) ja piirretään maaston pintaan MapLibren viivatasona.
// Lähikuvassa uoman päällä on nauha, jossa alavirtaan kulkee valopulsseja (three.js, transit.js:n
// 3D-tasolla). Nauha seuraa uomaa, joten pulssit kaartuvat mutkien mukana. Nauhan geometria on
// kiinteä: pulssit lasketaan varjostimessa matkasta uomaa pitkin ja ajasta. Liike on nopeutettu ja
// mitoitettu näytön pikseleissä: mitä enemmän uomassa virtaa vettä, sitä nopeampia ja leveämpiä
// pulssit ovat, ja isossa uomassa pulssin keskikohta kulkee reunoja edellä kuten virtaus.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import { rawElevationAt } from "./bridges.js";

const HYDRO_API = "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata";
const DISCHARGE_POLL = 3600000; // ms: asemalta tulee päiväarvo, joten tunnin välein riittää
export const FLOW_MINZOOM = 13.5;
const FADE_ZOOM = 0.4; // virtaus tulee näkyviin tällä zoomausvälillä
const SMOOTH_ROUNDS = 2; // Chaikin-tasoitus: OSM:n uomissa pisteet ovat noin 10 metrin välein
const ELEV_BUDGET = 2500; // korkeuskyselyä piirtokertaa kohden
const ELEV_MAX_AGE = 3000; // ms: näkyvien pisteiden korkeus haetaan uudelleen, kun korkeusmalli tarkentuu
const UNKNOWN = -1e4; // korkeutta ei vielä tiedetä
// Nauha nostetaan maanpinnasta (px näytöllä), koska uoman pohja on korkeusmallissa usein
// maastomallin pintaa alempana ja peittäisi sen.
const LIFT_PX = 1.5;
const ATTR = 'Purot © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, '
  + 'valuma-alueet ja virtaama © <a href="https://www.syke.fi/avoindata" target="_blank" rel="noopener">Syke</a> (CC BY 4.0)';
const MONTHS = ["tammikuun", "helmikuun", "maaliskuun", "huhtikuun", "toukokuun", "kesäkuun", "heinäkuun", "elokuun",
  "syyskuun", "lokakuun", "marraskuun", "joulukuun"];

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const ORIGIN_LON = 24.7, ORIGIN_LAT = 60.2, M_LON = 55462, M_LAT = 111415; // paikalliset metrit kuten transit.js
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const ORIGIN_MX = mercX(ORIGIN_LON), ORIGIN_MY = mercY(ORIGIN_LAT);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Virtaaman (m³/s) suuruusluokka 0…1: 1 l/s → 0, 10 m³/s → 1. Siitä riippuvat pulssien nopeus
// (px/s) ja väli (px); nauhan leveys ja kirkkaus lasketaan varjostimessa samasta luvusta.
const sizeOf = (q) => clamp((Math.log10(Math.max(q, 1e-4)) + 3) / 4, 0, 1);
const STYLE = {
  speed: (t) => 10 + 34 * t,
  spacing: (t) => 80 - 30 * t,
};

const fmtNum = (v, digits) => v.toLocaleString("fi-FI", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function formatFlow(q) {
  if (q >= 10) return `${fmtNum(q, 0)} m³/s`;
  if (q >= 1) return `${fmtNum(q, 1)} m³/s`;
  if (q >= 0.1) return `${fmtNum(q, 2)} m³/s`;
  return `${fmtNum(Math.max(q * 1000, 0.1), q * 1000 >= 10 ? 0 : 1)} l/s`;
}

// Chaikinin kulmanleikkaus: kierros korvaa kunkin välipisteen kahdella pisteellä viereisten
// osien 1/4- ja 3/4-kohdissa, joten mutkat pyöristyvät. Päätepisteet pysyvät paikallaan.
function chaikin(pts, rounds) {
  for (let r = 0; r < rounds && pts.length > 2; r++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      if (i > 0) out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by]);
      if (i < pts.length - 2) out.push([0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function prepareChains(data) {
  return data.uomat.map((u) => {
    // Osuudet tasoitetaan erikseen, jotta niiden rajat (yhtymäkohdat) pysyvät paikallaan.
    const ll = [], pieces = [];
    u.o.forEach(([start, area, culvert, name], k) => {
      const end = k + 1 < u.o.length ? u.o[k + 1][0] : u.p.length / 2 - 1;
      const raw = [];
      for (let i = start; i <= end; i++) raw.push([u.p[2 * i], u.p[2 * i + 1]]);
      const smooth = chaikin(raw, SMOOTH_ROUNDS);
      pieces.push({ start: Math.max(ll.length - 1, 0), area, culvert: !!culvert, name, q: 0, t: 0 });
      ll.push(...(ll.length ? smooth.slice(1) : smooth));
    });
    const n = ll.length;
    const lonlat = new Float64Array(2 * n), mx = new Float64Array(n), my = new Float64Array(n);
    const lx = new Float32Array(n), ly = new Float32Array(n), s = new Float64Array(n), pieceOf = new Int32Array(n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const [lon, lat] = ll[i];
      lonlat[2 * i] = lon;
      lonlat[2 * i + 1] = lat;
      mx[i] = mercX(lon);
      my[i] = mercY(lat);
      lx[i] = (lon - ORIGIN_LON) * M_LON;
      ly[i] = (lat - ORIGIN_LAT) * M_LAT;
      if (i) s[i] = s[i - 1] + Math.hypot(lx[i] - lx[i - 1], ly[i] - ly[i - 1]);
      minX = Math.min(minX, lx[i]); maxX = Math.max(maxX, lx[i]);
      minY = Math.min(minY, ly[i]); maxY = Math.max(maxY, ly[i]);
    }
    pieces.forEach((p, k) => pieceOf.fill(k, p.start, k + 1 < pieces.length ? pieces[k + 1].start : n));
    return {
      lonlat, mx, my, lx, ly, s, pieceOf, pieces, minX, minY, maxX, maxY,
      elev: new Float32Array(n).fill(UNKNOWN), elevAt: new Float64Array(n), v0: 0, phase: Math.random(), tMain: 0,
    };
  });
}

// Viivataso: yksi kohde uoman osuutta kohden. w = uoman koko 0…1 valuma-alan mukaan (viivan leveys).
function lineFeatures(chains) {
  const features = [];
  chains.forEach((ch, ci) => ch.pieces.forEach((p, k) => {
    const end = k + 1 < ch.pieces.length ? ch.pieces[k + 1].start : ch.s.length - 1;
    const coords = [];
    for (let i = p.start; i <= end; i++) coords.push([ch.lonlat[2 * i], ch.lonlat[2 * i + 1]]);
    features.push({
      type: "Feature", geometry: { type: "LineString", coordinates: coords },
      properties: { uoma: ci, osa: k, nimi: p.name, ala: p.area, rumpu: p.culvert ? 1 : 0, w: clamp((Math.log10(p.area) + 1) / 3.3, 0, 1) },
    });
  }));
  return { type: "FeatureCollection", features };
}

function lineLayer(visible) {
  const culvert = ["==", ["get", "rumpu"], 1];
  const byW = (a, b) => ["interpolate", ["linear"], ["get", "w"], 0, a, 1, b];
  // Kaukaa näytetään vain isommat uomat; rummussa kulkeva osuus on haalea. Lähikuvassa viiva
  // ohenee, jottei se peitä virtausta.
  const opacity = (big, small) => ["*", ["case", culvert, 0.45, 1], ["case", [">=", ["get", "ala"], 5], big, small]];
  return {
    id: "purot", type: "line", source: "purot", minzoom: 11,
    layout: { "line-cap": "round", "line-join": "round", visibility: visible ? "visible" : "none" },
    paint: {
      "line-color": ["case", culvert, "#8bb8d0", "#3a9ad9"],
      "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, byW(0.4, 1.8), 14, byW(0.8, 3.2), 17, byW(1.2, 6)],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, opacity(0.8, 0), 12.5, opacity(0.85, 0.3), 14, opacity(0.85, 0.75),
        16, opacity(0.65, 0.6)],
    },
  };
}

const RIBBON_VERTEX = `
  attribute vec2 aNormal;
  attribute vec2 aDuPhase;
  attribute float aSide, aElev, aU, aT, aInvCos, aHide;
  uniform vec2 uShift;
  uniform float uInvSc, uCenterElev, uCosC, uMpp, uLift;
  varying float vU, vSide, vT, vVis;
  varying vec2 vDuPhase;
  void main() {
    // Leveys pikseleinä: sama näytöllä zoomista riippumatta. Mutkien kohdalla aNormal on pidennetty.
    float width = 2.0 + 4.5 * aT;
    vec2 xy = vec2(position.x + uShift.x, -(position.y + uShift.y)) * uInvSc + aNormal * aSide * width * 0.5 * uMpp;
    bool known = aElev > ${UNKNOWN / 2}.0;
    float z = ((known ? aElev : uCenterElev) - uCenterElev) * uCosC * aInvCos + uLift;
    vU = aU;
    vSide = aSide;
    vT = aT;
    vDuPhase = aDuPhase;
    vVis = known ? 1.0 - aHide : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, z, 1.0);
  }`;

const RIBBON_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uTime, uOpacity;
  varying float vU, vSide, vT, vVis;
  varying vec2 vDuPhase;
  void main() {
    // f = pulssin kärjen ohituksesta kulunut osa pulssien välistä (0 = kärki, häntä ylävirtaan).
    // Leveässä uomassa reunat jäävät keskeltä jälkeen kuten virtauksessa.
    float du = vDuPhase.x;
    float f = fract((uTime + vDuPhase.y * du - vU) / du - abs(vSide) * (0.04 + 0.16 * vT));
    float pulse = max(pow(max(1.0 - f / 0.5, 0.0), 1.6), clamp((f - 0.93) / 0.07, 0.0, 1.0));
    float edge = 1.0 - smoothstep(0.45, 1.0, abs(vSide));
    float a = pulse * edge * vVis * uOpacity * (0.6 + 0.35 * vT);
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`;

// Nauha: kaksi kärkeä kutakin uoman pistettä kohden (aSide −1 ja +1), kolmiot pisteparien välissä.
// Paikat ovat Web Mercator -yksiköitä suhteessa paikallisen koordinaatiston origoon, joten
// kartan siirtyessä riittää muuttaa varjostimen siirtoa ja mittakaavaa.
function ribbonMesh(chains) {
  const N = chains.reduce((sum, ch) => sum + ch.s.length, 0), V = 2 * N;
  const pos = new Float32Array(3 * V), nor = new Float32Array(2 * V), side = new Float32Array(V);
  const invCos = new Float32Array(V), hide = new Float32Array(V);
  const index = new Uint32Array(6 * chains.reduce((sum, ch) => sum + ch.s.length - 1, 0));
  let v = 0, o = 0;
  for (const ch of chains) {
    ch.v0 = v;
    const n = ch.s.length;
    for (let i = 0; i < n; i++) {
      // Normaali molempien viereisten osien suuntien keskiarvona; mutkassa pidennetään (enintään 2×).
      const seg = (a, b) => {
        const dx = ch.mx[b] - ch.mx[a], dy = -(ch.my[b] - ch.my[a]), d = Math.hypot(dx, dy) || 1;
        return [-dy / d, dx / d];
      };
      const n1 = seg(Math.max(i - 1, 0), Math.max(i, 1)), n2 = seg(Math.min(i, n - 2), Math.min(i + 1, n - 1));
      let nx = n1[0] + n2[0], ny = n1[1] + n2[1];
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) { [nx, ny] = n1; } else { nx /= len; ny /= len; }
      const miter = 1 / Math.max(nx * n1[0] + ny * n1[1], 0.5);
      const culvert = ch.pieces[ch.pieceOf[Math.min(i, n - 2)]].culvert ? 1 : 0;
      for (let k = 0; k < 2; k++) {
        const j = 2 * (v + i) + k;
        pos[3 * j] = ch.mx[i] - ORIGIN_MX;
        pos[3 * j + 1] = ch.my[i] - ORIGIN_MY;
        nor[2 * j] = nx * miter;
        nor[2 * j + 1] = ny * miter;
        side[j] = k ? 1 : -1;
        invCos[j] = 1 / Math.cos(ch.lonlat[2 * i + 1] * D2R);
        hide[j] = culvert;
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = 2 * (v + i);
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], o);
      o += 6;
    }
    v += n;
  }
  const g = new THREE.BufferGeometry();
  const attr = (array, size, dynamic) => {
    const at = new THREE.BufferAttribute(array, size);
    if (dynamic) at.setUsage(THREE.DynamicDrawUsage);
    return at;
  };
  g.setAttribute("position", attr(pos, 3));
  g.setAttribute("aNormal", attr(nor, 2));
  g.setAttribute("aSide", attr(side, 1));
  g.setAttribute("aInvCos", attr(invCos, 1));
  g.setAttribute("aHide", attr(hide, 1));
  g.setAttribute("aElev", attr(new Float32Array(V).fill(UNKNOWN), 1, true));
  g.setAttribute("aU", attr(new Float32Array(V), 1, true));
  g.setAttribute("aT", attr(new Float32Array(V), 1, true));
  g.setAttribute("aDuPhase", attr(new Float32Array(2 * V), 2, true));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color("#f2fdff") }, uTime: { value: 0 }, uOpacity: { value: 1 },
      uShift: { value: new THREE.Vector2() }, uInvSc: { value: 1 }, uCenterElev: { value: 0 }, uCosC: { value: 0.5 },
      uMpp: { value: 1 }, uLift: { value: 0 },
    },
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT,
    // Molemmat puolet: Mercator-muunnoksen peilaus kääntää kolmioiden kiertosuunnan.
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    // Uoman pohja on usein maastomallin pintaa alempana; siirretään syvyyttä kameraa kohti.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
  const mesh = new THREE.Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

// Absoluuttinen maanpinnan korkeus (maaston korostus mukana). Sillan kohdalla korkeusmalli on
// nostettu kannen tasolle (bridges.js), mutta uoma kulkee sillan alla alkuperäisellä pinnalla.
function groundAbs(map, lon, lat, centerElev, exag) {
  const raw = rawElevationAt(lon, lat);
  if (raw != null) return raw * exag;
  const q = map.queryTerrainElevation([lon, lat]);
  return q == null ? UNKNOWN : q + centerElev;
}

export async function createStreams(map, { url, visible = true, beforeLayer }) {
  const data = await fetch(url).then((r) => r.json());
  const station = data.asema;
  const chains = prepareChains(data);
  map.addSource("purot", { type: "geojson", data: lineFeatures(chains), attribution: ATTR });
  map.addLayer(lineLayer(visible), map.getLayer(beforeLayer) ? beforeLayer : undefined);

  // Mittausaseman kohdalla oleva osuus: siinä virtaama on mitattu, muualla arvioitu.
  const [sx, sy] = [(station.lon - ORIGIN_LON) * M_LON, (station.lat - ORIGIN_LAT) * M_LAT];
  let measuredAt = null, bestD = 200;
  chains.forEach((ch, ci) => {
    for (let i = 0; i < ch.s.length; i++) {
      const d = Math.hypot(ch.lx[i] - sx, ch.ly[i] - sy), k = ch.pieceOf[i];
      if (d < bestD || (d < 200 && measuredAt && ch.pieces[k].area > chains[measuredAt[0]].pieces[measuredAt[1]].area * 1.5)) {
        bestD = d;
        measuredAt = [ci, k];
      }
    }
  });

  const mesh = ribbonMesh(chains);
  const geom = mesh.geometry, uniforms = mesh.material.uniforms;
  let reading = null; // { q, date } asemalta
  let flowQ = null, flowVersion = 0;
  const listeners = [];
  const monthMedian = (date) => station.kuukaudet[date.getMonth()][0];

  // Virtaama osuuksille, nauhan leveys (aT) ja pulssien väli ketjulla (aDuPhase).
  function setFlow(q) {
    flowQ = q;
    flowVersion++;
    const tArr = geom.getAttribute("aT").array, dp = geom.getAttribute("aDuPhase").array;
    for (const ch of chains) {
      let wsum = 0, lsum = 0;
      ch.pieces.forEach((p, k) => {
        p.q = (q * p.area) / station.ala;
        p.t = sizeOf(p.q);
        const end = k + 1 < ch.pieces.length ? ch.pieces[k + 1].start : ch.s.length - 1;
        const len = ch.s[end] - ch.s[p.start];
        wsum += p.t * len;
        lsum += len;
      });
      ch.tMain = lsum ? wsum / lsum : 0;
      const du = STYLE.spacing(ch.tMain) / STYLE.speed(ch.tMain);
      for (let i = 0; i < ch.s.length; i++) {
        const t = ch.pieces[ch.pieceOf[i]].t;
        for (let k = 0; k < 2; k++) {
          const j = 2 * (ch.v0 + i) + k;
          tArr[j] = t;
          dp[2 * j] = du;
          dp[2 * j + 1] = ch.phase;
        }
      }
    }
    geom.getAttribute("aT").needsUpdate = true;
    geom.getAttribute("aDuPhase").needsUpdate = true;
    for (const fn of listeners) fn();
  }

  async function fetchDischarge() {
    try {
      const query = `$filter=${encodeURIComponent(`Paikka_Id eq ${station.id}`)}&$orderby=${encodeURIComponent("Aika desc")}&$top=1`;
      // JSON tulee vain Accept-otsakkeella; otsake ei vaadi CORS-esikyselyä.
      const res = await fetch(`${HYDRO_API}/Virtaama?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
      const row = (await res.json()).value?.[0];
      if (row?.Arvo == null) throw new Error("Virtaama puuttuu");
      reading = { q: +row.Arvo, date: new Date(row.Aika) };
      setFlow(reading.q);
    } catch (err) {
      console.warn("Espoonjoen virtaamaa ei saatu", err);
      if (flowQ == null) setFlow(monthMedian(new Date())); // tavanomainen virtaama, kunnes mittaus saadaan
    }
  }
  fetchDischarge();
  setInterval(fetchDischarge, DISCHARGE_POLL);

  let shown = visible, timedBand = null, timedFlow = -1;

  // Matka-aika (s) ketjun alusta kuhunkin pisteeseen pulssien nopeudella. Pulssit ovat ketjulla
  // tasavälein matka-ajassa, joten ne kulkevat osuuksien rajojen yli ilman hyppäyksiä. Nopeus
  // mitoitetaan kokonaislukuzoomin mukaan, jotta pulssit eivät liu'u zoomattaessa.
  function retime(mpp) {
    const uArr = geom.getAttribute("aU").array;
    for (const ch of chains) {
      let u = 0;
      for (let i = 0; i < ch.s.length; i++) {
        if (i) u += (ch.s[i] - ch.s[i - 1]) / (STYLE.speed(ch.pieces[ch.pieceOf[i - 1]].t) * mpp);
        uArr[2 * (ch.v0 + i)] = uArr[2 * (ch.v0 + i) + 1] = u;
      }
    }
    geom.getAttribute("aU").needsUpdate = true;
  }

  // Korkeudet haetaan näkyvän alueen pisteille vähitellen ja tallennetaan absoluuttisina.
  function updateElevations(x0, y0, x1, y1, ctx, now) {
    const { centerElev, exag } = ctx, attr = geom.getAttribute("aElev"), arr = attr.array;
    let budget = ELEV_BUDGET, dirty = false;
    attr.clearUpdateRanges();
    for (const ch of chains) {
      if (budget <= 0) break;
      if (ch.maxX < x0 || ch.minX > x1 || ch.maxY < y0 || ch.minY > y1) continue;
      let lo = Infinity, hi = -1;
      for (let i = 0; i < ch.s.length && budget > 0; i++) {
        if (ch.lx[i] < x0 || ch.lx[i] > x1 || ch.ly[i] < y0 || ch.ly[i] > y1) continue;
        if (ch.elev[i] !== UNKNOWN && now - ch.elevAt[i] < ELEV_MAX_AGE) continue;
        const e = groundAbs(map, ch.lonlat[2 * i], ch.lonlat[2 * i + 1], centerElev, exag);
        ch.elev[i] = e;
        ch.elevAt[i] = now + Math.random() * 500;
        arr[2 * (ch.v0 + i)] = arr[2 * (ch.v0 + i) + 1] = e;
        lo = Math.min(lo, i);
        hi = i;
        budget--;
      }
      if (hi >= 0) {
        attr.addUpdateRange(2 * (ch.v0 + lo), 2 * (hi - lo + 1));
        dirty = true;
      }
    }
    if (dirty) attr.needsUpdate = true;
  }

  function draw(map, ctx) {
    const { zoom, cmx, cmy, sc, cosC, centerElev, now } = ctx;
    mesh.visible = shown && flowQ != null && zoom >= FLOW_MINZOOM - FADE_ZOOM;
    if (!mesh.visible) return;
    const c = map.getCenter(), cosLat = Math.cos(c.lat * D2R);
    const mpp = (EARTH_CIRC * cosLat) / (512 * 2 ** zoom); // m/px nyt (leveys)
    const band = Math.round(zoom);
    if (band !== timedBand || flowVersion !== timedFlow) {
      retime((EARTH_CIRC * cosLat) / (512 * 2 ** band));
      timedBand = band;
      timedFlow = flowVersion;
    }
    // Viistosti katsottaessa näkymä ulottuu kauas; korkeudet haetaan vain lähialueelta.
    const R = 1.6 * Math.max(ctx.W, ctx.H) * mpp;
    const cx = (c.lng - ORIGIN_LON) * M_LON, cy = (c.lat - ORIGIN_LAT) * M_LAT;
    updateElevations(cx - R, cy - R, cx + R, cy + R, ctx, now);
    uniforms.uShift.value.set(ORIGIN_MX - cmx, ORIGIN_MY - cmy);
    uniforms.uInvSc.value = 1 / sc;
    uniforms.uCenterElev.value = centerElev;
    uniforms.uCosC.value = cosC;
    uniforms.uMpp.value = mpp;
    uniforms.uLift.value = LIFT_PX * mpp;
    uniforms.uTime.value = now / 1000;
    uniforms.uOpacity.value = clamp((zoom - (FLOW_MINZOOM - FADE_ZOOM)) / FADE_ZOOM, 0, 1);
  }

  function popupContent(props) {
    const ch = chains[props.uoma], p = ch?.pieces[props.osa];
    if (!p) return null;
    const measured = reading && measuredAt && measuredAt[0] === props.uoma && measuredAt[1] === props.osa;
    const day = reading ? reading.date.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" }) : null;
    const flow = flowQ == null ? "–" : measured ? `${formatFlow(reading.q)} (mitattu ${day})` : `noin ${formatFlow(p.q)} (arvio)`;
    const rows = [
      ["Virtaama", flow],
      ["Valuma-ala", `${fmtNum(p.area, p.area < 10 ? 1 : 0)} km²`],
      p.culvert ? ["Uoma", "rummussa"] : null,
    ].filter(Boolean);
    const note = measured ? "Syken mittausasema Espoonjoki."
      : `Arvio: Espoonjoen mitattu virtaama valuma-alan suhteessa (${fmtNum(station.ala, 0)} km² asemalla).`;
    const node = (tag, attrs, ...children) => {
      const el = document.createElement(tag);
      for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, val);
      el.append(...children);
      return el;
    };
    return node("div", { class: "pop" },
      node("div", { class: "kind" }, "Puro tai joki"),
      node("h3", {}, p.name || "Nimetön uoma"),
      node("table", {}, ...rows.map(([key, val]) => node("tr", {}, node("th", {}, key), node("td", {}, val)))),
      node("p", { class: "more" }, note));
  }

  // Selite: Espoonjoen virtaama nyt verrattuna saman kuukauden mediaaniin.
  function legendText() {
    const tail = " Muiden uomien virtaama on arvio valuma-alan mukaan. Lähikuvassa virtaus liikkuu alavirtaan nopeutettuna.";
    if (flowQ == null) return "Haetaan Espoonjoen virtaamaa…";
    if (!reading) return `Virtaamaa ei juuri nyt saatu; uomissa näytetään tavanomainen ${MONTHS[new Date().getMonth()]} virtaama.${tail}`;
    const median = monthMedian(reading.date), ratio = reading.q / median, month = MONTHS[reading.date.getMonth()];
    const day = reading.date.toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" });
    const compare = ratio >= 1.15 ? `${fmtNum(ratio, 1)}-kertainen ${month} mediaaniin (${formatFlow(median)}) nähden`
      : ratio <= 0.87 ? `${Math.round(ratio * 100)} % ${month} mediaanista (${formatFlow(median)})`
        : `tavanomainen (${month} mediaani ${formatFlow(median)})`;
    return `Espoonjoki ${day}: ${formatFlow(reading.q)}, ${compare}.${tail}`;
  }

  return {
    drawable: { object: mesh, draw, animating: () => shown && flowQ != null && map.getZoom() >= FLOW_MINZOOM - FADE_ZOOM },
    setVisible(on) {
      shown = on;
      if (map.getLayer("purot")) map.setLayoutProperty("purot", "visibility", on ? "visible" : "none");
      map.triggerRepaint();
    },
    popupContent,
    legendText,
    onUpdate(fn) { listeners.push(fn); },
    chains, station, // selaimen konsolia varten
  };
}
