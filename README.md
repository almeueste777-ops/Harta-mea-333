# 🚕 TaxiRută — ocolește traficul

Aplicație de navigație **gratuită** (PWA) pentru taximetriști, în stilul Waze / Google Maps, dar gândită altfel:
**preferă străduțele și ocolirile, chiar dacă faci mai mulți kilometri, numai să nu stai pe loc în trafic.**

## Ce face

- **Cursele de azi (max. 10):** cauți adresa sau ții apăsat pe hartă → se adaugă în listă. Apeși ▶ și pornești.
- **Ordine optimă:** calculează cea mai bună ordine a curselor rămase, pornind de unde ești.
- **3 tipuri de rută:**
  - **Rapid** — ca o aplicație obișnuită.
  - **Străduțe** *(implicit)* — dă greutate mare distanței, nu vitezei teoretice a bulevardelor; ia scurtături prin cartiere.
  - **Doar străduțe** — drumul cel mai scurt, chiar dacă are multe viraje.
- **Butonul roșu „Blocat! Ocolește”:** exclude următorii ~600 m din traseu și găsește imediat o ocolire.
- **Detectează singur când stai pe loc** (sub 60 m în 2 minute) și caută ocolire.
- **Învață din experiența ta:** ține minte locurile unde ai stat blocat (zi lucrătoare/weekend, ora) și le ocolește
  data viitoare la aceeași oră. Apar ca puncte mov pe hartă. Totul rămâne doar pe telefonul tău.
- **Trafic în timp real (opțional, gratuit):** cu o cheie TomTom gratuită, aplicația vede ambuteiajele,
  accidentele și drumurile închise, le ocolește și verifică la fiecare 2 minute dacă a apărut o rută mai liberă.
- Navigație pas cu pas **cu voce în română**, recalculare automată când ieși de pe traseu, ecranul rămâne aprins.
- Hartă de zi / de noapte automată, merge instalată pe ecranul telefonului (PWA), pornește și fără semnal.
- Buton de rezervă: deschide aceeași destinație în **Waze** sau **Google Maps**.

## Cum se instalează pe telefon

1. Deschide adresa aplicației în Chrome (Android) sau Safari (iPhone).
2. Android: meniul ⋮ → **Adaugă pe ecranul de pornire / Instalează aplicația**.
   iPhone: butonul Partajare → **Adaugă pe ecranul principal**.
3. La prima pornire permite accesul la **locație**.

Probă fără mașină: adaugă `?sim` la adresă (ex. `https://…/?sim`) — aplicația „conduce” singură pe traseu.

## Servicii folosite (toate gratuite, fără cont)

| Ce | Serviciu |
|---|---|
| Hartă | [OpenFreeMap](https://openfreemap.org) (date OpenStreetMap) |
| Rutare + instrucțiuni în română | [Valhalla](https://valhalla.github.io/valhalla/) — serverul public FOSSGIS |
| Căutare adrese | [Photon](https://photon.komoot.io) (Komoot) |
| Trafic live *(opțional)* | [TomTom Traffic](https://developer.tomtom.com) — plan gratuit: 2.500 cereri/zi + 50.000 de dale de hartă/zi |
| Găzduire | Cloudflare Workers (plan gratuit: 100.000 cereri/zi) |

## Structura

```
public/            aplicația (PWA): index.html, app.js, app.css, sw.js, manifest, iconițe
public/vendor/     MapLibre GL (harta)
worker/index.js    Cloudflare Worker: /api/geocode, /api/reverse, /api/route, /api/optimize, /api/traffic-tile
wrangler.jsonc     configurația Cloudflare
```

`/api/route` cere de la Valhalla ruta + 2 alternative, le compară cu blocajele live (dacă există cheie TomTom)
și cu punctele de evitat trimise de telefon; dacă toate variantele trec prin blocaje, cere din nou o rută care
exclude porțiunile blocate.

## Publicare pe Cloudflare

```bash
npm install
npx wrangler login          # sau: export CLOUDFLARE_API_TOKEN=... și CLOUDFLARE_ACCOUNT_ID=...
npm run deploy
```

### Activează traficul live (recomandat, gratuit)

1. Fă-ți cont gratuit pe <https://developer.tomtom.com> și copiază cheia API.
2. Rulează:
   ```bash
   npx wrangler secret put TOMTOM_KEY
   ```
3. Gata — în aplicație apare butonul 🚦 (strat de trafic) și mesajul „trafic live activ”.

### Dezvoltare locală

```bash
npm run dev      # http://localhost:8787  (pune TOMTOM_KEY=... în .dev.vars pentru trafic)
```
