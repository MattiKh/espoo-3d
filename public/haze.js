// Utu: kaukainen maisema hälvenee ilman väriin. MapLibren oma sumu koskee vain maastoa (ilmakuvaa
// ja karttoja), ei 3D-rakennuksia eikä 3D-tason kohteita (kulkuneuvot, katot, maamerkit), joten ne
// näkyivät kaukana terävinä utuisen maan päällä. Tämä utu on karttakuvan päällä oleva liukuväri:
// se koskee kaikkea karttaan piirrettyä, mutta linjanumerot, merkit ja ponnahdusikkunat jäävät
// sen päälle.
//
// Kunkin näytön rivin utu lasketaan sen kohdan etäisyydestä, kun maa oletetaan tasaiseksi. Rivi,
// joka on kulman α katselusuunnan yläpuolella, osuu maahan matkan h / tan(β − α) päähän, kun h on
// kameran korkeus ja β katselusuunnan kulma vaakatason alapuolella. Taivaalla utu häviää vähitellen.

const EARTH_CIRC = 40075016.686;
const START = 1000; // m: utu alkaa tätä kauempana
const SCALE = 6000; // m: utu tihenee eksponentiaalisesti tällä mittakaavalla
const MAX = 0.8; // peittävyys horisontissa
const SKY_FADE = 0.1; // taivaalla utu häviää tämän osan matkalla näytön korkeudesta
const ROWS = 16; // liukuvärin pisteet horisontista näytön alareunaan

export function addHaze(map, color) {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;pointer-events:none;";
  map.getCanvas().after(el); // merkit ja ponnahdusikkunat lisätään piirtopinnan perään, joten ne jäävät udun päälle
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const rgba = (a) => `rgba(${r},${g},${b},${a.toFixed(3)})`;
  let last = "";

  function update() {
    const t = map.transform, H = t.height, f = t.cameraToCenterDistance;
    const beta = Math.PI / 2 - (t.pitch * Math.PI) / 180;
    const mpp = (EARTH_CIRC * Math.cos((t.center.lat * Math.PI) / 180)) / (512 * 2 ** t.zoom);
    const h = f * mpp * Math.sin(beta); // kameran korkeus kartan keskipisteen tasosta (m)
    const cy = H / 2;
    const sky = cy - t.getHorizon(); // MapLibre piirtää taivaan tämän rivin yläpuolelle
    const haze = (y) => {
      const depression = beta - Math.atan((cy - y) / f);
      if (depression <= 0) return MAX;
      const d = h / Math.tan(depression);
      return MAX * (1 - Math.exp(-Math.max(0, d - START) / SCALE));
    };
    const top = Math.max(sky, -H); // horisontti voi olla kaukana näytön yläpuolella
    const stops = [`${rgba(0)} ${(sky - SKY_FADE * H).toFixed(0)}px`, `${rgba(haze(sky))} ${sky.toFixed(0)}px`];
    for (let i = 1; i <= ROWS; i++) {
      const y = top + (H - top) * (i / ROWS) ** 2; // tiheämmin horisontin lähellä
      stops.push(`${rgba(haze(y))} ${y.toFixed(0)}px`);
    }
    const bg = `linear-gradient(to bottom, ${stops.join(", ")})`;
    if (bg !== last) el.style.background = last = bg;
  }

  map.on("move", update);
  map.on("resize", update);
  update();
}
