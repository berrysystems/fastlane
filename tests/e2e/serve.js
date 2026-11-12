"use strict";
// Liefert docs/ für die Tests aus — ohne zusätzliche Abhängigkeit.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..", "docs");
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.join(ROOT, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath);
  // Nichts außerhalb von docs/ ausliefern.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Nicht gefunden"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`docs/ auf http://127.0.0.1:${PORT}`));
