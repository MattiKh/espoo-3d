// Kyytinäkymä. Kun julkista kulkuneuvoa klikataan, kamera hyppää sen kyytiin: kamera on keulassa
// kuljettajan silmien korkeudella ja seuraa kulkuneuvon sijaintia ja suuntaa, jotka transit.js
// antaa joka ruudussa. Kamerana on MapLibren oma kamera, joten maasto, rakennukset ja pelillinen
// maasto näkyvät kuten muutenkin. Katsetta käännetään vetämällä; kartan oma raahaus ja zoomaus
// ovat kyydin ajan pois päältä. Poistuttaessa palataan näkymään, josta kyytiin hypättiin.
//
// MapLibre (4.7.1) sijoittaa kameran näkymän keskipisteen, zoomauksen ja kallistuksen mukaan, ja
// keskipisteen korkeudeksi tulee joka ruudussa maaston korkeus siinä kohdassa. Kyydin ajaksi
// korkeus lukitaan (_elevationFreeze, jota MapLibre käyttää itse siirtymien aikana), ja
// keskipiste asetetaan katseen suuntaan niin, että kamera on halutussa kohdassa ja korkeudessa.
// MapLibre nostaisi maaston alle joutuvan kameran (metrotunnelissa) maan pinnalle; kyydin ajan
// transformCameraUpdate palauttaa näkymän sellaisenaan.

const D2R = Math.PI / 180;
const EC = 2 * Math.PI * 6371008.8; // MapLibren maapallon ympärysmitta (m)
const HANDLERS = ["dragPan", "dragRotate", "scrollZoom", "boxZoom", "doubleClickZoom", "keyboard", "touchZoomRotate", "touchPitch"];
// Kallistus 90° olisi vaakasuoraan. MapLibre 4.7.1:n setMaxPitch sallii enintään 85°, mutta kamera
// piirtää oikein lähes vaakasuoraan asti, joten raja nostetaan kyydin ajaksi suoraan kameralle.
const MAX_PITCH = 87;
const MIN_PITCH = 60;
const DEFAULT_PITCH = 84;
const YAW_LIMIT = 120; // astetta kulkusuunnasta kumpaankin suuntaan
// MapLibren lähitaso on 1/50 näkymän korkeudesta kameran ja keskipisteen etäisyyden mittakaavassa,
// joten zoomaus valitaan niin, että lähitaso on 1,5 metrin päässä kamerasta. Kauempana lähellä
// olevat kohteet leikkautuisivat pois; lähempänä ruutuja haettaisiin turhan tarkkoina.
const NEAR = 1.5;
const H_FOV = 70; // vaakasuora näkökenttä (°); pystysuora rajataan 40–60°:een (MapLibre enintään 60°)
const ENTER_MS = 1800;
const EXIT_MS = 1500;
const TURN_MS = 450; // kulkusuunnan muutosten pehmennys
const RISE_MS = 300; // korkeuden muutosten pehmennys
const CLEARANCE = 1.2; // m: kamera pidetään vähintään näin korkealla maaston yläpuolella
const NOTE_MS = 5000;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
const angleDiff = (a, b) => wrap(a - b);
const ease = (t) => t * t * (3 - 2 * t);
const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / Math.PI) / 2;
const lonOfMerc = (x) => x * 360 - 180;
const latOfMerc = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

// Kamera kuvataan silmän paikkana (x, y Web Mercator -yksiköinä), korkeutena (alt, m, maaston
// korostus mukana kuten MapLibren korkeuksissa) ja katseen suuntana. zoom määrää vain
// keskipisteen etäisyyden kamerasta, eli lähitason ja ruutujen tarkkuuden.
//
// pose (transit.js): { lon, lat, z, heading, eye, pitch, underground }: keulan kohta, maan,
// kannen tai kiskojen korkeus (m, kuten alt), kulkusuunta (rad, myötäpäivään pohjoisesta),
// silmien korkeus siitä (m), katseen oletuskallistus ja kulkeeko kulkuneuvo maan alla. null, kun
// kulkuneuvo on kadonnut datasta.
export function createRide(map, { onEnd }) {
  const container = map.getContainer(), box = map.getCanvasContainer();
  let saved = null; // näkymä ja asetukset ennen kyytiä
  let look = null, smooth = null, anim = null, leaving = null;
  let pose = null, cam = null, want = null, lastAt = 0, rideZoom = null, zoomHeight = null;
  let drag = null, noteTimer = null;

  // Osoiterivin näkymä (hash: true) pysyy kyydin ajan siinä, josta kyytiin hypättiin, jottei
  // uudelleenlataus vie katutasolle.
  const updateHash = map._hash?._updateHash;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const duration = (ms) => (reduced.matches ? 1 : ms);

  // ------------------------------------------------------------ palkki

  const info = document.createElement("div");
  info.className = "ride-info";
  const exitButton = document.createElement("button");
  exitButton.type = "button";
  exitButton.textContent = "Poistu kyydistä";
  exitButton.addEventListener("click", () => exit());
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Vedä katsoaksesi ympärillesi. Kaksoisnapautus kääntää katseen kulkusuuntaan.";
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

  // ------------------------------------------------------------ kamera

  const groundAt = (lngLat) => (map.queryTerrainElevation(lngLat) ?? 0) + map.transform.elevation;
  const currentView = () => ({ center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), fov: map.transform.fov });

  // MapLibren näkymä kamerana samalla laskulla kuin MapLibre (Transform.getCameraPosition).
  function viewCam(view, elevation) {
    const t = map.transform, cos = Math.cos(view.center.lat * D2R);
    const ctcd = (0.5 * t.height) / Math.tan((view.fov * D2R) / 2);
    const dist = (ctcd * EC * cos) / (t.tileSize * 2 ** view.zoom);
    const p = view.pitch * D2R, b = view.bearing * D2R, h = (dist * Math.sin(p)) / (EC * cos);
    return {
      x: mercX(view.center.lng) - Math.sin(b) * h, y: mercY(view.center.lat) + Math.cos(b) * h,
      alt: elevation + dist * Math.cos(p), bearing: view.bearing, pitch: view.pitch, zoom: view.zoom, fov: view.fov,
    };
  }

  // Kamera MapLibren näkymäksi: keskipiste katseen suuntaan ja sen korkeus lukittuna.
  function apply(c) {
    const t = map.transform;
    map.stop(); // käynnissä olevan siirtymän päättyminen voi asettaa korkeuden uudelleen
    if (Math.abs(t.fov - c.fov) > 1e-6) t.fov = c.fov;
    const cos = Math.cos(latOfMerc(c.y) * D2R);
    const dist = (t.cameraToCenterDistance * EC * cos) / (t.tileSize * 2 ** c.zoom);
    const p = c.pitch * D2R, b = c.bearing * D2R, h = (dist * Math.sin(p)) / (EC * cos);
    want = {
      center: new maplibregl.LngLat(lonOfMerc(c.x + Math.sin(b) * h), latOfMerc(c.y - Math.cos(b) * h)),
      zoom: c.zoom, pitch: c.pitch, bearing: wrap(c.bearing), elevation: c.alt - dist * Math.cos(p),
    };
    t.elevation = want.elevation;
    map._elevationFreeze = true;
    map.jumpTo({ center: want.center, zoom: want.zoom, pitch: want.pitch, bearing: want.bearing }, { ride: true });
    cam = c;
  }

  // Kamera kulkuneuvon keulassa. Suunta ja korkeus pehmennetään, jotta sijaintien kohina ei
  // heiluta näkymää.
  function rideCam(p, dt) {
    const t = map.transform, k = (ms) => 1 - Math.exp(-dt / ms);
    const heading = p.heading / D2R, alt = p.z + p.eye;
    if (!smooth) smooth = { heading, alt };
    smooth.heading = wrap(smooth.heading + angleDiff(heading, smooth.heading) * k(TURN_MS));
    smooth.alt += (alt - smooth.alt) * k(RISE_MS);
    if (zoomHeight !== t.height) {
      zoomHeight = t.height;
      const near = Math.max(NEAR, p.eye / 10); // korkealta (metro) lähin maasto on kaukana
      rideZoom = Math.log2((t.height * EC * Math.cos(p.lat * D2R)) / (50 * t.tileSize * near));
    }
    const fov = clamp((2 * Math.atan((Math.tan((H_FOV * D2R) / 2) * t.height) / t.width)) / D2R, 40, 60);
    return {
      x: mercX(p.lon), y: mercY(p.lat), alt: p.underground ? smooth.alt : Math.max(smooth.alt, groundAt([p.lon, p.lat]) + CLEARANCE),
      bearing: smooth.heading + look.yaw, pitch: look.pitch, zoom: rideZoom, fov,
    };
  }

  function blend(a, b, s) {
    const mix = (u, v) => u + (v - u) * s;
    return {
      x: mix(a.x, b.x), y: mix(a.y, b.y), alt: mix(a.alt, b.alt), bearing: a.bearing + angleDiff(b.bearing, a.bearing) * s,
      pitch: mix(a.pitch, b.pitch), zoom: mix(a.zoom, b.zoom), fov: mix(a.fov, b.fov),
    };
  }

  // Kutsutaan joka ruudussa ennen piirtoa, kun kulkuneuvot on siirretty (transit.js).
  function update(p) {
    if (!saved) return;
    const now = performance.now(), dt = Math.min(now - lastAt, 500);
    lastAt = now;
    if (!p && !leaving) leave(endView(), "Vuoro päättyi, joten poistuit kyydistä.");
    let target;
    if (leaving) target = leaving.cam;
    else { pose = p; target = rideCam(p, dt); }
    let c = target;
    if (anim) {
      const t = (now - anim.t0) / anim.ms;
      if (t < 1) c = blend(anim.from, target, ease(t));
      else {
        anim = null;
        if (leaving) { restore(leaving.view, leaving.note); return; }
      }
    }
    apply(c);
  }

  // Näkymä, johon noustaan, kun kulkuneuvo katoaa: viimeisen sijainnin yläpuolelta samaan suuntaan.
  const endView = () => ({
    center: { lng: pose.lon, lat: pose.lat }, zoom: 16.5, pitch: 55,
    bearing: wrap(cam?.bearing ?? 0), fov: saved.view.fov,
  });

  function leave(view, note = null) {
    if (!saved || leaving) return;
    leaving = { view, note, cam: viewCam(view, groundAt(view.center)) };
    anim = { from: cam ?? viewCam(currentView(), map.transform.elevation), t0: performance.now(), ms: duration(EXIT_MS) };
    drag = null;
    exitButton.disabled = true;
  }

  // Kartan asetukset takaisin; view: näkymä, johon jäädään (muuten nykyinen).
  function restore(view, note = null) {
    const s = saved;
    saved = leaving = anim = drag = smooth = pose = cam = want = null;
    map.transformCameraUpdate = s.cameraUpdate;
    map._elevationFreeze = false;
    map.transform.fov = s.view.fov;
    if (updateHash) map.on("moveend", updateHash);
    if (view) {
      map.transform.elevation = groundAt(view.center); // MapLibre tarkistaa kameran korkeuden tällä
      map.jumpTo({ center: view.center, zoom: view.zoom, pitch: Math.min(view.pitch, s.maxPitch), bearing: view.bearing });
    }
    map.setMaxPitch(s.maxPitch);
    for (const h of s.handlers) map[h].enable();
    container.classList.remove("riding");
    box.classList.remove("looking");
    if (s.closedPanel) document.body.classList.remove("panel-closed");
    if (note) showBar(note);
    else bar.hidden = true;
    onEnd();
  }

  // ------------------------------------------------------------ katseen kääntäminen

  const refresh = () => { if (pose && !leaving) update(pose); };

  function turn(dYaw, dPitch) {
    look.yaw = clamp(look.yaw + dYaw, -YAW_LIMIT, YAW_LIMIT);
    look.pitch = clamp(look.pitch + dPitch, MIN_PITCH, MAX_PITCH);
    refresh();
  }

  // Vetäminen siirtää maisemaa sormen mukana: oikealle vetäminen kääntää katsetta vasemmalle.
  // Vedon jälkeen hiiren klikkaus ohitetaan, jottei se valitse kohdalle osunutta kulkuneuvoa
  // (MapLibren klikkauksen siirtymäraja nollautuu, kun kamera asetetaan joka ruudussa).
  let dragged = false;
  box.addEventListener("pointerdown", (e) => {
    if (!saved || leaving || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
    dragged = false;
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = map.transform.fov / map.transform.height; // astetta pikseliä kohden
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 4) dragged = true;
    box.classList.add("looking");
    turn(-dx * k, dy * k);
  });
  // Kaksoisnapautus tai -klikkaus kääntää katseen takaisin kulkusuuntaan.
  let lastTap = null;
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { x, y } = drag, now = performance.now();
    drag = null;
    box.classList.remove("looking");
    if (e.type !== "pointerup" || dragged) return;
    if (lastTap && now - lastTap.t < 350 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
      lastTap = null;
      look.yaw = 0;
      look.pitch = look.home;
      refresh();
    } else lastTap = { t: now, x, y };
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) box.addEventListener(type, endDrag);
  container.addEventListener("click", (e) => {
    if (dragged && box.contains(e.target)) e.stopPropagation();
    dragged = false;
  }, true);
  window.addEventListener("keydown", (e) => {
    if (!saved || leaving || e.target.closest?.("input, select, textarea")) return;
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 4], ArrowDown: [0, -4] }[e.key];
    if (e.key === "Escape") exit();
    else if (step) turn(...step);
    else return;
    e.preventDefault();
  });

  // ------------------------------------------------------------ julkinen rajapinta

  return {
    get active() { return saved != null; },
    update,
    setInfo(node) { if (saved && !leaving) info.replaceChildren(node); },
    // Kyytiin (tai kyydissä toiseen kulkuneuvoon): kamera siirtyy nykyisestä paikastaan keulaan.
    start(p, node) {
      if (!p) return;
      if (!saved) {
        saved = {
          view: currentView(), maxPitch: map.getMaxPitch(), handlers: HANDLERS.filter((h) => map[h]?.isEnabled()),
          cameraUpdate: map.transformCameraUpdate,
          closedPanel: matchMedia("(max-width: 700px)").matches && !document.body.classList.contains("panel-closed"),
        };
        for (const h of saved.handlers) map[h].disable();
        if (updateHash) map.off("moveend", updateHash);
        map.transformCameraUpdate = () => want ?? {};
        map.transform.maxPitch = MAX_PITCH;
        container.classList.add("riding");
        if (saved.closedPanel) document.body.classList.add("panel-closed"); // kapealla näytöllä paneeli peittäisi näkymän
      }
      anim = { from: cam ?? viewCam(currentView(), map.transform.elevation), t0: performance.now(), ms: duration(ENTER_MS) };
      leaving = smooth = null;
      zoomHeight = null;
      look = { yaw: 0, pitch: p.pitch ?? DEFAULT_PITCH, home: p.pitch ?? DEFAULT_PITCH };
      lastAt = performance.now();
      exitButton.disabled = false;
      info.replaceChildren(node);
      showBar(null);
      update(p);
    },
    // Poistu-nappi ja Esc: takaisin näkymään, josta kyytiin hypättiin.
    exit,
    // Heti pois kyydistä ilman siirtymää (esim. paneelista valittu paikka lennättää kartan muualle).
    stop() { if (saved) restore(null); },
  };

  function exit() {
    if (saved) leave(saved.view);
  }
}
