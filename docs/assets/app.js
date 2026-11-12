/* Listing-Werkbank — Programmlogik.
   Bewusst ein klassisches Skript ohne Module und ohne Build: so läuft die Seite
   auch per Doppelklick von der Festplatte (file://). */
(() => {
  "use strict";

  /* ================================================================== *
   * Konstanten
   * ================================================================== */

  const PALETTES = [
    ["#241B4D", "#5B3DF5"], ["#0B2027", "#1E7A6F"], ["#2A0E36", "#C2185B"],
    ["#12212E", "#2F6FED"], ["#3A1C0B", "#F2711C"], ["#F5F1EA", "#D9CFC0"],
    ["#101418", "#3A424C"],
  ];
  const RATIO = 19.5 / 9;
  const DENSITIES = [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]];
  const MAX_SHOTS = 8;
  const LIMITS = { mTitle: 30, mShort: 80, mFull: 4000, mWhats: 500 };
  const DARK_TEXT = "#131A24";
  const PROJECT_VERSION = 3;

  // Alles, was in Projektdatei und Autosave landet. Zugleich die Whitelist
  // beim Laden — eine fremde Datei darf keine beliebigen Elemente beschreiben.
  const SETTINGS = [
    "layout", "preset", "pano", "guides", "bg1", "bg2", "textcolor", "frame", "scale",
    "statusbar", "croptop", "headsize",
    "ftitle", "fsub", "falign", "fusericon", "fdevice", "fbg1", "fbg2", "ftextcolor",
    "ibg1", "ibg2", "izoom", "imono",
    "mLocale", "mPackage", "mDev", "mTitle", "mShort", "mFull", "mWhats",
  ];
  const REPAINT_SHOTS = new Set(["layout", "bg1", "bg2", "textcolor", "frame", "scale", "statusbar", "croptop", "headsize"]);
  const REBUILD_PLATES = new Set(["pano", "guides", "preset"]);

  const FONT_HEAD = "'Bricolage Grotesque','DM Sans',sans-serif";
  const FONT_BODY = "'DM Sans',sans-serif";

  /* ================================================================== *
   * Zustand und kleine Helfer
   * ================================================================== */

  // Ein Asset ist { blob, img, url }. Der Blob ist die unveränderte
  // Originaldatei — gespeichert wird immer sie, nie eine Neukodierung.
  const state = { shots: [], iconLogo: null, featLogo: null };
  let nextId = 1;

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    kids.flat().forEach((kid) => { if (kid != null) node.append(kid); });
    return node;
  }

  // Bündelt mehrere Aufrufe pro Frame zu einem einzigen.
  const scheduled = new Set();
  function schedule(fn) {
    if (scheduled.has(fn)) return;
    scheduled.add(fn);
    requestAnimationFrame(() => { scheduled.delete(fn); fn(); });
  }

  function toast(message, kind = "info") {
    const node = el("div", { class: "toast" + (kind === "error" ? " error" : ""), text: message });
    $("toasts").append(node);
    setTimeout(() => node.remove(), kind === "error" ? 7000 : 4000);
  }

  async function withBusy(button, task) {
    if (button.disabled) return;
    button.disabled = true;
    try { await task(); }
    catch (err) {
      console.error(err);
      toast("Das hat nicht geklappt: " + (err && err.message ? err.message : "unbekannter Fehler"), "error");
    }
    finally { button.disabled = false; }
  }

  /* ================================================================== *
   * Navigation
   * ================================================================== */

  const tabs = $$(".step");
  let activePanel = "icon";

  function activate(name, { focus = false } = {}) {
    const tab = tabs.find((t) => t.dataset.panel === name) || tabs[0];
    activePanel = tab.dataset.panel;
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
    $$(".panel").forEach((p) => { p.hidden = p.id !== "panel-" + activePanel; });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    try { history.replaceState(null, "", "#" + activePanel); } catch (_) { /* file:// in manchen Browsern */ }
    window.scrollTo(0, 0);
    refresh();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activate(tab.dataset.panel));
    tab.addEventListener("keydown", (e) => {
      const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      let target = null;
      if (move) target = tabs[(i + move + tabs.length) % tabs.length];
      else if (e.key === "Home") target = tabs[0];
      else if (e.key === "End") target = tabs[tabs.length - 1];
      if (!target) return;
      e.preventDefault();
      activate(target.dataset.panel, { focus: true });
    });
  });
  $("goexport").addEventListener("click", () => activate("export"));
  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (name && name !== activePanel) activate(name);
  });

  /* ================================================================== *
   * Bilder und Dateien
   * ================================================================== */

  function loadAsset(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        if (!img.width || !img.height) { URL.revokeObjectURL(url); reject(new Error("Bild ohne Abmessungen")); return; }
        resolve({ blob, img, url });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bild nicht lesbar")); };
      img.src = url;
    });
  }
  function releaseAsset(asset) { if (asset && asset.url) URL.revokeObjectURL(asset.url); }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  function dataUrlToBlob(url) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(url || ""));
    if (!m) throw new Error("Kein eingebettetes Bild");
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  function offscreen(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  function toBlob(canvas, type = "image/png", quality = 0.93) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Bild konnte nicht erzeugt werden"))), type, quality);
    });
  }
  function saveBlob(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function download(canvas, name, type) {
    saveBlob(await toBlob(canvas, type), name);
  }
  const hasZip = () => typeof window.JSZip !== "undefined";

  function wireDrop(zone, input, onFiles) {
    input.addEventListener("change", () => {
      if (input.files.length) onFiles(Array.from(input.files));
      input.value = "";
    });
    ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault(); zone.classList.add("hot");
    }));
    ["dragleave", "drop"].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault(); zone.classList.remove("hot");
    }));
    zone.addEventListener("drop", (e) => {
      e.stopPropagation();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) onFiles(files);
    });
  }
  const isRaster = (file) => /^image\/(png|jpeg|webp)$/.test(file.type);
  const isLogo = (file) => isRaster(file) || file.type === "image/svg+xml";

  /* ================================================================== *
   * Canvas-Helfer
   * ================================================================== */

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function drawContain(ctx, img, cx, cy, box) {
    const ratio = img.width / img.height;
    const w = ratio >= 1 ? box : box * ratio;
    const h = ratio >= 1 ? box / ratio : box;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }

  /* ================================================================== *
   * Farben
   * ================================================================== */

  function hex(r, g, b) {
    return "#" + [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("").toUpperCase();
  }
  function parseHex(value) {
    const m = /^#?([0-9a-f]{6})$/i.exec(value || "");
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrastRatio(a, b) {
    const l1 = luminance(parseHex(a)), l2 = luminance(parseHex(b));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function mix(h1, h2, t) {
    const a = parseHex(h1), b = parseHex(h2);
    return hex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }

  // Median-Cut wäre hier übertrieben: in 4-Bit-Töpfe sortieren, mitteln,
  // Papierweiß und Tiefschwarz verwerfen, dann nur Töpfe behalten, die im
  // RGB-Raum weit genug auseinanderliegen.
  function extractPalette(img, want) {
    const s = 72, ctx = offscreen(s, s).getContext("2d", { willReadFrequently: true });
    let data;
    try {
      ctx.drawImage(img, 0, 0, s, s);
      data = ctx.getImageData(0, 0, s, s).data;
    } catch (_) { return []; }
    const bins = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 130) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.min(r, g, b) > 242 || Math.max(r, g, b) < 16) continue;
      const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      const bin = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bin.n++; bin.r += r; bin.g += g; bin.b += b;
      bins.set(key, bin);
    }
    const sorted = Array.from(bins.values())
      .map((e) => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }))
      .sort((a, b) => b.n - a.n);
    const out = [];
    for (const e of sorted) {
      if (out.length >= want) break;
      const far = out.every((o) => Math.abs(o.r - e.r) + Math.abs(o.g - e.g) + Math.abs(o.b - e.b) > 96);
      if (far) out.push(e);
    }
    return out.map((e) => hex(e.r, e.g, e.b));
  }

  // Jede Farbgruppe: zwei Hintergrundfelder, optional Textfarbe und Kontrastanzeige.
  const COLOR_GROUPS = [
    { bg: ["bg1", "bg2"], text: "textcolor", badge: "contrast", swatches: "swatches", palette: "brandpalette", darken: 0.62, shots: true },
    { bg: ["fbg1", "fbg2"], text: "ftextcolor", badge: "fcontrast", swatches: "fswatches", palette: "fpalette", darken: 0.62 },
    { bg: ["ibg1", "ibg2"], swatches: "iswatches", palette: "ipalette", darken: 0.42 },
  ];
  const midBackground = (group) => mix($(group.bg[0]).value, $(group.bg[1]).value, 0.5);

  function autoTextColor(group) {
    if (!group.text) return;
    const bg = midBackground(group);
    $(group.text).value = contrastRatio("#FFFFFF", bg) >= contrastRatio(DARK_TEXT, bg) ? "#FFFFFF" : DARK_TEXT;
  }
  function setBackground(group, a, b) {
    $(group.bg[0]).value = a;
    $(group.bg[1]).value = b;
    autoTextColor(group);
    touch({ shots: !!group.shots });
  }
  function renderContrast(group) {
    if (!group.badge) return;
    const host = $(group.badge);
    const ratio = contrastRatio($(group.text).value, midBackground(group));
    const ok = ratio >= 4.5;
    host.className = "badge " + (ok ? "good" : "warn");
    host.replaceChildren(el("b", { text: ratio.toFixed(1) + ":1" }), ok ? "Text gut lesbar" : "Kontrast zu schwach");
    if (!ok) {
      host.append(el("button", {
        class: "linkbtn", type: "button", text: "Korrigieren",
        onclick: () => { autoTextColor(group); touch({ shots: !!group.shots }); },
      }));
    }
  }
  function buildSwatches() {
    COLOR_GROUPS.forEach((group) => {
      PALETTES.forEach(([a, b]) => {
        $(group.swatches).append(el("button", {
          class: "sw", type: "button",
          style: `background:linear-gradient(135deg,${a},${b})`,
          "aria-label": `Farbverlauf ${a} nach ${b}`, title: "Farbverlauf übernehmen",
          onclick: () => setBackground(group, a, b),
        }));
      });
    });
  }
  function renderPalettes() {
    const colours = state.iconLogo ? extractPalette(state.iconLogo.img, 5) : [];
    COLOR_GROUPS.forEach((group) => {
      const host = $(group.palette);
      host.replaceChildren();
      if (!colours.length) return;
      host.append(el("span", { class: "plabel", text: "Aus deinem Logo" }));
      colours.forEach((colour) => {
        host.append(el("button", {
          class: "chip", type: "button", "aria-label": `Farbe ${colour} übernehmen`,
          onclick: () => setBackground(group, mix(colour, "#000000", group.darken), colour),
        },
          el("span", { class: "fill", style: "background:" + colour }),
          el("span", { class: "hex", text: colour.slice(1) })
        ));
      });
    });
  }

  /* ================================================================== *
   * Gerät mit Statusleiste
   * ================================================================== */

  // Ersetzt die aufgenommene Statusleiste durch eine aufgeräumte: voller Akku,
  // voller Empfang, ruhige Uhrzeit. 14 % Akku im Store wirkt nachlässig.
  function drawStatusBar(ctx, x, y, w, h, dark) {
    const col = dark ? "rgba(16,20,26,.92)" : "rgba(255,255,255,.96)";
    ctx.save();
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const fs = h * 0.42, midY = y + h * 0.55;
    ctx.font = `500 ${fs}px ${FONT_BODY}`;
    ctx.fillText("9:41", x + w * 0.055, midY);
    // Empfang
    const bx = x + w * 0.79, bw = w * 0.011, gap = w * 0.007, base = midY + fs * 0.42;
    for (let i = 0; i < 4; i++) {
      const bh = fs * (0.3 + i * 0.19);
      ctx.fillRect(bx + i * (bw + gap), base - bh, bw, bh);
    }
    // WLAN
    const wx = x + w * 0.875, wy = midY + fs * 0.30;
    ctx.lineWidth = fs * 0.10;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(wx, wy, fs * (0.20 + k * 0.16), Math.PI * 1.25, Math.PI * 1.75);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(wx, wy, fs * 0.06, 0, Math.PI * 2); ctx.fill();
    // Akku
    const ex = x + w * 0.915, ew = w * 0.048, eh = fs * 0.52;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1, fs * 0.07);
    roundRect(ctx, ex, midY - eh / 2, ew, eh, eh * 0.28); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillRect(ex + ew * 0.09, midY - eh * 0.30, ew * 0.82, eh * 0.60);
    ctx.fillRect(ex + ew + fs * 0.03, midY - eh * 0.14, fs * 0.07, eh * 0.28);
    ctx.restore();
  }

  // Helligkeit des obersten Streifens — bestimmt, ob die Symbole hell oder
  // dunkel sein müssen. Pro Bild und Beschnitt gemerkt, weil jeder Repaint fragt.
  const lumCache = new WeakMap();
  function topLuminance(img, cropTop) {
    const cached = lumCache.get(img);
    if (cached && cached.crop === cropTop) return cached.value;
    let value = 0.5;
    try {
      const ctx = offscreen(24, 6).getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, img.height * cropTop, img.width, img.height * 0.04, 0, 0, 24, 6);
      const d = ctx.getImageData(0, 0, 24, 6).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      value = sum / (d.length / 4) / 255;
    } catch (_) { /* Vorgabewert bleibt */ }
    lumCache.set(img, { crop: cropTop, value });
    return value;
  }
  // Cover-Fit, aber ohne den obersten Streifen des Quellbilds.
  function drawScreen(ctx, img, x, y, w, h, cropTop) {
    const srcY = img.height * cropTop, srcH = img.height - srcY;
    const ir = img.width / srcH, tr = w / h;
    let sw, sh, sx;
    if (ir > tr) { sh = srcH; sw = sh * tr; sx = (img.width - sw) / 2; }
    else { sw = img.width; sh = sw / tr; sx = 0; }
    ctx.drawImage(img, sx, srcY, sw, sh, x, y, w, h);
  }

  function drawDevice(ctx, img, cx, cy, w, rot, style, framed) {
    const h = w * RATIO;
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    const x = -w / 2, y = -h / 2;
    const bezel = framed ? Math.max(5, w * 0.023) : 0;
    const outerR = w * 0.088;
    const innerR = framed ? Math.max(3, outerR - bezel * 0.7) : outerR * 0.75;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = w * 0.09; ctx.shadowOffsetY = w * 0.035;
    ctx.fillStyle = framed ? (style === "dark" ? "#0C0F13" : "#E9EBEE") : "#FFFFFF";
    roundRect(ctx, x, y, w, h, framed ? outerR : innerR); ctx.fill();
    ctx.restore();

    const sx = x + bezel, sy = y + bezel, sw = w - bezel * 2, sh = h - bezel * 2;
    ctx.save();
    roundRect(ctx, sx, sy, sw, sh, innerR); ctx.clip();
    ctx.fillStyle = "#FFF"; ctx.fillRect(sx, sy, sw, sh);
    const mode = $("statusbar").value;
    let crop = parseInt($("croptop").value, 10) / 100;
    if (mode !== "off") crop = Math.max(crop, 0.035);
    if (img) {
      drawScreen(ctx, img, sx, sy, sw, sh, crop);
      if (mode !== "off") {
        const dark = mode === "dark" || (mode === "auto" && topLuminance(img, crop) > 0.55);
        drawStatusBar(ctx, sx, sy, sw, sh * 0.038, dark);
      }
    }
    const sheen = ctx.createLinearGradient(sx, sy, sx + sw * 0.7, sy + sh * 0.45);
    sheen.addColorStop(0, "rgba(255,255,255,.11)"); sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen; ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();

    if (framed) {
      ctx.strokeStyle = style === "dark" ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.16)";
      ctx.lineWidth = Math.max(1, w * 0.0022);
      roundRect(ctx, x, y, w, h, outerR); ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,.82)";
      ctx.beginPath(); ctx.arc(0, y + bezel + w * 0.042, w * 0.016, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = style === "dark" ? "#23282F" : "#C9CDD3";
      roundRect(ctx, x + w, y + h * 0.20, w * 0.008, h * 0.075, w * 0.004); ctx.fill();
    }
    ctx.restore();
  }

  /* ================================================================== *
   * Screenshots
   * ================================================================== */

  function currentSize() {
    const [w, h] = $("preset").value.split("x").map(Number);
    return { w, h };
  }
  const shotDir = () => $("preset").selectedOptions[0].dataset.dir || "phoneScreenshots";
  const shotName = (i) => `screenshot-${String(i + 1).padStart(2, "0")}.jpg`;
  const isPano = () => $("pano").checked && state.shots.length > 1;

  function drawShot(canvas, i) {
    const shot = state.shots[i];
    if (!shot) return;
    const { w: W, h: H } = currentSize();
    const u = W / 1080, n = state.shots.length, pano = isPano();
    const bg1 = $("bg1").value, bg2 = $("bg2").value, textColor = $("textcolor").value;
    const frameStyle = $("frame").value, scale = parseInt($("scale").value, 10) / 100;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    if (pano) {
      const TW = W * n;
      ctx.save();
      ctx.translate(-i * W, 0);
      const g = ctx.createLinearGradient(0, 0, TW, H);
      g.addColorStop(0, bg1); g.addColorStop(1, bg2);
      ctx.fillStyle = g; ctx.fillRect(0, 0, TW, H);
      const glow = ctx.createRadialGradient(TW * 0.5, H * 0.28, 10, TW * 0.5, H * 0.28, TW * 0.42);
      glow.addColorStop(0, "rgba(255,255,255,.14)"); glow.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, TW, H);
      ctx.restore();
    } else {
      const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
      g.addColorStop(0, bg1); g.addColorStop(1, bg2);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    const headPx = parseInt($("headsize").value, 10) * u, subPx = headPx * 0.44, margin = 92 * u;
    const layout = pano ? "caption-top" : $("layout").value;
    const alignLeft = layout === "angled";
    const capTop = 118 * u;

    function paintCaption(baseY) {
      ctx.fillStyle = textColor;
      ctx.textAlign = alignLeft ? "left" : "center";
      ctx.textBaseline = "top";
      const maxW = W - margin * 2, x = alignLeft ? margin : W / 2;
      let y = baseY;
      ctx.font = `700 ${headPx}px ${FONT_HEAD}`;
      const lines = wrapLines(ctx, shot.headline, maxW), lineH = headPx * 1.16;
      lines.forEach((line, k) => ctx.fillText(line, x, y + k * lineH));
      y += lines.length * lineH;
      if (shot.sub) {
        ctx.globalAlpha = 0.78;
        ctx.font = `400 ${subPx}px ${FONT_BODY}`;
        if (lines.length) y += subPx * 0.42;
        const subLines = wrapLines(ctx, shot.sub, maxW * 0.92);
        subLines.forEach((line, k) => ctx.fillText(line, x, y + k * subPx * 1.3));
        y += subLines.length * subPx * 1.3;
        ctx.globalAlpha = 1;
      }
      return y - baseY;
    }

    const hasCaption = !!(shot.headline.trim() || shot.sub.trim());
    const capH = hasCaption && layout !== "caption-bottom" ? paintCaption(capTop) : 0;
    const top = capTop + capH + (hasCaption ? 78 * u : 0);
    const framed = layout !== "bare";
    let devW;

    if (pano) {
      devW = W * Math.min(scale, 0.82);
      const cx = W * 0.60, cy = top + devW * RATIO * 0.46;
      [-1, 0, 1].forEach((d) => {
        const neighbour = state.shots[i + d];
        if (neighbour) drawDevice(ctx, neighbour.img, cx + d * W, cy, devW, 0, frameStyle, framed);
      });
    } else if (layout === "bleed") {
      devW = W * Math.max(scale, 0.7);
      drawDevice(ctx, shot.img, W / 2, top + devW * RATIO * 0.46, devW, 0, frameStyle, framed);
    } else if (layout === "angled") {
      devW = W * Math.max(scale, 0.66);
      drawDevice(ctx, shot.img, W * 0.56, top + devW * RATIO * 0.44, devW, -7 * Math.PI / 180, frameStyle, framed);
    } else if (layout === "caption-bottom") {
      devW = Math.min(W * scale, (H - capTop - 300 * u) / RATIO);
      const cy = capTop + devW * RATIO / 2;
      drawDevice(ctx, shot.img, W / 2, cy, devW, 0, frameStyle, framed);
      if (hasCaption) paintCaption(cy + devW * RATIO / 2 + 70 * u);
    } else {
      devW = Math.min(W * scale, (H - top - 70 * u) / RATIO);
      drawDevice(ctx, shot.img, W / 2, top + devW * RATIO / 2, devW, 0, frameStyle, framed);
    }
  }

  function renderList() {
    const list = $("shotlist");
    list.replaceChildren();
    state.shots.forEach((shot, i) => {
      const no = i + 1;
      const tool = (label, title, onclick, cls = "") => el("button", {
        class: "iconbtn " + cls, type: "button", text: label, title,
        "aria-label": `${title} — Screenshot ${no}`, onclick,
      });
      list.append(el("li", { class: "shotrow" },
        el("img", { src: shot.url, alt: "" }),
        el("div", { class: "grow" },
          el("span", { class: "idx" }, String(no).padStart(2, "0"), i < 3 ? el("b", { text: " · in der Suche sichtbar" }) : null),
          el("input", {
            type: "text", value: shot.headline, placeholder: "Caption — der Nutzen, nicht der Screenname",
            "aria-label": `Caption für Screenshot ${no}`,
            oninput: (e) => { shot.headline = e.target.value; },
          }),
          el("input", {
            type: "text", class: "sub", value: shot.sub, placeholder: "Zweite Zeile (optional)",
            "aria-label": `Unterzeile für Screenshot ${no}`,
            oninput: (e) => { shot.sub = e.target.value; },
          })
        ),
        el("div", { class: "rowtools" },
          i > 0 ? tool("↑", "Nach vorn", () => moveShot(i, -1)) : null,
          i < state.shots.length - 1 ? tool("↓", "Nach hinten", () => moveShot(i, 1)) : null,
          tool("×", "Entfernen", () => removeShot(i), "del")
        )
      ));
    });
  }
  function moveShot(i, d) {
    const s = state.shots;
    [s[i], s[i + d]] = [s[i + d], s[i]];
    renderList();
    touch({ plates: true });
  }
  function removeShot(i) {
    releaseAsset(state.shots.splice(i, 1)[0]);
    renderList();
    touch({ plates: true });
  }

  function renderPlates() {
    const sheet = $("sheet"), n = state.shots.length, pano = isPano();
    sheet.className = "sheet" + (pano ? " pano" : "");
    $("stagelabel").textContent = !n ? "Vorschau"
      : `${n} von ${MAX_SHOTS} Screenshots` + (n < 2 ? " · mindestens 2 nötig" : n < 4 ? " · ab 4 Featuring-fähig" : "");
    if (!n) {
      sheet.replaceChildren(el("div", { class: "empty" },
        el("strong", { text: "Noch keine Screenshots" }),
        "Lade zwei bis acht Aufnahmen deiner App. Sie werden gerahmt, beschriftet und in Store-Auflösung ausgegeben.",
        el("div", {}, el("button", { class: "btn primary", type: "button", text: "Screenshots auswählen", onclick: () => $("file").click() }))
      ));
      renderSearchSim();
      return;
    }
    const { w, h } = currentSize(), guides = $("guides").checked;
    sheet.replaceChildren(...state.shots.map((shot, i) => {
      shot.canvas = el("canvas", { width: w, height: h });
      drawShot(shot.canvas, i);
      return el("div", { class: "plate shotplate" + (guides ? " showguides" : "") },
        el("div", { class: "ruler" }),
        el("span", { class: "dim", text: i === 0 || !pano ? `${w} × ${h}` : "↔" }),
        el("div", { class: "frameinner" }, shot.canvas, el("div", { class: "guides" })),
        el("div", { class: "cap" },
          el("span", { text: shotName(i) }),
          el("button", {
            class: "linkbtn", type: "button", text: "Laden", "aria-label": `Screenshot ${i + 1} herunterladen`,
            onclick: () => download(shot.canvas, shotName(i), "image/jpeg").catch((e) => toast(e.message, "error")),
          })
        )
      );
    }));
    renderSearchSim();
  }
  function repaintShots() {
    state.shots.forEach((shot, i) => { if (shot.canvas) drawShot(shot.canvas, i); });
    renderSearchSim();
    if (activePanel === "sim") renderStorePreview();
  }
  function scaledCopy(source, width) {
    const copy = offscreen(width, Math.round(width * source.height / source.width));
    copy.getContext("2d").drawImage(source, 0, 0, copy.width, copy.height);
    return copy;
  }
  function renderSearchSim() {
    $("searchsim").hidden = !state.shots.length;
    $("simshots").replaceChildren(...state.shots.slice(0, 3).filter((s) => s.canvas).map((s) => scaledCopy(s.canvas, 96)));
  }

  async function addShots(files) {
    let images = files.filter(isRaster);
    if (!images.length) { toast("Bitte PNG-, JPG- oder WebP-Dateien wählen.", "error"); return; }
    const room = MAX_SHOTS - state.shots.length;
    if (images.length > room) {
      toast(room > 0
        ? `Der Play Store nimmt höchstens ${MAX_SHOTS} Screenshots — nur die ersten ${room} wurden übernommen.`
        : `Es sind bereits ${MAX_SHOTS} Screenshots geladen. Entferne zuerst einen.`, "error");
      images = images.slice(0, Math.max(room, 0));
    }
    const results = await Promise.allSettled(images.map(loadAsset));
    const loaded = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (loaded.length < results.length) toast("Mindestens eine Datei ließ sich nicht als Bild lesen.", "error");
    if (!loaded.length) return;
    loaded.forEach((asset) => state.shots.push({ ...asset, id: nextId++, headline: "", sub: "", canvas: null }));
    renderList();
    touch({ plates: true });
  }

  async function downloadAllShots() {
    if (!state.shots.length) { toast("Lade zuerst mindestens einen Screenshot.", "error"); activate("shots"); return; }
    repaintShots();
    if (!hasZip()) {
      // Ohne ZIP-Bibliothek einzeln, mit Abstand — sonst blockt der Browser.
      for (let i = 0; i < state.shots.length; i++) {
        await download(state.shots[i].canvas, shotName(i), "image/jpeg");
        await new Promise((r) => setTimeout(r, 400));
      }
      return;
    }
    const zip = new window.JSZip();
    await Promise.all(state.shots.map(async (shot, i) => zip.file(shotName(i), await toBlob(shot.canvas, "image/jpeg"))));
    saveBlob(await zip.generateAsync({ type: "blob" }), "screenshots.zip");
  }

  /* ================================================================== *
   * Feature Graphic
   * ================================================================== */

  const featureTitle = () => $("ftitle").value.trim() || $("mTitle").value.trim();
  const featureSub = () => $("fsub").value.trim() || $("mShort").value.trim();
  const featureLogo = () => ($("fusericon").checked ? state.iconLogo : state.featLogo);

  function drawFeature() {
    const canvas = $("fcanvas"), ctx = canvas.getContext("2d"), W = 1024, H = 500, safe = 62;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, $("fbg1").value); g.addColorStop(1, $("fbg2").value);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    const title = featureTitle() || "Deine App", sub = featureSub();
    const asset = featureLogo(), logo = asset && asset.img, logoSize = 124;
    const showDevice = $("fdevice").checked && state.shots.length > 0;
    let textRight = W - safe;

    if (showDevice) {
      const glow = ctx.createRadialGradient(W * 0.80, H * 0.5, 10, W * 0.80, H * 0.5, H * 0.75);
      glow.addColorStop(0, "rgba(255,255,255,.13)"); glow.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
      drawDevice(ctx, state.shots[0].img, W * 0.80, H * 0.60, 190, -9 * Math.PI / 180, $("frame").value, true);
      textRight = W * 0.63;
    }
    ctx.textBaseline = "top";
    ctx.fillStyle = $("ftextcolor").value;
    const titleFont = (px) => `800 ${px}px ${FONT_HEAD}`, subFont = `400 26px ${FONT_BODY}`;

    if ($("falign").value === "center" && !showDevice) {
      const maxW = W - safe * 2;
      ctx.textAlign = "center";
      ctx.font = titleFont(60);
      const tl = wrapLines(ctx, title, maxW).slice(0, 2);
      ctx.font = subFont;
      const sl = wrapLines(ctx, sub, maxW).slice(0, 2);
      const blockH = (logo ? logoSize + 24 : 0) + tl.length * 68 + (sl.length ? 14 + sl.length * 35 : 0);
      let y = (H - blockH) / 2;
      if (logo) { drawContain(ctx, logo, W / 2, y + logoSize / 2, logoSize); y += logoSize + 24; }
      ctx.font = titleFont(60);
      tl.forEach((line, i) => ctx.fillText(line, W / 2, y + i * 68));
      ctx.globalAlpha = 0.82; ctx.font = subFont;
      sl.forEach((line, i) => ctx.fillText(line, W / 2, y + tl.length * 68 + 14 + i * 35));
    } else {
      let x = safe;
      ctx.textAlign = "left";
      if (logo) { drawContain(ctx, logo, x + logoSize / 2, H / 2, logoSize); x += logoSize + 38; }
      const maxW = textRight - x;
      ctx.font = titleFont(58);
      const tl = wrapLines(ctx, title, maxW).slice(0, 2);
      ctx.font = subFont;
      const sl = wrapLines(ctx, sub, maxW).slice(0, 2);
      const blockH = tl.length * 66 + (sl.length ? 14 + sl.length * 35 : 0), y = (H - blockH) / 2;
      ctx.font = titleFont(58);
      tl.forEach((line, i) => ctx.fillText(line, x, y + i * 66));
      ctx.globalAlpha = 0.82; ctx.font = subFont;
      sl.forEach((line, i) => ctx.fillText(line, x, y + tl.length * 66 + 14 + i * 35));
    }
    ctx.globalAlpha = 1;
  }

  /* ================================================================== *
   * Icon
   *
   * Adaptive Icons bestehen aus 108-dp-Ebenen, von denen der Launcher nur
   * die mittleren 72 dp zeigt. Sicher sichtbar ist ein Kreis mit 66 dp.
   * ================================================================== */

  const LAYER = 108, VIEWPORT = 72, SAFE = 66;
  const logoZoom = () => parseInt($("izoom").value, 10) / 100;

  function prepare(canvas, size) {
    if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, size, size);
    return ctx;
  }
  function iconBackground(ctx, size) {
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, $("ibg1").value); g.addColorStop(1, $("ibg2").value);
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  }
  function iconLogoOnLayer(ctx, size) {
    if (state.iconLogo) drawContain(ctx, state.iconLogo.img, size / 2, size / 2, size * (SAFE / LAYER) * logoZoom());
  }
  // Store-Icon: volles Quadrat, deckend, ohne Rundung — die macht Google.
  function drawStoreIcon(canvas, size) {
    const ctx = prepare(canvas, size);
    iconBackground(ctx, size);
    if (state.iconLogo) drawContain(ctx, state.iconLogo.img, size / 2, size / 2, size * 0.76 * logoZoom());
  }
  function drawForeground(canvas, size) { iconLogoOnLayer(prepare(canvas, size), size); }
  function drawBackgroundLayer(canvas, size) { iconBackground(prepare(canvas, size), size); }
  function drawMonochrome(canvas, size) {
    const ctx = prepare(canvas, size);
    if (!state.iconLogo) return;
    iconLogoOnLayer(ctx, size);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = $("imono").value;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = "source-over";
  }
  // Fertig maskiertes Icon, wie es der Launcher zeigt: `size` entspricht dem
  // 72-dp-Ausschnitt, die Ebenen ragen rundum darüber hinaus.
  function drawMasked(canvas, size, mask) {
    const ctx = prepare(canvas, size);
    const layer = size * LAYER / VIEWPORT, offset = (size - layer) / 2;
    ctx.save();
    if (mask === "circle") { ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); }
    else roundRect(ctx, 0, 0, size, size, size * (mask === "squircle" ? 0.32 : 0.17));
    ctx.clip();
    ctx.translate(offset, offset);
    iconBackground(ctx, layer);
    iconLogoOnLayer(ctx, layer);
    ctx.restore();
  }
  function drawIcons() {
    drawStoreIcon($("icStore"), 512);
    drawForeground($("icFg"), 432);
    drawMasked($("icCircle"), 288, "circle");
    drawMasked($("icSquircle"), 288, "squircle");
    drawMasked($("icRound"), 288, "round");
    drawMasked($("icSmall"), 96, "squircle");
    drawMonochrome($("icMono"), 288);
  }

  const adaptiveXml = () =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@mipmap/ic_launcher_background"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n' +
    '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n' +
    '</adaptive-icon>\n';

  async function addLauncherFiles(zip) {
    if (!state.iconLogo) return;
    const res = "android/app/src/main/res/";
    const jobs = [];
    const add = (path, draw, size, arg) => {
      const canvas = offscreen(size, size);
      draw(canvas, size, arg);
      jobs.push(toBlob(canvas).then((blob) => zip.file(path, blob)));
    };
    DENSITIES.forEach(([name, factor]) => {
      const dir = `${res}mipmap-${name}/`;
      const adaptive = Math.round(LAYER * factor), legacy = Math.round(48 * factor);
      add(dir + "ic_launcher_foreground.png", drawForeground, adaptive);
      add(dir + "ic_launcher_background.png", drawBackgroundLayer, adaptive);
      add(dir + "ic_launcher_monochrome.png", drawMonochrome, adaptive);
      // Für Android 7.1 und älter, die keine adaptiven Icons kennen.
      add(dir + "ic_launcher.png", drawMasked, legacy, "squircle");
      add(dir + "ic_launcher_round.png", drawMasked, legacy, "circle");
    });
    zip.file(res + "mipmap-anydpi-v26/ic_launcher.xml", adaptiveXml());
    zip.file(res + "mipmap-anydpi-v26/ic_launcher_round.xml", adaptiveXml());
    await Promise.all(jobs);
  }
  async function storeIconBlob() {
    const canvas = offscreen(512, 512);
    drawStoreIcon(canvas, 512);
    return toBlob(canvas);
  }
  function requireLogo() {
    if (state.iconLogo) return true;
    toast("Lade zuerst ein Logo.", "error");
    activate("icon");
    return false;
  }

  async function setLogo(slot, file) {
    if (!file || !isLogo(file)) { toast("Bitte eine PNG-, SVG-, JPG- oder WebP-Datei wählen.", "error"); return; }
    try {
      const asset = await loadAsset(file);
      releaseAsset(state[slot]);
      state[slot] = asset;
      if (slot === "iconLogo") renderPalettes();
      touch();
    } catch (_) { toast("Das Logo ließ sich nicht lesen. Nimm PNG oder SVG.", "error"); }
  }

  /* ================================================================== *
   * Texte und Prüfung
   * ================================================================== */

  const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
  const TEXT_FIELDS = { title: ["mTitle", "App-Name"], short: ["mShort", "Kurzbeschreibung"], full: ["mFull", "Beschreibung"] };
  const EMOJI = "\\p{Extended_Pictographic}\\uFE0F?";

  // `in` legt fest, in welchen Feldern eine Regel greift. Preisangaben und
  // Versalien sind in der langen Beschreibung unkritisch, im Titel nicht.
  const RULES = [
    { in: ["title", "short", "full"],
      re: /(?<!\p{L})(beste[rnms]?|best|nummer\s*1|nr\.?\s*1|#1|top[- ]?app|marktführer|weltweit führend|führende[rns]?)(?!\p{L})/giu,
      title: "Superlativ oder Ranking-Behauptung",
      note: "Play untersagt Behauptungen über Platzierungen und unbelegte Bestwerte im Eintrag." },
    { in: ["title", "short"],
      re: /(?<!\p{L})(kostenlos|gratis|umsonst|free|rabatt|sale|jetzt sparen|\d+\s*%\s*(rabatt|off))(?!\p{L})/giu,
      title: "Preis- oder Werbeaussage",
      note: "Preise und Aktionen gehören nicht in Name und Kurzbeschreibung — sie veralten und verstoßen gegen die Richtlinien." },
    { in: ["title", "short", "full"], re: /!{2,}/g,
      title: "Mehrfache Ausrufezeichen", note: "Wirkt wie Spam und bringt keinen Suchvorteil." },
    { in: ["title", "short"], re: /(?<!\p{L})\p{Lu}{5,}(?!\p{L})/gu,
      title: "Wort in Versalien", note: "Durchgehende Großschreibung wird bei der Prüfung beanstandet." },
    { in: ["title"], re: new RegExp(EMOJI, "gu"),
      title: "Emoji im App-Namen", note: "Emoji und Sonderzeichen ohne Bezug zur App sind im Titel nicht erlaubt." },
    { in: ["short", "full"], re: new RegExp(`(?:${EMOJI}\\s*){3,}`, "gu"),
      title: "Emoji-Kette", note: "Drei oder mehr Emoji hintereinander gelten als dekoratives Rauschen." },
    { in: ["title", "short"],
      re: /(?<!\p{L})(download|downloaden|installiere?n?\s+jetzt|jetzt\s+(herunterladen|installieren))(?!\p{L})/giu,
      title: "Handlungsaufforderung", note: "Der Installieren-Button steht direkt daneben — der Satz kostet nur Platz." },
  ];

  function lint() {
    const values = Object.fromEntries(Object.entries(TEXT_FIELDS).map(([key, [id]]) => [key, $(id).value]));
    const found = [];

    RULES.forEach((rule) => {
      const hits = [], where = [];
      rule.in.forEach((key) => {
        const matches = values[key].match(rule.re);
        if (!matches) return;
        where.push(TEXT_FIELDS[key][1]);
        matches.forEach((m) => { const t = m.trim(); if (t && !hits.includes(t)) hits.push(t); });
      });
      if (hits.length) found.push({ level: "warn", title: rule.title, note: rule.note, hits: hits.slice(0, 4), where });
    });

    // Keyword-Stapeln: ein Inhaltswort, das auffällig oft vorkommt.
    const freq = new Map();
    (values.full.toLowerCase().match(/\p{L}{5,}/gu) || []).forEach((w) => freq.set(w, (freq.get(w) || 0) + 1));
    const stuffed = Array.from(freq).filter(([, n]) => n >= 7);
    if (stuffed.length) {
      found.push({ level: "warn", title: "Mögliches Keyword-Stapeln",
        note: "Play wertet unnatürliche Wiederholungen ab. Formuliere die Stellen um.",
        hits: stuffed.slice(0, 4).map(([w, n]) => `${w} ×${n}`), where: ["Beschreibung"] });
    }
    Object.entries(LIMITS).forEach(([id, max]) => {
      const over = $(id).value.length - max;
      if (over > 0) {
        found.push({ level: "warn", title: `${document.querySelector(`label[for="${id}"]`).firstChild.textContent.trim()} ist zu lang`,
          note: `${over} Zeichen über dem Limit von ${max}. Die Console lehnt den Text so ab.` });
      }
    });
    if ((values.full.split(/\n\s*\n/)[0] || "").length > 165) {
      found.push({ level: "info", title: "Erster Absatz wird abgeschnitten",
        note: "Sichtbar sind etwa drei Zeilen. Das Versprechen sollte in die ersten rund 165 Zeichen passen." });
    }
    if (values.short.trim() && !/[.!?…]$/.test(values.short.trim())) {
      found.push({ level: "info", title: "Kurzbeschreibung ohne Satzzeichen",
        note: "Sie steht als eigener Satz unter dem Titel." });
    }

    const host = $("lintlist");
    if (!found.length) {
      const empty = !Object.values(values).join("").trim();
      host.replaceChildren(el("li", { class: empty ? "info" : "done" },
        el("span", { class: "mark", text: empty ? "·" : "✓" }),
        el("div", {}, empty ? "Noch keine Texte" : "Nichts auffällig",
          el("small", { text: empty ? "Sobald du schreibst, erscheinen hier Hinweise." : "Keine der geprüften Formulierungen gefunden." }))
      ));
      return;
    }
    host.replaceChildren(...found.map((f) => el("li", { class: f.level === "info" ? "info" : "" },
      el("span", { class: "mark", text: f.level === "info" ? "i" : "!" }),
      el("div", {}, f.title,
        el("small", { text: f.note }),
        f.hits ? el("small", {}, `Gefunden in ${f.where.join(", ")}: `, f.hits.flatMap((h) => [el("mark", { text: h }), " "])) : null)
    )));
  }

  function setPreviewText(node, value, placeholder) {
    node.textContent = value || placeholder;
    node.classList.toggle("placeholder", !value);
  }
  function syncText() {
    Object.entries(LIMITS).forEach(([id, max]) => {
      const counter = $("c" + id.slice(1)), n = $(id).value.length;
      counter.textContent = `${n} / ${max}`;
      counter.classList.toggle("over", n > max);
    });
    setPreviewText($("pvTitle"), $("mTitle").value.trim(), "App-Name");
    setPreviewText($("pvShort"), $("mShort").value.trim(), "Kurzbeschreibung");
    setPreviewText($("pvFull"), $("mFull").value.trim(), "Die ersten drei Zeilen deiner Beschreibung.");
    drawMasked($("pvIcon"), 112, "round");
    $("pkgerror").hidden = PACKAGE_RE.test($("mPackage").value.trim());
    lint();
  }

  $("mScaffold").addEventListener("click", () => {
    if ($("mFull").value.trim() && !confirm("Die vorhandene Beschreibung wird ersetzt. Fortfahren?")) return;
    $("mFull").value =
      "Was die App für dich tut, in zwei Sätzen. Diese Zeilen sind alles, was vor dem Antippen von „Mehr ansehen“ sichtbar ist.\n\n" +
      "DAS KANN SIE\n" +
      "• Funktion eins — der Nutzen, nicht die Technik\n" +
      "• Funktion zwei\n" +
      "• Funktion drei\n\n" +
      "FÜR WEN\n" +
      "Beschreibe die Situation, in der jemand nach so etwas sucht.\n\n" +
      "DATEN UND BERECHTIGUNGEN\n" +
      "Welche Daten die App braucht und warum. Deckungsgleich mit dem Data-Safety-Formular halten.\n\n" +
      "FRAGEN\n" +
      "kontakt@example.com";
    touch();
    $("mFull").focus();
  });

  /* ================================================================== *
   * Store-Vorschau
   * ================================================================== */

  function renderStorePreview() {
    drawMasked($("simIcon"), 192, "round");
    $("simTitle").textContent = $("mTitle").value.trim() || "App-Name";
    $("simDev").textContent = $("mDev").value.trim() || "Entwicklername";
    $("simShort").textContent = $("mShort").value.trim() || "Hier steht deine Kurzbeschreibung, bevor jemand „Mehr ansehen“ antippt.";
    const shots = state.shots.filter((s) => s.canvas);
    $("simRail").replaceChildren(...(shots.length
      ? shots.map((s) => scaledCopy(s.canvas, 236))
      : [el("p", { text: "Noch keine Screenshots — sie erscheinen hier als Galerie." })]));
  }

  /* ================================================================== *
   * Checkliste und Export
   * ================================================================== */

  const textOk = (id) => !!$(id).value.trim() && $(id).value.length <= LIMITS[id];

  function checks() {
    const n = state.shots.length;
    return [
      { ok: !!state.iconLogo, label: "App-Icon 512 × 512", note: "32-Bit-PNG, unter 1 MB, ohne vorgerundete Ecken.", go: "icon" },
      { ok: n >= 2, label: `Screenshots (${n} von ${MAX_SHOTS})`, note: "Mindestens 2, ab 4 im Hochformat Featuring-fähig.", go: "shots" },
      { ok: !!featureTitle(), label: "Feature Graphic 1024 × 500", note: "Immer erforderlich, auch ohne Vorschauvideo. Braucht einen Titel.", go: "feat" },
      { ok: textOk("mTitle"), label: "App-Name", note: "Höchstens 30 Zeichen.", go: "text" },
      { ok: textOk("mShort"), label: "Kurzbeschreibung", note: "Höchstens 80 Zeichen, steht unter dem Titel.", go: "text" },
      { ok: textOk("mFull"), label: "Vollständige Beschreibung", note: "Höchstens 4000 Zeichen.", go: "text" },
      { ok: null, label: "Datenschutzerklärung", note: "In der Play Console die URL hinterlegen." },
      { ok: null, label: "Data-Safety-Formular", note: "In der Play Console ausfüllen — passend zur Beschreibung und zum tatsächlichen Verhalten." },
      { ok: null, label: "Inhaltseinstufung", note: "In der Play Console den Fragebogen ausfüllen." },
    ];
  }
  function renderStatus() {
    $("statuslist").replaceChildren(...checks().map((c) => el("li", { class: c.ok === true ? "done" : c.ok === null ? "info" : "" },
      el("span", { class: "mark", text: c.ok === true ? "✓" : c.ok === null ? "→" : "!" }),
      el("div", {}, c.label, el("small", { text: c.note })),
      c.ok === false ? el("button", { class: "linkbtn", type: "button", text: "Öffnen", onclick: () => activate(c.go) }) : null
    )));
  }
  function setStep(id, label, done) {
    const node = $("st-" + id);
    node.textContent = label;
    node.classList.toggle("done", done);
  }
  function updateSteps() {
    const n = state.shots.length;
    const texts = ["mTitle", "mShort", "mFull"].filter(textOk).length;
    const open = checks().filter((c) => c.ok === false).length;
    setStep("icon", state.iconLogo ? "✓" : "fehlt", !!state.iconLogo);
    setStep("shots", `${n}/${MAX_SHOTS}`, n >= 2);
    setStep("feat", featureTitle() ? "✓" : "Titel fehlt", !!featureTitle());
    setStep("text", texts === 3 && $("mWhats").value.length <= LIMITS.mWhats ? "✓" : `${texts}/3`, texts === 3);
    setStep("export", open ? `${open} offen` : "bereit", !open);
  }

  const metaBase = () => `fastlane/metadata/android/${$("mLocale").value}/`;
  const publishCommand = () =>
    `node tools/play-publish/publish.js --package ${$("mPackage").value.trim() || "com.example.app"} --dry-run`;

  function renderTree() {
    const lines = [
      [`fastlane/metadata/android/${$("mLocale").value}/`, true],
      ["  title.txt"], ["  short_description.txt"], ["  full_description.txt"],
      ["  changelogs/default.txt"],
      ["  images/", true],
      ["    icon.png              512 × 512"],
      ["    featureGraphic.jpg    1024 × 500"],
      [`    ${shotDir()}/`, true],
      ["      1_screenshot.jpg … 8_screenshot.jpg"],
      ["android/app/src/main/res/", true],
      ["  mipmap-mdpi … mipmap-xxxhdpi/"],
      ["    ic_launcher.png · ic_launcher_round.png"],
      ["    ic_launcher_foreground.png"],
      ["    ic_launcher_background.png"],
      ["    ic_launcher_monochrome.png"],
      ["  mipmap-anydpi-v26/"],
      ["    ic_launcher.xml · ic_launcher_round.xml"],
    ];
    $("tree").replaceChildren(...lines.flatMap(([text, bold]) => [bold ? el("b", { text }) : text, "\n"]));
  }

  async function buildZip(full) {
    if (!hasZip()) { toast("Die ZIP-Bibliothek fehlt (assets/vendor/jszip.min.js). Lade die Assets einzeln.", "error"); return; }
    repaintShots();
    drawFeature();
    const zip = new window.JSZip(), base = metaBase(), jobs = [];
    const text = (path, id) => { const v = $(id).value.trim(); if (v) zip.file(base + path, v + "\n"); };
    text("title.txt", "mTitle");
    text("short_description.txt", "mShort");
    text("full_description.txt", "mFull");
    text("changelogs/default.txt", "mWhats");
    zip.file("LIESMICH.txt",
      "Play-Store-Paket aus der Listing-Werkbank\n\n" +
      "1. Den Ordner fastlane/ ins Wurzelverzeichnis deines Repos legen.\n" +
      "2. Prüfen, ohne etwas zu veröffentlichen:\n" +
      "   " + publishCommand() + "\n" +
      "3. Denselben Befehl ohne --dry-run ausführen, um zu veröffentlichen.\n" +
      "   Alternative: fastlane supply --skip_upload_apk\n" +
      (full ? "4. android/app/src/main/res/ in dein Android-Projekt übernehmen (Launcher-Icons).\n" : "") +
      "\nManuell in der Play Console bleiben: Datenschutz-URL, Data-Safety-Formular, Inhaltseinstufung.\n");

    if (state.iconLogo) jobs.push(storeIconBlob().then((b) => zip.file(base + "images/icon.png", b)));
    jobs.push(toBlob($("fcanvas"), "image/jpeg").then((b) => zip.file(base + "images/featureGraphic.jpg", b)));
    state.shots.forEach((shot, i) => {
      jobs.push(toBlob(shot.canvas, "image/jpeg").then((b) => zip.file(`${base}images/${shotDir()}/${i + 1}_screenshot.jpg`, b)));
    });
    if (full) jobs.push(addLauncherFiles(zip));
    await Promise.all(jobs);
    saveBlob(await zip.generateAsync({ type: "blob" }), `play-listing-${$("mLocale").value}.zip`);

    const open = checks().filter((c) => c.ok === false).map((c) => c.label.replace(/\s*\(.*\)$/, ""));
    toast(open.length ? "Exportiert. Noch offen: " + open.join(", ") + "." : "Paket exportiert — alles Nötige ist drin.");
  }

  /* ================================================================== *
   * Projekt: Autosave im Browser, Datei zum Mitnehmen
   * ================================================================== */

  const isCheckbox = (node) => node.type === "checkbox";
  function defaultOf(node) {
    if (isCheckbox(node)) return node.defaultChecked;
    if (node.tagName === "SELECT") {
      const preset = Array.from(node.options).find((o) => o.defaultSelected) || node.options[0];
      return preset.value;
    }
    return node.defaultValue;
  }
  const DEFAULTS = Object.fromEntries(SETTINGS.map((id) => [id, defaultOf($(id))]));

  function readSettings() {
    return Object.fromEntries(SETTINGS.map((id) => [id, isCheckbox($(id)) ? $(id).checked : $(id).value]));
  }
  function applySettings(settings) {
    SETTINGS.forEach((id) => {
      const value = settings && id in settings ? settings[id] : DEFAULTS[id];
      const node = $(id);
      if (isCheckbox(node)) node.checked = !!value;
      else {
        node.value = String(value);
        // Unbekannter Select-Wert aus einer fremden Datei: zurück zur Vorgabe.
        if (node.tagName === "SELECT" && node.selectedIndex < 0) node.value = DEFAULTS[id];
      }
    });
  }

  // Lokale Ablage. Blobs wandern unverändert in die IndexedDB.
  const local = {
    open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open("listing-werkbank", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("project");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async run(mode, action) {
      const db = await this.open();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction("project", mode);
          const req = action(tx.objectStore("project"));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    },
    load() { return this.run("readonly", (s) => s.get("current")); },
    save(value) { return this.run("readwrite", (s) => s.put(value, "current")); },
    clear() { return this.run("readwrite", (s) => s.delete("current")); },
  };

  function snapshot() {
    return {
      version: PROJECT_VERSION,
      settings: readSettings(),
      shots: state.shots.map((s) => ({ headline: s.headline, sub: s.sub, blob: s.blob })),
      logo: state.iconLogo ? state.iconLogo.blob : null,
      featLogo: state.featLogo ? state.featLogo.blob : null,
    };
  }
  async function restore(snap) {
    const shots = await Promise.all((snap.shots || []).slice(0, MAX_SHOTS).map(async (s) => ({
      ...(await loadAsset(s.blob)), id: nextId++, headline: String(s.headline || ""), sub: String(s.sub || ""), canvas: null,
    })));
    const iconLogo = snap.logo ? await loadAsset(snap.logo) : null;
    const featLogo = snap.featLogo ? await loadAsset(snap.featLogo) : null;
    // Erst wenn alles gelesen ist, den alten Stand ersetzen.
    [...state.shots, state.iconLogo, state.featLogo].forEach(releaseAsset);
    Object.assign(state, { shots, iconLogo, featLogo });
    applySettings(snap.settings);
    renderList();
    renderPlates();
    renderPalettes();
    refresh();
  }

  let saveTimer = 0, autosave = true;
  function setSaveState(text) { $("savestate").textContent = text; }
  function markDirty() {
    if (!autosave) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await local.save(snapshot()); setSaveState("Automatisch gespeichert"); }
      catch (err) {
        console.warn("Autosave fehlgeschlagen", err);
        autosave = false;
        setSaveState("Autosave nicht möglich — bitte „Sichern“ nutzen");
      }
    }, 600);
  }

  async function saveProjectFile() {
    const snap = snapshot();
    const data = {
      version: snap.version, saved: new Date().toISOString(), settings: snap.settings,
      shots: await Promise.all(snap.shots.map(async (s) => ({ headline: s.headline, sub: s.sub, image: await blobToDataUrl(s.blob) }))),
      logo: snap.logo ? await blobToDataUrl(snap.logo) : null,
      featLogo: snap.featLogo ? await blobToDataUrl(snap.featLogo) : null,
    };
    const slug = $("mTitle").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "listing";
    saveBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), slug + "-projekt.json");
    toast("Projektdatei gesichert.");
  }
  async function loadProjectFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || typeof data.settings !== "object") throw new Error("Kein Projekt");
      await restore({
        settings: data.settings,
        shots: (Array.isArray(data.shots) ? data.shots : []).map((s) => ({ headline: s.headline, sub: s.sub, blob: dataUrlToBlob(s.image) })),
        logo: data.logo ? dataUrlToBlob(data.logo) : null,
        featLogo: data.featLogo ? dataUrlToBlob(data.featLogo) : null,
      });
      markDirty();
      toast("Projekt geladen.");
    } catch (err) {
      console.error(err);
      toast("Die Datei ließ sich nicht lesen. Ist es eine mit diesem Tool gesicherte Projektdatei?", "error");
    }
  }
  async function newProject() {
    if (!confirm("Alle Bilder, Texte und Einstellungen verwerfen und leer anfangen?")) return;
    await restore({ settings: DEFAULTS, shots: [] });
    try { await local.clear(); } catch (_) { /* nichts gespeichert */ }
    setSaveState("");
    activate("icon");
  }

  /* ================================================================== *
   * Aktualisieren
   * ================================================================== */

  // Alles Leichte in einem Rutsch. Die großen Screenshot-Canvases laufen
  // getrennt über repaintShots, weil sie pro Frame mehrere Megapixel kosten.
  function refresh() {
    $$('input[type="range"]').forEach((range) => {
      $(range.id + "val").textContent = `${range.value} ${range.dataset.unit || ""}`.trim();
    });
    COLOR_GROUPS.forEach(renderContrast);

    const ownLogo = !$("fusericon").checked;
    $("flogofield").hidden = !ownLogo;
    $("flogoclear").hidden = !state.featLogo;
    $("flogodrop").classList.toggle("loaded", !!state.featLogo);
    $("flogodrop").querySelector("strong").textContent = state.featLogo ? "Eigenes Logo geladen — anderes wählen" : "Eigenes Logo auswählen";
    $("ilogodrop").classList.toggle("loaded", !!state.iconLogo);
    $("ilogodrop").querySelector("strong").textContent = state.iconLogo ? "Logo geladen — anderes wählen" : "Logo auswählen";

    drawIcons();
    drawFeature();
    syncText();
    if (activePanel === "sim") renderStorePreview();
    renderStatus();
    renderTree();
    $("nextcmd").textContent = publishCommand();
    updateSteps();
  }

  // Nach jeder Änderung aufrufen — egal ob durch Eingabe oder per Code.
  function touch({ shots = false, plates = false } = {}) {
    if (plates) renderPlates();
    else if (shots) schedule(repaintShots);
    schedule(refresh);
    markDirty();
  }

  function onEdit(e) {
    const target = e.target;
    if (!(target instanceof HTMLElement) || target.type === "file") return;
    const inRow = !!target.closest(".shotrow");
    if (!inRow && !SETTINGS.includes(target.id)) return;
    touch({
      plates: REBUILD_PLATES.has(target.id),
      // Der Rahmen bestimmt auch das Gerät in der Feature Graphic.
      shots: inRow || REPAINT_SHOTS.has(target.id),
    });
  }
  document.addEventListener("input", onEdit);
  document.addEventListener("change", onEdit);

  /* ================================================================== *
   * Verdrahtung
   * ================================================================== */

  wireDrop($("drop"), $("file"), addShots);
  wireDrop($("ilogodrop"), $("ilogo"), (files) => setLogo("iconLogo", files[0]));
  wireDrop($("flogodrop"), $("flogo"), (files) => setLogo("featLogo", files[0]));
  $("flogoclear").addEventListener("click", () => { releaseAsset(state.featLogo); state.featLogo = null; touch(); });

  // Dateien irgendwo fallen lassen: nie die Seite verlassen, und im
  // Screenshot-Schritt direkt übernehmen.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length && activePanel === "shots") addShots(files);
  });

  const onClick = (id, task) => $(id).addEventListener("click", (e) => withBusy(e.currentTarget, task));
  onClick("dlall", downloadAllShots);
  onClick("fdl", async () => { drawFeature(); await download($("fcanvas"), "featureGraphic.jpg", "image/jpeg"); });
  onClick("idlstore", async () => { if (requireLogo()) saveBlob(await storeIconBlob(), "icon.png"); });
  onClick("idlall", async () => {
    if (!requireLogo()) return;
    if (!hasZip()) { toast("Die ZIP-Bibliothek fehlt (assets/vendor/jszip.min.js).", "error"); return; }
    const zip = new window.JSZip();
    await addLauncherFiles(zip);
    zip.file("play/icon.png", await storeIconBlob());
    saveBlob(await zip.generateAsync({ type: "blob" }), "launcher-icons.zip");
  });
  onClick("zipall", () => buildZip(true));
  onClick("zipmeta", () => buildZip(false));
  onClick("projsave", saveProjectFile);
  onClick("projnew", newProject);
  $("projload").addEventListener("click", () => $("projfile").click());
  $("projfile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) loadProjectFile(file);
  });
  $("copycmd").addEventListener("click", async () => {
    const text = publishCommand();
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const range = document.createRange();
      range.selectNodeContents($("nextcmd"));
      const sel = getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      try { document.execCommand("copy"); } catch (_e) { toast("Bitte den markierten Befehl von Hand kopieren."); return; }
    }
    toast("Befehl kopiert.");
  });

  /* ================================================================== *
   * Start
   * ================================================================== */

  async function boot() {
    buildSwatches();
    // Canvas zeichnet nur mit Schriften, die schon geladen sind. Kurz warten,
    // aber nie hängen bleiben, falls eine Datei fehlt.
    const fonts = [`700 64px ${FONT_HEAD}`, `800 60px ${FONT_HEAD}`, `400 26px ${FONT_BODY}`, `500 26px ${FONT_BODY}`];
    if (document.fonts && document.fonts.load) {
      await Promise.race([
        Promise.all(fonts.map((f) => document.fonts.load(f))).catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    let saved = null;
    try { saved = await local.load(); }
    catch (_) { autosave = false; setSaveState("Autosave nicht möglich — bitte „Sichern“ nutzen"); }
    try {
      if (saved) { await restore(saved); setSaveState("Letzter Stand wiederhergestellt"); }
    } catch (err) {
      console.warn("Gespeicherter Stand unlesbar", err);
      saved = null;
    }
    if (!saved) { applySettings(DEFAULTS); renderPlates(); }
    activate(location.hash.slice(1) || "icon");
  }
  boot();
})();
