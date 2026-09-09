# Repo einrichten

## Struktur

```
mein-app-repo/
├─ docs/
│  └─ index.html                     das Browser-Tool
├─ tools/
│  └─ play-publish/                  publish.js, package.json, README.md
├─ fastlane/
│  └─ metadata/android/de-DE/        Ziel des ZIP-Exports
├─ .github/workflows/
│  ├─ deploy-pages.yml               veröffentlicht docs/
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

## Ablauf bei einem Release

1. Seite öffnen, Screenshots und Texte pflegen, ZIP exportieren
2. ZIP entpacken, den Ordner `fastlane/` ins Repo legen, committen
3. *Actions → Play-Listing veröffentlichen* starten, erst als Probelauf
4. Wenn die Prüfung sauber durchläuft, den Haken entfernen und erneut starten

Die Projektdatei aus dem Tool (`*-projekt.json`) kannst du mit ins Repo
legen. Dann fängst du beim nächsten Release nicht bei null an.
