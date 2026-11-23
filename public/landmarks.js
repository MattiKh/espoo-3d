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

export const LANDMARK_MODELS = {
  haukilahden_vesitorni: haukilahdenVesitorni,
};
