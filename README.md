# Espoo 3D

Selaimessa toimiva 3D-kartta Espoosta. Siinä yhdistyvät maasto, rakennukset,
kaavoitus, vedet, maaperä, luonto, väestö ja liikenne, ja kaikki tieto tulee
avoimista lähteistä.

## Käynnistys

```bash
python3 server.py
```

Avaa sitten http://localhost:8765. Kartta tarvitsee verkkoyhteyden, koska
ilmakuvat, karttakuvat ja korkeusmalli haetaan suoraan lähdepalveluista.

## Aineistojen päivitys

```bash
python3 scripts/build_data.py
```

Skripti lataa aineistot Espoon ja HSY:n rajapinnoista kansioon `cache/`,
muuntaa ne GeoJSONiksi (`data/`) ja tekee niistä vektoritiilet
(`public/tiles/`). Tiilitykseen tarvitaan
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe`).
Jos haluat ladata aineistot uudelleen, poista ensin `cache/`. Yksittäisen
aineiston voi päivittää nimellä, esim. `python3 scripts/build_data.py
maankaytto tiilet`. Kansiot `cache/` ja `data/` eivät ole versionhallinnassa;
valmiit tiilet ovat.

## Julkaisu (Netlify)

Netlify julkaisee `public/`-kansion sellaisenaan aina, kun GitHubin `main`-haaraan
tulee muutos. Asetukset ovat tiedostossa `netlify.toml`: build-komentoa ei ole, ja
HSY:n karttakuvat välitetään reitin `/proxy/hsy/wms` kautta samoin kuin paikallisesti.
Jos kartta julkaistaan palvelussa, jossa välitystä ei ole (esim. GitHub Pages), HSY:n
kolme tasoa näkyvät harmaina ja muu kartta toimii normaalisti.

Vektoritiilet ovat gzip-pakattuja, ja selain purkaa ne itse (`app.js`), joten
palvelimen ei tarvitse lähettää `Content-Encoding`-otsaketta.

## Lähteet

| Aineisto | Lähde |
|---|---|
| Rakennukset (pohja ja mitattu korkeus, LOD0) | Espoo WFS `bldg:building_lod0` |
| Asemakaavat, käyttötarkoitukset, kaavahankkeet | Espoo WFS `GIS:*` |
| Vedet, luontokohteet, sulfaattimaat, liikennemäärät, aluejaot | Espoo WFS `GIS:*` |
| Ilmakuvat 1950–2026, opaskartat, vanhat kartat, kaava-, melu- ja kiinteistökartat | Espoo WMS |
| Maalajit 1:20 000 ja 1:200 000 | GTK WMS |
| Väestöruudukko 250 m (2025) | HSY WFS |
| Maanpeite, aurinkosähköpotentiaali, hiilinielut | HSY WMS (palvelimen välityksellä) |
| Korkeusmalli 2 m | Maanmittauslaitos (CC BY 4.0), tiilet: Mapterhorn |

Espoon rajapinnoissa on myös tunnuksia vaativia aineistoja, joita ei käytetä:
kaavayksiköt, yleiskaavat, viher- ja katualueet, Espoon oma maaperä-, rakennettavuus-
ja savisyvyyskartta, liito-oravat, johtokartat sekä vääräväri-ilmakuva.

## Huomioita aineistosta

- Espoon WFS tulkitsee BBOX-rajauksen samassa koordinaatistossa kuin `srsName`-tulosteen.
- Kun tuloste pyydetään EPSG:3857:nä, osa rakennusten kärkipisteistä jää ETRS-GK25-
  koordinaateiksi, ja osa on roskaa (INF tai lähellä nollaa). `build_data.py` muuntaa
  GK25-pisteet itse JHS 154 -kaavoilla ja jättää roskapisteet pois.
- Rakennusten vuosi 1900 on aineistossa tuntemattoman vuoden paikka-arvo, joten se jätetään tyhjäksi.

## Rakenne

- `server.py`: paikallinen palvelin, joka jakaa `public/`-kansion ja välittää HSY:n WMS-pyynnöt
- `netlify.toml`: julkaisuasetukset
- `scripts/build_data.py`: aineistojen lataus ja muunnos
- `public/layers.js`: tasojen, värien ja selitteiden määrittelyt
- `public/app.js`: kartta ja käyttöliittymä (MapLibre GL JS)
