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
weitergegeben werden sie über die Projektdatei (*Projekt → Als Datei
sichern* / *Projektdatei öffnen*).

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

Die drei Werte sind keine Geheimnisse — sie stehen bewusst unter *Variables*,
damit nachvollziehbar bleibt, was eingestellt ist.

### 7. Prüfen

In einem privaten Browserfenster:

| Aufruf                                             | Erwartet                          |
|----------------------------------------------------|-----------------------------------|
| `https://fastlane.berry-systems.de`                | Anmeldeseite von Cloudflare       |
| Anmeldung mit einer eingeladenen Adresse           | Code per E-Mail, danach die Werkbank; oben rechts steht die Adresse |
| Anmeldung mit einer fremden Adresse                | kein Code, kein Zugang            |
| `https://<projekt>.pages.dev`                      | „Kein Zugriff — Diese Adresse ist gesperrt“ |
| `https://berrysystems.github.io/fastlane/`         | nicht mehr erreichbar             |

## Server-Funktionen freischalten

Vier Funktionen laufen über den Türsteher bei Cloudflare statt im Browser.
Jede ist **aus**, bis sie ausdrücklich eingeschaltet wird. Eingeschaltet wird
im GitHub-Repo unter *Settings → Secrets and variables → Actions →
Variables*; danach *Seite veröffentlichen* starten. Geheimnisse werden nie
automatisch kopiert — sie hinterlegst du von Hand im Pages-Projekt unter
*Settings → Variables and Secrets* als **Secret**.

| Funktion | Variable in GitHub | Zusätzlich bei Cloudflare |
|---|---|---|
| Store-Eintrag aus Play laden | `PLAY_IN_WERKBANK` = `true` | Secret `GOOGLE_SERVICE_ACCOUNT_KEY` |
| Direkt veröffentlichen | `PLAY_PUBLISH_IN_WERKBANK` = `true` und `PUBLISHERS` | Secret `GOOGLE_SERVICE_ACCOUNT_KEY` |
| Textvorschläge per Knopf | `AI_IN_WERKBANK` = `true` | Secret `ANTHROPIC_API_KEY` |
| Team-Ablage | `TEAM_KV_ID` | ein KV-Namespace |

### Store-Eintrag aus Play laden

Im Schritt *Texte* holt *Aus Play laden* die aktuellen Store-Texte aller
Sprachen. Es wird nur gelesen. `GOOGLE_SERVICE_ACCOUNT_KEY` ist der komplette
Inhalt der JSON-Schlüsseldatei des Dienstkontos — derselbe Schlüssel wie im
GitHub-Secret `PLAY_SERVICE_ACCOUNT_KEY`.

Jedes eingeladene Mitglied kann damit die Texte aller Apps abrufen, auf die
das Dienstkonto in der Play Console Zugriff hat.

### Direkt veröffentlichen

Im Schritt *Export* erscheinen *Probelauf* und *Jetzt veröffentlichen*. Die
Werkbank rendert alle Sprachen und Geräte und schickt Texte und Bilder zu
Google Play — ohne ZIP und Repo.

- **`PUBLISHERS`** ist die Liste der E-Mail-Adressen, die veröffentlichen
  dürfen, mit Komma getrennt. Ist sie leer, darf es niemand — auch wenn der
  Schalter an ist. Alle anderen Mitglieder sehen die Knöpfe nicht.
- **Probelauf** lässt Google den Eintrag prüfen und verwirft ihn danach. Im
  Store ändert sich nichts.
- **Veröffentlichen** fragt nach und ersetzt dann Texte und Bilder aller
  Sprachen im Projekt. Die Änderungen gehen in die Prüfung bei Google.
- Bricht etwas ab, wird der Vorgang bei Google verworfen.
- Das Dienstkonto braucht in der Play Console das Recht, den Store-Eintrag
  zu bearbeiten.

Änderungshinweise („Was ist neu“) gehören zu einem Release und werden so
nicht übertragen; dafür bleibt der Weg über ZIP und Workflow.

### Textvorschläge per Knopf

Im Schritt *Briefing* schickt *Vorschläge direkt erzeugen* den Auftrag an
die Claude-API und füllt Texte und Captions. `ANTHROPIC_API_KEY` ist ein
Schlüssel aus der [Claude Console](https://platform.claude.com/). Jede
Anfrage kostet Geld auf diesem Konto — je nach Zahl der Sprachen wenige Cent.
Der Weg über *Auftrag kopieren* bleibt daneben bestehen und kostet nichts.

### Team-Ablage

Im Dialog *Projekt* erscheint die *Team-Ablage*: Mitglieder legen ein Projekt
fürs Team ab, andere öffnen eine Kopie davon. Es gibt kein gleichzeitiges
Bearbeiten — wer ablegt, ersetzt den abgelegten Stand. Hat jemand anderes
inzwischen abgelegt, fragt die Werkbank vorher nach.

Einrichten: im Cloudflare-Dashboard unter *Storage & Databases → KV* einen
Namespace anlegen (Name beliebig, z. B. `werkbank-team`) und dessen **ID**
(32 Zeichen) als Variable `TEAM_KV_ID` in GitHub eintragen.

Ein Projekt darf höchstens 24 MB groß sein. Größere gibst du weiterhin als
Datei weiter.

### Wer hat was getan?

Abruf, Veröffentlichen, Vorschläge und Ablegen stehen mit der E-Mail-Adresse
des Mitglieds in den Logs des Pages-Projekts.

### Abschalten

Die Variable entfernen und neu ausliefern — der Türsteher lehnt die Funktion
dann ab. Das zugehörige Secret zusätzlich im Pages-Projekt löschen.

## Logo auf der Anmeldeseite

Die Anmeldeseite von Cloudflare Access lädt ihr Logo über eine Adresse, die
**ohne Anmeldung** erreichbar sein muss — sie wird ja gezeigt, bevor jemand
angemeldet ist. Die Werkbank selbst liegt hinter Access und taugt dafür
nicht.

Solange dieses Repo öffentlich ist, geht die Adresse der Datei auf GitHub:

```
https://raw.githubusercontent.com/berrysystems/fastlane/main/docs/assets/brand/logo.png
```

In Zero Trust unter *Settings → Custom pages* (bzw. *Reusable components →
Custom pages*) die **Login page** bearbeiten, die Adresse als **Logo URL**
eintragen und speichern. Dort lassen sich auch Name, Hintergrundfarbe und
Text der Seite anpassen — passend zum Logo zum Beispiel `#0F1318` als
Hintergrund.

Wird das Repo privat gestellt, ist das Logo unter dieser Adresse nicht mehr
erreichbar. Dann die Datei an einem anderen öffentlichen Ort ablegen (etwa
auf der Website von berry-systems.de) und die Adresse dort eintragen.

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
  Auf geteilten Geräten die Projekte vor dem Abmelden als Datei sichern und
  in der Projektliste löschen.
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
| Ein Knopf fehlt (*Aus Play laden*, *Vorschläge direkt erzeugen*, *Jetzt veröffentlichen*, *Team-Ablage*) | Die Funktion ist nicht eingeschaltet, das Secret fehlt, oder — beim Veröffentlichen — deine Adresse steht nicht in `PUBLISHERS`. Nach dem Ändern neu ausliefern und die Seite neu laden. Lokal gibt es diese Knöpfe nie. |
| „Die Anmeldung des Dienstkontos bei Google ist fehlgeschlagen“ | Das Secret `GOOGLE_SERVICE_ACCOUNT_KEY` ist unvollständig eingefügt oder der Schlüssel wurde bei Google gelöscht. |
| „Das Dienstkonto hat für diese App nicht die nötige Berechtigung“ | In der Play Console fehlt dem Dienstkonto das Recht für diese App. |
| „Der hinterlegte Schlüssel für die Claude-API ist ungültig“ | Das Secret `ANTHROPIC_API_KEY` prüfen. |

## Offizielle Anleitungen

- [Cloudflare Pages: eigene Domain](https://developers.cloudflare.com/pages/configuration/custom-domains/)
- [Cloudflare Pages: bekannte Einschränkungen mit Access](https://developers.cloudflare.com/pages/platform/known-issues/)
- [Access: Anwendungstoken und AUD-Tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Access: Sitzungen verwalten und widerrufen](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Ausliefern aus GitHub Actions](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
