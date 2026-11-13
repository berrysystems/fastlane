#!/usr/bin/env node
/**
 * Lädt Store-Texte, Listing-Bilder und optional ein App Bundle über die
 * Google Play Developer API (androidpublisher v3) hoch.
 *
 * Alles passiert in einem einzigen Edit: schlägt ein Schritt fehl, wird der
 * Edit verworfen und im Store ändert sich nichts.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const OPTIONS = {
  package: { type: "string" },
  metadata: { type: "string" },
  aab: { type: "string" },
  apk: { type: "string" },
  track: { type: "string", default: "internal" },
  rollout: { type: "string" },
  "release-name": { type: "string" },
  key: { type: "string" },
  "skip-images": { type: "boolean", default: false },
  "skip-listings": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  check: { type: "boolean", default: false },
  pull: { type: "boolean", default: false },
  force: { type: "boolean", default: false },
  verbose: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

const USAGE = `
Play-Listing veröffentlichen

  node publish.js --package com.example.app [Optionen]

Optionen
  --package <id>        Paketname. Fällt sonst auf PACKAGE_NAME zurück.
  --metadata <dir>      Metadatenverzeichnis (Standard: fastlane/metadata/android)
  --aab <datei>         App Bundle hochladen (optional)
  --apk <datei>         APK hochladen statt AAB (optional)
  --track <name>        production | beta | alpha | internal (Standard: internal)
  --rollout <0..1>      Gestufter Rollout, z. B. 0.1 für zehn Prozent
  --release-name <txt>  Name des Releases in der Console
  --key <datei>         Service-Account-JSON. Sonst GOOGLE_SERVICE_ACCOUNT_KEY
                        (Inhalt) oder GOOGLE_APPLICATION_CREDENTIALS (Pfad).
  --skip-images         Texte aktualisieren, Bilder unangetastet lassen
  --skip-listings       Nur Binary hochladen
  --check               Nur lokal prüfen — ohne Zugangsdaten, ohne Netzwerk
  --pull                Texte des bestehenden Eintrags aus Play herunterladen,
                        statt etwas hochzuladen. Ändert im Store nichts.
  --force               Mit --pull: vorhandene lokale Texte überschreiben
  --dry-run             Zusätzlich von Google validieren lassen, nichts committen
  --verbose             Mehr Ausgabe
  -h, --help            Diese Hilfe
`;

/** Fehler, die der Nutzer selbst beheben kann — ohne Stacktrace ausgeben. */
class UsageError extends Error {}

/* ------------------------------------------------------------------ *
 * .env
 *
 * Bewusst ohne Abhängigkeit: KEY=VALUE pro Zeile, # leitet nur am
 * Zeilenanfang einen Kommentar ein (ein JSON-Schlüssel darf # enthalten).
 * Bereits gesetzte Variablen gewinnen, damit die CI nicht überschrieben wird.
 * ------------------------------------------------------------------ */

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/* ------------------------------------------------------------------ *
 * Bildprüfung vor dem Upload
 *
 * Google lehnt falsche Abmessungen erst nach dem Upload mit einer knappen
 * Meldung ab. Die Header lokal zu lesen kostet nichts und scheitert früh.
 * ------------------------------------------------------------------ */

function readImageInfo(file) {
  const buf = fs.readFileSync(file);
  const bytes = buf.length;

  // PNG: 8 Byte Signatur, danach IHDR
  if (bytes > 26 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    const colourType = buf[25];
    return {
      format: "png",
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      // Typ 4 (Grau+Alpha) und 6 (RGBA) haben einen Alphakanal; Palettenbilder
      // (Typ 3) nur, wenn ein tRNS-Chunk vor den Bilddaten steht.
      alpha: colourType === 4 || colourType === 6 || (colourType === 3 && hasPngChunk(buf, "tRNS")),
      bytes,
    };
  }

  // JPEG: Marker ablaufen bis zum Start-of-Frame
  if (bytes > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xff) { off++; continue; }                       // Füllbyte
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { format: "jpeg", height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), alpha: false, bytes };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

function hasPngChunk(buf, wanted) {
  let off = 8;
  while (off + 12 <= buf.length) {
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === wanted) return true;
    if (type === "IDAT" || type === "IEND") return false;
    off += 12 + buf.readUInt32BE(off);
  }
  return false;
}

const MB = 1024 * 1024;
const tooBig = (i, max) => (i.bytes > max * MB ? `darf höchstens ${max} MB haben (ist ${(i.bytes / MB).toFixed(2)} MB)` : null);

const IMAGE_RULES = {
  icon: (i) => {
    if (i.format !== "png") return "muss ein 32-Bit-PNG sein";
    if (i.width !== 512 || i.height !== 512) return `muss exakt 512 × 512 sein (ist ${i.width} × ${i.height})`;
    return tooBig(i, 1);
  },
  featureGraphic: (i) => {
    if (i.width !== 1024 || i.height !== 500) return `muss exakt 1024 × 500 sein (ist ${i.width} × ${i.height})`;
    if (i.alpha) return "hat einen Alphakanal, erlaubt sind JPEG oder 24-Bit-PNG";
    return tooBig(i, 15);
  },
  screenshot: (i) => {
    const min = Math.min(i.width, i.height);
    const max = Math.max(i.width, i.height);
    if (min < 320) return `kürzeste Seite unter 320 px (ist ${min})`;
    if (max > 3840) return `längste Seite über 3840 px (ist ${max})`;
    if (max > min * 2) return `Seitenverhältnis über 2:1 (${i.width} × ${i.height})`;
    if (i.alpha) return "hat einen Alphakanal, Screenshots müssen ohne auskommen";
    return tooBig(i, 8);
  },
};

/* ------------------------------------------------------------------ *
 * Metadaten auf der Platte (Fastlane-Struktur)
 * ------------------------------------------------------------------ */

const IMAGE_TYPES = {
  icon: { file: "icon", rule: "icon" },
  featureGraphic: { file: "featureGraphic", rule: "featureGraphic" },
  tvBanner: { file: "tvBanner", rule: null },
  phoneScreenshots: { dir: "phoneScreenshots", rule: "screenshot" },
  sevenInchScreenshots: { dir: "sevenInchScreenshots", rule: "screenshot" },
  tenInchScreenshots: { dir: "tenInchScreenshots", rule: "screenshot" },
  tvScreenshots: { dir: "tvScreenshots", rule: "screenshot" },
  wearScreenshots: { dir: "wearScreenshots", rule: "screenshot" },
};

const TEXT_FILES = {
  title: { file: "title.txt", max: 30 },
  shortDescription: { file: "short_description.txt", max: 80 },
  fullDescription: { file: "full_description.txt", max: 4000 },
};
const CHANGELOG_MAX = 500;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Play zählt Zeichen, nicht UTF-16-Einheiten — ein Emoji ist eins, nicht zwei.
const charCount = (text) => Array.from(text).length;

function readTrimmed(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

function imageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((f) => path.join(dir, f));
}

function findSingle(dir, base) {
  for (const ext of [".png", ".jpg", ".jpeg"]) {
    const p = path.join(dir, base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Sucht das Metadatenverzeichnis: erst relativ zum Aufrufort, dann im Repo. */
function resolveMetadataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const relative = path.join("fastlane", "metadata", "android");
  const candidates = [path.resolve(relative), path.resolve(__dirname, "..", "..", relative)];
  return candidates.find((dir) => fs.existsSync(dir)) || candidates[0];
}

function collectLocales(metadataDir) {
  if (!fs.existsSync(metadataDir)) {
    throw new UsageError(`Metadatenverzeichnis nicht gefunden: ${metadataDir}`);
  }
  const dirs = fs
    .readdirSync(metadataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const skipped = dirs.filter((d) => !LOCALE_RE.test(d));
  if (skipped.length) console.warn(`Übersprungen (kein Sprachcode): ${skipped.join(", ")}`);
  return dirs.filter((d) => LOCALE_RE.test(d));
}

function readLocale(metadataDir, locale) {
  const dir = path.join(metadataDir, locale);
  const imagesDir = path.join(dir, "images");
  const images = {};

  for (const [type, spec] of Object.entries(IMAGE_TYPES)) {
    const files = spec.file
      ? [findSingle(imagesDir, spec.file)].filter(Boolean)
      : imageFiles(path.join(imagesDir, spec.dir));
    if (files.length) images[type] = { files, rule: spec.rule };
  }

  const listing = {};
  for (const [field, spec] of Object.entries(TEXT_FILES)) {
    listing[field] = readTrimmed(path.join(dir, spec.file));
  }
  listing.video = readTrimmed(path.join(dir, "video.txt")) || undefined;

  return {
    locale,
    listing,
    changelog: readTrimmed(path.join(dir, "changelogs", "default.txt")),
    images,
  };
}

function validateLocale(data, { texts = true, images = true } = {}) {
  const problems = [];
  const add = (msg) => problems.push(`${data.locale}: ${msg}`);

  if (texts) {
    for (const [field, spec] of Object.entries(TEXT_FILES)) {
      const value = data.listing[field];
      if (!value) add(`${spec.file} fehlt oder ist leer`);
      else if (charCount(value) > spec.max) add(`${spec.file} hat ${charCount(value)} Zeichen, erlaubt sind ${spec.max}`);
    }
  }
  if (data.changelog && charCount(data.changelog) > CHANGELOG_MAX) {
    add(`changelogs/default.txt hat ${charCount(data.changelog)} Zeichen, erlaubt sind ${CHANGELOG_MAX}`);
  }

  if (images) {
    for (const [type, entry] of Object.entries(data.images)) {
      if (type === "phoneScreenshots" && entry.files.length < 2) {
        add(`mindestens 2 Phone-Screenshots nötig, gefunden ${entry.files.length}`);
      }
      if (type.endsWith("Screenshots") && entry.files.length > 8) {
        add(`${type} hat ${entry.files.length} Bilder, erlaubt sind 8`);
      }
      for (const file of entry.files) {
        const name = path.relative(process.cwd(), file);
        const info = readImageInfo(file);
        if (!info) { problems.push(`${name}: kein lesbares PNG oder JPEG`); continue; }
        const err = entry.rule ? IMAGE_RULES[entry.rule](info) : null;
        if (err) problems.push(`${name}: ${err}`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Zugangsdaten
 * ------------------------------------------------------------------ */

function buildAuth(google, keyFlag) {
  const scopes = ["https://www.googleapis.com/auth/androidpublisher"];

  // Ein ausdrücklich übergebener Pfad gewinnt gegen die Umgebung.
  if (keyFlag) {
    if (!fs.existsSync(keyFlag)) throw new UsageError(`Schlüsseldatei nicht gefunden: ${keyFlag}`);
    return new google.auth.GoogleAuth({ keyFile: keyFlag, scopes });
  }
  const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").trim();
  if (inline) {
    let credentials;
    try { credentials = JSON.parse(inline); }
    catch { throw new UsageError("GOOGLE_SERVICE_ACCOUNT_KEY enthält kein gültiges JSON. Erwartet wird der komplette Inhalt der Schlüsseldatei."); }
    if (!credentials.client_email || !credentials.private_key) {
      throw new UsageError("GOOGLE_SERVICE_ACCOUNT_KEY ist kein Service-Account-Schlüssel (client_email oder private_key fehlt).");
    }
    return new google.auth.GoogleAuth({ credentials, scopes });
  }
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) throw new UsageError(`Schlüsseldatei nicht gefunden: ${keyFile}`);
    return new google.auth.GoogleAuth({ keyFile, scopes });
  }
  throw new UsageError(
    "Keine Zugangsdaten. Setze GOOGLE_SERVICE_ACCOUNT_KEY (JSON-Inhalt) " +
      "oder GOOGLE_APPLICATION_CREDENTIALS (Pfad), oder nutze --key.\n" +
      "Nur lokal prüfen geht ohne: --check"
  );
}

/* ------------------------------------------------------------------ *
 * Bestehenden Eintrag herunterladen
 *
 * Schreibt die Texte aller Sprachen in die Fastlane-Struktur — als
 * Ausgangspunkt für die Werkbank (Texte → „Fastlane-Ordner importieren“).
 * Der dafür nötige Edit wird nie committet, im Store ändert sich nichts.
 * ------------------------------------------------------------------ */

async function pullListings(publisher, packageName, metadataDir, { force = false } = {}) {
  const { data: edit } = await publisher.edits.insert({ packageName });
  let listings;
  try {
    const { data } = await publisher.edits.listings.list({ packageName, editId: edit.id });
    listings = data.listings || [];
  } finally {
    try { await publisher.edits.delete({ packageName, editId: edit.id }); } catch { /* Edit verfällt von selbst */ }
  }

  const writes = [];
  for (const listing of listings) {
    // Der Sprachcode kommt von außen und wird zum Ordnernamen.
    if (!LOCALE_RE.test(listing.language || "")) continue;
    const dir = path.join(metadataDir, listing.language);
    for (const [field, spec] of Object.entries(TEXT_FILES)) {
      writes.push({ file: path.join(dir, spec.file), text: listing[field] || "" });
    }
    if (listing.video) writes.push({ file: path.join(dir, "video.txt"), text: listing.video });
  }

  const conflicts = writes.filter((w) => {
    const current = readTrimmed(w.file);
    return current !== null && current !== "" && current !== w.text.trim();
  });
  if (conflicts.length && !force) {
    throw new UsageError(
      "Diese lokalen Dateien weichen vom Store ab und würden überschrieben:\n" +
        conflicts.map((c) => "  " + path.relative(process.cwd(), c.file)).join("\n") +
        "\nMit --force trotzdem überschreiben, oder mit --metadata in einen anderen Ordner laden."
    );
  }
  for (const w of writes) {
    fs.mkdirSync(path.dirname(w.file), { recursive: true });
    fs.writeFileSync(w.file, w.text.trim() + "\n");
  }
  return [...new Set(writes.map((w) => path.basename(path.dirname(w.file))))].sort();
}

/** Lädt googleapis erst, wenn wirklich mit Play gesprochen wird. */
function connect(keyFlag) {
  let google;
  try { ({ google } = require("googleapis")); }
  catch { throw new UsageError("Das Paket googleapis fehlt. Führe in tools/play-publish zuerst `npm ci` aus."); }
  return google.androidpublisher({ version: "v3", auth: buildAuth(google, keyFlag) });
}

/* ------------------------------------------------------------------ *
 * Ablauf
 * ------------------------------------------------------------------ */

const log = (...m) => console.log(...m);

async function main() {
  let args;
  try {
    args = parseArgs({ options: OPTIONS, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(`${err.message}\n${USAGE}`);
  }
  if (args.help) { log(USAGE); return; }

  loadEnvFile(path.resolve(".env"));
  loadEnvFile(path.join(__dirname, ".env"));

  if (args.pull) {
    if (args.aab || args.apk || args.check || args["dry-run"]) {
      throw new UsageError("--pull lädt nur herunter und lässt sich nicht mit --aab, --apk, --check oder --dry-run kombinieren.");
    }
    const packageName = args.package || process.env.PACKAGE_NAME;
    if (!packageName) throw new UsageError("Paketname fehlt. Nutze --package oder PACKAGE_NAME.");
    const dir = resolveMetadataDir(args.metadata);
    const pulled = await pullListings(connect(args.key), packageName, dir, { force: args.force });
    if (!pulled.length) { log("Im Store ist für diese App noch kein Eintrag hinterlegt."); return; }
    log(`Texte heruntergeladen für ${pulled.length} Sprache(n): ${pulled.join(", ")}`);
    log(`Abgelegt in ${path.relative(process.cwd(), dir) || "."}. Bilder werden nicht geladen — im Store ändert sich nichts.`);
    return;
  }

  const skipListings = args["skip-listings"];
  const skipImages = args["skip-images"] || skipListings;

  if (args.aab && args.apk) throw new UsageError("Entweder --aab oder --apk, nicht beides.");
  const binary = args.aab || args.apk || null;
  if (binary && !fs.existsSync(binary)) throw new UsageError(`Datei nicht gefunden: ${binary}`);
  if (skipListings && !binary && !args.check) {
    throw new UsageError("--skip-listings ohne --aab oder --apk hätte nichts hochzuladen.");
  }

  let rollout = null;
  if (args.rollout !== undefined) {
    rollout = Number(args.rollout);
    if (!(rollout > 0 && rollout <= 1)) throw new UsageError("--rollout muss größer als 0 und höchstens 1 sein.");
    if (!binary) throw new UsageError("--rollout wirkt nur zusammen mit --aab oder --apk.");
  }

  const metadataDir = resolveMetadataDir(args.metadata);
  const locales = collectLocales(metadataDir).map((l) => readLocale(metadataDir, l));
  if (!locales.length) throw new UsageError(`Keine Sprachordner in ${metadataDir}`);

  // ---- lokale Prüfung, bevor irgendein Request rausgeht
  const problems = locales.flatMap((l) => validateLocale(l, { texts: !skipListings, images: !skipImages }));
  if (problems.length) {
    console.error("\nDie Prüfung ist fehlgeschlagen:\n");
    problems.forEach((p) => console.error("  ✗ " + p));
    console.error("\nNichts wurde hochgeladen.\n");
    process.exitCode = 1;
    return;
  }
  log(`Prüfung bestanden für ${locales.length} Sprache(n): ${locales.map((l) => l.locale).join(", ")}`);
  if (args.verbose || args.check) {
    for (const l of locales) {
      const counts = Object.entries(l.images).map(([type, e]) => `${type} ${e.files.length}`);
      log(`  ${l.locale}: ${counts.length ? counts.join(", ") : "keine Bilder"}`);
    }
  }
  if (args.check) { log("\nNur lokal geprüft (--check). Nichts wurde hochgeladen."); return; }

  const packageName = args.package || process.env.PACKAGE_NAME;
  if (!packageName) throw new UsageError("Paketname fehlt. Nutze --package oder PACKAGE_NAME.");

  const publisher = connect(args.key);

  const { data: edit } = await publisher.edits.insert({ packageName });
  const editId = edit.id;
  log(`Edit angelegt: ${editId}`);

  try {
    let versionCode = null;

    // ---- Binary
    if (binary) {
      log(`Lade ${path.basename(binary)} hoch, das kann dauern …`);
      const res = args.aab
        ? await publisher.edits.bundles.upload({
            packageName,
            editId,
            media: { mimeType: "application/octet-stream", body: fs.createReadStream(binary) },
          })
        : await publisher.edits.apks.upload({
            packageName,
            editId,
            media: { mimeType: "application/vnd.android.package-archive", body: fs.createReadStream(binary) },
          });
      versionCode = res.data.versionCode;
      log(`Hochgeladen, versionCode ${versionCode}`);
    }

    // ---- Texte und Bilder
    if (!skipListings) {
      for (const data of locales) {
        await publisher.edits.listings.update({
          packageName,
          editId,
          language: data.locale,
          requestBody: { language: data.locale, ...data.listing },
        });
        log(`Texte aktualisiert: ${data.locale}`);

        if (skipImages) continue;

        for (const [imageType, entry] of Object.entries(data.images)) {
          // Ersetzen statt anhängen, sonst sammeln sich alte Screenshots an.
          await publisher.edits.images.deleteall({ packageName, editId, language: data.locale, imageType });
          for (const file of entry.files) {
            await publisher.edits.images.upload({
              packageName,
              editId,
              language: data.locale,
              imageType,
              media: { mimeType: /\.png$/i.test(file) ? "image/png" : "image/jpeg", body: fs.createReadStream(file) },
            });
            if (args.verbose) log(`    ${imageType}: ${path.basename(file)}`);
          }
          log(`  ${imageType}: ${entry.files.length} Bild(er)`);
        }
      }
    }

    // ---- Track
    if (versionCode != null) {
      const staged = rollout !== null && rollout < 1;
      const release = { versionCodes: [String(versionCode)], status: staged ? "inProgress" : "completed" };
      if (staged) release.userFraction = rollout;
      if (args["release-name"]) release.name = args["release-name"];

      const notes = locales.filter((l) => l.changelog).map((l) => ({ language: l.locale, text: l.changelog }));
      if (notes.length) release.releaseNotes = notes;

      await publisher.edits.tracks.update({
        packageName,
        editId,
        track: args.track,
        requestBody: { track: args.track, releases: [release] },
      });
      log(`Track "${args.track}" gesetzt${staged ? ` (Rollout ${Math.round(rollout * 1000) / 10} %)` : ""}`);
    }

    // ---- Abschluss
    if (args["dry-run"]) {
      await publisher.edits.validate({ packageName, editId });
      await publisher.edits.delete({ packageName, editId });
      log("\nProbelauf: von Google validiert, Edit wieder verworfen. Nichts veröffentlicht.");
      return;
    }

    await publisher.edits.commit({ packageName, editId });
    log("\nEdit committet. Die Änderungen gehen jetzt in die Prüfung.");
  } catch (err) {
    // Aufräumen ist Kür — der eigentliche Fehler soll sichtbar bleiben.
    try { await publisher.edits.delete({ packageName, editId }); } catch { /* Edit verfällt von selbst */ }
    throw err;
  }
}

function report(err) {
  if (err instanceof UsageError) {
    console.error("\n" + err.message);
    return;
  }
  // googleapis liefert die Details je nach Version an unterschiedlicher Stelle.
  const api = err?.response?.data?.error;
  const status = err?.status ?? err?.response?.status ?? err?.code;
  const reason = api?.status || api?.errors?.[0]?.reason || err?.errors?.[0]?.reason;
  const message = api?.message || err?.errors?.[0]?.message || err?.message || String(err);
  console.error(`\nFehlgeschlagen${reason ? ` (${reason})` : ""}: ${message}`);

  if (status === 401 || status === 403) {
    console.error(
      "Prüfe, ob das Dienstkonto in der Play Console unter „Nutzer und Berechtigungen“ " +
        "eingeladen ist und den Store-Eintrag dieser App bearbeiten darf."
    );
  } else if (status === 404) {
    console.error("Prüfe den Paketnamen. Die App muss in der Console bereits angelegt und einmal von Hand veröffentlicht sein.");
  }
  if (process.env.DEBUG) console.error(err);
}

if (require.main === module) {
  main().catch((err) => {
    report(err);
    process.exitCode = 1;
  });
}

module.exports = { readImageInfo, validateLocale, readLocale, collectLocales, loadEnvFile, pullListings, IMAGE_RULES };
