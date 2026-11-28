// Oma sijainti: "Seuraa sijaintiani" -painike kartan oikeassa yläkulmassa.
//
// Painalluksesta selain kysyy luvan sijaintiin, ja kartta keskittyy sijaintiin ja seuraa sitä.
// Liikkuessa kartta kääntyy menosuuntaan, joten edessä oleva näkyy ylöspäin. Suunta tulee
// paikantimelta (GPS:n kulkusuunta) tai lasketaan peräkkäisistä sijainneista, jos selain ei kerro
// sitä. Paikallaan ollessa kartan suunta pysyy ennallaan, ja merkin nuoli näyttää kompassin
// suunnan, jos laite kertoo sen.
//
// Zoomaus, kallistus ja kierto eivät katkaise seurantaa (zoomaus tehdään näkymän keskipisteen
// ympäri). Kun karttaa siirtää selvästi sivuun, seuranta jää taustalle: merkki pysyy, ja painike
// keskittää näkymän taas sijaintiin. Seurannan aikana painike lopettaa sijainnin käytön.
// Kulkuneuvon kyytiin hypättäessä (ride.js) kyytinäkymä ohjaa karttaa, ja sijainnin seuranta jää
// taustalle.

const D2R = Math.PI / 180;
const FOLLOW_ZOOM = 16.5; // seurannan alkaessa zoomataan vähintään tähän (noin 700 m näkymän leveydeltä)
const MIN_RECENTER_ZOOM = 14; // keskitettäessä uudelleen kauempaa zoomataan tähän
const START_MS = 1500;
const MOVE_SPEED = 1; // m/s: tätä nopeammin liikuttaessa kartta kääntyy menosuuntaan
const MIN_STEP = 8; // m: suunta lasketaan sijainneista, kun siirtymää on vähintään näin paljon
const MAX_ACCURACY = 50; // m: tätä epätarkemmista sijainneista ei lasketa suuntaa
const STEP_MAX_MS = 30000; // vertailukohta vanhenee, jos siirtymää ei kerry tässä ajassa
const HEADING_SMOOTH = 0.5; // uuden suunnan osuus, jotta paikantimen kohina ei heiluta karttaa
const HEADING_TTL = 10000; // ms: menosuunta näytetään vielä näin kauan liikkeen loputtua
const COMPASS_TTL = 3000;
const TURN_DEADBAND = 5; // astetta: pienempiä suunnan muutoksia ei käännetä
const STALE_MS = 30000; // merkki harmaaksi, jos uutta sijaintia ei ole tullut näin pitkään
const NOTE_MS = 6000;
const LINEAR = (t) => t;

const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
const angleDiff = (a, b) => wrap(a - b);
const norm = (deg) => ((deg % 360) + 360) % 360;

function metres(a, b) {
  const dx = (b.lon - a.lon) * 111320 * Math.cos(((a.lat + b.lat) / 2) * D2R), dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
}

function bearing(a, b) {
  const dx = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * D2R), dy = b.lat - a.lat;
  return norm(Math.atan2(dx, dy) / D2R);
}

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">'
  + '<path d="M20.2 3.8 3.6 10.7l7.1 2.6 2.6 7.1z" stroke-width="1.8" stroke-linejoin="round"/></svg>';

const TITLES = {
  off: "Seuraa sijaintiani",
  haku: "Haetaan sijaintia… (lopeta painamalla)",
  seuraa: "Lopeta sijainnin seuraaminen",
  vapaa: "Keskitä sijaintiini",
};

const ERRORS = {
  1: "Sijainnin käyttö on estetty. Salli sijainti selaimen tai puhelimen asetuksista.",
  2: "Sijaintia ei saatu selvitettyä.",
  3: "Sijaintia ei saatu ajoissa. Yritä uudelleen.",
};

export function createLocate(map) {
  const container = map.getContainer();
  let state = "off"; // off | haku (odotetaan ensimmäistä sijaintia) | seuraa | vapaa (merkki, ei seurantaa)
  let watchId = null;
  let fix = null; // viimeisin sijainti { lon, lat, acc, t, speed, heading, at }
  let anchor = null; // vertailukohta suunnan laskemiseen sijainneista
  let heading = null, headingAt = -Infinity; // menosuunta (astetta myötäpäivään pohjoisesta)
  let compass = null, compassAt = -Infinity, compassOn = false;
  let marker = null, dot = null, halo = null, arrow = null;
  let shown = null, glide = null, glideFrame = 0; // merkin kohta liukuu sijainnista seuraavaan
  let interacting = false; // käyttäjän ele (raahaus, zoomaus, kierto) käynnissä
  let startEnd = 0; // seurannan alun siirtymä (zoomaus) kesken tähän asti; sitä ei katkaista
  const pointers = new Set();
  let noteTimer = null;

  // ------------------------------------------------------------ painike ja ilmoitus

  const group = document.createElement("div");
  group.className = "maplibregl-ctrl maplibregl-ctrl-group";
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = ICON;
  button.addEventListener("click", onButton);
  group.append(button);

  const note = document.createElement("div");
  note.className = "ride locate-note";
  note.hidden = true;
  note.setAttribute("aria-live", "polite");
  const noteText = document.createElement("p");
  noteText.className = "ride-note";
  note.append(noteText);
  container.append(note);

  function showNote(text) {
    clearTimeout(noteTimer);
    noteText.textContent = text;
    note.hidden = false;
    noteTimer = setTimeout(() => { note.hidden = true; }, NOTE_MS);
  }

  function render() {
    button.className = `locate-button ${state}`;
    button.title = TITLES[state];
    button.setAttribute("aria-label", TITLES[state]);
    button.setAttribute("aria-pressed", String(state === "seuraa"));
  }
  render();

  function onButton() {
    if (state === "off") start();
    else if (state === "vapaa") follow(false);
    else stop();
  }

  // ------------------------------------------------------------ tilat

  function start() {
    if (!navigator.geolocation) return showNote("Selain ei kerro sijaintia.");
    if (!window.isSecureContext) return showNote("Sijainti toimii vain suojatulla (https) yhteydellä.");
    note.hidden = true;
    startCompass(); // iOS kysyy luvan vain painalluksen yhteydessä
    // Kapealla näytöllä paneeli peittäisi näkymän keskikohdan.
    if (matchMedia("(max-width: 700px)").matches) document.body.classList.add("panel-closed");
    state = "haku";
    render();
    watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }

  function stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    stopCompass();
    for (const m of marker ?? []) m.remove();
    cancelAnimationFrame(glideFrame);
    marker = fix = anchor = heading = compass = shown = glide = null;
    lockZoom(false);
    state = "off";
    render();
  }

  // Seurantaan: kartta keskelle sijaintia (first: seuranta alkaa, zoomataan lähemmäs).
  function follow(first) {
    if (!fix) { state = "haku"; render(); return; }
    state = "seuraa";
    render();
    lockZoom(true);
    const z = map.getZoom();
    ease(START_MS, { zoom: first ? Math.max(z, FOLLOW_ZOOM) : Math.max(z, MIN_RECENTER_ZOOM), turn: moving() });
    startEnd = performance.now() + START_MS;
  }

  function release() {
    state = "vapaa";
    render();
    lockZoom(false);
  }

  // Seurannan aikana zoomaus (rulla, nipistys) tehdään näkymän keskipisteen eli sijainnin ympäri.
  // Asetus vaihtuu vain ottamalla käsittelijä uudelleen käyttöön. Kyytinäkymä (ride.js) poistaa
  // käsittelijät käytöstä ja palauttaa ne oletusasetuksin.
  function lockZoom(on) {
    for (const h of [map.scrollZoom, map.touchZoomRotate]) {
      if (!h?.isEnabled()) continue;
      h.disable();
      h.enable(on ? { around: "center" } : undefined);
    }
  }

  const riding = () => container.classList.contains("riding");

  // ------------------------------------------------------------ sijainnit

  function onFix(pos) {
    const c = pos.coords;
    const p = {
      lon: c.longitude, lat: c.latitude, acc: c.accuracy ?? 1000, t: pos.timestamp || Date.now(),
      speed: c.speed, heading: c.heading, at: performance.now(),
    };
    const bounds = map.getMaxBounds();
    if (bounds && !bounds.contains([p.lon, p.lat])) {
      stop();
      showNote("Sijaintisi on kartta-alueen ulkopuolella.");
      return;
    }
    const prev = fix;
    travel(p);
    fix = p;
    // Merkki ja kartta siirtyvät uuteen sijaintiin samassa ajassa tasaisesti, jolloin merkki pysyy
    // seurannassa näkymän keskellä eikä hypi.
    const ms = prev ? Math.min(Math.max(p.t - prev.t, 250), 2000) : 0;
    showMarker(ms);
    if (riding() && state === "seuraa") release();
    if (state === "haku") { follow(true); return; }
    if (state !== "seuraa") return;
    if (interacting && !map.isMoving()) interacting = false; // varmistus, jos eleen loppu jäi huomaamatta
    if (interacting || pointers.size || document.hidden || performance.now() < startEnd) return;
    // Menosuunta mukana joka kerta liikkeen aikana, jotta edellisen siirtymän kesken jäänyt kääntö jatkuu.
    ease(ms, { turn: moving() });
  }

  function onError(err) {
    if (err.code === 1 || state === "haku") {
      stop();
      showNote(ERRORS[err.code] ?? ERRORS[2]);
    }
    // Hetkellinen katkos seurannan aikana: odotetaan seuraavaa sijaintia.
  }

  // Menosuunta: paikantimen kertoma kulkusuunta tai peräkkäisten sijaintien välinen suunta.
  function travel(p) {
    const reported = Number.isFinite(p.speed) ? p.speed >= MOVE_SPEED : null;
    if (reported && Number.isFinite(p.heading)) { setHeading(p.heading); anchor = p; return; }
    if (reported === false) { anchor = p; return; } // paikallaan
    if (p.acc > MAX_ACCURACY) return;
    if (!anchor || p.t - anchor.t > STEP_MAX_MS) { anchor = p; return; }
    const d = metres(anchor, p);
    if (d < Math.max(MIN_STEP, 0.5 * Math.max(anchor.acc, p.acc))) return;
    if (d / Math.max((p.t - anchor.t) / 1000, 0.001) >= MOVE_SPEED) setHeading(bearing(anchor, p));
    anchor = p;
  }

  function setHeading(h) {
    const now = performance.now();
    heading = heading == null || now - headingAt > HEADING_TTL ? norm(h) : norm(heading + angleDiff(h, heading) * HEADING_SMOOTH);
    headingAt = now;
  }

  const moving = () => heading != null && performance.now() - headingAt < HEADING_TTL;

  // Kartta sijaintiin; turn: käännetään menosuuntaan.
  function ease(ms, { zoom, turn }) {
    if (!fix || riding()) return;
    const o = { center: [fix.lon, fix.lat], duration: ms, easing: LINEAR };
    if (zoom != null) { o.zoom = zoom; delete o.easing; }
    if (turn && heading != null && Math.abs(angleDiff(heading, map.getBearing())) > TURN_DEADBAND) o.bearing = heading;
    map.easeTo(o, { sijainti: true });
  }

  // ------------------------------------------------------------ käyttäjän eleet

  const box = map.getCanvasContainer();
  box.addEventListener("pointerdown", (e) => pointers.add(e.pointerId));
  for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, (e) => pointers.delete(e.pointerId));

  map.on("movestart", (e) => { if (e.originalEvent) interacting = true; });
  map.on("moveend", (e) => {
    if (!e.originalEvent || !interacting) return;
    interacting = false;
    if (state !== "seuraa" || !fix) return;
    // Selvästi sivuun siirretty kartta jää siihen; zoomauksen tai nipistyksen pieni siirtymä palautetaan.
    const pt = map.project([fix.lon, fix.lat]), { width, height } = map.getCanvas().getBoundingClientRect();
    const off = Math.hypot(pt.x - width / 2, pt.y - height / 2);
    if (off > Math.max(60, 0.15 * Math.min(width, height))) release();
    else ease(300, {});
  });

  // ------------------------------------------------------------ merkki

  // Merkki kahdessa osassa: tarkkuusympyrä maan pinnassa (kallistuu ja kääntyy kartan mukana) ja
  // sen päällä piste ja suuntanuoli aina täysikokoisina. Nuolen kulma näytöllä lasketaan
  // maastossa menosuuntaan olevasta pisteestä, joten se osoittaa kallistetussakin näkymässä oikein.
  function showMarker(ms) {
    if (!marker) {
      const ground = document.createElement("div");
      ground.className = "locate-marker";
      halo = document.createElement("div");
      halo.className = "locate-accuracy";
      ground.append(halo);
      const pin = document.createElement("div");
      pin.className = "locate-pin";
      arrow = document.createElement("div");
      arrow.className = "locate-heading";
      dot = document.createElement("div");
      dot.className = "locate-dot";
      pin.append(arrow, dot);
      shown = { lon: fix.lon, lat: fix.lat };
      marker = [
        new maplibregl.Marker({ element: ground, rotationAlignment: "map", pitchAlignment: "map" }),
        new maplibregl.Marker({ element: pin }),
      ];
      for (const m of marker) m.setLngLat([shown.lon, shown.lat]).addTo(map);
    }
    glide = { from: { ...shown }, t0: performance.now(), ms: document.hidden ? 0 : ms };
    cancelAnimationFrame(glideFrame);
    stepGlide();
    dot.classList.remove("stale");
  }

  function stepGlide() {
    if (!glide || !fix) return;
    const t = glide.ms > 0 ? Math.min((performance.now() - glide.t0) / glide.ms, 1) : 1;
    shown = { lon: glide.from.lon + (fix.lon - glide.from.lon) * t, lat: glide.from.lat + (fix.lat - glide.from.lat) * t };
    for (const m of marker) m.setLngLat([shown.lon, shown.lat]);
    updateHalo();
    updateArrow();
    if (t < 1) glideFrame = requestAnimationFrame(stepGlide);
  }

  // Tarkkuusympyrä: säde pikseleinä merkin kohdalla näytön vaakasuunnassa (ei lyhene kallistuksessa).
  function updateHalo() {
    if (!fix || !halo || !shown) return;
    const b = (map.getBearing() + 90) * D2R, { lon, lat } = shown;
    const dLat = (fix.acc * Math.cos(b)) / 110540, dLon = (fix.acc * Math.sin(b)) / (111320 * Math.cos(lat * D2R));
    const a = map.project([lon, lat]), e = map.project([lon + dLon, lat + dLat]);
    const r = Math.min(Math.hypot(e.x - a.x, e.y - a.y), 3000);
    halo.style.display = r < 12 ? "none" : "";
    halo.style.width = halo.style.height = `${2 * r}px`;
  }

  function updateArrow() {
    if (!arrow || !shown) return;
    const now = performance.now();
    const h = moving() ? heading : compass != null && now - compassAt < COMPASS_TTL ? compass : null;
    arrow.style.display = h == null ? "none" : "";
    if (h == null) return;
    const r = h * D2R, { lon, lat } = shown;
    const a = map.project([lon, lat]);
    const b = map.project([lon + (20 * Math.sin(r)) / (111320 * Math.cos(lat * D2R)), lat + (20 * Math.cos(r)) / 110540]);
    arrow.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(b.x - a.x, a.y - b.y) / D2R}deg)`;
  }

  map.on("move", () => { updateHalo(); updateArrow(); });
  setInterval(() => {
    if (fix && dot && performance.now() - fix.at > STALE_MS) dot.classList.add("stale");
    updateArrow();
  }, 1000);

  // ------------------------------------------------------------ kompassi

  const screenAngle = () => screen.orientation?.angle ?? window.orientation ?? 0;

  function onOrientation(e) {
    let h = null;
    if (Number.isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading; // iOS
    else if (e.absolute && Number.isFinite(e.alpha)) h = 360 - e.alpha;
    if (h == null) return;
    h = norm(h + screenAngle());
    const now = performance.now();
    compass = compass == null || now - compassAt > COMPASS_TTL ? h : norm(compass + angleDiff(h, compass) * 0.2);
    compassAt = now;
    if (!moving()) updateArrow();
  }

  const orientationEvent = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";

  function startCompass() {
    const E = window.DeviceOrientationEvent;
    if (compassOn || !E) return;
    compassOn = true;
    const listen = () => { if (compassOn) window.addEventListener(orientationEvent, onOrientation); };
    if (typeof E.requestPermission === "function") {
      E.requestPermission().then((r) => { if (r === "granted") listen(); }).catch(() => {});
    } else listen();
  }

  function stopCompass() {
    compassOn = false;
    window.removeEventListener(orientationEvent, onOrientation);
  }

  // ------------------------------------------------------------ MapLibren ohjain

  return {
    onAdd() { return group; },
    onRemove() { stop(); group.remove(); note.remove(); },
    get state() { return state; }, // selaimen konsolia varten
  };
}
