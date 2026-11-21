/* =========================================================
   PULSAR RM v1.06 — Estilo de reproductor «Inmersive»
   Segundo diseño del reproductor, alternativo e independiente del actual (Pulsar RM, que no se toca).
   Se elige en Ajustes → Apariencia → Estilo del reproductor y se guarda (Settings.playerStyle).

   NO es otro reproductor: usa el MISMO motor (Player, Queue, Library, Covers). Este módulo solo
     · muestra el marcado #im-player cuando el estilo es Inmersive (la regla vive en immersive.css),
     · refleja en él lo que ya calcula la app (canción, portada, progreso, estado de reproducción),
     · y conecta sus botones con las funciones existentes (Player.toggle, anterior/siguiente, letras, cola…).
   El progreso y los tiempos NO se duplican: la barra lleva data-progress y los textos data-time, así que la app
   los mueve, pinta y busca igual que en los otros diseños.
   Si este archivo falla o no carga, el reproductor Pulsar RM sigue funcionando exactamente igual.
   ========================================================= */
const PlayerStyle = {
  STYLES: ["pulsar", "inmersive"],
  ready: false,
  el: {},
  bgToken: 0,
  bgFlip: false,
  bgUrl: undefined,
  volTimer: 0,
  volHoldUntil: 0,
  volDragging: false,

  /* ---------- Estado ---------- */

  get style() {
    const value = Settings.values.playerStyle;
    return this.STYLES.includes(value) ? value : "pulsar";
  },

  get active() { return this.style === "inmersive"; },

  /* ---------- Arranque ---------- */

  init() {
    if (this.ready) return;
    const $ = (id) => document.getElementById(id);
    this.el = {
      root: $("im-player"), bg: $("im-bg"), cover: $("im-cover"), title: $("im-title"), artist: $("im-artist"),
      fav: document.querySelector('#im-player [data-im="fav"]'), menu: $("im-menu"),
      menuButton: document.querySelector('#im-player [data-im="menu"]'), toggle: $("im-toggle"),
      badge: $("im-badge"), volume: $("im-volume"), volumeRange: $("im-volume-range"),
      menuShuffle: $("im-menu-shuffle"), menuRepeat: $("im-menu-repeat"), card: $("player-style-card")
    };
    if (!this.el.root || !this.el.bg) return; // el marcado no está: no se hace nada y todo sigue con Pulsar RM
    this.el.bgA = this.el.bg.querySelector(".im-bg-a");
    this.el.bgB = this.el.bg.querySelector(".im-bg-b");
    this.ready = true;

    // Cada vez que la app actualiza su reproductor, este diseño se actualiza también (sin tocar el código original)
    this.wrap(UI, "refreshNowPlayingInfo", (song) => this.syncTrack(song));
    this.wrap(UI, "resetNowPlaying", () => this.syncTrack(null));
    this.wrap(UI, "updatePlayState", () => this.syncPlay());
    // Atrás de Android: primero cierra el menú de Inmersive, como el del diseño Pulsar RM
    const back = Router.handleBack;
    Router.handleBack = function (...args) {
      if (PlayerStyle.menuOpen()) { PlayerStyle.closeMenu(); return true; }
      return back.apply(this, args);
    };

    this.bind();
    this.setupVolume();
    Settings.watch("playerStyle", () => this.apply());
    Settings.watch(["shuffle", "repeat"], () => this.syncMenu());
    this.apply();
    this.syncAll();
  },

  wrap(target, name, after) {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      const result = original.apply(this, args);
      try { after(...args); } catch (error) { console.warn("Inmersive:", name, error); }
      return result;
    };
  },

  bind() {
    // Botones propios del diseño (los demás usan data-action / data-view y los atiende la app, igual que siempre)
    this.el.root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-im]");
      if (button && this.el.root.contains(button)) {
        switch (button.dataset.im) {
          case "toggle": Player.toggle(); break;
          case "fav": this.toggleFavorite(); break;
          case "menu": this.toggleMenu(); break;
          case "devices": this.openDevices(); break;
          default: break;
        }
        return;
      }
      if (event.target.closest("#im-menu button")) setTimeout(() => this.closeMenu(), 0); // la opción ya se ejecutó
    });
    document.addEventListener("click", (event) => {
      if (this.menuOpen() && !event.target.closest("#im-menu") && !event.target.closest('[data-im="menu"]')) this.closeMenu();
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && this.menuOpen()) this.closeMenu(); });

    // Tarjeta de Ajustes: elegir estilo
    document.addEventListener("click", (event) => {
      const option = event.target.closest("[data-player-style-id]");
      if (!option) return;
      const id = option.dataset.playerStyleId;
      if (this.STYLES.includes(id) && id !== this.style) Settings.set("playerStyle", id);
      else this.syncCard();
    });
  },

  /* ---------- Aplicar el estilo ---------- */

  apply() {
    document.documentElement.dataset.playerStyle = this.style;
    this.syncCard();
    this.onRoute(Router.current);
    if (this.active) this.syncAll();
  },

  syncCard() {
    document.querySelectorAll("[data-player-style-id]").forEach((option) => {
      option.setAttribute("aria-checked", String(option.dataset.playerStyleId === this.style));
    });
  },

  // Se llama al cambiar de pantalla (Features.onRoute): el fondo dinámico y el volumen solo viven en el reproductor
  onRoute(name) {
    if (!this.ready) return;
    const on = this.active && name === "player";
    document.documentElement.classList.toggle("im-on", on);
    if (on) { this.syncAll(); this.startVolumePoll(); }
    else { this.stopVolumePoll(); this.closeMenu(); }
    if (name === "settings") this.syncCard();
  },

  /* ---------- Sincronizar con el motor ---------- */

  syncAll() {
    if (!this.ready) return;
    const song = Player.currentId !== null ? Library.byId(Player.currentId) : null;
    this.syncTrack(song || null);
    this.syncPlay();
    this.syncMenu();
  },

  syncTrack(song) {
    if (!this.ready) return;
    if (!song) {
      UI.swapText(this.el.title, "Sin reproducción");
      UI.swapText(this.el.artist, "Pulsar RM");
      UI.setCover(this.el.cover, null);
      this.paintBackground(null);
      this.setBadge("");
      this.setFavorite(false);
      return;
    }
    UI.swapText(this.el.title, song.name || "Sin título");
    UI.swapText(this.el.artist, song.artist || "");
    const url = Covers.get(song);
    UI.setCover(this.el.cover, url);
    this.paintBackground(url);
    this.setBadge(this.badgeFor(song));
    this.setFavorite(Boolean(song.favorite));
  },

  syncPlay() {
    if (!this.ready) return;
    const playing = Player.currentId !== null && !Player.audio.paused;
    const state = playing ? "pause" : "play";
    if (this.el.toggle.dataset.state !== state) {
      this.el.toggle.dataset.state = state;
      this.el.toggle.innerHTML = playing ? Icons.pauseBold : Icons.playBold;
    }
    this.el.toggle.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
  },

  // Etiquetas de aleatorio y repetir dentro del menú (se activan con los mismos botones de siempre)
  syncMenu() {
    if (!this.ready) return;
    const shuffle = Boolean(Settings.values.shuffle);
    const repeat = Settings.values.repeat || "all";
    const repeatText = { off: "no", all: "todas", one: "una canción" }[repeat] || "todas";
    const set = (button, text) => { const label = button && button.querySelector("span"); if (label && label.textContent !== text) label.textContent = text; };
    set(this.el.menuShuffle, "Aleatorio: " + (shuffle ? "activado" : "desactivado"));
    set(this.el.menuRepeat, "Repetir: " + repeatText);
  },

  /* Calidad: «Lossless» para formatos sin pérdida; para el resto, el formato del archivo */
  badgeFor(song) {
    const ext = String(song.fileName || "").split(".").pop().toLowerCase();
    if (["flac", "wav", "aif", "aiff", "alac"].includes(ext)) return "Lossless";
    const names = { mp3: "MP3", m4a: "M4A", aac: "AAC", ogg: "OGG", oga: "OGG", opus: "OPUS", weba: "WEBM" };
    return names[ext] || "";
  },

  setBadge(text) {
    this.el.badge.textContent = text;
    this.el.badge.hidden = !text;
  },

  /* ---------- Favoritos ---------- */

  setFavorite(on) {
    if (!this.el.fav) return;
    this.el.fav.setAttribute("aria-pressed", String(on));
    this.el.fav.setAttribute("aria-label", on ? "Quitar de favoritas" : "Añadir a favoritas");
  },

  toggleFavorite() {
    const song = Player.currentId !== null ? Library.byId(Player.currentId) : null;
    if (!song) { UI.toast("Reproduce una canción para añadirla a favoritas."); return; }
    song.favorite = !song.favorite;
    this.setFavorite(song.favorite);
    UI.toast(song.favorite ? "Añadida a favoritas" : "Quitada de favoritas");
    Store.updateSong(song).catch((error) => console.warn("No se pudo guardar el favorito:", error));
  },

  /* ---------- Menú ⋯ ---------- */

  menuOpen() { return this.ready && !this.el.menu.classList.contains("hidden"); },

  toggleMenu() {
    const open = !this.menuOpen();
    this.el.menu.classList.toggle("hidden", !open);
    this.el.menuButton.setAttribute("aria-expanded", String(open));
    if (open) this.syncMenu();
  },

  closeMenu() {
    if (!this.ready || !this.menuOpen()) return;
    this.el.menu.classList.add("hidden");
    this.el.menuButton.setAttribute("aria-expanded", "false");
  },

  /* ---------- Dispositivos de audio ---------- */

  openDevices() {
    if (Native.has("openAudioOutput")) Native.call("openAudioOutput"); // selector de salida de Android (altavoz, Bluetooth…)
    else UI.toast("Elige la salida de audio desde el panel de volumen de tu dispositivo.");
  },

  /* ---------- Volumen ----------
     En la app de Android controla el volumen de MÚSICA del teléfono, el mismo de las teclas físicas y de Bluetooth
     (se mantiene al día mientras esta pantalla está abierta). En el navegador no hay forma de cambiar el volumen del
     sistema, así que allí la fila se oculta y se usa el volumen del dispositivo. */

  setupVolume() {
    const range = this.el.volumeRange;
    if (!Native.has("getVolume") || !Native.has("setVolume")) { this.el.volume.classList.add("hidden"); return; }
    const paint = () => range.style.setProperty("--p", String((Number(range.value) || 0) / 1000));
    range.addEventListener("input", () => {
      paint();
      this.volHoldUntil = Date.now() + 700; // mientras se mueve, la lectura periódica no la pisa
      Native.call("setVolume", Number(range.value) / 1000);
    });
    range.addEventListener("pointerdown", () => { this.volDragging = true; });
    ["pointerup", "pointercancel", "change"].forEach((type) => range.addEventListener(type, () => { this.volDragging = false; }));
    this.paintVolume = paint;
    this.readVolume(true);
  },

  readVolume(force) {
    if (!this.ready || !this.paintVolume) return;
    if (!force && (this.volDragging || Date.now() < this.volHoldUntil)) return;
    const value = Native.call("getVolume");
    if (typeof value !== "number" || value < 0) return;
    const next = String(Math.round(Math.min(1, value) * 1000));
    if (this.el.volumeRange.value !== next) { this.el.volumeRange.value = next; this.paintVolume(); }
  },

  startVolumePoll() {
    if (this.volTimer || !this.paintVolume) return;
    this.readVolume(true);
    this.volTimer = setInterval(() => { if (!document.hidden) this.readVolume(false); }, 500); // sigue las teclas de volumen
  },

  stopVolumePoll() {
    if (this.volTimer) { clearInterval(this.volTimer); this.volTimer = 0; }
  },

  /* ---------- Fondo dinámico ----------
     La portada se reduce a 48×48 con desenfoque y saturación (barato) y el navegador la estira con suavidad:
     da el efecto de colores difuminados sin filtros pesados en pantalla. Al cambiar de canción se funde con la anterior. */

  paintBackground(url) {
    const bg = this.el.bg;
    if (!bg || url === this.bgUrl) return;
    this.bgUrl = url;
    const token = ++this.bgToken;
    bg.classList.toggle("still", typeof UI.prefersReducedMotion === "function" && UI.prefersReducedMotion());
    const clear = () => { bg.classList.add("nocover"); this.el.bgA.classList.remove("on"); this.el.bgB.classList.remove("on"); };
    if (!url) { clear(); return; }
    const image = new Image();
    image.onload = () => {
      if (token !== this.bgToken || !image.naturalWidth) return;
      const next = this.bgFlip ? this.el.bgA : this.el.bgB;
      const previous = this.bgFlip ? this.el.bgB : this.el.bgA;
      this.bgFlip = !this.bgFlip;
      const size = next.width;
      const ctx = next.getContext("2d");
      ctx.clearRect(0, 0, size, size);
      try { ctx.filter = "blur(3px) saturate(1.7) brightness(0.92)"; } catch (error) { /* sin filtros: queda la imagen reducida */ }
      const k = Math.max(size / image.naturalWidth, size / image.naturalHeight) * 1.15; // un poco más grande para que el borde no se vea
      const w = image.naturalWidth * k;
      const h = image.naturalHeight * k;
      ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
      try { ctx.filter = "none"; } catch (error) { /* nada */ }
      bg.classList.remove("nocover");
      next.classList.add("on");
      previous.classList.remove("on");
    };
    image.onerror = () => { if (token === this.bgToken) clear(); };
    image.src = url;
  }
};
