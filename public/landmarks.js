// Maamerkkien 3D-mallit (määrittelyt: layers.js, LANDMARKS). Mallit ovat paikallisissa metreissä:
// x itään, y pohjoiseen, z ylös, origo maanpinnalla rakennuksen keskellä.
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.min.js";

// Pyörähdyskappale profiilista [[säde, korkeus], ...] (z-akselin ympäri).
function lathe(profile, color, segments = 64) {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), segments);
  g.rotateX(Math.PI / 2); // LatheGeometry pyörittää y-akselin ympäri; meillä ylös on z
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
}

// Pallokalotin profiili: pohjan säde a, korkeus h, alin (tai ylin) kohta korkeudella z0.
function cap(a, h, z0, { up = false, from = 0, steps = 24 } = {}) {
  const R = (a * a + h * h) / (2 * h), pts = [];
  for (let i = 0; i <= steps; i++) {
    const r = from + ((a - from) * i) / steps, dz = R - Math.sqrt(R * R - r * r);
    pts.push([r, up ? z0 - dz : z0 + dz]);
  }
  return pts;
}

// Haukilahden vesitorni (1968): 45,3 m korkea "lentävä lautanen". Keskivarren halkaisija 5,7 m ja
// ympärillä kuusi 1,5 metrin pilaria; säiliö on kahdesta pallokalotista (halkaisijat 40 ja 45 m)
// koottu lautanen, jonka päällä on pyöreä näköalaravintola ja pallokupoli. Lähteet: Wikipedia
// (Haukilahti water tower) ja Docomomo Suomi. Kalottien korkeutta ei ole julkaistu, joten
// lautasen paksuus on arvio.
function haukilahdenVesitorni() {
  const group = new THREE.Group();
  const concrete = 0xcfcfc8, light = 0xe6e6e0, white = 0xf2f2ee, glass = 0x2b3a46;
  const bottom = 30, rim = 39; // lautasen alin kohta varren kohdalla ja reunan alareuna
  group.add(lathe([[2.85, 0], [2.85, bottom + 0.4]], concrete)); // keskivarsi
  const underside = cap(22.5, rim - bottom, bottom, { from: 2.85 });
  group.add(lathe(underside, light)); // lautasen kaareva alapinta
  group.add(lathe([[22.5, rim], [22.6, rim + 0.6], [22.4, rim + 1.2]], white)); // reunus
  group.add(lathe([[22.4, rim + 1.2], [17, rim + 1.7], [12.8, rim + 2.0]], concrete)); // terassi
  group.add(lathe([[12.5, rim + 2.0], [12.5, rim + 4.3]], glass, 48)); // ravintolan ikkunarivi
  group.add(lathe([[13.1, rim + 4.3], ...cap(13.1, 2.0, 45.3, { up: true, steps: 16 }).reverse()], white)); // kupoli
  // Kuusi tukipilaria keskivarren ympärillä, alapinnan kohtaan asti.
  const R = (22.5 ** 2 + (rim - bottom) ** 2) / (2 * (rim - bottom));
  const pillarTop = bottom + R - Math.sqrt(R * R - 6.5 * 6.5);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, pillarTop, 12),
      new THREE.MeshLambertMaterial({ color: concrete }));
    pillar.rotation.x = Math.PI / 2;
    pillar.position.set(6.5 * Math.cos(a), 6.5 * Math.sin(a), pillarTop / 2);
    group.add(pillar);
  }
  return group;
}

// Pystysuora prisma tai lieriö (z-akselin suuntaan) korkeudelta z0 korkeudelle z1.
function prism(rTop, rBottom, z0, z1, segments, color, { open = false } = {}) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, z1 - z0, segments, 1, open);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  m.position.z = (z0 + z1) / 2;
  return m;
}

// Laatikko keskipisteestä (x, y), koko (w × d), korkeudelta z0 korkeudelle z1, kierto z-akselin ympäri.
function block(x, y, w, d, z0, z1, color, rot = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, z1 - z0), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, (z0 + z1) / 2);
  m.rotation.z = rot;
  return m;
}

// Monikulmion muotoinen kappale (pohja [[x, y], ...]) korkeudelta z0 korkeudelle z1.
function extruded(points, z0, z1, color, scale = 1) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x * scale, y * scale)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  m.position.z = z0;
  return m;
}

// Otaniemen vesitorni (Alvar Aalto, 1970–72), 52 m korkea. Alhaalla viisikerroksinen,
// vapaamuotoinen huippulämpökeskus- ja toimistorakennus; sen yläpuolella 12-kulmainen vesisäiliö,
// jonka pohja on kartio ja jota kantaa 12 suorakaiteen muotoista betonipylvästä (ne jatkuvat
// säiliön kyljessä pilastereina yläreunaan asti). Säiliön alla säteittäiset palkit ja keskellä
// kierreportaan ja hissin lieriö. Säiliön päällä matala viuhkamainen toimistokerros ja tumma
// antennimittaustorni, vieressä suorakaiteen muotoinen betonipiippu. Lähteet: Otaniemen
// vesitornin rakennushistoriaselvitys (ark-byroo 2017) ja Espoon LOD2-malli (säiliön halkaisija
// noin 35 m, yläreuna 44 m maasta). Piipun paikka ja alaosan muoto on arvioitu valokuvista.
function otaniemenVesitorni() {
  const group = new THREE.Group();
  const concrete = 0xc9c9c2, lower = 0xa9a8a1, planks = 0xe2e0d8, wood = 0x8c8b84, dark = 0x3a3f44, glass = 0x2b3a46;
  const R = 17.5, bottom = 24, belly = 30, top = 44; // säiliön ulkokulmien säde ja korkeudet (m)
  // Alaosa: vapaamuotoinen monikulmio, ikkunanauhat 4. ja 5. kerroksessa.
  const base = [[-13, -9], [-6, -14], [7, -13], [13, -6], [14, 5], [8, 12], [-5, 13], [-12, 7]];
  group.add(extruded(base, 0, 19, lower));
  group.add(extruded(base, 13.2, 14.6, glass, 1.012));
  group.add(extruded(base, 16.3, 17.7, glass, 1.012));
  group.add(prism(4.5, 4.5, 0, top, 24, concrete)); // kierreportaan ja hissin lieriö
  group.add(prism(R, 5, bottom, belly, 12, wood)); // säiliön kartiopohja (harmaa lautaverhous)
  group.add(prism(R, R, belly, top, 12, planks)); // säiliö
  for (const z of [33.5, 37, 40.5]) group.add(prism(R + 0.08, R + 0.08, z, z + 0.25, 12, wood, { open: true })); // lankkusaumat
  // CylinderGeometryn kulmat ovat kulmissa i·30° (0° = etelä); pylväät kulmiin.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, x = R * Math.sin(a), y = -R * Math.cos(a);
    group.add(block(x, y, 1.4, 2.4, 0, top + 1, concrete, a));
    const r = (4.5 + R) / 2; // säteittäinen palkki säiliön alla
    group.add(block(r * Math.sin(a), -r * Math.cos(a), 0.8, R - 4.5, bottom - 1.6, bottom, concrete, a));
  }
  // Viuhkamainen toimistokerros säiliön päällä (koilliseen) ja antennimittaustorni.
  const fan = [[-5, -4]];
  for (let k = 0; k <= 8; k++) {
    const a = ((15 + (k / 8) * 75) * Math.PI) / 180;
    fan.push([-5 + 17 * Math.cos(a), -4 + 17 * Math.sin(a)]);
  }
  group.add(extruded(fan, top, top + 2.6, concrete));
  group.add(extruded(fan, top + 0.9, top + 2.0, glass, 1.01));
  group.add(block(2, 3, 4, 4, top + 2.6, 52, dark));
  group.add(block(8, 20, 7, 4, 0, 48, concrete)); // huippulämpökeskuksen piippu
  return group;
}

export const LANDMARK_MODELS = {
  haukilahden_vesitorni: haukilahdenVesitorni,
  otaniemen_vesitorni: otaniemenVesitorni,
};

// Maamerkki Espoon 3D-kaupunkimallista (LOD2) (scripts/build_data.py, build_landmarks). Malli
// väritetään kuten muut rakennukset (setLandmarkStyle, app.js): seinät rakennuksen värillä ja
// katot hieman tummempina kuten roofs.js:n katoissa. Mallin origo ja korkeus tulevat tiedostosta.
const ROOF_SHADE = 0.78;
const lod2Landmarks = [];
let landmarkStyle = { colorOf: () => "#bdbdbd", isVisible: () => true };

// Väritys ja näkyvyys samoin kuin muissa rakennuksissa.
export function setLandmarkStyle(style) {
  landmarkStyle = style;
  for (const l of lod2Landmarks) paintLandmark(l);
}

function paintLandmark({ mesh, building, kinds }) {
  if (!mesh) return;
  mesh.visible = landmarkStyle.isVisible(building);
  const c = new THREE.Color(landmarkStyle.colorOf(building)), col = mesh.geometry.attributes.color;
  for (let i = 0; i < kinds.length; i++) {
    const s = kinds[i] === 0 ? ROOF_SHADE : 1;
    col.setXYZ(i, c.r * s, c.g * s, c.b * s);
  }
  col.needsUpdate = true;
}

export function lod2Landmark(entry) {
  const group = new THREE.Group(), record = { mesh: null, building: null, kinds: null };
  lod2Landmarks.push(record);
  fetch(entry.lod2).then((r) => r.json()).then((data) => {
    entry.lon = data.lon;
    entry.lat = data.lat;
    group.userData.anchor = data.korkeus * 0.7;
    const pos = [], idx = [], kinds = [];
    for (const [kind, v, tri] of data.pinnat) {
      const base = pos.length / 3;
      for (const c of v) pos.push(c / 10);
      for (let i = 0; i < v.length; i += 3) kinds.push(kind);
      for (const i of tri) idx.push(base + i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    g.setIndex(idx);
    g.computeVertexNormals(); // kullakin pinnalla omat kärkipisteet: pinnan normaali
    // Pinnat voivat olla kumpaan suuntaan tahansa kierrettyjä, joten molemmat puolet piirretään.
    record.mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    record.building = { tunnus: String([entry.building].flat()[0]), luokka: data.luokka, vuosi: data.vuosi, korkeus: data.rakennuskorkeus };
    record.kinds = kinds;
    group.add(record.mesh);
    group.userData.box = null; // klikkausalue lasketaan uudelleen (transit.js)
    paintLandmark(record);
  }).catch((err) => console.warn("Maamerkin mallia ei saatu ladattua", entry.id, err));
  return group;
}
