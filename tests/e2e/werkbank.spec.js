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

test("Tablet-Format landet im passenden Ordner", async ({ page }) => {
  await open(page);
  await addShots(page, 2);
  await page.locator("#preset").selectOption("1600x2560");
  await fillTexts(page);
  await page.locator("#tab-export").click();
  await expect(page.locator("#tree")).toContainText("tenInchScreenshots/");
  const { files } = await downloadZip(page, "#zipmeta");
  expect(files).toContain("fastlane/metadata/android/de-DE/images/tenInchScreenshots/1_screenshot.jpg");
  expect(files.some((f) => f.includes("phoneScreenshots"))).toBe(false);
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
  await settle(page);
  await page.locator("#undo").click();
  await page.locator("#tab-text").click();
  await expect(page.locator("#mShort")).toHaveValue("");
  await expect(page.locator("#mTitle")).toHaveValue("");
  await page.locator("#tab-brief").click();
  await expect(page.locator("#bWhat")).toHaveValue("Erfasst Arbeitszeiten und schreibt daraus Rechnungen.");
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

  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#projsave").click()]);
  expect(download.suggestedFilename()).toBe("tagwerk-projekt.json");
  const file = await download.path();
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(data.version).toBe(4);
  expect(data.shots[0].image).toMatch(/^data:image\/png;base64,/);

  page.once("dialog", (d) => d.accept());
  await page.locator("#projnew").click();
  await expect(page.locator(".shotrow")).toHaveCount(0);
  await expect(page.locator("#mTitle")).toHaveValue("");
  await expect(page.locator("#bg2")).toHaveValue("#5b3df5");

  await page.locator("#projfile").setInputFiles(file);
  await expect(page.locator(".shotrow")).toHaveCount(2);
  await expect(captions(page).nth(0)).toHaveValue("Bleibt erhalten");
  await expect(page.locator("#mTitle")).toHaveValue("Tagwerk");
  await expect(page.locator("#bg2")).toHaveValue("#123456");
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
  const { files } = await downloadZip(page, "#dlall");
  expect(files).toEqual(["screenshot-01.jpg", "screenshot-02.jpg"]);
});
