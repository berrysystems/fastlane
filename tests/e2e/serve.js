"use strict";
// Liefert docs/ für die Tests aus — ohne zusätzliche Abhängigkeit.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "docs");
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

// Dieselben Schutz-Header wie hinter Cloudflare, damit die Tests merken,
// wenn die Seite etwas tut, das die Content-Security-Policy verbietet.
// Das Nutzer-Cookie stellt eine Anmeldung nach.
const TEST_USER = "test.nutzer@example.com";
const published = new Map();   // Paketname → Liste der Aufrufe
const teamStore = new Map();   // Projektkennung → { body, meta }
const worker = import("../../docs/_worker.js");

http.createServer(async (req, res) => {
  const { SECURITY_HEADERS, USER_COOKIE } = (await worker).default.internals;
  const url = new URL(req.url, "http://localhost");
  // ---- Nachgestellter Server-Teil: dieselben Aufrufe und Meldungen wie docs/_worker.js
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__test/")) {
    const reply = (status, body, extra = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const q = url.searchParams, pkg = q.get("package") || "";
    // Was die Tests später nachlesen: alle Veröffentlichungs-Aufrufe je Paket.
    if (url.pathname === "/__test/publish") return reply(200, published.get(pkg) || []);
    if (req.headers["x-werkbank"] !== "1") return reply(403, { error: "Dieser Aufruf ist nur aus der Werkbank möglich." });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (url.pathname === "/api/me") return reply(200, { email: TEST_USER, features: { pull: true, publish: true, ai: true, team: true } });

    if (url.pathname === "/api/listing") {
      if (pkg !== "de.beispiel.tagwerk") return reply(404, { error: "Diese App gibt es im Play-Konto nicht. Prüfe den Paketnamen." });
      return reply(200, { package: pkg, listings: [
        { language: "de-DE", title: "Tagwerk", shortDescription: "Plane deinen Tag in Minuten.", fullDescription: "Der Eintrag aus dem Store.", video: "" },
        { language: "en-US", title: "Dayworks", shortDescription: "Plan your day in minutes.", fullDescription: "The listing from the store.", video: "" },
      ] });
    }

    if (url.pathname.startsWith("/api/publish/")) {
      const action = url.pathname.slice("/api/publish/".length);
      const calls = published.get(pkg) || published.set(pkg, []).get(pkg);
      // Ein Paketname mit „kaputt“ lässt Google die Prüfung ablehnen.
      if (action === "finish" && pkg.includes("kaputt")) {
        calls.push("finish abgelehnt");
        return reply(502, { error: "Google Play hat abgelehnt (400): Screenshot zu klein." });
      }
      const head = body.length >= 2 ? body.readUInt16BE(0) : 0;
      calls.push([
        action, q.get("language"), q.get("type"), q.get("first") ? "first" : null, q.get("mode"),
        action === "image" ? `${req.headers["content-type"]}${head === 0x8950 ? " png" : head === 0xffd8 ? " jpeg" : " ?"}` : null,
        action === "listing" ? JSON.parse(body.toString()).title : null,
      ].filter(Boolean).join(" "));
      return reply(200, action === "start" ? { edit: "edit-test" } : { ok: true });
    }

    if (url.pathname === "/api/suggest") {
      const prompt = JSON.parse(body.toString()).prompt;
      const shots = (prompt.match(/^\d+\. /gm) || []).length;
      return reply(200, { text: "```json\n" + JSON.stringify({ listings: { "de-DE": {
        title: "Stundenwerk", titleAlternatives: ["Zeitwerk"], shortDescription: "Arbeitszeit erfassen und abrechnen.",
        fullDescription: prompt.includes("Rechnung als PDF") ? "Erfasse deine Zeiten.\n\n• Rechnung als PDF" : "Erfasse deine Zeiten.",
        whatsNew: "", featureSubtitle: "Zeiten erfassen, Rechnung fertig.",
        captions: Array.from({ length: shots }, (_, i) => ({ headline: `Vorschlag ${i + 1}`, sub: "" })),
      } } }) + "\n```" });
    }

    if (url.pathname === "/api/team") {
      return reply(200, { projects: [...teamStore].map(([id, e]) => ({ id, ...e.meta })).sort((a, b) => b.at - a.at) });
    }
    if (url.pathname === "/api/team/item") {
      const id = q.get("id"), entry = teamStore.get(id);
      if (req.method === "GET") {
        return entry ? reply(200, entry.body, { "X-Team-At": String(entry.meta.at) }) : reply(404, { error: "Dieses Projekt liegt nicht mehr in der Team-Ablage." });
      }
      if (req.method === "DELETE") { teamStore.delete(id); return reply(200, { ok: true }); }
      if (entry && entry.meta.at > (Number(q.get("base")) || 0) && q.get("force") !== "1") {
        return reply(409, { error: "Jemand hat dieses Projekt inzwischen neu abgelegt.", by: entry.meta.by, at: entry.meta.at });
      }
      // „by“ lässt sich für den Konflikttest von außen setzen.
      const meta = { name: q.get("name"), by: req.headers["x-test-user"] || TEST_USER, at: Date.now(), size: body.length };
      teamStore.set(id, { body: body.toString(), meta });
      return reply(200, { ok: true, ...meta });
    }
    return reply(404, { error: "Unbekannter Aufruf." });
  }
  const urlPath = decodeURIComponent(url.pathname);
  const file = path.join(ROOT, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath);
  // Nichts außerhalb von docs/ ausliefern.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Nicht gefunden"); return; }
    const headers = { ...SECURITY_HEADERS, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" };
    delete headers["Strict-Transport-Security"];          // der Testserver spricht nur HTTP
    if (file.endsWith(".html")) headers["Set-Cookie"] = `${USER_COOKIE}=${encodeURIComponent(TEST_USER)}; Path=/; SameSite=Strict`;
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`docs/ auf http://127.0.0.1:${PORT}`));
