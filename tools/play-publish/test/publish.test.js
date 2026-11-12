"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readImageInfo, readLocale, validateLocale, collectLocales, loadEnvFile } = require("../publish.js");

/** Kleinstes PNG, das die Header-Prüfung braucht: Signatur + IHDR. */
function png(width, height, colourType = 2) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = colourType;
  return buf;
}

/** JPEG mit vorangestelltem APP0-Segment und einem SOF0-Frame. */
function jpeg(width, height) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.alloc(8)]);
}

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "play-publish-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

const GOOD = {
  "de-DE/title.txt": "Tagwerk\n",
  "de-DE/short_description.txt": "Plane deinen Tag in Minuten.\n",
  "de-DE/full_description.txt": "Eine lange Beschreibung.\n",
  "de-DE/images/icon.png": png(512, 512, 6),
  "de-DE/images/featureGraphic.jpg": jpeg(1024, 500),
  "de-DE/images/phoneScreenshots/1_screenshot.jpg": jpeg(1080, 1920),
  "de-DE/images/phoneScreenshots/2_screenshot.jpg": jpeg(1080, 1920),
};

test("liest Abmessungen aus PNG und JPEG", () => {
  const root = fixture({ "a.png": png(512, 512, 6), "b.jpg": jpeg(1024, 500), "c.png": Buffer.from("kein Bild") });
  assert.deepEqual(
    { ...readImageInfo(path.join(root, "a.png")), bytes: 0 },
    { format: "png", width: 512, height: 512, alpha: true, bytes: 0 }
  );
  const info = readImageInfo(path.join(root, "b.jpg"));
  assert.equal(info.width, 1024);
  assert.equal(info.height, 500);
  assert.equal(readImageInfo(path.join(root, "c.png")), null);
});

test("ein vollständiges Listing besteht die Prüfung", () => {
  const root = fixture(GOOD);
  assert.deepEqual(collectLocales(root), ["de-DE"]);
  assert.deepEqual(validateLocale(readLocale(root, "de-DE")), []);
});

test("meldet fehlende Texte, Überlängen und falsche Bilder", () => {
  const root = fixture({
    ...GOOD,
    "de-DE/title.txt": "x".repeat(31),
    "de-DE/short_description.txt": "",
    "de-DE/changelogs/default.txt": "y".repeat(501),
    "de-DE/images/icon.png": png(256, 256, 6),
    "de-DE/images/featureGraphic.png": png(1024, 500, 6),
    "de-DE/images/phoneScreenshots/2_screenshot.jpg": jpeg(1080, 2400),
  });
  fs.rmSync(path.join(root, "de-DE/images/featureGraphic.jpg"));
  const problems = validateLocale(readLocale(root, "de-DE")).join("\n");
  assert.match(problems, /title\.txt hat 31 Zeichen/);
  assert.match(problems, /short_description\.txt fehlt oder ist leer/);
  assert.match(problems, /changelogs\/default\.txt hat 501 Zeichen/);
  assert.match(problems, /icon\.png: muss exakt 512 × 512/);
  assert.match(problems, /featureGraphic\.png: hat einen Alphakanal/);
  assert.match(problems, /2_screenshot\.jpg: Seitenverhältnis über 2:1/);
});

test("Emoji zählen als ein Zeichen", () => {
  const root = fixture({ ...GOOD, "de-DE/title.txt": "😀".repeat(30) });
  assert.deepEqual(validateLocale(readLocale(root, "de-DE")), []);
});

test("--skip-images und --skip-listings überspringen die jeweilige Prüfung", () => {
  const root = fixture({ "de-DE/images/icon.png": png(10, 10) });
  const data = readLocale(root, "de-DE");
  assert.equal(validateLocale(data, { texts: false, images: false }).length, 0);
  assert.equal(validateLocale(data, { texts: true, images: false }).length, 3);
});

test("Ordner ohne Sprachcode werden nicht als Sprache behandelt", () => {
  const root = fixture({ "de-DE/title.txt": "a", "en-US/title.txt": "a", "entwurf_alt/title.txt": "a" });
  assert.deepEqual(collectLocales(root), ["de-DE", "en-US"]);
});

test(".env: JSON-Werte bleiben ganz, gesetzte Variablen gewinnen", () => {
  const root = fixture({
    ".env": '# Kommentar\nPP_TEST_KEY={"type":"service_account","note":"a=b #c"}\nPP_TEST_QUOTED="mit Leerzeichen"\nPP_TEST_SET=aus-datei\n',
  });
  process.env.PP_TEST_SET = "aus-umgebung";
  loadEnvFile(path.join(root, ".env"));
  assert.equal(JSON.parse(process.env.PP_TEST_KEY).note, "a=b #c");
  assert.equal(process.env.PP_TEST_QUOTED, "mit Leerzeichen");
  assert.equal(process.env.PP_TEST_SET, "aus-umgebung");
});
