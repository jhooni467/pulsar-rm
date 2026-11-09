/* PULSAR RM 1.04 — Pantallas secundarias (Letras, Cola, Ecualizador, Información), cola real, mezcla con crossfade,
   temporizador, segundo plano en Android, biblioteca por carpetas, tasa de refresco y Ajustes reorganizados.
   Archivos: native.js (puente con Android) · script.js (núcleo) · features.js (módulos de la v1.04)
   Módulos del núcleo: Store (IndexedDB) · Settings · CoverColor · Lyrics · Queue · AudioGraph · Equalizer · Library · Player · Router · UI
   Todos los botones usan delegación de eventos: siguen funcionando aunque el HTML se vuelva a dibujar. */

"use strict";

// ÚNICO lugar donde se escribe la versión. El workflow de GitHub la lee de aquí para
// el versionName y el versionCode del APK. Formato: "X.YY" (ej. 1.04 → versionCode 104).
const APP_VERSION = "1.04";

// Si el APK expone PulsarNative.getVersion(), se muestra la versión REAL instalada;
// si no, se usa la constante de arriba.
function resolveAppVersion() {
  try {
    if (window.PulsarNative && typeof window.PulsarNative.getVersion === "function") {
      const native = String(window.PulsarNative.getVersion() || "").trim();
      if (native) return native;
    }
  } catch (error) { /* se usa la constante */ }
  return APP_VERSION;
}
const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "weba"];

const $ = (id) => document.getElementById(id);

/* =========================================================
   ICONOS — SVG propios (se ven igual en todos los teléfonos)
   Reemplazan a los emojis y símbolos de texto, que Android dibuja distinto.
   ========================================================= */
const Icons = {
  play: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5v14l12-7z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  pause: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.5 12.5l3.8 3.8 7.2-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  note: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></g></svg>',
  x: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // Portada predeterminada (canciones sin portada): usa los colores del tema y modo activos
  art: '<svg class="art-default" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><circle class="art-glow" cx="80" cy="20" r="48"/><circle class="art-ring" cx="50" cy="50" r="42"/><circle class="art-ring art-ring-2" cx="50" cy="50" r="29"/><g transform="translate(34 34) scale(1.36)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path class="art-note" d="M9 18V6l10-2v12"/><circle class="art-note" cx="6.5" cy="18" r="2.5"/><circle class="art-note" cx="16.5" cy="16" r="2.5"/></g></svg>'
};

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
      if (blob) this.memory.blobs.set(meta.id, blob);
      return Promise.resolve(meta);
    }
    return this._tx(["songs", "blobs"], "readwrite", (tx, done) => {
      const request = tx.objectStore("songs").add(meta);
      request.onsuccess = () => {
        meta.id = request.result;
        if (blob) tx.objectStore("blobs").put(blob, meta.id); // las canciones de carpetas no guardan copia del archivo
        done(meta);
      };
    });
  },

  // v1.04 — varias canciones en una sola transacción (lectura de carpetas)
  addSongs(list) {
    if (!list.length) return Promise.resolve(list);
    if (!this.available) {
      list.forEach((meta) => { meta.id = this.memory.nextId++; this.memory.songs.set(meta.id, meta); });
      return Promise.resolve(list);
    }
    return this._tx("songs", "readwrite", (tx, done) => {
      const store = tx.objectStore("songs");
      let pending = list.length;
      list.forEach((meta) => {
        const request = store.add(meta);
        request.onsuccess = () => { meta.id = request.result; if (--pending === 0) done(list); };
      });
    });
  },

  updateSongs(list) {
    if (!list.length) return Promise.resolve(list);
    if (!this.available) { list.forEach((meta) => this.memory.songs.set(meta.id, meta)); return Promise.resolve(list); }
    return this._tx("songs", "readwrite", (tx, done) => {
      const store = tx.objectStore("songs");
      list.forEach((meta) => store.put(meta));
      done(list);
    });
  },

  removeSongs(ids) {
    if (!ids.length) return Promise.resolve();
    if (!this.available) { ids.forEach((id) => { this.memory.songs.delete(id); this.memory.blobs.delete(id); }); return Promise.resolve(); }
    return this._tx(["songs", "blobs"], "readwrite", (tx) => {
      ids.forEach((id) => { tx.objectStore("songs").delete(id); tx.objectStore("blobs").delete(id); });
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
  defaults: {
    theme: "pulsar", mode: "dark", eq: { enabled: false, preset: "flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    // v1.03
    coverColor: false,        // la app toma el color de la portada que suena
    coverIntensity: "medium", // low | medium | high
    hideStatusBar: false,     // oculta la barra de estado de Android
    lyricsAnim: "flow",       // flow | glow | letters
    lyricsFont: "default",    // ver LYRIC_FONTS ("custom" = fuente importada)
    lyricsFontFile: null,     // { name, data } de la fuente importada
    lyricsSize: "medium",     // small | medium | large
    lyricsDuet: true,         // cantante principal a la izquierda, secundario a la derecha
    lyricsBlur: true,         // desenfoca suavemente las líneas lejanas
    // v1.04 — letras
    lyricsView: "sync",       // sync (sincronizada) | plain (texto normal, sin resaltado)
    lyricsAutoScroll: true,   // la letra se desplaza sola siguiendo la canción
    lyricsSpacing: "normal",  // compact | normal | wide
    lyricsBg: "theme",        // theme | cover (portada difuminada de fondo)
    keepScreenOn: false,      // pantalla encendida mientras se ve la letra
    // v1.04 — reproducción
    shuffle: false,           // reproducción aleatoria
    repeat: "all",            // off | all | one  (all = como en la v1.03: al acabar vuelve al principio)
    prevRestart: true,        // "Anterior" reinicia la canción si ya pasaron 3 s
    gapless: true,            // reproducción continua: la siguiente ya está lista al acabar
    crossfade: false,         // fundido cruzado entre canciones
    crossfadeSecs: 4,         // duración del fundido (1 a 12 s)
    bgPlayback: true,         // música en segundo plano
    focusMode: "duck",        // al llegar un aviso de otra app: duck (bajar volumen) | pause
    pauseOnNoisy: true,       // pausar al desconectar auriculares
    // v1.04 — audio
    limiter: true,            // limitador de picos (evita la saturación)
    mono: false,              // mezcla izquierda y derecha en un solo canal
    balance: 0,               // -1 (izquierda) a 1 (derecha)
    // v1.04 — biblioteca
    folders: [],              // carpetas autorizadas [{ uri, name, addedAt, lastScan, count }]
    ignoredKeys: [],          // archivos de carpetas que el usuario quitó de la biblioteca
    lastScan: null,           // resumen de la última actualización
    libTab: "songs",          // songs | albums | artists | genres
    // v1.04 — rendimiento y pantalla
    refreshHz: 0,             // 0 = automático (lo decide el dispositivo) | 60 | 90 | 120
    animations: "full",       // full | reduced | off
    visualFx: true,           // desenfoques y resplandores
    fpsCap: "auto",           // auto | 30 | 60 (cuántos cuadros por segundo dibujan las animaciones de la app)
    // v1.04 — avisos de una sola vez
    notifAsked: false,        // ya se pidió el permiso de notificaciones
    perfInit: false           // ya se revisó si el dispositivo necesita el modo ligero
  },
  values: {},
  watchers: {},

  // Los módulos se suscriben a los ajustes que usan: Settings.watch("crossfade", (valor) => …)
  watch(keys, handler) {
    (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
      (this.watchers[key] = this.watchers[key] || []).push(handler);
    });
  },

  notify(key, initial) {
    (this.watchers[key] || []).forEach((handler) => {
      try { handler(this.values[key], key, Boolean(initial)); } catch (error) { console.error("Ajuste", key, error); }
    });
  },

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
    StatusBar.apply(false);
    LyricsStyle.restoreFont();
    LyricsStyle.apply();
    Object.keys(this.watchers).forEach((key) => this.notify(key, true)); // cada módulo aplica lo que había guardado
    UI.refreshSettingsControls();
  },

  async set(key, value) {
    this.values[key] = value;
    // Solo el tema y el modo repintan la app y avisan a Android (barras, icono).
    // Mover una barra del ecualizador no debe disparar todo eso en cada ajuste.
    if (key === "theme" || key === "mode") this.apply();
    this.changed(key);
    try { await Store.setSetting(key, value); } catch (error) { console.warn(error); }
  },

  // Cada ajuste nuevo avisa al módulo que lo usa
  changed(key) {
    if (key === "coverColor") CoverColor.update(CoverColor.song);
    else if (key === "coverIntensity") CoverColor.sync();
    else if (key === "hideStatusBar") StatusBar.apply(true);
    else if (key.startsWith("lyrics")) LyricsStyle.apply();
    this.notify(key, false);
    UI.refreshSettingsControls();
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
    CoverColor.sync();      // los porcentajes de color dependen del modo
    NativeBars.syncSoon();  // las barras de Android esperan a que termine el desvanecido
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

  /* Cantantes (duetos). Admite los marcadores de Apple Music y del LRC mejorado:
       V1: V2: V1000:  ·  [V1]  ·  M: F: D:  ·  <v Nombre> (VTT).
     Devuelve { id, rest } o null. Las marcas de tiempo <mm:ss.xx> que vayan antes se conservan. */
  SPEAKER: /^((?:<[^>]*>)*\s*)(?:\[\s*)?(?:([Vv]\d{1,4})|([MFD]))\s*\]?\s*[:：]\s*/,
  SPEAKER_ONLY: /^\s*(?:\[\s*)?(?:([Vv]\d{1,4})|([MFD]))\s*\]?\s*[:：]\s*$/,

  takeSpeaker(row) {
    const m = row.match(this.SPEAKER);
    if (!m) return null;
    return { id: (m[2] || m[3]).toLowerCase(), rest: m[1] + row.slice(m[0].length) };
  },

  // Lado de la pantalla de cada línea: V1 = izquierda (principal), V2 y siguientes = derecha,
  // V1000 / D = centro (los dos cantan). Con M: y F:, el primero en cantar va a la izquierda.
  assignSides(lines) {
    const order = [];
    lines.forEach((line) => {
      const id = line.spk;
      let side = "l";
      if (id) {
        const v = id.match(/^v(\d+)$/);
        if (v) {
          const n = Number(v[1]);
          side = n >= 1000 ? "c" : n === 1 ? "l" : "r";
        } else if (id === "d") {
          side = "c";
        } else {
          if (!order.includes(id)) order.push(id);
          side = order.indexOf(id) === 0 ? "l" : "r";
        }
      }
      line.side = side;
      // Voces de fondo, como en Apple Music: toda la línea entre paréntesis
      line.bg = /^[(（].*[)）]$/.test(line.text || "");
    });
    return lines.some((line) => line.side !== "l");
  },

  /* Palabras (o sílabas) listas para animar: si un mismo tiempo cubre varias palabras, se
     reparte por letras. Cada unidad: { t, end, text, sb (espacio antes), sa (espacio después) }. */
  units(line) {
    if (line.units) return line.units;
    const out = [];
    (line.words || []).forEach((w) => {
      const parts = String(w.text).split(/(\s+)/).filter((part) => part !== "");
      const items = [];
      let leading = false;
      parts.forEach((part) => {
        if (/^\s+$/.test(part)) {
          if (items.length) items[items.length - 1].sa = true; else leading = true;
        } else {
          items.push({ text: part, sb: false, sa: false });
        }
      });
      if (!items.length) return;
      if (leading) items[0].sb = true;
      const total = items.reduce((sum, item) => sum + Array.from(item.text).length, 0) || 1;
      let used = 0;
      items.forEach((item) => {
        const size = Array.from(item.text).length;
        item.t = w.t + ((w.end - w.t) * used) / total;
        item.end = w.t + ((w.end - w.t) * (used + size)) / total;
        used += size;
        out.push(item);
      });
    });
    line.units = out;
    return out;
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
    let sticky = null;
    const lines = [];
    rows.forEach((row) => {
      if (this.SPEAKER_ONLY.test(row)) { sticky = (row.match(this.SPEAKER_ONLY)[1] || row.match(this.SPEAKER_ONLY)[2]).toLowerCase(); return; }
      const sp = this.takeSpeaker(row);
      if (sp) sticky = sp.id;
      lines.push({ t: null, text: sp ? sp.rest.trim() : row, words: null, spk: sticky });
    });
    const duet = this.assignSides(lines);
    return { format: "txt", synced: false, wordLevel: false, duet, metaOffset: 0, meta: {}, lines };
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
    let offset = 0, order = 0, sticky = null;
    text.split("\n").forEach((rawLine) => {
      let row = rawLine.trim();
      if (!row) return;

      // Línea que solo dice quién canta ("V2:"): vale para las siguientes
      const only = row.match(this.SPEAKER_ONLY);
      if (only) { sticky = (only[1] || only[2]).toLowerCase(); return; }

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

      const sp = this.takeSpeaker(row.trim());
      if (sp) sticky = sp.id;
      const parsed = this.parseInline(sp ? sp.rest.trim() : row.trim(), stamps[0]);
      if (sp && !parsed.text && !parsed.words) return; // "[00:30.00]V2:" sin letra: solo cambia de cantante
      stamps.forEach((stamp) => {
        const delta = stamp - stamps[0];
        lines.push({
          t: stamp,
          spk: sticky,
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
    let order = 0, sticky = null;
    text.split(/\n{2,}/).forEach((block) => {
      const rows = block.split("\n");
      const at = rows.findIndex((row) => timeRe.test(row));
      if (at < 0) return;
      const match = rows[at].match(timeRe);
      const start = this.parseCueTime(match[1]);
      const end = this.parseCueTime(match[2]);
      let body = rows.slice(at + 1).join(" ");
      let voice = null;
      const tagged = body.match(/<v(?:\.[^>\s]*)?\s+([^>]+)>/i); // VTT: <v Nombre>
      if (tagged) voice = tagged[1].trim().toLowerCase();
      body = body
        .replace(/\{[^}]*\}/g, "")
        .replace(/<\/?(?:c|v|i|b|u|ruby|rt|lang)(?:\.[^>\s]*)?(?:\s[^>]*)?>/gi, "")
        .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        .replace(/\s+/g, " ").trim();
      if (!body) return;
      const sp = this.takeSpeaker(body);
      if (sp) { voice = sp.id; body = sp.rest.trim(); }
      if (voice) sticky = voice;
      const parsed = this.parseInline(body, start);
      if (!parsed.text && !parsed.words) return;
      lines.push({ t: start, order: order++, spk: sticky, text: parsed.text, words: parsed.words, end });
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
    const duet = this.assignSides(lines);
    return { ...info, lines, duet, wordLevel: lines.some((line) => line.words) };
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
    // Se trabaja en centésimas enteras: con decimales, 1.15 s salía como 00:01.14.
    const total = Math.floor(Math.max(0, seconds) * 100 + 1e-6);
    const m = Math.floor(total / 6000);
    const s = Math.floor(total / 100) % 60;
    const cs = total % 100;
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
      return { bg: "#FFFFFF", surface: mixHex(theme.accentLight, "#F6F6F9", 0.03), accent: theme.accentLight };
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
          <span class="swatch-check" aria-hidden="true">${Icons.check}</span>
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
   BARRAS DEL SISTEMA (solo APK) — la barra de estado y la de navegación de Android
   toman el color de la app (adiós a la franja negra) y sus iconos se ven claros u oscuros
   según el modo. Si no hay puente nativo (navegador), no hace nada.
   ========================================================= */
const NativeBars = {
  timer: 0,

  sync(mode) {
    try {
      const css = getComputedStyle(document.documentElement);
      // Los colores animados (@property) se devuelven como rgb(): se pasan a #RRGGBB
      const status = cssToHex(css.getPropertyValue("--bg"));
      const nav = cssToHex(css.getPropertyValue("--nav-bg")) || status;
      if (!status) return;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", status);
      if (!window.PulsarNative || typeof window.PulsarNative.setBars !== "function") return;
      window.PulsarNative.setBars(status, nav, mode.id === "light"); // true = iconos oscuros (fondo claro)
    } catch (error) { console.warn("No se pudieron ajustar las barras del sistema", error); }
  },

  // Con el desvanecido de colores (0.7 s) hay que esperar a que termine para leer el color final.
  syncSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.sync(MODES.find((item) => item.id === Settings.values.mode) || MODES[1]);
    }, 780);
  }
};

/* Convierte cualquier color CSS (rgb(), color(srgb …), oklab(…), #abc…) a #RRGGBB. Vacío si no puede.
   Los colores animados (@property) llegan en formatos como color(srgb …) u oklab(…): se leen pintando un píxel. */
function cssToHex(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  if (!text) return "";
  try {
    const canvas = cssToHex.canvas || (cssToHex.canvas = document.createElement("canvas"));
    canvas.width = canvas.height = 1;
    const ctx = cssToHex.ctx || (cssToHex.ctx = canvas.getContext("2d", { willReadFrequently: true }));
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#010203";   // si el color no se entiende, queda este
    ctx.fillStyle = text;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 255 && !(r === 1 && g === 2 && b === 3)) {
      return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
    }
  } catch (error) { /* se prueba el formato rgb() */ }
  const m = text.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
  return m ? "#" + [m[1], m[2], m[3]].map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join("").toUpperCase() : "";
}

/* =========================================================
   BARRA DE ESTADO (v1.03) — ocultarla en Ajustes
   En el APK lo hace Android (PulsarNative.setStatusBarHidden); la barra vuelve a verse
   un momento al deslizar desde arriba. En el navegador se usa la pantalla completa.
   ========================================================= */
const StatusBar = {
  native() {
    return Boolean(window.PulsarNative && typeof window.PulsarNative.setStatusBarHidden === "function");
  },

  // fromUser = la persona acaba de tocar el interruptor (el navegador solo permite pantalla completa con un toque)
  apply(fromUser) {
    const hide = Boolean(Settings.values.hideStatusBar);
    try {
      if (this.native()) {
        window.PulsarNative.setStatusBarHidden(hide);
      } else if (fromUser) {
        const root = document.documentElement;
        if (hide && !document.fullscreenElement && root.requestFullscreen) {
          root.requestFullscreen({ navigationUI: "hide" }).catch(() => UI.toast("Este navegador no permite la pantalla completa."));
        } else if (!hide && document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
    } catch (error) { console.warn("No se pudo cambiar la barra de estado", error); }
  }
};

/* =========================================================
   COLOR DE PORTADA (v1.03)
   Saca el color principal de la portada de la canción que suena y la app se tiñe de él en
   tiempo real. La mezcla la hace style.css (variables --cv y --t-…); aquí solo se calcula el
   color y cuánto se mezcla según la intensidad: Bajo, Medio o Fuerte.
   Los cambios se desvanecen solos (colores registrados con @property).
   ========================================================= */
const CoverColor = {
  song: null,
  cache: new Map(), // url de portada → { h, s, l } (o null si no hay color)
  token: 0,
  current: null,

  // [fondo, superficies/tarjetas, líneas] que se mezclan con el color de la portada, por modo.
  // Amoled nunca tiñe el fondo: el negro puro se conserva.
  TINTS: {
    dark:   { low: [0.04, 0.05, 0.04], medium: [0.12, 0.14, 0.10], high: [0.24, 0.26, 0.18] },
    amoled: { low: [0, 0.02, 0.02],    medium: [0, 0.07, 0.06],    high: [0, 0.16, 0.12] },
    light:  { low: [0, 0.02, 0.03],    medium: [0, 0.05, 0.06],    high: [0.06, 0.11, 0.12] }
  },
  ACCENT: { low: 0.6, medium: 0.9, high: 1 }, // cuánto del acento del tema se cambia por el color de la portada

  async update(song) {
    this.song = song || null;
    const token = ++this.token;
    const url = song && Settings.values.coverColor ? Covers.get(song) : null;
    if (!url) {
      this.current = null;
      this.sync();
      return;
    }
    let color = this.cache.get(url);
    if (color === undefined) {
      color = await this.extract(url);
      this.cache.set(url, color);
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    }
    if (token !== this.token) return; // ya cambió la canción mientras se leía la imagen
    this.current = color;
    this.sync();
  },

  extract(url) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const size = 40;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(image, 0, 0, size, size);
          resolve(this.pick(ctx.getImageData(0, 0, size, size).data));
        } catch (error) { resolve(null); }
      };
      image.onerror = () => resolve(null);
      image.src = url;
    });
  },

  // Elige el color "protagonista": el tono más presente, dando más peso a lo colorido y de brillo medio.
  pick(data) {
    const bins = Array.from({ length: 24 }, () => ({ w: 0, n: 0, r: 0, g: 0, b: 0 }));
    let total = 0, nr = 0, ng = 0, nb = 0, nn = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [h, s, l] = CoverColor.rgbToHsl(r, g, b);
      total++;
      if (l < 0.1 || l > 0.93) continue; // casi negro o casi blanco
      if (s < 0.14) { nr += r; ng += g; nb += b; nn++; continue; }
      const w = (0.05 + s * s) * (1 - Math.abs(l - 0.5) * 0.9);
      const bin = bins[Math.min(23, Math.floor(h * 24))];
      bin.w += w; bin.n++; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
    let best = bins[0];
    bins.forEach((bin) => { if (bin.w > best.w) best = bin; });
    if (best.n && best.n >= total * 0.04) {
      const [h, s, l] = this.rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
      return { h, s: Math.min(0.9, Math.max(0.5, s)), l };
    }
    if (nn) { // portada en grises o blanco y negro
      const [h, , l] = this.rgbToHsl(nr / nn, ng / nn, nb / nn);
      return { h, s: 0.06, l };
    }
    return null;
  },

  rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [((h / 6) + 1) % 1, s, l];
  },

  hslToHex(h, s, l) {
    const k = (n) => (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  },

  sync() {
    const root = document.documentElement;
    const values = Settings.values;
    const color = values.coverColor ? this.current : null;
    if (color) {
      // Dos versiones del color: clara (para Dark y Amoled) y oscura (para Light)
      const grey = color.s < 0.15;
      root.style.setProperty("--cv", this.hslToHex(color.h, color.s, grey ? 0.78 : 0.68));
      root.style.setProperty("--cv-d", this.hslToHex(color.h, color.s, grey ? 0.34 : 0.4));
    }
    const mode = root.getAttribute("data-mode") || "dark";
    const level = this.ACCENT[values.coverIntensity] !== undefined ? values.coverIntensity : "medium";
    const [bg, surface, line] = color ? this.TINTS[mode][level] : [0, 0, 0];
    root.style.setProperty("--t-acc", color ? this.ACCENT[level] : 0);
    root.style.setProperty("--t-bg", bg);
    root.style.setProperty("--t-s", surface);
    root.style.setProperty("--t-l", line);
    NativeBars.syncSoon();
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
  unitEls: [],
  units: [],
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

    // Solo cuentan los avisos del reproductor que está sonando (con dos decks, el otro puede estar preparando la siguiente)
    Player.onActive("play", () => this.refresh(false));
    Player.onActive("pause", () => this.update(false));
    Player.onActive("seeked", () => this.update(false));
    Player.onActive("ended", () => this.update(false));
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
    // Canciones de carpetas: la letra puede estar en un .lrc junto al archivo o dentro de él (Android la lee ahora)
    if (song && !song.lyrics && typeof LyricsScreen !== "undefined") LyricsScreen.fetchNative(song);
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

  // La letra se ve en su propia pantalla (v1.04)
  visible() {
    return Boolean(this.el) && Router.current === "lyrics";
  },

  // ¿Se muestra sincronizada? Una letra con tiempos se puede ver también como texto normal (Ajustes → Letras)
  live() {
    return Boolean(this.data && this.data.synced && Settings.values.lyricsView !== "plain");
  },

  shouldRun() {
    return this.visible() && this.live() && Player.currentId !== null &&
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
    let last = 0;
    const tick = (now) => {
      this.raf = 0;
      if (!this.shouldRun()) return;
      const gap = Performance.frameGap(); // límite de FPS (Ajustes → Rendimiento)
      if (!gap || now - last >= gap) { last = now; this.update(false); }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  /* ---------- Dibujo ---------- */

  render() {
    if (!this.el) return;
    const data = this.data;
    this.lineEls = [];
    this.unitEls = [];
    this.units = [];

    const live = this.live();
    this.el.classList.toggle("is-empty", !data);
    this.bar.classList.toggle("no-data", !data);
    this.bar.classList.toggle("no-sync", !live);
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
      const seek = live ? ` data-i="${i}"` : "";
      const side = ` s${line.side || "l"}${line.bg ? " bg" : ""}${line.words ? "" : " nw"}`;
      if (!line.text && !line.words) {
        return live
          ? `<p class="lyric-line gap${side}"${seek}>${Icons.note}</p>`
          : `<p class="lyric-line plain gap">&nbsp;</p>`;
      }
      // Como texto normal no se necesita el dibujo palabra por palabra
      const inner = line.words && live ? this.wordsHTML(line) : UI.escapeHTML(line.text);
      return `<p class="lyric-line${live ? "" : " plain"}${side}"${seek}>${inner}</p>`;
    }).join("");
    this.lineEls = Array.from(this.el.querySelectorAll(".lyric-line"));
    this.unitEls = [];
    this.units = [];
    this.el.scrollTop = 0;
  },

  /* Palabra por palabra: cada palabra es un bloque que no se parte al cambiar de renglón;
     dentro van sus sílabas (.lw). En la animación "Letra por letra" cada sílaba se reparte en letras (.lc).
     El color y el brillo se dibujan en una capa encima (::before / ::after) que se revela con --n (0 a 1). */
  wordsHTML(line) {
    const letters = LyricsStyle.anim() === "letters";
    const esc = (text) => UI.escapeHTML(text);
    let html = "", open = false, prev = null;
    LyricsParser.units(line).forEach((unit) => {
      const joined = prev && !prev.sa && !unit.sb;
      if (!joined) {
        if (open) html += "</span>";
        if (prev) html += " ";
        html += '<span class="wd">';
        open = true;
      }
      html += letters
        ? `<span class="lw">${Array.from(unit.text).map((c) => `<span class="lc" data-t="${esc(c)}">${esc(c)}</span>`).join("")}</span>`
        : `<span class="lw" data-t="${esc(unit.text)}">${esc(unit.text)}</span>`;
      prev = unit;
    });
    if (open) html += "</span>";
    return html;
  },

  // Dibuja el avance de las palabras (o letras) de la línea activa. Lo usa también la vista previa de Ajustes.
  paint(unitEls, units, time, letters) {
    const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
    const set = (el, value) => {
      const text = value.toFixed(3);
      if (el._n !== text) { el._n = text; el.style.setProperty("--n", text); }
    };
    units.forEach((unit, j) => {
      const el = unitEls[j];
      if (!el) return;
      const span = Math.max(0.05, unit.end - unit.t);
      const p = clamp((time - unit.t) / span);
      const current = p > 0 && p < 1;
      if (el._cur !== current) { el._cur = current; el.classList.toggle("cur", current); }
      if (!letters) { set(el, p); return; }
      const chars = el.children, count = chars.length || 1;
      for (let k = 0; k < chars.length; k++) {
        const start = unit.t + (span * k) / count;
        const length = Math.max(0.12, span / count);
        set(chars[k], clamp((time - start) / length));
      }
    });
  },

  updateBar() {
    const data = this.data;
    if (!data) this.badge.textContent = "Sin letra";
    else if (!data.synced) this.badge.textContent = "Texto sin sincronizar";
    else if (!this.live()) this.badge.textContent = `${this.FORMAT_NAMES[data.format] || "LRC"} · vista de texto`;
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
    if (!data || !this.live() || !this.visible()) return;

    const time = Player.audio.currentTime - this.shift();
    const index = this.find(time);

    if (index !== this.active || force) {
      this.active = index;
      this.lineEls.forEach((el, i) => {
        el.classList.toggle("active", i === index);
        el.classList.toggle("past", i < index);
        el.style.setProperty("--d", Math.min(5, Math.abs(i - index))); // distancia a la línea activa (desenfoque)
      });
      this.unitEls = index >= 0 && this.lineEls[index]
        ? Array.from(this.lineEls[index].querySelectorAll(".lw"))
        : [];
      this.units = index >= 0 && data.lines[index].words ? LyricsParser.units(data.lines[index]) : [];
      this.center(index, force);
    }

    if (this.needsCenter && Date.now() >= this.userScrollUntil) this.center(this.active, false);

    if (index >= 0 && this.units.length) this.paint(this.unitEls, this.units, time, LyricsStyle.anim() === "letters");
  },

  center(index, instant, manual) {
    if (index < 0 || !this.lineEls[index]) return;
    // Desplazamiento automático apagado: solo se centra cuando la persona lo pide (botón «Centrar»)
    if (!instant && !manual && Settings.values.lyricsAutoScroll === false) return;
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

  // Botón «Centrar»: vuelve a la línea que suena aunque el desplazamiento automático esté apagado
  recenter() {
    this.userScrollUntil = 0;
    if (this.active >= 0) this.center(this.active, false, true);
  },

  seekToLine(index) {
    const line = this.data && this.data.lines[index];
    if (!line || Player.currentId === null || !this.live()) return;
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

  // `target` = canción a la que pertenece la letra. El editor lo manda para que, si la
  // reproducción pasa a otra canción con el editor abierto, la letra no se guarde en la equivocada.
  async saveRaw(raw, target) {
    const song = target || this.song;
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
    if (this.song && this.song.id === song.id) this.load(song); // solo se redibuja si es la que está sonando
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
   ESTILO DE LAS LETRAS (v1.03) — animación, fuente, tamaño, duetos y desenfoque (Ajustes → Letras)
   Los valores van en atributos de <html> (data-lanim…) y variables CSS; style.css hace el resto.
   ========================================================= */
const LYRIC_ANIMS = [
  { id: "flow", name: "Fluida", hint: "La letra se llena de color con un degradado suave." },
  { id: "glow", name: "Fluida con glow", hint: "Igual de fluida, con un brillo que acompaña a cada palabra." },
  { id: "letters", name: "Letra por letra", hint: "Cada letra se enciende y sube un poquito al cantarse." }
];
const LYRIC_FONTS = [
  { id: "default", name: "Predeterminada", stack: "inherit", weight: 700 },
  { id: "condensed", name: "Condensada", stack: '"sans-serif-condensed", "Roboto Condensed", "Arial Narrow", sans-serif', weight: 700 },
  { id: "black", name: "Gruesa", stack: '"sans-serif-black", "Roboto Black", "Arial Black", sans-serif', weight: 900 },
  { id: "serif", name: "Elegante", stack: 'Georgia, "Noto Serif", "Times New Roman", serif', weight: 700 },
  { id: "script", name: "Manuscrita", stack: '"Dancing Script", "Segoe Script", cursive', weight: 700 },
  { id: "mono", name: "Máquina", stack: '"Courier New", "Droid Sans Mono", monospace', weight: 700 }
];
const LYRIC_SIZES = { small: 20, medium: 24, large: 29 };

const LyricsStyle = {
  last: "",
  face: null,

  anim() {
    const id = Settings.values.lyricsAnim;
    return LYRIC_ANIMS.some((item) => item.id === id) ? id : "flow";
  },

  fontStack() {
    const id = Settings.values.lyricsFont;
    if (id === "custom" && this.face) return { stack: '"PulsarLyrics", sans-serif', weight: 700 };
    return LYRIC_FONTS.find((item) => item.id === id) || LYRIC_FONTS[0];
  },

  apply() {
    const values = Settings.values;
    const root = document.documentElement;
    const anim = this.anim();
    root.setAttribute("data-lanim", anim);
    root.setAttribute("data-lblur", values.lyricsBlur === false ? "off" : "on");
    root.setAttribute("data-lduet", values.lyricsDuet === false ? "off" : "on");
    const view = values.lyricsView === "plain" ? "plain" : "sync";
    root.setAttribute("data-lview", view);
    root.setAttribute("data-lspace", ["compact", "wide"].includes(values.lyricsSpacing) ? values.lyricsSpacing : "normal");
    root.setAttribute("data-lbg", values.lyricsBg === "cover" ? "cover" : "theme");
    root.style.setProperty("--lyric-size", (LYRIC_SIZES[values.lyricsSize] || LYRIC_SIZES.medium) + "px");
    const font = this.fontStack();
    root.style.setProperty("--lyric-font", font.stack);
    root.style.setProperty("--lyric-weight", font.weight);
    // Con "Letra por letra" (o al pasar a texto normal) el texto se dibuja distinto: hay que volver a armar las líneas
    const signature = anim + "|" + view;
    if (signature !== this.last) {
      this.last = signature;
      Lyrics.render();
      Lyrics.update(true);
      LyricsPreview.build();
    }
  },

  /* ---------- Fuente propia (.ttf / .otf / .woff / .woff2) ---------- */

  async load(buffer) {
    const face = new FontFace("PulsarLyrics", buffer);
    await face.load();
    if (this.face) document.fonts.delete(this.face);
    document.fonts.add(face);
    this.face = face;
  },

  async restoreFont() {
    const file = Settings.values.lyricsFontFile;
    if (!file || !file.data) return;
    try {
      await this.load(file.data);
      this.apply();
      UI.refreshSettingsControls();
    } catch (error) {
      console.warn("No se pudo cargar la fuente guardada", error);
    }
  },

  async importFont(file) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("La fuente pesa demasiado (máximo 10 MB).");
      const data = await file.arrayBuffer();
      await this.load(data);
      await Settings.set("lyricsFontFile", { name: file.name.replace(/\.[^.]+$/, ""), data });
      await Settings.set("lyricsFont", "custom");
      UI.toast("Fuente aplicada a las letras.");
    } catch (error) {
      console.warn(error);
      UI.toast(error && error.message && /pesa/.test(error.message) ? error.message : "No se pudo leer esa fuente.");
    }
  },

  async removeFont() {
    if (this.face) { document.fonts.delete(this.face); this.face = null; }
    if (Settings.values.lyricsFont === "custom") await Settings.set("lyricsFont", "default");
    await Settings.set("lyricsFontFile", null);
  },

  // Botones de fuente en Ajustes (cada uno se ve con su propia fuente)
  renderFonts() {
    const box = $("lyric-fonts");
    if (!box) return;
    const file = Settings.values.lyricsFontFile;
    const items = LYRIC_FONTS.map((font) => ({ id: font.id, name: font.name, stack: font.stack, weight: font.weight }));
    if (file && this.face) items.push({ id: "custom", name: file.name, stack: '"PulsarLyrics", sans-serif', weight: 700 });
    const key = items.map((item) => item.id + item.name).join("|");
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = items.map((item) =>
        `<button type="button" role="radio" aria-checked="false" data-val="${item.id}" style="font-family:${UI.escapeHTML(item.stack)};font-weight:${item.weight}">${UI.escapeHTML(item.name)}</button>`
      ).join("");
    }
    const removeButton = $("lyric-font-remove");
    if (removeButton) removeButton.classList.toggle("hidden", !(file && this.face));
  }
};

/* Vista previa de las animaciones en Ajustes: dos cantantes y tres palabras que se van cantando. */
const LyricsPreview = {
  CYCLE: 7.4,
  raf: 0,
  t0: 0,
  lines: null,
  els: [],
  active: -1,

  data() {
    if (this.lines) return this.lines;
    const make = (side, words) => ({
      side, t: words[0][1], end: words[words.length - 1][2],
      words: words.map(([text, t, end]) => ({ text, t, end }))
    });
    this.lines = [
      make("l", [["Tu ", 0, 0.5], ["música, ", 0.5, 1.7], ["tu ", 1.7, 2.1], ["universo", 2.1, 3.5]]),
      make("r", [["Brilla ", 3.9, 4.7], ["conmigo", 4.7, 6.3]])
    ];
    return this.lines;
  },

  build() {
    const box = $("lyric-preview");
    if (!box) return;
    box.innerHTML = this.data().map((line, i) =>
      `<p class="lyric-line s${line.side}" data-pv="${i}">${Lyrics.wordsHTML(line)}</p>`
    ).join("");
    this.els = Array.from(box.querySelectorAll(".lyric-line"));
    this.active = -1;
    this.t0 = performance.now();
    this.frame(this.t0);
  },

  frame(now) {
    const lines = this.data();
    const time = (((now - this.t0) / 1000) % this.CYCLE);
    let index = -1;
    lines.forEach((line, i) => { if (line.t <= time) index = i; });
    if (index !== this.active) {
      this.active = index;
      this.els.forEach((el, i) => {
        el.classList.toggle("active", i === index);
        el.classList.toggle("past", i < index);
      });
    }
    if (index < 0 || !this.els[index]) return;
    Lyrics.paint(Array.from(this.els[index].querySelectorAll(".lw")), LyricsParser.units(lines[index]), time, LyricsStyle.anim() === "letters");
  },

  start() {
    if (this.raf || !$("lyric-preview")) return;
    if (!this.els.length) this.build();
    const tick = (now) => {
      this.raf = 0;
      if (Router.current !== "settings" || document.hidden) return;
      const gap = Performance.frameGap();
      if (!gap || now - (this.lastFrame || 0) >= gap) { this.lastFrame = now; this.frame(now); }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
};

/* =========================================================
   STAGE — zona central del reproductor: portada cuadrada
   (v1.04: la letra y la cola ya no van aquí, tienen su propia pantalla)
   ========================================================= */
const Stage = {
  init() {
    this.watchSize();
  },

  // Portada cuadrada en modo inmersivo: la más grande que quepa en la zona central,
  // sin pegarse a los bordes (88 % del ancho) y sin pasar de 520 px.
  fitCover() {
    const stage = $("stage");
    if (!stage) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    if (!width || !height) return; // pantalla oculta: se mide cuando vuelva a verse
    stage.style.setProperty("--cover-size", Math.floor(Math.min(width * 0.88, height, 520)) + "px");
  },

  watchSize() {
    const stage = $("stage");
    if (!stage) return;
    if (typeof ResizeObserver === "function") new ResizeObserver(() => this.fitCover()).observe(stage);
    window.addEventListener("resize", () => this.fitCover());
    this.fitCover();
  }
};

/* =========================================================
   QUEUE (v1.04) — la cola de reproducción es una lista real
   ids = canciones en el orden en que suenan · pos = la que suena ahora.
   Al tocar una canción de la biblioteca, la cola pasa a ser la lista desde la que se tocó
   (igual que en la v1.03). Desde la pantalla Cola se puede reordenar, quitar, añadir y mezclar.
   La pantalla Cola (QueueScreen, features.js) solo dibuja y pide cambios a este módulo.
   ========================================================= */
const Queue = {
  ids: [],
  pos: -1,
  backup: null, // orden original mientras la reproducción aleatoria está activa

  get currentId() { return this.pos >= 0 ? this.ids[this.pos] : null; },

  playable(id) {
    const song = Library.byId(id);
    return Boolean(song) && !song.missing;
  },

  shuffled(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  },

  // Se llama con cualquier cambio: la canción que sigue pudo cambiar, así que se prepara de nuevo.
  changed() {
    Player.invalidatePreload();
    if (typeof MediaBridge !== "undefined") MediaBridge.update();
    if (typeof QueueScreen !== "undefined") QueueScreen.refresh();
  },

  // Empieza una cola nueva desde la canción `id`. `context` = ids de la lista desde la que se tocó.
  startAt(id, context) {
    let list = Array.isArray(context) && context.includes(id) ? context.filter((x) => this.playable(x) || x === id) : Library.playableIds();
    if (!list.includes(id)) list = [id];
    if (Settings.values.shuffle) {
      this.backup = list.slice();
      this.ids = [id, ...this.shuffled(list.filter((x) => x !== id))];
      this.pos = 0;
    } else {
      this.backup = null;
      this.ids = list;
      this.pos = list.indexOf(id);
    }
    this.changed();
  },

  // La reproducción pasó a `id` (siguiente, anterior, saltar…): la cola solo mueve su marcador.
  commit(id) {
    const before = this.pos;
    let index = -1;
    for (let i = 0; i < this.ids.length; i++) {
      if (this.ids[i] === id && (index < 0 || Math.abs(i - before) < Math.abs(index - before))) index = i;
    }
    if (index < 0) { this.startAt(id); return; }
    // Al dar la vuelta con la reproducción aleatoria, se mezcla otra vez para que no se repita el mismo orden
    if (Settings.values.shuffle && index < before && this.ids.length > 2) {
      this.ids = [id, ...this.shuffled(this.ids.filter((x) => x !== id))];
      index = 0;
    }
    this.pos = index;
    this.changed();
  },

  // Canción que sigue. auto = la canción terminó sola (con «No repetir» ahí se acaba la cola).
  nextId(auto) {
    const n = this.ids.length;
    if (!n || this.pos < 0) return null;
    const current = this.ids[this.pos];
    if (auto && Settings.values.repeat === "one") return current;
    for (let i = this.pos + 1; i < n; i++) if (this.playable(this.ids[i])) return this.ids[i];
    if (auto && Settings.values.repeat === "off") return null;
    for (let i = 0; i < this.pos; i++) if (this.playable(this.ids[i])) return this.ids[i];
    // Solo queda la canción actual
    if (auto) return null;
    return this.playable(current) ? current : null;
  },

  prevId() {
    const n = this.ids.length;
    if (!n || this.pos < 0) return null;
    for (let i = this.pos - 1; i >= 0; i--) if (this.playable(this.ids[i])) return this.ids[i];
    for (let i = n - 1; i > this.pos; i--) if (this.playable(this.ids[i])) return this.ids[i];
    return this.playable(this.ids[this.pos]) ? this.ids[this.pos] : null;
  },

  upcoming() { return this.pos < 0 ? this.ids.slice() : this.ids.slice(this.pos + 1); },
  played() { return this.pos <= 0 ? [] : this.ids.slice(0, this.pos); },

  /* ---------- Cambios que pide la pantalla Cola ---------- */

  // Mueve una canción pendiente (índices absolutos de ids). La que suena no se mueve.
  move(from, to) {
    if (from === to || from <= this.pos || to <= this.pos) return false;
    if (from < 0 || to < 0 || from >= this.ids.length || to >= this.ids.length) return false;
    const [id] = this.ids.splice(from, 1);
    this.ids.splice(to, 0, id);
    this.changed();
    return true;
  },

  remove(index) {
    if (index < 0 || index >= this.ids.length || index === this.pos) return false;
    this.ids.splice(index, 1);
    if (index < this.pos) this.pos--;
    this.changed();
    return true;
  },

  // Quita una canción de TODA la cola (por ejemplo al borrarla de la biblioteca)
  removeId(id) {
    const current = this.currentId;
    this.ids = this.ids.filter((x) => x !== id);
    if (this.backup) this.backup = this.backup.filter((x) => x !== id);
    this.pos = current === null || current === id ? Math.min(this.pos, this.ids.length - 1) : this.ids.indexOf(current);
    if (!this.ids.length) this.pos = -1;
    this.changed();
  },

  // where: "next" = justo después de la que suena · "end" = al final
  add(id, where) {
    if (!Library.byId(id)) return false;
    if (!this.ids.length) { this.ids = [id]; this.pos = -1; }
    else if (where === "next" && this.pos >= 0) this.ids.splice(this.pos + 1, 0, id);
    else this.ids.push(id);
    if (this.backup) this.backup.push(id);
    this.changed();
    return true;
  },

  // Mezcla solo lo que falta por sonar
  shuffleUpcoming() {
    if (this.upcoming().length < 2) return false;
    const head = this.ids.slice(0, this.pos + 1);
    this.ids = head.concat(this.shuffled(this.ids.slice(this.pos + 1)));
    this.changed();
    return true;
  },

  // Reproducción aleatoria: al activarla se mezclan las pendientes; al apagarla vuelve el orden original
  setShuffle(on) {
    if (on) {
      if (!this.backup) this.backup = this.ids.slice();
      const head = this.ids.slice(0, this.pos + 1);
      this.ids = head.concat(this.shuffled(this.ids.slice(this.pos + 1)));
    } else if (this.backup) {
      const current = this.currentId;
      const present = new Set(this.ids);
      const original = this.backup.filter((id) => present.has(id));
      const extra = this.ids.filter((id) => !this.backup.includes(id)); // añadidas mientras tanto
      this.ids = original.concat(extra);
      this.pos = current === null ? -1 : this.ids.indexOf(current);
      this.backup = null;
    }
    this.changed();
  },

  clearUpcoming() {
    if (!this.upcoming().length) return false;
    this.ids = this.pos < 0 ? [] : this.ids.slice(0, this.pos + 1);
    if (this.backup) this.backup = this.backup.filter((id) => this.ids.includes(id));
    this.changed();
    return true;
  },

  // Quita de la cola lo que ya no existe o dejó de estar disponible (menos la canción actual)
  prune() {
    const current = this.currentId;
    this.ids = this.ids.filter((id) => id === current || this.playable(id));
    this.pos = current === null ? -1 : this.ids.indexOf(current);
    if (!this.ids.length) this.pos = -1;
    this.changed();
  },

  clear(notify) {
    this.ids = [];
    this.pos = -1;
    this.backup = null;
    if (notify !== false) this.changed();
  },

  // Segundos que faltan para terminar la cola (para el resumen de la pantalla Cola)
  remainingSeconds() {
    let total = 0;
    this.upcoming().forEach((id) => {
      const song = Library.byId(id);
      if (song && song.duration) total += song.duration;
    });
    const audio = Player.currentId !== null ? Player.audio : null;
    if (audio && Number.isFinite(audio.duration)) total += Math.max(0, audio.duration - audio.currentTime);
    return total;
  }
};

/* =========================================================
   AUDIO GRAPH (v1.04) — Web Audio compartido
   Dos reproductores <audio> (A y B) → una ganancia cada uno (para el crossfade) → 10 filtros del
   ecualizador → preamp → limitador → mono → balance → volumen general → salida.
   Solo se crea cuando hace falta (ecualizador, crossfade, mono o balance). Mientras no se use,
   la reproducción es exactamente la de siempre: el <audio> suena directo.
   Todo es procesamiento real del audio (BiquadFilterNode, GainNode…): nada está simulado.
   ========================================================= */
const AudioGraph = {
  ctx: null,
  sources: [],
  gains: [],
  eqIn: null,
  filters: [],
  preamp: null,
  limiter: null,
  mono: null,
  panner: null,
  master: null,
  ready: false,
  failed: false,

  supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  },

  // ¿Alguna función necesita el grafo ahora mismo?
  needed() {
    const v = Settings.values;
    return Boolean((v.eq && v.eq.enabled) || v.crossfade || v.mono || Number(v.balance) !== 0);
  },

  ensure() {
    if (this.ready) return true;
    if (this.failed) return false;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio no disponible");
      const ctx = new AudioCtx();
      const sources = Player.decks.map((deck) => ctx.createMediaElementSource(deck.el));
      const gains = sources.map((source) => {
        const gain = ctx.createGain();
        source.connect(gain);
        return gain;
      });
      const eqIn = ctx.createGain();
      gains.forEach((gain) => gain.connect(eqIn));

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
      limiter.knee.value = 0;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      const mono = ctx.createGain(); // con channelCount = 1 mezcla izquierda y derecha
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const master = ctx.createGain();

      let node = eqIn;
      filters.forEach((filter) => { node.connect(filter); node = filter; });
      node.connect(preamp);
      preamp.connect(limiter);
      limiter.connect(mono);
      if (panner) { mono.connect(panner); panner.connect(master); } else mono.connect(master);
      master.connect(ctx.destination);

      ctx.onstatechange = () => {
        if (ctx.state === "suspended" && Player.audio && !Player.audio.paused) ctx.resume().catch(() => {});
      };
      Object.assign(this, { ctx, sources, gains, eqIn, filters, preamp, limiter, mono, panner, master, ready: true });
      this.applyFx();
      return true;
    } catch (error) {
      console.error("No se pudo crear el audio avanzado:", error);
      this.failed = true;
      return false;
    }
  },

  resume() {
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  },

  // Limitador, mono y balance (Ajustes → Audio)
  applyFx() {
    if (!this.ready) return;
    const v = Settings.values;
    const now = this.ctx.currentTime;
    const limit = v.limiter !== false;
    this.limiter.threshold.setValueAtTime(limit ? -2 : 0, now);
    this.limiter.ratio.setValueAtTime(limit ? 20 : 1, now); // ratio 1 = no hace nada
    const mono = Boolean(v.mono);
    this.mono.channelCount = mono ? 1 : 2;
    this.mono.channelCountMode = mono ? "explicit" : "max";
    this.mono.channelInterpretation = "speakers";
    if (this.panner) this.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, Number(v.balance) || 0)), now, 0.03);
  },

  // Ganancia de cada reproductor (0 a 1)
  setDeckGain(index, value) {
    if (!this.ready || !this.gains[index]) return;
    const param = this.gains[index].gain;
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setValueAtTime(value, this.ctx.currentTime);
  },

  // Curva de potencia constante: la suma de los dos volúmenes se mantiene pareja a mitad del cruce.
  // Las rampas las ejecuta el motor de audio, así que no se entrecortan aunque la pantalla esté apagada.
  rampDeck(index, from, to, seconds) {
    if (!this.ready || !this.gains[index]) return false;
    const param = this.gains[index].gain;
    const now = this.ctx.currentTime;
    const steps = 48;
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const level = from <= to ? Math.sin(t * Math.PI / 2) : Math.cos(t * Math.PI / 2);
      curve[i] = from <= to ? from + (to - from) * level : to + (from - to) * level;
    }
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    try { param.setValueCurveAtTime(curve, now, Math.max(0.1, seconds)); }
    catch (error) { param.linearRampToValueAtTime(to, now + Math.max(0.1, seconds)); }
    return true;
  },

  // Volumen general (atenuación suave del temporizador y bajar el volumen en interrupciones)
  rampMaster(to, seconds) {
    if (!this.ready) return false;
    const param = this.master.gain;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(to, now + Math.max(0.02, seconds));
    return true;
  }
};

/* =========================================================
   ECUALIZADOR — 10 bandas con Web Audio (BiquadFilterNode: lowshelf + 8 peaking + highshelf)
   Solo se conecta al audio la primera vez que lo activas (así, mientras no lo uses,
   la reproducción es exactamente la de siempre). Al desactivarlo queda plano.
   Es un ecualizador REAL: modifica el sonido que sale por el altavoz o los auriculares.
   ========================================================= */
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
const EQ_MAX_DB = 12;
const EQ_PRESETS = [
  { id: "bass",       name: "Bajos",       gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  { id: "vocal",      name: "Voces",       gains: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1] },
  { id: "treble",     name: "Agudos",      gains: [-1, -1, 0, 0, 0, 1, 3, 5, 6, 7] },
  { id: "rock",       name: "Rock",        gains: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5] },
  { id: "pop",        name: "Pop",         gains: [-1, 1, 3, 4, 3, 1, -1, -1, 1, 2] },
  { id: "classical",  name: "Clásica",     gains: [0, 0, 0, 0, 0, 0, -2, -3, -3, -4] },
  { id: "electronic", name: "Electrónica", gains: [5, 4, 1, 0, -2, 2, 1, 2, 4, 5] },
  { id: "jazz",       name: "Jazz",        gains: [3, 3, 1, 2, -2, -2, 0, 1, 2, 3] }
];
const EQ_FLAT = { id: "flat", name: "Plano", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

const Equalizer = {
  applied: false,
  drag: null,
  saveTimer: 0,
  state: { enabled: false, preset: "flat", gains: new Array(10).fill(0) },

  supported() { return AudioGraph.supported() && !AudioGraph.failed; },

  init() {
    this.buildBands();
    Player.onActive("play", () => AudioGraph.resume());
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

  // Se llama al empezar cada canción: si el ecualizador (o el crossfade) estaba activado, se reconecta.
  onPlay() {
    if (!AudioGraph.needed()) return;
    if (AudioGraph.ensure()) {
      AudioGraph.resume();
      this.apply();
    } else if (this.state.enabled) {
      this.state.enabled = false;
      this.refreshUI();
    }
  },

  apply() {
    if (!AudioGraph.ready) return;
    const ctx = AudioGraph.ctx;
    const on = this.state.enabled;
    const now = ctx.currentTime;
    const instant = !this.applied; // la primera vez, de golpe: así no suena plano al principio
    this.applied = true;
    AudioGraph.filters.forEach((filter, i) => {
      const target = on ? this.state.gains[i] : 0;
      if (instant) filter.gain.value = target;
      else filter.gain.setTargetAtTime(target, now, 0.02);
    });
    const boost = on ? Math.max(0, ...this.state.gains) : 0;
    // Baja un poco el volumen general según lo que se sube, para evitar distorsión.
    const level = Math.pow(10, -(boost * 0.7) / 20);
    if (instant) AudioGraph.preamp.gain.value = level;
    else AudioGraph.preamp.gain.setTargetAtTime(level, now, 0.03);
  },

  /* ---------- Cambios del usuario ---------- */

  setEnabled(on) {
    if (on) {
      if (!AudioGraph.ensure()) {
        this.state.enabled = false;
        this.refreshUI();
        UI.toast("Este dispositivo no permite usar el ecualizador.");
        return;
      }
      AudioGraph.resume();
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
    if (!this.state.enabled && id !== "flat") this.setEnabled(true);
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

  presetName() {
    if (this.state.preset === "custom") return "Personalizado";
    const found = [...EQ_PRESETS, EQ_FLAT].find((item) => item.id === this.state.preset);
    return found ? found.name : "Plano";
  },

  /* ---------- Interfaz ---------- */

  buildBands() {
    $("eq-presets").innerHTML = [EQ_FLAT, ...EQ_PRESETS].map((preset) =>
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
    const tab = $("tab-eq");
    if (tab) tab.classList.toggle("on", this.state.enabled);

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
    const status = $("eq-engine");
    if (status) {
      const bad = !AudioGraph.supported() || AudioGraph.failed;
      status.textContent = bad
        ? "Este dispositivo no admite el procesamiento de audio necesario para el ecualizador."
        : "Motor: Web Audio · 10 bandas reales (filtros biquad). Funciona con todas las canciones, también las de carpetas.";
      status.classList.toggle("warn", bad);
    }
    const summary = $("eq-summary");
    if (summary) summary.textContent = (this.state.enabled ? "Activado · " : "Desactivado · ") + this.presetName();
  }
};

/* =========================================================
   EDITOR DE LETRAS — texto editable con herramientas de sincronía
   Se escribe en formato LRC: [mm:ss.xx]línea  ·  por palabras: [mm:ss.xx]<mm:ss.xx>pa<mm:ss.xx>la<mm:ss.xx>bra
   ========================================================= */
const LyricsEditor = {
  songId: null, // canción cuya letra se está editando (puede dejar de ser la que suena)

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
    this.songId = song.id;
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
    this.songId = null;
  },

  discard() {
    if (this.isOpen()) this.close();
  },

  updateClock() {
    $("lyrics-clock").textContent = LyricsParser.stamp(Player.audio.currentTime);
  },

  async save() {
    const raw = $("lyrics-text").value;
    const song = Library.byId(this.songId);
    if (!song) { this.close(); return; }
    if (await Lyrics.saveRaw(raw, song)) {
      const current = Lyrics.song && Lyrics.song.id === song.id;
      this.close();
      UI.toast(raw.trim() ? "Letra guardada" + (current ? " · " + Lyrics.badge.textContent : "") + "." : "Letra eliminada.");
    }
  },

  async clearLyrics() {
    const song = Library.byId(this.songId);
    if (!song) return;
    if (!(await UI.confirm("¿Borrar la letra de esta canción?", "Borrar", true))) return;
    if (await Lyrics.saveRaw("", song)) {
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
    if (!song) return null;
    if (!song.cover) return song.coverFile ? Native.coverUrl(song.coverFile) || null : null; // carátula incrustada leída por Android
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

  // Ids de las canciones que se pueden reproducir ahora (las de carpetas que ya no existen quedan fuera)
  playableIds() {
    return this.songs.filter((song) => !song.missing).map((song) => song.id);
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
    const fromFolder = Boolean(song.uri);
    const question = fromFolder
      ? `¿Quitar "${song.name}" de la biblioteca? El archivo no se borra y no volverá a añadirse al actualizar.`
      : `¿Eliminar "${song.name}" de la biblioteca?`;
    if (!(await UI.confirm(question, fromFolder ? "Quitar" : "Eliminar", true))) return;
    if (Player.currentId === id) Player.stop();
    try {
      await UI.animateOut(id);
      await Store.removeSong(id);
      this.songs = this.songs.filter((item) => item.id !== id);
      Covers.release(id);
      Queue.removeId(id);
      if (fromFolder && song.docKey) {
        // Se recuerda para que «Actualizar biblioteca» no la vuelva a traer
        const ignored = (Settings.values.ignoredKeys || []).concat(song.docKey);
        await Settings.set("ignoredKeys", Array.from(new Set(ignored)));
      }
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
    if (!(await UI.confirm("¿Borrar toda la biblioteca? Esto no elimina tus archivos originales. Las carpetas autorizadas se mantienen: puedes volver a cargarlas con «Actualizar biblioteca».", "Borrar", true))) return;
    Player.stop();
    try {
      await Store.clearAll();
      this.songs = [];
      Covers.releaseAll();
      Queue.clear();
      UI.renderAll();
      UI.toast("Biblioteca borrada.");
    } catch (error) {
      console.error(error);
      UI.toast("No se pudo borrar la biblioteca.");
    }
  }
};

/* =========================================================
   PLAYER — reproducción (v1.04)
   Dos reproductores <audio> ("decks"). Mientras suena uno, la siguiente canción se prepara en el otro:
   así el cambio es inmediato (reproducción continua) y el crossfade mezcla las dos canciones sin cortes.
   `Player.audio` siempre apunta al deck que suena (compatibilidad con letras, editor y ecualizador).
   ========================================================= */
function makeDeck() {
  const el = new Audio();
  el.preload = "auto";
  return { el, url: "", revoke: null, songId: null };
}

const Player = {
  decks: [makeDeck(), makeDeck()],
  activeIdx: 0,
  currentId: null,
  objectUrl: null,   // "hay algo cargado" (se conserva por compatibilidad con la v1.03)
  seeking: false,
  loadToken: 0,
  positionAt: 0,
  fading: null,      // { from, to, timer } mientras dura un crossfade
  preloaded: null,   // { songId, deckIdx }
  preloadTimer: 0,
  failStreak: 0,
  startingFade: false,
  userPaused: false,
  interrupted: false, // pausada por otra app (llamada, otro reproductor…): se reanuda sola al volver el foco
  duckLevel: 1,      // < 1 mientras otra app pide que bajemos el volumen
  fadeLevel: 1,      // < 1 durante el fundido final del temporizador

  get audio() { return this.decks[this.activeIdx].el; },
  get deck() { return this.decks[this.activeIdx]; },
  get idle() { return this.decks[1 - this.activeIdx]; },

  isActive(deck) { return this.decks[this.activeIdx] === deck; },

  // Para los módulos que escuchan eventos del audio (letras, ecualizador…): solo avisa si viene del deck que suena
  onActive(eventName, handler) {
    this.decks.forEach((deck) => {
      deck.el.addEventListener(eventName, (event) => { if (this.isActive(deck)) handler(event); });
    });
  },

  init() {
    this.decks.forEach((deck, index) => {
      const el = deck.el;
      const active = () => this.isActive(deck);
      el.addEventListener("play", () => { if (active()) { UI.updatePlayState(); MediaBridge.update(true); } });
      el.addEventListener("pause", () => {
        if (!active()) return;
        UI.updatePlayState();
        MediaBridge.update(true);
      });
      el.addEventListener("playing", () => { if (active()) this.failStreak = 0; });
      el.addEventListener("timeupdate", () => {
        if (!active()) return;
        UI.updateProgress();
        this.updatePositionState();
        Lyrics.onTime(el.currentTime);
        this.tick();
      });
      el.addEventListener("seeked", () => { if (active()) MediaBridge.update(true); });
      el.addEventListener("loadedmetadata", () => { if (active()) UI.setDuration(el.duration); });
      el.addEventListener("durationchange", () => {
        if (active()) { UI.setDuration(el.duration); MediaBridge.update(); }
      });
      el.addEventListener("ended", () => { if (active()) this.handleEnded(); });
      el.addEventListener("error", () => this.handleError(deck, index));
    });
    this.setupMediaSession();
    this.applyLoopMode();

    // Música en segundo plano apagada: al salir de la app, la música se pausa
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && Settings.values.bgPlayback === false && this.currentId !== null && !this.audio.paused) this.pause();
    });
    Settings.watch(["repeat"], () => { this.applyLoopMode(); this.invalidatePreload(); });
    Settings.watch(["gapless", "crossfade", "crossfadeSecs"], (value, key) => {
      if (key === "crossfade" && value) AudioGraph.ensure();
      this.invalidatePreload();
    });
    Settings.watch(["limiter", "mono", "balance"], () => {
      if (AudioGraph.needed()) AudioGraph.ensure();
      AudioGraph.applyFx();
    });
  },

  /* ---------- Cargar y reproducir ---------- */

  // Devuelve { url, revoke } con la dirección desde la que se reproduce la canción.
  async resolveSource(song) {
    if (song.uri) { // canción de una carpeta autorizada: la sirve Android desde el mismo origen de la app
      const url = Native.audioUrl(song.uri);
      return url ? { url, revoke: null } : null;
    }
    let blob = null;
    try { blob = await Store.getBlob(song.id); } catch (error) { console.error(error); }
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  },

  attach(deck, song, source) {
    const previous = deck.revoke;
    deck.el.src = source.url;
    deck.url = source.url;
    deck.revoke = source.revoke;
    deck.songId = song.id;
    if (previous) previous();
  },

  release(deck) {
    try {
      deck.el.pause();
      deck.el.removeAttribute("src");
      deck.el.load();
    } catch (error) { /* no crítico */ }
    if (deck.revoke) deck.revoke();
    deck.url = "";
    deck.revoke = null;
    deck.songId = null;
    deck.el.loop = false;
    deck.el.volume = 1;
    const index = this.decks.indexOf(deck);
    if (index >= 0) AudioGraph.setDeckGain(index, 1);
  },

  // opts.fromQueue: la cola ya apunta a esta canción (siguiente, anterior…); opts.context: lista de ids de la que viene
  async play(id, opts = {}) {
    const song = Library.byId(id);
    if (!song) return false;
    if (song.missing) {
      UI.toast("Este archivo ya no está disponible. Actualiza la biblioteca en Ajustes.");
      return false;
    }
    this.finishFade();
    this.cancelPreloadTimer();
    const token = ++this.loadToken;
    // Lo preparado se guarda antes de mover la cola (mover la cola vuelve a calcular qué sigue)
    const pre = this.preloaded;
    this.preloaded = null;
    if (!opts.fromQueue) Queue.startAt(id, opts.context);
    else Queue.commit(id);
    if (AudioGraph.needed()) AudioGraph.ensure(); // con el gesto del usuario, para que el audio avanzado arranque sin problemas

    // ¿Ya está lista en el otro reproductor? Entonces el cambio es inmediato.
    let deck = null;
    if (pre && pre.songId === id && pre.deckIdx !== this.activeIdx && this.decks[pre.deckIdx].songId === id && this.decks[pre.deckIdx].url) {
      deck = this.decks[pre.deckIdx];
      const old = this.deck;
      this.activeIdx = pre.deckIdx;
      this.release(old);
      try { deck.el.currentTime = 0; } catch (error) { /* aún sin metadatos */ }
    } else {
      const source = await this.resolveSource(song);
      if (token !== this.loadToken) { if (source && source.revoke) source.revoke(); return false; } // se pidió otra canción mientras cargaba
      if (!source) {
        UI.toast(song.uri && !Native.available ? "Las carpetas solo se pueden reproducir en la app Android." : "No se encontró el archivo de esta canción.");
        return false;
      }
      deck = this.deck;
      this.release(this.idle);
      deck.el.pause();
      this.attach(deck, song, source);
    }

    this.objectUrl = deck.url;
    this.currentId = id;
    AudioGraph.setDeckGain(this.activeIdx, 1);
    this.applyLoopMode();
    this.applyLevel();
    this.userPaused = false;
    this.interrupted = false;
    this.afterTrackStart(song);
    Equalizer.onPlay();

    try {
      await deck.el.play();
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("No se pudo reproducir:", error);
        UI.toast("No se pudo iniciar la reproducción.");
      }
    }
    if (token !== this.loadToken) return true;
    UI.updatePlayState();
    this.schedulePreload();
    return true;
  },

  // Todo lo que cambia al empezar una canción (sea normal o por crossfade)
  afterTrackStart(song) {
    Lyrics.load(song);
    UI.showNowPlaying(song);
    UI.markPlaying();
    this.updateMediaMetadata(song);
    MediaBridge.update(true);
    if (typeof SongInfo !== "undefined") SongInfo.onTrackChange();
  },

  /* ---------- Controles ---------- */

  toggle() {
    if (this.currentId === null) {
      const first = Library.playableIds()[0];
      if (first !== undefined) this.play(first, { context: Library.playableIds() });
      else UI.toast("Importa música para empezar.");
      return;
    }
    if (this.audio.paused) this.resume(); else this.pause();
  },

  resume() {
    if (this.currentId === null) return;
    this.userPaused = false;
    this.interrupted = false;
    AudioGraph.resume();
    this.audio.play().catch((error) => {
      if (error.name !== "AbortError") UI.toast("No se pudo reanudar la reproducción.");
    });
  },

  pause() {
    this.userPaused = true;
    this.finishFade();
    this.audio.pause();
  },

  next(opts = {}) {
    const id = Queue.nextId(false);
    if (id === null) return;
    this.play(id, { fromQueue: true, ...opts });
  },

  previous() {
    const restart = Settings.values.prevRestart !== false;
    if (restart && this.currentId !== null && this.audio.currentTime > 3) {
      this.finishFade();
      this.audio.currentTime = 0;
      return;
    }
    const id = Queue.prevId();
    if (id === null) return;
    this.play(id, { fromQueue: true });
  },

  // Saltar a una posición de la cola (pantalla Cola)
  skipTo(index) {
    const id = Queue.ids[index];
    if (id === undefined) return;
    if (index === Queue.pos) { this.toggle(); return; }
    this.play(id, { fromQueue: true });
  },

  seekTo(fraction) {
    const duration = this.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      this.finishFade();
      this.audio.currentTime = fraction * duration;
    }
  },

  stop() {
    this.loadToken++;
    this.finishFade();
    this.cancelPreloadTimer();
    this.preloaded = null;
    this.decks.forEach((deck) => this.release(deck));
    this.objectUrl = null;
    this.currentId = null;
    this.userPaused = false;
    this.interrupted = false;
    Queue.clear(false);
    Lyrics.clear();
    UI.resetNowPlaying();
    MediaBridge.update(true);
    Queue.changed();
    if (typeof SongInfo !== "undefined") SongInfo.onTrackChange();
  },

  /* ---------- Fin de canción, continuidad y crossfade ---------- */

  handleEnded() {
    if (typeof SleepTimer !== "undefined" && SleepTimer.consumeTrackEnd()) return;
    const next = Queue.nextId(true);
    if (next === null) { this.endOfQueue(); return; }
    this.play(next, { fromQueue: true });
  },

  // No hay más canciones (repetición desactivada, o una sola canción)
  endOfQueue() {
    this.audio.currentTime = 0;
    UI.updatePlayState();
    UI.updateProgress();
    MediaBridge.update(true);
  },

  handleError(deck, index) {
    if (!deck.url) return;
    console.error("Error de audio:", deck.el.error);
    if (!this.isActive(deck)) { // era la canción preparada: se descarta sin avisar
      if (this.preloaded && this.preloaded.deckIdx === index) this.preloaded = null;
      this.release(deck);
      return;
    }
    UI.updatePlayState();
    this.failStreak++;
    if (this.failStreak <= 2 && Queue.ids.length > 1) {
      UI.toast("No se pudo reproducir este archivo. Pasando a la siguiente…");
      setTimeout(() => { if (this.audio.error) this.next(); }, 500);
    } else {
      UI.toast("No se pudo reproducir este archivo. Puede que su formato no sea compatible.");
    }
  },

  // Con reproducción continua o crossfade, la siguiente canción se prepara en el otro reproductor
  wantsPreload() {
    return Settings.values.gapless !== false || Boolean(Settings.values.crossfade);
  },

  schedulePreload() {
    this.cancelPreloadTimer();
    if (!this.wantsPreload()) return;
    this.preloadTimer = setTimeout(() => this.preload(), 1800);
  },

  cancelPreloadTimer() {
    clearTimeout(this.preloadTimer);
    this.preloadTimer = 0;
  },

  // La cola o los ajustes cambiaron: lo preparado puede ya no ser la siguiente canción
  invalidatePreload() {
    if (this.fading) return;
    this.cancelPreloadTimer();
    if (this.preloaded) {
      const stale = this.preloaded.songId !== Queue.nextId(true);
      if (stale || !this.wantsPreload()) {
        this.preloaded = null;
        if (this.currentId !== null) this.release(this.idle);
      }
    }
    if (this.currentId !== null) this.schedulePreload();
  },

  async preload() {
    if (this.currentId === null || this.fading) return null;
    const nextId = Queue.nextId(true);
    if (nextId === null || nextId === this.currentId) return null;
    if (this.preloaded && this.preloaded.songId === nextId && this.idle.songId === nextId) return this.idle;
    const song = Library.byId(nextId);
    if (!song || song.missing) return null;
    const token = this.loadToken;
    const source = await this.resolveSource(song);
    if (!source) return null;
    // Mientras se leía el archivo pudo cambiar la canción o la cola
    if (token !== this.loadToken || Queue.nextId(true) !== nextId || this.fading) {
      if (source.revoke) source.revoke();
      return null;
    }
    const deck = this.idle;
    deck.el.pause();
    this.attach(deck, song, source);
    deck.el.load();
    this.preloaded = { songId: nextId, deckIdx: 1 - this.activeIdx };
    return deck;
  },

  fadeSeconds(duration) {
    const wanted = Number(Settings.values.crossfadeSecs) || 4;
    return Math.max(0.5, Math.min(wanted, duration / 2 - 0.3));
  },

  // Se llama en cada timeupdate: revisa el temporizador y arranca el crossfade cuando faltan los segundos configurados
  tick() {
    if (typeof SleepTimer !== "undefined") SleepTimer.check();
    if (!Settings.values.crossfade || this.fading || this.startingFade) return;
    const el = this.audio;
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration < 4 || el.paused) return;
    if (Settings.values.repeat === "one" || (typeof SleepTimer !== "undefined" && SleepTimer.mode === "track")) return;
    const remaining = duration - el.currentTime;
    if (remaining > this.fadeSeconds(duration) + 0.15) return;
    const nextId = Queue.nextId(true);
    if (nextId === null || nextId === this.currentId) return;
    this.startCrossfade(nextId);
  },

  async startCrossfade(nextId) {
    this.startingFade = true;
    try {
      const song = Library.byId(nextId);
      if (!song || song.missing) return;
      const token = this.loadToken;
      const ready = await this.preload();
      if (!ready || token !== this.loadToken || this.fading) return; // si no hubo tiempo, termina con el cambio normal
      if (ready.el.readyState < 2) {
        await new Promise((resolve) => {
          const done = () => { ready.el.removeEventListener("canplay", done); resolve(); };
          ready.el.addEventListener("canplay", done);
          setTimeout(done, 1200);
        });
        if (token !== this.loadToken) return;
      }
      if (ready.el.readyState < 2 || this.audio.paused) return;

      const from = this.deck;
      const fromIdx = this.activeIdx;
      const toIdx = 1 - this.activeIdx;
      const canRamp = AudioGraph.ensure();
      AudioGraph.resume();
      this.preloaded = null;
      this.loadToken++;
      Queue.commit(nextId);
      this.activeIdx = toIdx;
      this.currentId = nextId;
      this.objectUrl = ready.url;
      this.userPaused = false;
      this.applyLoopMode();
      if (canRamp) AudioGraph.setDeckGain(toIdx, 0);
      else ready.el.volume = 0;

      try { await ready.el.play(); } catch (error) { console.warn("Crossfade:", error); }
      // Lo que falta de la canción que termina (el play() pudo tardar unos milisegundos)
      const left = Math.max(0.4, (from.el.duration || 8) - from.el.currentTime);
      const seconds = Math.min(this.fadeSeconds(from.el.duration || 8), left);
      if (canRamp) {
        AudioGraph.rampDeck(fromIdx, 1, 0, seconds);
        AudioGraph.rampDeck(toIdx, 0, 1, seconds);
      } else {
        this.softVolume(from.el, 1, 0, seconds);
        this.softVolume(ready.el, 0, 1, seconds);
      }
      this.fading = { from, to: ready, timer: setTimeout(() => this.finishFade(), seconds * 1000 + 150) };
      this.afterTrackStart(song);
      Equalizer.onPlay();
    } finally {
      this.startingFade = false;
    }
  },

  // Sin Web Audio: el volumen del propio <audio> sube o baja por pasos
  softVolume(el, from, to, seconds) {
    const t0 = performance.now();
    el.volume = from;
    clearInterval(el._ramp);
    el._ramp = setInterval(() => {
      const t = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      el.volume = Math.max(0, Math.min(1, from + (to - from) * t));
      if (t >= 1) clearInterval(el._ramp);
    }, 60);
  },

  // Termina el cruce de inmediato: la canción anterior se detiene y se libera
  finishFade() {
    const fade = this.fading;
    if (!fade) return;
    clearTimeout(fade.timer);
    this.fading = null;
    const fromIdx = this.decks.indexOf(fade.from);
    clearInterval(fade.from.el._ramp);
    clearInterval(fade.to.el._ramp);
    this.release(fade.from);
    fade.from.el.volume = 1;
    fade.to.el.volume = 1;
    if (fromIdx >= 0) AudioGraph.setDeckGain(fromIdx, 1);
    AudioGraph.setDeckGain(this.decks.indexOf(fade.to), 1);
    if (this.currentId !== null) this.schedulePreload(); // ahora sí: se prepara la canción que sigue
  },

  // Repetir una canción: el propio <audio> la repite sin cortes
  applyLoopMode() {
    this.decks.forEach((deck) => { deck.el.loop = this.isActive(deck) && Settings.values.repeat === "one"; });
  },

  /* ---------- Volumen general: interrupciones de audio y fundido del temporizador ---------- */

  // Sin Web Audio el volumen se controla en el propio <audio>; con Web Audio, en la ganancia general
  applyLevel(seconds) {
    const level = Math.max(0, Math.min(1, this.duckLevel * this.fadeLevel));
    if (AudioGraph.ready) {
      AudioGraph.rampMaster(level, seconds === undefined ? 0.15 : seconds);
    } else if (!this.fading) {
      this.decks.forEach((deck) => { deck.el.volume = level; });
    }
  },

  setDuck(on) {
    this.duckLevel = on ? 0.25 : 1;
    this.applyLevel(on ? 0.12 : 0.6);
  },

  /* ---------- Android / navegador: pantalla de bloqueo y notificación ---------- */

  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (error) { /* no soportado */ }
    };
    set("play", () => this.resume());
    set("pause", () => this.pause());
    set("previoustrack", () => this.previous());
    set("nexttrack", () => this.next());
    set("seekto", (details) => {
      if (details && typeof details.seekTime === "number") { this.finishFade(); this.audio.currentTime = details.seekTime; }
    });
  },

  // Mantiene la barra de la notificación / pantalla de bloqueo en la posición correcta (1 vez por segundo).
  updatePositionState() {
    if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const now = Date.now();
    if (now - this.positionAt < 1000) return;
    this.positionAt = now;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: this.audio.playbackRate || 1,
        position: Math.min(Math.max(0, this.audio.currentTime), duration)
      });
    } catch (error) { /* no crítico */ }
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
  },

  // Órdenes que llegan de la notificación, los botones de los auriculares o el temporizador nativo
  nativeAction(name, value) {
    switch (name) {
      case "play": this.resume(); break;
      case "pause": this.pause(); break;
      case "toggle": this.toggle(); break;
      case "next": this.next(); break;
      case "previous": this.previous(); break;
      case "stop": this.pause(); break;
      case "seek": if (Number.isFinite(Number(value))) { this.finishFade(); this.audio.currentTime = Number(value) / 1000; } break;
      case "sleep": if (typeof SleepTimer !== "undefined") SleepTimer.fire(true); break;
      case "interrupt": // auriculares desconectados: pausa (la persona decide cuándo seguir)
        if (!this.audio.paused) { this.userPaused = true; this.audio.pause(); this.finishFade(); }
        break;
    }
  },

  // Foco de audio (llamadas, otras apps): lo avisa Android
  focus(action) {
    switch (action) {
      case "duck": this.setDuck(true); break;
      case "unduck": this.setDuck(false); break;
      case "pause": // pérdida temporal: pausa y se reanuda sola cuando el foco vuelve
        if (this.currentId !== null && !this.audio.paused) { this.interrupted = true; this.finishFade(); this.audio.pause(); }
        break;
      case "resume":
        this.setDuck(false);
        if (this.interrupted && !this.userPaused) this.resume();
        this.interrupted = false;
        break;
      case "loss": // pérdida permanente (otro reproductor tomó el audio): pausa y no se reanuda sola
        this.interrupted = false;
        if (!this.audio.paused) { this.userPaused = true; this.finishFade(); this.audio.pause(); }
        this.setDuck(false);
        break;
    }
  }
};

/* =========================================================
   ROUTER — navegación entre pantallas (#hash + historial controlado)
   v1.01: el historial del navegador refleja EXACTAMENTE la ruta lógica
   (Inicio → pantalla → subpantalla). Nunca se duplican pantallas, no hay ciclos
   y el botón/gesto Atrás de Android sigue la ruta; en Inicio, Atrás sale de la app.
   ========================================================= */
const Router = {
  views: ["home", "library", "player", "lyrics", "queue", "timer", "info", "eq", "settings", "collection"],
  // Pantalla "padre": a dónde vuelve Atrás. Inicio es la raíz (Atrás en Inicio = salir).
  // Las pantallas del reproductor (letra, cola, temporizador, información, ecualizador) cuelgan de él;
  // si se abren desde otra pantalla (Ajustes, Cola…) Atrás vuelve a ella (ver go(nombre, padre)).
  parents: { library: "home", settings: "home", player: "home", lyrics: "player", queue: "player", timer: "player",
             info: "player", eq: "player", collection: "library" },
  // Pantallas "inmersivas": sin barra de arriba, barra inferior ni mini reproductor
  IMMERSIVE: ["player", "lyrics", "queue", "timer", "info", "eq"],
  override: null,   // padre temporal para la próxima navegación
  current: "home",
  lastBase: "home", // última pantalla de la barra inferior (Inicio o Biblioteca): a ella se vuelve al cerrar Reproductor o Ajustes
  stack: ["home"],  // ruta actual, igual que las entradas del historial: ["home"], ["home","player","eq"]…
  afterPop: null,   // paso pendiente cuando hay que retroceder varias entradas antes de continuar
  expectPop: false, // true cuando el retroceso lo pide la propia app (no el usuario)

  init() {
    window.addEventListener("popstate", (event) => this.onPopState(event));
    const saved = history.state;
    const valid = saved && saved.pulsar && Array.isArray(saved.stack) && saved.stack.length &&
      saved.stack.every((view) => this.views.includes(view));
    if (valid) {
      // Recarga con historial propio ya construido: se respeta tal cual (sin duplicar entradas).
      this.stack = saved.stack.slice();
    } else {
      // Arranque limpio: la app siempre empieza en Inicio, que es la raíz.
      this.stack = ["home"];
      history.replaceState({ pulsar: true, stack: ["home"] }, "", "#home");
    }
    this.show(this.stack[this.stack.length - 1]);
  },

  fromHash() {
    const name = location.hash.replace("#", "");
    return this.views.includes(name) ? name : "home";
  },

  // Ruta lógica hasta una pantalla: player → ["home","player"], eq → ["home","player","eq"]
  pathTo(name) {
    const path = [];
    let view = name;
    while (view && !path.includes(view)) {
      path.unshift(view);
      view = (this.override && this.override[view]) || this.parents[view];
    }
    if (path[0] !== "home") path.unshift("home");
    return path;
  },

  // go("eq", "settings"): abre el ecualizador y Atrás vuelve a Ajustes (en vez de al reproductor)
  go(name, parent) {
    if (!this.views.includes(name)) return;
    if (name === this.current) {
      window.scrollTo(0, 0);
      return;
    }
    this.override = parent && this.views.includes(parent) ? { [name]: parent } : null;
    // Si la pantalla de destino ya está en la ruta (por ejemplo Cola → Información → Cola), se vuelve con Atrás
    const target = this.pathTo(name);
    this.override = null;
    let common = 0;
    while (common < this.stack.length && common < target.length && this.stack[common] === target[common]) common++;
    const pops = this.stack.length - common;   // entradas que sobran en el historial
    const pushes = target.slice(common);       // entradas nuevas que faltan

    const finish = (replaceFirst) => {
      pushes.forEach((view, i) => {
        const state = { pulsar: true, stack: target.slice(0, common + i + 1) };
        if (i === 0 && replaceFirst) history.replaceState(state, "", "#" + view);
        else history.pushState(state, "", "#" + view);
      });
      this.stack = target.slice();
      this.show(name);
    };

    if (pops === 0) {
      finish(false);                       // solo avanzar: se agrega una entrada
    } else if (pushes.length === 0) {
      this.back(pops);                     // solo volver a una pantalla ya en la ruta: se descartan entradas
    } else if (pops === 1) {
      finish(true);                        // cambiar de rama: se reemplaza la entrada, no se acumula
    } else {
      this.afterPop = () => finish(true);  // retrocede lo que sobra y luego reemplaza
      this.back(pops - 1);
    }
  },

  back(steps) {
    this.expectPop = true;
    history.go(-steps);
  },

  // Botón ‹ de las pantallas secundarias: un paso atrás en la ruta (o a Inicio si no hay historial propio)
  up() {
    if (this.stack.length > 1) this.back(1);
    else this.go("home");
  },

  immersive(name) {
    return this.IMMERSIVE.includes(name || this.current);
  },

  // Cierra lo que esté abierto encima de la pantalla (menú ⋮, editores). Devuelve true si cerró algo.
  closeOverlay() {
    if (UI.dismissConfirm) { UI.dismissConfirm(); return true; }
    if (UI.closeTopOverlay()) return true;
    if (LyricsEditor.isOpen()) { LyricsEditor.close(); return true; }
    if (Editor.isOpen()) { Editor.close(); return true; }
    if (UI.el.playerMenu && !UI.el.playerMenu.classList.contains("hidden")) { UI.closeMenu(); return true; }
    return false;
  },

  // Se ejecuta con el botón Atrás de Android, el gesto lateral o cualquier retroceso del historial.
  onPopState(event) {
    const programmatic = this.expectPop;
    this.expectPop = false;

    if (this.afterPop) {
      const next = this.afterPop;
      this.afterPop = null;
      next();
      return;
    }

    // Atrás con un menú o editor abierto: solo se cierra eso y se permanece en la misma pantalla.
    if (!programmatic && this.closeOverlay()) {
      history.pushState({ pulsar: true, stack: this.stack.slice() }, "", "#" + this.current);
      return;
    }

    const state = event.state;
    let stack = state && state.pulsar && Array.isArray(state.stack) ? state.stack : null;
    if (!stack || !stack.every((view) => this.views.includes(view))) stack = this.pathTo(this.fromHash());
    this.stack = stack.slice();
    this.show(this.stack[this.stack.length - 1]);
  },

  show(name) {
    this.current = name;
    if (name === "home" || name === "library") this.lastBase = name;
    Editor.discard();
    LyricsEditor.discard();
    UI.closeMenu();
    // Modo inmersivo: en el reproductor (y su ecualizador) se ocultan la barra de arriba y la de abajo.
    const immersive = this.immersive(name);
    const root = document.documentElement;
    if (root.classList.contains("immersive") !== immersive) {
      root.classList.toggle("immersive", immersive);
      // la barra de navegación de Android toma el color del fondo mientras no hay barra inferior
      NativeBars.syncSoon();
    }
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
    if (name === "settings") { UI.renderSettings(); LyricsPreview.start(); }
    if (typeof Features !== "undefined") Features.onRoute(name);
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
    if (this.el.appVersion) this.el.appVersion.textContent = resolveAppVersion();
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
        // data-parent: desde dónde se abre (para que Atrás vuelva ahí). En Ajustes y en Cola se usa la pantalla actual.
        const from = Router.current === "settings" || Router.current === "queue" ? Router.current : undefined;
        // El engranaje es un interruptor: abre Ajustes y, si ya estás en Ajustes, vuelve.
        if (wanted === "settings" && Router.current === "settings") Router.go(Router.lastBase);
        else Router.go(wanted, viewButton.dataset.parent || from);
        return;
      }

      const libTab = target.closest("[data-lib-tab]");
      if (libTab) { event.preventDefault(); LibraryBrowse.setTab(libTab.dataset.libTab); return; }

      const jump = target.closest("[data-jump]");
      if (jump) { event.preventDefault(); SettingsNav.jump(jump.dataset.jump); return; }

      const hzButton = target.closest("[data-hz]");
      if (hzButton) { event.preventDefault(); Performance.select(Number(hzButton.dataset.hz)); return; }

      const segButton = target.closest("[data-seg] [data-val]");
      if (segButton) {
        event.preventDefault();
        const key = segButton.closest("[data-seg]").dataset.seg;
        let value = segButton.dataset.val;
        if (key === "lyricsFont" && value === "custom" && !LyricsStyle.face) return;
        Settings.set(key, value);
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
        else Player.play(id, { context: this.listIds(songRow) });
      }
    });

    // Interruptores de Ajustes (color de portada, barra de estado, duetos, desenfoque)
    document.addEventListener("change", (event) => {
      const input = event.target.closest && event.target.closest("[data-toggle]");
      if (input) Settings.set(input.dataset.toggle, input.checked);
    });

    const fontFile = $("lyric-font-file");
    if (fontFile) {
      fontFile.addEventListener("change", (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (file) LyricsStyle.importFont(file);
      });
    }

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

    // La barra de progreso existe en el reproductor y en la pantalla de letras: todas se mueven juntas
    document.querySelectorAll("[data-progress]").forEach((progress) => {
      progress.addEventListener("input", () => {
        Player.seeking = true;
        const duration = Player.audio.duration;
        if (Number.isFinite(duration)) {
          const text = this.formatTime((progress.value / 1000) * duration);
          document.querySelectorAll('[data-time="current"]').forEach((el) => { el.textContent = text; });
        }
      });
      progress.addEventListener("change", () => {
        Player.seekTo(progress.value / 1000);
        Player.seeking = false;
        this.updateProgress();
      });
    });

    // Barras deslizantes de Ajustes (duración del crossfade, balance…)
    document.addEventListener("input", (event) => {
      const range = event.target.closest && event.target.closest("[data-range]");
      if (!range) return;
      const scale = Number(range.dataset.scale) || 1;
      Settings.set(range.dataset.range, Number(range.value) / scale);
    });
  },

  // Canciones de la lista desde la que se tocó una fila: la cola pasa a ser esa lista (como en la v1.03).
  // «Recientes» (Inicio) usa toda la biblioteca.
  listIds(row) {
    const list = row.closest(".song-list");
    if (!list || list.id === "recent-list") return Library.playableIds();
    const ids = Array.from(list.querySelectorAll("[data-song]")).map((el) => Number(el.dataset.song));
    return ids.filter((id) => Queue.playable(id));
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
      case "back": Router.up(); break;
      case "shuffle": Settings.set("shuffle", !Settings.values.shuffle); break;
      case "repeat": Settings.set("repeat", { off: "all", all: "one", one: "off" }[Settings.values.repeat] || "all"); break;
      case "eq-reset": Equalizer.reset(); break;
      case "open-lyrics-settings": Router.go("settings", "lyrics"); SettingsNav.jumpSoon("lyrics"); break;
      case "open-audio-settings": Router.go("settings", "eq"); SettingsNav.jumpSoon("audio"); break;
      case "lyric-font-import": $("lyric-font-file").click(); break;
      case "lyric-font-remove": LyricsStyle.removeFont(); break;
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
      default: if (typeof Features !== "undefined") Features.handle(action); // temporizador, cola, información, carpetas…
    }
  },

  /* ---------- Dibujo ---------- */

  renderAll() {
    if (typeof QueueScreen !== "undefined") QueueScreen.refresh();
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
    const duration = (song.duration ? ` · ${this.formatTime(song.duration)}` : "") + (song.missing ? " · no disponible" : "");
    return `
      <div class="song-item${song.missing ? " missing" : ""}" data-song="${song.id}" style="--i:${delay}">
        <div class="song-cover">${this.coverHTML(song)}</div>
        <div class="song-details">
          <strong>${this.escapeHTML(song.name || "Sin título")}</strong>
          <small>${this.escapeHTML(song.artist)}${duration}</small>
        </div>
        <button type="button" data-song-play="${song.id}" aria-label="Reproducir">${Icons.play}</button>
        <button type="button" class="remove" data-remove="${song.id}" aria-label="Eliminar">${Icons.x}</button>
      </div>`;
  },

  emptyState(searching) {
    return `
      <div class="empty">
        <div class="empty-icon">${Icons.note}</div>
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
    if (typeof LibraryBrowse !== "undefined" && LibraryBrowse.render(query)) return; // álbumes, artistas o géneros
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

  // Pone al día los botones e interruptores de Ajustes con los valores guardados
  refreshSettingsControls() {
    const values = Settings.values;
    document.querySelectorAll("[data-seg]").forEach((group) => {
      const current = String(values[group.dataset.seg]);
      group.querySelectorAll("[data-val]").forEach((button) => {
        button.setAttribute("aria-checked", String(button.dataset.val === current));
      });
    });
    document.querySelectorAll("[data-toggle]").forEach((input) => {
      input.checked = Boolean(values[input.dataset.toggle]);
    });
    document.querySelectorAll("[data-range]").forEach((input) => {
      const scale = Number(input.dataset.scale) || 1;
      input.value = String(Math.round((Number(values[input.dataset.range]) || 0) * scale));
    });
    const intensity = $("cover-intensity");
    if (intensity) intensity.classList.toggle("disabled", !values.coverColor);
    if (typeof Features !== "undefined") Features.refreshControls();
    const hint = $("status-hint");
    if (hint) {
      hint.textContent = StatusBar.native()
        ? "Para verla un momento, desliza desde el borde de arriba."
        : "En el navegador usa la pantalla completa. En la app Android oculta la barra de estado.";
    }
    LyricsStyle.renderFonts();
    const anim = LYRIC_ANIMS.find((item) => item.id === LyricsStyle.anim());
    const animHint = $("lyric-anim-hint");
    if (animHint && anim) animHint.textContent = anim.hint;
  },

  async renderSettings() {
    this.refreshSettingsControls();
    let text = Store.available
      ? "Tus canciones se guardan en este dispositivo."
      : "Aviso: este navegador no permite guardar la biblioteca; se perderá al cerrar.";
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage } = await navigator.storage.estimate();
        if (typeof usage === "number") text += ` Espacio usado: ${this.formatBytes(usage)}.`;
      }
    } catch (error) { /* no crítico */ }
    const total = Library.songs.length;
    this.el.storageInfo.textContent = `${total} ${total === 1 ? "canción" : "canciones"}. ${text}`;
    if (typeof Features !== "undefined") Features.renderSettings();
  },

  /* ---------- Reproductor ---------- */

  showNowPlaying(song) {
    this.refreshNowPlayingInfo(song);
    this.setProgressValue(0);
    this.setTimeText("current", "0:00");
    this.setTimeText("duration", this.formatTime(song.duration));
    this.markPlaying();
    this.updatePlayState();
    this.updateMiniPlayer();
  },

  resetNowPlaying() {
    this.setCover(this.el.bigCover, null);
    this.setCover(this.el.miniCover, null);
    this.swapText(this.el.playerTitle, "Sin reproducción");
    this.swapText(this.el.playerArtist, "Pulsar RM");
    this.swapText(this.el.miniTitle, "Sin reproducción");
    this.swapText(this.el.miniArtist, "Pulsar RM");
    CoverColor.update(null);
    if (typeof LyricsScreen !== "undefined") LyricsScreen.onTrack(null);
    this.setProgressValue(0);
    this.setTimeText("current", "0:00");
    this.setTimeText("duration", "0:00");
    this.markPlaying();
    this.updatePlayState();
    this.updateMiniPlayer();
  },

  updatePlayState() {
    const playing = Player.currentId !== null && !Player.audio.paused;
    const symbol = playing ? Icons.pause : Icons.play;
    document.querySelectorAll('[data-action="toggle"]').forEach((button) => {
      const state = playing ? "pause" : "play";
      if (button.dataset.state !== state) { // solo si cambió: así el icono puede animarse
        button.dataset.state = state;
        button.innerHTML = symbol;
      }
      button.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
    });
    document.querySelectorAll("[data-song-play]").forEach((button) => {
      const isCurrent = Number(button.dataset.songPlay) === Player.currentId;
      button.innerHTML = isCurrent && playing ? Icons.pause : Icons.play;
    });
    document.documentElement.classList.toggle("is-playing", playing);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    }
  },

  updateProgress() {
    if (Player.seeking) return;
    const duration = Player.audio.duration;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    this.setProgressValue(hasDuration ? (Player.audio.currentTime / duration) * 1000 : 0);
    this.setTimeText("current", this.formatTime(Player.audio.currentTime));
  },

  // Las mismas barras y tiempos se repiten en el reproductor y en la pantalla de letras
  setProgressValue(value) {
    document.querySelectorAll("[data-progress]").forEach((input) => { input.value = value; });
  },

  setTimeText(kind, text) {
    document.querySelectorAll(`[data-time="${kind}"]`).forEach((el) => { if (el.textContent !== text) el.textContent = text; });
  },

  setDuration(seconds) {
    if (Number.isFinite(seconds) && seconds > 0) this.setTimeText("duration", this.formatTime(seconds));
  },

  updateMiniPlayer() {
    const visible = Player.currentId !== null && !Router.immersive();
    this.el.miniPlayer.classList.toggle("hidden", !visible);
  },

  /* ---------- Carátulas y menú ---------- */

  coverHTML(song) {
    const url = Covers.get(song);
    return url ? `<img src="${url}" alt="" loading="lazy" draggable="false">` : Icons.art;
  },

  setCover(element, url) {
    if (!element) return;
    if (url) {
      const current = element.querySelector("img");
      if (current && current.getAttribute("src") === url) return; // misma portada: sin parpadeo
      element.textContent = "";
      const image = document.createElement("img");
      image.alt = "";
      image.src = url;
      element.appendChild(image);
    } else {
      element.innerHTML = Icons.art;
    }
  },

  // Actualiza título, artista y carátula del reproductor SIN reiniciar la barra de progreso.
  refreshNowPlayingInfo(song) {
    const title = song.name || "Sin título";
    this.swapText(this.el.playerTitle, title);
    this.swapText(this.el.playerArtist, song.artist);
    this.swapText(this.el.miniTitle, title);
    this.swapText(this.el.miniArtist, song.artist);
    const url = Covers.get(song);
    this.setCover(this.el.bigCover, url);
    this.setCover(this.el.miniCover, url);
    CoverColor.update(song);
    if (typeof LyricsScreen !== "undefined") LyricsScreen.onTrack(song);
  },

  // Cambia un texto con un pequeño desvanecido (solo si de verdad cambió)
  swapText(element, text) {
    if (!element || element.textContent === text) return;
    element.textContent = text;
    element.classList.remove("swap");
    void element.offsetWidth; // reinicia la animación
    element.classList.add("swap");
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

  // Android pidió "reducir animaciones" o la persona las redujo en Ajustes → Rendimiento
  prefersReducedMotion() {
    if (Settings.values.animations && Settings.values.animations !== "full") return true;
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  /* ---------- Hojas emergentes (se cierran con Atrás de Android) ---------- */
  overlays: [],

  // Abre una hoja inferior con `html` dentro. Devuelve { el, close }.
  openSheet(html, onClose) {
    const box = document.createElement("div");
    box.className = "sheet sheet-open";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet-panel">${html}</div>`;
    const handle = { el: box, close: null };
    const close = () => {
      const i = this.overlays.indexOf(handle);
      if (i >= 0) this.overlays.splice(i, 1);
      box.remove();
      if (!this.overlays.length) document.body.classList.remove("no-scroll");
      if (onClose) onClose();
    };
    handle.close = close;
    box.querySelector(".sheet-backdrop").addEventListener("click", close);
    this.overlays.push(handle);
    document.body.classList.add("no-scroll");
    document.body.appendChild(box);
    return handle;
  },

  closeTopOverlay() {
    const top = this.overlays[this.overlays.length - 1];
    if (!top) return false;
    top.close();
    return true;
  },

  // Desvanece la fila antes de borrarla (si el usuario no pidió reducir animaciones).
  animateOut(id) {
    const rows = document.querySelectorAll(`[data-song="${id}"]`);
    if (!rows.length || this.prefersReducedMotion()) return Promise.resolve();
    rows.forEach((row) => row.classList.add("leaving"));
    return new Promise((resolve) => setTimeout(resolve, 220));
  },

  // Diálogo de confirmación propio (confirm() del navegador se ve como web y puede fallar en el APK).
  dismissConfirm: null,

  confirm(message, okLabel = "Aceptar", danger = false) {
    if (this.dismissConfirm) this.dismissConfirm(); // nunca dos diálogos a la vez
    return new Promise((resolve) => {
      const box = document.createElement("div");
      box.className = "confirm";
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      box.innerHTML = `
        <div class="confirm-backdrop"></div>
        <div class="confirm-panel">
          <p></p>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel">Cancelar</button>
            <button type="button" class="confirm-ok${danger ? " danger" : ""}"></button>
          </div>
        </div>`;
      box.querySelector("p").textContent = message;
      box.querySelector(".confirm-ok").textContent = okLabel;
      const finish = (value) => {
        document.removeEventListener("keydown", onKey, true);
        this.dismissConfirm = null;
        box.remove();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
      };
      this.dismissConfirm = () => finish(false);
      box.querySelector(".confirm-ok").addEventListener("click", () => finish(true));
      box.querySelector(".confirm-cancel").addEventListener("click", () => finish(false));
      box.querySelector(".confirm-backdrop").addEventListener("click", () => finish(false));
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(box);
      box.querySelector(".confirm-cancel").focus();
    });
  },

  toast(message, sticky = false) {
    const box = this.el.toast;
    box.textContent = message;
    box.classList.remove("hidden", "out");
    clearTimeout(this.toastTimer);
    clearTimeout(this.toastHide);
    if (!sticky) {
      this.toastTimer = setTimeout(() => {
        box.classList.add("out"); // se desvanece en vez de desaparecer de golpe
        this.toastHide = setTimeout(() => box.classList.add("hidden"), 220);
      }, 3500);
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

  // Sin id edita la canción que suena; con id (Información de la canción) edita esa
  open(id) {
    const song = Library.byId(id !== undefined && id !== null ? id : Player.currentId);
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
    const previous = { name: song.name, artist: song.artist, cover: song.cover, edited: song.edited };
    song.name = UI.el.editName.value.trim() || parsed.title;
    song.artist = UI.el.editArtist.value.trim() || parsed.artist;
    if (this.coverChanged) song.cover = this.pendingCover;
    // Canciones de carpetas: lo editado a mano no se sobrescribe al actualizar la biblioteca
    if (song.uri && (song.name !== previous.name || song.artist !== previous.artist || this.coverChanged)) song.edited = true;

    try {
      await Store.updateSong(song);
      if (this.coverChanged) Covers.release(song.id);
      UI.renderAll();
      if (Player.currentId === song.id) {
        UI.refreshNowPlayingInfo(song);
        Player.updateMediaMetadata(song);
        MediaBridge.update(true);
      }
      if (typeof SongInfo !== "undefined") SongInfo.refreshIfShowing(song.id);
      if (typeof LibraryBrowse !== "undefined") LibraryBrowse.invalidate();
      this.close();
      UI.toast("Información guardada.");
    } catch (error) {
      console.error("No se pudo guardar:", error);
      song.name = previous.name;
      song.artist = previous.artist;
      song.cover = previous.cover;
      song.edited = previous.edited;
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

  // Sin menú ni selección al mantener presionado (se siente como app, no como navegador).
  // Solo se permite en campos de texto: editor de información, editor de letras y buscador.
  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest && event.target.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
  });

  Player.init();
  Themes.init();
  Lyrics.init();
  LyricsEditor.init();
  Stage.init();
  Equalizer.init();
  Features.init();   // features.js: temporizador, pantallas Cola / Información / Letras, carpetas, rendimiento
  Router.init();
  UI.renderAll();

  await Store.open();
  await Settings.load();
  Equalizer.loadSaved();
  await Library.load();
  Features.afterLoad();
  UI.renderAll();

  if (!Store.available) {
    UI.toast("Este navegador no permite guardar la biblioteca; se perderá al cerrar.");
  }
  console.log("Pulsar RM " + resolveAppVersion() + " iniciado correctamente 💜");
});
