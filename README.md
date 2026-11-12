# Play-Listing-Toolkit

Erzeugt die Assets und Texte für einen Play-Store-Eintrag und lädt sie hoch.

Zwei getrennte Teile:

- **`docs/`** — die *Listing-Werkbank*, ein Werkzeug, das komplett im Browser
  läuft. Rahmt Screenshots, baut die Feature Graphic, erzeugt den Icon-Satz,
  prüft die Store-Texte und exportiert alles als ZIP.
- **`tools/play-publish/`** — ein Node-Skript, das dieses Ergebnis über die
  Google Play Developer API in die Console schiebt.

## Schnellstart

Nur ausprobieren: `docs/index.html` doppelklicken. Es braucht keinen Server
und keine Internetverbindung — Schriften und ZIP-Bibliothek liegen in
`docs/assets/`, es wird nichts von fremden Servern geladen und nichts
verlässt deinen Rechner.

Als Seite bereitstellen: siehe [SETUP.md](SETUP.md).

Hochladen einrichten: siehe [tools/play-publish/README.md](tools/play-publish/README.md).

## Was die Werkbank kann

Die Oberfläche führt in sechs Schritten zum fertigen Paket. Jeder Schritt
zeigt oben seinen Stand, die Checkliste im letzten Schritt springt direkt zu
dem, was noch fehlt.

1. **Icon** — Store-Icon 512 × 512 plus den adaptiven Launcher-Satz in allen
   fünf Dichten, samt Monochrome-Ebene, Legacy- und Rund-Icons und den
   passenden XML-Dateien. Die Vorschau zeigt das Ergebnis unter Kreis-,
   Squircle- und Rechteckmaske.
2. **Screenshots** — fünf Layouts, Panorama über mehrere Frames, saubere
   Statusleiste statt der aufgenommenen, Vorschau in Thumbnail-Größe.
   Tablet-Formate landen automatisch im richtigen Ordner
   (`sevenInchScreenshots`, `tenInchScreenshots`).
3. **Feature Graphic** — 1024 × 500 mit Sicherheitsbereich. Titel und
   Untertitel kommen automatisch aus den Store-Texten, solange du nichts
   anderes einträgst.
4. **Texte** — Zeichenzähler auf die Limits der Console, Vorschau des
   Anrisses und eine Prüfung auf Formulierungen, die bei der Review auffallen.
5. **Vorschau** — Icon, Titel und Screenshots zusammen, wie auf der Store-Seite.
6. **Export** — Checkliste, ZIP in Fastlane-Struktur, nächster Befehl zum Kopieren.

Dazu:

- **Farben** aus dem Logo, mit Kontrastprüfung für Captions und Feature Graphic.
- **Automatisches Speichern** im Browser (IndexedDB). Nach einem Neuladen ist
  der letzte Stand wieder da.
- **Projektdatei** (`*-projekt.json`) über *Sichern* / *Öffnen* — zum
  Mitnehmen, Weitergeben oder Einchecken. Sie enthält die Originalbilder
  unverändert.
- Helles und dunkles Design folgen der Systemeinstellung.

## Ablauf bei einem Release

1. Seite öffnen, Screenshots und Texte pflegen, ZIP exportieren
2. Den Ordner `fastlane/` aus dem ZIP ins Repo legen und committen
3. `node tools/play-publish/publish.js --check` — prüft lokal, ohne Zugangsdaten
4. `node tools/play-publish/publish.js --package … --dry-run` — lässt Google
   zusätzlich validieren, veröffentlicht nichts
5. Ohne `--dry-run` erneut ausführen, oder den Workflow in Actions starten

## Aufbau

```
docs/
  index.html            Seitengerüst
  assets/app.css        Gestaltung
  assets/app.js         Logik, ohne Build-Schritt
  assets/fonts/         Schriften (SIL Open Font License)
  assets/vendor/        JSZip 3.10.1 (MIT)
tools/play-publish/     Upload-Skript mit Tests
fastlane/metadata/      Ziel des ZIP-Exports
.github/workflows/      Seite ausliefern, Listing hochladen, Tests
```

## Entwickeln

Das Browser-Tool hat bewusst keinen Build: Datei ändern, Seite neu laden.

```bash
cd tools/play-publish
```

```bash
npm ci
```

```bash
npm test
```

## Grenzen

Die API kann einen Eintrag nur aktualisieren, nicht anlegen. Die erste
Veröffentlichung machst du von Hand in der Console. Ebenso Datenschutz-URL,
Data-Safety-Formular und Inhaltseinstufung.

Die Werkbank pflegt eine Sprache pro Projekt. Für weitere Sprachen das
Projekt sichern, Sprache und Texte ändern und erneut exportieren — die ZIPs
ergänzen sich im Ordner `fastlane/metadata/android/`.
