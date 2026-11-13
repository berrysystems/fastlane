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

Die Oberfläche führt in sieben Schritten zum fertigen Paket. Jeder Schritt
zeigt oben seinen Stand, die Checkliste im letzten Schritt springt direkt zu
dem, was noch fehlt.

1. **Icon** — Store-Icon 512 × 512 plus den adaptiven Launcher-Satz in allen
   fünf Dichten, samt Monochrome-Ebene, Legacy- und Rund-Icons und den
   passenden XML-Dateien.
2. **Screenshots** — fünf Layouts, Panorama über mehrere Frames, saubere
   Statusleiste statt der aufgenommenen. Reihenfolge per Ziehen; einzelne
   Screenshots können ein eigenes Layout und eigene Farben bekommen, die
   Überschriften eine eigene Markenschrift. Tablet-Formate landen automatisch
   im richtigen Ordner.
3. **Briefing** — was die App tut, für wen, was die Screenshots zeigen.
   Daraus entsteht ein fertiger Auftrag für einen KI-Assistenten; dessen
   Antwort füllt Store-Texte, Namensalternativen und Captions für alle
   Sprachen. Die Seite selbst spricht mit keiner KI und braucht keinen
   API-Schlüssel.
4. **Texte** — Zeichenzähler auf die Limits der Console, Vorschau des
   Anrisses und eine Prüfung auf Formulierungen, die bei der Review auffallen.
   Ein bestehender Eintrag lässt sich als ZIP oder Fastlane-Ordner importieren.
5. **Feature Graphic** — 1024 × 500 mit Sicherheitsbereich. Titel und
   Untertitel kommen aus den Store-Texten, solange du nichts anderes einträgst.
6. **Vorschau** — Icon, Titel und Screenshots zusammen, wie auf der Store-Seite.
7. **Export** — Checkliste, ZIP in Fastlane-Struktur, nächster Befehl zum Kopieren.

Dazu:

- **Mehrere Sprachen** in einem Projekt (Auswahl oben rechts). Jede Sprache
  hat eigene Store-Texte und Captions; der Export rendert Screenshots und
  Feature Graphic für jede Sprache und legt sie in ihren Ordner.
- **Rückgängig / Wiederholen** für alles, auch für entfernte Bilder und
  übernommene Textvorschläge (Strg+Z außerhalb von Textfeldern).
- **Farben** aus dem Logo, mit Kontrastprüfung für Captions und Feature Graphic.
- **Automatisches Speichern** im Browser (IndexedDB). Nach einem Neuladen ist
  der letzte Stand wieder da.
- **Projektdatei** (`*-projekt.json`) über *Sichern* / *Öffnen* — zum
  Mitnehmen, Weitergeben oder Einchecken. Sie enthält die Originalbilder
  unverändert. Dateien älterer Versionen werden übernommen.
- Helles und dunkles Design folgen der Systemeinstellung.

## Ablauf bei einem Release

0. Gibt es die App schon im Store: Texte mit
   `node tools/play-publish/publish.js --package … --pull` holen und in der
   Werkbank importieren
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
tests/e2e/              Browser-Tests der Werkbank (Playwright)
fastlane/metadata/      Ziel des ZIP-Exports
.github/workflows/      Seite ausliefern, Listing hochladen, Tests
```

## Entwickeln

Das Browser-Tool hat bewusst keinen Build: Datei ändern, Seite neu laden.

Tests des Upload-Skripts:

```bash
cd tools/play-publish && npm ci && npm test
```

Browser-Tests der Werkbank (einmalig vorher `npx playwright install`):

```bash
cd tests/e2e && npm ci && npx playwright test
```

Die CI führt beides bei jedem Pull Request aus, die Browser-Tests in
Chromium, Firefox und WebKit.

## Grenzen

Die API kann einen Eintrag nur aktualisieren, nicht anlegen. Die erste
Veröffentlichung machst du von Hand in der Console. Ebenso Datenschutz-URL,
Data-Safety-Formular und Inhaltseinstufung.

Screenshots müssen die echte App zeigen. Die Werkbank rahmt und beschriftet
sie, erfindet aber keine Oberflächen — das wäre ein Ablehnungsgrund bei der
Review.

Texte aus dem Briefing sind Vorschläge. Die Prüfung in Schritt 4 fängt
Richtlinienverstöße und Überlängen ab, das Gegenlesen ersetzt sie nicht.
