/* PULSAR RM 0.4a — Base estable + animaciones
   Módulos: Store (IndexedDB) · Settings · Library · Player · Router · UI · Lyrics (reservado)
   Todos los botones usan delegación de eventos: siguen funcionando aunque el HTML se vuelva a dibujar. */

"use strict";

const APP_VERSION = "0.4a";
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
const Settings = {
  defaults: { accent: "#A18AFF" },
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
    document.documentElement.style.setProperty("--accent", this.values.accent);
  }
};

/* =========================================================
   LYRICS — reservado para letras sincronizadas
   Cada canción ya tiene el campo `lyrics` (null por ahora).
   Futuro: guardar [{ time: 12.5, text: "..." }] y pintar en #lyrics.
   ========================================================= */
const Lyrics = {
  load(song) { /* futuro: leer song.lyrics y preparar líneas */ },
  onTime(seconds) { /* futuro: resaltar la línea actual */ },
  clear() { /* futuro: vaciar #lyrics */ }
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

  buildMeta(file, duration) {
    const cleanName = file.name.replace(/\.[^/.]+$/, "");
    let title = cleanName;
    let artist = "Archivo local";
    const parts = cleanName.split(" - ");
    if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(" - ").trim()) {
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    }
    return {
      name: title,
      artist: artist,
      fileName: file.name,
      mime: file.type || "",
      size: file.size,
      lastModified: file.lastModified,
      duration: duration,
      addedAt: Date.now(),
      lyrics: null
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
    this.updateMediaMetadata(song);

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
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name,
        artist: song.artist,
        album: "Pulsar RM"
      });
    } catch (error) { /* no crítico */ }
  }
};

/* =========================================================
   ROUTER — navegación entre pantallas (usa #hash: el botón Atrás de Android funciona)
   ========================================================= */
const Router = {
  views: ["home", "library", "player", "settings"],
  current: "home",

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

      const viewButton = target.closest("[data-view]");
      if (viewButton) {
        event.preventDefault();
        Router.go(viewButton.dataset.view);
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
    }
  },

  /* ---------- Dibujo ---------- */

  renderAll() {
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
        <div class="song-cover">♫</div>
        <div class="song-details">
          <strong>${this.escapeHTML(song.name)}</strong>
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
    this.el.playerTitle.textContent = song.name;
    this.el.playerArtist.textContent = song.artist;
    this.el.miniTitle.textContent = song.name;
    this.el.miniArtist.textContent = song.artist;
    this.el.progress.value = 0;
    this.el.currentTime.textContent = "0:00";
    this.el.duration.textContent = this.formatTime(song.duration);
    this.markPlaying();
    this.updatePlayState();
    this.updateMiniPlayer();
  },

  resetNowPlaying() {
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
    const visible = Player.currentId !== null && Router.current !== "player";
    this.el.miniPlayer.classList.toggle("hidden", !visible);
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
   ARRANQUE
   Primero se activan los botones y la navegación (síncrono),
   después se carga la biblioteca guardada (asíncrono).
   ========================================================= */
document.addEventListener("DOMContentLoaded", async () => {
  UI.cache();
  UI.bindEvents();
  Player.init();
  Router.init();
  UI.renderAll();

  await Store.open();
  await Settings.load();
  await Library.load();
  UI.renderAll();

  if (!Store.available) {
    UI.toast("Este navegador no permite guardar la biblioteca; se perderá al cerrar.");
  }
  console.log("Pulsar RM " + APP_VERSION + " iniciado correctamente 💜");
});
