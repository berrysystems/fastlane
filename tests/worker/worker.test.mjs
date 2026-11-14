import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../docs/_worker.js";

const { SECURITY_HEADERS, USER_COOKIE, clearKeyCache, readConfig } = worker.internals;

/* ------------------------------------------------------------------ *
 * Nachgestelltes Cloudflare Access: eigenes Schlüsselpaar, eigene Token
 * ------------------------------------------------------------------ */

const TEAM = "testteam.cloudflareaccess.com";
const AUD = "aud-der-werkbank";
const HOST = "werkbank.example.com";
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_HOSTS: HOST };

const b64url = (data) => Buffer.from(data).toString("base64url");

async function keyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}
const access = await keyPair("schluessel-1");
const stranger = await keyPair("schluessel-1");     // gleiche Kennung, anderer Schlüssel

async function token(claims = {}, { key = access, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify({
    iss: `https://${TEAM}`, aud: [AUD], email: "anna@example.com", iat: now, nbf: now, exp: now + 3600, ...claims,
  }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

let certRequests = [];
test.beforeEach(() => {
  clearKeyCache();
  certRequests = [];
  globalThis.fetch = async (url) => {
    certRequests.push(String(url));
    return new Response(JSON.stringify({ keys: [access.jwk] }), { headers: { "Content-Type": "application/json" } });
  };
});

const ASSETS = {
  fetch: async (request) => new URL(request.url).pathname.endsWith(".css")
    ? new Response("body{}", { headers: { "Content-Type": "text/css" } })
    : new Response("<!doctype html><title>Werkbank</title>", { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600" } }),
};
function call({ path = "/", host = HOST, headers = {}, method = "GET", env = ENV } = {}) {
  return worker.fetch(new Request(`https://${host}${path}`, { method, headers }), { ...env, ASSETS });
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("mit gültigem Token: Seite, Schutz-Header und Name des Nutzers", async () => {
  const res = await call({ headers: { "Cf-Access-Jwt-Assertion": await token() } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Werkbank/);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, name);
  assert.equal(res.headers.get("Cache-Control"), "private, no-cache");
  assert.match(res.headers.get("Set-Cookie"), new RegExp(`^${USER_COOKIE}=anna%40example\\.com; Path=/; Secure; SameSite=Strict$`));
  assert.deepEqual(certRequests, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test("das Token darf auch im Cookie stehen; andere Dateien bekommen kein Nutzer-Cookie", async () => {
  const res = await call({ path: "/assets/app.css", headers: { Cookie: `foo=1; CF_Authorization=${await token()}; bar=2` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("ohne Token gibt es nichts", async () => {
  const res = await call();
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /Kein Zugriff/);
  assert.doesNotMatch(body, /Werkbank<\/title>/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Set-Cookie"), null);
});

const rejected = {
  "abgelaufen": () => token({ exp: Math.floor(Date.now() / 1000) - 5 }),
  "für eine andere Anwendung ausgestellt": () => token({ aud: ["andere-anwendung"] }),
  "von einem anderen Team ausgestellt": () => token({ iss: "https://fremd.cloudflareaccess.com" }),
  "mit fremdem Schlüssel signiert": () => token({}, { key: stranger }),
  "mit unbekannter Schlüsselkennung": () => token({}, { key: { ...stranger, kid: "unbekannt" } }),
  "ohne Signaturverfahren (alg none)": () => token({}, { header: { alg: "none" } }),
  "mit HS256 statt RS256": () => token({}, { header: { alg: "HS256" } }),
  "erst in der Zukunft gültig": () => token({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
  "Dienst-Token ohne E-Mail": () => token({ email: undefined, common_name: "dienst" }),
  "kein Token, nur Text": async () => "kein.echtes.token",
  "nachträglich verändert": async () => {
    const [head, , signature] = (await token()).split(".");
    return `${head}.${b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "eve@example.com", exp: 9999999999 }))}.${signature}`;
  },
};
for (const [name, make] of Object.entries(rejected)) {
  test(`abgewiesen: ${name}`, async () => {
    const res = await call({ headers: { "Cf-Access-Jwt-Assertion": await make() } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /Werkbank<\/title>/);
  });
}

test("andere Adressen sind gesperrt — auch mit gültigem Token", async () => {
  const res = await call({ host: "fastlane-abc.pages.dev", headers: { "Cf-Access-Jwt-Assertion": await token() } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Adresse ist gesperrt/);
  assert.deepEqual(certRequests, []);
});

test("ohne vollständige Konfiguration bleibt die Seite zu", async () => {
  const good = { "Cf-Access-Jwt-Assertion": await token() };
  for (const env of [
    {},
    { ...ENV, ACCESS_AUD: "" },
    { ...ENV, ALLOWED_HOSTS: " " },
    { ...ENV, ACCESS_TEAM_DOMAIN: "boese.example.com" },
    { ...ENV, ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com.boese.example" },
  ]) {
    const res = await call({ env, headers: good });
    assert.equal(res.status, 503, JSON.stringify(env));
    assert.doesNotMatch(await res.text(), /Werkbank<\/title>/);
  }
  assert.deepEqual(certRequests, []);
});

test("Konfiguration: Schreibweisen werden vereinheitlicht, mehrere Werte möglich", () => {
  assert.deepEqual(
    readConfig({ ACCESS_TEAM_DOMAIN: "https://TestTeam.cloudflareaccess.com/", ACCESS_AUD: "a, b", ALLOWED_HOSTS: "A.example.com,b.example.com" }),
    { team: TEAM, audiences: ["a", "b"], hosts: ["a.example.com", "b.example.com"] });
});

test("nur Lesen ist erlaubt", async () => {
  const res = await call({ method: "POST", headers: { "Cf-Access-Jwt-Assertion": await token() } });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET, HEAD");
});

test("Schlüssel werden gemerkt und nicht bei jeder Anfrage neu geholt", async () => {
  const headers = { "Cf-Access-Jwt-Assertion": await token() };
  await call({ headers });
  await call({ headers });
  await call({ headers: { "Cf-Access-Jwt-Assertion": await token({}, { key: { ...stranger, kid: "unbekannt" } }) } });
  assert.equal(certRequests.length, 1);
});

test("fällt der Schlüsselabruf aus, bleibt die Seite zu", async () => {
  globalThis.fetch = async () => new Response("kaputt", { status: 500 });
  const res = await call({ headers: { "Cf-Access-Jwt-Assertion": await token() } });
  assert.equal(res.status, 403);
});

/* ------------------------------------------------------------------ *
 * Abruf aus Play — mit nachgestelltem Google
 * ------------------------------------------------------------------ */

const { generateKeyPairSync, createVerify } = await import("node:crypto");
const google = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SERVICE_KEY = JSON.stringify({ type: "service_account", client_email: "dienst@projekt.iam.gserviceaccount.com", private_key: google.privateKey, private_key_id: "kid-1" });
const PLAY_ENV = { ...ENV, PLAY_API: "on", GOOGLE_SERVICE_ACCOUNT_KEY: SERVICE_KEY };

// Antwortet wie Google: Token-Tausch, Edit anlegen, Listings, Edit löschen.
function fakeGoogle({ editStatus = 200, listings = [{ language: "de-DE", title: "Tagwerk", shortDescription: "Kurz.", fullDescription: "Lang.", video: "x" }] } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input), method = init.method || "GET";
    calls.push(`${method} ${url.replace(/^https:\/\/[^/]+/, "")}`);
    if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [access.jwk] });
    if (url === "https://oauth2.googleapis.com/token") {
      // Die Anmeldung muss mit dem Schlüssel des Dienstkontos signiert sein.
      const assertion = new URLSearchParams(init.body).get("assertion");
      const [head, body, signature] = assertion.split(".");
      const ok = createVerify("RSA-SHA256").update(`${head}.${body}`).verify(google.publicKey, Buffer.from(signature, "base64url"));
      const claims = JSON.parse(Buffer.from(body, "base64url"));
      if (!ok || claims.scope !== "https://www.googleapis.com/auth/androidpublisher" || claims.iss !== "dienst@projekt.iam.gserviceaccount.com") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: "google-token", expires_in: 3600 });
    }
    if ((init.headers || {}).Authorization !== "Bearer google-token") return new Response("", { status: 401 });
    if (method === "POST" && url.endsWith("/edits")) return editStatus === 200 ? Response.json({ id: "edit-7" }) : new Response("", { status: editStatus });
    if (method === "GET" && url.endsWith("/edits/edit-7/listings")) return Response.json({ listings });
    if (method === "DELETE" && url.endsWith("/edits/edit-7")) return new Response(null, { status: 204 });
    return new Response("", { status: 500 });
  };
  return calls;
}
const pull = async (overrides = {}) => call({
  path: "/api/listing?package=de.beispiel.tagwerk", env: PLAY_ENV,
  headers: { "Cf-Access-Jwt-Assertion": await token(), "X-Werkbank": "1" }, ...overrides,
});

test("Abruf: liefert die Texte, verwirft den Edit und gibt nichts sonst heraus", async () => {
  const calls = fakeGoogle();
  const res = await pull();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    package: "de.beispiel.tagwerk",
    listings: [{ language: "de-DE", title: "Tagwerk", shortDescription: "Kurz.", fullDescription: "Lang.", video: "x" }],
  });
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  const base = "/androidpublisher/v3/applications/de.beispiel.tagwerk/edits";
  assert.deepEqual(calls, ["GET /cdn-cgi/access/certs", "POST /token", `POST ${base}`, `GET ${base}/edit-7/listings`, `DELETE ${base}/edit-7`]);
});

test("Abruf: das Google-Token wird wiederverwendet", async () => {
  const calls = fakeGoogle();
  await pull();
  await pull();
  assert.equal(calls.filter((c) => c === "POST /token").length, 1);
});

test("Abruf: ohne Anmeldung, ohne eigenen Header oder mit Schreibversuch gibt es nichts", async () => {
  const calls = fakeGoogle();
  assert.equal((await pull({ headers: { "X-Werkbank": "1" } })).status, 403);
  assert.equal((await pull({ headers: { "Cf-Access-Jwt-Assertion": await token() } })).status, 403);
  assert.equal((await pull({ method: "POST" })).status, 405);
  assert.equal((await pull({ host: "fastlane-abc.pages.dev" })).status, 403);
  assert.deepEqual(calls.filter((c) => !c.includes("certs")), []);
});

test("Abruf: nur wenn freigeschaltet und der Schlüssel brauchbar ist", async () => {
  const calls = fakeGoogle();
  for (const env of [
    { ...ENV, GOOGLE_SERVICE_ACCOUNT_KEY: SERVICE_KEY },                       // nicht freigeschaltet
    { ...ENV, PLAY_API: "on" },                                                // kein Schlüssel
    { ...ENV, PLAY_API: "on", GOOGLE_SERVICE_ACCOUNT_KEY: "kein json" },
    { ...ENV, PLAY_API: "on", GOOGLE_SERVICE_ACCOUNT_KEY: '{"type":"authorized_user"}' },
  ]) {
    const res = await pull({ env });
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /nicht eingerichtet/);
  }
  assert.deepEqual(calls.filter((c) => !c.includes("certs")), []);
});

test("Abruf: Paketname wird geprüft, bevor Google gefragt wird", async () => {
  const calls = fakeGoogle();
  for (const pkg of ["", "tagwerk", "de.beispiel/../../x", "de.beispiel.app?x=1", "de..app", "a.b\n"]) {
    const res = await pull({ path: "/api/listing?package=" + encodeURIComponent(pkg) });
    assert.equal(res.status, 400, pkg);
  }
  assert.deepEqual(calls.filter((c) => !c.includes("certs")), []);
});

test("Abruf: Ablehnung durch Google wird verständlich weitergegeben", async () => {
  fakeGoogle({ editStatus: 403 });
  let res = await pull();
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Dienstkonto hat für diese App nicht die nötige Berechtigung/);
  clearKeyCache();
  fakeGoogle({ editStatus: 404 });
  res = await pull();
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Prüfe den Paketnamen/);
});

test("Abruf: ein ungültiger Schlüssel führt zu einer klaren Meldung, nicht zu einem Absturz", async () => {
  fakeGoogle();
  const other = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const wrong = JSON.stringify({ ...JSON.parse(SERVICE_KEY), private_key: other.privateKey });
  for (const key of [wrong, JSON.stringify({ ...JSON.parse(SERVICE_KEY), private_key: "kaputt" })]) {
    clearKeyCache();
    const res = await pull({ env: { ...PLAY_ENV, GOOGLE_SERVICE_ACCOUNT_KEY: key } });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Schlüssel ist ungültig oder widerrufen/);
  }
});

test("unbekannte API-Pfade liefern keine Dateien aus", async () => {
  const res = await call({ path: "/api/anderes", headers: { "Cf-Access-Jwt-Assertion": await token(), "X-Werkbank": "1" } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
});

/* ------------------------------------------------------------------ *
 * Rechte, Veröffentlichen, Textvorschläge, Team-Ablage
 * ------------------------------------------------------------------ */

const signedIn = async (email = "anna@example.com") => ({ "Cf-Access-Jwt-Assertion": await token({ email }), "X-Werkbank": "1" });
const PUBLISH_ENV = { ...PLAY_ENV, PLAY_PUBLISH: "on", PUBLISHERS: "Anna@Example.com, chef@example.com" };

test("Rechte: jede Funktion ist aus, bis sie eingeschaltet ist", async () => {
  fakeGoogle();
  const me = async (env, email) => (await (await call({ path: "/api/me", env, headers: await signedIn(email) })).json()).features;
  assert.deepEqual(await me(ENV), { pull: false, publish: false, ai: false, team: false });
  assert.deepEqual(await me(PLAY_ENV), { pull: true, publish: false, ai: false, team: false });
  // Veröffentlichen braucht Schalter, Schlüssel und einen Eintrag in der Liste.
  assert.equal((await me(PUBLISH_ENV)).publish, true);
  assert.equal((await me(PUBLISH_ENV, "gast@example.com")).publish, false);
  assert.equal((await me({ ...PUBLISH_ENV, PUBLISHERS: "" })).publish, false);
  assert.equal((await me({ ...PUBLISH_ENV, GOOGLE_SERVICE_ACCOUNT_KEY: "" })).publish, false);
  assert.equal((await me({ ...ENV, AI_API: "on" })).ai, false);
  assert.equal((await me({ ...ENV, AI_API: "on", ANTHROPIC_API_KEY: "sk-test" })).ai, true);
  assert.equal((await me({ ...ENV, TEAM: fakeKv() })).team, true);
  const res = await call({ path: "/api/me", headers: await signedIn("anna@example.com") });
  assert.equal((await res.json()).email, "anna@example.com");
});

// Nimmt alle Aufrufe an Google Play an und merkt sie sich.
function fakePlay({ fail = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input), method = init.method || "GET";
    if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [access.jwk] });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "google-token", expires_in: 3600 });
    // Kurzform zum Vergleichen; die volle Adresse prüft die Zeile darunter.
    assert.match(url, /^https:\/\/androidpublisher\.googleapis\.com\/(upload\/)?androidpublisher\/v3\/applications\/de\.beispiel\.tagwerk\/edits/);
    const path = url.replace(/^https:\/\/[^/]+/, "").replace("/androidpublisher/v3/applications/de.beispiel.tagwerk", "");
    const size = init.body && init.body.byteLength !== undefined ? ` (${init.body.byteLength} Bytes, ${init.headers["Content-Type"]})` : "";
    calls.push(`${method} ${path}${size}`);
    for (const [needle, status] of Object.entries(fail)) {
      if (`${method} ${path}`.includes(needle)) return Response.json({ error: { message: "Grund von Google" } }, { status });
    }
    if (method === "POST" && path === "/edits") return Response.json({ id: "edit-9" });
    return Response.json({});
  };
  return calls;
}
const pub = async (action, { method = "POST", query = "", body, type, env = PUBLISH_ENV, email } = {}) => {
  const headers = await signedIn(email);
  if (type) headers["Content-Type"] = type;
  return worker.fetch(new Request(`https://${HOST}/api/publish/${action}?package=de.beispiel.tagwerk${query}`, { method, headers, body }), { ...env, ASSETS });
};
const GOOD_LISTING = JSON.stringify({ title: "Tagwerk", shortDescription: "Kurz.", fullDescription: "Lang.", video: " https://youtu.be/abcdefghijk " });

test("Veröffentlichen: Probelauf prüft und verwirft, Veröffentlichen committet", async () => {
  const calls = fakePlay();
  assert.deepEqual(await (await pub("start")).json(), { edit: "edit-9" });
  const q = "&edit=edit-9&language=de-DE";
  assert.equal((await pub("listing", { method: "PUT", query: q, body: GOOD_LISTING, type: "application/json" })).status, 200);
  assert.equal((await pub("image", { query: q + "&type=icon&first=1", body: new Uint8Array(10), type: "image/png" })).status, 200);
  assert.equal((await pub("image", { query: q + "&type=phoneScreenshots&first=1", body: new Uint8Array(20), type: "image/jpeg" })).status, 200);
  assert.equal((await pub("image", { query: q + "&type=phoneScreenshots", body: new Uint8Array(30), type: "image/jpeg" })).status, 200);
  assert.deepEqual(await (await pub("finish", { query: "&edit=edit-9&mode=check" })).json(), { ok: true, mode: "check" });
  assert.deepEqual(calls, [
    "POST /edits",
    "PUT /edits/edit-9/listings/de-DE",
    "DELETE /edits/edit-9/listings/de-DE/icon",
    "POST /upload/edits/edit-9/listings/de-DE/icon?uploadType=media (10 Bytes, image/png)",
    "DELETE /edits/edit-9/listings/de-DE/phoneScreenshots",
    "POST /upload/edits/edit-9/listings/de-DE/phoneScreenshots?uploadType=media (20 Bytes, image/jpeg)",
    "POST /upload/edits/edit-9/listings/de-DE/phoneScreenshots?uploadType=media (30 Bytes, image/jpeg)",
    "POST /edits/edit-9:validate",
    "DELETE /edits/edit-9",
  ]);
  calls.length = 0;
  assert.deepEqual(await (await pub("finish", { query: "&edit=edit-9&mode=commit" })).json(), { ok: true, mode: "commit" });
  assert.deepEqual(calls, ["POST /edits/edit-9:commit"]);
  calls.length = 0;
  await pub("abort", { query: "&edit=edit-9" });
  assert.deepEqual(calls, ["DELETE /edits/edit-9"]);
});

test("Veröffentlichen: nur für freigegebene Adressen und nur wenn eingeschaltet", async () => {
  const calls = fakePlay();
  assert.equal((await pub("start", { email: "gast@example.com" })).status, 403);
  assert.equal((await pub("start", { env: PLAY_ENV })).status, 403);
  assert.equal((await pub("start", { env: { ...PUBLISH_ENV, PUBLISHERS: "" } })).status, 403);
  assert.equal((await pub("finish", { query: "&edit=edit-9&mode=commit", email: "gast@example.com" })).status, 403);
  assert.equal((await pub("start", { method: "GET" })).status, 405);
  assert.equal((await pub("loeschen")).status, 404);
  const noHeader = await worker.fetch(new Request(`https://${HOST}/api/publish/start?package=de.beispiel.tagwerk`, {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": await token() } }), { ...PUBLISH_ENV, ASSETS });
  assert.equal(noHeader.status, 403);
  assert.deepEqual(calls, []);
});

test("Veröffentlichen: Eingaben werden geprüft, bevor Google sie sieht", async () => {
  const calls = fakePlay();
  const q = "&edit=edit-9&language=de-DE";
  const listing = (body, query = q) => pub("listing", { method: "PUT", query, body: JSON.stringify(body), type: "application/json" });
  assert.equal((await listing({ title: "", shortDescription: "a", fullDescription: "b" })).status, 400);
  assert.equal((await listing({ title: "x".repeat(31), shortDescription: "a", fullDescription: "b" })).status, 400);
  assert.equal((await listing({ title: "a", shortDescription: "a", fullDescription: "b" }, "&edit=edit-9&language=../x")).status, 400);
  assert.equal((await listing({ title: "a", shortDescription: "a", fullDescription: "b" }, "&edit=a/b&language=de-DE")).status, 400);
  assert.equal((await pub("image", { query: q + "&type=tvBanner", body: new Uint8Array(5), type: "image/png" })).status, 400);
  assert.equal((await pub("image", { query: q + "&type=icon", body: new Uint8Array(5), type: "image/svg+xml" })).status, 400);
  assert.equal((await pub("image", { query: q + "&type=icon", body: new Uint8Array(0), type: "image/png" })).status, 400);
  assert.deepEqual(calls, []);
  // Emoji zählen als ein Zeichen, das Video wird gekürzt weitergereicht.
  assert.equal((await listing({ title: "😀".repeat(30), shortDescription: "a", fullDescription: "b" })).status, 200);
});

test("Veröffentlichen: Googles Begründung kommt beim Mitglied an", async () => {
  fakePlay({ fail: { ":validate": 400 } });
  const res = await pub("finish", { query: "&edit=edit-9&mode=check" });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Google Play hat abgelehnt \(400\): Grund von Google/);
  clearKeyCache();
  fakePlay({ fail: { "PUT /edits": 403 } });
  const denied = await pub("listing", { method: "PUT", query: "&edit=edit-9&language=de-DE", body: GOOD_LISTING, type: "application/json" });
  assert.equal(denied.status, 403);
});

// Antwortet wie die Claude-API auf POST /v1/messages.
function fakeClaude(reply, status = 200) {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input.url || input);
    if (url.endsWith("/cdn-cgi/access/certs")) return Response.json({ keys: [access.jwk] });
    const headers = new Headers(init.headers || input.headers);
    // Je nach Art des Schlüssels sendet das SDK ihn als x-api-key oder als Bearer-Token.
    const key = headers.get("x-api-key") || (headers.get("authorization") || "").replace(/^Bearer /, "");
    requests.push({ url, key, beta: headers.get("anthropic-beta"), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
  };
  return requests;
}
const AI_ENV = { ...ENV, AI_API: "on", ANTHROPIC_API_KEY: "sk-test-key" };
const ask = async (prompt, env = AI_ENV) => worker.fetch(new Request(`https://${HOST}/api/suggest`, {
  method: "POST", headers: { ...(await signedIn()), "Content-Type": "application/json" }, body: JSON.stringify({ prompt }),
}), { ...env, ASSETS });
const claudeMessage = (extra) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: '{"listings":' }, { type: "text", text: "{}}" }],
  usage: { input_tokens: 10, output_tokens: 5 }, ...extra,
});

test("Textvorschläge: reicht den Auftrag weiter und gibt nur den Text zurück", async () => {
  const requests = fakeClaude(claudeMessage());
  const res = await ask("Schreibe den Eintrag.");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: '{"listings":{}}' });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(requests[0].key, "sk-test-key");
  assert.match(requests[0].beta, /server-side-fallback-2026-07-01/);
  assert.deepEqual(requests[0].body, {
    model: "claude-opus-5-5", max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" },
    fallbacks: "default", messages: [{ role: "user", content: "Schreibe den Eintrag." }],
  });
});

test("Textvorschläge: aus, zu lang, abgelehnt, abgeschnitten, falscher Schlüssel", async () => {
  let requests = fakeClaude(claudeMessage());
  assert.equal((await ask("x", ENV)).status, 501);
  assert.equal((await ask("x", { ...AI_ENV, ANTHROPIC_API_KEY: "" })).status, 501);
  assert.equal((await ask("   ")).status, 400);
  assert.equal((await ask("x".repeat(60001))).status, 400);
  assert.deepEqual(requests, []);

  fakeClaude(claudeMessage({ stop_reason: "refusal", content: [] }));
  let res = await ask("x");
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /abgelehnt/);

  fakeClaude(claudeMessage({ stop_reason: "max_tokens" }));
  res = await ask("x");
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /weniger Sprachen/);

  fakeClaude({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
  res = await ask("x");
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Schlüssel für die Claude-API ist ungültig/);
});

// Kleinster KV-Nachbau: Werte mit Metadaten, Auflisten nach Präfix.
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key).value : null; },
    async getWithMetadata(key) {
      const entry = store.get(key);
      return entry ? { value: new Response(entry.value).body, metadata: entry.metadata } : { value: null, metadata: null };
    },
    async put(key, value, options = {}) { store.set(key, { value, metadata: options.metadata || null }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { list_complete: true, keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })) };
    },
  };
}
const teamCall = async (kv, path, { method = "GET", body, email } = {}) => worker.fetch(
  new Request(`https://${HOST}${path}`, { method, headers: await signedIn(email), body }), { ...ENV, TEAM: kv, ASSETS });

test("Team-Ablage: ablegen, auflisten, öffnen, löschen", async () => {
  fakeGoogle();
  const kv = fakeKv(), id = "3f2a9c1e-aaaa-bbbb-cccc-1234567890ab";
  let res = await teamCall(kv, `/api/team/item?id=${id}&name=Tagwerk`, { method: "PUT", body: '{"version":4}' });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.by, "anna@example.com");
  assert.equal(saved.size, 13);

  res = await teamCall(kv, "/api/team");
  assert.deepEqual((await res.json()).projects, [{ id, name: "Tagwerk", by: "anna@example.com", at: saved.at, size: 13 }]);

  res = await teamCall(kv, `/api/team/item?id=${id}`, { email: "ben@example.com" });
  assert.equal(await res.text(), '{"version":4}');
  assert.equal(res.headers.get("X-Team-At"), String(saved.at));
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");

  res = await teamCall(kv, `/api/team/item?id=${id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await teamCall(kv, `/api/team/item?id=${id}`)).status, 404);
  assert.deepEqual((await (await teamCall(kv, "/api/team")).json()).projects, []);
});

test("Team-Ablage: wer einen neueren Stand überschreiben würde, wird gewarnt", async () => {
  fakeGoogle();
  const kv = fakeKv(), path = "/api/team/item?id=projekt-0001&name=Tagwerk";
  const first = await (await teamCall(kv, path, { method: "PUT", body: "{}" })).json();
  // Ben kennt den Stand nicht (base fehlt) und würde Annas Arbeit ersetzen.
  let res = await teamCall(kv, path, { method: "PUT", body: '{"b":1}', email: "ben@example.com" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).by, "anna@example.com");
  assert.equal(kv.store.get("project:projekt-0001").value.byteLength, 2);
  // Mit dem bekannten Stand oder ausdrücklich geht es.
  res = await teamCall(kv, `${path}&base=${first.at}`, { method: "PUT", body: '{"b":1}', email: "ben@example.com" });
  assert.equal(res.status, 200);
  res = await teamCall(kv, `${path}&force=1`, { method: "PUT", body: '{"c":1}' });
  assert.equal(res.status, 200);
});

test("Team-Ablage: aus ohne Speicher, ungültige Kennungen und zu große Projekte werden abgewiesen", async () => {
  fakeGoogle();
  const kv = fakeKv();
  assert.equal((await call({ path: "/api/team", headers: await signedIn() })).status, 501);
  assert.equal((await teamCall(kv, "/api/team/item?id=../x")).status, 400);
  assert.equal((await teamCall(kv, "/api/team/item?id=kurz")).status, 400);
  assert.equal((await teamCall(kv, "/api/team/item?id=projekt-0002", { method: "PUT", body: "" })).status, 400);
  const big = await teamCall(kv, "/api/team/item?id=projekt-0002", { method: "PUT", body: new Uint8Array(24 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  assert.equal(kv.store.size, 0);
  assert.equal((await teamCall(kv, "/api/team", { method: "POST", body: "x" })).status, 405);
});
