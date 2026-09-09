# Play-Listing veröffentlichen

Lädt die Texte, Listing-Bilder und optional ein App Bundle über die
Google Play Developer API hoch — aus dem ZIP, das der Asset-Generator ausgibt.

Alles passiert in einem einzigen Edit. Schlägt ein Schritt fehl, wird der Edit
verworfen und im Store ändert sich nichts.

## Einrichten

**1. Service-Account anlegen**

In der [Google Cloud Console](https://console.cloud.google.com/) ein Projekt
wählen, die
[Google Play Android Developer API](https://console.cloud.google.com/apis/api/androidpublisher.googleapis.com)
aktivieren, unter
[IAM & Verwaltung → Dienstkonten](https://console.cloud.google.com/iam-admin/serviceaccounts)
ein Konto anlegen und im Reiter *Schlüssel* einen JSON-Schlüssel erzeugen.
Eine IAM-Rolle im Cloud-Projekt braucht das Konto dafür nicht — die
Berechtigungen kommen im nächsten Schritt aus der Play Console.

**2. In der Play Console berechtigen**

Die frühere Verknüpfung eines Cloud-Projekts mit dem Entwicklerkonto ist nicht
mehr nötig. Stattdessen lädst du das Dienstkonto als Nutzer ein:

1. <https://play.google.com/console/users-and-permissions> öffnen — in der
   linken Navigation ganz unten unter *Nutzer und Berechtigungen*. Achte
   darauf, auf der Kontoebene zu sein, nicht in einer einzelnen App.
2. *Neue Nutzer einladen*
3. Die E-Mail des Dienstkontos eintragen, Form
   `name@projekt-id.iam.gserviceaccount.com`
4. Unter *App-Berechtigungen* deine App wählen und mindestens das Bearbeiten
   des Store-Eintrags erlauben. Für Binaries zusätzlich das Verwalten der
   Tracks, auf die du hochladen willst.
5. *Nutzer einladen*

Die Rechte greifen meist sofort. Bei einem frisch angelegten Dienstkonto kann
der erste Aufruf trotzdem mit 401 fehlschlagen — dann kurz warten und erneut
versuchen.

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
