// Kyytinäkymä. Kun julkista kulkuneuvoa klikataan, kartta alkaa seurata sitä yläpuolelta: näkymän
// keskipiste pysyy kulkuneuvossa (hieman näkymän keskikohdan alapuolella, jotta edessä näkyy
// enemmän) ja menosuunta on aina ylöspäin. Sijainti ja suunta tulevat transit.js:ltä joka
// ruudussa. Kartan kohteita (rakennukset, aineistot, muut kulkuneuvot) voi klikata kuten muutenkin.
// Kartan oma raahaus ja kierto ovat seurannan ajan pois päältä; zoomausta (rulla, nipistys, +/−)
// ja kallistusta (hiirellä vetäminen ylös tai alas) ohjataan täällä, sillä MapLibren omat eleet
// pysähtyisivät, kun näkymä asetetaan joka ruudussa.
// Poistuttaessa palataan näkymään, josta kyytiin hypättiin.

const D2R = Math.PI / 180;
const HANDLERS = ["dragPan", "dragRotate", "scrollZoom", "boxZoom", "doubleClickZoom", "keyboard", "touchZoomRotate", "touchPitch"];
const FOLLOW_ZOOM = 17; // noin 350 m näkymän leveydeltä (1280 px)
const MIN_ZOOM = 14.5, MAX_ZOOM = 19;
const FOLLOW_PITCH = 45;
const MIN_PITCH = 0, MAX_PITCH = 80; // app.js: maxPitch
const PITCH_PER_PX = 0.5; // kuten MapLibren kallistus hiirellä: ylös vetäminen kallistaa kohti horisonttia
// FOLLOW_PITCHiä jyrkemmin kallistetaan vain niin pitkälle, että kamera on vähintään näin korkealla
// kulkuneuvon yläpuolella, jottei se lähikuvassa painu mäen tai rakennusten sisään.
const CAM_MIN_HEIGHT = 40; // m
const EARTH_CIRC = 40075016.686;
const LEAD = 0.3; // näkymän yläreunan täyte korkeuden osuutena: kulkuneuvo noin 65 % ylhäältä
const ENTER_MS = 1500;
const EXIT_MS = 1200;
const TURN_MS = 600; // kulkusuunnan muutosten pehmennys
const ZOOM_MS = 120; // zoomauksen pehmennys
const NOTE_MS = 5000;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
const angleDiff = (a, b) => wrap(a - b);
const ease = (t) => t * t * (3 - 2 * t);

// Näkymä: { center: { lng, lat }, zoom, pitch, bearing, padding: { top, bottom, left, right } }.
//
// pose (transit.js): { lon, lat, heading }: kulkuneuvon kohta ja kulkusuunta (rad, myötäpäivään
// pohjoisesta). null, kun kulkuneuvo on kadonnut datasta.
export function createRide(map, { onEnd }) {
  const container = map.getContainer(), box = map.getCanvasContainer();
  let saved = null; // näkymä ja asetukset ennen kyytiä
  let smooth = null, anim = null, leaving = null, pose = null, view = null, lastAt = 0;
  let zoom = FOLLOW_ZOOM, zoomTarget = FOLLOW_ZOOM, pitch = FOLLOW_PITCH, pitchTarget = FOLLOW_PITCH, noteTimer = null;

  // Osoiterivin näkymä (hash: true) pysyy kyydin ajan siinä, josta kyytiin hypättiin, jottei
  // uudelleenlataus jatka seurantaa vanhasta kohdasta.
  const updateHash = map._hash?._updateHash;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const duration = (ms) => (reduced.matches ? 1 : ms);

  // ------------------------------------------------------------ palkki

  const info = document.createElement("div");
  info.className = "ride-info";
  const exitButton = document.createElement("button");
  exitButton.type = "button";
  exitButton.textContent = "Lopeta seuranta";
  exitButton.addEventListener("click", () => exit());
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Menosuunta on ylöspäin. Kallista vetämällä hiirellä ylös tai alas, zoomaa rullalla, nipistämällä tai +/−. Kohteita voi klikata.";
  const bar = document.createElement("div");
  bar.className = "ride";
  bar.hidden = true;
  bar.setAttribute("aria-live", "polite");
  bar.append(info, exitButton, hint);
  container.append(bar);

  function showBar(note) {
    clearTimeout(noteTimer);
    exitButton.hidden = hint.hidden = !!note;
    if (note) {
      const p = document.createElement("p");
      p.className = "ride-note";
      p.textContent = note;
      info.replaceChildren(p);
      noteTimer = setTimeout(() => { bar.hidden = true; }, NOTE_MS);
    }
    bar.hidden = false;
  }

  // ------------------------------------------------------------ näkymä

  const currentView = () => ({ center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: map.getPadding() });

  // Leveällä näytöllä avoin paneeli peittää kartan vasenta reunaa, joten seurattava pidetään
  // näkyvän osan keskellä (tarkistetaan puolen sekunnin välein).
  let inset = 0, insetAt = -Infinity;
  function panelInset(now) {
    if (now - insetAt < 500) return inset;
    insetAt = now;
    const panel = document.getElementById("panel");
    const open = panel && !document.body.classList.contains("panel-closed") && !matchMedia("(max-width: 700px)").matches;
    inset = open ? Math.max(0, panel.getBoundingClientRect().right - container.getBoundingClientRect().left) : 0;
    return inset;
  }

  // Suurin kallistus zoomaustasolla z: kameran etäisyys näkymän keskipisteestä (m) riippuu
  // zoomauksesta ja näkymän korkeudesta.
  let pitchLimit = MAX_PITCH;
  function maxPitch(z, lat) {
    const t = map.transform, d = (t.cameraToCenterDistance * EARTH_CIRC * Math.cos(lat * D2R)) / ((t.tileSize ?? 512) * 2 ** z);
    return clamp(Math.acos(Math.min(1, CAM_MIN_HEIGHT / d)) / D2R, FOLLOW_PITCH, MAX_PITCH);
  }

  // Seurantanäkymä: kulkuneuvo täytteiden sisäpuolisen alueen keskellä, menosuunta ylöspäin.
  // Suunta pehmennetään, jotta sijaintien kohina ei heiluta karttaa.
  function followView(p, dt, now) {
    const heading = p.heading / D2R;
    if (!smooth) smooth = { heading };
    smooth.heading = wrap(smooth.heading + angleDiff(heading, smooth.heading) * (1 - Math.exp(-dt / TURN_MS)));
    zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt / ZOOM_MS));
    pitchLimit = maxPitch(zoom, p.lat);
    pitch += (Math.min(pitchTarget, pitchLimit) - pitch) * (1 - Math.exp(-dt / ZOOM_MS));
    return {
      center: { lng: p.lon, lat: p.lat }, zoom, pitch, bearing: smooth.heading,
      padding: { top: map.transform.height * LEAD, bottom: 0, left: panelInset(now), right: 0 },
    };
  }

  function blend(a, b, s) {
    const mix = (u, v) => u + (v - u) * s;
    return {
      center: { lng: mix(a.center.lng, b.center.lng), lat: mix(a.center.lat, b.center.lat) },
      zoom: mix(a.zoom, b.zoom), pitch: mix(a.pitch, b.pitch), bearing: a.bearing + angleDiff(b.bearing, a.bearing) * s,
      padding: Object.fromEntries(["top", "bottom", "left", "right"].map((k) => [k, mix(a.padding[k] ?? 0, b.padding[k] ?? 0)])),
    };
  }

  const apply = (v) => {
    map.jumpTo(v, { ride: true });
    view = v;
  };

  // Kutsutaan joka ruudussa ennen piirtoa, kun kulkuneuvot on siirretty (transit.js).
  function update(p) {
    if (!saved) return;
    const now = performance.now(), dt = Math.min(now - lastAt, 500);
    lastAt = now;
    if (!p && !leaving) leave(endView(), "Vuoro päättyi, joten seuranta päättyi.");
    let target;
    if (leaving) target = leaving.view;
    else { pose = p; target = followView(p, dt, now); }
    let v = target;
    if (anim) {
      const t = (now - anim.t0) / anim.ms;
      if (t < 1) v = blend(anim.from, target, ease(t));
      else {
        anim = null;
        if (leaving) { restore(leaving.view, leaving.note); return; }
      }
    }
    apply(v);
  }

  // Näkymä, johon jäädään, kun kulkuneuvo katoaa: sen viimeinen sijainti keskelle.
  const endView = () => ({ ...(view ?? currentView()), center: { lng: pose.lon, lat: pose.lat }, padding: saved.view.padding });

  function leave(v, note = null) {
    if (!saved || leaving) return;
    leaving = { view: v, note };
    anim = { from: view ?? currentView(), t0: performance.now(), ms: duration(EXIT_MS) };
    exitButton.disabled = true;
  }

  // Kartan asetukset takaisin; v: näkymä, johon jäädään (muuten nykyinen täytteen kanssa).
  function restore(v, note = null) {
    const s = saved;
    saved = leaving = anim = smooth = pose = view = null;
    pinch = drag = null;
    container.classList.remove("ride-drag");
    if (updateHash) map.on("moveend", updateHash);
    map.jumpTo(v ?? { padding: s.view.padding });
    for (const h of s.handlers) map[h].enable();
    container.classList.remove("riding");
    if (s.closedPanel) document.body.classList.remove("panel-closed");
    if (note) showBar(note);
    else bar.hidden = true;
    onEnd();
  }

  // ------------------------------------------------------------ zoomaus

  const zoomBy = (dz) => { zoomTarget = clamp(zoomTarget + dz, MIN_ZOOM, MAX_ZOOM); };
  box.addEventListener("wheel", (e) => {
    if (!saved || leaving) return;
    e.preventDefault();
    zoomBy((-e.deltaY * (e.deltaMode === 1 ? 33 : 1)) / 400); // hiiren rullan pykälä noin 0,25 tasoa
  }, { passive: false });

  // Nipistys kahdella sormella; yksi sormi ei siirrä karttaa, joten napautus on klikkaus.
  const touches = new Map();
  let pinch = null;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  box.addEventListener("pointerdown", (e) => {
    if (!saved || e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) pinch = { d: spread(), zoom: zoomTarget };
  });
  box.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2 && !leaving) zoomTarget = clamp(pinch.zoom + Math.log2(spread() / pinch.d), MIN_ZOOM, MAX_ZOOM);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    box.addEventListener(type, (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    });
  }
  // Kallistus vetämällä hiirellä (mikä tahansa nappi) ylös tai alas. Paikallaan painettu nappi on
  // klikkaus, sillä MapLibre ei tulkitse klikkaukseksi yli 3 px:n siirtoa.
  let drag = null;
  box.addEventListener("pointerdown", (e) => {
    if (!saved || leaving || e.pointerType !== "mouse") return;
    drag = { id: e.pointerId, y: e.clientY, pitch: Math.min(pitchTarget, pitchLimit) };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id || leaving) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 3) container.classList.add("ride-drag");
    pitchTarget = clamp(drag.pitch - dy * PITCH_PER_PX, MIN_PITCH, MAX_PITCH);
  });
  for (const type of ["pointerup", "pointercancel"]) {
    box.addEventListener(type, (e) => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      container.classList.remove("ride-drag");
    });
  }

  window.addEventListener("keydown", (e) => {
    if (!saved || leaving || e.target.closest?.("input, select, textarea")) return;
    if (e.key === "Escape") exit();
    else if (e.key === "+" || e.key === "=") zoomBy(0.5);
    else if (e.key === "-") zoomBy(-0.5);
    else return;
    e.preventDefault();
  });

  // ------------------------------------------------------------ julkinen rajapinta

  return {
    get active() { return saved != null; },
    update,
    setInfo(node) { if (saved && !leaving) info.replaceChildren(node); },
    // Seuraamaan (tai seurannassa toiseen kulkuneuvoon): kartta siirtyy nykyisestä näkymästä seurantaan.
    start(p, node) {
      if (!p) return;
      if (!saved) {
        saved = {
          view: currentView(), handlers: HANDLERS.filter((h) => map[h]?.isEnabled()),
          closedPanel: matchMedia("(max-width: 700px)").matches && !document.body.classList.contains("panel-closed"),
        };
        for (const h of saved.handlers) map[h].disable();
        if (updateHash) map.off("moveend", updateHash);
        container.classList.add("riding");
        if (saved.closedPanel) document.body.classList.add("panel-closed"); // kapealla näytöllä paneeli peittäisi näkymän
        zoom = zoomTarget = FOLLOW_ZOOM;
        pitch = pitchTarget = FOLLOW_PITCH;
      }
      anim = { from: view ?? currentView(), t0: performance.now(), ms: duration(ENTER_MS) };
      leaving = smooth = null;
      lastAt = performance.now();
      exitButton.disabled = false;
      info.replaceChildren(node);
      showBar(null);
      update(p);
    },
    // Lopeta-nappi ja Esc: takaisin näkymään, josta kyytiin hypättiin.
    exit,
    // Heti pois seurannasta ilman siirtymää (esim. paneelista valittu paikka lennättää kartan muualle).
    stop() { if (saved) restore(null); },
  };

  function exit() {
    if (saved) leave(saved.view);
  }
}
