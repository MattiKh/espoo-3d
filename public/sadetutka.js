// Sadetutka (Ilmatieteen laitos): sateen voimakkuus pyöreäreunaisina alueina 50 m maanpinnan
// yläpuolella (three.js, transit.js:n 3D-tasolla).
//
// Tutkakuva on 500 metrin ruudukko TM35FIN-koordinaatistossa (EPSG:3067). Se haetaan WMS:stä koko
// kartan alueelta (REGION) täsmälleen tutkan ruudukon mukaisena: yksi kuvapiste on yksi tutkan ruutu,
// joten sama pieni kuva kelpaa kaikilla zoomaustasoilla. Varjostin pehmentää ruudut kuutiollisella
// B-splinillä ja leikkaa reunan kohdasta EDGE: yksittäinen ruutu on pyöreä läiskä, isommat alueet
// pyöreäreunaisia, ja värit liukuvat ruudusta toiseen.
//
// Pinta on 500 metrin välein oleva verkko. Sen korkeus on lähiympäristön (±STEP) korkein maanpinta
// korostettuna kuten kartalla + LIFT, joten mäet eivät puhkaise pintaa. Maanpinta luetaan harvasta
// korkeusmallista (Mapterhorn, taso DEM_ZOOM), joka haetaan kerran.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";

const FMI_WMS = "https://openwms.fmi.fi/geoserver/Radar/wms";
const DEM = (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`;
const REGION = [[22.9, 59.4], [26.6, 61.0]]; // kartan rajat (maxBounds) ja reunus viistoja näkymiä varten
const GRID = 500, GRID_E = 400, GRID_N = 150; // m: tutkan ruudun koko ja ruutujen reunat (mod 500) TM35FIN:ssä
const STEP = 500; // m: verkon väli
const LIFT = 50; // m maanpinnan yläpuolella
const OPACITY = 0.25; // läpinäkyvyys 75 %
const EDGE = 0.3; // reuna pehmennetyn peittävyyden kohdassa (0…1); pienempi = alueet hieman suurempia
const DEM_ZOOM = 7; // noin 300 m kuvapiste
const EDGE_FADE = 10; // verkon väliä: alueen reuna häivytetään, jottei sade katkea suoraan viivaan

const D2R = Math.PI / 180, EARTH_CIRC = 40075016.686;
const ORIGIN_LON = 24.7, ORIGIN_LAT = 60.2; // paikallinen origo kuten transit.js
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const ORIGIN_MX = mercX(ORIGIN_LON), ORIGIN_MY = mercY(ORIGIN_LAT);

// ETRS-TM35FIN (EPSG:3067) maantieteellisistä koordinaateista (GRS80, Krügerin sarja, JHS 154).
const TM = (() => {
  const a = 6378137, f = 1 / 298.257222101, n = f / (2 - f), e = Math.sqrt(f * (2 - f)), k0 = 0.9996;
  const A1 = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const h = [
    n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3 + (41 / 180) * n ** 4,
    (13 / 48) * n ** 2 - (3 / 5) * n ** 3 + (557 / 1440) * n ** 4,
    (61 / 240) * n ** 3 - (103 / 140) * n ** 4,
    (49561 / 161280) * n ** 4,
  ];
  return (lon, lat) => {
    const phi = lat * D2R, l = (lon - 27) * D2R;
    const Q = Math.asinh(Math.tan(phi)) - e * Math.atanh(e * Math.sin(phi)), beta = Math.atan(Math.sinh(Q));
    const eta0 = Math.atanh(Math.cos(beta) * Math.sin(l)), xi0 = Math.asin(Math.sin(beta) * Math.cosh(eta0));
    let xi = xi0, eta = eta0;
    h.forEach((hk, k) => {
      xi += hk * Math.sin(2 * (k + 1) * xi0) * Math.cosh(2 * (k + 1) * eta0);
      eta += hk * Math.cos(2 * (k + 1) * xi0) * Math.sinh(2 * (k + 1) * eta0);
    });
    return [A1 * eta * k0 + 500000, A1 * xi * k0];
  };
})();

const VERTEX = `
  attribute vec2 aGrid;
  attribute float aGround, aInvCos, aEdge;
  uniform vec2 uShift;
  uniform float uInvSc, uCenterElev, uCosC, uExag;
  varying vec2 vGrid;
  varying float vFade;
  void main() {
    vec2 xy = vec2(position.x + uShift.x, -(position.y + uShift.y)) * uInvSc;
    float z = (aGround * uExag + ${LIFT.toFixed(1)} - uCenterElev) * uCosC * aInvCos;
    vGrid = aGrid;
    vFade = clamp(aEdge / ${EDGE_FADE.toFixed(1)}, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, z, 1.0);
  }`;

// Kuutiollinen B-spline neljällä bilineaarisella haulla (GPU Gems 2, luku 20). Kuvassa värit on
// kerrottu peittävyydellä, joten sateettomat ruudut eivät sävytä reunoja.
const FRAGMENT = `
  uniform sampler2D uRadar;
  uniform vec2 uSize;
  uniform float uOpacity;
  varying vec2 vGrid;
  varying float vFade;
  vec4 smoothRadar(vec2 p) {
    p -= 0.5;
    vec2 i = floor(p), f = p - i, f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1, g1 = w2 + w3;
    vec2 h0 = (i - 0.5 + w1 / g0) / uSize, h1 = (i + 1.5 + w3 / g1) / uSize;
    return g0.y * (g0.x * texture2D(uRadar, h0) + g1.x * texture2D(uRadar, vec2(h1.x, h0.y)))
      + g1.y * (g0.x * texture2D(uRadar, vec2(h0.x, h1.y)) + g1.x * texture2D(uRadar, h1));
  }
  void main() {
    vec4 c = smoothRadar(vGrid);
    float w = fwidth(c.a);
    float cover = smoothstep(${EDGE} - w, ${EDGE} + w, c.a);
    cover *= vFade;
    if (cover <= 0.0) discard;
    gl_FragColor = vec4(c.rgb / max(c.a, 1e-3), cover * uOpacity);
  }`;

async function decode(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

// Maanpinnan korkeus (m) Web Mercator -pisteessä harvasta korkeusmallista (terrarium-koodaus).
async function loadGround() {
  const n = 2 ** DEM_ZOOM;
  const [x0, x1] = [Math.floor(mercX(REGION[0][0]) * n), Math.floor(mercX(REGION[1][0]) * n)];
  const [y0, y1] = [Math.floor(mercY(REGION[1][1]) * n), Math.floor(mercY(REGION[0][1]) * n)];
  const tiles = new Map();
  await Promise.all(Array.from({ length: (x1 - x0 + 1) * (y1 - y0 + 1) }, (_, k) => {
    const x = x0 + (k % (x1 - x0 + 1)), y = y0 + Math.floor(k / (x1 - x0 + 1));
    return decode(DEM(DEM_ZOOM, x, y)).then((img) => tiles.set(`${x}/${y}`, img));
  }));
  // Kuvapisteen (koko kuvaston koordinaateissa) korkeus; Mapterhornissa meri on syvyyksineen.
  const size = tiles.values().next().value.width;
  const at = (px, py) => {
    const img = tiles.get(`${Math.floor(px / size)}/${Math.floor(py / size)}`);
    if (!img) return 0;
    const i = 4 * ((py % size) * size + (px % size)), d = img.data;
    return Math.max(0, d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768);
  };
  return { size: size * n, at };
}

// Tutkakuvan alue TM35FIN:ssä ruutujen reunoihin pyöristettynä.
function radarArea(points) {
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  for (const [e, n] of points) {
    e0 = Math.min(e0, e); e1 = Math.max(e1, e); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
  }
  const down = (v, off) => Math.floor((v - off) / GRID) * GRID + off, up = (v, off) => Math.ceil((v - off) / GRID) * GRID + off;
  const area = { e0: down(e0, GRID_E), e1: up(e1, GRID_E), n0: down(n0, GRID_N), n1: up(n1, GRID_N) };
  return { ...area, w: (area.e1 - area.e0) / GRID, h: (area.n1 - area.n0) / GRID };
}

export function createRadar(map, { layer, visible = true, attribution }) {
  // Tyhjä taso tekijätietoja ja näkyvyyttä varten (MapLibre näyttää vain käytössä olevien lähteiden tiedot).
  map.addSource("sadetutka", { type: "geojson", data: { type: "FeatureCollection", features: [] }, attribution });
  map.addLayer({ id: "sadetutka", type: "fill", source: "sadetutka", layout: { visibility: visible ? "visible" : "none" }, paint: { "fill-opacity": 0 } });

  // Verkko tasavälein Web Mercatorissa; kärjille TM35FIN-paikka tutkan kuvapisteinä.
  const cosO = Math.cos(ORIGIN_LAT * D2R), step = STEP / (EARTH_CIRC * cosO);
  const mx0 = mercX(REGION[0][0]), mx1 = mercX(REGION[1][0]), my0 = mercY(REGION[1][1]), my1 = mercY(REGION[0][1]);
  const NX = Math.ceil((mx1 - mx0) / step) + 1, NY = Math.ceil((my1 - my0) / step) + 1, V = NX * NY;
  const pos = new Float32Array(3 * V), invCos = new Float32Array(V), edge = new Float32Array(V), tm = new Float64Array(2 * V);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const v = j * NX + i, mx = mx0 + i * step, my = my0 + j * step;
      const lon = mx * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / D2R;
      pos[3 * v] = mx - ORIGIN_MX;
      pos[3 * v + 1] = my - ORIGIN_MY;
      invCos[v] = 1 / Math.cos(lat * D2R);
      edge[v] = Math.min(i, NX - 1 - i, j, NY - 1 - j);
      [tm[2 * v], tm[2 * v + 1]] = TM(lon, lat);
    }
  }
  const area = radarArea(Array.from({ length: V }, (_, v) => [tm[2 * v], tm[2 * v + 1]]));
  const grid = new Float32Array(2 * V);
  for (let v = 0; v < V; v++) {
    grid[2 * v] = (tm[2 * v] - area.e0) / GRID;
    grid[2 * v + 1] = (area.n1 - tm[2 * v + 1]) / GRID; // kuvan rivit pohjoisesta alkaen
  }
  const index = new Uint32Array(6 * (NX - 1) * (NY - 1));
  for (let j = 0, o = 0; j < NY - 1; j++) {
    for (let i = 0; i < NX - 1; i++, o += 6) {
      const a = j * NX + i;
      index.set([a, a + 1, a + NX, a + 1, a + NX + 1, a + NX], o);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("aInvCos", new THREE.BufferAttribute(invCos, 1));
  geom.setAttribute("aGrid", new THREE.BufferAttribute(grid, 2));
  geom.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  geom.setAttribute("aGround", new THREE.BufferAttribute(new Float32Array(V), 1));
  geom.setIndex(new THREE.BufferAttribute(index, 1));

  const texture = new THREE.DataTexture(new Uint8Array(4 * area.w * area.h), area.w, area.h, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  const uniforms = {
    uRadar: { value: texture }, uSize: { value: new THREE.Vector2(area.w, area.h) }, uOpacity: { value: OPACITY },
    uShift: { value: new THREE.Vector2() }, uInvSc: { value: 1 }, uCenterElev: { value: 0 }, uCosC: { value: 0.5 }, uExag: { value: 1 },
  };
  // Värit ovat tutkakuvan sRGB-arvoja sellaisenaan kuten MapLibren karttakuvissa (ei värimuunnosta).
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
    // Molemmat puolet: Mercator-muunnoksen peilaus kääntää kolmioiden kiertosuunnan, ja kyydissä
    // pintaa katsotaan alta.
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.visible = false;

  let shown = visible, hasGround = false, hasImage = false;
  loadGround().then(({ size, at }) => {
    // Korkein maanpinta kärjen ympäriltä (±STEP): verkon kolmiot pysyvät maanpinnan yläpuolella.
    const r = Math.ceil(STEP / ((EARTH_CIRC * cosO) / size)), arr = geom.getAttribute("aGround").array;
    for (let v = 0; v < V; v++) {
      const px = Math.floor((pos[3 * v] + ORIGIN_MX) * size), py = Math.floor((pos[3 * v + 1] + ORIGIN_MY) * size);
      let hi = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) hi = Math.max(hi, at(px + dx, py + dy));
      arr[v] = hi;
    }
    geom.getAttribute("aGround").needsUpdate = true;
    hasGround = true;
    map.triggerRepaint();
  }).catch((err) => console.warn("Sadetutkan korkeusmallia ei saatu", err));

  // Tutkakuva annettuun aikaan; värit kerrotaan peittävyydellä (sade = täysin peittävät kuvapisteet).
  async function setTime(time) {
    const params = new URLSearchParams({
      SERVICE: "WMS", VERSION: "1.1.1", REQUEST: "GetMap", LAYERS: layer, STYLES: "", SRS: "EPSG:3067",
      BBOX: [area.e0, area.n0, area.e1, area.n1].join(","), WIDTH: area.w, HEIGHT: area.h,
      FORMAT: "image/png", TRANSPARENT: "TRUE", TIME: time,
    });
    const img = await decode(`${FMI_WMS}?${params}`);
    const src = img.data, dst = texture.image.data;
    for (let i = 0; i < src.length; i += 4) {
      const rain = src[i + 3] >= 128 ? 1 : 0;
      dst[i] = src[i] * rain; dst[i + 1] = src[i + 1] * rain; dst[i + 2] = src[i + 2] * rain; dst[i + 3] = 255 * rain;
    }
    texture.needsUpdate = true;
    hasImage = true;
    map.triggerRepaint();
  }

  function draw(map, ctx) {
    mesh.visible = shown && hasGround && hasImage;
    if (!mesh.visible) return;
    uniforms.uShift.value.set(ORIGIN_MX - ctx.cmx, ORIGIN_MY - ctx.cmy);
    uniforms.uInvSc.value = 1 / ctx.sc;
    uniforms.uCenterElev.value = ctx.centerElev;
    uniforms.uCosC.value = ctx.cosC;
    uniforms.uExag.value = ctx.exag;
  }

  return {
    drawable: { object: mesh, draw, animating: () => false },
    setTime,
    setVisible(on) {
      shown = on;
      map.setLayoutProperty("sadetutka", "visibility", on ? "visible" : "none");
      map.triggerRepaint();
    },
  };
}
