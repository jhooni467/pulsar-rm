/* PULSAR RM 1.04 — features.js
   Módulos nuevos de la v1.04 (se cargan después de script.js, que contiene el núcleo):
   MediaBridge · SleepTimer · LyricsScreen · QueueScreen · SongInfo · LibraryScan · LibraryBrowse · Performance · SettingsNav · Features
   Todo lo que depende de Android pasa por Native (native.js) y se comprueba con Native.has(): en el navegador
   la app sigue funcionando sin esas funciones. */

"use strict";


/* Iconos que solo usan las pantallas nuevas (se suman a los de script.js) */
const _svg = (body) => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + body + '</g></svg>';
Object.assign(Icons, {
  close: Icons.x,
  grip: _svg('<path d="M8 7h8M8 12h8M8 17h8"/>'),
  info: _svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01" stroke-width="2.6"/>'),
  queue: _svg('<path d="M4 7h11M4 12h11M4 17h6"/><path d="M18 14.5v5l3.5-2.5z" fill="currentColor"/>'),
  album: _svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/>'),
  user: _svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c.8-3.4 3.6-5.2 7-5.2s6.2 1.8 7 5.2"/>'),
  tag: _svg('<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 2l-6.2 6.2a1.4 1.4 0 0 1-2 0z"/><path d="M8 8h.01" stroke-width="2.6"/>'),
  folder: _svg('<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.3H19a1.5 1.5 0 0 1 1.5 1.5v7.7A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  refresh: _svg('<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1"/><path d="M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5v4h-4"/><path d="M6.5 20.5v-4h4"/>'),
  trash: _svg('<path d="M5 7h14"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12"/>'),
  warn: _svg('<path d="M12 4.2l8.5 15H3.5z"/><path d="M12 10v4"/><path d="M12 17h.01" stroke-width="2.6"/>')
});

/* =========================================================
   MEDIA BRIDGE — avisa a Android de qué suena
   Android crea la notificación, los controles de la pantalla de bloqueo y atiende los botones de
   los auriculares con esta información (MediaSession nativa + servicio en primer plano).
   El audio lo sigue reproduciendo el <audio> de la web; Android solo lo "anuncia" y lo mantiene vivo.
   ========================================================= */
const MediaBridge = {
  coverSent: "",
  timer: 0,
  asked: false,

  update(now) {
    if (!Native.has("mediaUpdate")) return;
    if (now) { clearTimeout(this.timer); this.send(); return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), 120);
  },

  send() {
    const song = Library.byId(Player.currentId);
    if (!song) { Native.call("mediaStop"); return; }
    this.askNotifications();
    const audio = Player.audio;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : song.duration || 0;
    const payload = {
      id: song.id,
      title: song.name || "Sin título",
      artist: song.artist || "",
      album: song.album || "",
      coverFile: song.coverFile || "",
      durationMs: Math.round(duration * 1000),
      positionMs: Math.round((audio.currentTime || 0) * 1000),
      playing: !audio.paused,
      canPrev: Queue.ids.length > 0,
      canNext: Queue.ids.length > 0
    };
    // Portada elegida a mano (se guarda dentro de la canción): se envía una sola vez por canción
    const coverKey = song.id + ":" + (song.cover ? song.cover.size : 0);
    if (!song.coverFile && song.cover && this.coverSent !== coverKey) {
      this.coverSent = coverKey;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        payload.coverB64 = text.slice(text.indexOf(",") + 1);
        Native.call("mediaUpdate", JSON.stringify(payload));
      };
      reader.onerror = () => Native.call("mediaUpdate", JSON.stringify(payload));
      reader.readAsDataURL(song.cover);
      return;
    }
    Native.call("mediaUpdate", JSON.stringify(payload));
  },

  // Android 13+: la notificación necesita permiso. Se pide una sola vez, al empezar a reproducir.
  askNotifications() {
    if (this.asked || Settings.values.notifAsked) return;
    const info = Native.info();
    if (!info || info.notifications !== false) return;
    this.asked = true;
    Settings.set("notifAsked", true);
    UI.toast("Permite las notificaciones para controlar la música desde la pantalla de bloqueo.");
    setTimeout(() => Native.call("requestNotificationPermission"), 900);
  }
};

/* =========================================================
   TEMPORIZADOR — detiene la música solo
   Dos modos: tiempo (1–480 min) y "al terminar la canción". Usa la hora real del sistema, así que no se
   desajusta con la pantalla apagada. Al llegar la hora, el volumen baja suavemente y la música se pausa.
   Android recibe la hora de fin como respaldo (setSleepTimer) por si el WebView se retrasa.
   ========================================================= */
const SleepTimer = {
  mode: null,    // "time" | "track" | null
  endAt: 0,
  total: 0,
  fading: false,
  tickTimer: 0,
  FADE_MS: 8000,
  PRESETS: [5, 10, 15, 30, 45, 60, 90],

  init() {
    $("timer-presets").innerHTML = this.PRESETS.map((m) =>
      `<button type="button" class="eq-chip" data-timer-min="${m}">${m < 60 ? m + " min" : (m / 60) + (m === 60 ? " hora" : " h 30 min")}</button>`
    ).join("");
    document.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-timer-min]");
      if (chip) { event.preventDefault(); this.start(Number(chip.dataset.timerMin)); }
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.check(); });
    this.refresh();
  },

  active() { return this.mode !== null; },
  remainingMs() { return this.mode === "time" ? Math.max(0, this.endAt - Date.now()) : 0; },

  start(minutes) {
    const mins = Math.max(1, Math.min(480, Math.round(Number(minutes))));
    if (!Number.isFinite(mins)) return;
    this.cancel(true);
    this.mode = "time";
    this.total = mins * 60000;
    this.endAt = Date.now() + this.total;
    Native.call("setSleepTimer", String(this.endAt));
    this.arm();
    this.refresh();
    UI.toast(`La música se detendrá en ${this.format(this.total, true)}.`);
  },

  startEndOfTrack() {
    this.cancel(true);
    this.mode = "track";
    this.endAt = 0;
    Player.applyLoopMode(); // «Repetir una canción» no deja que la canción termine: durante el temporizador se desactiva
    this.arm();
    this.refresh();
    UI.toast("La música se detendrá al terminar esta canción.");
  },

  add(minutes) {
    if (this.mode !== "time") { this.start(minutes); return; }
    this.endAt += minutes * 60000;
    this.total += minutes * 60000;
    if (this.fading) this.stopFade();
    Native.call("setSleepTimer", String(this.endAt));
    this.refresh();
    UI.toast(`Se añadieron ${minutes} minutos.`);
  },

  cancel(silent) {
    const had = this.mode !== null;
    this.mode = null;
    this.endAt = 0;
    this.total = 0;
    clearInterval(this.tickTimer);
    this.tickTimer = 0;
    this.stopFade();
    Native.call("cancelSleepTimer");
    Player.applyLoopMode();
    this.refresh();
    if (had && !silent) UI.toast("Temporizador cancelado.");
  },

  // Revisa la hora cada segundo (y en cada timeupdate del audio, por si el temporizador de la página se retrasa)
  arm() {
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => { this.check(); this.refresh(true); }, 1000);
  },

  check() {
    if (this.mode !== "time") return;
    const left = this.endAt - Date.now();
    if (left <= 0) { this.finish(); return; }
    if (left <= this.FADE_MS && !this.fading && !Player.audio.paused) this.startFade(left);
  },

  startFade(ms) {
    this.fading = true;
    const secs = Math.max(0.3, ms / 1000);
    if (AudioGraph.ready) { Player.fadeLevel = 0; Player.applyLevel(secs); }
    else Player.softVolume(Player.audio, Player.audio.volume, 0, secs); // sin Web Audio: baja el volumen del propio <audio>
  },

  stopFade() {
    if (!this.fading) return;
    this.fading = false;
    this.restoreVolume();
  },

  restoreVolume() {
    Player.fadeLevel = 1;
    Player.decks.forEach((deck) => { clearInterval(deck.el._ramp); });
    if (AudioGraph.ready) Player.applyLevel(0.05);
    else Player.decks.forEach((deck) => { deck.el.volume = Player.duckLevel; });
  },

  // Android avisa que llegó la hora (por si la página estaba dormida)
  fire(immediate) {
    if (this.mode === "time" || immediate) this.finish();
  },

  finish() {
    if (this.mode === null) return;
    this.mode = null;
    this.endAt = 0;
    clearInterval(this.tickTimer);
    this.tickTimer = 0;
    Player.pause();
    this.fading = false;
    setTimeout(() => this.restoreVolume(), 150); // la próxima vez que suene, vuelve con todo el volumen
    Native.call("cancelSleepTimer");
    Player.applyLoopMode();
    this.refresh();
    UI.toast("Temporizador terminado: música detenida.");
  },

  // Lo llama Player.handleEnded: true = la canción terminó y aquí se detiene todo
  consumeTrackEnd() {
    if (this.mode !== "track") return false;
    this.mode = null;
    clearInterval(this.tickTimer);
    this.tickTimer = 0;
    Player.applyLoopMode();
    Player.endOfQueue();
    this.refresh();
    UI.toast("Temporizador terminado: música detenida.");
    return true;
  },

  format(ms, words) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (words) {
      const mins = Math.max(1, Math.round(ms / 60000));
      if (mins >= 60) return `${Math.floor(mins / 60)} h${mins % 60 ? " " + (mins % 60) + " min" : ""}`;
      return `${mins} ${mins === 1 ? "minuto" : "minutos"}`;
    }
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  },

  label() {
    if (this.mode === "time") return this.format(this.remainingMs());
    if (this.mode === "track") return "Fin de canción";
    return "";
  },

  refresh(light) {
    const on = this.active();
    const label = this.label();
    const queueLabel = $("q-timer-label");
    if (queueLabel) queueLabel.textContent = on ? "Temporizador · " + label : "Temporizador";
    const chip = $("q-timer");
    if (chip) chip.classList.toggle("on", on);
    const note = $("set-timer-text");
    if (note) note.textContent = on
      ? (this.mode === "time" ? `Activo: la música se detendrá en ${this.format(this.remainingMs())}.` : "Activo: la música se detendrá al terminar la canción.")
      : "Detén la música automáticamente después de un tiempo.";
    if (light && Router.current !== "timer") return;

    const clock = $("timer-clock"), caption = $("timer-caption"), arc = $("timer-arc");
    if (!clock) return;
    clock.textContent = on ? (this.mode === "time" ? this.format(this.remainingMs()) : "♪") : "—";
    caption.textContent = !on ? "Sin temporizador" : this.mode === "time" ? (this.fading ? "Bajando el volumen…" : "Tiempo restante") : "Al terminar la canción";
    const C = 339.3;
    const fraction = this.mode === "time" && this.total ? Math.max(0, Math.min(1, this.remainingMs() / this.total)) : (this.mode === "track" ? 1 : 0);
    arc.style.strokeDasharray = String(C);
    arc.style.strokeDashoffset = String(C * (1 - fraction));
    $("view-timer").classList.toggle("is-on", on);
    $("timer-active").classList.toggle("hidden", !on);
    const nativeNote = $("timer-native-note");
    if (nativeNote) nativeNote.textContent = Native.has("setSleepTimer")
      ? "Android también guarda la hora de fin como respaldo."
      : "En el navegador el temporizador solo funciona con la página abierta.";
  }
};

/* =========================================================
   PANTALLA DE LETRAS (v1.04)
   La letra tiene su pantalla propia: título, vista sincronizada o texto, personalización rápida, fondo con
   la portada difuminada y pantalla encendida mientras se lee. El dibujo de las líneas es el de la v1.03.
   ========================================================= */
const LyricsScreen = {
  wake: null,       // WakeLockSentinel del navegador
  lastCover: "",

  init() {
    Settings.watch(["keepScreenOn"], () => this.applyWake());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.applyWake(); });
  },

  onTrack(song) {
    const title = $("lyrics-song"), artist = $("lyrics-song-artist");
    if (title) UI.swapText(title, song ? song.name || "Sin título" : "Sin reproducción");
    if (artist) UI.swapText(artist, song ? song.artist || "" : "Pulsar RM");
    const url = song ? Covers.get(song) : null;
    const backdrop = $("lyrics-backdrop");
    if (backdrop && url !== this.lastCover) {
      this.lastCover = url || "";
      backdrop.style.backgroundImage = url ? `url("${url}")` : "";
      backdrop.classList.toggle("has-cover", Boolean(url));
    }
  },

  toggleOptions(force) {
    const box = $("lyrics-options"), button = $("lyrics-options-btn");
    const open = typeof force === "boolean" ? force : box.classList.contains("hidden");
    box.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    button.classList.toggle("selected", open);
  },

  onRoute(name) {
    if (name !== "lyrics") this.toggleOptions(false);
    this.applyWake();
  },

  // Pantalla encendida solo mientras se ve la letra y el ajuste está activo
  applyWake() {
    const want = Router.current === "lyrics" && Settings.values.keepScreenOn && !document.hidden;
    if (Native.has("setKeepScreenOn")) { Native.call("setKeepScreenOn", Boolean(want)); return; }
    try {
      if (want && "wakeLock" in navigator && !this.wake) {
        navigator.wakeLock.request("screen").then((sentinel) => {
          this.wake = sentinel;
          sentinel.addEventListener("release", () => { if (this.wake === sentinel) this.wake = null; });
        }).catch(() => {});
      } else if (!want && this.wake) {
        this.wake.release().catch(() => {});
        this.wake = null;
      }
    } catch (error) { /* no crítico */ }
  },

  // Canciones de carpetas: la letra puede estar en un archivo .lrc/.vtt/.srt/.txt junto a la canción o dentro del archivo.
  // Android la lee solo cuando se necesita (no al actualizar la biblioteca).
  async fetchNative(song) {
    if (!song || song.lyrics || !song.lyricsHint || !Native.has("readLyrics")) return;
    if (song._lyricsTried) return;
    song._lyricsTried = true;
    try {
      const answer = Native.json("readLyrics", JSON.stringify({ uri: song.uri, lrcUri: song.lrcUri || "", lyrics: song.lyricsHint, mime: song.mime || "" }));
      if (!answer || !answer.ok || !answer.b64) return;
      const bin = atob(answer.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const text = LyricsParser.decode(bytes.buffer).replace(/\r\n?/g, "\n").trim();
      if (!text) return;
      song.lyrics = { raw: text, delay: 0, updatedAt: Date.now(), source: "auto" };
      await Store.updateSong(song);
      if (Lyrics.song && Lyrics.song.id === song.id) Lyrics.load(song);
      if (typeof SongInfo !== "undefined") SongInfo.refreshIfShowing(song.id);
    } catch (error) { console.warn("No se pudo leer la letra del archivo", error); }
  }
};

/* =========================================================
   PANTALLA COLA (v1.04)
   Dibuja la cola real (Queue, en script.js): canción actual, pendientes y ya reproducidas.
   Arrastra el asa ⠿ para reordenar (o usa las flechas del teclado), ✕ para quitar, toca una fila
   para saltar a ella, «i» para ver su información. Solo dibuja: los cambios los hace Queue.
   ========================================================= */
const QueueScreen = {
  MAX_UPCOMING: 200,
  dirty: true,
  dragging: null,
  showPlayed: false,

  init() {
    const list = $("queue-list");
    list.addEventListener("click", (event) => {
      const t = event.target;
      const row = t.closest("[data-qi]");
      if (t.closest("[data-q-toggle-played]")) { this.showPlayed = !this.showPlayed; this.render(); return; }
      if (t.closest("[data-q-add]")) { this.openPicker(); return; }
      if (!row) return;
      const index = Number(row.dataset.qi);
      if (t.closest("[data-q-info]")) { SongInfo.open(Queue.ids[index], "queue"); return; }
      if (t.closest("[data-q-remove]")) { this.removeAt(index, row); return; }
      if (t.closest(".q-grip")) return;
      Player.skipTo(index);
    });
    this.initDrag(list);
    list.addEventListener("keydown", (event) => {
      const grip = event.target.closest(".q-grip");
      if (!grip) return;
      const row = grip.closest("[data-qi]");
      const index = Number(row.dataset.qi);
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const to = index + (event.key === "ArrowUp" ? -1 : 1);
        if (Queue.move(index, to)) {
          this.announce(`Movida a la posición ${to - Queue.pos} de las pendientes`);
          requestAnimationFrame(() => { const g = list.querySelector(`[data-qi="${to}"] .q-grip`); if (g) g.focus(); });
        }
      }
    });
    Settings.watch(["crossfade", "crossfadeSecs", "gapless", "shuffle", "repeat"], () => this.refreshMix());
    // La fila actual late mientras suena
    Player.onActive("play", () => this.markPlaying());
    Player.onActive("pause", () => this.markPlaying());
  },

  announce(text) { UI.toast(text); },

  // Cualquier cambio de la cola pasa por aquí
  refresh() {
    this.dirty = true;
    if (Router.current === "queue" && !this.dragging) this.render();
    this.updateSummary();
  },

  onRoute() {
    if (this.dirty) this.render();
    this.refreshMix();
  },

  markPlaying() {
    const row = document.querySelector("#queue-list .q-now");
    if (row) row.classList.toggle("is-playing", !Player.audio.paused);
  },

  updateSummary() {
    const el = $("queue-summary");
    if (!el) return;
    const total = Queue.ids.length;
    if (!total) { el.textContent = "Sin canciones"; return; }
    const secs = Queue.remainingSeconds();
    const left = Queue.upcoming().length;
    let text = `${total} ${total === 1 ? "canción" : "canciones"}`;
    if (secs > 0) text += ` · ${this.formatLong(secs)} restantes`;
    else if (left === 0) text += " · al final";
    el.textContent = text;
  },

  formatLong(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 1) return "menos de 1 min";
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  },

  rowHTML(id, index, kind) {
    const song = Library.byId(id);
    if (!song) return "";
    const art = Covers.get(song);
    const cover = art ? `<span class="song-cover" style="background-image:url('${art}')"></span>` : `<span class="song-cover default">${Icons.note}</span>`;
    const dur = song.duration ? UI.formatTime(song.duration) : "";
    const missing = song.missing ? " missing" : "";
    const info = `<button type="button" class="icon-btn" data-q-info aria-label="Información de ${UI.escapeHTML(song.name)}">${Icons.info}</button>`;
    const title = `<strong>${UI.escapeHTML(song.name)}</strong><small>${UI.escapeHTML(song.artist || "")}${song.missing ? " · no disponible" : ""}</small>`;
    if (kind === "now") {
      return `<div class="q-row q-now${Player.audio.paused ? "" : " is-playing"}" data-qi="${index}">
        ${cover}<span class="song-details">${title}</span><span class="eq-bars" aria-hidden="true"><i></i><i></i><i></i></span>${info}</div>`;
    }
    if (kind === "played") {
      return `<div class="q-row played${missing}" data-qi="${index}">${cover}<span class="song-details">${title}</span><span class="q-dur">${dur}</span>${info}</div>`;
    }
    return `<div class="q-row${missing}" data-qi="${index}" data-q-id="${id}">
      <button type="button" class="q-grip" aria-label="Mover ${UI.escapeHTML(song.name)}. Usa las flechas arriba y abajo" title="Arrastra para reordenar">${Icons.grip}</button>
      ${cover}<span class="song-details">${title}</span><span class="q-dur">${dur}</span>${info}
      <button type="button" class="icon-btn" data-q-remove aria-label="Quitar ${UI.escapeHTML(song.name)} de la cola">${Icons.close}</button></div>`;
  },

  render() {
    this.dirty = false;
    const list = $("queue-list");
    if (!list) return;
    this.updateSummary();
    list.classList.remove("loading");
    if (!Queue.ids.length) {
      list.innerHTML = `<div class="empty-state">
        <span class="empty-ico">${Icons.queue}</span>
        <h3>Tu cola está vacía</h3>
        <p>${Library.songs.length ? "Toca una canción de la biblioteca o añade canciones a la cola." : "Importa música para empezar."}</p>
        ${Library.songs.length ? `<button type="button" class="add-music small" data-q-add>Añadir canciones</button>` : ""}</div>`;
      return;
    }
    let html = "";
    const now = Queue.pos >= 0 ? Queue.ids[Queue.pos] : null;
    if (now !== null) html += `<h3 class="q-head">Reproduciendo ahora</h3>` + this.rowHTML(now, Queue.pos, "now");
    const upcoming = Queue.upcoming();
    html += `<h3 class="q-head">A continuación<span>${upcoming.length}</span></h3>`;
    if (!upcoming.length) {
      html += `<p class="q-empty">No hay más canciones pendientes.${Settings.values.repeat === "all" ? " Al terminar, la cola vuelve a empezar." : ""}</p>`;
    } else {
      const shown = upcoming.slice(0, this.MAX_UPCOMING);
      html += `<div class="q-upcoming">` + shown.map((id, i) => this.rowHTML(id, Queue.pos + 1 + i, "up")).join("") + `</div>`;
      if (upcoming.length > shown.length) html += `<p class="q-empty">…y ${upcoming.length - shown.length} más</p>`;
    }
    const played = Queue.played();
    if (played.length) {
      html += `<button type="button" class="q-head q-toggle" data-q-toggle-played aria-expanded="${this.showPlayed}">Ya sonaron<span>${played.length}</span><i class="chev"></i></button>`;
      if (this.showPlayed) html += played.map((id, i) => this.rowHTML(id, i, "played")).join("");
    }
    list.innerHTML = html;
    this.measure();
  },

  measure() { /* las filas tienen altura fija por CSS */ },

  removeAt(index, row) {
    const done = () => { Queue.remove(index); };
    if (row && !UI.prefersReducedMotion()) {
      row.classList.add("leaving");
      setTimeout(done, 180);
    } else done();
  },

  /* ---------- Reordenar arrastrando ---------- */
  initDrag(list) {
    let drag = null;
    const rows = () => Array.from(list.querySelectorAll(".q-upcoming .q-row"));

    list.addEventListener("pointerdown", (event) => {
      const grip = event.target.closest(".q-grip");
      if (!grip || (event.pointerType === "mouse" && event.button !== 0)) return;
      const row = grip.closest(".q-row");
      const all = rows();
      const from = all.indexOf(row);
      if (from < 0) return;
      event.preventDefault();
      try { grip.setPointerCapture(event.pointerId); } catch (error) { /* no crítico */ }
      const rects = all.map((r) => r.getBoundingClientRect());
      drag = { row, grip, all, from, to: from, startY: event.clientY, h: rects[0].height, rects, scrollY: window.scrollY, pointerId: event.pointerId };
      this.dragging = drag;
      row.classList.add("dragging");
      list.classList.add("is-dragging");
      this.autoScroll();
    });

    list.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.lastY = event.clientY;
      this.moveDrag(drag);
    });

    const end = (event) => {
      if (!drag || (event && event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
      const d = drag;
      drag = null;
      this.dragging = null;
      cancelAnimationFrame(this.scrollRaf);
      d.all.forEach((r) => { r.style.transform = ""; r.classList.remove("shift"); });
      d.row.classList.remove("dragging");
      list.classList.remove("is-dragging");
      if (d.to !== d.from) Queue.move(Queue.pos + 1 + d.from, Queue.pos + 1 + d.to);
      else if (this.dirty) this.render();
    };
    list.addEventListener("pointerup", end);
    list.addEventListener("pointercancel", end);
    list.addEventListener("lostpointercapture", end);
  },

  moveDrag(d) {
    const y = (d.lastY === undefined ? d.startY : d.lastY);
    const dy = y - d.startY + (window.scrollY - d.scrollY);
    d.row.style.transform = `translateY(${dy}px)`;
    // Fila hacia la que cae la que se arrastra: se compara el centro con el de las demás
    const center = d.rects[d.from].top + d.h / 2 + dy;
    let to = d.from;
    d.rects.forEach((rect, i) => {
      const mid = rect.top + rect.height / 2;
      if (i < d.from && center < mid) to = Math.min(to, i);
      if (i > d.from && center > mid) to = Math.max(to, i);
    });
    d.to = to;
    d.all.forEach((row, i) => {
      if (i === d.from) return;
      let shift = 0;
      if (d.from < to && i > d.from && i <= to) shift = -d.h;
      if (d.from > to && i < d.from && i >= to) shift = d.h;
      row.classList.add("shift");
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  },

  // Al acercarse al borde de la pantalla, la lista se desplaza sola
  autoScroll() {
    const step = () => {
      const d = this.dragging;
      if (!d) return;
      const y = d.lastY === undefined ? d.startY : d.lastY;
      const edge = 90, speed = 14;
      if (y < edge + 60) window.scrollBy(0, -speed * Math.min(1, (edge + 60 - y) / edge));
      else if (y > window.innerHeight - edge - 70) window.scrollBy(0, speed * Math.min(1, (y - (window.innerHeight - edge - 70)) / edge));
      this.moveDrag(d);
      this.scrollRaf = requestAnimationFrame(step);
    };
    this.scrollRaf = requestAnimationFrame(step);
  },

  /* ---------- Añadir canciones a la cola ---------- */
  openPicker() {
    if (!Library.songs.length) { UI.toast("Importa música primero."); return; }
    const sheet = UI.openSheet(`
      <div class="sheet-head"><h3>Añadir a la cola</h3><button type="button" class="icon-btn" data-sheet-close aria-label="Cerrar">${Icons.close}</button></div>
      <input type="search" class="sheet-search" placeholder="Buscar canciones o artistas…" autocomplete="off" aria-label="Buscar canciones">
      <div class="sheet-list" role="list"></div>`);
    const listEl = sheet.el.querySelector(".sheet-list");
    const input = sheet.el.querySelector(".sheet-search");
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const found = Library.songs.filter((s) => !s.missing && (!q || (s.name + " " + (s.artist || "") + " " + (s.album || "")).toLowerCase().includes(q)));
      const shown = found.slice(0, 80);
      listEl.innerHTML = shown.length ? shown.map((s) => {
        const art = Covers.get(s);
        const cover = art ? `<span class="song-cover" style="background-image:url('${art}')"></span>` : `<span class="song-cover default">${Icons.note}</span>`;
        return `<div class="q-row pick" role="listitem" data-pick="${s.id}">${cover}<span class="song-details"><strong>${UI.escapeHTML(s.name)}</strong><small>${UI.escapeHTML(s.artist || "")}</small></span>
          <button type="button" class="chip-btn tiny" data-pick-next>Siguiente</button><button type="button" class="chip-btn tiny" data-pick-end>Al final</button></div>`;
      }).join("") + (found.length > shown.length ? `<p class="q-empty">Escribe para ver más (${found.length - shown.length} más)</p>` : "")
        : `<p class="q-empty">No hay resultados.</p>`;
    };
    input.addEventListener("input", draw);
    sheet.el.addEventListener("click", (event) => {
      if (event.target.closest("[data-sheet-close]")) { sheet.close(); return; }
      const row = event.target.closest("[data-pick]");
      if (!row) return;
      const id = Number(row.dataset.pick);
      if (event.target.closest("[data-pick-next]")) { Queue.add(id, "next"); UI.toast("Se reproducirá a continuación."); }
      else if (event.target.closest("[data-pick-end]")) { Queue.add(id, "end"); UI.toast("Añadida al final de la cola."); }
    });
    draw();
    setTimeout(() => input.focus({ preventScroll: true }), 120);
  },

  // Resumen del cuadro «Mezcla y transición»
  refreshMix() {
    const v = Settings.values;
    const label = $("mix-state");
    if (label) label.textContent = v.crossfade ? `Crossfade ${v.crossfadeSecs || 4} s` : (v.gapless !== false ? "Continua" : "Normal");
    const secs = $("mix-secs");
    if (secs) secs.textContent = `${v.crossfadeSecs || 4} s`;
    const block = $("mix-duration");
    if (block) block.classList.toggle("disabled", !v.crossfade);
  }
};

/* =========================================================
   INFORMACIÓN DE LA CANCIÓN (v1.04)
   Muestra todo lo que se sabe de una canción: etiquetas, formato, archivo, origen, letra…
   Con la app Android también pide el detalle técnico (frecuencia de muestreo, canales, bitrate) al archivo.
   ========================================================= */
const SongInfo = {
  songId: null,
  follow: false,   // true = abierta desde el reproductor: sigue a la canción que suena
  nativeCache: new Map(),

  init() {},

  // Abre la pantalla. Sin id: la canción actual. from = pantalla de la que se viene (Atrás vuelve ahí).
  open(id, from) {
    const target = id !== undefined && id !== null ? id : Player.currentId;
    if (target === null || !Library.byId(target)) { UI.toast("Reproduce una canción para ver su información."); return; }
    this.songId = target;
    this.follow = id === undefined || id === null;
    Router.go("info", from);
  },

  onRoute() {
    if (!Library.byId(this.songId) && Player.currentId !== null) { this.songId = Player.currentId; this.follow = true; }
    this.render();
  },

  onTrackChange() { if (this.follow && Router.current === "info" && Player.currentId !== null) { this.songId = Player.currentId; this.render(); } },

  refreshIfShowing(id) { if (Router.current === "info" && this.songId === id) this.render(); },

  fmtDate(ms) {
    if (!ms) return "—";
    try { return new Date(ms).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" }); } catch (error) { return "—"; }
  },

  fmtSize(bytes) {
    if (!bytes) return "—";
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB";
  },

  format(song) {
    const ext = ((song.fileName || "").split(".").pop() || "").toUpperCase();
    const mime = song.mime || (song.type || "");
    const names = { "audio/mpeg": "MP3", "audio/mp4": "AAC / M4A", "audio/aac": "AAC", "audio/flac": "FLAC", "audio/x-flac": "FLAC", "audio/ogg": "Ogg Vorbis", "audio/opus": "Opus", "audio/wav": "WAV", "audio/x-wav": "WAV", "audio/webm": "WebM", "audio/x-m4a": "M4A" };
    return names[mime] || (ext && ext.length <= 5 ? ext : "") || mime || "—";
  },

  lyricsStatus(song) {
    if (song.lyrics && song.lyrics.raw) {
      const raw = song.lyrics.raw;
      const synced = /\[\d{1,3}:\d{2}/.test(raw) || /-->/.test(raw);
      const words = /<\d{1,3}:\d{2}/.test(raw);
      const origin = song.lyrics.source === "auto" ? " (del archivo)" : "";
      return (words ? "Sincronizada palabra por palabra" : synced ? "Sincronizada" : "Texto sin sincronizar") + origin;
    }
    if (song.lyricsHint) return song.lyricsHint === "embedded" ? "Incluida dentro del archivo" : `Archivo .${song.lyricsHint} junto a la canción`;
    return "No tiene";
  },

  rows(song) {
    const folder = song.uri ? ((Settings.values.folders || []).find((f) => f.uri === song.folderUri) || {}).name : "";
    const e = UI.escapeHTML;
    const dash = (value) => (value ? e(String(value)) : "—");
    const track = song.track ? (song.disc ? `${song.disc}-${song.track}` : String(song.track)) : "";
    const list = [
      ["Título", dash(song.name)], ["Artista", dash(song.artist)], ["Álbum", dash(song.album)],
      ["Artista del álbum", dash(song.albumArtist && song.albumArtist !== song.artist ? song.albumArtist : "")],
      ["Género", dash(song.genre)], ["Año", dash(song.year)], ["Pista", dash(track)],
      ["Duración", song.duration ? UI.formatTime(song.duration) : "—"],
      ["Formato", dash(this.format(song))],
      ["Calidad", dash(song.bitrate ? Math.round(song.bitrate / 1000) + " kbps" : "")],
      ["Frecuencia de muestreo", `<span data-info-extra="sampleRate">—</span>`],
      ["Canales", `<span data-info-extra="channels">—</span>`],
      ["Tamaño", this.fmtSize(song.size)],
      ["Archivo", dash(song.fileName)],
      ["Origen", song.uri ? `Carpeta${folder ? " «" + e(folder) + "»" : ""}${song.missing ? " · <b class=\"warn\">no disponible</b>" : ""}` : "Importada a la app"],
      ["Letra", this.lyricsStatus(song)],
      ["Añadida", this.fmtDate(song.addedAt)],
      ["Modificada", this.fmtDate(song.lastModified)]
    ];
    return list.map(([k, v]) => `<div class="info-row"><span>${k}</span><b>${v}</b></div>`).join("");
  },

  render() {
    const song = Library.byId(this.songId);
    const list = $("info-list");
    if (!song) {
      $("info-title").textContent = "Canción no encontrada";
      $("info-artist").textContent = "";
      list.innerHTML = `<p class="q-empty">Esta canción ya no está en la biblioteca.</p>`;
      $("info-links").innerHTML = "";
      return;
    }
    $("info-title").textContent = song.name || "Sin título";
    $("info-artist").textContent = song.artist || "";
    const art = Covers.get(song);
    const cover = $("info-cover");
    cover.style.backgroundImage = art ? `url("${art}")` : "";
    cover.classList.toggle("default", !art);
    cover.innerHTML = art ? "" : Icons.note;
    list.innerHTML = this.rows(song);
    const links = [];
    if (song.album) links.push(`<button type="button" class="chip-btn" data-col="album" data-key="${encodeURIComponent(LibraryBrowse.albumKey(song))}" data-parent="info">${Icons.album}<span>${UI.escapeHTML(song.album)}</span></button>`);
    if (song.artist) links.push(`<button type="button" class="chip-btn" data-col="artist" data-key="${encodeURIComponent(LibraryBrowse.artistKey(song))}" data-parent="info">${Icons.user}<span>${UI.escapeHTML(LibraryBrowse.artistKey(song))}</span></button>`);
    if (song.genre) links.push(`<button type="button" class="chip-btn" data-col="genre" data-key="${encodeURIComponent(song.genre)}" data-parent="info">${Icons.tag}<span>${UI.escapeHTML(song.genre)}</span></button>`);
    $("info-links").innerHTML = links.join("");
    this.loadNative(song);
  },

  // Detalle técnico desde Android (frecuencia de muestreo, canales)
  loadNative(song) {
    if (!song.uri || !Native.has("getTrackInfo")) return;
    const apply = (data) => {
      if (this.songId !== song.id) return;
      const set = (name, text) => { const el = document.querySelector(`[data-info-extra="${name}"]`); if (el) el.textContent = text; };
      if (data.sampleRate) set("sampleRate", (data.sampleRate / 1000).toFixed(data.sampleRate % 1000 ? 1 : 0) + " kHz");
      if (data.channels) set("channels", data.channels === 1 ? "Mono" : data.channels === 2 ? "Estéreo" : data.channels + " canales");
      if (data.bitrate && !song.bitrate) song.bitrate = data.bitrate;
    };
    if (this.nativeCache.has(song.id)) { apply(this.nativeCache.get(song.id)); return; }
    setTimeout(() => {
      const data = Native.json("getTrackInfo", song.uri);
      if (data) { this.nativeCache.set(song.id, data); apply(data); }
    }, 0);
  },

  play() {
    const id = this.songId;
    if (id === null || !Library.byId(id)) return;
    if (id === Player.currentId) { Player.toggle(); return; }
    Player.play(id, { context: Library.playableIds() });
  },

  playNext() {
    const id = this.songId;
    if (id === null || !Library.byId(id)) return;
    if (id === Player.currentId) { UI.toast("Esta canción ya está sonando."); return; }
    if (Player.currentId === null) { this.play(); return; }
    Queue.add(id, "next");
    UI.toast("Se reproducirá a continuación.");
  },

  edit() {
    if (this.songId === null) return;
    Editor.open(this.songId);
  }
};

/* =========================================================
   BIBLIOTECA POR CARPETAS (v1.04) — LibraryScan
   Solo en la app Android: la persona elige carpetas (selector del sistema, permiso persistente) y Android
   lee los archivos. La app NO vigila las carpetas: solo se revisan al pulsar «Actualizar biblioteca»
   (o al añadir una carpeta, que se lee una vez).
   Android entrega los archivos por lotes; aquí se concilian con lo que ya hay:
     nueva · actualizada (cambió el archivo) · sin cambios · restaurada (volvió a estar disponible)
     no disponible (ya no está o la carpeta es inaccesible) · duplicada · ignorada (la persona la quitó)
   Lo que la persona editó a mano (título, artista, carátula, letra) nunca se sobrescribe.
   ========================================================= */
const LibraryScan = {
  running: false,
  session: null,
  watchdog: 0,
  lastResult: null,

  init() {
    Native.on("folderPicked", (data) => this.onPicked(data));
    Native.on("folderCancelled", () => { this.picking = false; });
    Native.on("scanProgress", (data) => this.onProgress(data));
    Native.on("scanBatch", (data) => this.onBatch(data));
    Native.on("scanDone", (data) => this.onDone(data));

    const list = $("folder-list");
    if (list) list.addEventListener("click", (event) => {
      const row = event.target.closest("[data-fi]");
      if (!row) return;
      const folder = (Settings.values.folders || [])[Number(row.dataset.fi)];
      if (!folder) return;
      if (event.target.closest("[data-folder-scan]")) this.start({ folders: [folder.uri] });
      else if (event.target.closest("[data-folder-remove]")) this.removeFolder(folder.uri);
    });
  },

  supported() {
    const info = Native.info();
    return Boolean(info && info.folders && Native.has("pickFolder") && Native.has("scanLibrary"));
  },

  /* ---------- Carpetas ---------- */

  addFolder() {
    if (!this.supported()) {
      UI.toast(Native.available ? "Este Android no permite elegir carpetas (hace falta Android 8 o superior)." : Native.oldShell ? "Este APK es antiguo y no trae las funciones de Android. Instala el último desde Releases." : "Elegir carpetas solo está disponible en la app de Android.");
      return;
    }
    if (this.running) { UI.toast("Espera a que termine la actualización."); return; }
    this.picking = true;
    Native.call("pickFolder");
  },

  async onPicked(data) {
    this.picking = false;
    if (!data || !data.uri) return;
    const folders = (Settings.values.folders || []).slice();
    if (folders.some((f) => f.uri === data.uri)) { UI.toast("Esa carpeta ya está añadida."); return; }
    // Una subcarpeta de una carpeta ya añadida no aporta nada nuevo (los archivos se reconocen por su identificador)
    const parent = folders.find((f) => data.uri.startsWith(f.uri + "%2F"));
    if (parent) {
      Native.call("releaseFolder", data.uri);
      UI.toast(`Ya está incluida dentro de «${parent.name}».`);
      return;
    }
    folders.push({ uri: data.uri, name: data.name || "Carpeta", addedAt: Date.now(), lastScan: 0, count: 0 });
    await Settings.set("folders", folders);
    this.renderFolders();
    UI.toast(`Carpeta «${data.name || "Carpeta"}» añadida. Leyendo canciones…`);
    this.start({ folders: [data.uri], reason: "add" });
  },

  async removeFolder(uri) {
    const folder = (Settings.values.folders || []).find((f) => f.uri === uri);
    if (!folder) return;
    if (this.running) { UI.toast("Espera a que termine la actualización."); return; }
    const songs = Library.songs.filter((s) => s.folderUri === uri);
    const text = songs.length
      ? `¿Quitar la carpeta «${folder.name}»? Sus ${songs.length} canciones saldrán de la biblioteca. Tus archivos no se borran.`
      : `¿Quitar la carpeta «${folder.name}»?`;
    if (!(await UI.confirm(text, "Quitar", true))) return;
    await this.removeSongs(songs);
    Native.call("releaseFolder", uri);
    await Settings.set("folders", (Settings.values.folders || []).filter((f) => f.uri !== uri));
    this.renderFolders();
    UI.renderAll();
    UI.toast("Carpeta quitada.");
  },

  // Quita canciones de la biblioteca (sin tocar sus archivos)
  async removeSongs(songs) {
    if (!songs.length) return;
    const ids = new Set(songs.map((s) => s.id));
    if (ids.has(Player.currentId)) Player.stop();
    try { await Store.removeSongs(songs.map((s) => s.id)); } catch (error) { console.error(error); }
    Library.songs = Library.songs.filter((s) => !ids.has(s.id));
    songs.forEach((s) => { Covers.release(s.id); Queue.removeId(s.id); });
    LibraryBrowse.invalidate();
  },

  renderFolders() {
    const box = $("folder-list");
    if (!box) return;
    const supported = this.supported();
    const addBtn = $("folder-add"), scanBtn = $("scan-btn");
    [addBtn, scanBtn].forEach((btn) => { if (btn) { btn.classList.toggle("disabled", !supported); btn.setAttribute("aria-disabled", String(!supported)); } });
    const text = $("folders-text");
    const folders = Settings.values.folders || [];
    if (!supported) {
      if (text) text.textContent = Native.available
        ? "Este Android no permite elegir carpetas. Puedes importar archivos sueltos."
        : Native.oldShell
          ? "Este APK es antiguo y no trae las funciones de Android. Instala el último APK desde Releases para elegir carpetas."
          : "Elegir carpetas está disponible en la app de Android. En el navegador puedes importar archivos sueltos.";
      box.innerHTML = "";
      return;
    }
    if (text) text.textContent = "Elige las carpetas que Pulsar RM puede leer. El permiso se conserva entre sesiones y puedes quitarlo cuando quieras.";
    if (!folders.length) {
      box.innerHTML = `<div class="folder-empty">${Icons.folder}<span>Aún no hay carpetas. Añade la carpeta donde guardas tu música.</span></div>`;
      return;
    }
    box.innerHTML = folders.map((f, i) => {
      const count = Library.songs.reduce((n, s) => n + (s.folderUri === f.uri ? 1 : 0), 0);
      const missing = Library.songs.reduce((n, s) => n + (s.folderUri === f.uri && s.missing ? 1 : 0), 0);
      const last = f.lastScan ? "Revisada " + this.when(f.lastScan) : "Sin revisar";
      return `<div class="folder-row" data-fi="${i}">
        <span class="folder-ico">${Icons.folder}</span>
        <span class="folder-info"><strong>${UI.escapeHTML(f.name)}</strong>
          <small>${count} ${count === 1 ? "canción" : "canciones"}${missing ? ` · ${missing} no disponibles` : ""} · ${last}</small></span>
        <button type="button" class="icon-btn" data-folder-scan aria-label="Actualizar ${UI.escapeHTML(f.name)}" title="Actualizar esta carpeta">${Icons.refresh}</button>
        <button type="button" class="icon-btn" data-folder-remove aria-label="Quitar ${UI.escapeHTML(f.name)}" title="Quitar carpeta">${Icons.trash}</button>
      </div>`;
    }).join("");
  },

  when(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return "hace un momento";
    if (diff < 3600000) return `hace ${Math.round(diff / 60000)} min`;
    if (diff < 86400000) return `hace ${Math.round(diff / 3600000)} h`;
    try { return new Date(ms).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }); } catch (error) { return ""; }
  },

  renderLast() {
    const el = $("scan-last");
    const last = Settings.values.lastScan;
    if (el) el.textContent = last && last.at ? `Última actualización: ${this.when(last.at)}${last.cancelled ? " (cancelada)" : ""}.` : "Todavía no se ha actualizado la biblioteca.";
    const result = $("scan-result");
    if (!result) return;
    if (this.lastResult) { result.innerHTML = this.lastResult; result.classList.remove("hidden"); }
  },

  /* ---------- Actualizar ---------- */

  async start(opts = {}) {
    if (this.running) { UI.toast("Ya se está actualizando la biblioteca."); return; }
    if (!this.supported()) {
      UI.toast(Native.available ? "Este Android no permite leer carpetas." : Native.oldShell ? "Este APK es antiguo y no trae las funciones de Android. Instala el último desde Releases." : "Actualizar carpetas solo está disponible en la app de Android.");
      return;
    }
    if (Library.importing) { UI.toast("Espera a que termine la importación."); return; }
    const all = (Settings.values.folders || []).map((f) => f.uri);
    const targets = (opts.folders || all).filter((uri) => all.includes(uri));
    if (!targets.length) {
      UI.toast("Primero añade una carpeta de música.");
      return;
    }
    // Carpetas cuyo permiso ya no existe (se quitó desde los ajustes de Android)
    const persisted = Native.has("getPersistedFolders") ? Native.json("getPersistedFolders") : null;
    const lost = persisted && Array.isArray(persisted.folders) ? targets.filter((uri) => !persisted.folders.includes(uri)) : [];

    const byKey = new Map(), sig = new Map(), known = {};
    const importedSig = new Set();
    Library.songs.forEach((s) => {
      if (s.uri && s.docKey) { byKey.set(s.docKey, s); known[s.docKey] = (s.lastModified || 0) + ":" + (s.size || 0); }
      if (s.fileName && s.size) sig.set(s.fileName + "|" + s.size, s);
    });
    this.session = {
      targets: new Set(targets), byKey, sig, seen: new Set(), lost,
      ignored: new Set(Settings.values.ignoredKeys || []),
      added: [], touched: new Map(), counts: { added: 0, updated: 0, unchanged: 0, restored: 0, duplicates: 0, ignored: 0, missing: 0, found: 0 },
      startedAt: Date.now(), reason: opts.reason || "manual", persistChain: Promise.resolve(), flushed: 0
    };
    this.running = true;
    this.lastResult = "";
    this.setProgress({ phase: "start" });
    this.touchWatchdog();
    const options = { folders: targets.filter((uri) => !lost.includes(uri)), known };
    if (!options.folders.length) { this.onDone({ ok: true, errors: [] }); return; }
    const answer = Native.call("scanLibrary", JSON.stringify(options));
    if (answer === false || answer === "false") this.fail("Android no pudo empezar la lectura.");
  },

  cancel() {
    if (!this.running) return;
    Native.call("cancelScan");
    this.session.cancelled = true;
    this.setProgressText("Cancelando…");
  },

  touchWatchdog() {
    clearInterval(this.watchdog);
    this.last = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.last > 90000) { Native.call("cancelScan"); this.fail("Android dejó de responder durante la lectura."); }
    }, 5000);
  },

  fail(message) {
    if (!this.running) return;
    clearInterval(this.watchdog);
    this.running = false;
    this.session = null;
    this.setProgress({ phase: "end" });
    this.lastResult = `<p class="warn-text">${UI.escapeHTML(message)}</p>`;
    this.renderLast();
    UI.toast(message);
  },

  // ----- progreso -----
  setProgress(data) {
    const box = $("scan-progress"), fill = $("scan-fill"), btn = $("scan-btn");
    if (!box) return;
    const on = this.running;
    box.classList.toggle("hidden", !on);
    if (btn) { btn.disabled = on; btn.classList.toggle("busy", on); }
    document.querySelectorAll("[data-folder-scan]").forEach((b) => { b.disabled = on; });
    if (!on) { if (fill) fill.style.width = "0%"; box.classList.remove("indeterminate"); return; }
    const total = Number(data.total) || 0, done = Number(data.done) || 0;
    box.classList.toggle("indeterminate", !total);
    if (fill) fill.style.width = total ? Math.min(100, Math.round((done / total) * 100)) + "%" : "";
    let text = "Preparando…";
    if (data.phase === "listing") text = `Buscando archivos de audio… ${data.found || 0}`;
    else if (data.phase === "reading") text = `Leyendo información: ${done} de ${total}`;
    else if (data.phase === "finishing") text = "Guardando…";
    this.setProgressText(text);
  },

  setProgressText(text) { const el = $("scan-text"); if (el) el.textContent = text; },

  onProgress(data) {
    if (!this.running || !data) return;
    this.touchWatchdog();
    if (!this.session.cancelled) this.setProgress(data);
  },

  /* ---------- Conciliación ---------- */

  songFromItem(it) {
    const m = it.meta || {};
    const parsed = Library.parseFileName(it.fileName);
    const song = {
      name: m.title || parsed.title,
      artist: m.artist || parsed.artist,
      fileName: it.fileName,
      uri: it.uri, docKey: it.docKey, folderUri: it.folderUri,
      mime: it.mime || "", size: it.size || 0, lastModified: it.lastModified || 0,
      duration: Number(m.duration) || 0,
      addedAt: Date.now(),
      lyrics: null, cover: null
    };
    this.applyMeta(song, it);
    return song;
  },

  // Copia la información leída del archivo sin pisar lo que la persona editó
  applyMeta(song, it) {
    const m = it.meta || {};
    const parsed = Library.parseFileName(it.fileName);
    if (!song.edited) {
      song.name = m.title || parsed.title;
      song.artist = m.artist || parsed.artist;
    }
    song.album = m.album || "";
    song.albumArtist = m.albumArtist || "";
    song.genre = m.genre || "";
    song.year = Number(m.year) || 0;
    song.track = Number(m.track) || 0;
    song.disc = Number(m.disc) || 0;
    if (Number(m.duration)) song.duration = Number(m.duration);
    song.bitrate = Number(m.bitrate) || song.bitrate || 0;
    song.coverFile = m.coverFile || "";
    song.lyricsHint = m.lyricsHint || "";
    song.lrcUri = m.lrcUri || "";
    if (it.mime) song.mime = it.mime;
    song.size = it.size || song.size;
    song.lastModified = it.lastModified || song.lastModified;
    song.uri = it.uri || song.uri;
    song.folderUri = it.folderUri || song.folderUri;
    delete song._lyricsTried;
  },

  onBatch(data) {
    if (!this.running || !data || !Array.isArray(data.items)) return;
    this.touchWatchdog();
    const s = this.session;
    const c = s.counts;
    data.items.forEach((it) => {
      if (!it || !it.docKey || !it.uri) return;
      if (s.seen.has(it.docKey)) return; // la misma canción llegó por dos carpetas solapadas
      s.seen.add(it.docKey);
      c.found++;
      if (s.ignored.has(it.docKey)) { c.ignored++; return; }
      const existing = s.byKey.get(it.docKey);
      if (existing) {
        const wasMissing = existing.missing;
        if (wasMissing) { existing.missing = false; c.restored++; }
        if (it.unchanged || !it.meta) {
          c.unchanged++;
          if (it.uri !== existing.uri || (it.folderUri && it.folderUri !== existing.folderUri) || wasMissing) {
            existing.uri = it.uri; existing.folderUri = it.folderUri || existing.folderUri;
            s.touched.set(existing.id, existing);
          }
        } else {
          this.applyMeta(existing, it);
          if (!wasMissing) c.updated++;
          s.touched.set(existing.id, existing);
          if (Lyrics.song && Lyrics.song.id === existing.id) { /* la letra sigue siendo la guardada */ }
        }
        return;
      }
      const key = it.fileName + "|" + (it.size || 0);
      if (it.size && s.sig.has(key)) { c.duplicates++; return; } // el mismo archivo ya está (importado a mano o en otra carpeta)
      const song = this.songFromItem(it);
      s.sig.set(key, song);
      s.added.push(song);
      c.added++;
    });
    if (s.added.length >= 150) this.flush();
  },

  // Guarda lo nuevo por tandas, así se ve aparecer la biblioteca durante una lectura larga
  flush() {
    const s = this.session;
    if (!s || !s.added.length) return;
    const batch = s.added.splice(0, s.added.length);
    s.persistChain = s.persistChain.then(async () => {
      try {
        await Store.addSongs(batch);
        batch.forEach((song) => { Library.songs.push(song); s.byKey.set(song.docKey, song); });
        s.flushed += batch.length;
        LibraryBrowse.invalidate();
        this.softRender();
      } catch (error) {
        console.error("No se pudieron guardar las canciones leídas", error);
        s.saveError = error;
      }
    });
  },

  softRender() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => { UI.updateCount(); UI.renderLibrary(); UI.renderHome(); this.renderFolders(); LibraryBrowse.stats(); }, 350);
  },

  async onDone(data) {
    if (!this.running) return;
    const s = this.session;
    clearInterval(this.watchdog);
    this.setProgress({ phase: "finishing", total: 0 });
    data = data || {};
    const cancelled = Boolean(s.cancelled || data.cancelled);
    this.flush();
    await s.persistChain;

    const errors = Array.isArray(data.errors) ? data.errors.slice() : [];
    s.lost.forEach((uri) => errors.push({ folderUri: uri, reason: "permission" }));
    const badFolders = new Set(errors.map((e) => e.folderUri));

    // Lo que ya no está (o está en una carpeta inaccesible) se marca como no disponible, no se borra
    if (!cancelled) {
      Library.songs.forEach((song) => {
        if (!song.uri || !s.targets.has(song.folderUri) || song.missing) return;
        if (!s.seen.has(song.docKey) && !s.ignored.has(song.docKey)) { song.missing = true; s.counts.missing++; s.touched.set(song.id, song); }
      });
    }
    try {
      if (s.touched.size) await Store.updateSongs(Array.from(s.touched.values()));
    } catch (error) { console.error(error); s.saveError = error; }

    const now = Date.now();
    const folders = (Settings.values.folders || []).map((f) => s.targets.has(f.uri) && !badFolders.has(f.uri) && !cancelled ? { ...f, lastScan: now } : f);
    const summary = { at: now, cancelled, ms: now - s.startedAt, ...s.counts, errors: errors.length };
    this.running = false;
    this.session = null;
    this.setProgress({ phase: "end" });
    await Settings.set("folders", folders);
    await Settings.set("lastScan", summary);
    Queue.prune();
    Library.songs.sort((a, b) => (a.addedAt - b.addedAt) || (a.id - b.id));
    LibraryBrowse.invalidate();
    UI.renderAll();
    this.renderFolders();
    this.showResult(summary, errors, s.saveError);
    if (Library.songs.length) Library.requestPersistence();
  },

  showResult(r, errors, saveError) {
    const chips = [];
    const chip = (n, label, cls) => { if (n) chips.push(`<span class="res-chip ${cls || ""}"><b>${n}</b> ${label}</span>`); };
    chip(r.added, r.added === 1 ? "nueva" : "nuevas", "good");
    chip(r.updated, r.updated === 1 ? "actualizada" : "actualizadas");
    chip(r.restored, r.restored === 1 ? "recuperada" : "recuperadas", "good");
    chip(r.missing, "no disponibles", "warn");
    chip(r.duplicates, r.duplicates === 1 ? "duplicada omitida" : "duplicadas omitidas");
    chip(r.ignored, r.ignored === 1 ? "ignorada" : "ignoradas");
    chip(r.unchanged, "sin cambios");
    const noChanges = !r.added && !r.updated && !r.restored && !r.missing;
    let title = r.cancelled ? "Actualización cancelada" : noChanges ? "Todo está al día" : "Biblioteca actualizada";
    let html = `<div class="res-head">${r.cancelled ? Icons.warn : Icons.check}<strong>${title}</strong><small>${(r.ms / 1000).toFixed(r.ms < 10000 ? 1 : 0)} s · ${r.found} archivos de audio</small></div>`;
    if (chips.length) html += `<div class="res-chips">${chips.join("")}</div>`;
    if (errors.length) {
      const names = errors.map((e) => {
        const folder = (Settings.values.folders || []).find((f) => f.uri === e.folderUri);
        const why = e.reason === "permission" ? "sin permiso: vuelve a añadirla" : "no se pudo leer";
        return `${UI.escapeHTML(folder ? folder.name : "Carpeta")} (${why})`;
      });
      html += `<p class="warn-text">Carpetas con problemas: ${names.join(", ")}.</p>`;
    }
    if (saveError) html += `<p class="warn-text">Algunas canciones no se pudieron guardar${saveError.name === "QuotaExceededError" ? " (sin espacio)" : ""}.</p>`;
    if (r.missing) html += `<p class="res-note">Las no disponibles se conservan por si vuelve la carpeta. Puedes quitarlas con «Quitar no disponibles».</p>`;
    this.lastResult = html;
    this.renderLast();
    UI.toast(r.cancelled ? "Actualización cancelada." : noChanges ? "La biblioteca ya estaba al día." : `Biblioteca actualizada: ${r.added} nuevas.`);
  },

  /* ---------- Acciones de Ajustes ---------- */

  async restoreIgnored() {
    const n = (Settings.values.ignoredKeys || []).length;
    if (!n) return;
    await Settings.set("ignoredKeys", []);
    LibraryScan.refreshManage();
    UI.toast(`${n} ${n === 1 ? "archivo vuelve" : "archivos vuelven"} a estar permitidos. Pulsa «Actualizar biblioteca» para traerlos.`);
  },

  async pruneMissing() {
    const gone = Library.songs.filter((s) => s.missing);
    if (!gone.length) return;
    if (!(await UI.confirm(`¿Quitar ${gone.length} ${gone.length === 1 ? "canción no disponible" : "canciones no disponibles"} de la biblioteca?`, "Quitar", true))) return;
    await this.removeSongs(gone);
    UI.renderAll();
    this.renderFolders();
    this.refreshManage();
    UI.toast("Listo.");
  },

  refreshManage() {
    const restore = $("restore-ignored"), prune = $("prune-missing");
    const ignored = (Settings.values.ignoredKeys || []).length;
    const missing = Library.songs.reduce((n, s) => n + (s.missing ? 1 : 0), 0);
    if (restore) { restore.classList.toggle("hidden", !ignored); restore.textContent = `Restaurar quitadas (${ignored})`; }
    if (prune) { prune.classList.toggle("hidden", !missing); prune.textContent = `Quitar no disponibles (${missing})`; }
  }
};

/* =========================================================
   EXPLORAR LA BIBLIOTECA (v1.04) — Canciones · Álbumes · Artistas · Géneros
   Agrupa lo que ya hay en Library.songs (no guarda nada propio). Cada grupo se abre en la pantalla
   «Álbum / Artista / Género», que lista sus canciones y permite reproducirlas o mezclarlas.
   ========================================================= */
const LibraryBrowse = {
  tab: "songs",
  col: null,        // { kind, key } de la colección abierta
  cache: null,

  init() {
    this.tab = ["songs", "albums", "artists", "genres"].includes(Settings.values.libTab) ? Settings.values.libTab : "songs";
    const open = (event) => {
      const el = event.target.closest("[data-col]");
      if (!el) return;
      event.preventDefault();
      this.open(el.dataset.col, decodeURIComponent(el.dataset.key || ""), el.dataset.parent);
    };
    document.addEventListener("click", open);
    this.syncTabs();
  },

  invalidate() { this.cache = null; },

  // Claves de agrupación
  unknownArtist(name) { return !name || /^(archivo local|desconocido|<unknown>|unknown)$/i.test(String(name).trim()); },
  artistKey(song) { return this.unknownArtist(song.artist) ? "Artista desconocido" : String(song.artist).trim(); },
  albumKey(song) {
    if (!song.album) return "||";
    return String(song.album).trim() + "||" + String(song.albumArtist || song.artist || "").trim();
  },
  albumName(key) { const i = key.indexOf("||"); return i <= 0 ? "Sin álbum" : key.slice(0, i); },
  albumArtist(key) { const i = key.indexOf("||"); return i < 0 ? "" : key.slice(i + 2); },
  genreKey(song) { return song.genre ? String(song.genre).trim() : ""; },

  groups() {
    if (this.cache && this.cache.n === Library.songs.length) return this.cache;
    const albums = new Map(), artists = new Map(), genres = new Map();
    const add = (map, key, song) => {
      let g = map.get(key);
      if (!g) { g = { key, songs: [], seconds: 0, art: null, albums: new Set() }; map.set(key, g); }
      g.songs.push(song);
      g.seconds += song.duration || 0;
      if (!g.art && (song.cover || song.coverFile)) g.art = song;
      if (song.album) g.albums.add(song.album);
    };
    Library.songs.forEach((song) => {
      add(albums, this.albumKey(song), song);
      add(artists, this.artistKey(song), song);
      const genre = this.genreKey(song);
      if (genre) add(genres, genre, song);
    });
    const byName = (a, b) => a.key.localeCompare(b.key, "es", { sensitivity: "base", numeric: true });
    this.cache = {
      n: Library.songs.length,
      albums: Array.from(albums.values()).sort((a, b) => (a.key === "||") - (b.key === "||") || byName(a, b)),
      artists: Array.from(artists.values()).sort((a, b) => (a.key === "Artista desconocido") - (b.key === "Artista desconocido") || byName(a, b)),
      genres: Array.from(genres.values()).sort(byName)
    };
    return this.cache;
  },

  /* ---------- Pestañas ---------- */

  setTab(tab) {
    if (!["songs", "albums", "artists", "genres"].includes(tab) || tab === this.tab) return;
    this.tab = tab;
    Settings.set("libTab", tab);
    this.syncTabs();
    UI.el.songList.classList.remove("animate");
    UI.renderLibrary();
  },

  syncTabs() {
    document.querySelectorAll("[data-lib-tab]").forEach((btn) => {
      const on = btn.dataset.libTab === this.tab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });
  },

  // Dibuja las pestañas Álbumes/Artistas/Géneros. Devuelve false en «Canciones» (la lista normal la dibuja UI.renderLibrary).
  render(query) {
    const songs = $("song-list"), grid = $("album-grid"), list = $("group-list");
    if (!songs || !grid || !list) return false;
    this.renderBanner();
    const tab = this.tab;
    songs.classList.toggle("hidden", tab !== "songs");
    grid.classList.toggle("hidden", tab !== "albums");
    list.classList.toggle("hidden", tab === "songs" || tab === "albums");
    if (tab === "songs") return false;
    if (!Library.songs.length) {
      const target = tab === "albums" ? grid : list;
      target.innerHTML = UI.emptyState(false);
      return true;
    }
    const g = this.groups();
    const match = (group, text) => !query || text.toLowerCase().includes(query);
    if (tab === "albums") {
      const items = g.albums.filter((x) => match(x, this.albumName(x.key) + " " + this.albumArtist(x.key)));
      grid.innerHTML = items.length ? items.map((x, i) => this.albumCard(x, i)).join("") : this.noResults(query);
    } else if (tab === "artists") {
      const items = g.artists.filter((x) => match(x, x.key));
      list.innerHTML = items.length ? items.map((x, i) => this.groupRow("artist", x, i)).join("") : this.noResults(query);
    } else {
      const items = g.genres.filter((x) => match(x, x.key));
      list.innerHTML = items.length ? items.map((x, i) => this.groupRow("genre", x, i)).join("")
        : (g.genres.length ? this.noResults(query) : `<div class="empty"><div class="empty-icon">${Icons.tag}</div><h3>Sin géneros</h3><p>Los géneros se leen de las etiquetas de los archivos de tus carpetas.</p></div>`);
    }
    return true;
  },

  noResults(query) {
    return `<div class="empty"><div class="empty-icon">${Icons.note}</div><h3>${query ? "Sin resultados" : "Nada por aquí"}</h3><p>${query ? "Prueba con otro nombre." : ""}</p></div>`;
  },

  coverStyle(group) {
    const url = group.art ? Covers.get(group.art) : null;
    return url ? `style="background-image:url('${url}')"` : "";
  },

  albumCard(group, i) {
    const name = this.albumName(group.key), artist = this.albumArtist(group.key);
    const has = Boolean(group.art);
    return `<button type="button" class="album-card" data-col="album" data-key="${encodeURIComponent(group.key)}" style="--i:${Math.min(i, 10)}">
      <span class="album-art${has ? "" : " default"}" ${this.coverStyle(group)}>${has ? "" : Icons.note}</span>
      <strong>${UI.escapeHTML(name)}</strong>
      <small>${UI.escapeHTML(this.unknownArtist(artist) ? "Artista desconocido" : artist)} · ${group.songs.length}</small></button>`;
  },

  groupRow(kind, group, i) {
    const n = group.songs.length;
    const sub = kind === "artist"
      ? `${n} ${n === 1 ? "canción" : "canciones"}${group.albums.size ? ` · ${group.albums.size} ${group.albums.size === 1 ? "álbum" : "álbumes"}` : ""}`
      : `${n} ${n === 1 ? "canción" : "canciones"}`;
    const has = Boolean(group.art);
    const initial = UI.escapeHTML((group.key.trim()[0] || "?").toUpperCase());
    return `<button type="button" class="song-item group-row" data-col="${kind}" data-key="${encodeURIComponent(group.key)}" style="--i:${Math.min(i, 10)}">
      <span class="song-cover${kind === "artist" ? " round" : ""}${has ? "" : " default"}" ${this.coverStyle(group)}>${has ? "" : `<b>${initial}</b>`}</span>
      <span class="song-details"><strong>${UI.escapeHTML(group.key)}</strong><small>${sub}</small></span>
      <span class="chev-right" aria-hidden="true"></span></button>`;
  },

  /* ---------- Aviso encima de la lista ---------- */

  renderBanner() {
    const box = $("lib-banner");
    if (!box) return;
    const missing = Library.songs.reduce((n, s) => n + (s.missing ? 1 : 0), 0);
    let html = "";
    if (missing) {
      html = `<span>${Icons.warn}</span><p>${missing} ${missing === 1 ? "canción no está disponible" : "canciones no están disponibles"}. Revisa tus carpetas.</p><button type="button" class="chip-btn" data-jump="library">Revisar</button>`;
    } else if (!Library.songs.length && LibraryScan.supported() && !(Settings.values.folders || []).length) {
      html = `<span>${Icons.folder}</span><p>Elige la carpeta donde guardas tu música.</p><button type="button" class="chip-btn" data-action="folder-add">Elegir carpeta</button>`;
    }
    box.innerHTML = html;
    box.classList.toggle("hidden", !html);
  },

  /* ---------- Colección (álbum, artista o género) ---------- */

  songsOf(kind, key) {
    const list = Library.songs.filter((song) =>
      kind === "album" ? this.albumKey(song) === key
        : kind === "artist" ? this.artistKey(song) === key
          : this.genreKey(song) === key);
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), "es", { sensitivity: "base", numeric: true });
    if (kind === "album") list.sort((a, b) => ((a.disc || 1) - (b.disc || 1)) || ((a.track || 9999) - (b.track || 9999)) || byName(a, b));
    else if (kind === "artist") list.sort((a, b) => String(a.album || "~").localeCompare(String(b.album || "~"), "es") || ((a.track || 9999) - (b.track || 9999)) || byName(a, b));
    else list.sort(byName);
    return list;
  },

  open(kind, key, parent) {
    if (!["album", "artist", "genre"].includes(kind)) return;
    this.col = { kind, key };
    if (Router.current === "collection") { this.renderCollection(); window.scrollTo(0, 0); return; }
    Router.go("collection", parent || (Router.current === "library" ? undefined : Router.current));
  },

  onRoute() { this.renderCollection(); },

  currentIds() {
    if (!this.col) return [];
    return this.songsOf(this.col.kind, this.col.key).filter((s) => !s.missing).map((s) => s.id);
  },

  renderCollection() {
    const list = $("col-list");
    if (!list || !this.col) return;
    const { kind, key } = this.col;
    const songs = this.songsOf(kind, key);
    const title = kind === "album" ? this.albumName(key) : key;
    const secs = songs.reduce((n, s) => n + (s.duration || 0), 0);
    const extra = kind === "album" ? this.albumArtist(key) : "";
    const kindLabel = { album: "Álbum", artist: "Artista", genre: "Género" }[kind];
    $("col-title").textContent = title || kindLabel;
    $("col-sub").textContent = [kindLabel, extra && !this.unknownArtist(extra) ? extra : "", `${songs.length} ${songs.length === 1 ? "canción" : "canciones"}`, secs ? LibraryBrowse.long(secs) : ""].filter(Boolean).join(" · ");
    list.classList.add("animate");
    list.innerHTML = songs.length ? songs.map((s, i) => UI.songRow(s, i)).join("")
      : `<div class="empty"><div class="empty-icon">${Icons.note}</div><h3>Ya no hay canciones aquí</h3><p>Se quitaron de la biblioteca.</p></div>`;
    UI.markPlaying();
  },

  long(seconds) {
    const mins = Math.round(seconds / 60);
    return mins < 60 ? `${Math.max(1, mins)} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  },

  play(shuffle) {
    const ids = this.currentIds();
    if (!ids.length) { UI.toast("No hay canciones disponibles aquí."); return; }
    const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
    const start = () => Player.play(first, { context: ids });
    if (shuffle && !Settings.values.shuffle) Settings.set("shuffle", true).then(start);
    else start();
  },

  /* ---------- Estadísticas (Ajustes → Biblioteca musical) ---------- */

  stats() {
    const box = $("lib-stats");
    if (!box) return;
    const songs = Library.songs;
    if (!songs.length) { box.innerHTML = `<p class="set-hint">Cuando tengas canciones verás aquí un resumen.</p>`; return; }
    const g = this.groups();
    const secs = songs.reduce((n, s) => n + (s.duration || 0), 0);
    const withLyrics = songs.filter((s) => (s.lyrics && s.lyrics.raw) || s.lyricsHint).length;
    const withCover = songs.filter((s) => s.cover || s.coverFile).length;
    const missing = songs.filter((s) => s.missing).length;
    const fromFolders = songs.filter((s) => s.uri).length;
    const cell = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
    box.innerHTML = [
      cell(songs.length, "canciones"),
      cell(g.albums.filter((x) => x.key !== "||").length, "álbumes"),
      cell(g.artists.filter((x) => x.key !== "Artista desconocido").length, "artistas"),
      cell(g.genres.length, "géneros"),
      cell(this.long(secs), "de música"),
      cell(withLyrics, "con letra"),
      cell(withCover, "con portada"),
      cell(fromFolders, "de carpetas"),
      missing ? cell(missing, "no disponibles") : ""
    ].join("");
  }
};

/* =========================================================
   RENDIMIENTO Y PANTALLA (v1.04)
   Hz ≠ FPS:
     · Hz  = veces por segundo que la PANTALLA se actualiza (60, 90, 120). Solo Android puede cambiarlo
             (elige un modo de pantalla); una página web no puede.
     · FPS = cuadros por segundo que la APP dibuja en sus propias animaciones (letras, vista previa).
   Perfil de Hz:
     · Con la app Android: se pide a Android el modo de pantalla con esa tasa (setRefreshRate). Solo se
       ofrecen las tasas que el dispositivo declara compatibles.
     · Sin app (navegador) o si Android no puede cambiarlo: no se puede cambiar la pantalla. La mejor alternativa
       real es limitar a esa tasa los cuadros que dibuja la app (así un perfil de 60 Hz ahorra batería en una
       pantalla de 120 Hz). Se explica en la propia pantalla de Ajustes.
   ========================================================= */
const Performance = {
  display: { currentHz: 60, maxHz: 60, rates: [60], native: false, switchable: false, measured: 0 },
  measuring: false,
  lastMeasure: 0,
  applied: null,     // resultado de la última petición a Android { ok, hz }
  RATES: [60, 90, 120, 144],

  init() {
    this.readNative();
    Settings.watch(["refreshHz"], (value, key, initial) => this.applyHz(initial));
    Settings.watch(["animations", "visualFx"], () => this.applyFx());
    Settings.watch(["fpsCap"], () => this.renderHz());
    Native.on("display", (data) => { this.readNative(data); this.renderHz(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Router.current === "settings") this.measure(); });
    this.applyFx();
  },

  afterLoad() {
    this.recommend();
    this.measure();
  },

  snap(hz) {
    const list = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
    return list.reduce((best, rate) => (Math.abs(rate - hz) < Math.abs(best - hz) ? rate : best), 60);
  },

  readNative(extra) {
    const info = extra || (Native.info() && Native.info().display);
    if (!info) return;
    const d = this.display;
    d.native = true;
    d.currentHz = Math.round(Number(info.currentHz) || d.currentHz);
    d.maxHz = Math.round(Number(info.maxHz) || Number(info.currentHz) || d.maxHz);
    const rates = Array.isArray(info.rates) ? info.rates.map((r) => Math.round(Number(r))).filter((r) => r >= 30) : [];
    d.rates = Array.from(new Set(rates.length ? rates : [d.maxHz])).sort((a, b) => a - b);
    d.switchable = Boolean(info.switchable) && d.rates.length > 1;
  },

  // Sin app: mide los cuadros reales del navegador (un valor de referencia, no una garantía de lo que admite la pantalla)
  measure(force) {
    if (this.measuring || document.hidden) return;
    if (!force && Date.now() - this.lastMeasure < 30000) return;
    this.measuring = true;
    const stamps = [];
    const step = (t) => {
      stamps.push(t);
      if (stamps.length < 45) { requestAnimationFrame(step); return; }
      this.measuring = false;
      this.lastMeasure = Date.now();
      const gaps = stamps.slice(1).map((v, i) => v - stamps[i]).sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)] || 16.7;
      const hz = this.snap(1000 / median);
      this.display.measured = hz;
      if (!this.display.native) {
        this.display.currentHz = hz;
        this.display.maxHz = Math.max(hz, 60);
        this.display.rates = [60, 90, 120, 144].filter((r) => r <= hz + 5);
        if (!this.display.rates.length) this.display.rates = [60];
      }
      this.renderHz();
    };
    requestAnimationFrame(step);
  },

  // Tasa pedida que el dispositivo no admite (por ejemplo un perfil guardado de 120 en una pantalla de 60) = automático
  effective() {
    const wanted = Number(Settings.values.refreshHz) || 0;
    return wanted && this.display.rates.includes(wanted) ? wanted : 0;
  },

  select(hz) {
    hz = Number(hz) || 0;
    if (hz && !this.display.rates.includes(hz)) { UI.toast(`Tu pantalla no admite ${hz} Hz.`); return; }
    if (hz === (Number(Settings.values.refreshHz) || 0)) return;
    Settings.set("refreshHz", hz);
  },

  applyHz(initial) {
    const hz = this.effective();
    if (Native.has("setRefreshRate")) {
      const answer = Native.json("setRefreshRate", hz);
      this.applied = answer || null;
      if (answer && answer.display) this.readNative(answer.display);
      if (!initial && answer && answer.ok === false && hz) UI.toast("Android no aceptó ese cambio. La app limita sus animaciones a esa tasa como alternativa.");
    }
    this.renderHz();
  },

  // ¿Cambió Android de verdad la tasa de la pantalla?
  nativeControls() { return this.display.native && this.display.switchable && (!this.applied || this.applied.ok !== false); },

  // Milisegundos mínimos entre dos dibujos de las animaciones propias de la app (0 = sin límite)
  frameGap() {
    const v = Settings.values;
    let fps = v.fpsCap === "30" ? 30 : v.fpsCap === "60" ? 60 : 0;
    const hz = this.effective();
    if (hz && !this.nativeControls()) fps = fps ? Math.min(fps, hz) : hz;   // alternativa cuando no se puede cambiar la pantalla
    if (v.animations === "reduced") fps = fps ? Math.min(fps, 30) : 30;
    return fps ? 1000 / fps - 1.5 : 0;
  },

  applyFx() {
    const root = document.documentElement;
    root.setAttribute("data-anim", Settings.values.animations || "full");
    root.setAttribute("data-fx", Settings.values.visualFx === false ? "off" : "on");
    if (this.rendered) this.renderHz();
  },

  // Primera vez: un dispositivo con muy pocos recursos arranca en modo ligero (se avisa y se puede cambiar)
  recommend() {
    if (Settings.values.perfInit) return;
    Settings.set("perfInit", true);
    const mem = Number(navigator.deviceMemory) || 0;
    const cores = Number(navigator.hardwareConcurrency) || 0;
    if ((mem && mem <= 2) || (cores && cores <= 2)) {
      Settings.set("visualFx", false);
      Settings.set("fpsCap", "30");
      setTimeout(() => UI.toast("Dispositivo con pocos recursos: activamos el modo ligero. Puedes cambiarlo en Ajustes → Rendimiento."), 1500);
    }
  },

  renderHz() {
    const grid = $("hz-grid"), info = $("hz-info");
    if (!grid) return;
    this.rendered = true;
    const d = this.display;
    const current = Number(Settings.values.refreshHz) || 0;
    const effective = this.effective();
    const items = [`<button type="button" role="radio" aria-checked="${effective === 0}" data-hz="0"><strong>Automático</strong><small>Lo decide el dispositivo</small></button>`]
      .concat(d.rates.map((r) => `<button type="button" role="radio" aria-checked="${effective === r}" data-hz="${r}"><strong>${r} Hz</strong><small>${r >= 120 ? "Muy fluido" : r >= 90 ? "Fluido" : "Ahorra batería"}</small></button>`));
    grid.innerHTML = items.join("");
    if (!info) return;
    const lines = [];
    if (d.native) {
      lines.push(`Pantalla: ${d.currentHz} Hz ahora · admite ${d.rates.join(", ")} Hz.`);
      if (d.rates.length === 1) lines.push("Este dispositivo solo admite una tasa, por eso no hay más opciones.");
      else if (!d.switchable) lines.push("Android no permite que las apps cambien la tasa de esta pantalla.");
      if (effective && this.nativeControls()) lines.push(`Perfil ${effective} Hz aplicado por Android (la pantalla puede bajar de tasa por sí sola si no hay movimiento).`);
      else if (effective) lines.push(`Android no pudo fijar ${effective} Hz: la app limita sus animaciones a ${effective} FPS como alternativa.`);
    } else {
      lines.push(`Navegador: se detectan unos ${d.measured || d.currentHz} Hz. Una página web no puede cambiar los Hz de la pantalla; eso solo lo hace la app de Android.`);
      if (effective) lines.push(`Como alternativa, el perfil ${effective} Hz limita las animaciones de la app a ${effective} FPS.`);
    }
    const gap = this.frameGap();
    lines.push(gap ? `Animaciones de la app: máximo ${Math.round(1000 / (gap + 1.5))} FPS.` : "Animaciones de la app: a la velocidad de la pantalla.");
    info.textContent = lines.join(" ");
    void current;
  }
};

/* =========================================================
   NAVEGACIÓN DE AJUSTES (v1.04)
   La barra de arriba lleva a cada categoría y marca en cuál estás mientras te desplazas.
   ========================================================= */
const SettingsNav = {
  spy: null,
  locked: 0,

  init() {
    this.setupSpy();
  },

  offset() {
    const bar = $("settings-nav");
    const top = document.querySelector(".topbar, .app-header");
    return (bar ? bar.offsetHeight : 0) + (top && getComputedStyle(top).position !== "static" ? top.offsetHeight : 0) + 8;
  },

  // Va a una categoría; si Ajustes no está abierta, la abre primero.
  jump(id, instant) {
    if (Router.current !== "settings") { Router.go("settings"); this.jumpSoon(id); return; }
    const target = $("set-" + id);
    if (!target) return;
    this.locked = Date.now();
    this.mark(id);
    const y = target.getBoundingClientRect().top + window.scrollY - this.offset();
    const smooth = !instant && !UI.prefersReducedMotion();
    window.scrollTo({ top: Math.max(0, y), behavior: smooth ? "smooth" : "auto" });
  },

  jumpSoon(id) {
    let tries = 0;
    const attempt = () => {
      if (Router.current === "settings" && $("view-settings").classList.contains("active")) { this.jump(id, true); return; }
      if (++tries < 12) setTimeout(attempt, 40);
    };
    setTimeout(attempt, 60);
  },

  mark(id) {
    document.querySelectorAll("#settings-nav [data-jump]").forEach((btn) => {
      const on = btn.dataset.jump === id;
      btn.classList.toggle("active", on);
      if (on) {
        btn.setAttribute("aria-current", "true");
        const nav = $("settings-nav");
        if (nav && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: btn.offsetLeft - nav.clientWidth / 2 + btn.offsetWidth / 2, behavior: "auto" });
      } else btn.removeAttribute("aria-current");
    });
  },

  setupSpy() {
    if (!("IntersectionObserver" in window)) return;
    const sections = Array.from(document.querySelectorAll(".set-group[data-group]")).filter((s) => s.dataset.group !== "about");
    const visible = new Map();
    this.spy = new IntersectionObserver((entries) => {
      entries.forEach((e) => visible.set(e.target.dataset.group, e.isIntersecting ? e.intersectionRatio : 0));
      if (Date.now() - this.locked < 900) return; // mientras dura el desplazamiento de un toque, manda ese toque
      let best = null, ratio = 0;
      sections.forEach((s) => { const r = visible.get(s.dataset.group) || 0; if (r > ratio) { ratio = r; best = s.dataset.group; } });
      if (best) this.mark(best);
    }, { rootMargin: "-90px 0px -55% 0px", threshold: [0, 0.1, 0.3, 0.6, 1] });
    sections.forEach((s) => this.spy.observe(s));
  }
};

/* =========================================================
   FEATURES — coordinador de la v1.04
   Une los módulos nuevos con el núcleo (script.js): arranque, acciones de los botones, eventos de Android
   y el estado de los controles. Aquí no hay lógica propia de reproducción ni de biblioteca.
   ========================================================= */
/* =========================================================
   ABRIR CON PULSAR RM (v1.04, revisión)
   Cuando otra app (administrador de archivos, WhatsApp, descargas…) abre un audio con Pulsar RM, Android lo deja
   pendiente (takePendingOpen). Aquí se lee con la ruta propia /_pulsar_media, se añade a la biblioteca como
   cualquier importación (así sigue ahí al cerrar la app) y se reproduce.
   ========================================================= */
const ExternalOpen = {
  busy: false,

  async check() {
    if (this.busy || !Native.has("takePendingOpen")) return;
    const info = Native.json("takePendingOpen");
    if (!info || !info.uri) return;
    this.busy = true;
    try {
      const name = String(info.name || "audio");
      UI.toast("Abriendo " + name + "…", true);
      const response = await fetch(Native.audioUrl(info.uri));
      if (!response.ok) throw new Error("No se pudo leer el archivo (" + response.status + ")");
      const blob = await response.blob();
      // lastModified fijo: abrir dos veces el mismo archivo no lo duplica en la biblioteca
      const file = new File([blob], name, { type: info.mime || blob.type || "audio/mpeg", lastModified: 0 });
      if (!Library.isAudioFile(file)) { UI.toast("Ese archivo no parece ser de audio."); return; }
      let song = Library.songs.find((item) => item.fileName === file.name && item.size === file.size && item.lastModified === 0);
      if (!song) {
        if (Library.importing) { UI.toast("Ya hay una importación en curso."); return; }
        await Library.importFiles([file]);
        song = Library.songs.find((item) => item.fileName === file.name && item.size === file.size && item.lastModified === 0);
      }
      if (song) Player.play(song.id, { context: Library.playableIds() });
    } catch (error) {
      console.error("Abrir con Pulsar RM:", error);
      Diagnostics.log("abrir con", error && error.message ? error.message : error);
      UI.toast("No se pudo abrir el audio.");
    } finally {
      this.busy = false;
    }
  }
};

const Features = {
  // Un módulo que falle no debe dejar sin botones al resto de la app: cada uno arranca por separado y el error se registra.
  safe(name, fn) {
    try { return fn(); } catch (error) {
      console.error("Pulsar RM:", name, error);
      if (typeof Diagnostics !== "undefined") Diagnostics.log("módulo " + name, error && error.message ? error.message : error, error && error.stack ? String(error.stack).split("\n")[1] : "");
    }
    return undefined;
  },

  init() {
    this.safe("letras", () => LyricsScreen.init());
    this.safe("temporizador", () => SleepTimer.init());
    this.safe("cola", () => QueueScreen.init());
    this.safe("información", () => SongInfo.init());
    this.safe("explorar", () => LibraryBrowse.init());
    this.safe("carpetas", () => LibraryScan.init());
    this.safe("rendimiento", () => Performance.init());
    this.safe("ajustes", () => SettingsNav.init());
    this.safe("android", () => this.wireNative());
    this.safe("opciones", () => this.initWatchers());
  },

  initWatchers() {
    // Reproducción aleatoria: avisa a la cola (al cargar los ajustes la cola aún está vacía, no hace falta)
    Settings.watch(["shuffle"], (value, key, initial) => { if (!initial) Queue.setShuffle(Boolean(value)); this.refreshControls(); });
    // Opciones que Android necesita conocer (servicio, foco de audio, auriculares)
    Settings.watch(["pauseOnNoisy", "focusMode", "bgPlayback"], () => this.sendAudioOptions());

    // Escape cierra la hoja emergente abierta (teclado físico)
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && UI.overlays.length && !UI.dismissConfirm) UI.closeTopOverlay();
    });
  },

  afterLoad() {
    this.safe("rendimiento", () => Performance.afterLoad());
    this.safe("pestañas", () => LibraryBrowse.syncTabs());
    this.safe("carpetas", () => { LibraryScan.renderFolders(); LibraryScan.renderLast(); });
    this.safe("temporizador", () => SleepTimer.refresh());
    this.safe("audio nativo", () => this.sendAudioOptions());
    this.safe("controles", () => this.refreshControls());
    this.safe("diagnóstico", () => Diagnostics.render());
    this.safe("abrir con", () => ExternalOpen.check());   // audio con el que Android abrió la app
    // Un APK nuevo puede haber perdido permisos de carpeta: se comprueba en silencio (no se lee ningún archivo)
    this.safe("permisos", () => {
      if (LibraryScan.supported() && Native.has("getPersistedFolders")) {
        const persisted = Native.json("getPersistedFolders");
        if (persisted && Array.isArray(persisted.folders)) {
          const lost = (Settings.values.folders || []).filter((f) => !persisted.folders.includes(f.uri));
          if (lost.length) UI.toast(`Falta el permiso de ${lost.length === 1 ? "la carpeta «" + lost[0].name + "»" : lost.length + " carpetas"}. Revísalo en Ajustes → Biblioteca musical.`);
        }
      }
    });
  },

  sendAudioOptions() {
    if (!Native.has("setAudioOptions")) return;
    const v = Settings.values;
    Native.call("setAudioOptions", Boolean(v.pauseOnNoisy), String(v.focusMode || "duck"), v.bgPlayback !== false);
  },

  wireNative() {
    Native.on("action", (data) => { if (data && data.name) Player.nativeAction(data.name, data.value); });
    Native.on("focus", (data) => { if (data && data.action) Player.focus(data.action); });
    Native.on("sleep", () => SleepTimer.fire(true));
    Native.on("permission", () => { Native.info(true); this.renderSettings(); });
    Native.on("openAudio", () => ExternalOpen.check());
  },

  // Cada vez que se abre una pantalla
  onRoute(name) {
    this.safe("pantalla " + name, () => {
      LyricsScreen.onRoute(name);
      if (name === "queue") QueueScreen.onRoute();
      else if (name === "timer") SleepTimer.refresh();
      else if (name === "info") SongInfo.onRoute();
      else if (name === "collection") LibraryBrowse.onRoute();
      else if (name === "library") { LibraryBrowse.syncTabs(); UI.renderLibrary(); }
      else if (name === "settings") { Performance.measure(); this.renderSettings(); }
      this.refreshControls();
    });
  },

  // Acciones de los botones con data-action que el núcleo no conoce
  handle(action) {
    switch (action) {
      // Letras
      case "lyrics-options": LyricsScreen.toggleOptions(); break;
      case "lyrics-center": Lyrics.recenter(); break;
      // Cola
      case "queue-add": QueueScreen.openPicker(); break;
      case "queue-mix": { const box = $("queue-mixbox"); if (box) { box.open = !box.open; if (box.open) box.scrollIntoView({ block: "nearest", behavior: UI.prefersReducedMotion() ? "auto" : "smooth" }); } break; }
      case "queue-clear": this.clearQueue(); break;
      // Temporizador
      case "timer-track": SleepTimer.startEndOfTrack(); break;
      case "timer-cancel": SleepTimer.cancel(); break;
      case "timer-add": SleepTimer.add(5); break;
      case "timer-custom": {
        const input = $("timer-custom");
        const minutes = Number(input && input.value);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) { UI.toast("Escribe un tiempo de 1 a 480 minutos."); if (input) input.focus(); break; }
        SleepTimer.start(minutes);
        input.value = "";
        break;
      }
      // Información de la canción
      case "info-play": SongInfo.play(); break;
      case "info-next": SongInfo.playNext(); break;
      case "info-edit": SongInfo.edit(); break;
      // Álbum / artista / género
      case "col-play": LibraryBrowse.play(false); break;
      case "col-shuffle": LibraryBrowse.play(true); break;
      // Biblioteca de carpetas
      case "folder-add": LibraryScan.addFolder(); break;
      case "scan": LibraryScan.start(); break;
      case "scan-cancel": LibraryScan.cancel(); break;
      case "restore-ignored": LibraryScan.restoreIgnored(); break;
      case "prune-missing": LibraryScan.pruneMissing(); break;
      // Diagnóstico
      case "diag-copy": Diagnostics.copy().then((ok) => UI.toast(ok ? "Errores copiados." : "No se pudo copiar. Mantén pulsado el texto para seleccionarlo.")); break;
      case "diag-clear": Diagnostics.clear(); UI.toast("Registro borrado."); break;
    }
  },

  async clearQueue() {
    if (!Queue.upcoming().length) { UI.toast("No hay canciones pendientes."); return; }
    if (!(await UI.confirm("¿Quitar de la cola todas las canciones que faltan por sonar? La canción actual sigue.", "Quitar", true))) return;
    Queue.clearUpcoming();
    UI.toast("Cola vaciada.");
  },

  // Pone al día botones y textos que dependen de los ajustes
  refreshControls() {
    const v = Settings.values;
    const shuffle = Boolean(v.shuffle);
    ["btn-shuffle", "q-shuffle"].forEach((id) => {
      const el = $(id);
      if (el) { el.classList.toggle("on", shuffle); el.setAttribute("aria-pressed", String(shuffle)); }
    });
    const repeat = v.repeat || "all";
    const names = { off: "No repetir", all: "Repetir toda la cola", one: "Repetir esta canción" };
    ["btn-repeat", "q-repeat"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.dataset.mode = repeat;
      el.classList.toggle("on", repeat !== "off");
      el.setAttribute("aria-pressed", String(repeat !== "off"));
      el.setAttribute("aria-label", names[repeat]);
      el.title = names[repeat];
    });
    // Salidas de las barras deslizantes
    document.querySelectorAll("[data-range-out]").forEach((out) => {
      const key = out.dataset.rangeOut, value = Number(v[key]) || 0;
      out.textContent = key === "balance" ? (Math.abs(value) < 0.03 ? "Centro" : `${value < 0 ? "Izq." : "Der."} ${Math.round(Math.abs(value) * 100)}%`) : `${value} s`;
    });
    const fade = Boolean(v.crossfade);
    ["set-mix-duration", "mix-duration"].forEach((id) => { const el = $(id); if (el) el.classList.toggle("disabled", !fade); });
    QueueScreen.refreshMix();
    const eqText = $("set-eq-text");
    if (eqText) eqText.textContent = v.eq && v.eq.enabled ? `Activado · ${Equalizer.presetName ? Equalizer.presetName() : "10 bandas"}. Ajusta las bandas o elige un modo.` : "10 bandas reales con modos predefinidos y ajuste manual. Ahora está desactivado.";
    const balance = document.querySelector('[data-range="balance"]');
    if (balance) balance.classList.toggle("is-center", Math.abs(Number(v.balance) || 0) < 0.03);
  },

  // Textos de Ajustes que dependen de Android o del estado de la biblioteca
  renderSettings() {
    const info = Native.info();
    const bg = $("bg-hint");
    if (bg) {
      bg.textContent = !info ? "En el navegador la música se detiene cuando el sistema suspende la página. En la app Android sigue sonando con la pantalla apagada."
        : info.notifications === false ? "Para ver los controles en la notificación y la pantalla de bloqueo, permite las notificaciones de Pulsar RM en los ajustes de Android."
          : "Android muestra los controles de Pulsar RM en la notificación y la pantalla de bloqueo.";
    }
    const audio = $("audio-hint");
    if (audio) audio.textContent = AudioGraph.ready || AudioGraph.needed()
      ? "Procesamiento de audio activo (Web Audio): ecualizador, limitador, mono y balance."
      : "El procesamiento de audio se activa solo cuando lo necesitas (ecualizador, crossfade, mono o balance).";
    const about = $("about-device");
    if (about) {
      const d = Performance.display;
      about.textContent = info ? `App Android · Android API ${info.sdk || "?"} · pantalla ${d.currentHz} Hz` : (Native.oldShell ? "APK antiguo (sin funciones de Android) · instala el último desde Releases" : "Versión web (PWA)");
    }
    LibraryScan.renderFolders();
    LibraryScan.renderLast();
    LibraryScan.refreshManage();
    LibraryBrowse.stats();
    Performance.renderHz();
    SleepTimer.refresh();
  }
};
