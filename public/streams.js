// Purot ja joet: uomat virtaussuuntineen ja virtaus lähikuvassa.
//
// Uomat ja niiden yläpuolinen valuma-ala tulevat tiedostosta purot.json (scripts/build_data.py:
// OpenStreetMapin uomat ja Syken valuma-aluejako). Virtaamaa mitataan Espoossa vain Espoonjoesta
// (Syken hydrologiarajapinta, päiväarvo). Muiden uomien virtaama arvioidaan olettamalla, että
// neliökilometriltä valuu yhtä paljon vettä kuin Espoonjoen valuma-alueelta: Q = Q_asema · A / A_asema.
//
// Uomat piirretään maaston pintaan MapLibren viivatasona. Lähikuvassa niissä liikkuu alavirtaan
// virtaviivoja (three.js, transit.js:n 3D-tasolla). Liike on nopeutettu ja mitoitettu näytön
// pikseleissä: mitä enemmän uomassa virtaa vettä, sitä nopeampia, pidempiä ja tiheämpiä viivat ovat.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";
import { rawElevationAt } from "./bridges.js";

const HYDRO_API = "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata";
const DISCHARGE_POLL = 3600000; // ms: asemalta tulee päiväarvo, joten tunnin välein riittää
export const FLOW_MINZOOM = 13.5;
const FADE_ZOOM = 0.4; // virtaviivat tulevat näkyviin tällä zoomausvälillä
const STREAK_CAP = 8000;
const ELEV_BUDGET = 1500; // korkeuskyselyä piirtokertaa kohden
const ELEV_MAX_AGE = 3000; // ms: näkyvien pisteiden korkeus haetaan uudelleen, kun korkeusmalli tarkentuu
// Virtaviivat nostetaan maanpinnasta (px näytöllä), koska uoman pohja on korkeusmallissa usein
// maastomallin pintaa alempana ja peittäisi ne.
const LIFT_PX = 1.5;
const ATTR = 'Purot © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, '
  + 'valuma-alueet ja virtaama © <a href="https://www.syke.fi/avoindata" target="_blank" rel="noopener">Syke</a> (CC BY 4.0)';
const MONTHS = ["tammikuun", "helmikuun", "maaliskuun", "huhtikuun", "toukokuun", "kesäkuun", "heinäkuun", "elokuun",
  "syyskuun", "lokakuun", "marraskuun", "joulukuun"];

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const ORIGIN_LON = 24.7, ORIGIN_LAT = 60.2, M_LON = 55462, M_LAT = 111415; // paikalliset metrit kuten transit.js
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Virtaaman (m³/s) suuruusluokka 0…1: 1 l/s → 0, 10 m³/s → 1. Siitä riippuvat virtaviivojen
// nopeus (px/s), väli (px), pituus ja leveys (px) sekä rinnakkaisten jonojen määrä.
const sizeOf = (q) => clamp((Math.log10(Math.max(q, 1e-4)) + 3) / 4, 0, 1);
const STYLE = {
  speed: (t) => 10 + 34 * t,
  spacing: (t) => 72 - 36 * t,
  length: (t) => 11 + 19 * t,
  width: (t) => 1.6 + 3 * t,
  lanes: (t) => (t > 0.78 ? 3 : t > 0.55 ? 2 : 1),
  alpha: (t) => 0.55 + 0.4 * t,
};
const MAX_LANES = 3;
// Uoman leveys (m) virtaamasta (hydraulinen geometria, karkea): rinnakkaiset jonot sen sisälle.
const channelWidth = (q) => 3.5 * Math.sqrt(q);

const fmtNum = (v, digits) => v.toLocaleString("fi-FI", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export function formatFlow(q) {
  if (q >= 10) return `${fmtNum(q, 0)} m³/s`;
  if (q >= 1) return `${fmtNum(q, 1)} m³/s`;
  if (q >= 0.1) return `${fmtNum(q, 2)} m³/s`;
  return `${fmtNum(Math.max(q * 1000, 0.1), q * 1000 >= 10 ? 0 : 1)} l/s`;
}

function prepareChains(data) {
  return data.uomat.map((u) => {
    const n = u.p.length / 2;
    const mx = new Float64Array(n), my = new Float64Array(n), lx = new Float32Array(n), ly = new Float32Array(n);
    const s = new Float64Array(n), pieceOf = new Int32Array(n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const lon = u.p[2 * i], lat = u.p[2 * i + 1];
      mx[i] = mercX(lon);
      my[i] = mercY(lat);
      lx[i] = (lon - ORIGIN_LON) * M_LON;
      ly[i] = (lat - ORIGIN_LAT) * M_LAT;
      if (i) s[i] = s[i - 1] + Math.hypot(lx[i] - lx[i - 1], ly[i] - ly[i - 1]);
      minX = Math.min(minX, lx[i]); maxX = Math.max(maxX, lx[i]);
      minY = Math.min(minY, ly[i]); maxY = Math.max(maxY, ly[i]);
    }
    const pieces = u.o.map(([start, area, culvert, name]) => ({ start, area, culvert: !!culvert, name, q: 0, t: 0 }));
    pieces.forEach((p, k) => pieceOf.fill(k, p.start, k + 1 < pieces.length ? pieces[k + 1].start : n));
    return {
      lonlat: u.p, mx, my, lx, ly, s, pieceOf, pieces, minX, minY, maxX, maxY,
      elev: new Float32Array(n).fill(NaN), elevAt: new Float64Array(n), u: new Float64Array(n), du: 1,
      phase: Math.random(),
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
  // Kaukaa näytetään vain isommat uomat; rummussa kulkeva osuus on haalea.
  const opacity = (big, small) => ["*", ["case", culvert, 0.45, 1], ["case", [">=", ["get", "ala"], 5], big, small]];
  return {
    id: "purot", type: "line", source: "purot", minzoom: 11,
    layout: { "line-cap": "round", "line-join": "round", visibility: visible ? "visible" : "none" },
    paint: {
      "line-color": ["case", culvert, "#8bb8d0", "#3a9ad9"],
      "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, byW(0.4, 1.8), 14, byW(0.8, 4), 17, byW(1.6, 11)],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, opacity(0.8, 0), 12.5, opacity(0.85, 0.3), 14, opacity(0.85, 0.75)],
    },
  };
}

function streakMesh() {
  const geometry = new THREE.PlaneGeometry(1, 1); // x pitkin virtaa (kärki +x), y poikittain
  geometry.setAttribute("aAlpha", new THREE.InstancedBufferAttribute(new Float32Array(STREAK_CAP), 1).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color("#effcff") }, uOpacity: { value: 1 } },
    vertexShader: `
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        // Häntä häipyy ylävirtaan, kärki ja reunat pehmenevät.
        float a = smoothstep(0.0, 0.8, vUv.x) * (1.0 - smoothstep(0.86, 1.0, vUv.x))
          * (1.0 - smoothstep(0.2, 0.5, abs(vUv.y - 0.5))) * vAlpha * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
    // Molemmat puolet: Mercator-muunnoksen peilaus kääntää kolmioiden kiertosuunnan.
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    // Uoman pohja on usein maastomallin pintaa alempana; siirretään syvyyttä kameraa kohti.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, STREAK_CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.count = 0;
  return mesh;
}

// Absoluuttinen maanpinnan korkeus (maaston korostus mukana). Sillan kohdalla korkeusmalli on
// nostettu kannen tasolle (bridges.js), mutta uoma kulkee sillan alla alkuperäisellä pinnalla.
function groundAbs(map, lon, lat, centerElev, exag) {
  const raw = rawElevationAt(lon, lat);
  if (raw != null) return raw * exag;
  const q = map.queryTerrainElevation([lon, lat]);
  return q == null ? NaN : q + centerElev;
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

  let reading = null; // { q, date } asemalta
  let flowQ = null, flowVersion = 0;
  const listeners = [];
  const monthMedian = (date) => station.kuukaudet[date.getMonth()][0];

  function setFlow(q) {
    flowQ = q;
    flowVersion++;
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
    }
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

  const mesh = streakMesh();
  const alphaAttr = mesh.geometry.getAttribute("aAlpha");
  let shown = visible, timedBand = null, timedFlow = -1;

  // Matka-aika (s) ketjun alusta kuhunkin pisteeseen virtaviivojen nopeudella. Virtaviivat ovat
  // ketjulla tasavälein matka-ajassa, joten ne kulkevat osuuksien rajojen yli ilman hyppäyksiä.
  // Nopeus mitoitetaan kokonaislukuzoomin mukaan, jotta viivat eivät liu'u zoomattaessa.
  function retime(mpp) {
    for (const ch of chains) {
      const n = ch.s.length;
      for (let i = 1; i < n; i++) {
        const t = ch.pieces[ch.pieceOf[i - 1]].t;
        ch.u[i] = ch.u[i - 1] + (ch.s[i] - ch.s[i - 1]) / (STYLE.speed(t) * mpp);
      }
      ch.du = STYLE.spacing(ch.tMain) / STYLE.speed(ch.tMain);
    }
  }

  function updateElevations(ch, x0, y0, x1, y1, budget, ctx, now) {
    const { centerElev, exag } = ctx;
    for (let i = 0; i < ch.s.length && budget > 0; i++) {
      if (ch.lx[i] < x0 || ch.lx[i] > x1 || ch.ly[i] < y0 || ch.ly[i] > y1) continue;
      if (!Number.isNaN(ch.elev[i]) && now - ch.elevAt[i] < ELEV_MAX_AGE) continue;
      ch.elev[i] = groundAbs(map, ch.lonlat[2 * i], ch.lonlat[2 * i + 1], centerElev, exag);
      ch.elevAt[i] = now + Math.random() * 500;
      budget--;
    }
    return budget;
  }

  function draw(map, ctx) {
    const { zoom, cmx, cmy, sc, cosC, centerElev, now } = ctx;
    mesh.count = 0;
    mesh.visible = shown && flowQ != null && zoom >= FLOW_MINZOOM - FADE_ZOOM;
    if (!mesh.visible) return;
    mesh.material.uniforms.uOpacity.value = clamp((zoom - (FLOW_MINZOOM - FADE_ZOOM)) / FADE_ZOOM, 0, 1);
    const c = map.getCenter(), cosLat = Math.cos(c.lat * D2R);
    const mpp = (EARTH_CIRC * cosLat) / (512 * 2 ** zoom); // m/px nyt (koot)
    const band = Math.round(zoom);
    if (band !== timedBand || flowVersion !== timedFlow) {
      retime((EARTH_CIRC * cosLat) / (512 * 2 ** band));
      timedBand = band;
      timedFlow = flowVersion;
    }
    // Viistosti katsottaessa näkymä ulottuu kauas; kaukaiset viivat olisivat alle pikselin kokoisia.
    const R = 1.6 * Math.max(ctx.W, ctx.H) * mpp;
    const cx = (c.lng - ORIGIN_LON) * M_LON, cy = (c.lat - ORIGIN_LAT) * M_LAT;
    const x0 = cx - R, x1 = cx + R, y0 = cy - R, y1 = cy + R;
    const time = now / 1000, a = mesh.instanceMatrix.array, alpha = alphaAttr.array;
    let budget = ELEV_BUDGET, count = 0;
    for (const ch of chains) {
      if (ch.maxX < x0 || ch.minX > x1 || ch.maxY < y0 || ch.minY > y1) continue;
      budget = updateElevations(ch, x0, y0, x1, y1, budget, ctx, now);
      const n = ch.s.length, U = ch.u[n - 1], du = ch.du;
      if (!(U > 0)) continue;
      for (let lane = 0; lane < MAX_LANES; lane++) {
        let j = 0;
        // Jonot vuorottelevat matka-ajassa, jotta rinnakkaiset viivat eivät kulje samassa rivissä.
        for (let u = (time + (ch.phase + lane / MAX_LANES) * du) % du; u < U && count < STREAK_CAP; u += du) {
          while (j < n - 2 && ch.u[j + 1] < u) j++;
          const p = ch.pieces[ch.pieceOf[j]], lanes = STYLE.lanes(p.t);
          if (p.culvert || lane >= lanes) continue;
          const f = clamp((u - ch.u[j]) / (ch.u[j + 1] - ch.u[j] || 1), 0, 1);
          const px = ch.lx[j] + f * (ch.lx[j + 1] - ch.lx[j]), py = ch.ly[j] + f * (ch.ly[j + 1] - ch.ly[j]);
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          const e0 = ch.elev[j], e1 = ch.elev[j + 1];
          if (Number.isNaN(e0) || Number.isNaN(e1)) continue;
          const lat = ch.lonlat[2 * j + 1] + f * (ch.lonlat[2 * j + 3] - ch.lonlat[2 * j + 1]);
          const k = cosC / Math.cos(lat * D2R);
          const dx = ch.mx[j + 1] - ch.mx[j], dy = -(ch.my[j + 1] - ch.my[j]), dl = Math.hypot(dx, dy) || 1;
          const ux = dx / dl, uy = dy / dl;
          const across = lanes > 1 ? (lane - (lanes - 1) / 2) * Math.min(channelWidth(p.q) / 3, STYLE.width(p.t) * 2 * mpp) : 0;
          const wx = (ch.mx[j] + f * dx - cmx) / sc - uy * across, wy = (-(ch.my[j] - cmy)) / sc + f * dy / sc + ux * across;
          const wz = (e0 + f * (e1 - e0) - centerElev + LIFT_PX * mpp) * k;
          const len = STYLE.length(p.t) * mpp, wid = STYLE.width(p.t) * mpp, o = count * 16;
          a[o] = ux * len; a[o + 1] = uy * len; a[o + 2] = 0; a[o + 3] = 0;
          a[o + 4] = -uy * wid; a[o + 5] = ux * wid; a[o + 6] = 0; a[o + 7] = 0;
          a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = 1; a[o + 11] = 0;
          a[o + 12] = wx; a[o + 13] = wy; a[o + 14] = wz; a[o + 15] = 1;
          alpha[count] = STYLE.alpha(p.t);
          count++;
        }
      }
    }
    mesh.count = count;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, count * 16);
    mesh.instanceMatrix.needsUpdate = true;
    alphaAttr.clearUpdateRanges();
    alphaAttr.addUpdateRange(0, count);
    alphaAttr.needsUpdate = true;
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
