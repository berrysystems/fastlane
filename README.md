# Play-Listing-Toolkit

Erzeugt die Assets und Texte für einen Play-Store-Eintrag und lädt sie hoch.

Zwei getrennte Teile:

- **`docs/index.html`** — ein Werkzeug, das komplett im Browser läuft. Rahmt
  Screenshots, baut die Feature Graphic, erzeugt den Icon-Satz, prüft die
  Store-Texte und exportiert alles als ZIP.
- **`tools/play-publish/`** — ein Node-Skript, das dieses Ergebnis über die
  Google Play Developer API in die Console schiebt.

## Schnellstart

Nur ausprobieren: `docs/index.html` doppelklicken. Es braucht keinen Server,
und es verlässt nichts deinen Rechner.

Als Seite bereitstellen: siehe [SETUP.md](SETUP.md).

Hochladen einrichten: siehe [tools/play-publish/README.md](tools/play-publish/README.md).

## Was das Browser-Tool kann

**Screenshots** — fünf Layouts, Panorama über mehrere Frames, saubere
Statusleiste statt der aufgenommenen, Vorschau in Thumbnail-Größe, damit du
siehst, ob die Caption in den Suchergebnissen noch lesbar ist.

**Feature Graphic** — 1024 × 500, mit Sicherheitsbereich für den Beschnitt.

**Icon** — Store-Icon 512 × 512 plus den adaptiven Launcher-Satz in allen
fünf Dichten, samt Monochrome-Ebene und `ic_launcher.xml`. Die Vorschau zeigt
das Ergebnis unter Kreis-, Squircle- und Rechteckmaske.

**Farben** — zieht die Palette aus deinem Logo und prüft den Kontrast der
Caption gegen den Hintergrund.

**Texte** — Zeichenzähler auf die Limits der Console, Vorschau mit denselben
Abschnitten wie im Store, und eine Prüfung auf Formulierungen, die bei der
Review auffallen.

**Projekt speichern** — eine JSON-Datei mit allem drin, für das nächste
Release.

## Ablauf bei einem Release

1. Seite öffnen, Screenshots und Texte pflegen, ZIP exportieren
2. Den Ordner `fastlane/` aus dem ZIP ins Repo legen und committen
3. `node tools/play-publish/publish.js --package … --dry-run` — prüft lokal
   und bei Google, veröffentlicht nichts
4. Ohne `--dry-run` erneut ausführen, oder den Workflow in Actions starten

## Grenzen

Die API kann einen Eintrag nur aktualisieren, nicht anlegen. Die erste
Veröffentlichung machst du von Hand in der Console. Ebenso Datenschutz-URL,
Data-Safety-Formular und Inhaltseinstufung.
