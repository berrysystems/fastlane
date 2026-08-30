# Play-Listing veröffentlichen

Lädt die Texte, Listing-Bilder und optional ein App Bundle über die
Google Play Developer API hoch — aus dem ZIP, das der Asset-Generator ausgibt.

Alles passiert in einem einzigen Edit. Schlägt ein Schritt fehl, wird der Edit
verworfen und im Store ändert sich nichts.

## Einrichten

**1. Service-Account anlegen**

In der Google Cloud Console ein Projekt wählen, die *Google Play Android
Developer API* aktivieren, unter *IAM & Verwaltung → Dienstkonten* ein Konto
anlegen und einen JSON-Schlüssel erzeugen.

**2. In der Play Console verknüpfen**

*Einstellungen → API-Zugriff*, das Dienstkonto einladen und ihm für deine App
mindestens die Rechte *Store-Eintrag bearbeiten* und, falls du Binaries
hochlädst, *Releases verwalten* geben. Die Freischaltung braucht manchmal ein
paar Minuten.

**3. Installieren**

```bash
cd tools/play-publish
npm install
cp .env.example .env      # und den Schlüssel eintragen
```

## Benutzen

```bash
# Erst prüfen — validiert lokal und bei Google, committet nichts
node publish.js --package com.example.app --dry-run

# Nur den Store-Eintrag aktualisieren
node publish.js --package com.example.app

# Mit Bundle, gestufter Rollout auf zehn Prozent
node publish.js --package com.example.app \
  --aab app/build/outputs/bundle/release/app-release.aab \
  --track production --rollout 0.1
```

Weitere Optionen zeigt `node publish.js --help`.

## Was vorher geprüft wird

Bevor überhaupt ein Request rausgeht, liest das Skript die Bildheader und die
Textlängen. Das fängt die Fehler ab, die Google sonst erst nach dem Upload mit
einer knappen Meldung quittiert:

- Icon exakt 512 × 512 und unter 1 MB
- Feature Graphic exakt 1024 × 500
- Screenshots zwischen 320 und 3840 px, Seitenverhältnis höchstens 2:1, ohne Alphakanal
- mindestens 2 und höchstens 8 Phone-Screenshots
- Titel 30, Kurzbeschreibung 80, Beschreibung 4000 Zeichen

## Erwartete Ordnerstruktur

```
fastlane/metadata/android/
  de-DE/
    title.txt
    short_description.txt
    full_description.txt
    changelogs/default.txt
    images/
      icon.png
      featureGraphic.jpg
      phoneScreenshots/       1_*.jpg … 8_*.jpg
      sevenInchScreenshots/   optional
      tenInchScreenshots/     optional
```

Die Screenshots werden natürlich sortiert, `10_` landet also hinter `9_`.
Vor jedem Upload räumt das Skript den jeweiligen Bildtyp per `deleteall` ab,
sonst sammeln sich alte Screenshots im Eintrag an.

## In der CI

`.github/workflows/publish-listing.yml` ist vorbereitet. Es erwartet:

- Secret `PLAY_SERVICE_ACCOUNT_KEY` — der komplette JSON-Inhalt
- Variable `PACKAGE_NAME`

Der Workflow läuft manuell über *Actions → Run workflow*, standardmäßig als
Probelauf. Erst wenn du den Haken entfernst, wird veröffentlicht.

## Grenzen

Die API kann einen Eintrag nur aktualisieren, nicht anlegen. Die allererste
Veröffentlichung machst du von Hand in der Console. Ebenfalls dort und nicht
über dieses Skript: Datenschutz-URL, Data-Safety-Formular und
Inhaltseinstufung.
