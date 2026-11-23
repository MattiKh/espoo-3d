# Espoo 3D

Selaimessa toimiva 3D-kartta Espoosta. Siinä yhdistyvät maasto, rakennukset,
kaavoitus, vedet, maaperä, luonto, väestö ja liikenne, ja kaikki tieto tulee
avoimista lähteistä. Espoon bussit, raitiovaunut, junat ja metro liikkuvat kartalla
reaaliajassa 3D-malleina.

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

Skripti lataa aineistot Espoon, HSY:n ja Tilastokeskuksen rajapinnoista kansioon `cache/`,
muuntaa ne GeoJSONiksi (`data/`) ja tekee niistä vektoritiilet
(`public/tiles/`). Siltojen tiedot tallentuvat tiedostoon `public/data/sillat.json` ja
metroradat tiedostoon `public/data/metro.json`. Tiilitykseen tarvitaan
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
| Puuttuvat rakennukset (pohja, kerrosluku) | Espoo WFS `GIS:Rakennukset` |
| Asemakaavat, käyttötarkoitukset, kaavahankkeet | Espoo WFS `GIS:*` |
| Vedet, luontokohteet, sulfaattimaat, liikennemäärät, aluejaot | Espoo WFS `GIS:*` |
| Ilmakuvat 1950–2026, opaskartat, vanhat kartat, kaava-, melu- ja kiinteistökartat | Espoo WMS |
| Maalajit 1:20 000 ja 1:200 000 | GTK WMS |
| Väestöruudukko 250 m (2025) | HSY WFS |
| Maanpeite, aurinkosähköpotentiaali, hiilinielut | HSY WMS (palvelimen välityksellä) |
| Korkeusmalli 2 m | Maanmittauslaitos (CC BY 4.0), tiilet: Mapterhorn |
| Bussien, raitiovaunujen, lähijunien ja metron sijainnit | HSL:n HFP-rajapinta (MQTT, CC BY 4.0) |
| Kauko- ja tavarajunien sijainnit ja tiedot | Fintraffic / Digitraffic (MQTT ja REST, CC BY 4.0) |
| Espoon ja Kauniaisen raja (ajoneuvojen rajaus) | Tilastokeskus, kunnat 1:1 000 000 |
| Siltojen reunaviivat ja kansien korkeudet | Espoo WFS `kanta:Silta` (kantakartta) |
| Länsimetron raiteet | © OpenStreetMap-tekijät (ODbL), Overpass API |

Espoon rajapinnoissa on myös tunnuksia vaativia aineistoja, joita ei käytetä:
kaavayksiköt, yleiskaavat, viher- ja katualueet, Espoon oma maaperä-, rakennettavuus-
ja savisyvyyskartta, liito-oravat, johtokartat sekä vääräväri-ilmakuva.

## Huomioita aineistosta

- Espoon WFS tulkitsee BBOX-rajauksen samassa koordinaatistossa kuin `srsName`-tulosteen.
- Kun tuloste pyydetään EPSG:3857:nä, osa rakennusten kärkipisteistä jää ETRS-GK25-
  koordinaateiksi, ja osa on roskaa (INF tai lähellä nollaa). `build_data.py` muuntaa
  GK25-pisteet itse JHS 154 -kaavoilla ja jättää roskapisteet pois.
- Rakennusten vuosi 1900 on aineistossa tuntemattoman vuoden paikka-arvo, joten se jätetään tyhjäksi.
- Rakennusten 3D-mallista (LOD0) puuttuu kokonaisia alueita, esimerkiksi Etelä-Leppävaaran
  ja Laajalahden pientaloalueita. Puuttuvat rakennukset täydennetään rakennusrekisteristä
  (`GIS:Rakennukset`), ja niiden korkeus arvioidaan kerrosluvusta: arvona käytetään mallissa
  olevien saman kerrosluvun rakennusten mitattujen korkeuksien mediaania. Kohteen tiedoissa
  näkyy silloin "Korkeus (m, arvio)".

## Joukkoliikenne reaaliajassa

Selain tilaa sijainnit suoraan HSL:n ja Digitrafficin MQTT-palveluista (`public/transit.js`),
eikä niihin tarvita avainta tai välityspalvelinta. Kartalle otetaan ajoneuvot, jotka ovat
Espoossa tai Kauniaisissa tai enintään 300 metrin päässä niiden rajasta.

- Ajoneuvot näytetään noin kaksi sekuntia (Digitrafficin junat yhdeksän sekuntia) todellista
  sijaintia jäljessä. Näin liike voidaan laskea tunnettujen sijaintien väliltä monotonisella
  kuutiollisella interpoloinnilla, ja lopuksi se vielä pehmennetään. Ajoneuvojen ja selaimen
  kellojen ero arvioidaan hitaasti kaikista viesteistä, jottei arvion muutos nytkäytä ajoneuvoja.
- Vaunut seuraavat keulan kulkemaa reittiä, joten nivelraitiovaunut ja junat kaartavat.
- HSL:n lähijunat tulevat HFP-syötteestä, joten Digitrafficista otetaan vain kauko- ja tavarajunat.
- Metro kulkee Espoossa tunnelissa. Junat pidetään OpenStreetMapin raiteilla ja piirretään
  läpikuultavina tunneliputkien sisään yhdelle tasolle (−15 m N2000) maanpinnan muodoista
  riippumatta. Metro ja tunnelit piirretään ennen rakennuksia ilman syvyystestiä, joten ne
  näkyvät maaston läpi, mutta rakennukset peittävät ne.
- Metron sijainti tulee kulunvalvonnasta, ja se päivittyy noin 50 metrin askelin 2,5–3 sekunnin
  välein; välissä syöte toistaa edellistä sijaintia. Toistot ohitetaan (liikkuva juna samassa
  paikassa), ja metro näytetään seitsemän sekuntia jäljessä, jotta liike voidaan laskea askelten
  väliltä tasaiseksi.
- Kaukaa katsottaessa ajoneuvot ovat pisteitä, jotka piirretään joka ruudussa samasta tasoitetusta
  sijainnista kuin mallit, joten nekin liikkuvat pehmeästi.
- Linjanumerot ovat karttakuvan päällä olevia läpikuultavia elementtejä, joita siirretään joka
  ruudussa ajoneuvon mukana.
- Lähikuvassa tilataan vain näkymän ympäristön HFP-ruudut. Taustalle jääneen välilehden
  yhteydet suljetaan 30 sekunnin kuluttua.

## Sillat

Maanmittauslaitoksen korkeusmallista sillat on poistettu, joten ilmakuvan tie notkahti sillan
kohdalla alla olevan tien tai joen tasolle, ja ajoneuvot sukelsivat mukana. Espoon kantakartan
siltojen reunaviivoissa on kannen mitattu korkeus. `build_data.py` muodostaa niistä kansialueet:
kannen reunoiksi tulkitaan samansuuntaiset, samalla korkeudella olevat viivat 3–40 metrin päässä
toisistaan. Selain nostaa korkeusmallin tiilet kansialueilla kannen tasolle (`public/bridges.js`)
ja muistaa alkuperäisen maanpinnan korkeuden.

Ajoneuvo pysyy kannella, jos se tuli sillalle kannen korkeudelta, esimerkiksi penkereeltä.
Sillan ali kulkeva ajoneuvo lähestyi alempaa ja pysyy alla olevan tien tasolla.

## Rakenne

- `server.py`: paikallinen palvelin, joka jakaa `public/`-kansion ja välittää HSY:n WMS-pyynnöt
- `netlify.toml`: julkaisuasetukset
- `scripts/build_data.py`: aineistojen lataus ja muunnos
- `public/layers.js`: tasojen, värien ja selitteiden määrittelyt
- `public/app.js`: kartta ja käyttöliittymä (MapLibre GL JS)
- `public/transit.js`: reaaliaikaiset ajoneuvot, liikkeen tasoitus ja 3D-mallit (three.js)
- `public/bridges.js`: siltakansien nosto korkeusmalliin ja kannen korkeus ajoneuvoille
