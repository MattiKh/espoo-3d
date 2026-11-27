# Espoo 3D

Selaimessa toimiva 3D-kartta Espoosta. Siinä yhdistyvät maasto, rakennukset,
kaavoitus, vedet, väestö ja liikenne, ja kaikki tieto tulee avoimista lähteistä.
Espoon bussit, raitiovaunut, junat ja metro, Espoon vesillä liikkuvat alukset sekä Espoon
yllä lentävät koneet liikkuvat kartalla aina reaaliajassa 3D-malleina, ja latauksessa olevat
sähköautot näkyvät latauspaikoillaan. Bussin, raitiovaunun, junan, metron tai lautan kyytiin voi
hypätä klikkaamalla, jolloin kartta seuraa kulkuneuvoa yläpuolelta menosuunta ylöspäin.

## Paneeli

- Liikenne näkyy aina; paneelissa näkyy ajoneuvojen ja lentokoneiden määrä lajeittain.
- Aineistoja on neljätoista: kaupunginosien nimet, asemakaavan käyttötarkoitukset, vireillä
  olevat kaavat, ajantasa-asemakaava, maankäyttökartta, purot ja joet, asukkaat 250 m ruuduissa
  (3D), autoliikenne, tie- ja raideliikenteen melu, kiinteistörajat, kantakartan maastotiedot,
  sadetutka ja kelikamerat. Oletuksena päällä ovat kaupunginosien nimet, purot ja joet, sadetutka
  ja kelikamerat.
  Vedet ovat maaston pinnassa (HSY:n maanpeite), joten erillistä vesialuetasoa ei ole.
  Määrittelyt ovat tiedostossa `public/layers.js` (`LAYERS`).
- Kaupunginosan nimi on alueen rakennusten keskellä, koska kaupunginosien rajat ulottuvat
  usein merelle (`kaupunginosat_nimet.geojson`, `build_data.py kaupunginosat`).
- Kauniainen on oma kaupunkinsa Espoon sisällä: raja näkyy aina katkoviivana, alue on hieman
  tummennettu ja nimi KAUNIAINEN näkyy alueen keskellä (`kauniainen.geojson`,
  `build_data.py kauniainen`). Raja on HSY:n seutukartasta, koska Tilastokeskuksen
  1:1 000 000 -raja on karkea; Kauniaisesta ei ole 3D-rakennuksia, koska ne tulevat Espoon
  aineistoista.
- Rakennusten värityksenä on käyttötarkoitus (oletus), valmistumisvuosi, korkeus tai luonnolliset
  värit (ks. Rakennusten värit). 3D-rakennukset ja 3D-puut voi ottaa pois samasta kohdasta.
- Pohjana on pelillinen maasto (ks. Pelillinen maasto): maanpeite tekstuureina, tiet viivoineen,
  3D-sillat ja metsissä 3D-puut. Puut voi ottaa pois (Rakennukset → 3D-puut metsissä tai osoite
  `?puut=0`). Aiemmin pohjana oli Espoon ilmakuva (vuodet 1976–2024); se poistettiin, kun
  pelillinen maasto kattoi koko Espoon.
- Sadetutka (Ilmatieteen laitos) näyttää sateen voimakkuuden (mm/h) pyöreäreunaisina alueina
  läpikuultavana (75 % läpinäkyvä) värikerroksena 50 m maanpinnan yläpuolella (`public/sadetutka.js`).
  Tutkakuva on 500 metrin ruudukko TM35FIN-koordinaatistossa; se haetaan WMS:stä kerran koko kartan
  alueelta niin, että yksi kuvapiste on yksi tutkan ruutu. Varjostin pehmentää ruudut (kuutiollinen
  B-spline) ja leikkaa reunan, joten yksittäinen ruutu on pyöreä läiskä ja värit liukuvat ruudusta
  toiseen. Pinta on 500 metrin verkko lähiympäristön korkeimman maanpinnan (Mapterhornin harva
  korkeusmalli, korostettuna kuten kartalla) yläpuolella, joten mäet eivät puhkaise sitä; yli
  50-metriset rakennukset nousevat sen läpi. Uusin kuva-aika luetaan kahden minuutin välein, ja aika on
  kuvan osoitteessa, jottei selain näytä vanhaa kuvaa.

## Käynnistys

```bash
python3 server.py
```

Avaa sitten http://localhost:8765. Kartta tarvitsee verkkoyhteyden, koska
karttakuvat ja korkeusmalli (siltojen kohtia lukuun ottamatta) haetaan suoraan
lähdepalveluista.

## Aineistojen päivitys

```bash
python3 scripts/build_data.py
```

Skripti lataa aineistot Espoon, HSY:n ja Tilastokeskuksen rajapinnoista kansioon `cache/`,
muuntaa ne GeoJSONiksi (`data/`) ja tekee niistä vektoritiilet
(`public/tiles/`). Siltojen tiedot tallentuvat tiedostoon `public/data/sillat.json` ja
raiteet tiedostoon `public/data/raiteet.json`, bussien ajotiet tiedostoon `public/data/ajotiet.json`
ja sähköautojen latauspaikat pysäköintiruutuineen
tiedostoon `public/data/lataus.json`. Rakennusten kaltevat katot tallentuvat kansioon
`public/tiles/katot` (`python3 scripts/build_data.py katot`; ensimmäinen ajo lataa koko
Espoon 3D-mallin, noin 2,5 Gt), ja rakennusten luonnolliset värit lasketaan saman mallin
valokuvista (`python3 scripts/build_data.py rakennusvarit`; ensimmäinen ajo hakee noin
172 000 pintakuvaa, noin kaksi tuntia). Tiilitykseen tarvitaan
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe`) ja siltojen
korkeusmallin tiiliin Pythonin numpy ja Pillow (`pip3 install numpy pillow`). Pelillisen
maaston aineistot tehdään komennolla `python3 scripts/build_data.py sillat maanpeite` (sillat ensin,
sillä viivat tarkistetaan pelillisen korkeusmallin pinnasta). Ensimmäinen ajo hakee HSY:ltä noin
4 000 maanpeiteruutua (noin 30 min), Espoon WFS:stä kantakartan viivat ja OpenStreetMapista väylät
(Overpass, ruuhkassa jopa tunti); välimuistista koko ajo vie noin 40 min. Pelkät viivat ja sillat
(maanpeite valmiina) tekee `python3 scripts/build_data.py pelimaasto` (noin 2 min välimuistista).
Jos haluat ladata aineistot uudelleen, poista ensin `cache/`. Yksittäisen
aineiston voi päivittää nimellä, esim. `python3 scripts/build_data.py
maankaytto tiilet`. Kansiot `cache/` ja `data/` eivät ole versionhallinnassa;
valmiit tiilet ovat.

## Julkaisu (Netlify)

Netlify julkaisee `public/`-kansion sellaisenaan aina, kun GitHubin `main`-haaraan
tulee muutos. Asetukset ovat tiedostossa `netlify.toml`: build-komentoa ei ole.
Lentokoneiden sijainnit (adsb.fi) välitetään reitin `/proxy/adsb/...` kautta, koska palvelu ei
salli selaimen suoria hakuja; `server.py` tekee saman paikallisesti. Jos kartta julkaistaan
palvelussa, jossa välitystä ei ole (esim. GitHub Pages), lentokoneita ei näy, mutta muu kartta
toimii.

Vektoritiilet ovat gzip-pakattuja, ja selain purkaa ne itse (`app.js`), joten
palvelimen ei tarvitse lähettää `Content-Encoding`-otsaketta.

## Lähteet

| Aineisto | Lähde |
|---|---|
| Rakennukset (pohja ja mitattu korkeus, LOD0) | Espoo WFS `bldg:building_lod0` |
| Kaltevat katot ja epäilyttävien korkeuksien korjaus (kattopinnat, LOD2) | Espoo WFS `bldg:building_lod2` |
| Puuttuvat rakennukset (pohja, kerrosluku) | Espoo WFS `GIS:Rakennukset` |
| Rakennuksen lisätiedot (kerrosala, tilavuus, lämmitys ym.) klikattaessa | Espoo WFS `GIS:Rakennukset` |
| Asemakaavan käyttötarkoitukset, vireillä olevat kaavat, autoliikennemäärät | Espoo WFS `GIS:*` |
| Ajantasa-asemakaava, maankäyttökartta, melu, kiinteistörajat, kantakartta | Espoo WMS |
| Sadetutka, sateen voimakkuus (mm/h) | Ilmatieteen laitos, avoin WMS (CC BY 4.0) |
| Purot ja joet, virtaussuunnat ja rummut | © OpenStreetMap-tekijät (ODbL), Overpass API |
| Purojen sijainnin tarkistus (vesialueiden keskilinja) | HSY:n maanpeite 2024, WFS |
| Valuma-alueet ja niiden purkupisteet (yläpuolinen valuma-ala) | Syke, valuma-aluejako (INSPIRE WFS, CC BY 4.0) |
| Espoonjoen virtaama (päiväarvot 1995 alkaen) | Syke, hydrologiarajapinta (CC BY 4.0) |
| Väestöruudukko 250 m (2025) | HSY WFS |
| Maanpeiteluokat (pelillinen maasto) | HSY:n maanpeiteaineisto 2024, WMS |
| Teiden reunaviivat ja kadunnimet (pelillinen maasto) | Espoo WFS `kanta:Liikennevayla`, `kanta:Kevyenliikenteenvayla`, `kanta:Polku`, `kanta:Paikannimi` |
| Korkeusmalli 2 m | Maanmittauslaitos (CC BY 4.0), tiilet: Mapterhorn |
| Bussien, raitiovaunujen, lähijunien ja metron sijainnit | HSL:n HFP-rajapinta (MQTT, CC BY 4.0) |
| Kauko- ja tavarajunien sijainnit ja tiedot | Fintraffic / Digitraffic (MQTT ja REST, CC BY 4.0) |
| Espoon ja Kauniaisen raja (ajoneuvojen rajaus) | Tilastokeskus, kunnat 1:1 000 000 |
| Kauniaisen raja kartalla | HSY:n seutukartta, kunnat 2021 (WFS) |
| Siltojen reunaviivat ja kansien korkeudet | Espoo WFS `kanta:Silta` (kantakartta) |
| Ajoväylien reunaviivat siltojen kohdalla (kansien täydennys, korkeusmallia uudemmat tiet) | Espoo WFS `kanta:Liikennevayla`, `kanta:Kevyenliikenteenvayla`; tiet © OpenStreetMap |
| Raiteiden keskilinjat korkeuksineen (kuoppien täyttö) | Espoo WFS `kanta:Raide` (kantakartta) |
| Alusten sijainnit, nimet, tyypit, mitat ja määränpäät | Fintraffic / Digitraffic AIS (REST, CC BY 4.0) |
| Lentokoneiden sijainnit, korkeudet, konetyypit | adsb.fi:n avoin ADS-B-rajapinta (välityspalvelimen kautta) |
| Lentojen reitit ja lentoyhtiöt | adsbdb.com (lentotunnuksen mukaan) |
| Haukilahden vesitornin muoto | Wikipedia (Haukilahti water tower), Docomomo Suomi |
| Otaniemen vesitornin muoto | Otaniemen vesitornin rakennushistoriaselvitys (ark-byroo 2017), Espoon LOD2-malli |
| Junien, metron ja raitiovaunujen raiteet ja pysähtymispaikat | © OpenStreetMap-tekijät (ODbL), Overpass API |
| Ajotiet, kaistamäärät ja yksisuuntaisuus (bussit ajoradan oikealle puolelle) | © OpenStreetMap-tekijät (ODbL), Overpass API |
| Sähköautojen latauspaikat ja latauspisteiden tila | Fintraffic / Digitraffic AFIR (REST, CC BY 4.0) |
| Tieliikenteen kelikamerat (sijainnit ja kuvat) | Fintraffic / Digitraffic weathercam (REST, CC BY 4.0) |
| Latausasemien sijainnit, pysäköintialueet, -ruudut ja tiet latauspaikkojen ympärillä | © OpenStreetMap-tekijät (ODbL), Overpass API |

Espoon rajapinnoissa on myös tunnuksia vaativia aineistoja, joita ei käytetä:
kaavayksiköt, yleiskaavat, viher- ja katualueet, Espoon oma maaperä-, rakennettavuus-
ja savisyvyyskartta, liito-oravat, johtokartat, vääräväri-ilmakuva, rakennusluvat,
rakennusvalvonnan aineistot sekä rakennusten kattoviivat.

## Huomioita aineistosta

- Rakennusten 3D-mallissa (LOD0) jokaisella rakennuksella on vain yksi korkeus, korkein
  mitattu kohta. Kirkon torni, jalustan päällä oleva tornitalo tai mittausvirhe (esim. nosturi)
  nostaa silloin koko rakennuksen liian korkeaksi; esim. Ahertajantie 4 oli 79 m, vaikka sen
  korkein kattopinta on noin 20 m. Rakennukset, jotka ovat selvästi kerroslukua korkeampia (tai
  yli 25 m ilman kerroslukua), jaetaan LOD2-mallin kattopintojen mukaisiin osiin, joilla kullakin
  on oma korkeutensa (`build_data.py`, `fix_heights`). Vuoden 2026 aineistossa tällaisia oli 208,
  joista 179 jaettiin osiin ja 22:n korkeus rajattiin kerrosluvun mukaan (LOD2-mallia ei
  löytynyt).
- Myös monitasoiset tasakattoiset rakennukset piirtyisivät liian korkeiksi, esim. Dipoli
  (17,5 m koko pohjan alalta) ja Tapiolan keskustan liikerakennukset. Kun koko Espoon LOD2-malli
  käsitellään kattoja varten, rakennus, jonka LOD0-korkeus on yli 3 m ja yli 25 % suurempi kuin
  kattojen pinta-alalla painotettu keskikorkeus, jaetaan kattopintojen mukaisiin osiin
  (`overtall_fix`). Jos osat kattavat alle 80 % pohjasta, korkeudeksi otetaan kattojen
  keskikorkeus ("Korkeus (m, kattojen keskikorkeus)"). Osiin jaettiin 372 rakennusta (Dipoli
  334 osaan) ja keskikorkeuteen laskettiin 36.

- Espoon avoimesta vesialueaineistosta (WFS `GIS:Vesialueet`) puuttuu suuri osa
  merialueesta (noin 100 km² Espoon noin 216 km²:n vesialueista), ja myös Espoon
  Vesistöt-karttakuvasta (WMS `Vesistot`) puuttuu paloja, esimerkiksi suorakulmainen alue
  Haukilahden lahdelta ja venesataman altaat. Vedet tulevat siksi HSY:n maanpeiteaineistosta
  (pelillinen maasto), jossa meri ja sisävedet ovat kokonaisina.

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

## Katot

LOD0-mallissa rakennuksella on vain yksi korkeus, joten 3D-rakennukset olisivat tasakattoisia
laatikoita. Espoon tarkemmassa 3D-mallissa (LOD2) on jokaisen katon pinnat, mutta ei valmista
kattotyyppiä (eikä sitä ole rakennusrekisterissäkään; OpenStreetMapissa kattomuoto on vain noin
7 %:lla Espoon rakennuksista). `build_data.py katot` hakee mallin koko Espoon rakennuksille
(653 noin 750 metrin ruutua, noin 2,4 Gt välimuistiin `cache/lod2_ruudut/`). Rakennukselle,
jonka kattopinta-alasta vähintään 15 % on yli 10° kalteva, lasketaan

- räystään korkeus: kattopintojen alin kohta maanpinnasta. Se lisätään rakennusaineistoon
  (`raystas`), ja rakennuksen tiedoissa näkyy "Räystäs (m)".
- kolmioverkko kattopinnoista ja räystään yläpuolisista seinänosista (päätykolmiot, korkeampien
  osien seinät). Pintojen kiertosuunta säilytetään CityGML:n mukaisena (ulospäin), ja katot
  käännetään aina ylöspäin. Seinät jatkuvat 2 m räystään alle ja ovat 3 cm sisempänä kuin
  3D-rakennuksen seinät: selain nostaa katon maastoon hieman eri tavalla kuin MapLibre
  3D-rakennuksen (keskipiste ja korkeusmallin tarkkuus), joten muuten katon ja seinien väliin
  jäisi rinteissä rako.

Kaltevia kattoja on 41 768; 18 425 rakennusta on tasakattoisia tai niiltä puuttuvat kattopinnat,
ja ne näkyvät ennallaan. Verkot ovat tiilinä `public/tiles/katot/14/x/y.bin` (278 tiiltä,
16 Mt, gzip-pakattu binääri; muoto on kuvattu `write_roof_tiles`-funktiossa ja värit
`color_roof_tiles`-funktiossa).

Selain (`public/roofs.js`) lataa lähikuvassa katot lähialueelta (ks. alla) ja piirtää ne
joukkoliikenteen 3D-tasolla. Katto nostetaan rakennuksen keskipisteen maastokorkeudelle samoin
kuin MapLibre nostaa 3D-rakennuksen, ja vielä 25 cm, jottei 3D-rakennuksen tasainen yläpinta
pistä räystäiden kohdalla katon läpi. Piirrettyjen kattojen rakennusten seinät lasketaan
räystään korkeuteen MapLibren feature-state-tilalla (`katto`), joten rakennus, jonka kattoa ei
piirretä, näkyy LOD0-korkeudessaan. Katon väri seuraa rakennusten väritystä hieman tummempana
(luonnollisissa väreissä katolla on oma värinsä), ja kattoa klikkaamalla saa rakennuksen tiedot.

Tiedostossa pinnan kolmiot jakavat kärkipisteitä, ja noin 6 000 rakennuksen kattopinnoissa on
pieniä vinoja tai alaspäin osoittavia kolmioita. Selain antaa siksi jokaiselle kolmiolle omat
kärkipisteet ja kolmion oman normaalin. Yhteinen kärkipiste sai aiemmin viimeksi käsitellyn
kolmion normaalin, jolloin koko lappeen varjostus vääristyi liukuvaksi ja harjakatto näytti
kourulta (esim. rivitalo 1016018534 Kauniaisten rajalla).

## Rakennusten värit

Värityksen vaihtoehto Luonnolliset värit näyttää rakennusten seinät ja katot niiden todellisen
värisinä. Rakennusrekisterissä väriä ei ole, eikä 3D-mallin (LOD2) materiaaliväristä ole apua
(sama oletusharmaa kaikille), mutta mallin jokaisella katto- ja seinäpinnalla on oma
valokuvatekstuuri vuoden 2024 ilmakuvista. `build_data.py rakennusvarit` valitsee rakennukselta
suurimman kaltevan kattopinnan (etelään päin olevia painotetaan) sekä suurimman seinän ja suurimman seinän
sen vastakkaiselta sivulta ja hakee niiden kuvat: 57 629 rakennusta ja 171 499 kuvaa,
ensimmäisellä kerralla noin kaksi ja puoli tuntia (16 hakua kerrallaan). Kuvassa näkyy pinnan
ympäristöäkin, joten pinnan alue rajataan tekstuurikoordinaateista ja tallennetaan enintään 48 px:n
näytteenä välimuistiin `cache/rakennusvarit/`; myöhemmät ajot laskevat värit näytteistä.

Katon väri on pinnan yleisin väri (tiheimmän väriruudun pikselien mediaani), josta on jätetty pois
kasvillisuus (kellanvihreä tai tumma vihreä; kuparikatto jää) ja mustimmat varjot. Ilmakuvissa katot
ovat todellista vaaleampia (yleisimmät värit olivat vaaleanharmaat `#aaa` ja `#999`), joten väri
kerrotaan 0,75:llä. Tasakatot (alle 10° kaltevat pinnat) ovat aina bitumikatteen harmaita
(`#4a4b4d`): niiden väri vaihtelee kuvissa valaistuksen, sepelin ja likaisuuden mukaan ja näyttäisi
kirjavalta. Kokonaan tasakattoiselta rakennukselta (ei räystästä, ks. Katot) ei siksi tallenneta
katon väriä, ja kaltevan katon tasaiset osat väritetään selaimessa kolmioiden normaalin mukaan
(`roofs.js`, maamerkit). Seinissä
haittaavat ikkunat ja auringon ylivalotus: auringon puoleinen seinä on viistokuvissa haalea
(Otakaari 1:n punatiili näkyy itäseinällä vaaleanpunaisena ja varjoisalla länsiseinällä
tummanruskeana). Lämpimän seinän (tiili, punamulta, rappaus) sävy ja kylläisyys otetaan siksi
värikkäimmältä seinältä ja kirkkaus valoisimmalta; kylläisyys kaksinkertaistetaan ja punaista tai
ruskeaa tummennetaan. Neutraali seinä (valkoinen, harmaa betoni) saa valoisimman seinän yleisimmän
värin, joten ikkunat eivät vaalenna sitä. Puiden peittämä seinä jää ilman väriä, mutta kokonaan
vihreä katto (esim. maalattu pelti) säilyy vihreänä. Värit ovat arvioita: esimerkiksi Otakaari 1
on harmaanruskea eikä punainen, koska kuvissa sen tiili on haalea.

Värit tallennetaan rakennusaineistoon (`seina`, `katto`), kattotiiliin ja maamerkkien malleihin;
ne ovat 57 456 rakennuksella (seinä 56 887, kalteva katto 44 346; kattoväri käytössä 42 890
rakennusosalla, ja 41 768 kaltevakattoisesta rakennuksesta 502 jää ilman). Värittömät rakennukset
(esim. rekisteristä täydennetyt) saavat yleisimmät sävyt, vaalean beigen seinän ja tummanharmaan
katon. Värit pyöristetään 16 tasoon kanavaa kohden (`#rgb`, 4 096 sävyä), jolloin samat arvot
toistuvat tiilissä ja pakkautuvat: rakennustiilet kasvavat värien takia noin 1,3 Mt eli 10 %
(13,1 → 14,4 Mt; tarkoilla väreillä koeajossa noin 35 %). 3D-mallin pisteet ovat Web Mercatorin
metreinä, joten pinnan kaltevuus lasketaan vasta, kun vaakamitat on muunnettu maaston metreiksi
(Espoossa kerroin noin 0,5); muuten loivat harjakatot näyttäisivät tasakatoilta.

MapLibren 3D-rakennuksella on yksi väri, joten tasaisen katon väri piirretään 30 cm paksuna
laattana rakennuksen yläpinnan päälle (taso `rakennukset-katto`, vain luonnollisissa väreissä).
Rakennuksella, jonka kalteva katto piirretään (`roofs.js`), laatta on litteä ja rakennuksen
sisällä 1 m korkeudessa: MapLibre jatkaa 3D-rakennuksen seiniä 10 m maan alle, jos pohjan
korkeus on 0, jolloin laatan seinät osuisivat rakennuksen omiin seiniin ja seinien alaosa välkkyisi.

## Lähialue ja sujuvuus

Lähikuvassa (zoom ≥ 14) 3D-rakennukset piirretään vain näkymän keskipisteen ympäriltä: säde
pienenee liukuvasti 4 km:stä zoomaustasolla 14 (2,8 km tasolla 15) 2 km:iin tasolla 16 ja
lähempänä (`layers.js`, `detailRadius`). Katot piirretään enintään 2,5 km:n päähän, koska
kauempana ne eivät juuri erotu; kauempana rakennukset näkyvät LOD0-korkeudessaan, ja säteen
ulkopuolella näkyy vain maaston pinta. Rakennusten suodatin
(MapLibren `distance`-lauseke) vaihdetaan vasta, kun näkymä on siirtynyt neljänneksen säteestä,
koska MapLibre käsittelee rakennustiilet silloin uudelleen. Liikkuvat ajoneuvot ja virtaus
piirretään noin 30 kertaa sekunnissa; karttaa liikutettaessa MapLibre piirtää täydellä
nopeudella.

Lähempänä kuin zoomaustaso 17 rakennukset ovat suurennettuja tason 15 tiiliä. Jos niiden kohdan
korkeusmalliruutu latautuu vielä, MapLibre (4.7) käyttää yläruutua mutta hakee korkeuden koko
yläruudun alueelta eikä ruudun omasta osasta. 3D-rakennus sai silloin toisen kohdan korkeuden ja
välähti hetkeksi ilmaan tai maan alle (keskimäärin noin 11 m, enimmillään noin 40 m korostettuna).
`app.js` (`fixTerrainLookup`) laskee hakumatriisin uudelleen käytetyn yläruudun mukaan.

## Joukkoliikenne reaaliajassa

Selain tilaa sijainnit suoraan HSL:n ja Digitrafficin MQTT-palveluista (`public/transit.js`),
eikä niihin tarvita avainta tai välityspalvelinta. Kartalle otetaan ajoneuvot, jotka ovat
Espoossa tai Kauniaisissa tai enintään 300 metrin päässä niiden rajasta.

- Ajoneuvot näytetään noin kaksi sekuntia (Digitrafficin junat yhdeksän sekuntia) todellista
  sijaintia jäljessä. Näin liike voidaan laskea tunnettujen sijaintien väliltä monotonisella
  kuutiollisella interpoloinnilla, ja lopuksi se vielä pehmennetään. Ajoneuvojen ja selaimen
  kellojen ero arvioidaan hitaasti kaikista viesteistä, jottei arvion muutos nytkäytä ajoneuvoja.
- Vaunut seuraavat keulan kulkemaa reittiä, joten nivelraitiovaunut ja junat kaartavat.
- Junien ja raitiovaunujen korkeus saa muuttua kuljettuun matkaan nähden vain radan suurimman
  kaltevuuden verran (rautatie 2,5 %, raitiotie 7 %). Korkeusmallin äkkinäiset muutokset
  ovat silloin virheitä eivätkä heiluta junaa, ja vaunut kulkevat keulan reitille tallentuneita
  korkeuksia pitkin.
- Junat, metrot ja raitiovaunut pidetään raiteilla (`public/rails.js`). Sijainti siirretään
  lähimmälle samanlajiselle raiteelle, ja edellisellä raiteella pysymistä suositaan, jottei juna
  hypi rinnakkaisten raiteiden välillä. Uuden junan vaunut asetetaan heti raidetta pitkin.
- Bussit kulkevat ajoradan oikealla puolella (`public/roads.js`). HFP:n GPS-sijainti on usein tien
  keskellä tai vastaantulevien kaistalla (noin viidesosa sijainneista on keskilinjan väärällä
  puolella), joten jokainen sijainti siirretään sivusuunnassa lähimmälle menosuuntaan sopivalle
  OpenStreetMapin ajotielle menosuunnan oikeanpuoleisimman kaistan keskelle. Kaistan paikka
  keskilinjasta on laskettu valmiiksi kummallekin suunnalle tien kaistamäärästä samoin kuin pelillisen
  maaston kaistaviivat (`public/data/ajotiet.json`, `python3 scripts/build_data.py ajotiet`), joten
  bussi on piirrettyjen viivojen välissä. Kaksisuuntaisella tiellä se on noin puolen ajoradan
  puolikkaan päässä keskilinjasta (kaistan leveys pääteillä 3,25–3,75 m, kaduilla 3 m), ja
  yksisuuntaisella ajoradalla (moottoritiet, erilliset ajoradat, rampit, kiertoliittymät) kaistamäärän
  mukaan lähellä keskilinjaa tai sen kohdalla. Bussikaistat ovat oikeassa reunassa, joten ne tulevat
  tästä mukaan. Pysäkin kohdalla (HFP:n `stop`) bussi saa olla enintään 3 m kaistaa oikeammalla, jos
  GPS-sijainti on siellä (pysäkkitasku).
- OSM:ssä ramppi erkanee pääväylän keskilinjalta ja yhtyy siihen, vaikka kaista jatkuu pääväylän
  oikeaan reunaan. Siksi yksisuuntaisen tien alussa ja lopussa kaistan paikka on sama kuin tiellä,
  jolta se jatkuu tai jolle se yhtyy (alle 30° kulmassa), ja se muuttuu tasaisesti 80 metrin matkalla.
  Samoin tasoittuu kaistamäärän muutos yksisuuntaisen ajoradan osien välillä.
- Tie valitaan etäisyydestä kaistan kohtaan. Poikittainen tie (risteävä katu) ja muu kuin edelliseen
  yhtyvä tie (rinnakkaiset tiet ja ajoradat) ovat huonompia, eikä yksisuuntaista tietä valita väärään
  suuntaan. Menosuunta on HFP:n suunta; seisova bussi pitää edellisen suuntansa, jottei se vaihda
  puolta pysäkillä. Ajoradalla tai enintään 4 metrin päässä sen reunasta oleva sijainti siirretään
  kokonaan, ja siitä siirto pienenee niin, että yli 12 metrin päässä (esim. varikot ja terminaalit,
  joiden teitä ei ole aineistossa) bussi on GPS-sijainnissaan. Mukana ovat ajotiet ja huoltotiet,
  joilla on bussilupa. Espoon bussien sijainneista noin 93 % kohdistuu tielle.
- Siirto tehdään vastaanotettuihin sijainteihin ennen interpolointia, joten liike niiden välillä pysyy
  yhtä tasaisena kuin ennen. Kun tie vaihtuu (risteykset, rampit, kaistamäärän muutos), uuden ja
  edellisen tien kaistan ero häipyy noin 25 metrin matkalla tai kolmessa sekunnissa, joten bussi ei
  nytkähdä. Samalla tiellä bussi pysyy kaistan kohdalla, eikä GPS-sijainnin heilunta näy.
- Jos raiteilla kulkevan sijainti katkeaa, liikettä jatketaan raidetta pitkin viimeisellä
  nopeudella enintään 90 sekuntia. Lähijunat, metrot ja raitiovaunut jarruttavat seuraavalle
  asemalle tai pysäkille ja jäävät sinne odottamaan; kaukojunat eivät pysähdy jokaisella asemalla,
  joten niitä vain jatketaan. Juna ei myöskään peruuta, jos myöhässä tullut sijainti on hieman
  jäljessä.
- Kahden tai kolmen yksikön lähijunassa jokainen yksikkö lähettää oman sijaintinsa samalla
  vuorolla. Ne näytetään yhtenä pitkänä junana, jonka keula on edimmäisen yksikön kohdalla.
- HSL:n lähijunat tulevat HFP-syötteestä, joten Digitrafficista otetaan vain kauko- ja tavarajunat.
- Metro kulkee Espoossa tunnelissa. Junat piirretään läpikuultavina tunneliputkien sisään
  yhdelle tasolle (−15 m N2000) maanpinnan muodoista riippumatta. Ne näkyvät myös suoraan
  ylhäältä katsottaessa, koska maanalaiset kohteet piirretään ilman kartan syvyysrajausta. Metro ja tunnelit piirretään ennen rakennuksia ilman syvyystestiä, joten ne
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

### Kyytinäkymä

Bussia, raitiovaunua, lähi- tai kaukojunaa, metroa tai matkustaja-alusta (lautat) klikkaamalla
hypätään sen kyytiin (`public/ride.js`): kartta siirtyy noin puolessatoista sekunnissa
seuraamaan kulkuneuvoa yläpuolelta. Kulkuneuvo pysyy näkymässä paikallaan hieman keskikohdan
alapuolella (yläreunassa täyte 30 % näkymän korkeudesta, joten edessä näkyy enemmän), menosuunta on
aina ylöspäin ja kallistus alussa 45°. Zoomaus on alussa 17 (noin 350 m näkymän leveydeltä). Tavarajunien,
lentokoneiden ja latausautojen klikkaus avaa tiedot kuten ennenkin. Kulkuneuvon tiedot ja
Lopeta seuranta -nappi ovat kapeassa, läpikuultavassa laatikossa oikeassa yläkulmassa, jossa kartan
navigointinapit ovat seurannan ajan piilossa; paneeli on yhtä läpikuultava (`--bg-glass`).

- Kartan kohteet ovat seurannan aikana klikattavissa kuten muutenkin: rakennusten tiedot,
  aineistojen kohteet, purot ja muiden kulkuneuvojen tiedot. Toisen julkisen kulkuneuvon klikkaus
  vaihtaa seurattavaa.
- Näkymä asetetaan joka ruudussa (`jumpTo`) samassa vaiheessa, kun ajoneuvot siirretään, joten
  kulkuneuvo ei heilu näkymässä. Kulkusuunnan muutokset pehmennetään, jotta sijaintien kohina ei
  käännä karttaa. Leveällä näytöllä avoin paneeli otetaan huomioon, ja kulkuneuvo pidetään
  näkyvän osan keskellä.
- Zoomataan hiiren rullalla, kahden sormen nipistyksellä tai +/− -näppäimillä (14,5–19), ja
  kameraa kallistetaan vetämällä hiirellä (napin pohjassa) ylös tai alas: ylös vetäminen
  kallistaa kohti horisonttia kuten kartan omassa kallistuksessa (0,5° pikseliltä, 0–80°).
  Paikallaan painettu nappi on edelleen klikkaus. Kartan omat eleet pysäyttäisivät joka
  ruudussa asetettavan näkymän, joten raahaus, kierto, kallistus, kartan oma zoomaus ja
  navigointinapit ovat seurannan ajan pois päältä, ja zoomaus ja kallistus tehdään `ride.js`:ssä.
- 45°:tta jyrkemmin kallistetaan vain niin pitkälle, että kamera on vähintään 40 m kulkuneuvon
  yläpuolella (kameran etäisyys keskipisteestä riippuu zoomauksesta ja näkymän korkeudesta):
  esimerkiksi 760 px korkeassa näkymässä zoomauksella 17 kallistus voi olla 80°, mutta 19:llä
  noin 62°. Zoomattaessa lähemmäs kallistus laskee rajaan ja palaa loitonnettaessa.
- Metro kulkee maan alla, ja se näkyy läpikuultavana kuten muutenkin. Metrotunnelien sisäpuoli
  (`public/metrotunnel.js`) piirretään vain, jos kamera on maan alla; se on jäänyt aiemmasta
  katutason kyytinäkymästä. Seurannassa kameran korkeusraja pitää sen maan yläpuolella
  tavallisissa maastonmuodoissa.
- "Lopeta seuranta" tai Esc palauttaa näkymän, josta kyytiin hypättiin; osoiterivin näkymä pysyy
  seurannan ajan siinä. Paneelin paikkanapit päättävät seurannan heti. Jos kulkuneuvo katoaa
  datasta (vuoro päättyy, ajoneuvo ajaa Espoon ulkopuolelle tai sijainti ei päivity), näkymä jää
  sen viimeiseen sijaintiin ja palkki kertoo seurannan päättyneen. Seurattavan ajoneuvon HFP-ruutu
  pysyy tilattuna, vaikka näkymä siirtyisi toiseen ruutuun.
- Kapealla näytöllä paneeli painetaan alas seurannan ajaksi. Kun liikettä vähennetään
  (`prefers-reduced-motion`), kartta siirtyy seurantaan ja takaisin ilman siirtymää.

## Kelikamerat

Fintrafficin tieliikenteen kelikamerat näkyvät kartalla kameramerkkeinä zoomaustasolta 10 alkaen
(`public/kelikamerat.js`, taso Kelikamerat). Merkit ovat kaukaa katsottaessa pieniä ja suurenevat
lähennettäessä. Sijainnit haetaan kerran Digitrafficin asemaluettelosta
(`https://tie.digitraffic.fi/api/weathercam/v1/stations`, koko Suomi noin 40 kt), ja mukaan otetaan
keruussa olevat kamerat Espoon rajan sisältä (sama raja kuin ajoneuvoilla, `espoo_raja.geojson`;
44 kameraa, joista kaksi aivan rajalla). Kuvia ei ladata etukäteen: kameraa klikkaamalla aukeaa
ikkuna, johon haetaan aseman nimi ja kuvasuuntien nimet (`/stations/{id}`) sekä kuvausajat
(`/stations/{id}/data`), ja kuvasuunnat näytetään pikkukuvina
(`https://weathercam.digitraffic.fi/{kuvasuunta}.jpg?thumbnail=true`). Pikkukuvasta aukeaa
täysikokoinen kuva (1280 × 720) koko näkymän päälle; Esc, taustan klikkaus tai sulkunappi sulkee
sen. Kamerat ottavat kuvan noin 10 minuutin välein, joten avoinna olevat kuvat päivitetään samassa
tahdissa. Vain alle 15 minuuttia vanhat kuvat näytetään: ikkunassa ovat vain tuoreet kuvasuunnat,
ja kartalla näkyvät (vihreinä) vain asemat, joilla on vähintään yksi tuore kuva. Kaikkien asemien
kuvausajat haetaan kahden minuutin välein yhdellä pyynnöllä (`/stations/data`, noin 20 kt), ja
merkit tulevat näkyviin ensimmäisen haun jälkeen. Rajapinnat sallivat selaimen suorat haut (CORS),
ja pyynnöissä on Digitrafficin suosittelema `Digitraffic-User`-otsake. Kamerat toimivat myös kyytinäkymän seurannassa.

## Lentokoneet

Koneet haetaan neljän sekunnin välein 25 meripeninkulman säteeltä Espoon keskeltä, ja kartalle
otetaan ne, jotka ovat Espoon yllä tai enintään viiden kilometrin päässä sen rajasta. Kone
näytetään ilmoittamassaan korkeudessa (GNSS-korkeus geoidiin korjattuna tai painekorkeus), ja
pystyviiva näyttää kohdan maassa. Hakujen välissä konetta liikutetaan nopeuden, suunnan ja
nousunopeuden mukaan, ja uuden sijainnin tuoma korjaus häivytetään pehmeästi. Kaukaa katsottaessa
koneet näytetään suurennettuina. Reitit tulevat lentotunnuksen perusteella tietokannasta, joka
voi olla vanhentunut; jos matalalla lentävän koneen reitissä ei ole Helsinki-Vantaata, reitti
merkitään epävarmaksi.

## Laivat ja veneet

Alusten AIS-sijainnit haetaan Digitrafficista kymmenen sekunnin välein 25 km:n säteeltä, ja
kartalle otetaan alukset, jotka ovat Espoon vesillä tai enintään kahden kilometrin päässä rajasta.
Yli 30 minuuttia vanhat sijainnit jätetään pois, samoin paikallaan olevat lähettimet, joiden
kohdalla maasto on korkeusmallin mukaan yli viisi metriä merenpinnan yläpuolella (esim.
laitevalmistajien testilaitteet). Hakujen välissä alusta liikutetaan nopeuden ja kurssin mukaan.

Alustyypin mukaan malli on rahtialus, säiliöalus, matkustaja-alus, työvene (myös hinaajat,
luotsi- ja pelastusveneet), purjevene tai moottorivene. Nimi, tyyppi, määränpää ja mitat haetaan
kerran alusta kohden. AIS kertoo GPS-antennin etäisyyden keulaan, perään ja kumpaankin kylkeen,
joten malli skaalataan aluksen todelliseen pituuteen ja leveyteen ja sijoitetaan oikein antennin
suhteen.

## Sähköautot latauksessa

Latauspisteiden tila tulee Fintrafficin AFIR-rajapinnasta (Digitraffic), joka kokoaa
latausoperaattorien tiedot ja päivittää koosteen minuutin välein. Selain hakee koosteen minuutin
välein, ja jokainen latauksessa (CHARGING) oleva latauspiste näytetään henkilöautona latauspaikan
vieressä. Lähikuvassa auton yllä välkkyy salama, ja kaukaa autot näkyvät keltaisina pisteinä.
Salama piirretään 3D-tasolla, joten rakennukset ja maasto peittävät sen, ja se näkyy vain
enintään 1,5 km:n päässä näkymän keskipisteestä (lähikuvassa lähialueen säteellä).
Klikkaamalla näkee latauspaikan, operaattorin, liittimen ja tehon, latauksen alkamisajan sekä
paikan muiden pisteiden tilanteen. Espoossa ja Kauniaisissa on 139 latauspaikkaa ja noin 1 200
latauspistettä.

Operaattori kertoo vain latauspisteen tilan, ei auton paikkaa, joten autot sijoitetaan
latauspaikan ympärille rinnakkain. `build_data.py lataus` laskee jokaiselle latauspaikalle
valmiiksi pysäköintiruudut (`public/data/lataus.json`):

- Operaattorin ilmoittama sijainti on joskus kaupan tai osoitteen kohdalla, jopa yli 100 metrin
  päässä latauspisteistä (esim. K-Market Maarinsolmu 125 m). Siksi latauspaikan sijainniksi
  otetaan OpenStreetMapiin kartoitettu latausasema, jos se vastaa latauspaikkaa: enintään 300
  metrin päässä ja kaksi perustetta täsmää (nimi, merkki tai operaattori, latauspisteiden määrä),
  tai yksi peruste 100 metriin asti. Eri merkin asema hylätään. Vastaava asema löytyy 46
  latauspaikalle, ja 34 sijaintia siirtyy yli 10 metriä (14 yli 50 metriä). Jos asema on
  kartoitettu alueena, autot sijoitetaan ensisijaisesti sen sisään.
- Ruudut sijoitetaan muuten ensisijaisesti OpenStreetMapin pysäköintiruutuihin, sitten pysäköintialueille
  riveihin latauspaikkaa lähimmän reunan viereen (autot 2,7 metrin välein, keula reunaa kohti) ja
  vasta viimeiseksi latauspaikan kohdalle lähimmän tien suuntaisesti.
- Auto ei saa olla tiellä eikä kevyen liikenteen väylällä: sen etäisyys väylän keskiviivaan on
  vähintään puolet väylän leveydestä (tyypin, kaistamäärän tai leveystiedon mukaan) ja marginaali.
  Se ei myöskään saa olla rakennuksen sisällä (kartan 3D-rakennukset) eikä toisen auton päällä.
- Pysäköintitalon latauspaikan autot sijoitetaan talon sisäänkäynnin luo.
- Ruudut jaetaan vierekkäisten latauspaikkojen kesken vuorotellen, joten kumpikin saa lähimmät
  ruutunsa.

Selaimessa uusi lataus saa latauspaikan ensimmäisen vapaan ruudun, joten autot ovat rinnakkain
latauspaikan vieressä, ja auto pysyy ruudussaan koko latauksen ajan.

## Maamerkit

Kaksi vesitornia piirretään omina malleinaan (`public/landmarks.js`), ja niiden rakennukset
piilotetaan 3D-rakennuksista:

- Haukilahden vesitorni: rakennusaineistossa pelkkä 45 metrin varsi, koska pohjana on vain varren
  pinta-ala. Mallissa keskivarsi ja kuusi pilaria, kalottimainen "lentävä lautanen" (halkaisija
  45 m), ravintolakerros ja kupoli. Lautasen paksuutta ei ole julkaistu, joten se on arvio.
- Otaniemen vesitorni (Alvar Aalto, 1970–72): rakennusaineistossa 46 metriä korkea umpinainen
  12-kulmio. Mallissa vapaamuotoinen alaosa, 12-kulmainen kartiopohjainen säiliö 12 pylvään
  varassa (halkaisija noin 35 m ja yläreuna 44 m LOD2-mallista), säteittäiset palkit,
  kierreportaan lieriö, viuhkamainen kattokerros, antennimittaustorni (huippu 52 m) ja piippu.
  Piipun paikka ja alaosan muoto on arvioitu valokuvista.

Neljä tunnettua rakennusta piirretään kokonaan Espoon 3D-kaupunkimallin (LOD2) pinnoista:
Dipoli (Raili ja Reima Pietilä, 1966; 661 pintaa), Suomen luontokeskus Haltia (Lahdelma &
Mahlamäki, 2013), Keilaniemen torni eli Accountor Tower (1976) ja Tapiolan kirkko (Aarno
Ruusuvuori, 1965). `build_data.py maamerkit` poimii rakennukset välimuistissa olevasta
3D-mallista (`LANDMARK_BUILDINGS`) tiedostoiksi `public/data/maamerkit/<id>.json`. Mallit
väritetään kuten muut rakennukset (luokka, vuosi tai korkeus, katot hieman tummempina, tai
luonnolliset värit), ne
noudattavat 3D-rakennusten valintaa, ja klikkaus avaa rakennuksen
tiedot kuten muissakin rakennuksissa, lisänä maamerkin omat tiedot. Espoon 3D-mallissa on
myös valokuvatekstuurit, mutta niillä rakennukset erottuivat liikaa muista. Lisää maamerkkejä
saa lisäämällä rakennustunnukset `LANDMARK_BUILDINGS`-luetteloon ja määrittelyn `layers.js`:n
`LANDMARKS`-luetteloon.

## Rakennuksen tiedot

Rakennusta klikkaamalla näkyvät rakennusaineiston tiedot (korkeus, kerrokset, valmistumisvuosi,
käyttötarkoitus, osoite, asunnot, kantava rakenne, rakennustunnus ja kaltevakattoisilla
räystään korkeus). Lisäksi Espoon rakennusrekisteristä (avoin WFS `GIS:Rakennukset`) haetaan
rakennustunnuksella kerrosala, kokonaisala, tilavuus, kellarin pinta-ala, huoneistojen määrä,
lämmitystapa, lämmön lähde, käyttötilanne, valmistumispäivä, kiinteistötunnus ja vanhan muodon
rakennustunnus. Haku tehdään vasta klikattaessa (yleensä alle sekunti, kylmänä muutama sekunti),
ja vastaukset muistetaan. Rakennusluvat (`GIS:Rakennusluvat`, `GIS:RakennusluvatEspoo`),
rakennusvalvonnan aineistot (`rakval:*`) ja kattoviivat (`GIS:RakennustenKatot`) vaativat tunnukset.

## Sillat

Maanmittauslaitoksen korkeusmallista sillat on poistettu, joten tie notkahti sillan
kohdalla alla olevan tien tai joen tasolle, ja ajoneuvot sukelsivat mukana. Siltojen päistä on
usein poistettu myös penkereen pää, jolloin tiehen tuli kuoppa juuri ennen siltaa. Siksi
korkeusmalli nostetaan siltojen kohdalla kannen tasolle. Nosto lasketaan valmiiksi
(`build_data.py`): skripti hakee Mapterhornin korkeusmallin tiilet (zoom 13–15) siltojen kohdalta,
nostaa kannet ja tallentaa muuttuneet tiilet häviöttömänä WebP:nä kansioon `public/tiles/korkeus`
(519 tiiltä, noin 35 Mt). Selain hakee siltojen kohdalla nämä tiilet ja muualla alkuperäiset
(`sillat.json` kertoo, mitkä tiilet on nostettu), eikä se käsittele korkeusmallia itse. Nosto tekee
sillasta umpinaisen: sillan alta kulkeva tie tai joki jää nostetun maaston alle.

Kannen korkeus tulee Espoon kantakartan mitatuista viivoista:

- Siltojen reunaviivat (`kanta:Silta`): kannen reunoiksi tulkitaan samansuuntaiset, samalla
  korkeudella olevat viivat 3–40 metrin päässä toisistaan.
- Siltaviivoista puuttuu usein toinen reuna; esimerkiksi Otasolmun kiertoliittymästä (Kehä I kulkee
  sen alta) on vain sisäkaaret. Siksi siltojen lähellä (40 m) haetaan myös ajoväylien ja kevyen
  liikenteen väylien reunaviivat (`kanta:Liikennevayla`, `kanta:Kevyenliikenteenvayla`). Kunkin
  reunaviivan vierestä etsitään lähin samansuuntainen viiva kummaltakin puolelta: jos se on samalla
  korkeudella (enintään kahden metrin ero, sillä siltaviiva on usein reunapalkin päällä ajorataa
  ylempänä), väli on kantta ja siitä tulee kaistale. Alla kulkevan tien reuna on metrejä alempana,
  joten kaistale ei peitä sitä. Kaistaleen kohdalla on oltava samansuuntainen OpenStreetMapin tie
  tai raide (esim. Raide-Jokerin kaareva silta Kehä I:n yli Laajalahdessa), jottei kahden tien
  välistä luiskaa tai rinnakkaisten siltojen väliä täytetä (siltaviivan ja ajoradan reunan välinen
  enintään 8 metrin kaista kelpaa ilmankin), ja siltaviiva samalla korkeudella enintään 30 metrin
  päässä: mukaan tulevat siltojen päät mutta eivät sillan alittavat tiet.
- Raiteiden keskilinjat (`kanta:Raide`, koko Espoo): raiteelle tehdään kaistale, joka on raiteen
  kohdalla (1,6 m keskilinjasta) mitatulla korkeudella (mediaani 10 metrin matkalta); sen
  ulkopuolella maasto laskee penkereen luiskana (1:3) maanpintaan enintään 7 metrin päässä. Luiska
  vain täyttää enintään 4,5 metrin kuoppia eikä peitä siltojen kansia. Korkeusmalli on paikoin
  ajalta ennen raidetta (esim. Raide-Jokeri Laajalahdessa on 1,5–2 metriä vanhaa maanpintaa
  ylempänä), jolloin raiteelle tulee loiva penger.

Kansista ja kaistaleista tehdään korkeusmallin pikseleittäin yksi pinta. Kansi tai kaistale nostaa
pikseliä vain, jos maanpinta on sen alapuolella (kaistale vähintään 0,5 metriä, koska kaistaleita
on myös tasaisella maalla tien kohdalla). Päällekkäiset kannet ja kaistaleet kuvaavat samaa
ajorataa (alempi on ajoradan tai raiteen pinta, ylempi esim. siltaviivan reunapalkki), joten pinta
on alin niistä. Yli 3 metriä ylempänä oleva pinta on oma tasonsa (silta toisen yllä), ja silloin
pinnaksi tulee ylempi taso, kuten ylhäältä katsottuna näkyisi. Kaistaleiden pikselit siistitään avauksella
(3 × 3): tukimuurin tai luiskan yläreunalle osuvat 1–2 pikselin kaistat jäävät pois, jottei niistä
tule piikkejä, mutta kansi säilyy.

**Korkeusmallia uudemmat tiet.** Korkeusmalli on paikoin vanhempi kuin tie. Esimerkiksi Kehä I:tä
on parannettu Laajalahden kohdalla (liittymiä on korvattu silloilla ja eritasoliittymillä), ja
Turuntien liittymän kohdalla tie kulkee nyt 2–6 metriä korkeusmallin maanpintaa alempana. Tien
pinta aaltoili vanhan maanpinnan mukaan. `build_data.py` vertaa kantakartan ajoväylien reunojen
mitattua korkeutta korkeusmalliin 20 metrin ruuduittain; siltojen ja tunnelien läheltä (20 m) ei
verrata, koska silta puuttuu korkeusmallista ja tunnelin päällä on maata. Jos reunat ovat ruudussa
mediaanina vähintään metrin korkeusmallia alempana yhtenäisellä, vähintään kolmen ruudun alueella,
tie on rakennettu tai laskettu keilauksen jälkeen. Tällaisia alueita löytyi 21, enimmäkseen uusilla
asuinalueilla ja työmailla (esim. Kiviruukki, Hehkurinne). Alueella (+40 m) tienpinta lasketaan
samalla korkeudella olevien reunaviivojen välisistä kaistaleista (sivukaltevuus enintään metri),
mitatut reunapisteet pidetään omalla korkeudellaan, ja kaistaleiden väliin jääviin aukkoihin
(esim. rampin erkanemiskohta) levitetään mitattu pinta OpenStreetMapin tiealueella (leveys tien
tyypin ja kaistojen mukaan). Tien ulkopuolella maasto liittyy uuteen pintaan luiskana (1:1,5,
enintään 15 m). Yli 3 metriä ylempänä oleva tienpinta on oma tasonsa, esimerkiksi uusi silta, jota
ei vielä ole siltaviivoissa, ja se jää pinnalle. Kannet nostetaan korjatun
maanpinnan yläpuolelle, mutta korjatulla tienpinnalla ajoväylien kaistaleita ei nosteta. Korjattujen
tiilten mitatuista reunapisteistä, joiden korkeus muuttui, 93 % on nyt 0,3 metrin päässä mitatusta
(ennen 6 %).

Tarkimmista tiilistä (zoom 15) tallennetaan myös nostettujen pikselien (korjattu) maanpinta
(`public/tiles/korkeus/maa`, muualla musta). Selain lataa sen, kun se hakee nostetun tiilen. Sillan
ali kulkeva ajoneuvo (`public/transit.js`) lähestyi alempaa ja pysyy alla olevan tien tasolla, ja
uoma (`public/streams.js`) kulkee sillan alla maanpinnalla. Sillalle kannen korkeudelta,
esimerkiksi penkereeltä, tullut ajoneuvo pysyy kannella.

## Purot ja joet

Uomat ovat OpenStreetMapista: joet, purot ja kanavat Espoossa ja enintään 500 metrin päässä
rajasta (585 km, josta rumpuja 28 km). OSM:n viivat on piirretty virtaussuuntaan. Espoossa ne
kulkevat Syken uomaverkoston kanssa samaan suuntaan 99,9 %:ssa niistä uomista, jotka ovat
molemmissa. Selain tasoittaa uomat Chaikinin kulmanleikkauksella kahdesti, jotta mutkat ovat
pyöreitä. Yhtymäkohdat ja muut osuuksien rajat pysyvät paikallaan. Uomat piirretään maaston
pintaan, viivan leveys kasvaa valuma-alan mukaan, ja rummussa viiva on haalea. Aineisto on
tiedostossa `public/data/purot.json` (`build_data.py purot`).

OSM:n uoma on paikoin piirretty mutkia oikaisten tai 20–30 metriä sivuun (esim. Lepsämänjoki
Espoon pohjoisrajalla), vaikka kartan vesialueet (HSY:n maanpeite 2024) osuvat uomaan: se näkyy
Maanmittauslaitoksen korkeusmallin rinnevarjosteessa, ja Syken uomaverkosto kulkee samassa
kohdassa. Kun OSM:n viiva lähtee vesialueelta ja palaa sinne (enintään kilometrin pätkä, enintään
100 metrin päässä vesialueesta), pätkä korvataan vesialueen keskilinjalla: metrin ruudukossa
haetaan lyhin reitti, jossa askel on sitä halvempi, mitä kauempana rannoista se on. Korjaus
alkaa ja päättyy vesialueen sisältä. Järviä, rumpuja ja pätkiä, joiden uusi reitti olisi kaukana
OSM:n viivasta tai eripituinen, ei muuteta, joten vesialueen vieressä kulkeva oja ei siirry
lampeen. Pätkän sisään jääneet yhtymäkohdat siirtyvät uudelle viivalle, ja sivu-uomat jatkuvat
niihin. Korjattuja pätkiä on 120 (11 km).

Kunkin uoman yläpuolinen valuma-ala lasketaan Syken valuma-aluejaon pienimmistä alueista. Alueen
oma pinta-ala jaetaan sen uomille pituuksien suhteessa, ja se kertyy alavirtaan. Järvien kohdalla
OSM:n uomat katkeavat, joten alueiden purkupisteissä kertymä korjataan Syken laskemaan
yläpuoliseen valuma-alaan. Kun uoma haarautuu (esim. myllykanava), vesi jatkaa päähaaraan.

Virtaamaa mitataan Espoossa vain Espoonjoesta. Syken asemalta tulee päiväarvo noin vuorokauden
viiveellä, ja aseman valuma-ala on 126 km². Selain hakee uusimman arvon tunnin välein Syken
hydrologiarajapinnasta. Muiden uomien virtaama arvioidaan olettaen, että neliökilometriltä valuu
yhtä paljon vettä kuin Espoonjoen valuma-alueelta: Q = Q_asema · A / A_asema. Kaupunkipurot
reagoivat sateeseen nopeammin, joten arvio on suuntaa-antava. Selite vertaa Espoonjoen
virtaamaa saman kuukauden mediaaniin (päiväarvot vuodesta 1995).

Lähikuvassa (zoom 13,5 tai lähempää) uoman päällä on nauha, jossa alavirtaan kulkee valkoisia
valopulsseja (`public/streams.js`, joukkoliikenteen 3D-tasolla). Nauha seuraa tasoitettua uomaa,
joten pulssit kaartuvat mutkissa uoman mukana. Aiemmin suorat virtaviivat oikaisivat mutkat
sahalaitaisiksi. Nauhan geometria on kiinteä, ja pulssit lasketaan varjostimessa matkasta uomaa
pitkin ja ajasta. Liike on nopeutettu, ja se on mitoitettu näytön pikseleissä: mitä suurempi
virtaama, sitä nopeampia ja leveämpiä pulssit ovat. Isossa uomassa pulssin keskikohta kulkee
reunoja edellä kuten virtaus. Sillan kohdalla nauha kulkee kannen alta alkuperäisellä
maanpinnalla, eikä rummuissa näytetä pulsseja.

## Pelillinen maasto

Maaston pinta piirretään pelillisenä: koko Espoo tarkkana (maanpeite tekstuureina, tiet viivoineen,
3D-sillat ja metsissä 3D-puut). Pohjana on HSY:n maanpeiteaineisto 2024: vesi, pellot, matala kasvillisuus, paljas
maa, avokalliot, puusto neljässä korkeusluokassa (2–10, 10–15, 15–20 ja yli 20 m), muut päällystetyt
pinnat, päällystämättömät ja päällystetyt tiet sekä rakennukset. `build_data.py` hakee luokat
HSY:n karttapalvelusta yhtenä kuvana ruutua kohden ja tunnistaa luokan tyylin täyttöväristä
(selite JSON-muodossa). Ne tallentuvat harmaasävyruutuina (arvo = luokka) häviöttöminä WebP-kuvina
(noin 30 % pienempiä kuin PNG) kansioon `public/tiles/maanpeite` (taso 16, 1024 px eli noin 0,3 m).
Tarvittavat ruudut valitaan yleiskuvasta (alla): maata sisältävät haetaan (4 039), pelkkää merta
olevat ja muut yhden luokan ruudut ovat vain luettelossa `public/data/maanpeite.json` (`tasaiset`,
6 407), ja Espoon ulkopuolella käytetään yleiskuvaa. Kuvia on 4 025 (141 Mt). Kaukaisempia
ruutuja varten tarkoista kootaan ruudun yleisimmällä luokalla välitaso 14 (1024 px eli noin 1,2 m;
416 kuvaa, 25 Mt), jolloin kaukaisen ruudun maalaukseen riittää yksi luokkaruutu kuudentoista sijaan.
Espoon rajana on HSY:n seutukartan kuntaraja vesialueineen; rajan ulkopuolelta säilytetään vain meri
(HSY:n merialue-taso haetaan rajan ruuduille erikseen), joten naapurikuntien maa ja järvet jäävät
tyhjiksi. Kauniainen jää pois kuten muutkin naapurikunnat. Tilastokeskuksen 1:1 000 000 -raja
(`espoo_raja.geojson`) seuraa rantaa niin karkeasti, että esim. Keilaniemi jäisi sen ulkopuolelle.

Loitonnettua näkymää varten koko Espoosta on yleiskuva (`build_landcover_overview`): taso 12
(1024 px eli noin 4,8 m) haetaan HSY:ltä ja taso 9 (noin 38 m) kootaan siitä ruudun yleisimmällä
luokalla, sillä HSY:n palvelin ei ehdi piirtää niin laajaa kuvaa. Tiheät ruudut eivät ehdi
palvelimen aikarajaan kokonaisina, joten ne haetaan neljänä palana. Karkeassa kuvassa pienimmät
kuviot jäävät piirtymättä, ja raot täytetään viereisellä luokalla. Espoon rajan ulkopuolelta mukana
on vain meri, jonka HSY:n merialue-taso antaa nopeasti yksinään, jottei rannikko katkea rajaan;
tasolla 9 meri on koko ruudun alueelta. Naapurikuntien maa jää tyhjäksi (59 + 4 ruutua, 3,6 Mt).

Selain maalaa luokista tekstuurit työsäikeessä (`public/pelimaasto_worker.js`): metsissä on
latvuksia (korkeammassa puustossa suurempia ja tummempia), pelloilla vakoja, vedessä aaltoja, kalliossa
halkeamia, pihoilla laatoitus ja teillä asfaltti tai sora. Kuviot lasketaan maailman
koordinaateista, joten ne jatkuvat ruudusta toiseen, ja luokkarajat ovat hieman epäsäännöllisiä ja
lähikuvassa tummalla ääriviivalla. MapLibre levittää ruudut maaston päälle rasteriruutuina
(tasot 8–19, joten tekstuuri pysyy terävänä lähelläkin), ja rinnevarjostus antaa maastolle muodot.
Lähellä (karttaruudun taso 16 ja tarkemmat) luokat tulevat tarkoista ruuduista, kauempana (14–15)
välitasosta, jonka pikseli on enintään maalattavan pikselin kokoinen, ja loitonnettaessa ja Espoon
ulkopuolella yleiskuvasta, jolloin luokkarajojen epäsäännöllisyys kasvaa yleiskuvan karkeuden
mukaan. Kauempaa katsottaessa (pikseli yli 3 m) luokat
väritetään tekstuurin keskivärillä, sillä hienot kuviot sekoittuisivat kohinaksi.
Ruudun maalaus vie työsäikeessä 13–50 ms.

Maaston päällä ovat kantakartan ajoratojen, kevyen liikenteen väylien ja polkujen reunaviivat
(myös ajoradan merkinnät, kuten nuolet) sekä kadunnimet kantakartan sijainnein ja suunnin
(vektoritiilet, ks. Laatat ja lataus). Nimet ovat maaston
pinnassa kuten kantakartassa, ja suunta (kantakartassa suuntakulma pohjoisesta) käännetään
luettavaksi. Espoon ulkopuoli on maaston keskisävyä
(rinnevarjostus on koko näkymässä). 3D-maastotilassa MapLibre (4.7) näyttää puuttuvan
rasteriruudun tilalla vain neljä alaruutua tai ladatun yläruudun ja piilottaa muut, joten
loitonnettaessa maastoruutu jäi toisinaan yhdeksi kuvaksi ilman pintaa ja kartta välähti.
Pelillisen maaston pinnalle ja varjostukselle pidetään siksi puuttuvan ruudun ladatut ylä- ja
alaruudut näkyvissä myös MapLibren välimuistista (`keepLoadedTiles`), ja taustan sävy on sama kuin
maaston, jottei harvinainen jäljelle jäävä aukko erotu. Sama säilytys on viivojen vektoritiilillä,
sillä ne tulevat verkosta.

Lisäksi OpenStreetMapista ovat kaistaviivat, suojatiet ja raiteet. Pääteille (moottori-, valta-,
kanta-, seutu- ja yhdystiet) tehdään kaistamäärän (`lanes`, oletuksena yksi kumpaankin suuntaan)
mukaan kaksisuuntaisille keskiviiva ja saman suunnan kaistojen väliin kaistaviivat, kaikki
valkoisia (kaista 3,25–3,75 m, 3 m viiva ja 9 m väli); asuntokaduilla ei ole viivoja. Viivat
katkaistaan risteysalueilla: risteys on solmu, johon yhtyy vähintään kolme ajotien osaa, ja viivat
jätetään pois leveimmän risteävän tien puolikkaan ja 3 metrin säteeltä. Suojatiet ovat ylitysväyliä
(`footway=crossing`) tai ylityskohtia (`highway=crossing`), joille väylää ei ole, jolloin ylitys
tehdään ajoradan poikki; merkitsemättömät jätetään pois. Ylitysväylä rajataan ajoradan leveydelle
(kaistamäärästä, `carriageway_half`, vinossa ylityksessä pidemmälle) niistä kohdista, joissa se ylittää
ajotien keskilinjan: OSM:ssä ylitysväylä jatkuu usein jalkakäytävälle asti, ja joskus koko pyörätie on
merkitty ylitykseksi (pisimmillään 280 m), jolloin pyörätien jatke näkyi pitkänä katkoviivana tien
vieressä. Rajattuna ylitys on mediaaniltaan 6 m ja enintään 14 m. Ne piirretään seepraksi
(3 m leveä, 0,5 m raidat ajoradan suuntaisina), ja pyörätien jatkeet kahtena rivinä 0,5 m neliöitä. Raiteet (juna ja
raitiovaunu, ei tunneleissa) piirretään sepelipohjana, ratapölkkyinä ja kahtena kiskona noin
1,5 metrin päässä toisistaan. Leveydet ovat metreinä, joten ne skaalautuvat zoomauksen mukana.
Metro on tunnelissa, joten sen raiteita ei piirretä. OpenStreetMapin väylät haetaan Overpassista
12 palana (koko Espoo yhtenä kyselynä ei ehdi palvelinten aikarajaan). Kantakartan WFS vastaa
ruuhkassa toisinaan tyhjällä kohdejoukolla (HTTP 200), joten tyhjä vastaus haetaan vielä kahdesti
väliaikaiseen tiedostoon (epäonnistunut haku ei vie edellistä), ja kolmesti tyhjä ruutu merkitään
(`.tyhja`), jottei sitä tarkisteta joka ajossa uudelleen. Mukaan otetaan Espoon
väylät (HSY:n kuntaraja vesialueineen, 60 m:n vara), joten esim. lahden ylittävä silta on mukana mutta
naapurikunnan (myös Kauniaisten) silta ei.

Sillat ovat pelillisessä maastossa 3D-malleja (`public/pelimaasto.js`): kansi (1 m paksu,
pinnassa asfaltti, kevyen liikenteen sillalla vaalea ja raidesillalla sepeli), reunoilla 0,9 m
kaiteet ja 24 metrin välein pilarit. Pääteiden silloilla kannen pinnassa jatkuvat tien kaista- ja
keskiviivat samoilla siirroilla kuin maassa (sama laskenta, `lane_offsets`). Ajotiesilloilla
ajoradan reunaviivat jatkavat maanpinnan reunaviivoja: niiden sivusijainti otetaan kantakartan
reunaviivoista enintään 8 m sillan päiden ulkopuolelta, ja jos se on päissä eri, se vaihtuu
tasaisesti (ilman niitä reuna on metrin päässä kannen reunasta). Reunaviivoiksi kelpaavat vain sillan
suuntaiset (enintään 25°) viivat kannen pään korkeudelta (±1,5 m, `EDGE_DZ`), ja jos niitä on enemmän
kuin kaksi, uloimmat; muuten kannelle tuli jopa 12 viivaa esim. sillan alta poikittain kulkevan tien
reunoista. Ne tehdään OpenStreetMapin siltaosuuksista
(663 siltaa jatkeineen, ks. Laatat ja lataus); kannen leveys tulee kaistamäärästä
(+ 1 m reunoille) ja korkeus siltojen kohdalla nostetusta korkeusmallista (kantakartan mitatut
kannet) tai, jos se on alempana, suoraan sillan päiden välillä; päiden korkeus on tien pinnasta
4 m sillan ulkopuolelta (esim. Kehä I:n alikulun kohdalla kantakartan kansi on mitattu 1–1,7 m
ajorataa alempaa). Jos sillan pää jatkuu toisena siltaosuutena (yhteinen OSM-solmu, esim. liittymä
sillalla), pää on viereisen osuuden kannen korkeudella; muuten lyhyt osuus kallistui maahan ja kansi
loppui ilmaan. Kaiteita ei piirretä sellaisen janan sivulle, jonka jokin kohta (2 m välein) on toisen
sillan kannella (`ka`: kaiteet janoittain), jottei liittymän keskelle jää kaiteita. Vapaaseen päähän,
joka on yli metrin maaston yläpuolella (esim. portaisiin tai rakennukseen päättyvä kevyen liikenteen
silta), tulee päätuki (`tu`; 35 päätä), jottei kansi jää ilmaan.
Pelillisessä tilassa korkeusmallin tiilet vaihdetaan siltojen kohdalla versioon, jossa
OSM:n siltojen kohdalla kaikki nostot ovat auki ja niiden ympäriltä on poistettu noin 3,5 metrin
täyttö (`public/tiles/korkeus/peli`, `build_data.py`; 316 tiiltä, 21 Mt). OSM:n silta on usein
kantakartan kantta lyhyempi tai kapeampi: esim. Turvesuontien silta Kehä I:n yllä Laajalahdessa
jatkuu rampin yli, ja avaamatta jäänyt kansi näkyi 3D-sillan jatkona maaston kohoumana, jonka kyljet
olivat pystysuoria seiniä sillan alla. Siksi auki ovat myös kannet, kaistaleet ja raiteet, jotka ovat
OSM:n sillan kohdalla (`mark_bridge_pieces`), kaikkialla, missä ne ovat vähintään 2 m maanpinnan
yläpuolella (`OPEN_MIN`), ja OSM:n siltaa jatketaan sen päästä lähteviä teitä pitkin avatun kannen
matkalle (`bridge_extensions`, enintään 60 m; 45 jatketta, yhteensä 457 m). Kantta ei kuitenkaan avata muiden teiden
ja raiteiden kohdalta siltä matkalta, jolla niiden kantakartan ajoradan reunaviivat on mitattu kannen
korkeudelle (`road_footprints`): tie kulkee silloin kannella, vaikka OSM:n silta ei jatku sen
kohdalle (esim. sivusta sillalle liittyvä tie), ja muuten se katkeaisi aukkoon. Sillan ali kulkevien
teiden, myös sillan päästä alas laskeutuvien ramppien, reunaviivat ovat alempana. Avatun kannen kohdalle
jää näin vain 46 m ajotietä ilman 3D-siltaa (koko Espoo, 2 m välein; ennen suojaa 160 m), ja yli
3 m:n porraskohtia pelillisessä korkeusmallissa on 6 961 (ennen 10 834). Jatkeet tallennetaan tiedostoon `sillat.json`
(`jatkeet`), ja pelillisen maaston viivat ja 3D-sillat tehdään väylistä, joissa jatke on erotettu
tiestä omaksi siltaosuudekseen (`game_ways`). Korkeusmallista on poistettu sillat ja niiden alue
täytetty alemmasta maasta, joten kannen pään ulkopuolelle jäi paikoin kuoppa (Turvesuontiellä 3 m).
Kannen vapaan pään ulkopuolella maa nostetaan siksi 12 metrin matkalle kannen pään korkeudesta
loivasti (1:4) laskevaksi penkereeksi, jos maa on 14 m päässä enintään 1,5 m kannen pään alapuolella
eli tie jatkuu kannen tasolla (`END_FILL`); tämä koskee myös tavallista korkeusmallia. Pelillinen tiili
tallennetaan vain, jos siinä avataan jotain; muuten käytetään tavallista nostettua tiiltä, ja jos
kaikki nostot avataan, alkuperäistä (`korkeus_peli_alkup` tiedostossa `sillat.json`). Muualla kannet
ja kuopat ovat täytettyinä. Sillan alta kulkeva tie näkyy siis sillan alla, ja
kannella kulkeva ajoneuvo pidetään kannen tasolla: 3D-siltojen kohdalla ladattujen siltaruutujen
kansista (`bridges.js`, `gameDecksAt`; enintään 1 m kannen reunan ulkopuolelle), muualla
kantakartan siltaviivoista. Raidesillalla juna ja raitiovaunu ovat aina kannella; muuten ajoneuvo on
kannella, jos se tuli sillalle kannen korkeudelta. Aiemmin juna laskeutui avatun jänteen pohjalle,
jos rautatiesillan kohdalla ei ollut kantakartan siltaviivoja. Sillan kannella kulkevat viivat
(kantakartan reunaviivat sillan alueella yli 2 m alkuperäisen korkeusmallin yläpuolella sekä
siltaosuuksien kaistaviivat, raiteet ja suojatiet) jätetään maanpinnasta pois, samoin
kantakartan viivat, jotka ovat yli 2 m pelillisen maaston pinnan alapuolella (penkereen sisällä).
Viivat tarkistetaan 2 metrin välein, sillä esim. kävelysillan ääriviivan sivu voi olla yksi suora
jana, jonka molemmat päät ovat maan tasolla.

Metsissä on kartan keskipisteen ympärillä (600 m, zoomaustaso 15 ja lähempää) matalapolygonisia
3D-puita (oletuksena; pois paneelista Rakennukset → 3D-puut metsissä tai osoitteella `?puut=0`)
(`public/pelimaasto.js`): tasavälinen 4,5 metrin ruudukko satunnaisesti siirrettynä, puun korkeus puustoluokasta, matalammassa puustossa enimmäkseen lehtipuita (pyöreä
latvus) ja korkeammassa havupuita (kartio). Puita on noin 10 000, ja niiden korkeus haetaan
maastosta vähitellen. Kun keskipiste siirtyy 150 m, puut sijoitellaan uudelleen; edelliseltä
kerralta tutut puut (sama ruudukon kohta) pysyvät paikallaan, ja korkeus haetaan vain uusille,
jottei metsä välähdä liikkuessa. Puut piirretään instansseina joukkoliikenteen 3D-tasolle; piirto vie noin
4 ms. Puut ovat maaston raskain osa: noin 0,7 miljoonaa
kolmiota joka kuvassa, noin 10 Mt ilmentymätietoja ja 150 metrin siirron jälkeen uudet
korkeuskyselyt; ilman niitä metsät näkyvät pelkkänä tekstuurina, mikä keventää hitaan puhelimen
käyttöä.

### Laatat ja lataus

Koko Espoon tarkka malli on noin 200 Mt, joten selain lataa siitä vain näkymän ympäriltä ja vapauttaa
kaukaiset osat. Kallistetussa näkymässä (esim. katutasolla, jossa näköala ulottuu horisonttiin)
MapLibre hakee ruudut sitä karkeampina, mitä kauempana ne ovat kamerasta (maaston korkeusmallin
kanssa MapLibre 4.7: lähteen tarkimmat ruudut noin kahden ruudun päähän, ja jokainen seuraava taso
kaksinkertaiseen etäisyyteen, kauimpana lähteen alin taso). Tarkkuus seuraa siis etäisyyttä:

- Pinta: MapLibre pyytää näkyvät ruudut (`peli://`) ja pitää omaa välimuistiaan. Työsäie hakee
  maalaukseen luokkaruudut (lähellä yksi tarkka, kauempana yksi välitason ruutu) ja pitää
  viimeksi käytettyjä muistissa enintään 40 Mt (tarkka ruutu purettuna 1 Mt). Jos MapLibre ei enää
  tarvitse ruutua (kartta siirtyi), maalaus perutaan ennen kuin se alkaa.
- Viivat ja nimet: vektoritiilet `public/tiles/pelimaasto` (tippecanoe; tasot 12–15, 1 360 tiiltä,
  10 Mt, tasolla 15 tarkkuus noin 7 cm). Karkeammissa tiilissä on vähemmän kohteita: tasoilla 12–13
  vain raiteet (näkyvät kauas), tasolla 14 lisäksi ajoradat, kevyen liikenteen väylät ja
  kaistaviivat (noin 2,4 km:n päähän) ja tasolla 15 kaikki (polut, suojatiet ja nimet). Lähteen alin
  taso on 12, jottei horisonttiin ulottuvassa näkymässä haeta kaukaista aluetta tason 14 tiilinä.
- Sillat: `public/tiles/pelisillat` tason 14 ruuduittain (noin 1,2 km; 663 siltaa 121 ruudussa,
  luettelo `public/data/pelimaasto_sillat.json`). Ruudut ladataan kameran ympäriltä 6 km:n päähän:
  alle 1,5 km:n päässä täysi malli (kaiteet, viivat ja pilarit), kauempana pelkkä kansi. Malleja
  rakennetaan enintään kaksi piirtokertaa kohden lähimmästä alkaen, ja ruutu vapautetaan, kun se on
  25 % rajaa kauempana (täysi malli vasta, kun kansi on valmis, jottei silta katoa välillä).
- Korkeusmalli: pelillisen tilan tiilet koko Espoosta vain siltojen kohdalla (ks. yllä).
- Välimuisti: tiiliosoitteissa on aineistoversio (`?v=`), joten Netlify antaa pelillisen maaston
  tiilille pitkän välimuistiajan (`netlify.toml`), ja selain ottaa jo haetut tiilet välimuistista
  kysymättä palvelimelta.

Mittaukset (headless Chrome samalla koneella, 1280 × 800; puhelin: 390 × 844, kolminkertainen
tarkkuus ja nelinkertaisesti hidastettu suoritin; ajo katutasolla reittiä pitkin: zoomaus 18,6,
kallistus 84°, 20 s;
keko: sivu ja työsäikeet yhteensä):

| | ennen (vain Otaniemi–Laajalahti) | jälkeen (koko Espoo) |
|---|---|---|
| Alkulataus pelillisellä maastolla (siirretty) | 14,6 Mt (puhelin 13,4 Mt) | 8,7 Mt (puhelin 7,6 Mt) |
| JS-keko alussa | 168 Mt (puhelin 176 Mt) | 86 Mt (puhelin 84 Mt) |
| Otaniemi katutasolla, ms/kuva (toistot) | 17,6–26,8 (puhelin 36) | 19,5–26,2 (puhelin 40) |
| Otaniemi katutasolla, työsäikeiden keko | 126 Mt (puhelin 120 Mt) | 29 Mt (puhelin 41 Mt) |
| Espoonlahti katutasolla, ms/kuva | 17,1–17,5 (ei tarkkaa mallia) | 20,9–21,4 (puhelin 37 → 49) |
| 40 s:n ajo Espoonlahdesta Leppävaaraan | ladattu 16 Mt | ladattu 31 Mt; siltaruutuja enintään 60, luokkaruutuja 38 (40 Mt) |

Samalla alueella piirto on yhtä raskas kuin ennen, mutta muistia kuluu selvästi vähemmän, koska
viivoja ja tarkkoja luokkaruutuja ei ladata kerralla. Uusilla alueilla tarkka malli maksaa noin 4 ms
kuvaa kohden. Kustannus tulee viivoista ja nimistä (piilotettuina 17,2 ms), kuten Otaniemessä ennenkin;
siltoja on lähellä noin 10 000–20 000 kolmiota.

## Rakenne

- `server.py`: paikallinen palvelin, joka jakaa `public/`-kansion ja välittää adsb.fi:n pyynnöt
- `netlify.toml`: julkaisuasetukset
- `scripts/build_data.py`: aineistojen lataus ja muunnos
- `public/layers.js`: tasojen, värien ja selitteiden määrittelyt
- `public/app.js`: kartta ja käyttöliittymä (MapLibre GL JS)
- `public/transit.js`: reaaliaikaiset ajoneuvot, lentokoneet ja latauksessa olevat sähköautot, liikkeen tasoitus ja 3D-mallit (three.js)
- `public/ride.js`: kyytinäkymä: kulkuneuvon seuranta yläpuolelta menosuunta ylöspäin, zoomaus, kallistus ja kyytipalkki
- `public/metrotunnel.js`: metrotunnelien ja asemien sisäpuoli (käytössä vain kameran ollessa maan alla)
- `public/pelimaasto.js` ja `public/pelimaasto_worker.js`: maaston pinta (pelillinen maasto): maanpeiteluokat tekstuureina, viivat, 3D-sillat ruuduittain ja 3D-puut
- `public/bridges.js`: siltojen kohdalla valmiiksi nostetut korkeusmallin tiilet, sillan alla oleva maanpinta ja kannen korkeus ajoneuvoille
- `public/streams.js`: purot ja joet, virtaaman haku ja arviointi sekä virtausanimaatio
- `public/roofs.js`: kaltevat katot 3D-mallista (tiilien lataus, kolmioverkot, korkeus maastosta)
- `public/rails.js`: raideverkko, raiteelle kohdistus, raidetta pitkin kulku ja asemat
- `public/roads.js`: bussien ajotiet ja kohdistus menosuunnan oikealle kaistalle
- `public/landmarks.js`: maamerkkien 3D-mallit (Haukilahden vesitorni)
- `public/kelikamerat.js`: tieliikenteen kelikamerat (Digitraffic): kameramerkit, kuvat ja suurennos
- `public/sadetutka.js`: sadetutka pyöreäreunaisina alueina 50 m maanpinnan yläpuolella (three.js)
