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
  canvasExpanded: false,   // Canvas a pantalla completa (solo estilo Inmersive con un Canvas activo)

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
      menuShuffle: $("im-menu-shuffle"), menuRepeat: $("im-menu-repeat"), card: $("player-style-card"), lyCover: $("im-ly-cover")
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
      if (PlayerStyle.lyMenuOpen()) { PlayerStyle.closeLyMenu(); return true; }
      if (PlayerStyle.canvasExpanded) { PlayerStyle.collapseCanvas(); return true; }
      return back.apply(this, args);
    };

    this.bind();
    this.setupVolume();
    this.initBackdrop();
    this.wrapRouter();
    this.watchOverlays();
    Settings.watch("mode", () => this.syncEdge(Router.current));
    if (typeof Visuals !== "undefined") Visuals.on(() => this.checkCanvas());
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
      // Canvas (v1.06): tocar la zona del video lo amplía; ya ampliado, tocar en cualquier parte (menos estrella/⋯) regresa al reproductor
      if (this.canvasMode()) {
        if (this.canvasExpanded) { if (!event.target.closest(".im-info")) this.collapseCanvas(); }
        else if (event.target.closest(".im-cover-wrap")) this.expandCanvas();
      }
    });
    window.addEventListener("resize", () => { if (this.canvasExpanded) this.measureShift(); });

    // Pantalla de letras (Inmersive): estrella, menú ⋯ y controles que aparecen al tocar
    document.addEventListener("click", (event) => {
      const action = event.target.closest("[data-im-ly]");
      if (action) { this.handleLy(action.dataset.imLy); return; }
      if (this.lyMenuOpen() && !event.target.closest("#im-ly-menu")) this.closeLyMenu();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.active || Router.current !== "lyrics" || event.target.closest(".sub-top")) return;
      this.showLyricsUi(4200);
    }, { passive: true });
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
    if (typeof Visuals !== "undefined") Visuals.sync(); // el contenido visual pasa de un diseño al otro
  },

  syncCard() {
    document.querySelectorAll("[data-player-style-id]").forEach((option) => {
      option.setAttribute("aria-checked", String(option.dataset.playerStyleId === this.style));
    });
  },

  // Se llama al cambiar de pantalla (Features.onRoute): el fondo dinámico y el volumen solo viven en el reproductor
  // Se llama al cambiar de pantalla (Features.onRoute): fondo, volumen, pantalla completa y Canvas
  onRoute(name) {
    if (!this.ready) return;
    const root = document.documentElement;
    const on = this.active && name === "player";
    const withBackdrop = this.active && (name === "player" || name === "lyrics"); // el reproductor y las letras comparten el fondo
    root.classList.toggle("im-on", on);
    root.classList.toggle("im-bgon", withBackdrop);
    if (typeof Lyrics !== "undefined") {   // Inmersive pone la línea que suena en el tercio superior (Apple Music); Pulsar RM la centra
      const wanted = this.active ? 0.12 : null;
      if (Lyrics.anchorRatio !== wanted) { Lyrics.anchorRatio = wanted; if (name === "lyrics") setTimeout(() => Lyrics.center(true), 60); }
    }
    const lyrics = this.active && name === "lyrics";
    root.classList.toggle("im-ly", lyrics);
    if (lyrics) this.showLyricsUi(2600);                       // al entrar, los controles se ven un momento y se esconden solos
    else { root.classList.remove("im-ly-ui", "im-ly-tools"); this.closeLyMenu(); }
    if (withBackdrop) this.ensureBackground();
    if (on) { this.syncAll(); this.startVolumePoll(); }
    else { this.stopVolumePoll(); this.closeMenu(); }
    if (name === "lyrics" && this.active) this.syncTrack(Player.currentId !== null ? Library.byId(Player.currentId) : null);
    if (name === "settings") this.syncCard();
    this.checkCanvas();
    this.syncEdge(name);
  },

  /* ---------- Pantalla completa (sin franja arriba) ----------
     En las pantallas inmersivas del estilo Inmersive el WebView ocupa TODA la pantalla y las barras de Android son
     transparentes; la app reserva el espacio de las barras con padding (--im-st arriba, --im-nv abajo, en px CSS).
     En el resto de pantallas se vuelve a lo de siempre. En el navegador (sin Android) no hace nada. */
  syncEdge(name) {
    const root = document.documentElement;
    const native = Native.has("setEdgeToEdge") && Native.has("getBarInsets");
    const want = native && this.active && Router.immersive(name);
    if (want) {
      const insets = Native.json("getBarInsets") || {};
      const ratio = window.devicePixelRatio || 1;
      root.style.setProperty("--im-st", Math.round((Number(insets.top) || 0) / ratio) + "px");
      root.style.setProperty("--im-nv", Math.round((Number(insets.bottom) || 0) / ratio) + "px");
    }
    root.classList.toggle("im-edge", Boolean(want));
    if (!native) return;
    // iconos oscuros solo en pantallas claras que no tienen el fondo oscuro del reproductor
    const lightScreen = (name !== "player" && name !== "lyrics") && root.dataset.mode === "light";
    Native.call("setEdgeToEdge", Boolean(want), Boolean(want && lightScreen));
  },

  /* ---------- Canvas (estilo Inmersive) ----------
     Con un Canvas activo, el video vertical ocupa toda la pantalla detrás de la interfaz (capa #vs-canvas-layer, acercado y con
     degradados para que se lea el texto). Tocar la zona del video lo AMPLÍA: la interfaz se desvanece, queda el video completo y
     solo título, artista, estrella y ⋯ bajan al borde inferior. Tocar de nuevo (o Atrás) regresa. La música no se interrumpe:
     es solo una transición visual, no hay ningún reproductor de video aparte. */

  canvasMode() {
    return this.ready && this.active && Router.current === "player" && document.documentElement.classList.contains("vs-canvas");
  },

  // Cuánto debe bajar el bloque título/estrella/⋯ para quedar pegado abajo en la vista ampliada
  measureShift() {
    const info = this.el.root.querySelector(".im-info");
    if (!info) return;
    this.el.root.style.setProperty("--vs-dy", "0px");
    const rect = info.getBoundingClientRect();
    const padBottom = parseFloat(getComputedStyle(document.getElementById("app")).paddingBottom) || 24;
    const target = document.documentElement.clientHeight - padBottom - 10;
    this.el.root.style.setProperty("--vs-dy", Math.max(0, Math.round(target - rect.bottom)) + "px");
  },

  expandCanvas() {
    if (this.canvasExpanded || !this.canvasMode()) return;
    this.closeMenu();
    this.measureShift();
    this.canvasExpanded = true;
    document.documentElement.classList.add("vs-full");
  },

  collapseCanvas() {
    if (!this.canvasExpanded) return;
    this.canvasExpanded = false;
    this.closeMenu();
    document.documentElement.classList.remove("vs-full");
  },

  // Si el Canvas deja de estar disponible (se desactiva, cambia de canción sin Canvas, otro diseño…), se sale de la vista ampliada
  checkCanvas() {
    if (this.canvasExpanded && !this.canvasMode()) this.collapseCanvas();
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
      UI.setCover(this.el.lyCover, null);
      this.lastCover = undefined;
      this.lastSongId = null;
      this.paintBackground(null);
      this.setBadge("");
      this.setFavorite(false);
      return;
    }
    UI.swapText(this.el.title, song.name || "Sin título");
    UI.swapText(this.el.artist, song.artist || "");
    const url = Covers.get(song);
    this.setCoverSmooth(url, song.id);
    UI.setCover(this.el.lyCover, url);
    this.paintBackground(url);
    this.setBadge(this.badgeFor(song));
    this.setFavorite(Boolean(song.favorite));
  },

  // Cambio de portada: la nueva entra desde abajo y la anterior se desvanece (no hay saltos ni cortes bruscos)
  setCoverSmooth(url, songId) {
    const cover = this.el.cover;
    const animate = this.lastSongId !== null && this.lastSongId !== undefined && this.lastSongId !== songId && this.lastCover !== url
      && this.active && Router.current === "player" && !(typeof UI.prefersReducedMotion === "function" && UI.prefersReducedMotion());
    let ghost = null;
    if (animate && cover.firstElementChild) {
      ghost = cover.cloneNode(true);
      ghost.removeAttribute("id");
      ghost.removeAttribute("role");
      ghost.removeAttribute("tabindex");
      ghost.classList.remove("swap-in", "has-anim");
      ghost.classList.add("im-cover-ghost");
      ghost.querySelectorAll(".vs-layer, video").forEach((node) => node.remove());
      cover.parentElement.appendChild(ghost);
      setTimeout(() => ghost.remove(), 650);
    }
    UI.setCover(cover, url);
    if (animate) {
      cover.classList.remove("swap-in");
      void cover.offsetWidth;
      cover.classList.add("swap-in");
      setTimeout(() => cover.classList.remove("swap-in"), 800);
    }
    this.lastCover = url;
    this.lastSongId = songId;
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
    [this.el.fav, document.getElementById("im-ly-fav")].forEach((button) => {
      if (!button) return;
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-label", on ? "Quitar de favoritas" : "Añadir a favoritas");
    });
  },

  toggleFavorite() {
    const song = Player.currentId !== null ? Library.byId(Player.currentId) : null;
    if (!song) { UI.toast("Reproduce una canción para añadirla a favoritas."); return; }
    song.favorite = !song.favorite;
    this.setFavorite(song.favorite);
    [this.el.fav, document.getElementById("im-ly-fav")].forEach((button) => {
      if (!button) return;
      button.classList.remove("pop");
      void button.offsetWidth;
      button.classList.add("pop");
    });
    UI.toast(song.favorite ? "Añadida a favoritas" : "Quitada de favoritas");
    Store.updateSong(song).catch((error) => console.warn("No se pudo guardar el favorito:", error));
  },

  /* ---------- Menú ⋯ ---------- */

  menuOpen() { return this.ready && this.el.menu.classList.contains("open"); },

  toggleMenu() { if (this.menuOpen()) this.closeMenu(); else this.openMenu(); },

  // Entra y sale con animación: «.hidden» (display:none) solo se pone cuando termina de salir
  openMenu() {
    clearTimeout(this.menuTimer);
    this.el.menu.classList.remove("hidden");
    void this.el.menu.offsetWidth;
    this.el.menu.classList.add("open");
    this.el.menuButton.setAttribute("aria-expanded", "true");
    this.syncMenu();
  },

  closeMenu() {
    if (!this.ready || !this.menuOpen()) return;
    this.el.menu.classList.remove("open");
    this.el.menuButton.setAttribute("aria-expanded", "false");
    clearTimeout(this.menuTimer);
    this.menuTimer = setTimeout(() => { if (!this.menuOpen()) this.el.menu.classList.add("hidden"); }, 280);
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

  /* ---------- Fondo dinámico (v1.06: a prueba de fallos) ----------
     Antes el fondo eran dos <canvas>: Android puede descartar su contenido (memoria, segundo plano, pérdida de la GPU) y la
     pantalla quedaba negra hasta cambiar de canción. Ahora:
       · la portada se reduce a 48×48 con desenfoque y se guarda como imagen (data:), que no se pierde;
       · debajo siempre hay un degradado con la PALETA de la portada (--im-c1/2/3), así que nunca queda negro;
       · la carga de la imagen se espera (decode) y se reintenta; si falla el desenfoque se usa otro método;
       · las capas se funden una SOBRE otra (la anterior sigue opaca debajo): no hay bajón de brillo en el cambio;
       · un vigilante comprueba el fondo al volver a la app, al entrar al reproductor y cada pocos segundos, y lo repinta si hace falta. */

  bgCache: new Map(),   // url → { data, palette } (las últimas portadas, para repintar al instante)
  bgLast: null,
  bgRetries: 0,

  bgHealthy() {
    const { bgA, bgB } = this.el;
    const top = this.bgTop;
    return Boolean(top && top.classList.contains("on") && top.style.backgroundImage && top.style.backgroundImage !== "none") || (this.bgFallback === true && !bgA.classList.contains("on") && !bgB.classList.contains("on"));
  },

  paintBackground(url, force) {
    const bg = this.el.bg;
    if (!bg) return;
    if (!force && url === this.bgUrl && this.bgHealthy()) return;
    // con un Animated Cover/Canvas el reproductor y las letras comparten la paleta del video: no se pisa con la de la portada fija
    if (!force && this.bgUrl === "media" && this.mediaStillValid() && this.bgHealthy()) return;
    this.bgUrl = url;
    const token = ++this.bgToken;
    clearTimeout(this.bgRetryTimer);
    bg.classList.toggle("still", typeof UI.prefersReducedMotion === "function" && UI.prefersReducedMotion());
    if (!url) { this.useFallback(); return; }
    const cached = this.bgCache.get(url);
    if (cached) { this.showRender(cached, token); return; }
    this.loadImage(url, token).then((image) => {
      if (token !== this.bgToken) return;
      if (!image) throw new Error("no se pudo cargar la portada");
      const render = this.render(image);
      this.bgCache.set(url, render);
      if (this.bgCache.size > 8) this.bgCache.delete(this.bgCache.keys().next().value);
      this.showRender(render, token);
    }).catch((error) => { if (token === this.bgToken) this.failBackground(url, error); });
  },

  // Espera a que la imagen esté lista de verdad (decode) y reintenta un par de veces
  async loadImage(url, token) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (token !== this.bgToken) return null;
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        await image.decode();
        if (image.naturalWidth > 0) return image;
      } catch (error) { /* se reintenta */ }
      await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
    }
    return null;
  },

  // Imagen o fotograma de video → { data: imagen 48×48 suavizada, palette: {c1,c2,c3} }
  render(source) {
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    if (!w || !h) throw new Error("fuente sin tamaño");
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const k = Math.max(size / w, size / h) * 1.15;       // un poco más grande: el borde del desenfoque no se ve
    const dw = w * k, dh = h * k, dx = (size - dw) / 2, dy = (size - dh) / 2;
    let blurred = false;
    try { ctx.filter = "blur(3px) saturate(1.3) brightness(0.78)"; blurred = typeof ctx.filter === "string" && ctx.filter !== "none"; } catch (error) { blurred = false; }
    ctx.drawImage(source, dx, dy, dw, dh);
    try { ctx.filter = "none"; } catch (error) { /* nada */ }
    if (!blurred) this.softBlur(ctx, source, size, dx, dy, dw, dh); // recuperación: sin filtro, se suaviza reduciendo y ampliando
    let palette = null;
    try { palette = this.paletteOf(ctx, size); } catch (error) { palette = null; }
    const data = canvas.toDataURL("image/jpeg", 0.86);
    if (!data || data.length < 300) throw new Error("imagen de fondo vacía");
    return { data, palette: palette || this.themePalette() };
  },

  softBlur(ctx, source, size, dx, dy, dw, dh) {
    const tiny = document.createElement("canvas");
    tiny.width = tiny.height = 9;
    const tctx = tiny.getContext("2d");
    tctx.imageSmoothingQuality = "high";
    tctx.drawImage(source, dx * 9 / size, dy * 9 / size, dw * 9 / size, dh * 9 / size);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tiny, 0, 0, size, size);
  },

  // Tres colores de la imagen: uno medio y oscuro (c1), el más vivo (c2) y el más oscuro (c3)
  paletteOf(ctx, size) {
    const data = ctx.getImageData(0, 0, size, size).data;
    const cells = 6, step = size / cells;
    let tr = 0, tg = 0, tb = 0, n = 0, vivid = null, dark = null;
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        let r = 0, g = 0, b = 0, count = 0;
        for (let y = Math.floor(cy * step); y < Math.floor((cy + 1) * step); y++) {
          for (let x = Math.floor(cx * step); x < Math.floor((cx + 1) * step); x++) {
            const i = (y * size + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
          }
        }
        if (!count) continue;
        r /= count; g /= count; b /= count;
        tr += r; tg += g; tb += b; n++;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const sat = max ? (max - min) / max : 0;
        const vividScore = sat * (0.35 + lum) * (lum > 0.08 ? 1 : 0.2);
        if (!vivid || vividScore > vivid.score) vivid = { r, g, b, score: vividScore };
        if (!dark || lum < dark.lum) dark = { r, g, b, lum };
      }
    }
    if (!n) throw new Error("sin píxeles");
    const avg = { r: tr / n, g: tg / n, b: tb / n };
    const mix = (c, t, k) => ({ r: c.r * (1 - k) + t.r * k, g: c.g * (1 - k) + t.g * k, b: c.b * (1 - k) + t.b * k });
    const black = { r: 6, g: 9, b: 18 };
    const c2 = this.tone(vivid || avg, 0.3, 0.5, 1.0);
    return { c1: this.rgb(mix(avg, black, 0.5)), c2: this.rgb(c2), c3: this.rgb(mix(dark || avg, black, 0.72)), c4: this.rgb(this.tone(avg, 0.46, 0.64, 0.3)) };
  },

  // Ajusta el brillo de un color a [lmin, lmax] (en HSL) y le da un poco más de vida
  tone(c, lmin, lmax, satBoost) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    l = Math.min(lmax, Math.max(lmin, l));
    s = Math.min(1, s * satBoost);
    const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - q;
    return { r: f(pp, q, h + 1 / 3) * 255, g: f(pp, q, h) * 255, b: f(pp, q, h - 1 / 3) * 255 };
  },

  rgb(c) { return "rgb(" + Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) + ")"; },

  // Paleta del tema (color de acento de Pulsar RM): se usa cuando no hay portada o no se pudo leer
  themePalette() {
    let hex = "";
    try { hex = cssToHex(getComputedStyle(document.documentElement).getPropertyValue("--accent")); } catch (error) { hex = ""; }
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    const base = m ? { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) } : { r: 90, g: 110, b: 190 };
    const black = { r: 6, g: 9, b: 18 };
    const mix = (c, t, k) => ({ r: c.r * (1 - k) + t.r * k, g: c.g * (1 - k) + t.g * k, b: c.b * (1 - k) + t.b * k });
    return { c1: this.rgb(mix(base, black, 0.62)), c2: this.rgb(this.tone(base, 0.34, 0.6, 1)), c3: this.rgb(mix(base, black, 0.9)), c4: this.rgb(this.tone(base, 0.46, 0.64, 0.3)) };
  },

  applyPalette(palette) {
    const root = document.documentElement;
    root.style.setProperty("--im-c1", palette.c1);
    root.style.setProperty("--im-c2", palette.c2);
    root.style.setProperty("--im-c3", palette.c3);
    root.style.setProperty("--im-c4", palette.c4 || palette.c2);
  },

  // Muestra la imagen nueva ENCIMA de la anterior; la anterior solo se apaga cuando la nueva ya está opaca
  showRender(render, token) {
    const { bg, bgA, bgB } = this.el;
    const next = this.bgTop === bgA ? bgB : bgA;
    const previous = this.bgTop === bgA ? bgA : bgB;
    const probe = new Image();
    const apply = () => {
      if (token !== this.bgToken) return;
      if (next.classList.contains("on")) { // era la capa de abajo de un cambio anterior: se apaga sin animar (queda tapada)
        next.style.transition = "none";
        next.classList.remove("on");
        void next.offsetWidth;
        next.style.transition = "";
      }
      next.style.backgroundImage = 'url("' + render.data + '")';
      next.style.zIndex = "2";
      previous.style.zIndex = "1";
      this.applyPalette(render.palette);
      bg.classList.remove("nocover");
      this.bgFallback = false;
      void next.offsetWidth;
      next.classList.add("on");
      this.bgTop = next;
      this.bgLast = render;
      this.bgRetries = 0;
      clearTimeout(this.bgSettle);
      this.bgSettle = setTimeout(() => { if (token === this.bgToken && this.bgTop === next) previous.classList.remove("on"); }, 1150);
    };
    probe.src = render.data;
    if (typeof probe.decode === "function") probe.decode().then(apply, apply); else { probe.onload = apply; probe.onerror = apply; }
  },

  // Sin portada (o ya agotados los reintentos): fondo con la paleta del tema; las capas se funden hacia fuera
  useFallback() {
    const { bg, bgA, bgB } = this.el;
    this.applyPalette(this.themePalette());
    bg.classList.add("nocover");
    bgA.classList.remove("on");
    bgB.classList.remove("on");
    this.bgTop = null;
    this.bgFallback = true;
  },

  failBackground(url, error) {
    Diagnostics.log("fondo", String(error && error.message ? error.message : error));
    if (this.bgRetries < 3) { // se mantiene lo que ya había (coherente con la canción anterior) y se reintenta con calma
      this.bgRetries++;
      const token = this.bgToken;
      this.bgRetryTimer = setTimeout(() => { if (token === this.bgToken) this.paintBackground(url, true); }, 1500 * this.bgRetries);
      if (!this.bgLast) this.useFallback();
      return;
    }
    this.useFallback();
  },

  // Vuelve a pintar el fondo si hace falta (al entrar, al volver a la app, y cada pocos segundos mientras se ve)
  ensureBackground() {
    if (!this.ready || !this.active) return;
    const song = Player.currentId !== null ? Library.byId(Player.currentId) : null;
    const url = song ? Covers.get(song) : null;
    // con un video en movimiento el fondo sigue al video (bgUrl = «media»): solo se repinta si dejó de estar sano o el video ya no está
    if (this.bgUrl === "media" && this.mediaStillValid() && this.bgHealthy()) return;
    if (url !== this.bgUrl || !this.bgHealthy()) this.paintBackground(url, true);
  },

  // El fondo «media» sigue valiendo mientras la canción sea la misma y conserve su Animated Cover o su Canvas activo
  mediaStillValid() {
    if (typeof Visuals === "undefined" || Player.currentId === null || this.mediaSongId !== Player.currentId) return false;
    return Visuals.hasCover(Player.currentId) || Visuals.canvasOn(Player.currentId);
  },

  // ¿Hay un Animated Cover o Canvas (video) montado para este diseño?
  hasMedia() {
    if (typeof Visuals === "undefined" || !Visuals.mounted) return false;
    const mounted = Visuals.mounted.iCanvas || Visuals.mounted.iCover;
    return Boolean(mounted && mounted.media && mounted.media.tagName === "VIDEO" && mounted.layer.isConnected);
  },

  initBackdrop() {
    this.bgTop = null;
    this.bgFallback = true;
    this.applyPalette(this.themePalette());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.ensureBackground(); });
    window.addEventListener("pageshow", () => this.ensureBackground());
    setInterval(() => {
      if (document.hidden || !document.documentElement.classList.contains("im-bgon")) return;
      this.ensureBackground();
    }, 4000);
    // con un Animated Cover / Canvas en movimiento, el fondo sigue sus colores (más seguido, para que los bordes de la imagen se fundan)
    setInterval(() => { if (!document.hidden) this.followMedia(); }, 2200);
    if (typeof Visuals !== "undefined") Visuals.on(() => setTimeout(() => this.followMedia(), 400));
    Settings.watch(["mode", "theme"], () => { if (this.bgFallback) this.applyPalette(this.themePalette()); });
  },

  // Con un Animated Cover (o un Canvas) en movimiento, la paleta y el fondo siguen los colores del video
  followMedia() {
    if (!this.active || Router.current !== "player" || typeof Visuals === "undefined" || !Visuals.mounted) return;
    if (!this.hasMedia()) { if (this.bgUrl === "media") this.ensureBackground(); return; }   // el video se quitó: vuelve el fondo de la portada
    const mounted = Visuals.mounted.iCanvas || Visuals.mounted.iCover;
    const video = mounted.media;
    if (video.paused || video.readyState < 2) return;
    try {
      const render = this.render(video);
      this.bgUrl = "media";
      this.mediaSongId = Player.currentId;
      this.showRender(render, this.bgToken);
    } catch (error) { /* se queda con el fondo de la portada */ }
  },

  /* ---------- Transiciones entre pantallas ----------
     Al cambiar de pantalla la anterior no desaparece de golpe: se deja una copia (fantasma) que se aleja y se desvanece mientras la
     nueva entra (animación en immersive.css). Es solo visual: Router.show se ejecuta igual y al instante, sin esperas ni toques perdidos. */

  rank(name) { return name === "home" || name === "library" ? 0 : name === "player" ? 1 : 2; },

  wrapRouter() {
    const show = Router.show;
    Router.show = function (name) {
      const previousEl = document.querySelector(".view.active");
      const previous = previousEl ? previousEl.dataset.viewName : null;
      let ghost = null;
      let direction = "fwd";
      if (PlayerStyle.ready && PlayerStyle.active && previousEl && previous && previous !== name
          && !(PlayerStyle.rank(previous) === 0 && PlayerStyle.rank(name) === 0)
          && !(typeof UI.prefersReducedMotion === "function" && UI.prefersReducedMotion())) {
        direction = PlayerStyle.rank(name) < PlayerStyle.rank(previous) ? "back" : "fwd";
        try { ghost = PlayerStyle.makeGhost(previousEl); } catch (error) { ghost = null; }
      }
      document.documentElement.dataset.nav = direction;
      const result = show.apply(this, arguments);
      if (ghost) PlayerStyle.playGhost(ghost, direction);
      return result;
    };
  },

  makeGhost(view) {
    const rect = view.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    const ghost = view.cloneNode(true);
    ghost.classList.remove("active");
    ghost.classList.add("im-ghost");
    ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    ghost.querySelectorAll("[data-progress], [data-time], [data-action], [data-view], [data-im], [data-vs]").forEach((node) => {
      ["data-progress", "data-time", "data-action", "data-view", "data-im", "data-vs"].forEach((name) => node.removeAttribute(name));
    });
    ghost.querySelectorAll("video, audio, canvas, input, .vs-layer").forEach((node) => { if (node.tagName !== "INPUT") node.remove(); });
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, { display: "block", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
    const lyrics = view.querySelector(".lyrics");
    ghost._scroll = lyrics ? lyrics.scrollTop : 0;
    return ghost;
  },

  playGhost(ghost, direction) {
    const host = document.getElementById("app") || document.body;
    host.appendChild(ghost);
    const lyrics = ghost.querySelector(".lyrics");
    if (lyrics) lyrics.scrollTop = ghost._scroll || 0;
    ghost.classList.add(direction);
    const done = () => ghost.remove();
    ghost.addEventListener("animationend", done, { once: true });
    setTimeout(done, 700);
  },

  /* ---------- Ventanas (hojas inferiores y diálogos) ----------
     La app las quita del documento al cerrarlas. Aquí se detecta y se vuelven a dejar un momento con la animación de salida,
     así no se cierran de golpe. */
  watchOverlays() {
    const observer = new MutationObserver((records) => {
      if (!this.active || (typeof UI.prefersReducedMotion === "function" && UI.prefersReducedMotion())) return;
      records.forEach((record) => record.removedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement) || node.dataset.imLeaving || !node.matches(".sheet, .confirm")) return;
        node.dataset.imLeaving = "1";
        node.classList.add("im-leaving");
        document.body.appendChild(node);
        setTimeout(() => node.remove(), 450);
      }));
    });
    observer.observe(document.body, { childList: true });
  },

  /* ---------- Pantalla de letras (Inmersive) ---------- */

  lyMenuOpen() { const menu = document.getElementById("im-ly-menu"); return Boolean(menu && menu.classList.contains("open")); },

  openLyMenu() {
    const menu = document.getElementById("im-ly-menu"), button = document.getElementById("im-ly-more");
    if (!menu) return;
    clearTimeout(this.lyMenuTimer);
    menu.classList.remove("hidden");
    void menu.offsetWidth;
    menu.classList.add("open");
    if (button) button.setAttribute("aria-expanded", "true");
  },

  closeLyMenu() {
    const menu = document.getElementById("im-ly-menu"), button = document.getElementById("im-ly-more");
    if (!menu || !menu.classList.contains("open")) return;
    menu.classList.remove("open");
    if (button) button.setAttribute("aria-expanded", "false");
    clearTimeout(this.lyMenuTimer);
    this.lyMenuTimer = setTimeout(() => { if (!menu.classList.contains("open")) menu.classList.add("hidden"); }, 280);
  },

  handleLy(action) {
    switch (action) {
      case "fav": this.toggleFavorite(); break;
      case "menu": if (this.lyMenuOpen()) this.closeLyMenu(); else this.openLyMenu(); break;
      case "options": this.closeLyMenu(); LyricsScreen.toggleOptions(); break;
      case "tools": this.closeLyMenu(); document.documentElement.classList.toggle("im-ly-tools"); break;
      case "controls": this.closeLyMenu(); this.showLyricsUi(7000); break;
      default: break;
    }
  },

  // Los controles de reproducción de las letras aparecen al tocar y se esconden solos (la referencia no los muestra en reposo)
  showLyricsUi(ms) {
    const root = document.documentElement;
    root.classList.add("im-ly-ui");
    clearTimeout(this.lyUiTimer);
    this.lyUiTimer = setTimeout(() => root.classList.remove("im-ly-ui"), ms || 4200);
  }
};
