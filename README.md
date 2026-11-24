# Espoo 3D

Selaimessa toimiva 3D-kartta Espoosta. Siinä yhdistyvät maasto, rakennukset,
kaavoitus, vedet, väestö ja liikenne, ja kaikki tieto tulee avoimista lähteistä.
Espoon bussit, raitiovaunut, junat ja metro, Espoon vesillä liikkuvat alukset sekä Espoon
yllä lentävät koneet liikkuvat kartalla aina reaaliajassa 3D-malleina, ja latauksessa olevat
sähköautot näkyvät latauspaikoillaan.

## Paneeli

- Liikenne näkyy aina; paneelissa näkyy ajoneuvojen ja lentokoneiden määrä lajeittain.
- Aineistoja on viisitoista: kaupunginosien nimet, Kauniaisen raja, asemakaavan
  käyttötarkoitukset, vireillä olevat kaavat, ajantasa-asemakaava, maankäyttökartta, vesialueet,
  purot ja joet, asukkaat 250 m ruuduissa (3D), autoliikenne, tie- ja raideliikenteen melu,
  kiinteistörajat, kantakartan maastotiedot sekä sadetutka. Oletuksena päällä ovat
  kaupunginosien nimet, Kauniaisen raja, vesialueet, purot ja joet sekä sadetutka.
  Määrittelyt ovat tiedostossa `public/layers.js` (`LAYERS`).
- Kaupunginosan nimi on alueen rakennusten keskellä, koska kaupunginosien rajat ulottuvat
  usein merelle (`kaupunginosat_nimet.geojson`, `build_data.py kaupunginosat`).
- Kauniainen on oma kaupunkinsa Espoon sisällä: raja näkyy katkoviivana, alue on hieman
  tummennettu ja nimi KAUNIAINEN näkyy alueen keskellä (`kauniainen.geojson`,
  `build_data.py kauniainen`). Raja on HSY:n seutukartasta, koska Tilastokeskuksen
  1:1 000 000 -raja on karkea; Kauniaisesta ei ole 3D-rakennuksia, koska ne tulevat Espoon
  aineistoista.
- Pohjana on oletuksena vuoden 2024 ilmakuva, jonka voi ottaa pois. Vuoden voi vaihtaa
  (2024, 2015, 2005, 1996, 1976), ja rakennuksista näytetään ne, jotka olivat silloin valmiina.
- Ilmakuvaruudut ovat raskaita (Espoon karttapalvelu tekee jokaisen 512 px:n ruudun erikseen,
  PNG noin 0,7 Mt, noin sekunti). Ne haetaan oman protokollan kautta (`ortho://`), ja kartan
  pysähdyttyä näkymän ympäriltä haetaan valmiiksi naapuriruudut lähimmistä alkaen selaimen
  välimuistiin, josta ne tulevat karttaa siirrettäessä muutamassa millisekunnissa.
- Sadetutka (Ilmatieteen laitos) näyttää sateen voimakkuuden (mm/h). Uusin kuva-aika luetaan
  kahden minuutin välein, ja aika on tiiliosoitteessa, jottei selain näytä vanhaa kuvaa.

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
raiteet tiedostoon `public/data/raiteet.json` ja sähköautojen latauspaikat pysäköintiruutuineen
tiedostoon `public/data/lataus.json`. Rakennusten kaltevat katot tallentuvat kansioon
`public/tiles/katot` (`python3 scripts/build_data.py katot`; ensimmäinen ajo lataa koko
Espoon 3D-mallin, noin 2,5 Gt). Tiilitykseen tarvitaan
[tippecanoe](https://github.com/felt/tippecanoe) (`brew install tippecanoe`).
Jos haluat ladata aineistot uudelleen, poista ensin `cache/`. Yksittäisen
aineiston voi päivittää nimellä, esim. `python3 scripts/build_data.py
maankaytto tiilet`. Kansiot `cache/` ja `data/` eivät ole versionhallinnassa;
valmiit tiilet ovat.

## Julkaisu (Netlify)

Netlify julkaisee `public/`-kansion sellaisenaan aina, kun GitHubin `main`-haaraan
tulee muutos. Asetukset ovat tiedostossa `netlify.toml`: build-komentoa ei ole.
Lentokoneiden sijainnit (adsb.fi) välitetään reitin `/proxy/adsb/...` kautta, koska palvelu ei
salli selaimen suoria hakuja; `server.py` tekee saman paikallisesti. Samasta syystä HSY:n
karttakuvat (vesialueet) välitetään reitin `/proxy/hsy/wms` kautta. Jos kartta julkaistaan
palvelussa, jossa välitystä ei ole (esim. GitHub Pages), vesialueita ja lentokoneita ei näy,
mutta muu kartta toimii.

Vektoritiilet ovat gzip-pakattuja, ja selain purkaa ne itse (`app.js`), joten
palvelimen ei tarvitse lähettää `Content-Encoding`-otsaketta.

## Lähteet

| Aineisto | Lähde |
|---|---|
| Rakennukset (pohja ja mitattu korkeus, LOD0) | Espoo WFS `bldg:building_lod0` |
| Kaltevat katot ja epäilyttävien korkeuksien korjaus (kattopinnat, LOD2) | Espoo WFS `bldg:building_lod2` |
| Puuttuvat rakennukset (pohja, kerrosluku) | Espoo WFS `GIS:Rakennukset` |
| Asemakaavan käyttötarkoitukset, vireillä olevat kaavat, autoliikennemäärät | Espoo WFS `GIS:*` |
| Ilmakuvat, ajantasa-asemakaava, maankäyttökartta, melu, kiinteistörajat, kantakartta | Espoo WMS |
| Vesialueet (meri ja sisävedet) | HSY:n maanpeite 2024, WMS (palvelimen välityksellä) |
| Sadetutka, sateen voimakkuus (mm/h) | Ilmatieteen laitos, avoin WMS (CC BY 4.0) |
| Purot ja joet, virtaussuunnat ja rummut | © OpenStreetMap-tekijät (ODbL), Overpass API |
| Valuma-alueet ja niiden purkupisteet (yläpuolinen valuma-ala) | Syke, valuma-aluejako (INSPIRE WFS, CC BY 4.0) |
| Espoonjoen virtaama (päiväarvot 1995 alkaen) | Syke, hydrologiarajapinta (CC BY 4.0) |
| Väestöruudukko 250 m (2025) | HSY WFS |
| Korkeusmalli 2 m | Maanmittauslaitos (CC BY 4.0), tiilet: Mapterhorn |
| Bussien, raitiovaunujen, lähijunien ja metron sijainnit | HSL:n HFP-rajapinta (MQTT, CC BY 4.0) |
| Kauko- ja tavarajunien sijainnit ja tiedot | Fintraffic / Digitraffic (MQTT ja REST, CC BY 4.0) |
| Espoon ja Kauniaisen raja (ajoneuvojen rajaus) | Tilastokeskus, kunnat 1:1 000 000 |
| Kauniaisen raja kartalla | HSY:n seutukartta, kunnat 2021 (WFS) |
| Siltojen reunaviivat ja kansien korkeudet | Espoo WFS `kanta:Silta` (kantakartta) |
| Alusten sijainnit, nimet, tyypit, mitat ja määränpäät | Fintraffic / Digitraffic AIS (REST, CC BY 4.0) |
| Lentokoneiden sijainnit, korkeudet, konetyypit | adsb.fi:n avoin ADS-B-rajapinta (välityspalvelimen kautta) |
| Lentojen reitit ja lentoyhtiöt | adsbdb.com (lentotunnuksen mukaan) |
| Haukilahden vesitornin muoto | Wikipedia (Haukilahti water tower), Docomomo Suomi |
| Otaniemen vesitornin muoto | Otaniemen vesitornin rakennushistoriaselvitys (ark-byroo 2017), Espoon LOD2-malli |
| Junien, metron ja raitiovaunujen raiteet ja pysähtymispaikat | © OpenStreetMap-tekijät (ODbL), Overpass API |
| Sähköautojen latauspaikat ja latauspisteiden tila | Fintraffic / Digitraffic AFIR (REST, CC BY 4.0) |
| Latausasemien sijainnit, pysäköintialueet, -ruudut ja tiet latauspaikkojen ympärillä | © OpenStreetMap-tekijät (ODbL), Overpass API |

Espoon rajapinnoissa on myös tunnuksia vaativia aineistoja, joita ei käytetä:
kaavayksiköt, yleiskaavat, viher- ja katualueet, Espoon oma maaperä-, rakennettavuus-
ja savisyvyyskartta, liito-oravat, johtokartat sekä vääräväri-ilmakuva.

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
  Haukilahden lahdelta ja venesataman altaat. Vesialueet näytetään siksi HSY:n
  maanpeiteaineistosta (meri- ja vesialueet 2024), jossa meri ja sisävedet ovat kokonaisina.

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
13 Mt, gzip-pakattu binääri; muoto on kuvattu `write_roof_tiles`-funktiossa).

Selain (`public/roofs.js`) lataa lähikuvassa katot lähialueelta (ks. alla) ja piirtää ne
joukkoliikenteen 3D-tasolla. Katto nostetaan rakennuksen keskipisteen maastokorkeudelle samoin
kuin MapLibre nostaa 3D-rakennuksen, ja vielä 25 cm, jottei 3D-rakennuksen tasainen yläpinta
pistä räystäiden kohdalla katon läpi. Piirrettyjen kattojen rakennusten seinät lasketaan
räystään korkeuteen MapLibren feature-state-tilalla (`katto`), joten rakennus, jonka kattoa ei
piirretä, näkyy LOD0-korkeudessaan. Katon väri seuraa rakennusten väritystä hieman tummempana,
ilmakuvavuoden suodatus koskee myös kattoja, ja kattoa klikkaamalla saa rakennuksen tiedot.

## Lähialue ja sujuvuus

Lähikuvassa (zoom ≥ 14) 3D-rakennukset piirretään vain näkymän keskipisteen ympäriltä: säde
pienenee liukuvasti 4 km:stä zoomaustasolla 14 (2,8 km tasolla 15) 2 km:iin tasolla 16 ja
lähempänä (`layers.js`, `detailRadius`). Katot piirretään enintään 2,5 km:n päähän, koska
kauempana ne eivät juuri erotu; kauempana rakennukset näkyvät LOD0-korkeudessaan, ja säteen
ulkopuolella näkyy ilmakuva. Rakennusten suodatin
(MapLibren `distance`-lauseke) vaihdetaan vasta, kun näkymä on siirtynyt neljänneksen säteestä,
koska MapLibre käsittelee rakennustiilet silloin uudelleen. Liikkuvat ajoneuvot ja virtaus
piirretään noin 30 kertaa sekunnissa; karttaa liikutettaessa MapLibre piirtää täydellä
nopeudella.

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

Neljä tunnettua rakennusta piirretään kokonaan Espoon 3D-kaupunkimallin (LOD2) pinnoista
valokuvatekstuureineen: Dipoli (Raili ja Reima Pietilä, 1966; 661 pintaa ja 192 tekstuuria),
Suomen luontokeskus Haltia (Lahdelma & Mahlamäki, 2013), Keilaniemen torni eli Accountor Tower
(1976) ja Tapiolan kirkko (Aarno Ruusuvuori, 1965). `build_data.py maamerkit` poimii
rakennukset välimuistissa olevasta 3D-mallista (`LANDMARK_BUILDINGS`) tiedostoiksi
`public/data/maamerkit/<id>.json`: pinnat kolmioina, tekstuurikoordinaatit ja kuvien osoitteet.
Selain lataa geometrian heti ja tekstuurit (pieniä JPEG-kuvia Espoon karttapalvelusta, CORS
sallittu) vasta, kun maamerkki on enintään 4 km:n päässä näkymän keskeltä zoomaustasolla 14
tai lähempää. Valaistus on kuvissa, joten teksturoidut pinnat piirretään ilman varjostusta.
Lisää maamerkkejä saa lisäämällä rakennustunnukset `LANDMARK_BUILDINGS`-luetteloon ja
määrittelyn `layers.js`:n `LANDMARKS`-luetteloon.

## Sillat

Maanmittauslaitoksen korkeusmallista sillat on poistettu, joten ilmakuvan tie notkahti sillan
kohdalla alla olevan tien tai joen tasolle, ja ajoneuvot sukelsivat mukana. Espoon kantakartan
siltojen reunaviivoissa on kannen mitattu korkeus. `build_data.py` muodostaa niistä kansialueet:
kannen reunoiksi tulkitaan samansuuntaiset, samalla korkeudella olevat viivat 3–40 metrin päässä
toisistaan. Selain nostaa korkeusmallin tiilet kansialueilla kannen tasolle (`public/bridges.js`)
ja muistaa alkuperäisen maanpinnan korkeuden.

Ajoneuvo pysyy kannella, jos se tuli sillalle kannen korkeudelta, esimerkiksi penkereeltä.
Sillan ali kulkeva ajoneuvo lähestyi alempaa ja pysyy alla olevan tien tasolla.

## Purot ja joet

Uomat ovat OpenStreetMapista: joet, purot ja kanavat Espoossa ja enintään 500 metrin päässä
rajasta (585 km, josta rumpuja 28 km). OSM:n viivat on piirretty virtaussuuntaan. Espoossa ne
kulkevat Syken uomaverkoston kanssa samaan suuntaan 99,9 %:ssa niistä uomista, jotka ovat
molemmissa. Selain tasoittaa uomat Chaikinin kulmanleikkauksella kahdesti, jotta mutkat ovat
pyöreitä. Yhtymäkohdat ja muut osuuksien rajat pysyvät paikallaan. Uomat piirretään maaston
pintaan, viivan leveys kasvaa valuma-alan mukaan, ja rummussa viiva on haalea. Aineisto on
tiedostossa `public/data/purot.json` (`build_data.py purot`).

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

## Rakenne

- `server.py`: paikallinen palvelin, joka jakaa `public/`-kansion ja välittää adsb.fi:n ja HSY:n pyynnöt
- `netlify.toml`: julkaisuasetukset
- `scripts/build_data.py`: aineistojen lataus ja muunnos
- `public/layers.js`: tasojen, värien ja selitteiden määrittelyt
- `public/app.js`: kartta ja käyttöliittymä (MapLibre GL JS)
- `public/transit.js`: reaaliaikaiset ajoneuvot, lentokoneet ja latauksessa olevat sähköautot, liikkeen tasoitus ja 3D-mallit (three.js)
- `public/bridges.js`: siltakansien nosto korkeusmalliin ja kannen korkeus ajoneuvoille
- `public/streams.js`: purot ja joet, virtaaman haku ja arviointi sekä virtausanimaatio
- `public/roofs.js`: kaltevat katot 3D-mallista (tiilien lataus, kolmioverkot, korkeus maastosta)
- `public/rails.js`: raideverkko, raiteelle kohdistus, raidetta pitkin kulku ja asemat
- `public/landmarks.js`: maamerkkien 3D-mallit (Haukilahden vesitorni)
