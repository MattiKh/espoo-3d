// Oma sijainti: "Seuraa sijaintiani" -painike kartan oikeassa yläkulmassa.
//
// Painalluksesta selain kysyy luvan sijaintiin, ja kartta keskittyy sijaintiin ja seuraa sitä.
// Kartta kääntyy siihen suuntaan, johon laite osoittaa, jos laite kertoo suuntansa (kompassi).
// Muuten kartta kääntyy liikkuessa menosuuntaan, joka tulee paikantimelta (GPS:n kulkusuunta) tai
// lasketaan peräkkäisistä sijainneista; paikallaan kartan suunta pysyy silloin ennallaan.
//
// Seurannassa näkymä asetetaan joka ruudussa (jumpTo), jotta kompassin mukana kääntyvä kartta ja
// sijainnista toiseen liukuva merkki liikkuvat tasaisesti. Käyttäjän eleen aikana näkymää ei
// aseteta, koska se katkaisisi eleen.
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
const RECENTER_MS = 300; // eleen jälkeen sijainti palautetaan keskelle
const MOVE_SPEED = 1; // m/s: tätä nopeammin liikuttaessa kartta kääntyy menosuuntaan
const MIN_STEP = 8; // m: suunta lasketaan sijainneista, kun siirtymää on vähintään näin paljon
const MAX_ACCURACY = 50; // m: tätä epätarkemmista sijainneista ei lasketa suuntaa
const STEP_MAX_MS = 30000; // vertailukohta vanhenee, jos siirtymää ei kerry tässä ajassa
const HEADING_SMOOTH = 0.5; // uuden suunnan osuus, jotta paikantimen kohina ei heiluta karttaa
const HEADING_TTL = 10000; // ms: menosuunta näytetään vielä näin kauan liikkeen loputtua
// Kompassi näyttää magneettisen pohjoisen; erannon arvio Espoossa vuonna 2026 (WMM2025) noin 11° itään.
const DECLINATION = 11;
const COMPASS_TTL = 2000; // ms: kompassin suuntaa käytetään, kun uusi lukema on tätä tuoreempi
const COMPASS_MS = 120; // kompassin lukemien pehmennys (aikavakio)
const TURN_MS = 350; // kartan kääntymisen pehmennys (aikavakio)
// Kartta alkaa kääntyä, kun ero on yli TURN_START astetta, ja pysähtyy alle TURN_STOP asteen
// erolla, jottei kompassin pieni värinä käännä karttaa jatkuvasti.
const TURN_START = 1.5, TURN_STOP = 0.3;
const INPUT_PAUSE_MS = 400; // hiiren rullan tai näppäimen jälkeen näkymää ei aseteta hetkeen
const STALE_MS = 30000; // merkki harmaaksi, jos uutta sijaintia ei ole tullut näin pitkään
const NOTE_MS = 6000;

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
  let inputAt = -Infinity; // viimeisin hiiren rulla tai näppäin
  let startEnd = 0; // siirtymä (easeTo) kesken tähän asti; sitä ei katkaista
  let frame = 0, lastFrame = 0, turning = false, applied = null; // seurannan ruutusilmukka
  const pointers = new Set();
  let noteTimer = null;
  // Näkymää ei siirretä ennen kuin kartan tyyli on ladattu (app.js:n moveend-käsittelijät tarvitsevat sen).
  let ready = map.loaded();
  if (!ready) map.once("load", () => { ready = true; });

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
    cancelAnimationFrame(frame);
    frame = 0;
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
    ease(START_MS, first ? Math.max(z, FOLLOW_ZOOM) : Math.max(z, MIN_RECENTER_ZOOM));
    if (!frame) { lastFrame = performance.now(); frame = requestAnimationFrame(loop); }
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
    // Merkki liukuu uuteen sijaintiin tasaisesti sijaintien välisessä ajassa, ja seurannassa
    // näkymä seuraa merkkiä (loop), joten merkki pysyy näkymän keskellä eikä hypi.
    showMarker(prev ? Math.min(Math.max(p.t - prev.t, 250), 2000) : 0);
    if (state === "haku") follow(true);
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

  const compassFresh = () => compass != null && performance.now() - compassAt < COMPASS_TTL;
  // Näkymän suunta: laitteen osoittama suunta (kompassi), muuten liikkuessa menosuunta.
  const viewHeading = () => (compassFresh() ? compass : moving() ? heading : null);

  // Siirtymä sijaintiin (seurannan alku, keskitys eleen jälkeen); ruutusilmukka jatkaa sen jälkeen.
  function ease(ms, zoom) {
    if (!fix || riding()) return;
    if (!ready) { map.once("load", () => { if (state === "seuraa") ease(ms, zoom); }); return; }
    const o = { center: [fix.lon, fix.lat], duration: ms };
    if (zoom != null) o.zoom = zoom;
    const h = viewHeading();
    if (h != null) o.bearing = h;
    map.easeTo(o, { sijainti: true });
    startEnd = performance.now() + ms;
    applied = null;
  }

  // Seurannan näkymä joka ruudussa: keskipiste merkin kohdalle ja suunta pehmennettynä kohti
  // näkymän suuntaa. Näkymää ei aseteta, jos mikään ei muutu, jottei karttaa piirretä turhaan.
  function loop(now) {
    frame = 0;
    if (state !== "seuraa") return;
    frame = requestAnimationFrame(loop);
    const dt = Math.min(Math.max(now - lastFrame, 0), 200);
    lastFrame = now;
    if (riding()) { release(); return; }
    if (interacting && !map.isMoving()) interacting = false; // varmistus, jos eleen loppu jäi huomaamatta
    if (!ready || interacting || pointers.size || now - inputAt < INPUT_PAUSE_MS || now < startEnd || !shown) return;
    const v = {};
    if (!applied || applied.lon !== shown.lon || applied.lat !== shown.lat) v.center = [shown.lon, shown.lat];
    const h = viewHeading();
    if (h != null) {
      const b = map.getBearing(), d = angleDiff(h, b);
      if (Math.abs(d) > TURN_START) turning = true;
      else if (Math.abs(d) < TURN_STOP) turning = false;
      if (turning) v.bearing = b + d * (1 - Math.exp(-dt / TURN_MS));
    } else turning = false;
    if (!v.center && v.bearing == null) return;
    map.jumpTo(v, { sijainti: true });
    applied = { ...shown };
  }

  // ------------------------------------------------------------ käyttäjän eleet

  const box = map.getCanvasContainer();
  box.addEventListener("pointerdown", (e) => pointers.add(e.pointerId));
  for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, (e) => pointers.delete(e.pointerId));
  // Rullan ja näppäinten eleet alkavat vasta seuraavassa ruudussa; ne katkeaisivat, jos näkymä
  // asetettaisiin sitä ennen.
  box.addEventListener("wheel", () => { inputAt = performance.now(); }, { passive: true });
  window.addEventListener("keydown", (e) => {
    if (!e.target.closest?.("input, select, textarea")) inputAt = performance.now();
  });

  map.on("movestart", (e) => { if (e.originalEvent) interacting = true; });
  map.on("moveend", (e) => {
    if (!e.originalEvent || !interacting) return;
    interacting = false;
    if (state !== "seuraa" || !fix) return;
    // Selvästi sivuun siirretty kartta jää siihen; zoomauksen tai nipistyksen pieni siirtymä palautetaan.
    const pt = map.project([fix.lon, fix.lat]), { width, height } = map.getCanvas().getBoundingClientRect();
    const off = Math.hypot(pt.x - width / 2, pt.y - height / 2);
    if (off > Math.max(60, 0.15 * Math.min(width, height))) release();
    else ease(RECENTER_MS);
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
    const h = viewHeading();
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

  // Laitteen osoittama suunta (astetta magneettisesta pohjoisesta myötäpäivään) tai null.
  // iOS kertoo sen valmiina (webkitCompassHeading). Muilla suunta lasketaan asennosta (alpha, beta,
  // gamma; W3C:n ZXY-kierrot): näytön yläreunan vaakasuunta, johon lisätään takapinnan vaakasuunta
  // sitä painavampana, mitä pystymmässä yläreuna on. Suunta on näin oikea sekä laite vaakatasossa
  // (yläreuna, myös sivuttain kallistettuna) että pystyssä (takapinta, kuten kameralla katsoessa).
  // Vaakanäytössä yläreunana käytetään laitteen kylkeä.
  function deviceHeading(e) {
    if (Number.isFinite(e.webkitCompassHeading)) {
      return e.webkitCompassAccuracy < 0 ? null : e.webkitCompassHeading + screenAngle();
    }
    if (!e.absolute || ![e.alpha, e.beta, e.gamma].every(Number.isFinite)) return null;
    const a = e.alpha * D2R, b = e.beta * D2R, g = e.gamma * D2R, s = screenAngle() * D2R;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    // Laitteen akselit (x oikealle, y ylös, takapinta −z) maan itä- ja pohjoiskomponentteina.
    const xE = cA * cG - sA * sB * sG, xN = sA * cG + cA * sB * sG, xU = -cB * sG;
    const yE = -sA * cB, yN = cA * cB, yU = sB;
    const zE = -cA * sG - sA * sB * cG, zN = -sA * sG + cA * sB * cG;
    const cS = Math.cos(s), sS = Math.sin(s), w = Math.abs(yU * cS + xU * sS); // yläreunan pystyys
    const vE = yE * cS + xE * sS + zE * w, vN = yN * cS + xN * sS + zN * w;
    return Math.hypot(vE, vN) < 0.1 ? null : Math.atan2(vE, vN) / D2R;
  }

  function onOrientation(e) {
    let h = deviceHeading(e);
    if (h == null) return;
    h = norm(h + DECLINATION);
    const now = performance.now();
    compass = compassFresh() ? norm(compass + angleDiff(h, compass) * (1 - Math.exp(-(now - compassAt) / COMPASS_MS))) : h;
    compassAt = now;
    updateArrow();
  }

  const orientationEvent = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";

  // Kuunnellaan aina; ilman lupaa lukemia ei vain tule. Lupa pyydetään, jos selain sitä vaatii
  // (iOS kysyy sen painalluksen yhteydessä), ja kuuntelu varmistetaan luvan saatua.
  function startCompass() {
    const E = window.DeviceOrientationEvent;
    if (compassOn || !E) return;
    compassOn = true;
    const listen = () => { if (compassOn) window.addEventListener(orientationEvent, onOrientation); };
    listen();
    if (typeof E.requestPermission === "function") {
      E.requestPermission().then((r) => { if (r === "granted") listen(); }).catch(() => {});
    }
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
