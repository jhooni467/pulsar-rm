/* PULSAR RM 0.4a — Base estable + animaciones
   Módulos: Store (IndexedDB) · Settings · Library · Player · Router · UI · Lyrics (reservado)
   Todos los botones usan delegación de eventos: siguen funcionando aunque el HTML se vuelva a dibujar. */

"use strict";

const APP_VERSION = "0.7";
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
  { id: "pulsar", name: "Pulsar", bg: "#080B16", surface: "#111827", accent: "#A18AFF" },
  { id: "ocean", name: "Océano", bg: "#091218", surface: "#111F27", accent: "#3DC8FF" },
  { id: "sunset", name: "Atardecer", bg: "#180C09", surface: "#271611", accent: "#FF8A4C" },
  { id: "forest", name: "Bosque", bg: "#091811", surface: "#11271C", accent: "#4ADE80" },
  { id: "rose", name: "Rosa", bg: "#180911", surface: "#27111C", accent: "#FF6FB5" },
  { id: "crimson", name: "Carmesí", bg: "#18090A", surface: "#271113", accent: "#FF4D5E" },
  { id: "gold", name: "Dorado", bg: "#181409", surface: "#272111", accent: "#F5C542" },
  { id: "midnight", name: "Medianoche", bg: "#000000", surface: "#0B0B10", accent: "#C4B5FD" },
  { id: "light", name: "Claro", bg: "#F3F4FA", surface: "#FFFFFF", accent: "#6A45F5" }
];

const Settings = {
  defaults: { theme: "pulsar", playback: { shuffle: false, repeat: "off" }, eq: { enabled: false, preset: "flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
  values: {},

  async load() {
    this.values = { ...this.defaults };
    for (const key of Object.keys(this.defaults)) {
      try {
        const saved = await Store.getSetting(key);
        if (saved !== undefined) this.values[key] = saved;
      } catch (error) {
        console.warn("No se pudo leer el ajuste", key, error);
      }
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
    document.documentElement.setAttribute("data-theme", theme.id);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme.bg); // color de la barra de estado de Android
    try { localStorage.setItem("pulsar-theme", theme.id); } catch (error) { /* se usa al abrir, para evitar parpadeo */ }
    Themes.refresh();
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
const Themes = {
  init() {
    const grid = $("theme-grid");
    if (!grid) return;
    grid.innerHTML = THEMES.map((theme) => `
      <button type="button" class="theme-swatch" role="radio" aria-checked="false" data-theme-id="${theme.id}"
              aria-label="Tema ${theme.name}">
        <span class="swatch" style="--sw-bg:${theme.bg};--sw-surface:${theme.surface};--sw-accent:${theme.accent}">
          <span class="swatch-check" aria-hidden="true">✓</span>
        </span>
        <span>${theme.name}</span>
      </button>`).join("");
    this.refresh();
  },

  refresh() {
    document.querySelectorAll(".theme-swatch").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.themeId === Settings.values.theme));
    });
  },

  select(id) {
    if (!THEMES.some((theme) => theme.id === id)) return;
    Settings.set("theme", id);
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
    return Boolean(this.el) && (
      (Router.current === "player" && Stage.mode === "lyrics") || Router.current === "immersive"
    );
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

    Immersive.onLyricsChange(data);
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
    this.fitPad();
    const line = this.lineEls[index];
    const top = line.offsetTop - (this.el.clientHeight - line.offsetHeight) / 2;
    const smooth = !instant && !UI.prefersReducedMotion();
    this.el.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  },

  // Los espacios de arriba y abajo se ajustan a la altura real del panel (portada, letra o modo inmersivo).
  fitPad() {
    const height = this.el.clientHeight;
    if (height && height !== this.padH) {
      this.padH = height;
      this.el.style.setProperty("--pad", Math.max(0, height / 2 - 30) + "px");
    }
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

  // Ids de lo que viene después, según aleatorio / repetir.
  upcomingIds() {
    const songs = Library.songs;
    if (Player.shuffle) {
      Player.ensureOrder();
      return Player.order.slice(Player.orderPos + 1);
    }
    const current = Library.indexOf(Player.currentId);
    const after = songs.slice(current + 1).map((song) => song.id);
    if (Player.repeat !== "all") return after;
    return after.concat(songs.slice(0, current).map((song) => song.id));
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
    const upcoming = this.upcomingIds();
    const shown = upcoming.slice(0, this.LIMIT).map((id) => Library.byId(id)).filter(Boolean);
    const modes = [Player.shuffle ? "aleatorio" : "", Player.repeat === "all" ? "repetir todo" : Player.repeat === "one" ? "repetir una" : ""]
      .filter(Boolean).join(" · ");
    let html = `<p class="queue-label">Reproduciendo ahora${modes ? " · " + modes : ""}</p>` + this.row(songs[current], 1, true);
    if (Player.repeat === "one") {
      html += `<p class="queue-empty">Esta canción se repite hasta que lo cambies.</p>`;
    } else if (!upcoming.length) {
      html += `<p class="queue-empty">${Player.repeat === "all" ? "Al terminar, vuelve a empezar." : "No hay más canciones: al terminar, la reproducción se detiene."}</p>`;
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
   METADATA — lee título, artista, álbum y portada incrustados en el audio
   Sin librerías: MP3 (ID3v2 y v1), M4A/MP4, FLAC y OGG (Vorbis y Opus).
   Devuelve { title, artist, album, picture: { mime, data } } con lo que encuentre.
   ========================================================= */
const Metadata = {
  MAX_PICTURE: 12 * 1024 * 1024,

  async read(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const tag = (i, text) => text.split("").every((c, k) => head[i + k] === c.charCodeAt(0));
      if (tag(0, "ID3")) return this.clean(await this.readID3v2(file, head));
      if (tag(0, "fLaC")) return this.clean(await this.readFlac(file));
      if (tag(0, "OggS")) return this.clean(await this.readOgg(file));
      if (tag(4, "ftyp")) return this.clean(await this.readMP4(file));
      return this.clean(await this.readID3v1(file)); // MP3 sin ID3v2
    } catch (error) {
      console.warn("No se pudieron leer las etiquetas de", file.name, error);
      return {};
    }
  },

  clean(info) {
    const out = {};
    ["title", "artist", "album"].forEach((key) => {
      const value = info && typeof info[key] === "string" ? info[key].replace(/\0/g, "").trim() : "";
      if (value) out[key] = value.slice(0, 200);
    });
    if (info && info.picture && info.picture.data && info.picture.data.length > 64) {
      out.picture = { mime: this.sniffMime(info.picture.data, info.picture.mime), data: info.picture.data };
    }
    return out;
  },

  sniffMime(bytes, fallback) {
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    if (fallback && /^image\//i.test(fallback)) return fallback.toLowerCase();
    if (/^(jpe?g)$/i.test(fallback || "")) return "image/jpeg";
    if (/^png$/i.test(fallback || "")) return "image/png";
    return "image/jpeg";
  },

  ascii(bytes, start, length) {
    let out = "";
    for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  },

  utf8(bytes) {
    try { return new TextDecoder("utf-8").decode(bytes); } catch (error) { return ""; }
  },

  /* ---------- Texto con codificación (ID3) ---------- */

  decodeText(bytes, encoding) {
    try {
      if (encoding === 1) {
        let little = true, start = 0;
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) { little = false; start = 2; }
        else if (bytes[0] === 0xFF && bytes[1] === 0xFE) { start = 2; }
        return new TextDecoder(little ? "utf-16le" : "utf-16be").decode(bytes.subarray(start));
      }
      if (encoding === 2) return new TextDecoder("utf-16be").decode(bytes);
      if (encoding === 3) return new TextDecoder("utf-8").decode(bytes);
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } // muchos MP3 "latin1" son UTF-8
      catch (error) { return new TextDecoder("windows-1252").decode(bytes); }
    } catch (error) {
      return "";
    }
  },

  firstValue(text) {
    return String(text || "").split("\0").map((part) => part.trim()).find(Boolean) || "";
  },

  // Posición del terminador (1 byte, o 2 si la codificación es UTF-16) desde "from".
  findTerminator(bytes, from, encoding) {
    if (encoding === 1 || encoding === 2) {
      for (let i = from; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
      return -1;
    }
    return bytes.indexOf(0, from);
  },

  /* ---------- MP3: ID3v2 ---------- */

  synchsafe(bytes, i) {
    return ((bytes[i] & 0x7F) << 21) | ((bytes[i + 1] & 0x7F) << 14) | ((bytes[i + 2] & 0x7F) << 7) | (bytes[i + 3] & 0x7F);
  },

  unsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let n = 0;
    for (let i = 0; i < bytes.length; i++) {
      out[n++] = bytes[i];
      if (bytes[i] === 0xFF && bytes[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  },

  async readID3v2(file, head) {
    const version = head[3];
    const flags = head[5];
    if (version < 2 || version > 4) return this.readID3v1(file);
    const size = Math.min(this.synchsafe(head, 6), 16 * 1024 * 1024);
    let buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if (version < 4 && (flags & 0x80)) buf = this.unsync(buf);

    let p = 0;
    if (flags & 0x40 && buf.length > 4) { // cabecera extendida
      p = version === 4
        ? this.synchsafe(buf, 0)
        : ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) + 4;
    }

    const idLength = version === 2 ? 3 : 4;
    const headerLength = version === 2 ? 6 : 10;
    const result = {};
    let bestPicture = null;

    while (p + headerLength <= buf.length) {
      const id = this.ascii(buf, p, idLength);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // relleno (ceros) o basura
      let frameSize;
      if (version === 2) frameSize = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5];
      else if (version === 3) frameSize = ((buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7]) >>> 0;
      else frameSize = this.synchsafe(buf, p + 4);
      const formatFlags = version === 2 ? 0 : buf[p + 9];
      const start = p + headerLength;
      const end = start + frameSize;
      if (frameSize <= 0 || end > buf.length) break;

      let data = buf.subarray(start, end);
      if (version === 4) {
        if (formatFlags & 0x01) data = data.subarray(4);        // indicador de longitud
        if (formatFlags & 0x02) data = this.unsync(data);        // desincronización por marco
        if (formatFlags & 0x0C) data = null;                     // comprimido o cifrado: se omite
      }

      if (data && data.length > 1) {
        if (id === "TIT2" || id === "TT2") result.title = this.firstValue(this.decodeText(data.subarray(1), data[0]));
        else if (id === "TPE1" || id === "TP1") result.artist = this.firstValue(this.decodeText(data.subarray(1), data[0]));
        else if ((id === "TPE2" || id === "TP2") && !result.albumArtist) result.albumArtist = this.firstValue(this.decodeText(data.subarray(1), data[0]));
        else if (id === "TALB" || id === "TAL") result.album = this.firstValue(this.decodeText(data.subarray(1), data[0]));
        else if ((id === "APIC" || id === "PIC") && data.length < this.MAX_PICTURE) {
          const picture = this.parseAPIC(data, id === "PIC");
          if (picture && (!bestPicture || (picture.type === 3 && bestPicture.type !== 3))) bestPicture = picture;
        }
      }
      p = end;
    }

    if (!result.artist && result.albumArtist) result.artist = result.albumArtist;
    if (bestPicture) result.picture = bestPicture;
    if (!result.title && !result.artist) {
      const old = await this.readID3v1(file); // por si solo trae etiquetas antiguas
      return { ...old, ...result, picture: result.picture };
    }
    return result;
  },

  parseAPIC(data, isV22) {
    const encoding = data[0];
    let p = 1, mime;
    if (isV22) {
      mime = this.ascii(data, 1, 3);
      p = 4;
    } else {
      const zero = data.indexOf(0, 1);
      if (zero < 0) return null;
      mime = this.ascii(data, 1, zero - 1);
      p = zero + 1;
    }
    const type = data[p];
    p += 1;
    const end = this.findTerminator(data, p, encoding);
    if (end < 0) return null;
    p = end + ((encoding === 1 || encoding === 2) ? 2 : 1);
    if (p >= data.length) return null;
    return { type, mime, data: data.slice(p) };
  },

  /* ---------- MP3: ID3v1 (al final del archivo) ---------- */

  async readID3v1(file) {
    if (file.size < 128) return {};
    const tail = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
    if (this.ascii(tail, 0, 3) !== "TAG") return {};
    const field = (start, length) => {
      let text = "";
      try { text = new TextDecoder("windows-1252").decode(tail.subarray(start, start + length)); } catch (error) { /* vacío */ }
      return text.replace(/\0[\s\S]*$/, "").trim();
    };
    return { title: field(3, 30), artist: field(33, 30), album: field(63, 30) };
  },

  /* ---------- FLAC ---------- */

  async readFlac(file) {
    const result = {};
    let pos = 4;
    for (let guard = 0; guard < 200 && pos + 4 <= file.size; guard++) {
      const header = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
      const last = (header[0] & 0x80) !== 0;
      const type = header[0] & 0x7F;
      const length = (header[1] << 16) | (header[2] << 8) | header[3];
      const bodyStart = pos + 4;
      if (type === 4 && length < 4 * 1024 * 1024) {
        const body = new Uint8Array(await file.slice(bodyStart, bodyStart + length).arrayBuffer());
        Object.assign(result, this.fromVorbisTags(this.parseVorbisComment(body, 0)));
      } else if (type === 6 && length < this.MAX_PICTURE && !result.picture) {
        const body = new Uint8Array(await file.slice(bodyStart, bodyStart + length).arrayBuffer());
        result.picture = this.parseFlacPicture(body);
      }
      pos = bodyStart + length;
      if (last) break;
    }
    return result;
  },

  parseFlacPicture(bytes) {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let p = 4; // tipo de imagen
      const mimeLength = view.getUint32(p); p += 4;
      const mime = this.ascii(bytes, p, mimeLength); p += mimeLength;
      const descLength = view.getUint32(p); p += 4 + descLength;
      p += 16; // ancho, alto, profundidad y colores
      const dataLength = view.getUint32(p); p += 4;
      if (p + dataLength > bytes.length) return null;
      return { mime, data: bytes.slice(p, p + dataLength) };
    } catch (error) {
      return null;
    }
  },

  /* ---------- Vorbis / Opus (comentarios) ---------- */

  parseVorbisComment(bytes, offset) {
    const tags = {};
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let p = offset;
      p += 4 + view.getUint32(p, true); // fabricante
      const count = view.getUint32(p, true); p += 4;
      for (let i = 0; i < count; i++) {
        if (p + 4 > bytes.length) break;
        const length = view.getUint32(p, true); p += 4;
        if (p + length > bytes.length) break; // comentario cortado (portada muy grande): se ignora
        const text = this.utf8(bytes.subarray(p, p + length)); p += length;
        const eq = text.indexOf("=");
        if (eq > 0) {
          const key = text.slice(0, eq).toUpperCase();
          (tags[key] = tags[key] || []).push(text.slice(eq + 1));
        }
      }
    } catch (error) { /* se devuelve lo leído */ }
    return tags;
  },

  fromVorbisTags(tags) {
    const first = (key) => (tags[key] && tags[key][0]) || "";
    const result = {
      title: first("TITLE"),
      artist: first("ARTIST") || first("ALBUMARTIST"),
      album: first("ALBUM")
    };
    const encoded = first("METADATA_BLOCK_PICTURE");
    if (encoded && encoded.length < this.MAX_PICTURE * 1.4) {
      try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const picture = this.parseFlacPicture(bytes);
        if (picture) result.picture = picture;
      } catch (error) { /* imagen dañada */ }
    }
    return result;
  },

  /* ---------- OGG (Vorbis y Opus) ---------- */

  async readOgg(file) {
    const buf = new Uint8Array(await file.slice(0, 6 * 1024 * 1024).arrayBuffer());
    const packets = this.oggPackets(buf, 2);
    const packet = packets[1];
    if (!packet) return {};
    let offset = -1;
    if (packet[0] === 0x03 && this.ascii(packet, 1, 6) === "vorbis") offset = 7;
    else if (this.ascii(packet, 0, 8) === "OpusTags") offset = 8;
    if (offset < 0) return {};
    return this.fromVorbisTags(this.parseVorbisComment(packet, offset));
  },

  // Reconstruye los primeros "wanted" paquetes de un flujo Ogg (pueden abarcar varias páginas).
  oggPackets(buf, wanted) {
    const packets = [];
    let parts = [], total = 0, p = 0;
    while (p + 27 <= buf.length && packets.length < wanted) {
      if (this.ascii(buf, p, 4) !== "OggS") break;
      const segments = buf[p + 26];
      let dataPos = p + 27 + segments;
      if (dataPos > buf.length) break;
      for (let s = 0; s < segments; s++) {
        const lace = buf[p + 27 + s];
        if (dataPos + lace > buf.length) return packets; // el archivo leído termina antes
        parts.push(buf.subarray(dataPos, dataPos + lace));
        total += lace;
        dataPos += lace;
        if (lace < 255) {
          const joined = new Uint8Array(total);
          let at = 0;
          parts.forEach((part) => { joined.set(part, at); at += part.length; });
          packets.push(joined);
          parts = []; total = 0;
          if (packets.length >= wanted) return packets;
        }
      }
      p = dataPos;
    }
    return packets;
  },

  /* ---------- M4A / MP4 ---------- */

  boxes(buf, start, end) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const list = [];
    let p = start;
    while (p + 8 <= end) {
      let size = view.getUint32(p);
      const type = this.ascii(buf, p + 4, 4);
      let header = 8;
      if (size === 1 && p + 16 <= end) {
        size = view.getUint32(p + 8) * 4294967296 + view.getUint32(p + 12);
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header) break;
      const boxEnd = Math.min(p + size, end);
      list.push({ type, start: p + header, end: boxEnd });
      p += size;
    }
    return list;
  },

  async readMP4(file) {
    let pos = 0;
    for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
      const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
      let size = head.getUint32(0);
      const type = this.ascii(new Uint8Array(head.buffer), 4, 4);
      let header = 8;
      if (size === 1) { size = head.getUint32(8) * 4294967296 + head.getUint32(12); header = 16; }
      else if (size === 0) size = file.size - pos;
      if (size < header) break;
      if (type === "moov") {
        if (size > 40 * 1024 * 1024) return {};
        const buf = new Uint8Array(await file.slice(pos + header, pos + size).arrayBuffer());
        return this.parseMoov(buf);
      }
      pos += size;
    }
    return {};
  },

  parseMoov(buf) {
    const find = (list, type) => list.find((box) => box.type === type);
    const udta = find(this.boxes(buf, 0, buf.length), "udta");
    if (!udta) return {};
    const meta = find(this.boxes(buf, udta.start, udta.end), "meta");
    if (!meta) return {};
    const ilst = find(this.boxes(buf, meta.start + 4, meta.end), "ilst"); // "meta" lleva 4 bytes de versión
    if (!ilst) return {};

    const result = {};
    this.boxes(buf, ilst.start, ilst.end).forEach((item) => {
      const dataBox = this.boxes(buf, item.start, item.end).find((box) => box.type === "data");
      if (!dataBox || dataBox.end - dataBox.start <= 8) return;
      const payload = buf.subarray(dataBox.start + 8, dataBox.end); // 4 de tipo + 4 de idioma
      if (item.type === "\xA9nam") result.title = this.utf8(payload);
      else if (item.type === "\xA9ART") result.artist = this.utf8(payload);
      else if (item.type === "aART" && !result.albumArtist) result.albumArtist = this.utf8(payload);
      else if (item.type === "\xA9alb") result.album = this.utf8(payload);
      else if (item.type === "covr" && payload.length < this.MAX_PICTURE && !result.picture) {
        result.picture = { mime: "", data: payload.slice() };
      }
    });
    if (!result.artist && result.albumArtist) result.artist = result.albumArtist;
    return result;
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
      cover: null,
      album: ""
    };
  },

  // Completa nombre, artista, álbum y portada con las etiquetas incrustadas en el archivo.
  async applyTags(meta, file) {
    const tags = await Metadata.read(file);
    if (tags.title) meta.name = tags.title;
    if (tags.artist) meta.artist = tags.artist;
    if (tags.album) meta.album = tags.album;
    if (tags.picture) {
      try {
        meta.cover = await Editor.makeCoverBlob(new Blob([tags.picture.data], { type: tags.picture.mime }));
      } catch (error) {
        console.warn("No se pudo usar la portada incrustada de", file.name, error);
      }
    }
    return tags;
  },

  // Vuelve a leer las etiquetas de las canciones ya guardadas (sin tocar lo que editaste a mano).
  async rescanTags() {
    if (this.importing) { UI.toast("Espera a que termine la importación."); return; }
    if (!this.songs.length) { UI.toast("La biblioteca está vacía."); return; }
    this.importing = true;
    let updated = 0;
    try {
      for (let i = 0; i < this.songs.length; i++) {
        const song = this.songs[i];
        UI.toast(`Leyendo etiquetas ${i + 1} de ${this.songs.length}…`, true);
        const blob = await Store.getBlob(song.id);
        if (!blob) continue;
        const tags = await Metadata.read(blob);
        let changed = false;
        if (!song.userEdited) {
          if (tags.title && tags.title !== song.name) { song.name = tags.title; changed = true; }
          if (tags.artist && tags.artist !== song.artist) { song.artist = tags.artist; changed = true; }
        }
        if (tags.album && tags.album !== song.album) { song.album = tags.album; changed = true; }
        if (!song.cover && tags.picture) {
          try {
            song.cover = await Editor.makeCoverBlob(new Blob([tags.picture.data], { type: tags.picture.mime }));
            Covers.release(song.id);
            changed = true;
          } catch (error) { /* imagen no válida: se deja sin portada */ }
        }
        if (changed) {
          await Store.updateSong(song);
          updated++;
        }
      }
      UI.renderAll();
      const current = Library.byId(Player.currentId);
      if (current) { UI.refreshNowPlayingInfo(current); Player.updateMediaMetadata(current); }
      UI.toast(updated ? `${updated} ${updated === 1 ? "canción actualizada" : "canciones actualizadas"}.` : "No hay nada nuevo que leer.");
    } catch (error) {
      console.error("Error al leer etiquetas:", error);
      UI.toast("No se pudieron leer todas las etiquetas.");
    } finally {
      this.importing = false;
    }
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
        await this.applyTags(meta, file);
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
    try { await Persistence.check(true); } catch (error) { /* no es crítico */ }
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
  shuffle: false,
  repeat: "off",   // "off" | "all" | "one"
  order: [],       // orden aleatorio (ids de canciones)
  orderPos: -1,    // posición actual dentro de "order"

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

  async play(id, options = {}) {
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
    if (this.shuffle && !options.keepOrder) this.rebuildOrder(); // elegiste una canción a mano: se mezcla el resto
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
        if (this.shuffle) this.play(this.step(1, false), { keepOrder: true });
        else this.play(Library.songs[0].id);
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

  /* ---------- Orden de reproducción (normal o aleatorio) ---------- */

  // Lista de ids mezclada. "first" queda al principio; "avoid" no queda primero (para no repetir al empezar otra ronda).
  makeShuffled(first = null, avoid = null) {
    const ids = Library.songs.map((song) => song.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    if (first !== null) {
      const at = ids.indexOf(first);
      if (at > 0) { ids.splice(at, 1); ids.unshift(first); }
    } else if (avoid !== null && ids.length > 1 && ids[0] === avoid) {
      ids.push(ids.shift());
    }
    return ids;
  },

  rebuildOrder() {
    const known = this.currentId !== null && Library.byId(this.currentId);
    this.order = this.makeShuffled(known ? this.currentId : null);
    this.orderPos = known ? 0 : -1;
  },

  // Si la biblioteca cambió (se añadió o borró música), se vuelve a mezclar conservando la canción actual.
  ensureOrder() {
    const songs = Library.songs;
    const ids = new Set(this.order);
    const valid = this.order.length === songs.length &&
      songs.every((song) => ids.has(song.id)) &&
      (this.currentId === null || this.order[this.orderPos] === this.currentId);
    if (!valid) this.rebuildOrder();
  },

  // Devuelve el id de la canción a la que hay que saltar (o null si la lista terminó).
  // auto = true cuando la canción acabó sola; false cuando la persona pulsó Siguiente/Anterior.
  step(direction, auto) {
    const songs = Library.songs;
    if (!songs.length) return null;

    if (this.shuffle) {
      this.ensureOrder();
      let pos = this.orderPos + direction;
      if (pos >= this.order.length) {
        if (auto && this.repeat !== "all") return null;
        this.order = this.makeShuffled(null, this.currentId); // nueva ronda mezclada
        this.orderPos = 0;
        return this.order[0];
      }
      if (pos < 0) pos = this.order.length - 1;
      this.orderPos = pos;
      return this.order[pos];
    }

    const index = Library.indexOf(this.currentId);
    if (index < 0) return songs[direction > 0 ? 0 : songs.length - 1].id;
    let target = index + direction;
    if (target >= songs.length) {
      if (auto && this.repeat !== "all") return null;
      target = 0;
    } else if (target < 0) {
      target = songs.length - 1;
    }
    return songs[target].id;
  },

  next() {
    const id = this.step(1, false);
    if (id !== null) this.play(id, { keepOrder: true });
  },

  previous() {
    if (!Library.songs.length) return;
    if (this.currentId !== null && this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    const id = this.step(-1, false);
    if (id !== null) this.play(id, { keepOrder: true });
  },

  handleEnded() {
    // Con "repetir una" el propio audio vuelve a empezar (audio.loop), así que aquí no se llega.
    const id = this.step(1, true);
    if (id === null) {
      // Fin de la lista sin repetir: se queda al inicio de la última canción, en pausa.
      this.audio.currentTime = 0;
      UI.updatePlayState();
      UI.updateProgress();
      Lyrics.refresh(true);
      return;
    }
    if (id === this.currentId) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    } else {
      this.play(id, { keepOrder: true });
    }
  },

  /* ---------- Aleatorio y repetir ---------- */

  loadPrefs() {
    const saved = Settings.values.playback || {};
    this.shuffle = Boolean(saved.shuffle);
    this.repeat = ["off", "all", "one"].includes(saved.repeat) ? saved.repeat : "off";
    this.audio.loop = this.repeat === "one";
    if (this.shuffle) this.rebuildOrder();
    UI.updateModes();
  },

  savePrefs() {
    Settings.set("playback", { shuffle: this.shuffle, repeat: this.repeat });
  },

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) this.rebuildOrder();
    this.savePrefs();
    UI.updateModes();
    Queue.refresh();
    UI.toast(this.shuffle ? "Aleatorio activado" : "Aleatorio desactivado");
  },

  cycleRepeat() {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    this.audio.loop = this.repeat === "one";
    this.savePrefs();
    UI.updateModes();
    Queue.refresh();
    UI.toast({ off: "Repetir desactivado", all: "Repetir toda la biblioteca", one: "Repetir esta canción" }[this.repeat]);
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
    this.order = [];
    this.orderPos = -1;
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
        album: song.album || "Pulsar RM",
        artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : []
      });
    } catch (error) { /* no crítico */ }
  }
};

/* =========================================================
   IMMERSIVE — modo inmersivo del reproductor
   Portada grande con fondo difuminado y letra sincronizada a pantalla completa.
   La letra es la misma del reproductor: el panel se mueve aquí mientras el modo está abierto.
   ========================================================= */
const Immersive = {
  wake: null,
  waking: false,

  init() {
    document.addEventListener("visibilitychange", () => this.updateWake());
    let timer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (Router.current === "immersive") Lyrics.refresh(true); }, 150);
    });
  },

  open() {
    if (Player.currentId === null) {
      UI.toast("Reproduce una canción para usar el modo inmersivo.");
      return;
    }
    Router.go("immersive");
  },

  close() {
    // Si veníamos del reproductor, "atrás" no deja entradas repetidas en el historial.
    if (Router.previous === "player") history.back();
    else Router.go("player");
  },

  toggleMode() {
    const view = $("view-immersive");
    const next = view.dataset.mode === "cover" ? "lyrics" : "cover";
    view.dataset.mode = next;
    $("im-mode").textContent = next === "cover" ? "♪ Letra" : "◉ Portada";
    Lyrics.refresh(true);
    setTimeout(() => { if (Router.current === "immersive") Lyrics.refresh(true); }, 400); // cuando termina la animación
  },

  // Se llama cada vez que cambia la pantalla: mueve el panel de letra y ajusta el fondo.
  sync(name) {
    const lyrics = $("lyrics");
    const host = $("im-lyrics");
    const panel = $("lyrics-panel");
    if (lyrics && host && panel) {
      if (name === "immersive") { if (lyrics.parentNode !== host) host.appendChild(lyrics); }
      else if (lyrics.parentNode !== panel) panel.appendChild(lyrics);
    }
    document.body.dataset.route = name;
    this.updateWake();
  },

  // Sin letra sincronizada, el modo "portada" no deja hueco para ella.
  onLyricsChange(data) {
    const view = $("view-immersive");
    if (view) view.classList.toggle("no-lyrics", !(data && data.synced));
  },

  setArt(url) {
    const bg = $("im-bg");
    if (!bg) return;
    bg.style.backgroundImage = url ? `url("${url}")` : "";
    bg.classList.toggle("has-art", Boolean(url));
  },

  /* ---------- Pantalla encendida mientras suena ---------- */

  wantsWake() {
    return Router.current === "immersive" && Player.currentId !== null && !Player.audio.paused && !document.hidden;
  },

  updateWake() {
    if (!this.wantsWake()) {
      if (this.wake) { this.wake.release().catch(() => {}); this.wake = null; }
      return;
    }
    if (this.wake || this.waking || !navigator.wakeLock) return;
    this.waking = true;
    navigator.wakeLock.request("screen").then((lock) => {
      this.waking = false;
      this.wake = lock;
      lock.addEventListener("release", () => { if (this.wake === lock) this.wake = null; });
      if (!this.wantsWake()) this.updateWake();
    }).catch(() => { this.waking = false; });
  }
};

/* =========================================================
   PERSISTENCE — pide al navegador que no borre la biblioteca cuando falte espacio
   ========================================================= */
const Persistence = {
  state: "unknown", // "yes" | "no" | "unsupported"

  async check(request) {
    if (!(navigator.storage && navigator.storage.persisted)) { this.state = "unsupported"; return this.state; }
    try {
      let granted = await navigator.storage.persisted();
      if (!granted && request && navigator.storage.persist) granted = await navigator.storage.persist();
      this.state = granted ? "yes" : "no";
    } catch (error) {
      this.state = "no";
    }
    return this.state;
  },

  message() {
    if (this.state === "yes") return "✓ Biblioteca protegida: Android no debería borrarla aunque falte espacio.";
    if (this.state === "unsupported") return "Este navegador no informa si protege tus datos. Evita borrar los datos del sitio en Ajustes de Android.";
    return "⚠ El navegador aún no protege tu biblioteca: si el teléfono se queda sin espacio podría borrarla. Instala Pulsar RM en la pantalla de inicio (menú ⋮ de Chrome → Instalar app) para que quede protegida.";
  }
};

/* =========================================================
   ROUTER — navegación entre pantallas (usa #hash: el botón Atrás de Android funciona)
   ========================================================= */
const Router = {
  views: ["home", "library", "player", "eq", "immersive", "settings"],
  current: "home",
  previous: "home",
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
    if (name === "immersive" && Player.currentId === null) { // al recargar en #immersive no hay nada sonando
      history.replaceState(null, "", "#player");
      name = "player";
    }
    if (name !== this.current) this.previous = this.current;
    this.current = name;
    Immersive.sync(name);
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
      editAlbum: $("edit-album"),
      editFile: $("edit-file"),
      coverFile: $("cover-file"),
      playerTitle: $("player-title"),
      playerArtist: $("player-artist"),
      progress: $("progress"),
      currentTime: $("current-time"),
      duration: $("duration"),
      storageInfo: $("storage-info"),
      persistInfo: $("persist-info"),
      imProgress: $("im-progress"),
      imCurrent: $("im-current"),
      imDuration: $("im-duration"),
      imTitle: $("im-title"),
      imArtist: $("im-artist"),
      imCover: $("im-cover"),
      imView: $("view-immersive"),
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

    [this.el.editName, this.el.editArtist, this.el.editAlbum].forEach((input) => {
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

    [this.el.progress, this.el.imProgress].forEach((progress) => {
      progress.addEventListener("input", () => {
        Player.seeking = true;
        const duration = Player.audio.duration;
        if (Number.isFinite(duration)) {
          const text = this.formatTime((progress.value / 1000) * duration);
          this.el.currentTime.textContent = text;
          this.el.imCurrent.textContent = text;
        }
      });
      progress.addEventListener("change", () => {
        Player.seekTo(progress.value / 1000);
        Player.seeking = false;
      });
    });
  },

  handleAction(action) {
    switch (action) {
      case "import": this.el.fileInput.click(); break;
      case "toggle": Player.toggle(); break;
      case "next": Player.next(); break;
      case "shuffle": Player.toggleShuffle(); break;
      case "repeat": Player.cycleRepeat(); break;
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
      case "edit-read-tags": Editor.readFromAudio(); break;
      case "rescan": Library.rescanTags(); break;
      case "immersive-open": Immersive.open(); break;
      case "immersive-close": Immersive.close(); break;
      case "immersive-mode": Immersive.toggleMode(); break;
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
    await Persistence.check(true);
    this.el.persistInfo.textContent = Persistence.message();
    this.el.persistInfo.classList.toggle("warn", Persistence.state === "no");
  },

  /* ---------- Reproductor ---------- */

  showNowPlaying(song) {
    this.refreshNowPlayingInfo(song);
    this.el.progress.value = 0;
    this.el.imProgress.value = 0;
    this.el.currentTime.textContent = "0:00";
    this.el.imCurrent.textContent = "0:00";
    this.el.duration.textContent = this.formatTime(song.duration);
    this.el.imDuration.textContent = this.formatTime(song.duration);
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
    this.setCover(this.el.imCover, null);
    Immersive.setArt(null);
    this.el.imTitle.textContent = "Sin reproducción";
    this.el.imArtist.textContent = "Pulsar RM";
    this.el.progress.value = 0;
    this.el.imProgress.value = 0;
    this.el.currentTime.textContent = "0:00";
    this.el.imCurrent.textContent = "0:00";
    this.el.duration.textContent = "0:00";
    this.el.imDuration.textContent = "0:00";
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
    if (this.el.imView) this.el.imView.classList.toggle("is-playing", playing);
    Immersive.updateWake();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    }
  },

  updateModes() {
    const labels = { off: "Repetir: desactivado", all: "Repetir: toda la biblioteca", one: "Repetir: esta canción" };
    document.querySelectorAll('[data-action="shuffle"]').forEach((button) => {
      button.classList.toggle("on", Player.shuffle);
      button.setAttribute("aria-pressed", String(Player.shuffle));
      button.setAttribute("aria-label", Player.shuffle ? "Aleatorio: activado" : "Aleatorio: desactivado");
    });
    document.querySelectorAll('[data-action="repeat"]').forEach((button) => {
      button.classList.toggle("on", Player.repeat !== "off");
      button.classList.toggle("one", Player.repeat === "one");
      button.setAttribute("aria-pressed", String(Player.repeat !== "off"));
      button.setAttribute("aria-label", labels[Player.repeat]);
    });
  },

  updateProgress() {
    if (Player.seeking) return;
    const duration = Player.audio.duration;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const value = hasDuration ? (Player.audio.currentTime / duration) * 1000 : 0;
    const text = this.formatTime(Player.audio.currentTime);
    this.el.progress.value = value;
    this.el.imProgress.value = value;
    this.el.currentTime.textContent = text;
    this.el.imCurrent.textContent = text;
  },

  setDuration(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) {
      this.el.duration.textContent = this.formatTime(seconds);
      this.el.imDuration.textContent = this.formatTime(seconds);
    }
  },

  updateMiniPlayer() {
    const visible = Player.currentId !== null && !["player", "eq", "immersive"].includes(Router.current);
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
    const byline = song.album ? `${song.artist} · ${song.album}` : song.artist;
    this.el.playerArtist.textContent = byline;
    this.el.imTitle.textContent = title;
    this.el.imArtist.textContent = byline;
    this.el.miniTitle.textContent = title;
    this.el.miniArtist.textContent = song.artist;
    const url = Covers.get(song);
    this.setCover(this.el.bigCover, url);
    this.setCover(this.el.miniCover, url);
    this.setCover(this.el.imCover, url);
    Immersive.setArt(url);
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
    UI.el.editAlbum.value = song.album || "";
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
    UI.el.editAlbum.value = "";
  },

  // Rellena el formulario con las etiquetas y la portada incrustadas en el archivo de audio.
  async readFromAudio() {
    const song = Library.byId(this.songId);
    if (!song) return;
    const blob = await Store.getBlob(song.id);
    if (!blob) { UI.toast("No se encontró el archivo de esta canción."); return; }
    const tags = await Metadata.read(blob);
    if (!tags.title && !tags.artist && !tags.album && !tags.picture) {
      UI.toast("Este archivo no trae etiquetas ni portada.");
      return;
    }
    if (tags.title) UI.el.editName.value = tags.title;
    if (tags.artist) UI.el.editArtist.value = tags.artist;
    if (tags.album) UI.el.editAlbum.value = tags.album;
    if (tags.picture) {
      try {
        this.pendingCover = await this.makeCoverBlob(new Blob([tags.picture.data], { type: tags.picture.mime }));
        this.coverChanged = true;
        this.renderPreview();
      } catch (error) { console.warn("Portada incrustada no válida:", error); }
    }
    UI.toast("Etiquetas leídas. Toca Guardar para aplicarlas.");
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
    const previous = { name: song.name, artist: song.artist, album: song.album, cover: song.cover, userEdited: song.userEdited };
    song.name = UI.el.editName.value.trim() || parsed.title;
    song.artist = UI.el.editArtist.value.trim() || parsed.artist;
    song.album = UI.el.editAlbum.value.trim();
    song.userEdited = true; // la relectura de etiquetas ya no cambiará título ni artista
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
      song.album = previous.album;
      song.userEdited = previous.userEdited;
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
  Immersive.init();
  Router.init();
  UI.renderAll();

  await Store.open();
  Persistence.check(true); // pide protección para la biblioteca (no hace falta esperarla)
  await Settings.load();
  Equalizer.loadSaved();
  await Library.load();
  Player.loadPrefs();
  UI.renderAll();

  if (!Store.available) {
    UI.toast("Este navegador no permite guardar la biblioteca; se perderá al cerrar.");
  }
  console.log("Pulsar RM " + APP_VERSION + " iniciado correctamente 💜");
});
