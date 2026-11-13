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
