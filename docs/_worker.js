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
 *
 * Optional — Abruf des bestehenden Store-Eintrags für angemeldete Mitglieder:
 *   PLAY_API                     "on" schaltet /api/listing frei
 *   GOOGLE_SERVICE_ACCOUNT_KEY   Geheimnis: JSON-Schlüssel des Dienstkontos
 */

// Schutz im Browser. Die Seite lädt nur eigene Dateien und spricht nur mit
// ihrem eigenen Server; alles andere ist verboten.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
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
function clearKeyCache() { keyCache.clear(); googleToken = null; }

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
 * Abruf aus Google Play
 *
 * Holt die Texte des bestehenden Store-Eintrags. Der Schlüssel des
 * Dienstkontos liegt nur hier als Geheimnis und erreicht nie den Browser.
 * Es wird ausschließlich gelesen: der dafür nötige Edit wird verworfen.
 * ------------------------------------------------------------------ */

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PLAY_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/";

const encodeBase64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeJson = (value) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8" },
});

function readServiceAccount(env) {
  try {
    const key = JSON.parse(String(env.GOOGLE_SERVICE_ACCOUNT_KEY || ""));
    return key && key.client_email && key.private_key ? key : null;
  } catch (_) { return null; }
}

let googleToken = null;   // { email, value, expires }

async function googleAccessToken(key) {
  if (googleToken && googleToken.email === key.client_email && googleToken.expires > Date.now() + 60000) return googleToken.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encodeJson({ alg: "RS256", typ: "JWT", kid: key.private_key_id }) + "." +
    encodeJson({ iss: key.client_email, scope: PLAY_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const pem = String(key.private_key).replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + encodeBase64Url(new Uint8Array(signature)),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) throw new Error("Anmeldung bei Google fehlgeschlagen");
  googleToken = { email: key.client_email, value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return googleToken.value;
}

async function pullListing(request, url, env, claims) {
  // Der eigene Header erzwingt bei fremden Seiten eine Vorabfrage, die hier
  // nie beantwortet wird — eine andere Website kann den Abruf nicht auslösen.
  if (request.headers.get("X-Werkbank") !== "1") return json(403, { error: "Dieser Aufruf ist nur aus der Werkbank möglich." });
  if (request.method !== "GET") return json(405, { error: "Nur Lesen ist erlaubt." });

  const key = env.PLAY_API === "on" ? readServiceAccount(env) : null;
  if (!key) return json(501, { error: "Der Abruf aus Play ist auf diesem Server nicht eingerichtet. Nutze stattdessen den ZIP-Import." });

  const pkg = url.searchParams.get("package") || "";
  if (!PACKAGE_RE.test(pkg) || pkg.length > 150) return json(400, { error: "Das ist kein gültiger Paketname." });

  console.log(`Play-Abruf: ${claims.email} lädt ${pkg}`);
  let token;
  try { token = await googleAccessToken(key); }
  catch (_) { return json(502, { error: "Die Anmeldung des Dienstkontos bei Google ist fehlgeschlagen. Der hinterlegte Schlüssel ist ungültig oder widerrufen." }); }

  const base = PLAY_BASE + encodeURIComponent(pkg) + "/edits";
  const auth = { Authorization: "Bearer " + token };
  const explain = (status) => status === 401 || status === 403
    ? json(403, { error: "Das Dienstkonto darf den Eintrag dieser App nicht lesen. Prüfe die Berechtigung in der Play Console." })
    : status === 404
      ? json(404, { error: "Diese App gibt es im Play-Konto nicht. Prüfe den Paketnamen." })
      : json(502, { error: `Google Play hat den Abruf abgelehnt (${status}).` });

  let editId = "";
  try {
    const created = await fetch(base, { method: "POST", headers: auth });
    if (!created.ok) return explain(created.status);
    editId = (await created.json()).id;
    const res = await fetch(`${base}/${encodeURIComponent(editId)}/listings`, { headers: auth });
    if (!res.ok) return explain(res.status);
    const data = await res.json();
    return json(200, {
      package: pkg,
      listings: (data.listings || []).map((l) => ({
        language: String(l.language || ""), title: String(l.title || ""),
        shortDescription: String(l.shortDescription || ""), fullDescription: String(l.fullDescription || ""),
      })),
    });
  } catch (_) {
    return json(502, { error: "Google Play ist gerade nicht erreichbar. Bitte später noch einmal versuchen." });
  } finally {
    // Aufräumen ist Kür — ein liegengebliebener Edit verfällt von selbst.
    if (editId) await fetch(`${base}/${encodeURIComponent(editId)}`, { method: "DELETE", headers: auth }).catch(() => {});
  }
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

    if (url.pathname === "/api/listing") {
      return secure(await pullListing(request, url, env, claims), { "Cache-Control": "no-store" });
    }
    if (url.pathname.startsWith("/api/")) return secure(json(404, { error: "Unbekannter Aufruf." }), { "Cache-Control": "no-store" });

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
