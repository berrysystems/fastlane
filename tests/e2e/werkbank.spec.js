"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("../../docs/assets/vendor/jszip.min.js");

/* ------------------------------------------------------------------ *
 * Helfer
 * ------------------------------------------------------------------ */

// Jede Konsolenmeldung der Seite ist ein Fehler im Test.
test.beforeEach(async ({ page }, testInfo) => {
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`); });
  testInfo.problems = problems;
});
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.problems, "Konsole der Seite").toEqual([]);
});

async function open(page, url = "/") {
  await page.goto(url);
  await page.waitForSelector("html[data-ready]");
}

/** Erzeugt im Browser ein PNG und gibt es als Upload-Objekt zurück. */
async function png(page, name, { w = 1080, h = 2340, colour = "#0E7C66", logo = false } = {}) {
  const base64 = await page.evaluate(([w, h, colour, logo]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    if (logo) {
      x.fillStyle = colour; x.beginPath(); x.arc(w / 2, h / 2, w * 0.45, 0, 7); x.fill();
      x.fillStyle = "#FFD166"; x.fillRect(w * 0.35, h * 0.3, w * 0.3, h * 0.4);
    } else {
      x.fillStyle = "#f4f6f8"; x.fillRect(0, 0, w, h);
      x.fillStyle = colour; x.fillRect(0, 0, w, h * 0.12);
    }
    return c.toDataURL("image/png").split(",")[1];
  }, [w, h, colour, logo]);
  return { name, mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
}

async function addShots(page, count = 2) {
  const colours = ["#0E7C66", "#2F6FED", "#C2185B", "#F2711C"];
  const files = [];
  for (let i = 0; i < count; i++) files.push(await png(page, `s${i + 1}.png`, { colour: colours[i % colours.length] }));
  await page.locator("#tab-shots").click();
  await page.locator("#file").setInputFiles(files);
  await expect(page.locator(".shotrow")).toHaveCount(count);
}

async function addLogo(page) {
  await page.locator("#tab-icon").click();
  await page.locator("#ilogo").setInputFiles(await png(page, "logo.png", { w: 512, h: 512, logo: true }));
  await expect(page.locator("#st-icon")).toHaveText("✓");
}

async function fillTexts(page, { title = "Tagwerk", short = "Plane deinen Tag in Minuten.", full = "Eine ehrliche Beschreibung der App." } = {}) {
  await page.locator("#tab-text").click();
  await page.locator("#mTitle").fill(title);
  await page.locator("#mShort").fill(short);
  await page.locator("#mFull").fill(full);
}

/** Klickt und liest den ausgelösten Download als ZIP. */
async function downloadZip(page, selector) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(selector).click()]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await download.path()));
  return { name: download.suggestedFilename(), zip, files: Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort() };
}

/** Farbe eines Pixels im n-ten Screenshot-Canvas. */
const pixel = (page, index, x = 5, y = 5) => page.evaluate(([index, x, y]) => {
  // Über eine Kopie lesen, damit das Canvas der Seite unangetastet bleibt.
  const canvas = document.querySelectorAll("#sheet canvas")[index];
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
  return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
}, [index, x, y]);

const captions = (page) => page.locator(".shotrow input[type=text]:not(.sub)");
// Der Autosave wartet, bis die Eingabe zur Ruhe kommt.
const settle = (page) => page.waitForTimeout(900);

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test("startet leer, zeigt sieben Schritte und lädt nichts von fremden Servern", async ({ page }) => {
  const foreign = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1") && !/^(data|blob):/.test(r.url())) foreign.push(r.url()); });
  await open(page);
  await expect(page.locator(".step")).toHaveCount(7);
  await expect(page.locator("#st-export")).toHaveText("4 offen");
  await expect(page.locator("#langswitch")).toHaveValue("de-DE");
  await expect(page.locator("#undo")).toBeDisabled();
  expect(await page.evaluate(() => document.fonts.check("700 20px 'Bricolage Grotesque'"))).toBe(true);
  expect(foreign).toEqual([]);
});

test("läuft unter den Schutz-Headern und zeigt, wer angemeldet ist", async ({ page }) => {
  const response = await page.goto("/");
  await page.waitForSelector("html[data-ready]");
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  await expect(page.locator("#userbox")).toBeVisible();
  await expect(page.locator("#useremail")).toHaveText("test.nutzer@example.com");
  await expect(page.locator("#userbox a")).toHaveAttribute("href", "/cdn-cgi/access/logout");
});

test("eigene Schrift lässt sich laden und wieder entfernen", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  await page.locator("#fontfile").setInputFiles(path.resolve(__dirname, "..", "..", "docs", "assets", "fonts", "dm-mono-latin-500-normal.woff2"));
  await expect(page.locator("#fontclear")).toBeVisible();
  await expect(page.locator("#fontdrop strong")).toHaveText("dm-mono-latin-500-normal.woff2");
  expect(await page.evaluate(() => document.fonts.check("700 20px ListingBrand"))).toBe(true);
  await page.locator("#fontclear").click();
  await expect(page.locator("#fontclear")).toBeHidden();
});

test("Schritte lassen sich mit den Pfeiltasten wechseln", async ({ page }) => {
  await open(page);
  await page.locator("#tab-icon").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-shots")).toBeFocused();
  await expect(page.locator("#panel-shots")).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.locator("#panel-export")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe("#export");
});

test("Icon: Farben aus dem Logo, ZIP mit allen Dichten und beiden XML-Dateien", async ({ page }) => {
  await open(page);
  await addLogo(page);
  await expect(page.locator("#ipalette .chip").first()).toBeVisible();
  await page.locator("#ipalette .chip").first().click();
  await expect(page.locator("#ibg2")).toHaveValue("#0e7c66");

  const { files, zip } = await downloadZip(page, "#idlall");
  expect(files).toContain("play/icon.png");
  expect(files).toContain("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
  expect(files).toContain("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml");
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    for (const name of ["ic_launcher", "ic_launcher_round", "ic_launcher_foreground", "ic_launcher_background", "ic_launcher_monochrome"]) {
      expect(files).toContain(`android/app/src/main/res/mipmap-${density}/${name}.png`);
    }
  }
  // Legacy-Icon in xxxhdpi ist 192 × 192 (PNG-Header: Breite ab Byte 16).
  const legacy = await zip.file("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png").async("nodebuffer");
  expect(legacy.readUInt32BE(16)).toBe(192);
});

test("Screenshots: Captions, Reihenfolge, Entfernen und Rückgängig", async ({ page }) => {
  await open(page);
  await addShots(page, 3);
  await captions(page).nth(0).fill("Erster");
  await captions(page).nth(1).fill("Zweiter");
  await captions(page).nth(2).fill("Dritter");
  await expect(page.locator("#st-shots")).toHaveText("3/8");
  await settle(page);

  await page.getByRole("button", { name: "Nach hinten — Screenshot 1" }).click();
  await expect(captions(page).nth(0)).toHaveValue("Zweiter");
  await expect(captions(page).nth(1)).toHaveValue("Erster");
  await settle(page);

  await page.getByRole("button", { name: "Entfernen — Screenshot 3" }).click();
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await settle(page);

  await page.locator("#undo").click();
  await expect(page.locator(".shotrow")).toHaveCount(3);
  await expect(captions(page).nth(2)).toHaveValue("Dritter");
  await expect(page.locator(".shotrow img").nth(2)).toHaveJSProperty("complete", true);
  expect(await page.locator(".shotrow img").nth(2).evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

  await page.locator("#undo").click();
  await expect(captions(page).nth(0)).toHaveValue("Erster");
  await page.locator("#redo").click();
  await expect(captions(page).nth(0)).toHaveValue("Zweiter");
});

test("Screenshots lassen sich am Griff umsortieren", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Natives Drag-and-drop lässt sich nur in Chromium verlässlich fernsteuern.");
  // Hoch genug, dass alle drei Zeilen ohne Scrollen sichtbar sind.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await open(page);
  await addShots(page, 3);
  await captions(page).nth(0).fill("Erster");
  await captions(page).nth(2).fill("Dritter");
  const last = await page.locator(".shotrow").nth(2).boundingBox();
  await page.locator(".shotrow .handle").nth(0).dragTo(page.locator(".shotrow").nth(2), {
    targetPosition: { x: last.width / 2, y: last.height - 4 },
  });
  await expect(captions(page).nth(2)).toHaveValue("Erster");
  await expect(captions(page).nth(1)).toHaveValue("Dritter");
});

test("Eigenes Layout gilt nur für den einen Screenshot", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  const before = await pixel(page, 1);
  const row = page.locator(".shotrow").nth(0);
  await row.locator("summary").click();
  await row.getByLabel("Eigener Hintergrund").check();
  await row.locator(".shotopts input[type=color]").nth(0).fill("#ff0000");
  await row.locator(".shotopts input[type=color]").nth(1).fill("#ff0000");
  await expect.poll(() => pixel(page, 0)).toEqual([255, 0, 0]);
  expect(await pixel(page, 1)).toEqual(before);
  await expect(row.locator("summary")).toContainText("aktiv");

  // Im Panorama ruht die Abweichung.
  await page.locator("#pano").check();
  await expect.poll(() => pixel(page, 0)).not.toEqual([255, 0, 0]);
});

test("Phone und Tablet im selben Projekt: eigene Screenshots, ein Export mit beiden Ordnern", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  await captions(page).nth(0).fill("Phone-Caption");

  // Anderes Gerät, anderer Satz: die Liste ist zunächst leer.
  await page.locator("#deviceset").selectOption("tenInchScreenshots");
  await expect(page.locator(".shotrow")).toHaveCount(0);
  await expect(page.locator("#presetfield")).toBeHidden();
  await page.locator("#file").setInputFiles([await png(page, "t1.png", { w: 1600, h: 2560 }), await png(page, "t2.png", { w: 1600, h: 2560, colour: "#C2185B" }), await png(page, "t3.png", { w: 1600, h: 2560 })]);
  await expect(page.locator(".shotrow")).toHaveCount(3);
  await captions(page).nth(0).fill("Tablet-Caption");
  expect(await page.locator("#sheet canvas").first().evaluate((c) => [c.width, c.height])).toEqual([1600, 2560]);

  await page.locator("#deviceset").selectOption("phoneScreenshots");
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect(captions(page).nth(0)).toHaveValue("Phone-Caption");

  await fillTexts(page);
  await page.locator("#mVideo").fill("https://www.youtube.com/watch?v=abcdefghijk");
  await page.locator("#mWhats").fill("Dunkelmodus.");
  await page.locator("#mVersionCode").fill("42");
  await page.locator("#tab-brief").click();
  await expect(page.locator(".noterow")).toHaveCount(5);
  await page.locator("#tab-export").click();
  await expect(page.locator("#tree")).toContainText("phoneScreenshots/");
  await expect(page.locator("#tree")).toContainText("tenInchScreenshots/");
  const { files, zip } = await downloadZip(page, "#zipmeta");
  const base = "fastlane/metadata/android/de-DE/";
  expect(files.filter((f) => f.includes("phoneScreenshots")).length).toBe(2);
  expect(files.filter((f) => f.includes("tenInchScreenshots")).length).toBe(3);
  expect(await zip.file(base + "video.txt").async("string")).toBe("https://www.youtube.com/watch?v=abcdefghijk\n");
  expect(await zip.file(base + "changelogs/42.txt").async("string")).toBe("Dunkelmodus.\n");
  expect(await zip.file(base + "changelogs/default.txt").async("string")).toBe("Dunkelmodus.\n");
  // JPEG-Kopf: Die Tablet-Bilder sind wirklich 1600 × 2560, die Phone-Bilder 1080 × 1920.
  const size = async (name) => {
    const buf = await zip.file(base + name).async("nodebuffer");
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      if (buf[i + 1] >= 0xc0 && buf[i + 1] <= 0xc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  };
  expect(await size("images/phoneScreenshots/1_screenshot.jpg")).toEqual([1080, 1920]);
  expect(await size("images/tenInchScreenshots/1_screenshot.jpg")).toEqual([1600, 2560]);
  // Nach dem Export steht wieder das vorher gewählte Gerät da.
  await expect(page.locator("#deviceset")).toHaveValue("phoneScreenshots");

  // Beides überlebt das Neuladen.
  await settle(page);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await page.locator("#tab-shots").click();
  await page.locator("#deviceset").selectOption("tenInchScreenshots");
  await expect(page.locator(".shotrow")).toHaveCount(3);
  await expect(captions(page).nth(0)).toHaveValue("Tablet-Caption");
});

test("Querformat, Ausschnitt und Textausrichtung wirken auf das Bild", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  const shape = () => page.locator("#sheet canvas").first().evaluate((c) => [c.width, c.height]);
  expect(await shape()).toEqual([1080, 1920]);
  await page.locator("#orient").selectOption("landscape");
  await expect.poll(shape).toEqual([1920, 1080]);
  await page.locator("#preset").selectOption("1242x2208");
  await expect.poll(shape).toEqual([2208, 1242]);
  await page.locator("#orient").selectOption("portrait");
  await page.locator("#preset").selectOption("1080x1920");
  await expect.poll(shape).toEqual([1080, 1920]);

  // Ausschnitt vergrößern verändert nur diesen Screenshot.
  const fingerprint = (index) => page.evaluate((index) => {
    const canvas = document.querySelectorAll("#sheet canvas")[index];
    const probe = document.createElement("canvas");
    probe.width = 24; probe.height = 42;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, 24, 42);
    return Array.from(ctx.getImageData(0, 0, 24, 42).data).join(",");
  }, index);
  const before = [await fingerprint(0), await fingerprint(1)];
  const row = page.locator(".shotrow").nth(0);
  await row.locator("summary").click();
  await row.getByLabel("Vergrößern für Screenshot 1").fill("200");
  await row.getByLabel("Ausschnitt für Screenshot 1").fill("100");
  await expect.poll(() => fingerprint(0)).not.toBe(before[0]);
  expect(await fingerprint(1)).toBe(before[1]);
  await expect(row.locator("summary")).toContainText("aktiv");

  // Linksbündige Caption: links vom Text ist Hintergrund, in der Mitte nicht mehr nur Hintergrund.
  await captions(page).nth(1).fill("MMMMMM");
  const centred = await fingerprint(1);
  await page.locator("#capalign").selectOption("left");
  await expect.poll(() => fingerprint(1)).not.toBe(centred);
});

test("Projektdatei mit Tablet-Zielformat der Vorversion landet im Tablet-Satz", async ({ page }) => {
  await open(page);
  const shot = await png(page, "alt.png", { w: 1600, h: 2560 });
  const image = "data:image/png;base64," + shot.buffer.toString("base64");
  const old = {
    version: 4, settings: { preset: "1600x2560" }, locale: "de-DE", locales: ["de-DE"],
    texts: { "de-DE": { mTitle: "Tablet-App", mShort: "", mFull: "", mWhats: "", ftitle: "", fsub: "", alts: [] } },
    shots: [{ captions: { "de-DE": { headline: "Alt", sub: "" } }, image }, { captions: {}, image }],
  };
  await page.locator("#projfile").setInputFiles({ name: "tablet-projekt.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.locator("#projectname")).toHaveText("Tablet-App");
  await page.locator("#tab-shots").click();
  await expect(page.locator("#deviceset")).toHaveValue("tenInchScreenshots");
  await expect(page.locator("#preset")).toHaveValue("1080x1920");
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect(captions(page).nth(0)).toHaveValue("Alt");
  await page.locator("#deviceset").selectOption("phoneScreenshots");
  await expect(page.locator(".shotrow")).toHaveCount(0);
});

test("Sprachen: eigene Texte und Captions je Sprache, Export enthält alle", async ({ page }) => {
  await open(page);
  await addLogo(page);
  await addShots(page, 2);
  await captions(page).nth(0).fill("Alles im Blick");
  await fillTexts(page, { title: "Tagwerk", short: "Plane deinen Tag in Minuten.", full: "Deutsche Beschreibung." });

  await page.locator("#langmanage").click();
  await page.locator("#langadd").selectOption("en-US");
  await page.locator("#langaddbtn").click();
  await page.locator("#langclose").click();
  await expect(page.locator("#langswitch")).toHaveValue("en-US");
  await expect(page.locator("#textlang")).toHaveText("en-US");
  // Kopie als Vorlage — die Checkliste mahnt die Übersetzung an.
  await expect(page.locator("#mFull")).toHaveValue("Deutsche Beschreibung.");
  await page.locator("#tab-export").click();
  await expect(page.locator("#statuslist")).toContainText("Noch wortgleich mit de-DE");

  await fillTexts(page, { title: "Tagwerk", short: "Plan your day in minutes.", full: "English description." });
  await page.locator("#tab-shots").click();
  await captions(page).nth(0).fill("Everything at a glance");

  await page.locator("#langswitch").selectOption("de-DE");
  await expect(captions(page).nth(0)).toHaveValue("Alles im Blick");
  await page.locator("#tab-text").click();
  await expect(page.locator("#mShort")).toHaveValue("Plane deinen Tag in Minuten.");

  await page.locator("#tab-export").click();
  await expect(page.locator("#st-export")).toHaveText("bereit");
  const { name, files, zip } = await downloadZip(page, "#zipall");
  expect(name).toBe("play-listing-2-sprachen.zip");
  const base = "fastlane/metadata/android/";
  expect(await zip.file(base + "de-DE/short_description.txt").async("string")).toBe("Plane deinen Tag in Minuten.\n");
  expect(await zip.file(base + "en-US/short_description.txt").async("string")).toBe("Plan your day in minutes.\n");
  for (const locale of ["de-DE", "en-US"]) {
    for (const file of ["title.txt", "full_description.txt", "images/icon.png", "images/featureGraphic.jpg",
      "images/phoneScreenshots/1_screenshot.jpg", "images/phoneScreenshots/2_screenshot.jpg"]) {
      expect(files).toContain(base + locale + "/" + file);
    }
  }
  // Unterschiedliche Captions ergeben unterschiedliche Bilder.
  const de = await zip.file(base + "de-DE/images/phoneScreenshots/1_screenshot.jpg").async("nodebuffer");
  const en = await zip.file(base + "en-US/images/phoneScreenshots/1_screenshot.jpg").async("nodebuffer");
  expect(de.equals(en)).toBe(false);
  // Nach dem Export steht wieder die vorherige Sprache da.
  await expect(page.locator("#langswitch")).toHaveValue("de-DE");

  // Sprache entfernen
  page.once("dialog", (d) => d.accept());
  await page.locator("#langmanage").click();
  await page.getByRole("button", { name: "Englisch (USA) entfernen" }).click();
  await expect(page.locator("#langlist li")).toHaveCount(1);
});

test("Briefing: Auftrag enthält die Angaben, die Antwort füllt Texte und Captions", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  await page.locator("#tab-brief").click();
  await page.locator("#bWhat").fill("Erfasst Arbeitszeiten und schreibt daraus Rechnungen.");
  await page.locator("#bFeatures").fill("Zeiten per Fingertipp\nRechnung als PDF");
  await page.locator("#bKeywords").fill("Zeiterfassung");
  await page.locator(".noterow input").nth(0).fill("Startseite mit laufender Uhr");
  await expect(page.locator("#st-brief")).toHaveText("✓");

  const prompt = page.locator("#promptview");
  await expect(prompt).toContainText("Erfasst Arbeitszeiten", { useInnerText: false });
  await expect(prompt).toContainText("- Rechnung als PDF", { useInnerText: false });
  await expect(prompt).toContainText("1. Startseite mit laufender Uhr", { useInnerText: false });
  await expect(prompt).toContainText("2. (keine Angabe", { useInnerText: false });
  await expect(prompt).toContainText('"de-DE"', { useInnerText: false });

  // Unbrauchbare Antwort: verständliche Meldung, nichts ändert sich.
  await page.locator("#aiResult").fill("Gerne! Hier sind ein paar Ideen ohne JSON.");
  await page.locator("#aiApply").click();
  await expect(page.locator(".toast.error")).toContainText("kein JSON");

  const answer = "Hier der Eintrag:\n```json\n" + JSON.stringify({ listings: {
    "de-DE": {
      title: "Stundenwerk", titleAlternatives: ["Stundenwerk Zeiten", "Zeitwerk"],
      shortDescription: "Arbeitszeit erfassen und abrechnen.", fullDescription: "Erfasse deine Zeiten.\n\nFUNKTIONEN\n• Rechnung als PDF",
      whatsNew: "", featureSubtitle: "Zeiten erfassen, Rechnung fertig.",
      captions: [{ headline: "Zeit läuft mit", sub: "Ein Tipp genügt" }, { headline: "Rechnung fertig", sub: "" }],
    },
    "en-US": { title: "Stundenwerk", shortDescription: "Track hours and invoice.", fullDescription: "Track your hours.", captions: [{ headline: "Time runs along", sub: "" }] },
  } }) + "\n```";
  await page.locator("#aiResult").fill(answer);
  await page.locator("#aiApply").click();

  await expect(page.locator("#panel-text")).toBeVisible();
  await expect(page.locator("#mTitle")).toHaveValue("Stundenwerk");
  await expect(page.locator("#mShort")).toHaveValue("Arbeitszeit erfassen und abrechnen.");
  await expect(page.locator("#titlealts .altchip")).toHaveCount(2);
  await page.locator("#titlealts .altchip", { hasText: "Zeitwerk" }).click();
  await expect(page.locator("#mTitle")).toHaveValue("Zeitwerk");

  // Die zweite Sprache kam aus der Antwort dazu.
  await expect(page.locator("#langswitch option")).toHaveCount(2);
  await page.locator("#tab-shots").click();
  await expect(captions(page).nth(0)).toHaveValue("Zeit läuft mit");
  await expect(page.locator(".shotrow input.sub").nth(0)).toHaveValue("Ein Tipp genügt");
  await page.locator("#langswitch").selectOption("en-US");
  await expect(captions(page).nth(0)).toHaveValue("Time runs along");
  await page.locator("#tab-feat").click();
  await page.locator("#langswitch").selectOption("de-DE");
  await expect(page.locator("#fsub")).toHaveValue("Zeiten erfassen, Rechnung fertig.");

  // Ein Schritt zurück stellt den Stand vor den Vorschlägen wieder her —
  // das Briefing selbst bleibt stehen.
  // Der Klick auf die Namensalternative ist ein eigener Schritt.
  await settle(page);
  await page.locator("#tab-text").click();
  await page.locator("#undo").click();
  await expect(page.locator("#mTitle")).toHaveValue("Stundenwerk");
  await expect(page.locator("#mShort")).toHaveValue("Arbeitszeit erfassen und abrechnen.");
  await page.locator("#undo").click();
  await expect(page.locator("#mShort")).toHaveValue("");
  await expect(page.locator("#mTitle")).toHaveValue("");
  await page.locator("#tab-brief").click();
  await expect(page.locator("#bWhat")).toHaveValue("Erfasst Arbeitszeiten und schreibt daraus Rechnungen.");
  await expect(page.locator(".noterow input").nth(0)).toHaveValue("Startseite mit laufender Uhr");
});

test("Import: Fastlane-ZIP füllt die Texte aller Sprachen", async ({ page }) => {
  await open(page);
  const zip = new JSZip();
  const base = "repo/fastlane/metadata/android/";
  zip.file(base + "en-US/title.txt", "Dayworks\n");
  zip.file(base + "en-US/short_description.txt", "Plan your day.\n");
  zip.file(base + "en-US/full_description.txt", "Long text.\n");
  zip.file(base + "en-US/changelogs/12.txt", "Old notes\n");
  zip.file(base + "en-US/changelogs/40.txt", "Newest notes\n");
  zip.file(base + "fr-FR/title.txt", "Journée\n");
  zip.file(base + "README.txt", "kein Listing");
  await page.locator("#tab-text").click();
  await page.locator("#importzipfile").setInputFiles({ name: "listing.zip", mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) });

  await expect(page.locator(".toast")).toContainText("en-US, fr-FR");
  // Die leere Startsprache de-DE verschwindet, weil sie im Import nicht vorkommt.
  await expect(page.locator("#langswitch option")).toHaveCount(2);
  await expect(page.locator("#langswitch")).toHaveValue("en-US");
  await expect(page.locator("#mTitle")).toHaveValue("Dayworks");
  await expect(page.locator("#mWhats")).toHaveValue("Newest notes");
  await page.locator("#langswitch").selectOption("fr-FR");
  await expect(page.locator("#mTitle")).toHaveValue("Journée");
});

test("Autosave überlebt das Neuladen, Projektdatei stellt alles wieder her", async ({ page }) => {
  await open(page);
  await addLogo(page);
  await addShots(page, 2);
  await captions(page).nth(0).fill("Bleibt erhalten");
  await page.locator(".shotrow").nth(1).locator("summary").click();
  await page.locator(".shotrow").nth(1).locator(".shotopts select").selectOption("bleed");
  await page.locator("#tab-brief").click();
  await page.locator(".noterow input").nth(0).fill("Startseite");
  await page.locator("#tab-shots").click();
  await page.locator("#bg2").fill("#123456");
  await fillTexts(page);
  await expect(page.locator("#savestate")).toHaveText("Automatisch gespeichert");
  await settle(page);

  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await expect(page.locator("#savestate")).toHaveText("Letzter Stand wiederhergestellt");
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect(page.locator("#mTitle")).toHaveValue("Tagwerk");
  await expect(page.locator("#bg2")).toHaveValue("#123456");
  await expect(page.locator("#st-icon")).toHaveText("✓");
  // Angaben je Screenshot überleben das Wiederherstellen.
  await expect(page.locator(".noterow input").nth(0)).toHaveValue("Startseite");
  await expect(page.locator(".shotrow").nth(1).locator(".shotopts select")).toHaveValue("bleed");

  await page.locator("#projectbtn").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#projsave").click()]);
  expect(download.suggestedFilename()).toBe("tagwerk-projekt.json");
  const file = await download.path();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(data.version).toBe(4);
  expect(data.shots[0].image).toMatch(/^data:image\/png;base64,/);

  // „Neues Projekt“ verwirft nichts: das bisherige bleibt in der Liste.
  await page.locator("#projnew").click();
  await expect(page.locator("#projectdialog")).toBeHidden();
  await expect(page.locator("#projectname")).toHaveText("Neues Projekt");
  await expect(page.locator(".shotrow")).toHaveCount(0);
  await expect(page.locator("#mTitle")).toHaveValue("");
  await expect(page.locator("#bg2")).toHaveValue("#5b3df5");

  await page.locator("#projfile").setInputFiles(file);
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect(captions(page).nth(0)).toHaveValue("Bleibt erhalten");
  await expect(page.locator("#mTitle")).toHaveValue("Tagwerk");
  await expect(page.locator("#bg2")).toHaveValue("#123456");
  await expect(page.locator(".noterow input").nth(0)).toHaveValue("Startseite");
  await expect(page.locator(".shotrow").nth(1).locator(".shotopts select")).toHaveValue("bleed");
});

test("Projektdateien der Vorversion werden übernommen", async ({ page }) => {
  await open(page);
  const shot = await png(page, "alt.png");
  const old = {
    version: 3,
    settings: { mLocale: "en-US", mTitle: "Oldie", mShort: "Short text.", mFull: "Full text.", mWhats: "", ftitle: "Banner", fsub: "", layout: "angled", evil: "x" },
    shots: [{ headline: "Old caption", sub: "Old sub", image: "data:image/png;base64," + shot.buffer.toString("base64") }],
    logo: null,
  };
  await page.locator("#projfile").setInputFiles({ name: "alt-projekt.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.locator(".shotrow")).toHaveCount(1);
  await expect(page.locator("#langswitch")).toHaveValue("en-US");
  await expect(page.locator("#layout")).toHaveValue("angled");
  await page.locator("#tab-shots").click();
  await expect(captions(page).nth(0)).toHaveValue("Old caption");
  await page.locator("#tab-text").click();
  await expect(page.locator("#mTitle")).toHaveValue("Oldie");
  await page.locator("#tab-feat").click();
  await expect(page.locator("#ftitle")).toHaveValue("Banner");
});

test("Textprüfung meldet Verstöße mit Fundstelle", async ({ page }) => {
  await open(page);
  await fillTexts(page, { title: "Tagwerk 🚀", short: "Die BESTE App, jetzt kostenlos!!", full: "Text." });
  const lint = page.locator("#lintlist");
  await expect(lint).toContainText("Superlativ");
  await expect(lint).toContainText("Preis- oder Werbeaussage");
  await expect(lint).toContainText("Emoji im App-Namen");
  await expect(lint).toContainText("Gefunden in Kurzbeschreibung");
  await page.locator("#mTitle").fill("x".repeat(31));
  await expect(page.locator("#cTitle")).toHaveText("31 / 30");
  await expect(lint).toContainText("App-Name ist zu lang");

  // Andere Sprachen und die Zusatzfelder werden ebenfalls geprüft.
  await page.locator("#mTitle").fill("Tagwerk");
  await page.locator("#mShort").fill("La meilleure app, gratuite. Téléchargez !");
  await expect(lint).toContainText("meilleure");
  await expect(lint).toContainText("gratuite");
  await expect(lint).toContainText("Téléchargez");
  await page.locator("#mVideo").fill("https://vimeo.com/123");
  await expect(lint).toContainText("kein YouTube-Link");
  await page.locator("#mVersionCode").fill("1.2.0");
  await expect(lint).toContainText("Versionscode ist keine Zahl");
});

test("schmales Fenster: kein waagerechtes Scrollen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  for (const tab of ["icon", "shots", "brief", "text", "feat", "sim", "export"]) {
    await page.locator("#tab-" + tab).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), tab).toBe(true);
  }
});

test("läuft auch per Doppelklick von der Festplatte", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "file:// wird nur in Chromium geprüft.");
  await open(page, "file://" + path.resolve(__dirname, "..", "..", "docs", "index.html"));
  await addShots(page, 2);
  await expect(page.locator("#userbox")).toBeHidden();
  const { files } = await downloadZip(page, "#dlall");
  expect(files).toEqual(["screenshot-01.jpg", "screenshot-02.jpg"]);
});

test("Projekte: mehrere nebeneinander, wechseln, löschen — und nach dem Neuladen noch da", async ({ page }) => {
  await open(page);
  await expect(page.locator("#projectname")).toHaveText("Neues Projekt");

  // Ein leeres Projekt wird nicht vervielfacht.
  await page.locator("#projectbtn").click();
  await expect(page.locator("#projectlist li")).toHaveCount(1);
  await page.locator("#projnew").click();
  await expect(page.locator(".toast")).toContainText("noch leer");

  // Projekt A
  await addShots(page, 2);
  await captions(page).nth(0).fill("Caption A");
  await fillTexts(page, { title: "App A" });
  await page.locator("#mPackage").fill("de.beispiel.a");
  await expect(page.locator("#projectname")).toHaveText("App A");
  await settle(page);

  // Projekt B
  await page.locator("#projectbtn").click();
  await page.locator("#projnew").click();
  await expect(page.locator("#projectname")).toHaveText("Neues Projekt");
  await expect(page.locator(".shotrow")).toHaveCount(0);
  await expect(page.locator("#undo")).toBeDisabled();
  await fillTexts(page, { title: "App B", short: "Kurz B.", full: "Lang B." });
  await addShots(page, 3);
  await settle(page);

  await page.locator("#projectbtn").click();
  await expect(page.locator("#projectlist li")).toHaveCount(2);
  await expect(page.locator("#projectlist li.active")).toContainText("App B");
  await expect(page.locator("#projectlist li", { hasText: "App A" })).toContainText("de.beispiel.a · 2 Screenshots");

  // Zurück zu A: alles wieder da.
  await page.getByRole("button", { name: "App A öffnen" }).click();
  await expect(page.locator("#projectdialog")).toBeHidden();
  await expect(page.locator("#projectname")).toHaveText("App A");
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect(captions(page).nth(0)).toHaveValue("Caption A");
  await expect(page.locator("#mPackage")).toHaveValue("de.beispiel.a");
  await expect(page.locator("#mTitle")).toHaveValue("App A");

  // Das aktive Projekt und die Liste überleben das Neuladen.
  await settle(page);
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await expect(page.locator("#projectname")).toHaveText("App A");
  await page.locator("#projectbtn").click();
  await expect(page.locator("#projectlist li")).toHaveCount(2);

  // Das geöffnete Projekt löschen: die Werkbank wechselt zum verbliebenen.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "App A löschen" }).click();
  await expect(page.locator("#projectname")).toHaveText("App B");
  await expect(page.locator("#projectlist li")).toHaveCount(1);
  await expect(page.locator(".shotrow")).toHaveCount(3);
  await page.locator("#projclose").click();
  await page.locator("#tab-text").click();
  await expect(page.locator("#mShort")).toHaveValue("Kurz B.");
});

test("Stand aus der Zeit mit nur einem Projekt wird übernommen", async ({ page }) => {
  await open(page);
  // Ablage so herrichten, wie die Vorversion sie hinterlassen hat.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open("listing-werkbank", 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("project", "readwrite");
      tx.objectStore("project").clear();
      tx.objectStore("project").put({
        version: 4, settings: { mPackage: "de.alt.app" }, locale: "de-DE", locales: ["de-DE"],
        texts: { "de-DE": { mTitle: "Altbestand", mShort: "Kurz.", mFull: "Lang.", mWhats: "", ftitle: "", fsub: "", alts: [] } },
        shots: [], logo: null, featLogo: null, font: null,
      }, "current");
      tx.oncomplete = () => { req.result.close(); resolve(); };
    };
  }));
  await page.reload();
  await page.waitForSelector("html[data-ready]");
  await expect(page.locator("#projectname")).toHaveText("Altbestand");
  await expect(page.locator("#mPackage")).toHaveValue("de.alt.app");
  await page.locator("#projectbtn").click();
  await expect(page.locator("#projectlist li")).toHaveCount(1);
  expect(await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open("listing-werkbank", 1);
    req.onsuccess = () => {
      const get = req.result.transaction("project").objectStore("project").getAllKeys();
      get.onsuccess = () => resolve(get.result.map((k) => (k.startsWith("p:") ? "p:…" : k)).sort());
    };
  }))).toEqual(["meta", "p:…"]);
});

test("Aus Play laden: füllt die Texte aller Sprachen, Fehler bleiben verständlich", async ({ page }) => {
  await open(page);
  await page.locator("#tab-text").click();
  await expect(page.locator("#pullplay")).toBeVisible();

  // Ohne Paketnamen geht nichts an den Server.
  await page.locator("#pullplay").click();
  await expect(page.locator(".toast.error")).toContainText("Paketnamen");

  // Die Konsole meldet den 404 der unbekannten App — das ist hier gewollt.
  await page.locator("#mPackage").fill("de.beispiel.unbekannt");
  await page.locator("#pullplay").click();
  await expect(page.locator(".toast.error").last()).toContainText("Prüfe den Paketnamen");
  test.info().problems.length = 0;

  await page.locator("#mPackage").fill("de.beispiel.tagwerk");
  await page.locator("#pullplay").click();
  await expect(page.locator(".toast").last()).toContainText("aus Play geladen: de-DE, en-US");
  await expect(page.locator("#mTitle")).toHaveValue("Tagwerk");
  await expect(page.locator("#mFull")).toHaveValue("Der Eintrag aus dem Store.");
  await expect(page.locator("#langswitch option")).toHaveCount(2);
  await page.locator("#langswitch").selectOption("en-US");
  await expect(page.locator("#mTitle")).toHaveValue("Dayworks");
  await expect(page.locator("#projectname")).toHaveText("Dayworks");

  // Ein Schritt zurück stellt den Stand vor dem Abruf wieder her.
  await settle(page);
  await page.locator("#undo").click();
  await expect(page.locator("#langswitch option")).toHaveCount(1);
  await expect(page.locator("#mTitle")).toHaveValue("");
});

test("Tablet-Formate bekommen einen Tablet-Rahmen", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  // Rand des Geräts: beim Handy schmal und hoch, beim Tablet breiter und niedriger.
  const deviceBox = () => page.evaluate(() => {
    const canvas = document.querySelector("#sheet canvas");
    const probe = document.createElement("canvas");
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    // Dunkler Rahmen (#0C0F13) auf farbigem Hintergrund: erste und letzte Zeile mit Rahmenfarbe in der Bildmitte.
    const x = Math.round(canvas.width / 2), column = ctx.getImageData(x, 0, 1, canvas.height).data;
    let top = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y++) {
      const dark = column[y * 4] < 30 && column[y * 4 + 1] < 30 && column[y * 4 + 2] < 40;
      if (dark) { if (top < 0) top = y; bottom = y; }
    }
    return { height: (bottom - top) / canvas.height, width: canvas.width, canvasRatio: canvas.height / canvas.width };
  });
  const phone = await deviceBox();
  await page.locator("#deviceset").selectOption("tenInchScreenshots");
  await page.locator("#file").setInputFiles([await png(page, "t1.png", { w: 1600, h: 2560 }), await png(page, "t2.png", { w: 1600, h: 2560 })]);
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect.poll(async () => (await deviceBox()).width).toBe(1600);
  const tablet = await deviceBox();
  // Gerät bei 76 % Breite: Handy rund 2,17 × Breite hoch, Tablet 1,6 ×.
  expect(phone.height * phone.canvasRatio / 0.76).toBeGreaterThan(1.9);
  expect(tablet.height * tablet.canvasRatio / 0.76).toBeGreaterThan(1.5);
  expect(tablet.height * tablet.canvasRatio / 0.76).toBeLessThan(1.7);
});
