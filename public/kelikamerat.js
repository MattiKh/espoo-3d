// Kelikamerat (Fintraffic, Digitraffic). Kameroiden sijainnit haetaan kerran asemaluettelosta, ja
// kartalle otetaan Espoon rajan sisällä olevat (sama raja kuin ajoneuvoilla, Kauniainen mukana).
// Kuvia ei ladata etukäteen: kameraa klikkaamalla aukeaa ikkuna, jossa on aseman kuvasuunnat
// pikkukuvina ja kuvausaika, ja pikkukuvasta aukeaa täysikokoinen kuva. Kamerat ottavat kuvan noin
// 10 minuutin välein, joten avoinna olevat kuvat päivitetään samassa tahdissa. Vain alle FRESH vanhat
// kuvat näytetään, ja kartalla on vain asemat, joilla on sellainen (kuvausajat kaikista asemista
// STATUS välein).
// Rajapinnat sallivat selaimen suorat haut (CORS); Digitraffic-User-otsake kuten muissakin
// Digitrafficin hauissa (transit.js). Lisenssi CC BY 4.0 (Fintraffic / digitraffic.fi).

const API = "https://tie.digitraffic.fi/api/weathercam/v1/stations";
const HEADERS = { "Digitraffic-User": "Espoo3D" };
const IMAGE = (preset) => `https://weathercam.digitraffic.fi/${preset}.jpg`;
const REFRESH = 10 * 60 * 1000; // ms
const FRESH = 15 * 60 * 1000; // ms: tätä vanhempia kuvia ei näytetä
const STATUS = 2 * 60 * 1000; // ms: kuvausajat haetaan näin usein
const MINZOOM = 10;
const COLOR = "#1f8a4c";
export const ATTR_CAMERAS = 'Kelikamerat © <a href="https://www.digitraffic.fi/tieliikenne/" target="_blank" rel="noopener">Fintraffic / digitraffic.fi</a> (CC BY 4.0)';

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};

const isFresh = (iso) => Date.now() - (Date.parse(iso) || 0) < FRESH;
const timeText = (iso) => (iso ? new Date(iso).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : null);

// Onko piste rajan (GeoJSON-monikulmiot) sisällä.
function insideOf(boundary) {
  const rings = boundary.features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
  const inRing = (ring, x, y) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
    return inside;
  };
  return ([x, y]) => rings.some((poly) => inRing(poly[0], x, y) && !poly.slice(1).some((hole) => inRing(hole, x, y)));
}

// Kameramerkki: värillinen ympyrä ja valkoinen kamera (kaksinkertainen tarkkuus).
function cameraIcon(color) {
  const s = 48, c = new OffscreenCanvas(s, s), g = c.getContext("2d");
  g.fillStyle = color;
  g.strokeStyle = "#ffffff";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 3, 0, 2 * Math.PI);
  g.fill();
  g.stroke();
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.roundRect(11, 17, 26, 17, 3);
  g.fill();
  g.fillRect(18, 13, 10, 5);
  g.fillStyle = color;
  g.beginPath();
  g.arc(24, 25.5, 5.5, 0, 2 * Math.PI);
  g.fill();
  return g.getImageData(0, 0, s, s);
}

export async function createCameras(map, { boundaryUrl, visible }) {
  const [list, boundary] = await Promise.all([
    fetch(API, { headers: HEADERS }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Kelikamerat ${r.status}`)))),
    fetch(boundaryUrl).then((r) => r.json()),
  ]);
  const inside = insideOf(boundary);
  const stations = list.features
    .filter((f) => f.properties.collectionStatus === "GATHERING" && f.properties.presets.some((p) => p.inCollection))
    .filter((f) => inside(f.geometry.coordinates));
  const collected = new Map(stations.map((f) => [f.properties.id, new Set(f.properties.presets.filter((p) => p.inCollection).map((p) => p.id))]));
  const features = stations.map((f) => ({ type: "Feature", geometry: { type: "Point", coordinates: f.geometry.coordinates.slice(0, 2) }, properties: { id: f.properties.id } }));
  map.addImage("kelikamera", cameraIcon(COLOR), { pixelRatio: 2 });
  // Merkit tulevat näkyviin, kun kuvausajat on haettu (updateStatus).
  map.addSource("kelikamerat", { type: "geojson", data: { type: "FeatureCollection", features: [] }, attribution: ATTR_CAMERAS });
  map.addLayer({
    id: "kelikamerat", type: "symbol", source: "kelikamerat", minzoom: MINZOOM,
    layout: {
      visibility: visible ? "visible" : "none", "icon-image": "kelikamera", "icon-allow-overlap": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], MINZOOM, 0.7, 15, 1],
    },
  });

  // Kuvausajat kaikista asemista yhdellä haulla; kartalle asemat, joilla on tuore kuva.
  const listeners = [];
  let shown = null;
  async function updateStatus() {
    if (document.hidden) return;
    try {
      const data = await fetch(`${API}/data`, { headers: HEADERS }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
      const ok = new Set(data.stations
        .filter((st) => (st.presets ?? []).some((q) => collected.get(st.id)?.has(q.id) && isFresh(q.measuredTime)))
        .map((st) => st.id));
      shown = features.filter((f) => ok.has(f.properties.id));
      map.getSource("kelikamerat")?.setData({ type: "FeatureCollection", features: shown });
      for (const fn of listeners) fn();
    } catch (err) {
      console.warn("Kelikameroiden kuvausaikoja ei saatu", err);
    }
  }
  updateStatus();
  setInterval(updateStatus, STATUS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) updateStatus(); });

  // Täysikokoinen kuva koko näkymän päälle; Esc, taustan klikkaus tai sulkunappi sulkee.
  let viewer = null;
  function showImage(preset, caption) {
    viewer?.close();
    const img = el("img", { src: `${IMAGE(preset)}?t=${Date.now()}`, alt: caption });
    const close = () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      node.remove();
      viewer = null;
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const node = el("div", { class: "camera-view", role: "dialog", "aria-label": caption, onclick: (e) => { if (e.target === node) close(); } },
      el("figure", {}, img, el("figcaption", {}, caption, el("button", { type: "button", class: "close", onclick: close, "aria-label": "Sulje" }, "×"))));
    const timer = setInterval(() => { img.src = `${IMAGE(preset)}?t=${Date.now()}`; }, REFRESH);
    window.addEventListener("keydown", onKey);
    document.body.append(node);
    viewer = { close };
  }

  // Ikkunan sisältö: aseman nimi ja tuoreet kuvasuunnat (nimi ja kuvausaika) pikkukuvina.
  async function details(id) {
    const [station, data] = await Promise.all([`${API}/${id}`, `${API}/${id}/data`].map((url) => fetch(url, { headers: HEADERS }).then((r) => r.json())));
    const measured = new Map((data.presets ?? []).map((p) => [p.id, p.measuredTime]));
    const p = station.properties;
    return {
      name: p.names?.fi ?? p.name,
      presets: p.presets.filter((q) => q.inCollection && isFresh(measured.get(q.id))).map((q) => ({ id: q.id, name: q.presentationName || "", time: measured.get(q.id) })),
    };
  }

  function popupContent(id) {
    const body = el("div", { class: "camera-grid" }, el("p", { class: "more" }, "Haetaan kameran tietoja…"));
    const title = el("h3", {}, "Kelikamera");
    const node = el("div", { class: "pop camera" }, el("div", { class: "kind" }, "Kelikamera"), title, body,
      el("p", { class: "more" }, "Kuvat päivittyvät noin 10 minuutin välein. Lähde Fintraffic / digitraffic.fi, CC BY 4.0."));
    const render = () => details(id).then(({ name, presets }) => {
      title.textContent = name;
      if (!presets.length) return body.replaceChildren(el("p", { class: "more" }, "Kameran kuvat ovat yli 15 minuuttia vanhoja, joten niitä ei näytetä."));
      body.replaceChildren(...presets.map((q) => {
        const caption = [name, q.name, q.time && `klo ${timeText(q.time)}`].filter(Boolean).join(" · ");
        return el("figure", {},
          el("button", { type: "button", onclick: () => showImage(q.id, caption), "aria-label": `Suurenna: ${q.name || name}` },
            el("img", { src: `${IMAGE(q.id)}?thumbnail=true&t=${Date.parse(q.time) || Date.now()}`, alt: q.name || name, loading: "lazy" })),
          el("figcaption", {}, [q.name, q.time && `klo ${timeText(q.time)}`].filter(Boolean).join(" · ")));
      }));
    }).catch(() => body.replaceChildren(el("p", { class: "more" }, "Kameran tietoja ei juuri nyt saatu haettua.")));
    render();
    // Avoinna olevan ikkunan kuvat päivitetään, kunnes ikkuna suljetaan.
    const timer = setInterval(() => (node.isConnected ? render() : clearInterval(timer)), REFRESH);
    return node;
  }

  return {
    count: features.length,
    // Paneelin selite: näkyvien (tuoreen kuvan) kameroiden määrä.
    legendText() {
      if (shown == null) return "Haetaan kameroiden kuvausaikoja…";
      return `${shown.length}/${features.length} kameraa (Fintraffic): vain ne, joiden kuva on alle 15 min vanha. Klikkaa kameraa nähdäksesi kuvat.`;
    },
    onUpdate(fn) {
      listeners.push(fn);
    },
    setVisible(on) {
      map.setLayoutProperty("kelikamerat", "visibility", on ? "visible" : "none");
    },
    // Klikatun kameran ikkunan paikka ja sisältö, tai null.
    pick(point) {
      if (map.getLayoutProperty("kelikamerat", "visibility") === "none") return null;
      const [f] = map.queryRenderedFeatures([[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]], { layers: ["kelikamerat"] });
      return f ? { lngLat: f.geometry.coordinates, content: popupContent(f.properties.id) } : null;
    },
  };
}
