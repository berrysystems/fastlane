#!/usr/bin/env bash
# Schreibt wrangler.toml für das Ausliefern der Werkbank auf Cloudflare Pages.
#
# Die Einstellungen des Zugangsschutzes kommen aus der Umgebung (in der CI:
# aus den Repository-Variablen). Fehlen sie, wird trotzdem ausgeliefert —
# die Seite bleibt dann geschlossen, bis sie gesetzt sind.
#
#   PAGES_PROJECT        Name des Pages-Projekts (Vorgabe: fastlane)
#   ACCESS_TEAM_DOMAIN   z. B. meinteam.cloudflareaccess.com
#   ACCESS_AUD           AUD-Tag der Access-Anwendung, mehrere mit Komma
#   SITE_HOST            Adresse der Seite, z. B. fastlane.example.com
set -euo pipefail

project="${PAGES_PROJECT:-fastlane}"
team="${ACCESS_TEAM_DOMAIN:-}"
aud="${ACCESS_AUD:-}"
host="${SITE_HOST:-}"
out="${1:-wrangler.toml}"

# Die Werte landen in einer Konfigurationsdatei. Alles außer den hier
# erlaubten Zeichen wird abgelehnt, damit niemand über eine Variable
# zusätzliche Einstellungen einschleusen kann.
check() {
  local name="$1" value="$2" pattern="$3"
  if [[ -n "$value" && ! "$value" =~ $pattern ]]; then
    echo "::error::$name enthält unerlaubte Zeichen." >&2
    exit 1
  fi
}
check PAGES_PROJECT "$project" '^[a-z0-9][a-z0-9-]{0,57}$'
check ACCESS_TEAM_DOMAIN "$team" '^[A-Za-z0-9.-]+$'
check ACCESS_AUD "$aud" '^[A-Za-z0-9, ]+$'
check SITE_HOST "$host" '^[A-Za-z0-9., -]+$'

cat > "$out" <<TOML
# Erzeugt von tools/deploy/write-wrangler-config.sh — nicht von Hand ändern.
name = "$project"
pages_build_output_dir = "docs"
compatibility_date = "2026-01-01"

[vars]
ACCESS_TEAM_DOMAIN = "$team"
ACCESS_AUD = "$aud"
ALLOWED_HOSTS = "$host"
TOML

if [[ -z "$team" || -z "$aud" || -z "$host" ]]; then
  echo "::warning::Zugangsschutz noch nicht eingerichtet (ACCESS_TEAM_DOMAIN, ACCESS_AUD oder SITE_HOST fehlt). Die Seite wird ausgeliefert, bleibt aber für alle geschlossen. Siehe ZUGANG.md."
fi
echo "wrangler.toml geschrieben für Projekt \"$project\"."
