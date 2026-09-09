#!/usr/bin/env node
/**
 * Publishes Play Store metadata, listing images and optionally an AAB
 * through the Google Play Developer API (androidpublisher v3).
 *
 * Everything happens inside one edit: if any step fails, nothing is committed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=");
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const USAGE = `
Play Store publisher

  node publish.js --package com.example.app [options]

Options
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
  --dry-run             Alles vorbereiten, validieren, aber nicht committen
  --verbose             Mehr Ausgabe
`;

/* ------------------------------------------------------------------ *
 * Image pre-flight
 *
 * Google rejects wrong dimensions with a terse error after the upload has
 * already run. Reading the headers locally costs nothing and fails fast.
 * ------------------------------------------------------------------ */

function readImageInfo(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(65536);
  const read = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const head = buf.slice(0, read);

  // PNG: 8-byte signature, then IHDR
  if (head.length > 26 && head.readUInt32BE(0) === 0x89504e47) {
    return {
      format: "png",
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
      // colour type 4 (grey+alpha) and 6 (RGBA) carry an alpha channel
      alpha: head[25] === 4 || head[25] === 6,
      bytes: fs.statSync(file).size,
    };
  }

  // JPEG: walk the markers until a start-of-frame
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    let off = 2;
    while (off + 9 < head.length) {
      if (head[off] !== 0xff) { off++; continue; }
      const marker = head[off + 1];
      const len = head.readUInt16BE(off + 2);
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return {
          format: "jpeg",
          height: head.readUInt16BE(off + 5),
          width: head.readUInt16BE(off + 7),
          alpha: false,
          bytes: fs.statSync(file).size,
        };
      }
      off += 2 + len;
    }
  }
  return null;
}

const IMAGE_RULES = {
  icon: (i) =>
    i.width !== 512 || i.height !== 512
      ? `muss exakt 512 × 512 sein (ist ${i.width} × ${i.height})`
      : i.bytes > 1024 * 1024
      ? `darf höchstens 1 MB haben (ist ${(i.bytes / 1048576).toFixed(2)} MB)`
      : null,
  featureGraphic: (i) =>
    i.width !== 1024 || i.height !== 500
      ? `muss exakt 1024 × 500 sein (ist ${i.width} × ${i.height})`
      : null,
  screenshot: (i) => {
    const min = Math.min(i.width, i.height);
    const max = Math.max(i.width, i.height);
    if (min < 320) return `kürzeste Seite unter 320 px (ist ${min})`;
    if (max > 3840) return `längste Seite über 3840 px (ist ${max})`;
    if (max > min * 2) return `Seitenverhältnis über 2:1 (${i.width} × ${i.height})`;
    if (i.alpha) return "hat einen Alphakanal, Screenshots müssen ohne auskommen";
    return null;
  },
};

/* ------------------------------------------------------------------ *
 * Metadata on disk (fastlane layout)
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

function readTrimmed(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function imageFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort(naturalSort)
    .map((f) => path.join(dir, f));
}

function findSingle(dir, base) {
  for (const ext of [".png", ".jpg", ".jpeg"]) {
    const p = path.join(dir, base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function collectLocales(metadataDir) {
  if (!fs.existsSync(metadataDir)) {
    throw new Error(`Metadatenverzeichnis nicht gefunden: ${metadataDir}`);
  }
  return fs
    .readdirSync(metadataDir)
    .filter((d) => fs.statSync(path.join(metadataDir, d)).isDirectory())
    .sort();
}

function readLocale(metadataDir, locale) {
  const dir = path.join(metadataDir, locale);
  const imagesDir = path.join(dir, "images");
  const images = {};

  for (const [type, spec] of Object.entries(IMAGE_TYPES)) {
    if (spec.file) {
      const found = findSingle(imagesDir, spec.file);
      if (found) images[type] = { files: [found], rule: spec.rule };
    } else {
      const files = imageFiles(path.join(imagesDir, spec.dir));
      if (files.length) images[type] = { files, rule: spec.rule };
    }
  }

  return {
    locale,
    listing: {
      title: readTrimmed(path.join(dir, "title.txt")),
      shortDescription: readTrimmed(path.join(dir, "short_description.txt")),
      fullDescription: readTrimmed(path.join(dir, "full_description.txt")),
      video: readTrimmed(path.join(dir, "video.txt")) || undefined,
    },
    changelog: readTrimmed(path.join(dir, "changelogs", "default.txt")),
    images,
  };
}

const TEXT_LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };

function validateLocale(data) {
  const problems = [];
  const l = data.listing;

  if (!l.title) problems.push(`${data.locale}: title.txt fehlt`);
  if (!l.shortDescription) problems.push(`${data.locale}: short_description.txt fehlt`);
  if (!l.fullDescription) problems.push(`${data.locale}: full_description.txt fehlt`);

  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (l[field] && l[field].length > max) {
      problems.push(`${data.locale}: ${field} hat ${l[field].length} Zeichen, erlaubt sind ${max}`);
    }
  }

  for (const [type, entry] of Object.entries(data.images)) {
    if (type === "phoneScreenshots" && entry.files.length < 2) {
      problems.push(`${data.locale}: mindestens 2 Phone-Screenshots nötig, gefunden ${entry.files.length}`);
    }
    if (entry.files.length > 8 && type.endsWith("Screenshots")) {
      problems.push(`${data.locale}: ${type} hat ${entry.files.length} Bilder, erlaubt sind 8`);
    }
    for (const file of entry.files) {
      const info = readImageInfo(file);
      if (!info) {
        problems.push(`${path.basename(file)}: kein lesbares PNG oder JPEG`);
        continue;
      }
      const check = entry.rule && IMAGE_RULES[entry.rule];
      const err = check ? check(info) : null;
      if (err) problems.push(`${path.relative(process.cwd(), file)}: ${err}`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

function buildAuth(args) {
  const scopes = ["https://www.googleapis.com/auth/androidpublisher"];

  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (inline && inline.trim().startsWith("{")) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(inline), scopes });
  }
  const keyFile = args.key || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) throw new Error(`Schlüsseldatei nicht gefunden: ${keyFile}`);
    return new google.auth.GoogleAuth({ keyFile, scopes });
  }
  throw new Error(
    "Keine Zugangsdaten. Setze GOOGLE_SERVICE_ACCOUNT_KEY (JSON-Inhalt) " +
      "oder GOOGLE_APPLICATION_CREDENTIALS (Pfad), oder nutze --key."
  );
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const log = (...m) => console.log(...m);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { log(USAGE); return; }

  const packageName = args.package || process.env.PACKAGE_NAME;
  if (!packageName) throw new Error("Paketname fehlt. Nutze --package oder PACKAGE_NAME.");

  const metadataDir = path.resolve(args.metadata || "fastlane/metadata/android");
  const track = args.track || "internal";
  const dryRun = !!args["dry-run"];
  const binary = args.aab || args.apk || null;

  if (binary && !fs.existsSync(binary)) throw new Error(`Datei nicht gefunden: ${binary}`);
  if (args.rollout !== undefined) {
    const f = Number(args.rollout);
    if (!(f > 0 && f <= 1)) throw new Error("--rollout muss zwischen 0 und 1 liegen.");
  }

  const locales = collectLocales(metadataDir).map((l) => readLocale(metadataDir, l));
  if (!locales.length) throw new Error(`Keine Sprachordner in ${metadataDir}`);

  // ---- pre-flight before touching the API
  const problems = locales.flatMap(validateLocale);
  if (problems.length) {
    console.error("\nDie Prüfung ist fehlgeschlagen:\n");
    problems.forEach((p) => console.error("  ✗ " + p));
    console.error("\nNichts wurde hochgeladen.\n");
    process.exitCode = 1;
    return;
  }
  log(`Prüfung bestanden für ${locales.length} Sprache(n): ${locales.map((l) => l.locale).join(", ")}`);

  const auth = buildAuth(args);
  const publisher = google.androidpublisher({ version: "v3", auth });

  const { data: edit } = await publisher.edits.insert({ packageName });
  const editId = edit.id;
  log(`Edit angelegt: ${editId}`);

  try {
    let versionCode = null;

    // ---- binary
    if (binary) {
      const isAab = /\.aab$/i.test(binary);
      log(`Lade ${path.basename(binary)} hoch, das kann dauern …`);
      const res = isAab
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

    // ---- listings and images
    if (!args["skip-listings"]) {
      for (const data of locales) {
        await publisher.edits.listings.update({
          packageName,
          editId,
          language: data.locale,
          requestBody: data.listing,
        });
        log(`Texte aktualisiert: ${data.locale}`);

        if (args["skip-images"]) continue;

        for (const [imageType, entry] of Object.entries(data.images)) {
          // replace rather than append, otherwise old screenshots linger
          await publisher.edits.images.deleteall({
            packageName, editId, language: data.locale, imageType,
          });
          for (const file of entry.files) {
            const mimeType = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
            await publisher.edits.images.upload({
              packageName,
              editId,
              language: data.locale,
              imageType,
              media: { mimeType, body: fs.createReadStream(file) },
            });
            if (args.verbose) log(`    ${imageType}: ${path.basename(file)}`);
          }
          log(`  ${imageType}: ${entry.files.length} Bild(er)`);
        }
      }
    }

    // ---- track
    if (versionCode) {
      const release = {
        versionCodes: [String(versionCode)],
        status: args.rollout ? "inProgress" : "completed",
      };
      if (args.rollout) release.userFraction = Number(args.rollout);
      if (args["release-name"]) release.name = args["release-name"];

      const notes = locales
        .filter((l) => l.changelog)
        .map((l) => ({ language: l.locale, text: l.changelog }));
      if (notes.length) release.releaseNotes = notes;

      await publisher.edits.tracks.update({
        packageName,
        editId,
        track,
        requestBody: { track, releases: [release] },
      });
      log(`Track "${track}" gesetzt${args.rollout ? ` (Rollout ${Number(args.rollout) * 100} %)` : ""}`);
    }

    // ---- finish
    if (dryRun) {
      await publisher.edits.validate({ packageName, editId });
      await publisher.edits.delete({ packageName, editId });
      log("\nProbelauf: von Google validiert, Edit wieder verworfen. Nichts veröffentlicht.");
      return;
    }

    await publisher.edits.commit({ packageName, editId });
    log("\nEdit committet. Die Änderungen gehen jetzt in die Prüfung.");
  } catch (err) {
    try { await publisher.edits.delete({ packageName, editId }); } catch (_) {}
    throw err;
  }
}

main().catch((err) => {
  const api = err && err.errors && err.errors[0];
  console.error("\nFehlgeschlagen: " + (api ? `${api.reason} — ${api.message}` : err.message));
  if (err.code === 401 || err.code === 403) {
    console.error(
      "Prüfe, ob das Service-Account in der Play Console verknüpft ist und " +
        "die Berechtigung zum Bearbeiten des Store-Eintrags hat."
    );
  }
  process.exitCode = 1;
});
