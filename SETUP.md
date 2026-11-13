# Repo einrichten

## Struktur

```
mein-app-repo/
├─ docs/
│  ├─ index.html                     das Browser-Tool
│  └─ assets/                        Styles, Skript, Schriften, JSZip
├─ tools/
│  └─ play-publish/                  publish.js, package.json, Tests
├─ tests/
│  └─ e2e/                           Browser-Tests (Playwright)
├─ fastlane/
│  └─ metadata/android/de-DE/        Ziel des ZIP-Exports
├─ .github/workflows/
│  ├─ ci.yml                         Tests bei jedem Push und Pull Request
│  ├─ deploy-pages.yml               veröffentlicht docs/
│  ├─ pull-listing.yml               holt die Texte des bestehenden Eintrags
│  └─ publish-listing.yml            lädt das Listing hoch
└─ .gitignore
```

## GitHub Pages aktivieren

*Settings → Pages*, bei **Source** die Option **GitHub Actions** wählen —
nicht „Deploy from a branch“, sonst greift dieser Workflow nicht.

Danach einmal pushen oder den Workflow unter *Actions → Seite veröffentlichen
→ Run workflow* starten. Die Adresse steht anschließend im Job unter
*deploy* und lautet `https://<name>.github.io/<repo>/`.

Bei einem privaten Repo ist Pages nur mit bezahltem Plan verfügbar. Die
HTML-Datei funktioniert aber genauso per Doppelklick vom eigenen Rechner.

## Secrets für den Upload

*Settings → Secrets and variables → Actions*

| Typ      | Name                       | Inhalt                          |
|----------|----------------------------|---------------------------------|
| Secret   | `PLAY_SERVICE_ACCOUNT_KEY` | kompletter JSON-Schlüssel       |
| Variable | `PACKAGE_NAME`             | z. B. `com.example.app`         |

Den Schlüssel als Secret anlegen, nicht als Variable — Variablen sind in
Logs sichtbar.

Der Paketname darf auch als Secret `PACKAGE_NAME` angelegt sein; die
Workflows lesen beides. Er erscheint dann in den Logs als `***`.

## Mit einem bestehenden Eintrag anfangen

1. *Actions → Play-Listing herunterladen → Run workflow*
2. Im fertigen Lauf unten das Artefakt `play-listing` laden
3. In der Werkbank: *Texte → ZIP importieren*

Damit stehen die aktuellen Texte aller Sprachen im Projekt. Im Store ändert
der Workflow nichts.

## Ablauf bei einem Release

1. Seite öffnen, Screenshots und Texte pflegen, ZIP exportieren
2. ZIP entpacken, den Ordner `fastlane/` ins Repo legen, committen
3. *Actions → Play-Listing veröffentlichen* starten, erst als Probelauf
4. Wenn die Prüfung sauber durchläuft, den Haken entfernen und erneut starten

Der Workflow prüft die Dateien zuerst lokal (`--check`) und bricht ab, bevor
überhaupt Zugangsdaten angefasst werden, wenn etwas nicht passt.

Das Tool speichert den Stand automatisch im Browser. Die Projektdatei
(`*-projekt.json`, über *Sichern*) kannst du zusätzlich mit ins Repo legen —
dann fängt auch ein anderer Rechner beim nächsten Release nicht bei null an.


## Zugriff auf die Seite

Die Seite ist ein reines Werkzeug: Sie enthält keine Zugangsdaten, lädt nichts
nach und schickt nichts weg. Bilder, Texte und der gespeicherte Stand bleiben
im Browser dessen, der sie benutzt. Ein Passwortschutz ist deshalb nicht
nötig. Wer sie trotzdem nicht öffentlich haben will, nutzt sie lokal per
Doppelklick oder setzt einen Zugangsschutz davor (GitHub Pages selbst bietet
das nur im Enterprise-Tarif).

## Screenshots automatisch aufnehmen

Gute Store-Screenshots stehen und fallen mit dem Rohmaterial: echte App,
aufgeräumte Beispieldaten, immer dasselbe Gerät. Wer das nicht bei jedem
Release von Hand machen will, lässt die App die Aufnahmen selbst erzeugen —
zum Beispiel mit [Maestro](https://maestro.mobile.dev/) im App-Repo:

```yaml
# .maestro/screenshots.yaml
appId: com.example.app
---
- launchApp:
    clearState: true
- takeScreenshot: 01-start
- tapOn: "Auswertung"
- takeScreenshot: 02-auswertung
```

Die erzeugten PNGs kommen in der Werkbank in Schritt 2. Rahmen, Captions und
Sprachen entstehen dort. Für Instrumentation-Tests leistet
[Fastlane Screengrab](https://docs.fastlane.tools/actions/screengrab/) dasselbe.
