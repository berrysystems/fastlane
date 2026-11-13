/**
 * Türsteher der Listing-Werkbank auf Cloudflare Pages.
 *
 * Cloudflare Access erledigt die Anmeldung (Code per E-Mail) und hängt an jede
 * Anfrage ein signiertes Token. Dieses Skript prüft das Token noch einmal
 * selbst, bevor es eine Datei herausgibt. Damit bleibt die Seite auch dann
 * zu, wenn Access im Dashboard versehentlich abgeschaltet oder für eine
 * Adresse (etwa <projekt>.pages.dev) nie eingerichtet wurde.
 *
 * Fehlt die Konfiguration, wird nichts ausgeliefert — nie umgekehrt.
 *
 * Einstellungen des Pages-Projekts (Variablen, keine Geheimnisse):
 *   ACCESS_TEAM_DOMAIN   z. B. meinteam.cloudflareaccess.com
 *   ACCESS_AUD           „Application Audience (AUD) Tag“ der Access-Anwendung,
 *                        mehrere durch Komma getrennt
 *   ALLOWED_HOSTS        Adressen, unter denen die Seite erreichbar sein darf,
 *                        z. B. fastlane.example.com (mehrere durch Komma)
 */

// Schutz im Browser. Die Seite lädt nur eigene Dateien und spricht mit
// keinem Server; alles andere ist verboten.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  // Geschützte Inhalte gehören in keinen gemeinsamen Zwischenspeicher.
  "Cache-Control": "private, no-cache",
};

const USER_COOKIE = "wb_user";
const CLOCK_SKEW = 60;            // Sekunden Toleranz für nbf
const KEYS_TTL = 60 * 60 * 1000;  // Schlüssel eine Stunde merken
const KEYS_RETRY = 60 * 1000;     // bei unbekanntem Schlüssel frühestens nach einer Minute neu laden

/* ------------------------------------------------------------------ *
 * Konfiguration
 * ------------------------------------------------------------------ */

const list = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);

function readConfig(env) {
  const team = String((env && env.ACCESS_TEAM_DOMAIN) || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const audiences = list(env && env.ACCESS_AUD);
  const hosts = list(env && env.ALLOWED_HOSTS).map((h) => h.toLowerCase());
  // Nur echte Access-Adressen: sonst könnte eine falsche Einstellung
  // Schlüssel von einem beliebigen Server holen.
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !audiences.length || !hosts.length) return null;
  return { team, audiences, hosts };
}

/* ------------------------------------------------------------------ *
 * Token prüfen
 * ------------------------------------------------------------------ */

function decodeBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
const decodeJson = (part) => JSON.parse(new TextDecoder().decode(decodeBase64Url(part)));

const keyCache = new Map();   // team → { fetched, keys: Map<kid, CryptoKey> }

async function loadKeys(team, fetcher) {
  const res = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Schlüssel nicht abrufbar");
  const data = await res.json();
  const keys = new Map();
  for (const jwk of data.keys || []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  const entry = { fetched: Date.now(), keys };
  keyCache.set(team, entry);
  return entry;
}
async function findKey(team, kid, fetcher) {
  let entry = keyCache.get(team);
  if (!entry || Date.now() - entry.fetched > KEYS_TTL) entry = await loadKeys(team, fetcher);
  // Access wechselt die Schlüssel regelmäßig: bei unbekannter Kennung einmal nachladen.
  if (!entry.keys.has(kid) && Date.now() - entry.fetched > KEYS_RETRY) entry = await loadKeys(team, fetcher);
  return entry.keys.get(kid) || null;
}
/** Nur für Tests. */
function clearKeyCache() { keyCache.clear(); }

/**
 * Prüft ein Access-Token und gibt dessen Inhalt zurück.
 * Wirft bei jedem Zweifel — der Aufrufer behandelt jede Ausnahme als „kein Zutritt“.
 */
async function verifyAccessToken(token, config, { now = Date.now(), fetcher = fetch } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("kein Token");
  const header = decodeJson(parts[0]);
  // Das Verfahren steht fest. Ein Token, das ein anderes verlangt, ist ungültig.
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("falsches Verfahren");

  const key = await findKey(config.team, header.kid, fetcher);
  if (!key) throw new Error("unbekannter Schlüssel");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!valid) throw new Error("Signatur ungültig");

  const claims = decodeJson(parts[1]);
  const seconds = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${config.team}`) throw new Error("falscher Aussteller");
  if (!audiences.some((aud) => config.audiences.includes(aud))) throw new Error("falsche Anwendung");
  if (typeof claims.exp !== "number" || claims.exp <= seconds) throw new Error("abgelaufen");
  if (typeof claims.nbf === "number" && claims.nbf > seconds + CLOCK_SKEW) throw new Error("noch nicht gültig");
  // Nur Menschen mit E-Mail-Adresse, keine Dienst-Token.
  if (typeof claims.email !== "string" || !claims.email.includes("@")) throw new Error("keine Person");
  return claims;
}

function tokenFrom(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") || "";
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? match[1] : "";
}

/* ------------------------------------------------------------------ *
 * Antworten
 * ------------------------------------------------------------------ */

function secure(response, extra = {}) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(name, value);
  return out;
}

function deny(status, message) {
  const body = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Kein Zugriff</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.25rem;color:#131a24">
<h1 style="font-size:1.4rem">Kein Zugriff</h1><p>${message}</p></body></html>`;
  return secure(new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }),
    { "Cache-Control": "no-store" });
}

// Die Workers-Laufzeit erlaubt neben dem Standard-Export nur Handler.
// Was Tests und der lokale Testserver brauchen, hängt deshalb hier an.
export default {
  internals: { SECURITY_HEADERS, USER_COOKIE, readConfig, verifyAccessToken, clearKeyCache },

  async fetch(request, env) {
    const config = readConfig(env);
    if (!config) return deny(503, "Der Zugangsschutz dieser Seite ist noch nicht eingerichtet.");

    const url = new URL(request.url);
    if (!config.hosts.includes(url.hostname.toLowerCase())) {
      return deny(403, "Diese Adresse ist gesperrt. Bitte die offizielle Adresse der Werkbank verwenden.");
    }

    let claims;
    try { claims = await verifyAccessToken(tokenFrom(request), config); }
    catch (_) { return deny(403, "Die Werkbank ist nur für eingeladene Mitglieder des Teams zugänglich. Bitte melde dich an."); }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return secure(new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }));
    }

    const response = secure(await env.ASSETS.fetch(request));
    // Damit die Seite zeigen kann, wer angemeldet ist. Das eigentliche
    // Anmelde-Cookie bleibt für Skripte unsichtbar.
    if ((response.headers.get("Content-Type") || "").includes("text/html")) {
      response.headers.append("Set-Cookie",
        `${USER_COOKIE}=${encodeURIComponent(claims.email)}; Path=/; Secure; SameSite=Strict`);
    }
    return response;
  },
};
