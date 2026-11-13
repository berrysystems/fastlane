# Zugang zur Werkbank

Die Werkbank läuft unter einer festen Adresse und ist nur nach Anmeldung
erreichbar. Wer hinein darf, bestimmt eine Liste von E-Mail-Adressen. Jede
Person meldet sich mit ihrer eigenen Adresse an — es gibt kein gemeinsames
Passwort.

## So funktioniert es

```
Browser ──► Cloudflare Access ──► Cloudflare Pages ──► docs/_worker.js ──► Dateien
            Anmeldung per          Auslieferung         prüft die Anmeldung
            E-Mail-Code                                 noch einmal selbst
```

- **Cloudflare Access** zeigt die Anmeldeseite. Wer auf der Liste steht,
  bekommt einen Einmal-Code per E-Mail. Alle anderen bekommen keinen.
- **`docs/_worker.js`** läuft bei Cloudflare vor jeder Datei und prüft die
  Anmeldung ein zweites Mal. Ohne gültige Anmeldung liefert es nichts aus —
  auch dann nicht, wenn Access im Dashboard versehentlich abgeschaltet wird
  oder jemand die technische Adresse `<projekt>.pages.dev` aufruft.
- Fehlt eine Einstellung, bleibt die Seite **geschlossen**, nie offen.

Projekte liegen weiterhin im Browser der jeweiligen Person. Im Team
weitergegeben werden sie über die Projektdatei (*Sichern* / *Öffnen*).

## Einmalig einrichten

Die Menüs im Cloudflare-Dashboard ändern sich gelegentlich. Die Schritte
nennen deshalb, *was* einzustellen ist; die offiziellen Anleitungen sind am
Ende verlinkt.

### 1. Domain zu Cloudflare

Access kann nur Adressen schützen, deren Domain bei Cloudflare verwaltet
wird. `berry-systems.de` muss deshalb als Website in Cloudflare angelegt und
die Nameserver beim Domain-Anbieter müssen auf Cloudflare umgestellt sein.

> **Achtung:** Das betrifft die ganze Domain, auch E-Mail. Cloudflare
> übernimmt beim Anlegen die vorhandenen DNS-Einträge — vor dem Umstellen der
> Nameserver bitte prüfen, dass alle Einträge (vor allem MX, SPF, DKIM) dort
> angekommen sind.

Wer die Domain nicht umziehen will: Schritt 4 auslassen und die Werkbank
unter der Adresse `<projekt>.pages.dev` betreiben. Alles andere bleibt gleich.

### 2. Zugangsdaten für das Ausliefern

Im Cloudflare-Dashboard:

- **Account-ID** notieren (steht auf der Übersichtsseite des Kontos).
- Ein **API-Token** anlegen mit dem Recht *Account → Cloudflare Pages → Edit*.

Im GitHub-Repo unter *Settings → Secrets and variables → Actions → Secrets*:

| Secret                  | Inhalt        |
|-------------------------|---------------|
| `CLOUDFLARE_API_TOKEN`  | das API-Token |
| `CLOUDFLARE_ACCOUNT_ID` | die Account-ID |

### 3. Erstes Ausliefern

*Actions → Seite veröffentlichen → Run workflow*. Der Lauf legt das
Pages-Projekt `fastlane` an und lädt die Seite hoch.

Die Seite antwortet jetzt mit „Der Zugangsschutz dieser Seite ist noch nicht
eingerichtet“. Das ist richtig so — sie ist bis Schritt 6 für alle
geschlossen.

### 4. Adresse verbinden

1. Im GitHub-Repo unter *Settings → Pages* die eigene Domain entfernen und
   die Seite über **Unpublish site** abschalten. Sonst bleibt dort eine
   ungeschützte Kopie erreichbar.
2. In Cloudflare beim Pages-Projekt unter *Custom domains* die Adresse
   `fastlane.berry-systems.de` hinzufügen.

Die Reihenfolge ist wichtig: Cloudflare kann eine Adresse nicht mit Pages
verbinden, solange schon eine Access-Anwendung auf ihr liegt. Also erst
verbinden, dann Schritt 5.

### 5. Anmeldung einrichten (Cloudflare Zero Trust)

1. Zero Trust öffnen. Beim ersten Mal einen **Teamnamen** wählen — daraus
   wird die Team-Adresse `<teamname>.cloudflareaccess.com`. Der kostenlose
   Tarif reicht.
2. Als Anmeldeverfahren **One-time PIN** aktivieren (Code per E-Mail).
3. Eine **Access-Anwendung** vom Typ *Self-hosted* anlegen:
   - Adresse: `fastlane.berry-systems.de`
   - Sitzungsdauer: 24 Stunden ist ein guter Wert
4. Dazu eine **Richtlinie** mit Aktion *Allow* und der Regel *Emails*: die
   Adressen aller Personen eintragen, die Zugang haben sollen.
5. In den Einstellungen der Anwendung das **Application Audience (AUD) Tag**
   kopieren — eine lange Zeichenfolge.

### 6. Türsteher scharf schalten

Im GitHub-Repo unter *Settings → Secrets and variables → Actions →
Variables*:

| Variable             | Inhalt                                  |
|----------------------|------------------------------------------|
| `ACCESS_TEAM_DOMAIN` | `<teamname>.cloudflareaccess.com`        |
| `ACCESS_AUD`         | das AUD-Tag aus Schritt 5                |
| `SITE_HOST`          | `fastlane.berry-systems.de`              |

Danach *Actions → Seite veröffentlichen → Run workflow* erneut starten.

Die drei Werte sind keine Geheimnisse — unter *Variables* bleibt
nachvollziehbar, was eingestellt ist. Gleichnamige *Secrets* liest der
Workflow ebenfalls; eine Variable hat Vorrang.

### 7. Prüfen

In einem privaten Browserfenster:

| Aufruf                                             | Erwartet                          |
|----------------------------------------------------|-----------------------------------|
| `https://fastlane.berry-systems.de`                | Anmeldeseite von Cloudflare       |
| Anmeldung mit einer eingeladenen Adresse           | Code per E-Mail, danach die Werkbank; oben rechts steht die Adresse |
| Anmeldung mit einer fremden Adresse                | kein Code, kein Zugang            |
| `https://<projekt>.pages.dev`                      | „Kein Zugriff — Diese Adresse ist gesperrt“ |
| `https://berrysystems.github.io/fastlane/`         | nicht mehr erreichbar             |

## Jemanden einladen

1. Zero Trust → die Access-Anwendung der Werkbank → Richtlinie bearbeiten.
2. Die E-Mail-Adresse zur Regel *Emails* hinzufügen und speichern.
3. Der Person die Adresse der Werkbank schicken. Sie gibt dort ihre
   E-Mail-Adresse ein und bekommt den Code.

Es muss nichts neu ausgeliefert werden; die Einladung gilt sofort.

Bei mehreren Anwendungen lohnt sich eine **Gruppe** (Access Group) „Team“:
Die Richtlinie verweist auf die Gruppe, und eingeladen wird nur noch dort.

## Zugang entziehen

1. Die Adresse aus der Regel *Emails* (oder der Gruppe) entfernen.
2. In Zero Trust beim Nutzer die laufenden **Sitzungen widerrufen** — sonst
   bleibt eine bestehende Anmeldung bis zum Ablauf der Sitzungsdauer gültig.

Projekte, die die Person in ihrem Browser gespeichert oder als Datei
gesichert hat, bleiben bei ihr.

## Was der Schutz abdeckt — und was nicht

- **Geschützt** ist die gehostete Seite: Ohne Anmeldung liefert sie keine
  einzige Datei aus.
- **Nicht geheim** ist der Quelltext, solange dieses Repo öffentlich ist.
  Jeder kann es klonen und `docs/index.html` lokal öffnen. Soll auch das
  nicht gehen, das Repo unter *Settings → General → Change visibility* auf
  privat stellen.
- **Gemeinsam genutzte Rechner:** Projekte liegen im Browser. Nach dem
  Abmelden sind sie für die nächste Person im selben Browserprofil sichtbar.
  Auf geteilten Geräten vor dem Abmelden *Sichern* und dann *Neu* wählen.
- **Zugangsdaten für Google Play** liegen nie in der Seite, sondern nur als
  Secret in GitHub. Wer die Werkbank benutzen darf, kann damit nichts
  veröffentlichen — das geht nur über die Workflows im Repo.

## Wenn etwas nicht geht

| Meldung                                              | Ursache |
|------------------------------------------------------|---------|
| „Der Zugangsschutz … ist noch nicht eingerichtet“    | Eine der drei Variablen aus Schritt 6 fehlt oder `ACCESS_TEAM_DOMAIN` endet nicht auf `.cloudflareaccess.com`. Danach neu ausliefern. |
| „Diese Adresse ist gesperrt“                         | Die aufgerufene Adresse steht nicht in `SITE_HOST`. |
| „… nur für eingeladene Mitglieder“ nach erfolgreicher Anmeldung | `ACCESS_AUD` passt nicht zur Access-Anwendung, oder `ACCESS_TEAM_DOMAIN` gehört zu einem anderen Team. |
| Kein Code kommt an                                   | Die Adresse steht nicht in der Richtlinie, oder die Mail liegt im Spam. |

## Offizielle Anleitungen

- [Cloudflare Pages: eigene Domain](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Cloudflare Pages: bekannte Einschränkungen mit Access](https://developers.cloudflare.com/pages/platform/known-issues/)
- [Access: Anwendungstoken und AUD-Tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Access: Sitzungen verwalten und widerrufen](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Ausliefern aus GitHub Actions](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
