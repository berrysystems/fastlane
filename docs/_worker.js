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
 * Optional — jede Funktion ist aus, solange sie nicht ausdrücklich eingeschaltet ist:
 *   PLAY_API                     "on": Store-Eintrag abrufen (/api/listing)
 *   PLAY_PUBLISH                 "on": Store-Eintrag veröffentlichen (/api/publish/…)
 *   PUBLISHERS                   E-Mail-Adressen, die veröffentlichen dürfen (Komma)
 *   GOOGLE_SERVICE_ACCOUNT_KEY   Geheimnis: JSON-Schlüssel des Dienstkontos
 *   AI_API                       "on": Textvorschläge erzeugen (/api/suggest)
 *   ANTHROPIC_API_KEY            Geheimnis: Schlüssel für die Claude-API
 *   TEAM                         KV-Namespace: gemeinsame Projekt-Ablage (/api/team…)
 */

import Anthropic from "@anthropic-ai/sdk";

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

// Welche Server-Funktionen dieses Mitglied nutzen darf.
function features(env, email) {
  const play = !!readServiceAccount(env);
  const publishers = list(env.PUBLISHERS).map((e) => e.toLowerCase());
  return {
    pull: env.PLAY_API === "on" && play,
    publish: env.PLAY_PUBLISH === "on" && play && publishers.includes(String(email).toLowerCase()),
    ai: env.AI_API === "on" && !!env.ANTHROPIC_API_KEY,
    team: !!(env.TEAM && typeof env.TEAM.get === "function"),
  };
}

const explainPlay = async (res) => {
  // Googles eigene Begründung hilft beim Beheben — sie enthält keine Geheimnisse.
  const detail = await res.json().then((d) => d && d.error && d.error.message).catch(() => "");
  if (res.status === 401 || res.status === 403) {
    return json(403, { error: "Das Dienstkonto hat für diese App nicht die nötige Berechtigung. Prüfe sie in der Play Console." });
  }
  if (res.status === 404) return json(404, { error: "Diese App gibt es im Play-Konto nicht. Prüfe den Paketnamen." });
  return json(502, { error: `Google Play hat abgelehnt (${res.status})${detail ? ": " + detail : "."}` });
};

async function playSession(env, pkg) {
  if (!PACKAGE_RE.test(pkg) || pkg.length > 150) return { error: json(400, { error: "Das ist kein gültiger Paketname." }) };
  try {
    const token = await googleAccessToken(readServiceAccount(env));
    return { auth: { Authorization: "Bearer " + token }, app: PLAY_BASE + encodeURIComponent(pkg) };
  } catch (_) {
    return { error: json(502, { error: "Die Anmeldung des Dienstkontos bei Google ist fehlgeschlagen. Der hinterlegte Schlüssel ist ungültig oder widerrufen." }) };
  }
}

async function pullListing(url, env, claims) {
  const pkg = url.searchParams.get("package") || "";
  const play = await playSession(env, pkg);
  if (play.error) return play.error;
  console.log(`Play-Abruf: ${claims.email} lädt ${pkg}`);

  let editId = "";
  try {
    const created = await fetch(play.app + "/edits", { method: "POST", headers: play.auth });
    if (!created.ok) return explainPlay(created);
    editId = (await created.json()).id;
    const res = await fetch(`${play.app}/edits/${encodeURIComponent(editId)}/listings`, { headers: play.auth });
    if (!res.ok) return explainPlay(res);
    const data = await res.json();
    return json(200, {
      package: pkg,
      listings: (data.listings || []).map((l) => ({
        language: String(l.language || ""), title: String(l.title || ""),
        shortDescription: String(l.shortDescription || ""), fullDescription: String(l.fullDescription || ""),
        video: String(l.video || ""),
      })),
    });
  } catch (_) {
    return json(502, { error: "Google Play ist gerade nicht erreichbar. Bitte später noch einmal versuchen." });
  } finally {
    // Aufräumen ist Kür — ein liegengebliebener Edit verfällt von selbst.
    if (editId) await fetch(`${play.app}/edits/${encodeURIComponent(editId)}`, { method: "DELETE", headers: play.auth }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Veröffentlichen
 *
 * Der Browser rendert die Bilder und schickt sie Schritt für Schritt:
 * start → je Sprache listing und image → finish. Erst „finish“ mit
 * mode=commit verändert den Store; mode=check lässt Google nur prüfen und
 * verwirft den Edit. So bleibt jeder Aufruf klein, und ein Abbruch
 * mittendrin hinterlässt nichts.
 * ------------------------------------------------------------------ */

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const EDIT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const IMAGE_TYPES = ["icon", "featureGraphic", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"];
const TEXT_LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const PLAY_UPLOAD = PLAY_BASE.replace("/androidpublisher/", "/upload/androidpublisher/");

async function publish(action, request, url, env, claims) {
  const q = url.searchParams, pkg = q.get("package") || "";
  const play = await playSession(env, pkg);
  if (play.error) return play.error;

  if (action === "start") {
    console.log(`Veröffentlichen: ${claims.email} beginnt für ${pkg}`);
    const res = await fetch(play.app + "/edits", { method: "POST", headers: play.auth });
    if (!res.ok) return explainPlay(res);
    return json(200, { edit: (await res.json()).id });
  }

  const edit = q.get("edit") || "";
  if (!EDIT_RE.test(edit)) return json(400, { error: "Ungültiger Vorgang." });
  const editUrl = `${play.app}/edits/${edit}`;

  if (action === "abort") {
    await fetch(editUrl, { method: "DELETE", headers: play.auth }).catch(() => {});
    return json(200, { ok: true });
  }
  if (action === "finish") {
    const commit = q.get("mode") === "commit";
    const res = await fetch(`${editUrl}:${commit ? "commit" : "validate"}`, { method: "POST", headers: play.auth });
    if (!res.ok) return explainPlay(res);
    if (!commit) await fetch(editUrl, { method: "DELETE", headers: play.auth }).catch(() => {});
    console.log(`Veröffentlichen: ${claims.email} hat ${pkg} ${commit ? "veröffentlicht" : "geprüft"}`);
    return json(200, { ok: true, mode: commit ? "commit" : "check" });
  }

  const language = q.get("language") || "";
  if (!LOCALE_RE.test(language)) return json(400, { error: "Ungültige Sprache." });
  const listingUrl = `${editUrl}/listings/${language}`;

  if (action === "listing") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json(400, { error: "Die Texte fehlen." });
    const listing = { language };
    for (const [field, max] of Object.entries(TEXT_LIMITS)) {
      const value = typeof body[field] === "string" ? body[field].trim() : "";
      if (!value) return json(400, { error: `${language}: ${field} fehlt.` });
      if (Array.from(value).length > max) return json(400, { error: `${language}: ${field} ist länger als ${max} Zeichen.` });
      listing[field] = value;
    }
    if (typeof body.video === "string" && body.video.trim()) listing.video = body.video.trim();
    const res = await fetch(listingUrl, {
      method: "PUT", headers: { ...play.auth, "Content-Type": "application/json" }, body: JSON.stringify(listing),
    });
    return res.ok ? json(200, { ok: true }) : explainPlay(res);
  }

  if (action === "image") {
    const type = q.get("type") || "", contentType = request.headers.get("Content-Type") || "";
    if (!IMAGE_TYPES.includes(type)) return json(400, { error: "Unbekannte Bildart." });
    if (contentType !== "image/png" && contentType !== "image/jpeg") return json(400, { error: "Nur PNG und JPEG sind erlaubt." });
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return json(400, { error: "Das Bild ist leer oder zu groß." });
    // Ersetzen statt anhängen: vor dem ersten Bild einer Art die alten löschen.
    if (q.get("first") === "1") {
      const cleared = await fetch(`${listingUrl}/${type}`, { method: "DELETE", headers: play.auth });
      if (!cleared.ok) return explainPlay(cleared);
    }
    const res = await fetch(`${PLAY_UPLOAD}${encodeURIComponent(pkg)}/edits/${edit}/listings/${language}/${type}?uploadType=media`, {
      method: "POST", headers: { ...play.auth, "Content-Type": contentType }, body: bytes,
    });
    return res.ok ? json(200, { ok: true }) : explainPlay(res);
  }
  return json(404, { error: "Unbekannter Aufruf." });
}

/* ------------------------------------------------------------------ *
 * Textvorschläge
 *
 * Reicht den Auftrag aus dem Briefing an die Claude-API weiter. Bewusst
 * ohne Streaming: so bleibt die Rechenzeit im Worker minimal.
 * ------------------------------------------------------------------ */

const MAX_PROMPT_CHARS = 60000;

async function suggest(request, env, claims) {
  const body = await request.json().catch(() => null);
  const prompt = body && typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json(400, { error: "Der Auftrag fehlt." });
  if (prompt.length > MAX_PROMPT_CHARS) return json(400, { error: "Der Auftrag ist zu lang. Kürze das Briefing oder teile die Sprachen auf." });
  console.log(`Textvorschläge: ${claims.email}, ${prompt.length} Zeichen`);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let message;
  try {
    message = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // Lehnt das Modell eine Anfrage ab, übernimmt ein anderes Modell.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return json(502, { error: "Der hinterlegte Schlüssel für die Claude-API ist ungültig." });
    }
    if (error instanceof Anthropic.RateLimitError) return json(429, { error: "Gerade zu viele Anfragen. Bitte in einer Minute noch einmal versuchen." });
    if (error instanceof Anthropic.BadRequestError) return json(502, { error: "Die Claude-API hat die Anfrage abgelehnt: " + error.message });
    if (error instanceof Anthropic.APIError) return json(502, { error: `Die Claude-API ist gerade nicht erreichbar (${error.status || "keine Antwort"}).` });
    throw error;
  }
  if (message.stop_reason === "refusal") return json(422, { error: "Das Modell hat diese Anfrage abgelehnt. Formuliere das Briefing anders." });
  if (message.stop_reason === "max_tokens") return json(422, { error: "Die Antwort wurde zu lang. Erzeuge die Vorschläge für weniger Sprachen auf einmal." });
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  return json(200, { text });
}

/* ------------------------------------------------------------------ *
 * Team-Ablage
 *
 * Projekte, die Mitglieder ausdrücklich fürs Team ablegen. Kein
 * gleichzeitiges Bearbeiten: wer ablegt, ersetzt den abgelegten Stand —
 * nach einer Warnung, falls jemand anderes ihn inzwischen geändert hat.
 * ------------------------------------------------------------------ */

const TEAM_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_PROJECT_BYTES = 24 * 1024 * 1024;   // KV fasst 25 MiB je Eintrag
const teamKey = (id) => "project:" + id;

async function team(request, url, env, claims) {
  if (url.pathname === "/api/team") {
    if (request.method !== "GET") return json(405, { error: "Nur Lesen ist erlaubt." });
    const projects = [];
    let cursor;
    do {
      const page = await env.TEAM.list({ prefix: "project:", cursor });
      for (const key of page.keys) projects.push({ id: key.name.slice("project:".length), ...(key.metadata || {}) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    projects.sort((a, b) => (b.at || 0) - (a.at || 0));
    return json(200, { projects });
  }

  const id = url.searchParams.get("id") || "";
  if (!TEAM_ID_RE.test(id)) return json(400, { error: "Ungültige Projektkennung." });

  if (request.method === "GET") {
    const entry = await env.TEAM.getWithMetadata(teamKey(id), { type: "stream" });
    if (!entry || !entry.value) return json(404, { error: "Dieses Projekt liegt nicht mehr in der Team-Ablage." });
    return new Response(entry.value, {
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Team-At": String((entry.metadata && entry.metadata.at) || 0) },
    });
  }
  if (request.method === "DELETE") {
    await env.TEAM.delete(teamKey(id));
    console.log(`Team-Ablage: ${claims.email} löscht ${id}`);
    return json(200, { ok: true });
  }
  if (request.method === "PUT") {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json(400, { error: "Das Projekt ist leer." });
    if (bytes.byteLength > MAX_PROJECT_BYTES) {
      return json(413, { error: "Das Projekt ist größer als 24 MB und passt nicht in die Team-Ablage. Verkleinere die Screenshots oder gib es als Datei weiter." });
    }
    // Hat jemand anderes seit dem letzten bekannten Stand abgelegt?
    const current = await env.TEAM.getWithMetadata(teamKey(id), { type: "stream" });
    const meta = current && current.metadata;
    if (current && current.value) await current.value.cancel();
    const base = Number(url.searchParams.get("base")) || 0;
    if (meta && meta.at > base && url.searchParams.get("force") !== "1") {
      return json(409, { error: "Jemand hat dieses Projekt inzwischen neu abgelegt.", by: meta.by, at: meta.at });
    }
    const metadata = {
      name: (url.searchParams.get("name") || "Projekt").slice(0, 80),
      by: claims.email, at: Date.now(), size: bytes.byteLength,
    };
    await env.TEAM.put(teamKey(id), bytes, { metadata });
    console.log(`Team-Ablage: ${claims.email} legt ${id} ab (${bytes.byteLength} Bytes)`);
    return json(200, { ok: true, ...metadata });
  }
  return json(405, { error: "Dieser Aufruf wird nicht unterstützt." });
}

/* ------------------------------------------------------------------ *
 * Verteiler für /api/…
 * ------------------------------------------------------------------ */

const OFF = {
  pull: "Der Abruf aus Play ist auf diesem Server nicht eingerichtet. Nutze stattdessen den ZIP-Import.",
  publish: "Du darfst aus der Werkbank nicht veröffentlichen. Das Veröffentlichen ist ausgeschaltet oder deine Adresse ist dafür nicht freigegeben.",
  ai: "Textvorschläge sind auf diesem Server nicht eingerichtet. Nutze stattdessen „Auftrag kopieren“.",
  team: "Die Team-Ablage ist auf diesem Server nicht eingerichtet.",
};

async function api(request, url, env, claims) {
  // Der eigene Header erzwingt bei fremden Seiten eine Vorabfrage, die hier
  // nie beantwortet wird — eine andere Website kann keinen Aufruf auslösen.
  if (request.headers.get("X-Werkbank") !== "1") return json(403, { error: "Dieser Aufruf ist nur aus der Werkbank möglich." });
  const can = features(env, claims.email), path = url.pathname, method = request.method;
  const off = (feature, status = 501) => json(status, { error: OFF[feature] });

  if (path === "/api/me") {
    return method === "GET" ? json(200, { email: claims.email, features: can }) : json(405, { error: "Nur Lesen ist erlaubt." });
  }
  if (path === "/api/listing") {
    if (method !== "GET") return json(405, { error: "Nur Lesen ist erlaubt." });
    return can.pull ? pullListing(url, env, claims) : off("pull");
  }
  if (path.startsWith("/api/publish/")) {
    const action = path.slice("/api/publish/".length);
    const expected = { start: "POST", listing: "PUT", image: "POST", finish: "POST", abort: "POST" }[action];
    if (!expected) return json(404, { error: "Unbekannter Aufruf." });
    if (method !== expected) return json(405, { error: "Dieser Aufruf wird nicht unterstützt." });
    return can.publish ? publish(action, request, url, env, claims) : off("publish", 403);
  }
  if (path === "/api/suggest") {
    if (method !== "POST") return json(405, { error: "Dieser Aufruf wird nicht unterstützt." });
    return can.ai ? suggest(request, env, claims) : off("ai");
  }
  if (path === "/api/team" || path === "/api/team/item") return can.team ? team(request, url, env, claims) : off("team");
  return json(404, { error: "Unbekannter Aufruf." });
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
  internals: { SECURITY_HEADERS, USER_COOKIE, readConfig, verifyAccessToken, clearKeyCache, features },

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

    if (url.pathname.startsWith("/api/")) {
      return secure(await api(request, url, env, claims), { "Cache-Control": "no-store" });
    }

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
