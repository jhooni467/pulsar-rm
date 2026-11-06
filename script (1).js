/* PULSAR RM 0.4a — Base estable + animaciones
   Módulos: Store (IndexedDB) · Settings · Library · Player · Router · UI · Lyrics (reservado)
   Todos los botones usan delegación de eventos: siguen funcionando aunque el HTML se vuelva a dibujar. */

"use strict";

const APP_VERSION = "0.6";
const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "weba"];

const $ = (id) => document.getElementById(id);

/* =========================================================
   STORE — guarda canciones en IndexedDB (persisten al recargar)
   Si IndexedDB no está disponible, usa memoria (se pierde al cerrar).
   ========================================================= */
const Store = {
  db: null,
  available: false,
  memory: { songs: new Map(), blobs: new Map(), settings: new Map(), nextId: 1 },

  open() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(false);
      let request;
      try {
        request = indexedDB.open("pulsar-rm", 1);
      } catch (error) {
        return resolve(false);
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("songs")) {
          db.createObjectStore("songs", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.available = true;
        resolve(true);
      };
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    });
  },

  _tx(stores, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      let output;
      tx.oncomplete = () => resolve(output);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transacción cancelada"));
      work(tx, (value) => { output = value; });
    });
  },

  getAllSongs() {
    if (!this.available) return Promise.resolve([...this.memory.songs.values()]);
    return this._tx("songs", "readonly", (tx, done) => {
      const request = tx.objectStore("songs").getAll();
      request.onsuccess = () => done(request.result);
    });
  },

  addSong(meta, blob) {
    if (!this.available) {
      meta.id = this.memory.nextId++;
      this.memory.songs.set(meta.id, meta);
      this.memory.blobs.set(meta.id, blob);
      return Promise.resolve(meta);
    }
    return this._tx(["songs", "blobs"], "readwrite", (tx, done) => {
      const request = tx.objectStore("songs").add(meta);
      request.onsuccess = () => {
        meta.id = request.result;
        tx.objectStore("blobs").put(blob, meta.id);
        done(meta);
      };
    });
  },

  updateSong(meta) {
    if (!this.available) {
      this.memory.songs.set(meta.id, meta);
      return Promise.resolve(meta);
    }
    return this._tx("songs", "readwrite", (tx, done) => {
      const request = tx.objectStore("songs").put(meta);
      request.onsuccess = () => done(meta);
    });
  },

  getBlob(id) {
    if (!this.available) return Promise.resolve(this.memory.blobs.get(id));
    return this._tx("blobs", "readonly", (tx, done) => {
      const request = tx.objectStore("blobs").get(id);
      request.onsuccess = () => done(request.result);
    });
  },

  removeSong(id) {
    if (!this.available) {
      this.memory.songs.delete(id);
      this.memory.blobs.delete(id);
      return Promise.resolve();
    }
    return this._tx(["songs", "blobs"], "readwrite", (tx) => {
      tx.objectStore("songs").delete(id);
      tx.objectStore("blobs").delete(id);
    });
  },

  clearAll() {
    if (!this.available) {
      this.memory.songs.clear();
      this.memory.blobs.clear();
      return Promise.resolve();
    }
    return this._tx(["songs", "blobs"], "readwrite", (tx) => {
      tx.objectStore("songs").clear();
      tx.objectStore("blobs").clear();
    });
  },

  getSetting(key) {
    if (!this.available) return Promise.resolve(this.memory.settings.get(key));
    return this._tx("settings", "readonly", (tx, done) => {
      const request = tx.objectStore("settings").get(key);
      request.onsuccess = () => done(request.result);
    });
  },

  setSetting(key, value) {
    if (!this.available) {
      this.memory.settings.set(key, value);
      return Promise.resolve();
    }
    return this._tx("settings", "readwrite", (tx) => {
      tx.objectStore("settings").put(value, key);
    });
  }
};

/* =========================================================
   SETTINGS — base para personalización futura (temas, colores…)
   ========================================================= */
/* Los colores completos de cada tema están en style.css; aquí solo lo necesario para la vista previa. */
const THEMES = [
  { id: "pulsar", name: "Pulsar", bg: "#080B16", surface: "#111827", accent: "#A18AFF", accentLight: "#6A45F5" },
  { id: "ocean", name: "Océano", bg: "#091218", surface: "#111F27", accent: "#3DC8FF", accentLight: "#0B7FB0" },
  { id: "sunset", name: "Atardecer", bg: "#180C09", surface: "#271611", accent: "#FF8A4C", accentLight: "#D4521A" },
  { id: "forest", name: "Bosque", bg: "#091811", surface: "#11271C", accent: "#4ADE80", accentLight: "#168040" },
  { id: "rose", name: "Rosa", bg: "#180911", surface: "#27111C", accent: "#FF6FB5", accentLight: "#D12C7C" },
  { id: "crimson", name: "Carmesí", bg: "#18090A", surface: "#271113", accent: "#FF4D5E", accentLight: "#CC2638" },
  { id: "gold", name: "Dorado", bg: "#181409", surface: "#272111", accent: "#F5C542", accentLight: "#9A7000" }
];

/* Modo de la app. "icon" = qué icono lleva (light = icono blanco, dark = icono negro). */
const MODES = [
  { id: "light", name: "Light", icon: "light" },
  { id: "dark", name: "Dark", icon: "dark" },
  { id: "amoled", name: "Amoled", icon: "dark" }
];

const Settings = {
  defaults: { theme: "pulsar", mode: "dark", eq: { enabled: false, preset: "flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
  values: {},

  async load() {
    this.values = { ...this.defaults };
    let modeSaved = false;
    for (const key of Object.keys(this.defaults)) {
      try {
        const saved = await Store.getSetting(key);
        if (saved !== undefined) {
          this.values[key] = saved;
          if (key === "mode") modeSaved = true;
        }
      } catch (error) {
        console.warn("No se pudo leer el ajuste", key, error);
      }
    }
    // Los antiguos temas "Claro" y "Medianoche" ahora son los modos Light y Amoled.
    const legacy = { light: "light", midnight: "amoled" };
    if (legacy[this.values.theme]) {
      if (!modeSaved) this.values.mode = legacy[this.values.theme];
      this.values.theme = "pulsar";
      try {
        await Store.setSetting("theme", this.values.theme);
        await Store.setSetting("mode", this.values.mode);
      } catch (error) { console.warn(error); }
    }
    this.apply();
  },

  async set(key, value) {
    this.values[key] = value;
    this.apply();
    try { await Store.setSetting(key, value); } catch (error) { console.warn(error); }
  },

  apply() {
    const theme = THEMES.find((item) => item.id === this.values.theme) || THEMES[0];
    const mode = MODES.find((item) => item.id === this.values.mode) || MODES[1];
    document.documentElement.setAttribute("data-theme", theme.id);
    document.documentElement.setAttribute("data-mode", mode.id);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", Themes.colors(theme, mode.id).bg); // color de la barra de estado de Android
    try {
      localStorage.setItem("pulsar-theme", theme.id); // se usan al abrir, para evitar parpadeo
      localStorage.setItem("pulsar-mode", mode.id);
    } catch (error) { /* sin almacenamiento local */ }
    Themes.refresh();
    AppMode.refresh();
    AppIcon.sync(mode);
  }
};

/* =========================================================
   LETRAS — lector de formatos
   Admite: LRC (línea por línea), LRC mejorado (palabra por palabra con <mm:ss.xx>),
   SRT, VTT (incluidas las marcas de palabra) y texto simple sin sincronizar.
   ========================================================= */
const LyricsParser = {
  LINE_STAMP: /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/,
  INLINE_SRC: "<(?:(\\d{1,2}):)?(\\d{1,3}):(\\d{2})(?:[.,:](\\d{1,3}))?>",
  CUE_TIME: "((?:\\d{1,2}:)?\\d{1,3}:\\d{2}[.,]\\d{1,3})",

  toSeconds(h, m, s, f) {
    return Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + (f ? parseFloat("0." + f) : 0);
  },

  parseCueTime(text) {
    const m = text.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})[.,](\d{1,3})$/);
    return m ? this.toSeconds(m[1], m[2], m[3], m[4]) : 0;
  },

  detect(raw) {
    if (/^\s*WEBVTT/i.test(raw)) return "vtt";
    const cue = raw.match(new RegExp(this.CUE_TIME + "\\s*-->\\s*" + this.CUE_TIME));
    if (cue) return cue[1].includes(",") ? "srt" : "vtt";
    if (/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(raw)) return "lrc";
    return "txt";
  },

  parse(raw) {
    const text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const format = this.detect(text);
    if (format === "lrc") return this.parseLRC(text);
    if (format === "srt" || format === "vtt") return this.parseCues(text, format);
    return this.parsePlain(text);
  },

  parsePlain(text) {
    const rows = text.split("\n").map((row) => row.trim());
    while (rows.length && !rows[rows.length - 1]) rows.pop();
    while (rows.length && !rows[0]) rows.shift();
    return {
      format: "txt", synced: false, wordLevel: false, metaOffset: 0, meta: {},
      lines: rows.map((row) => ({ t: null, text: row, words: null }))
    };
  },

  // Separa un texto con marcas <mm:ss.xx> en palabras con su tiempo.
  parseInline(body, start) {
    const re = new RegExp(this.INLINE_SRC, "g");
    const words = [];
    let current = null, last = 0, end = null, match;
    const push = (piece) => {
      if (piece) words.push({ t: current === null ? start : current, text: piece });
    };
    while ((match = re.exec(body)) !== null) {
      push(body.slice(last, match.index));
      current = this.toSeconds(match[1], match[2], match[3], match[4]);
      last = re.lastIndex;
    }
    if (current === null) return { text: body.trim(), words: null, end: null };

    const tail = body.slice(last);
    if (tail.trim() === "") end = current; // marca final = fin de la línea
    else push(tail);

    if (!words.length) return { text: "", words: null, end };
    words[0].text = words[0].text.replace(/^\s+/, "");
    words[words.length - 1].text = words[words.length - 1].text.replace(/\s+$/, "");
    const clean = words.filter((word) => word.text !== "");
    return { text: clean.map((word) => word.text).join("").trim(), words: clean, end };
  },

  parseLRC(text) {
    const lines = [], meta = {};
    let offset = 0, order = 0;
    text.split("\n").forEach((rawLine) => {
      let row = rawLine.trim();
      if (!row) return;

      const tag = row.match(/^\[([A-Za-z#]+):(.*)\]$/);
      if (tag) {
        const key = tag[1].toLowerCase();
        meta[key] = tag[2].trim();
        if (key === "offset") offset = parseInt(tag[2], 10) || 0;
        return;
      }

      const stamps = [];
      let match;
      while ((match = row.match(this.LINE_STAMP))) {
        stamps.push(this.toSeconds(0, match[1], match[2], match[3]));
        row = row.slice(match[0].length);
      }
      if (!stamps.length) return; // línea sin tiempo: no se muestra (sigue en el texto editable)

      const parsed = this.parseInline(row.trim(), stamps[0]);
      stamps.forEach((stamp) => {
        const delta = stamp - stamps[0];
        lines.push({
          t: stamp,
          order: order++,
          text: parsed.text,
          words: parsed.words ? parsed.words.map((word) => ({ t: word.t + delta, text: word.text })) : null,
          end: parsed.end === null ? null : parsed.end + delta
        });
      });
    });
    return this.finalize({ format: "lrc", synced: true, metaOffset: offset / 1000, meta }, lines);
  },

  parseCues(text, kind) {
    const timeRe = new RegExp(this.CUE_TIME + "\\s*-->\\s*" + this.CUE_TIME);
    const lines = [];
    let order = 0;
    text.split(/\n{2,}/).forEach((block) => {
      const rows = block.split("\n");
      const at = rows.findIndex((row) => timeRe.test(row));
      if (at < 0) return;
      const match = rows[at].match(timeRe);
      const start = this.parseCueTime(match[1]);
      const end = this.parseCueTime(match[2]);
      const body = rows.slice(at + 1).join(" ")
        .replace(/\{[^}]*\}/g, "")
        .replace(/<\/?(?:c|v|i|b|u|ruby|rt|lang)(?:\.[^>\s]*)?(?:\s[^>]*)?>/gi, "")
        .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        .replace(/\s+/g, " ").trim();
      if (!body) return;
      const parsed = this.parseInline(body, start);
      lines.push({ t: start, order: order++, text: parsed.text, words: parsed.words, end });
    });
    return this.finalize({ format: kind, synced: true, metaOffset: 0, meta: {} }, lines);
  },

  finalize(info, lines) {
    lines.sort((a, b) => (a.t - b.t) || (a.order - b.order));
    lines.forEach((line, i) => {
      const next = lines[i + 1];
      if (line.end === null || line.end === undefined || line.end <= line.t) {
        line.end = next ? Math.max(next.t, line.t + 0.1) : line.t + 5;
      }
      if (line.words) {
        line.words.forEach((word, j) => {
          const following = line.words[j + 1];
          word.end = following ? following.t : line.end;
          if (word.end <= word.t) word.end = word.t + 0.3;
        });
      }
    });
    return { ...info, lines, wordLevel: lines.some((line) => line.words) };
  },

  // Decodifica el archivo de letras: UTF-8, UTF-16 o Windows-1252 (archivos antiguos).
  decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(buffer);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(buffer);
    let text = new TextDecoder("utf-8").decode(buffer);
    if (text.includes("\uFFFD")) {
      try { text = new TextDecoder("windows-1252").decode(buffer); } catch (error) { /* se deja UTF-8 */ }
    }
    return text.replace(/^\uFEFF/, "");
  },

  stamp(seconds) {
    const t = Math.max(0, seconds);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor((t * 100) % 100);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(m)}:${pad(s)}.${pad(cs)}`;
  }
};

/* =========================================================
   THEMES — selector de temas en Ajustes
   ========================================================= */
/* Mezcla dos colores #RRGGBB: pct de "a" sobre "b" (igual que color-mix en style.css). */
function mixHex(a, b, pct) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const f = (x, y) => Math.round(x * pct + y * (1 - pct)).toString(16).padStart(2, "0");
  return "#" + f(ar, br) + f(ag, bg) + f(ab, bb);
}

const Themes = {
  // Colores de la vista previa y de la barra de estado de un tema en cada modo
  colors(theme, mode) {
    if (mode === "light") {
      return { bg: mixHex(theme.accentLight, "#F7F7FA", 0.05), surface: "#FFFFFF", accent: theme.accentLight };
    }
    if (mode === "amoled") {
      return { bg: "#000000", surface: mixHex(theme.accent, "#080808", 0.06), accent: theme.accent };
    }
    return { bg: theme.bg, surface: theme.surface, accent: theme.accent };
  },

  init() {
    const grid = $("theme-grid");
    if (!grid) return;
    grid.innerHTML = THEMES.map((theme) => `
      <button type="button" class="theme-swatch" role="radio" aria-checked="false" data-theme-id="${theme.id}"
              aria-label="Tema ${theme.name}">
        <span class="swatch">
          <span class="swatch-check" aria-hidden="true">✓</span>
        </span>
        <span>${theme.name}</span>
      </button>`).join("");
    this.refresh();
  },

  refresh() {
    const mode = Settings.values.mode || "dark";
    document.querySelectorAll(".theme-swatch").forEach((button) => {
      const theme = THEMES.find((item) => item.id === button.dataset.themeId);
      if (!theme) return;
      const c = this.colors(theme, mode);
      const swatch = button.querySelector(".swatch");
      if (swatch) {
        swatch.style.setProperty("--sw-bg", c.bg);
        swatch.style.setProperty("--sw-surface", c.surface);
        swatch.style.setProperty("--sw-accent", c.accent);
      }
      button.setAttribute("aria-checked", String(button.dataset.themeId === Settings.values.theme));
    });
  },

  select(id) {
    if (!THEMES.some((theme) => theme.id === id)) return;
    Settings.set("theme", id);
  }
};

/* =========================================================
   MODO DE LA APP — Light / Dark / Amoled (Ajustes)
   ========================================================= */
const AppMode = {
  refresh() {
    const current = Settings.values.mode || "dark";
    document.querySelectorAll(".mode-option").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.modeId === current));
    });
  },

  select(id) {
    if (!MODES.some((mode) => mode.id === id)) return;
    const before = MODES.find((mode) => mode.id === (Settings.values.mode || "dark"));
    const after = MODES.find((mode) => mode.id === id);
    Settings.set("mode", id);
    // En la app instalada (APK) el icono cambia al cerrarla
    if (before.icon !== after.icon && window.PulsarNative && typeof window.PulsarNative.setPendingIcon === "function") {
      UI.toast("El icono cambiará al cerrar la app");
    }
  }
};

/* =========================================================
   ICONO DE LA APP — Light = icono blanco · Dark y Amoled = icono negro
   - Pestaña del navegador / iOS: se cambia aquí mismo.
   - App Android (APK): avisa al código nativo, que aplica el icono al cerrar la app
     (ver android-icono.md). En una PWA instalada el icono del escritorio no se puede cambiar.
   ========================================================= */
const AppIcon = {
  sync(mode) {
    const variant = mode.icon;
    const favicon = document.getElementById("app-icon");
    const touch = document.getElementById("app-touch-icon");
    if (favicon) favicon.setAttribute("href", `icon-${variant}-192.png`);
    if (touch) touch.setAttribute("href", `icon-${variant}-192.png`);
    try {
      if (window.PulsarNative && typeof window.PulsarNative.setPendingIcon === "function") {
        window.PulsarNative.setPendingIcon(variant);
      }
    } catch (error) { console.warn("No se pudo avisar al icono nativo", error); }
  }
};

/* =========================================================
   LYRICS — letra de la canción actual (resaltado de línea y de palabra, desplazamiento automático)
   La letra se guarda tal cual (texto) en song.lyrics = { raw, delay, updatedAt }.
   ========================================================= */
const Lyrics = {
  song: null,
  data: null,
  delay: 0,
  active: -1,
  lineEls: [],
  wordEls: [],
  raf: 0,
  userScrollUntil: 0,
  needsCenter: false,
  saveTimer: 0,
  FORMAT_NAMES: { lrc: "LRC", srt: "SRT", vtt: "VTT", txt: "Texto" },

  init() {
    this.el = $("lyrics");
    this.bar = $("lyrics-bar");
    this.badge = $("lyrics-badge");
    this.delayEl = $("lyrics-delay");

    const pause = (event) => {
      if (event.target.closest && event.target.closest("button")) return; // tocar un botón no es desplazar
      this.userScrollUntil = Date.now() + 3500;
    };
    ["touchstart", "wheel", "pointerdown"].forEach((name) => this.el.addEventListener(name, pause, { passive: true }));

    const audio = Player.audio;
    audio.addEventListener("play", () => this.refresh(false));
    audio.addEventListener("pause", () => this.update(false));
    audio.addEventListener("seeked", () => this.update(false));
    audio.addEventListener("ended", () => this.update(false));
    document.addEventListener("visibilitychange", () => this.refresh(false));

    this.render();
  },

  load(song) {
    this.song = song || null;
    const lyrics = song && song.lyrics;
    this.delay = (lyrics && lyrics.delay) || 0;
    this.data = lyrics && lyrics.raw && lyrics.raw.trim() ? LyricsParser.parse(lyrics.raw) : null;
    this.active = -1;
    this.render();
    this.refresh(true);
  },

  clear() {
    this.song = null;
    this.data = null;
    this.delay = 0;
    this.active = -1;
    this.render();
  },

  shift() {
    return -((this.data && this.data.metaOffset) || 0) + this.delay;
  },

  visible() {
    return Boolean(this.el) && Router.current === "player" && Stage.mode === "lyrics";
  },

  shouldRun() {
    return this.visible() && this.data && this.data.synced && Player.currentId !== null &&
      !Player.audio.paused && !document.hidden;
  },

  // Se llama desde el reproductor en cada timeupdate.
  onTime() {
    if (!this.raf) this.update(false);
  },

  refresh(force) {
    if (!this.el) return;
    this.update(force);
    if (this.shouldRun()) this.startLoop();
  },

  startLoop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      if (!this.shouldRun()) return;
      this.update(false);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  /* ---------- Dibujo ---------- */

  render() {
    if (!this.el) return;
    const data = this.data;
    this.lineEls = [];
    this.wordEls = [];

    this.el.classList.toggle("is-empty", !data);
    this.bar.classList.toggle("no-data", !data);
    this.bar.classList.toggle("no-sync", !(data && data.synced));
    this.updateBar();

    if (!data) {
      this.el.innerHTML = this.song
        ? `<div class="lyrics-empty">
             <p>Esta canción todavía no tiene letra.</p>
             <div class="lyrics-empty-actions">
               <button type="button" class="chip-btn" data-action="lyrics-import">Importar archivo</button>
               <button type="button" class="chip-btn muted" data-action="lyrics-edit">Escribir letra</button>
             </div>
             <small>Formatos: LRC, LRC por palabras, SRT, VTT y texto.</small>
           </div>`
        : `<div class="lyrics-empty"><p>Reproduce una canción para ver su letra.</p></div>`;
      return;
    }

    this.el.innerHTML = data.lines.map((line, i) => {
      const seek = data.synced ? ` data-i="${i}"` : "";
      if (!line.text && !line.words) {
        return data.synced
          ? `<p class="lyric-line gap"${seek}>♪</p>`
          : `<p class="lyric-line plain gap">&nbsp;</p>`;
      }
      const inner = line.words
        ? line.words.map((word) => `<span class="lw">${UI.escapeHTML(word.text)}</span>`).join("")
        : UI.escapeHTML(line.text);
      return `<p class="lyric-line${data.synced ? "" : " plain"}"${seek}>${inner}</p>`;
    }).join("");
    this.lineEls = Array.from(this.el.querySelectorAll(".lyric-line"));
    this.el.scrollTop = 0;
  },

  updateBar() {
    const data = this.data;
    if (!data) this.badge.textContent = "Sin letra";
    else if (!data.synced) this.badge.textContent = "Texto sin sincronizar";
    else this.badge.textContent = `${this.FORMAT_NAMES[data.format] || "LRC"} · ${data.wordLevel ? "palabra por palabra" : "línea por línea"}`;
    const d = this.delay;
    this.delayEl.textContent = (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d).toFixed(2) + " s";
  },

  /* ---------- Sincronía ---------- */

  find(time) {
    const lines = this.data.lines;
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  },

  update(force) {
    const data = this.data;
    if (!data || !data.synced || !this.visible()) return;

    const time = Player.audio.currentTime - this.shift();
    const index = this.find(time);

    if (index !== this.active || force) {
      this.active = index;
      this.lineEls.forEach((el, i) => {
        el.classList.toggle("active", i === index);
        el.classList.toggle("past", i < index);
      });
      this.wordEls = index >= 0 && this.lineEls[index]
        ? Array.from(this.lineEls[index].querySelectorAll(".lw"))
        : [];
      this.center(index, force);
    }

    if (this.needsCenter && Date.now() >= this.userScrollUntil) this.center(this.active, false);

    if (index >= 0 && data.lines[index].words && this.wordEls.length) {
      const words = data.lines[index].words;
      this.wordEls.forEach((el, j) => {
        const w = words[j];
        if (!w) return;
        const p = Math.min(1, Math.max(0, (time - w.t) / (w.end - w.t)));
        const value = (p * 100).toFixed(1) + "%";
        if (el.dataset.p !== value) {
          el.dataset.p = value;
          el.style.setProperty("--p", value);
        }
      });
    }
  },

  center(index, instant) {
    if (index < 0 || !this.lineEls[index]) return;
    if (!instant && Date.now() < this.userScrollUntil) {
      this.needsCenter = true; // la persona está desplazando a mano: se recentra cuando termine la pausa
      return;
    }
    this.needsCenter = false;
    const line = this.lineEls[index];
    const top = line.offsetTop - (this.el.clientHeight - line.offsetHeight) / 2;
    const smooth = !instant && !UI.prefersReducedMotion();
    this.el.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  },

  seekToLine(index) {
    const line = this.data && this.data.lines[index];
    if (!line || Player.currentId === null) return;
    Player.audio.currentTime = Math.max(0, line.t + this.shift());
    this.userScrollUntil = 0;
    this.update(true);
    if (Player.audio.paused) Player.toggle();
    else this.refresh(false);
  },

  /* ---------- Ajuste de tiempo y guardado ---------- */

  adjustDelay(direction) {
    if (!this.song || !this.data || !this.data.synced) return;
    this.delay = Math.round(Math.min(30, Math.max(-30, this.delay + direction * 0.25)) * 100) / 100;
    this.song.lyrics.delay = this.delay;
    this.updateBar();
    this.userScrollUntil = 0;
    this.update(true);
    clearTimeout(this.saveTimer);
    const song = this.song;
    this.saveTimer = setTimeout(() => {
      Store.updateSong(song).catch((error) => console.warn("No se pudo guardar el ajuste:", error));
    }, 500);
  },

  async saveRaw(raw) {
    const song = this.song;
    if (!song) return false;
    const text = String(raw || "").replace(/\r\n?/g, "\n").trim();
    const previous = song.lyrics;
    song.lyrics = text ? { raw: text, delay: (previous && previous.delay) || 0, updatedAt: Date.now() } : null;
    try {
      await Store.updateSong(song);
    } catch (error) {
      console.error("No se pudo guardar la letra:", error);
      song.lyrics = previous;
      UI.toast(error && error.name === "QuotaExceededError"
        ? "No hay espacio suficiente para guardar la letra."
        : "No se pudo guardar la letra.");
      return false;
    }
    this.load(song);
    return true;
  },

  async readFile(file) {
    if (file.size > 2 * 1024 * 1024) throw new Error("El archivo es demasiado grande para ser una letra.");
    return LyricsParser.decode(await file.arrayBuffer());
  },

  // Importar desde el panel (sin editor abierto): se guarda directamente.
  async importFile(file) {
    try {
      const text = await this.readFile(file);
      if (!text.trim()) { UI.toast("El archivo está vacío."); return; }
      if (await this.saveRaw(text)) UI.toast("Letra importada: " + this.badge.textContent + ".");
    } catch (error) {
      console.error(error);
      UI.toast(error.message || "No se pudo leer el archivo de letras.");
    }
  }
};

/* =========================================================
   STAGE — zona central del reproductor: portada / letra / cola
   ========================================================= */
const Stage = {
  mode: "cover",

  init() {
    this.apply();
  },

  set(mode) {
    this.mode = this.mode === mode ? "cover" : mode; // tocar otra vez la pestaña vuelve a la portada
    this.apply();
  },

  apply() {
    $("stage").dataset.mode = this.mode;
    $("big-cover").classList.toggle("hidden", this.mode !== "cover");
    $("lyrics-panel").classList.toggle("hidden", this.mode !== "lyrics");
    $("queue-panel").classList.toggle("hidden", this.mode !== "queue");
    [["tab-lyrics", "lyrics"], ["tab-queue", "queue"]].forEach(([id, mode]) => {
      const button = $(id);
      button.classList.toggle("active", this.mode === mode);
      button.setAttribute("aria-pressed", String(this.mode === mode));
    });
    if (this.mode === "queue") Queue.render();
    Lyrics.refresh(true);
  }
};

/* =========================================================
   QUEUE — qué canción sigue (sigue el orden de la biblioteca)
   ========================================================= */
const Queue = {
  LIMIT: 100,

  refresh() {
    if (Stage.mode === "queue") this.render();
  },

  row(song, position, current) {
    const duration = song.duration ? UI.formatTime(song.duration) : "";
    return `
      <div class="song-item queue-item${current ? " playing" : ""}" data-song="${song.id}">
        <span class="queue-num">${current ? "▶" : position}</span>
        <div class="song-cover">${UI.coverHTML(song)}</div>
        <div class="song-details">
          <strong>${UI.escapeHTML(song.name || "Sin título")}</strong>
          <small>${UI.escapeHTML(song.artist)}</small>
        </div>
        <span class="queue-time">${duration}</span>
      </div>`;
  },

  render() {
    const list = $("queue-list");
    const songs = Library.songs;
    if (!songs.length) {
      list.innerHTML = `<p class="queue-empty">No hay canciones en la biblioteca.</p>`;
      return;
    }
    const current = Library.indexOf(Player.currentId);
    if (current < 0) {
      list.innerHTML = `<p class="queue-label">Elige una canción para empezar</p>` +
        songs.slice(0, this.LIMIT).map((song, i) => this.row(song, i + 1, false)).join("");
      return;
    }
    const upcoming = songs.slice(current + 1).concat(songs.slice(0, current));
    const shown = upcoming.slice(0, this.LIMIT);
    let html = `<p class="queue-label">Reproduciendo ahora</p>` + this.row(songs[current], 1, true);
    if (!upcoming.length) {
      html += `<p class="queue-empty">No hay más canciones: al terminar, esta se repite.</p>`;
    } else {
      html += `<p class="queue-label">A continuación · ${upcoming.length}</p>` +
        shown.map((song, i) => this.row(song, i + 1, false)).join("");
      if (upcoming.length > shown.length) {
        html += `<p class="queue-empty">… y ${upcoming.length - shown.length} más</p>`;
      }
    }
    list.innerHTML = html;
  }
};

/* =========================================================
   ECUALIZADOR — 10 bandas con Web Audio
   Solo se conecta al audio la primera vez que lo activas (así, mientras no lo uses,
   la reproducción es exactamente la de siempre). Al desactivarlo queda plano.
   ========================================================= */
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const EQ_MAX_DB = 12;
const EQ_PRESETS = [
  { id: "bass",   name: "Bajos",  gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { id: "vocal",  name: "Voces",  gains: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1] },
  { id: "treble", name: "Agudos", gains: [-1, -1, 0, 0, 0, 1, 3, 5, 6, 7] }
];
const EQ_FLAT = { id: "flat", name: "Plano", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

const Equalizer = {
  ctx: null,
  source: null,
  filters: [],
  preamp: null,
  limiter: null,
  ready: false,
  failed: false,
  applied: false,
  drag: null,
  saveTimer: 0,
  state: { enabled: false, preset: "flat", gains: new Array(10).fill(0) },

  init() {
    this.buildBands();
    Player.audio.addEventListener("play", () => this.resume());
    $("eq-enabled").addEventListener("change", (event) => this.setEnabled(event.target.checked));
    this.refreshUI();
  },

  loadSaved() {
    const saved = Settings.values.eq;
    if (saved && Array.isArray(saved.gains) && saved.gains.length === EQ_FREQS.length) {
      this.state.gains = saved.gains.map((g) => Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Number(g) || 0)));
      this.state.preset = this.matchPreset(); // se deduce de las barras, así nunca queda un nombre viejo
      this.state.enabled = Boolean(saved.enabled);
    }
    this.refreshUI();
  },

  /* ---------- Audio ---------- */

  ensureGraph() {
    if (this.ready) return true;
    if (this.failed) return false;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio no disponible");
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(Player.audio);
      const filters = EQ_FREQS.map((freq, i) => {
        const filter = ctx.createBiquadFilter();
        filter.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
        filter.frequency.value = freq;
        if (filter.type === "peaking") filter.Q.value = 1.1;
        filter.gain.value = 0;
        return filter;
      });
      const preamp = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor(); // protege de la saturación al subir graves
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;

      let node = source;
      filters.forEach((filter) => { node.connect(filter); node = filter; });
      node.connect(preamp);
      preamp.connect(limiter);
      limiter.connect(ctx.destination);

      ctx.onstatechange = () => {
        if (ctx.state === "suspended" && !Player.audio.paused) ctx.resume().catch(() => {});
      };
      Object.assign(this, { ctx, source, filters, preamp, limiter, ready: true });
      return true;
    } catch (error) {
      console.error("No se pudo crear el ecualizador:", error);
      this.failed = true;
      return false;
    }
  },

  resume() {
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  },

  // Se llama al empezar cada canción: si el ecualizador estaba activado, se reconecta.
  onPlay() {
    if (!this.state.enabled) return;
    if (this.ensureGraph()) {
      this.resume();
      this.apply();
    } else {
      this.state.enabled = false;
      this.refreshUI();
    }
  },

  apply() {
    if (!this.ready) return;
    const on = this.state.enabled;
    const now = this.ctx.currentTime;
    const instant = !this.applied; // la primera vez, de golpe: así no suena plano al principio
    this.applied = true;
    this.filters.forEach((filter, i) => {
      const target = on ? this.state.gains[i] : 0;
      if (instant) filter.gain.value = target;
      else filter.gain.setTargetAtTime(target, now, 0.02);
    });
    const boost = on ? Math.max(0, ...this.state.gains) : 0;
    // Baja un poco el volumen general según lo que se sube, para evitar distorsión.
    const level = Math.pow(10, -(boost * 0.7) / 20);
    if (instant) this.preamp.gain.value = level;
    else this.preamp.gain.setTargetAtTime(level, now, 0.03);
  },

  /* ---------- Cambios del usuario ---------- */

  setEnabled(on) {
    if (on) {
      if (!this.ensureGraph()) {
        this.state.enabled = false;
        this.refreshUI();
        UI.toast("Este navegador no permite usar el ecualizador.");
        return;
      }
      this.resume();
    }
    this.state.enabled = on;
    this.apply();
    this.refreshUI();
    this.saveSoon();
  },

  matchPreset() {
    const found = [...EQ_PRESETS, EQ_FLAT].find((preset) => preset.gains.every((g, i) => g === this.state.gains[i]));
    return found ? found.id : "custom";
  },

  setPreset(id) {
    const preset = [...EQ_PRESETS, EQ_FLAT].find((item) => item.id === id);
    if (!preset) return;
    this.state.gains = preset.gains.slice();
    this.state.preset = id;
    if (!this.state.enabled) this.setEnabled(true);
    else { this.apply(); this.refreshUI(); this.saveSoon(); }
    this.refreshUI();
  },

  setGain(index, db) {
    const value = Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Math.round(db * 2) / 2));
    if (this.state.gains[index] === value) return;
    this.state.gains[index] = value;
    this.state.preset = this.matchPreset();
    if (!this.state.enabled) { this.setEnabled(true); return; }
    this.apply();
    this.refreshUI();
    this.saveSoon();
  },

  reset() {
    this.setPreset("flat");
  },

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      Settings.set("eq", { enabled: this.state.enabled, preset: this.state.preset, gains: this.state.gains.slice() });
    }, 300);
  },

  /* ---------- Interfaz ---------- */

  buildBands() {
    $("eq-presets").innerHTML = EQ_PRESETS.map((preset) =>
      `<button type="button" class="eq-chip" data-preset="${preset.id}">${preset.name}</button>`
    ).join("");

    const wrap = $("eq-bands");
    wrap.innerHTML = EQ_FREQS.map((freq, i) => `
      <div class="eq-band">
        <span class="eq-db" id="eq-db-${i}">0</span>
        <div class="eq-track" role="slider" tabindex="0" data-band="${i}" aria-orientation="vertical"
             aria-label="${EQ_LABELS[i]} Hz" aria-valuemin="${-EQ_MAX_DB}" aria-valuemax="${EQ_MAX_DB}" aria-valuenow="0">
          <span class="eq-fill"></span><span class="eq-thumb"></span>
        </div>
        <span class="eq-hz">${EQ_LABELS[i]}</span>
      </div>`).join("");

    const dragTo = (event) => {
      const rect = this.drag.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      this.setGain(Number(this.drag.dataset.band), EQ_MAX_DB - ratio * 2 * EQ_MAX_DB);
    };
    wrap.addEventListener("pointerdown", (event) => {
      const track = event.target.closest(".eq-track");
      if (!track) return;
      this.drag = track;
      try { track.setPointerCapture(event.pointerId); } catch (error) { /* no crítico */ }
      event.preventDefault();
      dragTo(event);
    });
    wrap.addEventListener("pointermove", (event) => { if (this.drag) dragTo(event); });
    const end = () => { this.drag = null; };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);
    wrap.addEventListener("keydown", (event) => {
      const track = event.target.closest(".eq-track");
      if (!track) return;
      const i = Number(track.dataset.band);
      if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); this.setGain(i, this.state.gains[i] + 1); }
      if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); this.setGain(i, this.state.gains[i] - 1); }
    });
  },

  refreshUI() {
    const sheet = $("view-eq");
    if (!sheet) return;
    sheet.classList.toggle("off", !this.state.enabled);
    $("eq-enabled").checked = this.state.enabled;
    $("tab-eq").classList.toggle("on", this.state.enabled);

    this.state.gains.forEach((gain, i) => {
      const track = sheet.querySelector(`.eq-track[data-band="${i}"]`);
      if (!track) return;
      const pos = ((EQ_MAX_DB - gain) / (2 * EQ_MAX_DB)) * 100;
      track.querySelector(".eq-thumb").style.top = pos + "%";
      const fill = track.querySelector(".eq-fill");
      fill.style.top = Math.min(pos, 50) + "%";
      fill.style.height = Math.abs(pos - 50) + "%";
      track.setAttribute("aria-valuenow", String(gain));
      track.setAttribute("aria-valuetext", (gain > 0 ? "+" : "") + gain + " decibelios");
      $("eq-db-" + i).textContent = (gain > 0 ? "+" : "") + gain;
    });

    sheet.querySelectorAll("[data-preset]").forEach((button) => {
      button.classList.toggle("active", button.dataset.preset === this.state.preset);
    });
    $("eq-custom").classList.toggle("hidden", this.state.preset !== "custom");
  }
};

/* =========================================================
   EDITOR DE LETRAS — texto editable con herramientas de sincronía
   Se escribe en formato LRC: [mm:ss.xx]línea  ·  por palabras: [mm:ss.xx]<mm:ss.xx>pa<mm:ss.xx>la<mm:ss.xx>bra
   ========================================================= */
const LyricsEditor = {
  isOpen() {
    const sheet = $("lyrics-sheet");
    return Boolean(sheet) && !sheet.classList.contains("hidden");
  },

  init() {
    $("lyrics-file").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = ""; // permite volver a elegir el mismo archivo
      if (!file) return;
      if (this.isOpen()) this.importFile(file);
      else Lyrics.importFile(file);
    });
    Player.audio.addEventListener("timeupdate", () => { if (this.isOpen()) this.updateClock(); });
    Player.audio.addEventListener("seeked", () => { if (this.isOpen()) this.updateClock(); });
  },

  open() {
    const song = Library.byId(Player.currentId);
    if (!song) {
      UI.toast("Reproduce una canción para editar su letra.");
      return;
    }
    const area = $("lyrics-text");
    area.value = song.lyrics && song.lyrics.raw ? song.lyrics.raw : "";
    $("lyrics-sheet").classList.remove("hidden");
    document.body.classList.add("no-scroll");
    area.scrollTop = 0;
    area.setSelectionRange(0, 0);
    this.updateClock();
  },

  close() {
    const sheet = $("lyrics-sheet");
    if (!sheet || sheet.classList.contains("hidden")) return;
    sheet.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  },

  discard() {
    if (this.isOpen()) this.close();
  },

  updateClock() {
    $("lyrics-clock").textContent = LyricsParser.stamp(Player.audio.currentTime);
  },

  async save() {
    const raw = $("lyrics-text").value;
    if (await Lyrics.saveRaw(raw)) {
      this.close();
      UI.toast(raw.trim() ? "Letra guardada · " + Lyrics.badge.textContent + "." : "Letra eliminada.");
    }
  },

  async clearLyrics() {
    if (!confirm("¿Borrar la letra de esta canción?")) return;
    if (await Lyrics.saveRaw("")) {
      this.close();
      UI.toast("Letra eliminada.");
    }
  },

  async importFile(file) {
    try {
      const text = await Lyrics.readFile(file);
      if (!text.trim()) { UI.toast("El archivo está vacío."); return; }
      $("lyrics-text").value = text.replace(/\r\n?/g, "\n");
      $("lyrics-text").setSelectionRange(0, 0);
      UI.toast("Archivo cargado. Toca Guardar para aplicarlo.");
    } catch (error) {
      console.error(error);
      UI.toast(error.message || "No se pudo leer el archivo.");
    }
  },

  rewind() {
    Player.audio.currentTime = Math.max(0, Player.audio.currentTime - 3);
    this.updateClock();
  },

  scrollToLine(area, lineIndex) {
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 22;
    area.scrollTop = Math.max(0, lineIndex * lineHeight - area.clientHeight / 2 + lineHeight);
  },

  // Pone la marca de tiempo actual al inicio de la línea donde está el cursor y pasa a la siguiente.
  stampLine() {
    const area = $("lyrics-text");
    const text = area.value;
    const position = area.selectionStart;
    const lineStart = text.lastIndexOf("\n", position - 1) + 1;
    let lineEnd = text.indexOf("\n", position);
    if (lineEnd < 0) lineEnd = text.length;

    const stripped = text.slice(lineStart, lineEnd).replace(/^(?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+\s*/, "");
    const stamped = `[${LyricsParser.stamp(Player.audio.currentTime)}]${stripped}`;
    let value = text.slice(0, lineStart) + stamped + text.slice(lineEnd);

    let next = lineStart + stamped.length + 1;
    if (next > value.length) { value += "\n"; next = value.length; }
    area.value = value;
    area.setSelectionRange(next, next);
    this.scrollToLine(area, value.slice(0, next).split("\n").length - 1);
  },

  // Inserta una marca <mm:ss.xx> en el cursor, para sincronizar palabra por palabra.
  stampWord() {
    const area = $("lyrics-text");
    const marker = `<${LyricsParser.stamp(Player.audio.currentTime)}>`;
    area.setRangeText(marker, area.selectionStart, area.selectionEnd, "end");
  }
};

/* =========================================================
   COVERS — carátulas (se guardan como imagen pequeña dentro de cada canción)
   Cada carátula se convierte en una URL temporal que se reutiliza y se libera al cambiarla.
   ========================================================= */
const Covers = {
  urls: new Map(),

  get(song) {
    if (!song || !song.cover) return null;
    let url = this.urls.get(song.id);
    if (!url) {
      url = URL.createObjectURL(song.cover);
      this.urls.set(song.id, url);
    }
    return url;
  },

  release(id) {
    const url = this.urls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(id);
    }
  },

  releaseAll() {
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
  }
};

/* =========================================================
   LIBRARY — lista de canciones e importación
   ========================================================= */
const Library = {
  songs: [],
  importing: false,

  async load() {
    try {
      const saved = await Store.getAllSongs();
      this.songs = saved.sort((a, b) => (a.addedAt - b.addedAt) || (a.id - b.id));
    } catch (error) {
      console.error("No se pudo cargar la biblioteca:", error);
      this.songs = [];
      UI.toast("No se pudo cargar tu biblioteca guardada.");
    }
  },

  byId(id) {
    return this.songs.find((song) => song.id === id);
  },

  indexOf(id) {
    return this.songs.findIndex((song) => song.id === id);
  },

  isAudioFile(file) {
    // En Android, file.type a veces llega vacío (.flac, .m4a, .opus…): se valida también la extensión.
    if (file.type && file.type.startsWith("audio/")) return true;
    const extension = (file.name.split(".").pop() || "").toLowerCase();
    return AUDIO_EXTENSIONS.includes(extension);
  },

  readDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const probe = new Audio();
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        probe.removeAttribute("src");
        probe.load();
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(value) ? value : 0);
      };
      const timer = setTimeout(() => finish(0), 5000);
      probe.preload = "metadata";
      probe.onloadedmetadata = () => finish(probe.duration);
      probe.onerror = () => finish(0);
      probe.src = url;
    });
  },

  // "Artista - Título.mp3" → { title, artist }. Si no hay nombre, usa "Sin título".
  parseFileName(fileName) {
    const cleanName = String(fileName || "").replace(/\.[^/.]+$/, "");
    let title = cleanName.trim();
    let artist = "Archivo local";
    const parts = cleanName.split(" - ");
    if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(" - ").trim()) {
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    }
    return { title: title || "Sin título", artist: artist };
  },

  buildMeta(file, duration) {
    const parsed = this.parseFileName(file.name);
    return {
      name: parsed.title,
      artist: parsed.artist,
      fileName: file.name,
      mime: file.type || "",
      size: file.size,
      lastModified: file.lastModified,
      duration: duration,
      addedAt: Date.now(),
      lyrics: null,
      cover: null
    };
  },

  async importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (this.importing) {
      UI.toast("Ya hay una importación en curso.");
      return;
    }

    const valid = files.filter((file) => this.isAudioFile(file));
    const skipped = files.length - valid.length;
    if (!valid.length) {
      UI.toast("Ningún archivo parece ser de audio.");
      return;
    }

    this.importing = true;
    let added = 0, duplicates = 0, failed = 0, quotaError = false;

    for (let i = 0; i < valid.length; i++) {
      const file = valid[i];
      UI.toast(`Importando ${i + 1} de ${valid.length}…`, true);

      const isDuplicate = this.songs.some((song) =>
        song.fileName === file.name && song.size === file.size && song.lastModified === file.lastModified
      );
      if (isDuplicate) { duplicates++; continue; }

      try {
        const duration = await this.readDuration(file);
        const meta = this.buildMeta(file, duration);
        await Store.addSong(meta, file);
        this.songs.push(meta);
        added++;
      } catch (error) {
        console.error("Error al importar", file.name, error);
        failed++;
        if (error && error.name === "QuotaExceededError") { quotaError = true; break; }
      }
    }

    this.importing = false;
    UI.renderAll();

    const messages = [];
    if (added) messages.push(`${added} ${added === 1 ? "canción añadida" : "canciones añadidas"}`);
    if (duplicates) messages.push(`${duplicates} ya existían`);
    if (skipped) messages.push(`${skipped} ignorados (no son audio)`);
    if (failed) messages.push(quotaError ? "sin espacio suficiente" : `${failed} con error`);
    UI.toast(messages.join(" · ") || "No se añadió nada.");

    if (added) this.requestPersistence();
  },

  async requestPersistence() {
    // Pide a Android que no borre los datos del sitio cuando falte espacio.
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (error) { /* no es crítico */ }
  },

  async remove(id) {
    const song = this.byId(id);
    if (!song) return;
    if (!confirm(`¿Eliminar "${song.name}" de la biblioteca?`)) return;
    if (Player.currentId === id) Player.stop();
    try {
      await UI.animateOut(id);
      await Store.removeSong(id);
      this.songs = this.songs.filter((item) => item.id !== id);
      Covers.release(id);
      UI.renderAll();
    } catch (error) {
      console.error(error);
      UI.toast("No se pudo eliminar la canción.");
    }
  },

  async clear() {
    if (!this.songs.length) {
      UI.toast("La biblioteca ya está vacía.");
      return;
    }
    if (!confirm("¿Borrar toda la biblioteca? Esto no elimina tus archivos originales.")) return;
    Player.stop();
    try {
      await Store.clearAll();
      this.songs = [];
      Covers.releaseAll();
      UI.renderAll();
      UI.toast("Biblioteca borrada.");
    } catch (error) {
      console.error(error);
      UI.toast("No se pudo borrar la biblioteca.");
    }
  }
};

/* =========================================================
   PLAYER — reproducción
   ========================================================= */
const Player = {
  audio: new Audio(),
  currentId: null,
  objectUrl: null,
  seeking: false,
  loadToken: 0,

  init() {
    const audio = this.audio;
    audio.preload = "auto";

    audio.addEventListener("play", () => UI.updatePlayState());
    audio.addEventListener("pause", () => UI.updatePlayState());
    audio.addEventListener("timeupdate", () => {
      UI.updateProgress();
      Lyrics.onTime(audio.currentTime);
    });
    audio.addEventListener("loadedmetadata", () => UI.setDuration(audio.duration));
    audio.addEventListener("durationchange", () => UI.setDuration(audio.duration));
    audio.addEventListener("ended", () => this.handleEnded());
    audio.addEventListener("error", () => {
      if (!this.objectUrl) return;
      console.error("Error de audio:", audio.error);
      UI.toast("No se pudo reproducir este archivo. Puede que su formato no sea compatible.");
      UI.updatePlayState();
    });

    this.setupMediaSession();
  },

  async play(id) {
    const song = Library.byId(id);
    if (!song) return;

    const token = ++this.loadToken;
    let blob;
    try {
      blob = await Store.getBlob(id);
    } catch (error) {
      console.error(error);
    }
    if (token !== this.loadToken) return; // se pidió otra canción mientras cargaba
    if (!blob) {
      UI.toast("No se encontró el archivo de esta canción.");
      return;
    }

    const previousUrl = this.objectUrl;
    this.objectUrl = URL.createObjectURL(blob);
    this.currentId = id;
    this.audio.src = this.objectUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    Lyrics.load(song);
    UI.showNowPlaying(song);
    Queue.refresh();
    this.updateMediaMetadata(song);
    Equalizer.onPlay();

    try {
      await this.audio.play();
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("No se pudo reproducir:", error);
        UI.toast("No se pudo iniciar la reproducción.");
      }
    }
    UI.updatePlayState();
  },

  toggle() {
    if (this.currentId === null) {
      if (Library.songs.length) {
        this.play(Library.songs[0].id);
      } else {
        UI.toast("Importa música para empezar.");
      }
      return;
    }
    if (this.audio.paused) {
      this.audio.play().catch((error) => {
        if (error.name !== "AbortError") UI.toast("No se pudo reanudar la reproducción.");
      });
    } else {
      this.audio.pause();
    }
  },

  next() {
    if (!Library.songs.length) return;
    let index = Library.indexOf(this.currentId) + 1;
    if (index >= Library.songs.length) index = 0;
    this.play(Library.songs[index].id);
  },

  previous() {
    if (!Library.songs.length) return;
    if (this.currentId !== null && this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    let index = Library.indexOf(this.currentId) - 1;
    if (index < 0) index = Library.songs.length - 1;
    this.play(Library.songs[index].id);
  },

  handleEnded() {
    if (Library.songs.length <= 1) {
      this.audio.currentTime = 0;
      UI.updatePlayState();
      UI.updateProgress();
    } else {
      this.next();
    }
  },

  seekTo(fraction) {
    const duration = this.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      this.audio.currentTime = fraction * duration;
    }
  },

  stop() {
    this.loadToken++;
    const url = this.objectUrl;
    this.objectUrl = null;
    this.currentId = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (url) URL.revokeObjectURL(url);
    Lyrics.clear();
    UI.resetNowPlaying();
  },

  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (error) { /* no soportado */ }
    };
    set("play", () => this.toggle());
    set("pause", () => this.audio.pause());
    set("previoustrack", () => this.previous());
    set("nexttrack", () => this.next());
    set("seekto", (details) => {
      if (details && typeof details.seekTime === "number") this.audio.currentTime = details.seekTime;
    });
  },

  updateMediaMetadata(song) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    try {
      const art = Covers.get(song);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name,
        artist: song.artist,
        album: "Pulsar RM",
        artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : []
      });
    } catch (error) { /* no crítico */ }
  }
};

/* =========================================================
   ROUTER — navegación entre pantallas (usa #hash: el botón Atrás de Android funciona)
   ========================================================= */
const Router = {
  views: ["home", "library", "player", "eq", "settings"],
  current: "home",
  lastBase: "home", // última pantalla de la barra inferior (Inicio o Biblioteca): a ella se vuelve al cerrar Reproductor o Ajustes

  init() {
    window.addEventListener("hashchange", () => this.show(this.fromHash()));
    this.show(this.fromHash());
  },

  fromHash() {
    const name = location.hash.replace("#", "");
    return this.views.includes(name) ? name : "home";
  },

  go(name) {
    if (!this.views.includes(name)) return;
    if (name === this.current) {
      window.scrollTo(0, 0);
      return;
    }
    location.hash = name;
  },

  show(name) {
    this.current = name;
    if (name === "home" || name === "library") this.lastBase = name;
    Editor.discard();
    LyricsEditor.discard();
    UI.closeMenu();
    document.querySelectorAll(".settings").forEach((button) => {
      button.classList.toggle("selected", name === "settings");
    });
    document.querySelectorAll(".view").forEach((section) => {
      section.classList.toggle("active", section.dataset.viewName === name);
    });
    document.querySelectorAll(".nav-item").forEach((button) => {
      const active = button.dataset.view === name;
      button.classList.toggle("selected", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll(".view.active .song-list").forEach((list) => list.classList.add("animate"));
    window.scrollTo(0, 0);
    UI.updateMiniPlayer();
    if (name === "eq") Equalizer.refreshUI();
    Lyrics.refresh(true);
    if (name === "settings") UI.renderSettings();
  }
};

/* =========================================================
   UI — dibujo de pantallas, avisos y eventos
   ========================================================= */
const UI = {
  el: {},
  toastTimer: null,

  cache() {
    this.el = {
      fileInput: $("music-files"),
      songList: $("song-list"),
      recentList: $("recent-list"),
      recentSection: $("recent-section"),
      songCount: $("song-count"),
      search: $("search"),
      homeTitle: $("home-title"),
      homeText: $("home-text"),
      miniPlayer: $("mini-player"),
      miniTitle: $("mini-title"),
      miniArtist: $("mini-artist"),
      miniCover: $("mini-cover"),
      bigCover: $("big-cover"),
      playerMenu: $("player-menu"),
      playerMenuButton: $("player-menu-button"),
      editSheet: $("edit-sheet"),
      editCover: $("edit-cover"),
      editName: $("edit-name"),
      editArtist: $("edit-artist"),
      editFile: $("edit-file"),
      coverFile: $("cover-file"),
      playerTitle: $("player-title"),
      playerArtist: $("player-artist"),
      progress: $("progress"),
      currentTime: $("current-time"),
      duration: $("duration"),
      storageInfo: $("storage-info"),
      appVersion: $("app-version"),
      toast: $("toast")
    };
    this.el.appVersion.textContent = APP_VERSION;
  },

  bindEvents() {
    // Todos los botones con data-action / data-view / data-play, por delegación.
    document.addEventListener("click", (event) => {
      const target = event.target;

      // Cualquier toque fuera del menú ⋮ lo cierra
      if (!target.closest("#player-menu") && !target.closest("#player-menu-button")) this.closeMenu();

      const viewButton = target.closest("[data-view]");
      if (viewButton) {
        event.preventDefault();
        const wanted = viewButton.dataset.view;
        // El engranaje es un interruptor: abre Ajustes y, si ya estás en Ajustes, vuelve.
        if (wanted === "settings" && Router.current === "settings") Router.go(Router.lastBase);
        else Router.go(wanted);
        return;
      }

      const themeButton = target.closest("[data-theme-id]");
      if (themeButton) {
        event.preventDefault();
        Themes.select(themeButton.dataset.themeId);
        return;
      }

      const modeButton = target.closest("[data-mode-id]");
      if (modeButton) {
        event.preventDefault();
        AppMode.select(modeButton.dataset.modeId);
        return;
      }

      const presetButton = target.closest("[data-preset]");
      if (presetButton) {
        event.preventDefault();
        Equalizer.setPreset(presetButton.dataset.preset);
        return;
      }

      const lyricLine = target.closest(".lyric-line[data-i]");
      if (lyricLine) {
        Lyrics.seekToLine(Number(lyricLine.dataset.i));
        return;
      }

      const actionButton = target.closest("[data-action]");
      if (actionButton) {
        event.preventDefault();
        this.handleAction(actionButton.dataset.action);
        return;
      }

      const removeButton = target.closest("[data-remove]");
      if (removeButton) {
        event.stopPropagation();
        Library.remove(Number(removeButton.dataset.remove));
        return;
      }

      const songRow = target.closest("[data-song]");
      if (songRow) {
        const id = Number(songRow.dataset.song);
        if (id === Player.currentId) Player.toggle();
        else Player.play(id);
      }
    });

    this.el.fileInput.addEventListener("change", (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = ""; // permite volver a elegir los mismos archivos
      Library.importFiles(files);
    });

    this.el.coverFile.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) Editor.setCover(file);
    });

    [this.el.editName, this.el.editArtist].forEach((input) => {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          Editor.save();
        }
      });
    });

    this.el.search.addEventListener("input", () => {
      this.el.songList.classList.remove("animate"); // evita parpadeo mientras se escribe
      this.renderLibrary();
    });

    const progress = this.el.progress;
    progress.addEventListener("input", () => {
      Player.seeking = true;
      const duration = Player.audio.duration;
      if (Number.isFinite(duration)) {
        this.el.currentTime.textContent = this.formatTime((progress.value / 1000) * duration);
      }
    });
    progress.addEventListener("change", () => {
      Player.seekTo(progress.value / 1000);
      Player.seeking = false;
    });
  },

  handleAction(action) {
    switch (action) {
      case "import": this.el.fileInput.click(); break;
      case "toggle": Player.toggle(); break;
      case "next": Player.next(); break;
      case "prev": Player.previous(); break;
      case "clear": Library.clear(); break;
      case "close": Router.go(Router.lastBase); break;
      case "menu": this.toggleMenu(); break;
      case "edit": this.closeMenu(); Editor.open(); break;
      case "edit-cancel": Editor.close(); break;
      case "edit-save": Editor.save(); break;
      case "edit-pick-image": this.el.coverFile.click(); break;
      case "edit-remove-image": Editor.removeCover(); break;
      case "edit-reset": Editor.resetFromFile(); break;
      case "stage-lyrics": Stage.set("lyrics"); break;
      case "stage-queue": Stage.set("queue"); break;
      case "eq-open": Router.go("eq"); break;
      case "eq-back": Router.go("player"); break;
      case "eq-reset": Equalizer.reset(); break;
      case "lyrics-edit": LyricsEditor.open(); break;
      case "lyrics-import": this.el.lyricsFile ? this.el.lyricsFile.click() : $("lyrics-file").click(); break;
      case "lyrics-save": LyricsEditor.save(); break;
      case "lyrics-cancel": LyricsEditor.close(); break;
      case "lyrics-clear": LyricsEditor.clearLyrics(); break;
      case "lyrics-back": LyricsEditor.rewind(); break;
      case "lyrics-stamp-line": LyricsEditor.stampLine(); break;
      case "lyrics-stamp-word": LyricsEditor.stampWord(); break;
      case "lyrics-earlier": Lyrics.adjustDelay(-1); break;
      case "lyrics-later": Lyrics.adjustDelay(1); break;
    }
  },

  /* ---------- Dibujo ---------- */

  renderAll() {
    Queue.refresh();
    this.el.songList.classList.add("animate");
    this.el.recentList.classList.add("animate");
    this.renderHome();
    this.renderLibrary();
    this.updateCount();
    this.markPlaying();
    this.updateMiniPlayer();
    if (Router.current === "settings") this.renderSettings();
  },

  songRow(song, index = 0) {
    const delay = Math.min(index, 10); // máximo 10 pasos para que nunca se sienta lento
    const duration = song.duration ? ` · ${this.formatTime(song.duration)}` : "";
    return `
      <div class="song-item" data-song="${song.id}" style="--i:${delay}">
        <div class="song-cover">${this.coverHTML(song)}</div>
        <div class="song-details">
          <strong>${this.escapeHTML(song.name || "Sin título")}</strong>
          <small>${this.escapeHTML(song.artist)}${duration}</small>
        </div>
        <button type="button" data-song-play="${song.id}" aria-label="Reproducir">▶</button>
        <button type="button" class="remove" data-remove="${song.id}" aria-label="Eliminar">✕</button>
      </div>`;
  },

  emptyState(searching) {
    return `
      <div class="empty">
        <div class="empty-icon">♫</div>
        <h3>${searching ? "No encontramos canciones" : "Tu música te espera"}</h3>
        <p>${searching ? "Prueba con otro nombre." : "Importa tus archivos de audio<br>para comenzar."}</p>
        ${searching ? "" : '<button type="button" class="add-music" data-action="import">+ Importar música</button>'}
      </div>`;
  },

  renderHome() {
    const total = Library.songs.length;
    if (total === 0) {
      this.el.homeTitle.textContent = "Tu música te espera";
      this.el.homeText.innerHTML = "Importa tus archivos de audio<br>y comienza tu universo.";
    } else {
      this.el.homeTitle.textContent = `${total} ${total === 1 ? "canción" : "canciones"} en tu biblioteca`;
      this.el.homeText.innerHTML = "Importa más música cuando quieras.";
    }
    const recent = Library.songs.slice(-3).reverse();
    this.el.recentSection.classList.toggle("hidden", recent.length === 0);
    this.el.recentList.innerHTML = recent.map((song, i) => this.songRow(song, i)).join("");
  },

  renderLibrary() {
    const query = this.el.search.value.trim().toLowerCase();
    const filtered = Library.songs.filter((song) =>
      !query || song.name.toLowerCase().includes(query) || song.artist.toLowerCase().includes(query)
    );
    if (!filtered.length) {
      this.el.songList.innerHTML = this.emptyState(Boolean(query));
    } else {
      this.el.songList.innerHTML = filtered.map((song, i) => this.songRow(song, i)).join("");
    }
    this.markPlaying();
  },

  updateCount() {
    const total = Library.songs.length;
    this.el.songCount.textContent = `${total} ${total === 1 ? "canción" : "canciones"}`;
  },

  markPlaying() {
    document.querySelectorAll(".song-item").forEach((row) => {
      row.classList.toggle("playing", Number(row.dataset.song) === Player.currentId);
    });
  },

  async renderSettings() {
    let text = Store.available
      ? "Tus canciones se guardan en este dispositivo."
      : "Aviso: este navegador no permite guardar la biblioteca; se perderá al cerrar.";
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage } = await navigator.storage.estimate();
        if (typeof usage === "number") text += ` Espacio usado: ${this.formatBytes(usage)}.`;
      }
    } catch (error) { /* no crítico */ }
    this.el.storageInfo.textContent = `${Library.songs.length} canciones. ${text}`;
  },

  /* ---------- Reproductor ---------- */

  showNowPlaying(song) {
    this.refreshNowPlayingInfo(song);
    this.el.progress.value = 0;
    this.el.currentTime.textContent = "0:00";
    this.el.duration.textContent = this.formatTime(song.duration);
    this.markPlaying();
    this.updatePlayState();
    this.updateMiniPlayer();
  },

  resetNowPlaying() {
    this.setCover(this.el.bigCover, null);
    this.setCover(this.el.miniCover, null);
    this.el.playerTitle.textContent = "Sin reproducción";
    this.el.playerArtist.textContent = "Pulsar RM";
    this.el.miniTitle.textContent = "Sin reproducción";
    this.el.miniArtist.textContent = "Pulsar RM";
    this.el.progress.value = 0;
    this.el.currentTime.textContent = "0:00";
    this.el.duration.textContent = "0:00";
    this.markPlaying();
    this.updatePlayState();
    this.updateMiniPlayer();
  },

  updatePlayState() {
    const playing = Player.currentId !== null && !Player.audio.paused;
    const symbol = playing ? "⏸" : "▶";
    document.querySelectorAll('[data-action="toggle"]').forEach((button) => {
      button.textContent = symbol;
      button.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
    });
    document.querySelectorAll("[data-song-play]").forEach((button) => {
      const isCurrent = Number(button.dataset.songPlay) === Player.currentId;
      button.textContent = isCurrent && playing ? "⏸" : "▶";
    });
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    }
  },

  updateProgress() {
    if (Player.seeking) return;
    const duration = Player.audio.duration;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    this.el.progress.value = hasDuration ? (Player.audio.currentTime / duration) * 1000 : 0;
    this.el.currentTime.textContent = this.formatTime(Player.audio.currentTime);
  },

  setDuration(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.el.duration.textContent = this.formatTime(seconds);
    }
  },

  updateMiniPlayer() {
    const visible = Player.currentId !== null && Router.current !== "player" && Router.current !== "eq";
    this.el.miniPlayer.classList.toggle("hidden", !visible);
  },

  /* ---------- Carátulas y menú ---------- */

  coverHTML(song) {
    const url = Covers.get(song);
    return url ? `<img src="${url}" alt="" loading="lazy">` : "♫";
  },

  setCover(element, url) {
    if (!element) return;
    if (url) {
      element.textContent = "";
      const image = document.createElement("img");
      image.alt = "";
      image.src = url;
      element.appendChild(image);
    } else {
      element.textContent = "♫";
    }
  },

  // Actualiza título, artista y carátula del reproductor SIN reiniciar la barra de progreso.
  refreshNowPlayingInfo(song) {
    const title = song.name || "Sin título";
    this.el.playerTitle.textContent = title;
    this.el.playerArtist.textContent = song.artist;
    this.el.miniTitle.textContent = title;
    this.el.miniArtist.textContent = song.artist;
    const url = Covers.get(song);
    this.setCover(this.el.bigCover, url);
    this.setCover(this.el.miniCover, url);
  },

  toggleMenu() {
    const hide = !this.el.playerMenu.classList.contains("hidden");
    this.el.playerMenu.classList.toggle("hidden", hide);
    this.el.playerMenuButton.setAttribute("aria-expanded", String(!hide));
  },

  closeMenu() {
    if (!this.el.playerMenu) return;
    this.el.playerMenu.classList.add("hidden");
    this.el.playerMenuButton.setAttribute("aria-expanded", "false");
  },

  /* ---------- Utilidades ---------- */

  prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  // Desvanece la fila antes de borrarla (si el usuario no pidió reducir animaciones).
  animateOut(id) {
    const rows = document.querySelectorAll(`[data-song="${id}"]`);
    if (!rows.length || this.prefersReducedMotion()) return Promise.resolve();
    rows.forEach((row) => row.classList.add("leaving"));
    return new Promise((resolve) => setTimeout(resolve, 220));
  },

  toast(message, sticky = false) {
    const box = this.el.toast;
    box.textContent = message;
    box.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    if (!sticky) {
      this.toastTimer = setTimeout(() => box.classList.add("hidden"), 3500);
    }
  },

  formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.floor(seconds % 60);
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  },

  formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  },

  escapeHTML(text) {
    return String(text).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character]);
  }
};

/* =========================================================
   EDITOR — editar título, artista y carátula de una canción
   Se abre desde el menú ⋮ del reproductor completo.
   ========================================================= */
const Editor = {
  songId: null,
  pendingCover: null,   // Blob de la carátula elegida (o null si no hay)
  coverChanged: false,
  previewUrl: null,
  saving: false,

  isOpen() {
    return Boolean(UI.el.editSheet) && !UI.el.editSheet.classList.contains("hidden");
  },

  open() {
    const song = Library.byId(Player.currentId);
    if (!song) {
      UI.toast("Reproduce una canción para editar su información.");
      return;
    }
    this.songId = song.id;
    this.pendingCover = song.cover || null;
    this.coverChanged = false;
    UI.el.editName.value = song.name || "";
    UI.el.editArtist.value = song.artist || "";
    UI.el.editFile.textContent = "Archivo: " + song.fileName;
    this.renderPreview();
    UI.el.editSheet.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  },

  renderPreview() {
    this.revokePreview();
    if (this.pendingCover) this.previewUrl = URL.createObjectURL(this.pendingCover);
    UI.setCover(UI.el.editCover, this.previewUrl);
  },

  revokePreview() {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
  },

  async setCover(file) {
    try {
      this.pendingCover = await this.makeCoverBlob(file);
      this.coverChanged = true;
      this.renderPreview();
      UI.toast("Imagen lista. Toca Guardar para aplicarla.");
    } catch (error) {
      console.error("No se pudo procesar la imagen:", error);
      UI.toast("No se pudo usar esa imagen. Prueba con una JPG o PNG.");
    }
  },

  removeCover() {
    this.pendingCover = null;
    this.coverChanged = true;
    this.renderPreview();
  },

  resetFromFile() {
    const song = Library.byId(this.songId);
    if (!song) return;
    const parsed = Library.parseFileName(song.fileName);
    UI.el.editName.value = parsed.title;
    UI.el.editArtist.value = parsed.artist;
  },

  // Recorta al centro en cuadrado, reduce a 512 px máx. y guarda como JPG ligero.
  async makeCoverBlob(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("No se pudo leer la imagen"));
        img.src = url;
      });
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      if (!side) throw new Error("La imagen está vacía");
      const size = Math.min(512, side);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side,
        0, 0, size, size
      );
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("No se pudo convertir la imagen");
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  async save() {
    if (this.saving) return;
    const song = Library.byId(this.songId);
    if (!song) { this.close(); return; }
    this.saving = true;

    const parsed = Library.parseFileName(song.fileName);
    const previous = { name: song.name, artist: song.artist, cover: song.cover };
    song.name = UI.el.editName.value.trim() || parsed.title;
    song.artist = UI.el.editArtist.value.trim() || parsed.artist;
    if (this.coverChanged) song.cover = this.pendingCover;

    try {
      await Store.updateSong(song);
      if (this.coverChanged) Covers.release(song.id);
      UI.renderAll();
      if (Player.currentId === song.id) {
        UI.refreshNowPlayingInfo(song);
        Player.updateMediaMetadata(song);
      }
      this.close();
      UI.toast("Información guardada.");
    } catch (error) {
      console.error("No se pudo guardar:", error);
      song.name = previous.name;
      song.artist = previous.artist;
      song.cover = previous.cover;
      UI.toast(error && error.name === "QuotaExceededError"
        ? "No hay espacio suficiente para guardar."
        : "No se pudieron guardar los cambios.");
    } finally {
      this.saving = false;
    }
  },

  close() {
    if (UI.el.editSheet) UI.el.editSheet.classList.add("hidden");
    document.body.classList.remove("no-scroll");
    this.revokePreview();
    this.songId = null;
    this.pendingCover = null;
    this.coverChanged = false;
  },

  // Se llama al cambiar de pantalla (por ejemplo con el botón Atrás de Android).
  discard() {
    if (this.isOpen()) this.close();
  }
};

/* =========================================================
   ARRANQUE
   Primero se activan los botones y la navegación (síncrono),
   después se carga la biblioteca guardada (asíncrono).
   ========================================================= */
document.addEventListener("DOMContentLoaded", async () => {
  UI.cache();
  UI.bindEvents();
  Player.init();
  Themes.init();
  Lyrics.init();
  LyricsEditor.init();
  Stage.init();
  Equalizer.init();
  Router.init();
  UI.renderAll();

  await Store.open();
  await Settings.load();
  Equalizer.loadSaved();
  await Library.load();
  UI.renderAll();

  if (!Store.available) {
    UI.toast("Este navegador no permite guardar la biblioteca; se perderá al cerrar.");
  }
  console.log("Pulsar RM " + APP_VERSION + " iniciado correctamente 💜");
});
