/* =========================================================
   PULSAR RM — Herramientas de la biblioteca (library-tools.js)

   LibrarySort : orden de «Canciones» → Nombre · Artista · Agregado recientemente, ascendente o descendente.
   SortMenu    : menú flotante para elegir ese orden (botón junto al contador de la biblioteca).
   AlphaIndex  : indicador alfabético lateral. Aparece al desplazarse por Biblioteca → Canciones (ordenadas por
                 Nombre o Artista) y permite tocar o deslizar para saltar a una letra.
   LibraryTools: punto de entrada. script.js y features.js solo llaman a estos tres métodos:
                 init() · sorted(canciones) · onRender(lista) · onRoute(pantalla)

   Reglas de diseño:
   - Solo cambia la VISTA. Library.songs conserva su orden (por fecha de alta), no se escribe nada en los archivos
     ni en sus metadatos; lo único que se guarda son los ajustes `sortBy` y `sortDir` (Settings).
   - La cola sale del orden de la lista que se ve (UI.listIds lee el DOM), así que «siguiente» sigue lo que ves.
   - Si algo falla aquí, la biblioteca se dibuja igual (sin orden ni indicador) y el error queda en Diagnóstico.
   ========================================================= */

"use strict";

/* ---------------------------------------------------------
   LIBRARY SORT — criterios y comparación
   --------------------------------------------------------- */
const LibrarySort = {
  OPTIONS: [
    { id: "name", label: "Nombre", icon: "list" },
    { id: "artist", label: "Artista", icon: "person" },
    { id: "added", label: "Agregado recientemente", icon: "clock" }
  ],
  DIRS: [
    { id: "asc", label: "Ascendente", icon: "up" },
    { id: "desc", label: "Descendente", icon: "down" }
  ],

  _collator: null,

  // Símbolos y espacios del principio no cuentan para ordenar: «(Satisfaction)» va en la S y «¡Hola!» en la H.
  LEADING: (function () {
    try { return new RegExp("^[\\p{P}\\p{S}\\p{Z}\\p{C}]+", "u"); } catch (error) { /* WebView sin \p{…} */ }
    return /^[\s"'`´‘’“”«»¡¿!?.,;:()[\]{}<>\-_*#@$%&+=\/\\|~^]+/;
  })(),

  // Orden elegido (siempre válido, aunque el ajuste guardado esté vacío o dañado)
  state() {
    const values = (typeof Settings !== "undefined" && Settings.values) || {};
    return {
      by: this.OPTIONS.some((option) => option.id === values.sortBy) ? values.sortBy : "name",
      dir: values.sortDir === "desc" ? "desc" : "asc"
    };
  },

  setBy(id) { if (this.OPTIONS.some((option) => option.id === id)) Settings.set("sortBy", id); },
  setDir(id) { if (id === "asc" || id === "desc") Settings.set("sortDir", id); },

  label(by) { const option = this.OPTIONS.find((item) => item.id === by); return option ? option.label : ""; },

  collator() {
    if (!this._collator) {
      try { this._collator = new Intl.Collator("es", { sensitivity: "base", numeric: true }); } catch (error) {
        this._collator = { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };
      }
    }
    return this._collator;
  },

  // «Árbol» → «Arbol», sin símbolos al principio. Es la clave con la que se ordena y se elige la letra.
  key(text) {
    let value = String(text == null ? "" : text);
    try { value = value.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (error) { /* sin normalize */ }
    return value.replace(this.LEADING, "").trim();
  },

  // Letra A–Z del texto; números, símbolos y otros alfabetos van juntos en «#».
  group(key) {
    const first = key.charAt(0).toUpperCase();
    return /^[A-Z]$/.test(first) ? first : "#";
  },

  fieldOf(song, by) { return by === "artist" ? song.artist : (song.name || "Sin título"); },

  isUnknownArtist(song) {
    if (typeof LibraryBrowse !== "undefined" && LibraryBrowse.unknownArtist) return LibraryBrowse.unknownArtist(song.artist);
    return !song.artist || /^(archivo local|desconocido|<unknown>|unknown)$/i.test(String(song.artist).trim());
  },

  // Letra de una canción según el criterio (Nombre o Artista). Los artistas desconocidos van en «#».
  groupOf(song, by) {
    if (by === "artist" && this.isUnknownArtist(song)) return "#";
    return this.group(this.key(this.fieldOf(song, by)));
  },

  // Devuelve una COPIA ordenada. Nunca modifica la lista recibida (ni Library.songs).
  sorted(songs) {
    const { by, dir } = this.state();
    const sign = dir === "desc" ? -1 : 1;

    if (by === "added") {
      // Fecha de alta; con la misma fecha (importaciones en bloque) decide el id, así «descendente» es el inverso exacto de «ascendente».
      return songs
        .map((song, i) => ({ song, i }))
        .sort((a, b) => sign * (((a.song.addedAt || 0) - (b.song.addedAt || 0)) || (a.song.id - b.song.id) || (a.i - b.i)))
        .map((row) => row.song);
    }

    const collator = this.collator();
    const other = by === "artist" ? "name" : "artist";
    const rows = songs.map((song, i) => {
      const unknown = by === "artist" && this.isUnknownArtist(song);
      const k = this.key(this.fieldOf(song, by));
      return { song, i, unknown, k, g: unknown ? "#" : this.group(k), k2: this.key(this.fieldOf(song, other)) };
    });

    rows.sort((a, b) => {
      const ra = a.g === "#" ? 1 : 0, rb = b.g === "#" ? 1 : 0;
      if (ra !== rb) return ra - rb;                                  // «#» siempre al final
      if (!ra && a.g !== b.g) return a.g < b.g ? -sign : sign;        // primero la letra: cada letra queda en un solo bloque
      if (ra && a.unknown !== b.unknown) return a.unknown ? 1 : -1;   // artistas desconocidos, al final de «#»
      const c = collator.compare(a.k, b.k);
      if (c) return c * sign;
      // Empates: el otro campo (siempre A→Z), luego fecha de alta, id y posición original: el resultado es estable
      return collator.compare(a.k2, b.k2) || ((a.song.addedAt || 0) - (b.song.addedAt || 0)) || (a.song.id - b.song.id) || (a.i - b.i);
    });
    return rows.map((row) => row.song);
  }
};

/* ---------------------------------------------------------
   SORT MENU — menú flotante (referencia: 3.ª imagen del collage)
   --------------------------------------------------------- */
const SortMenu = {
  root: null,
  handle: null,
  anchor: null,

  init() {
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const button = target.closest("[data-sort-open]");
      if (button) {
        event.preventDefault();
        if (this.handle) this.close(); else this.open(button);
        return;
      }
      const item = target.closest(".sm-item");
      if (item && this.root && this.root.contains(item)) { event.preventDefault(); this.choose(item); }
    });

    // Teclado: flechas para moverse entre opciones (Escape ya lo gestiona Features → UI.closeTopOverlay)
    document.addEventListener("keydown", (event) => {
      if (!this.handle || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const items = Array.from(this.root.querySelectorAll(".sm-item"));
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement);
      const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
      items[next].focus();
    });
  },

  html() {
    const state = LibrarySort.state();
    const item = (attr, id, label, icon, on) =>
      `<button type="button" class="sm-item${on ? " on" : ""}" role="menuitemradio" aria-checked="${on}" ${attr}="${id}"><span>${label}</span>${LibraryTools.icon(icon)}</button>`;
    const by = (id) => LibrarySort.OPTIONS.find((option) => option.id === id);
    const criterion = (id) => item("data-sort-by", id, by(id).label, by(id).icon, state.by === id);
    const direction = (option) => item("data-sort-dir", option.id, option.label, option.icon, state.dir === option.id);
    // Tres bloques, como en la referencia: textos · fecha · dirección
    return `<div class="sm-group">${criterion("name")}${criterion("artist")}</div>` +
      `<div class="sm-gap"></div><div class="sm-group">${criterion("added")}</div>` +
      `<div class="sm-gap"></div><div class="sm-group">${LibrarySort.DIRS.map(direction).join("")}</div>`;
  },

  open(anchor) {
    if (this.handle) return;
    AlphaIndex.hide(true);
    const root = document.createElement("div");
    root.className = "sm";
    root.innerHTML = '<div class="sm-scrim"></div><div class="sm-menu" role="menu" aria-label="Ordenar canciones">' + this.html() + "</div>";
    document.body.appendChild(root);
    this.place(root, anchor);

    // Tocar fuera (o empezar a arrastrar la pantalla) lo cierra
    root.querySelector(".sm-scrim").addEventListener("pointerdown", (event) => { event.preventDefault(); this.close(); });

    anchor.setAttribute("aria-expanded", "true");
    // Se registra como las demás hojas: el botón/gesto Atrás de Android y Escape lo cierran (Router.closeOverlay → UI.closeTopOverlay)
    const handle = { el: root, close: () => this.close() };
    UI.overlays.push(handle);
    this.handle = handle;
    this.root = root;
    this.anchor = anchor;
    const active = root.querySelector(".sm-item.on");
    if (active) active.focus({ preventScroll: true });
  },

  // Bajo el botón y alineado a su borde derecho; si no cabe abajo, se abre hacia arriba
  place(root, anchor) {
    const menu = root.querySelector(".sm-menu");
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = Math.min(280, vw - 24);
    const left = Math.min(Math.max(12, rect.right - width), vw - width - 12);
    menu.style.width = width + "px";
    menu.style.left = left + "px";
    const height = menu.offsetHeight;
    let top = rect.bottom + 8, up = false;
    if (top + height > vh - 12) { top = Math.max(12, rect.top - 8 - height); up = true; }
    menu.style.top = top + "px";
    menu.style.transformOrigin = Math.round(rect.right - left) + "px " + (up ? "100%" : "0");
  },

  choose(item) {
    if (item.dataset.sortBy) LibrarySort.setBy(item.dataset.sortBy);
    if (item.dataset.sortDir) LibrarySort.setDir(item.dataset.sortDir);
    const state = LibrarySort.state();
    this.root.querySelectorAll(".sm-item").forEach((button) => {
      const on = button.dataset.sortBy ? button.dataset.sortBy === state.by : button.dataset.sortDir === state.dir;
      button.classList.toggle("on", on);
      button.setAttribute("aria-checked", String(on));
    });
    // Un instante para ver la marca nueva y se cierra (la lista ya cambió detrás)
    setTimeout(() => this.close(), UI.prefersReducedMotion() ? 0 : 140);
  },

  close(immediate) {
    const handle = this.handle;
    if (!handle) return;
    this.handle = null;
    const index = UI.overlays.indexOf(handle);
    if (index >= 0) UI.overlays.splice(index, 1);
    if (this.anchor) this.anchor.setAttribute("aria-expanded", "false");
    const root = this.root;
    this.root = null;
    if (!root) return;
    if (immediate || UI.prefersReducedMotion()) { root.remove(); return; }
    root.classList.add("out");
    setTimeout(() => root.remove(), 170);
  }
};

/* ---------------------------------------------------------
   ALPHA INDEX — indicador alfabético (referencia: 1.ª imagen del collage)
   Una columna fina a la derecha (puntos y letras), un círculo que marca dónde estás y, mientras la tocas,
   una burbuja grande con la letra. Se ve solo mientras te desplazas y se esconde sola.
   --------------------------------------------------------- */
const AlphaIndex = {
  el: null, track: null, thumb: null, bubble: null, letterEl: null, probe: null,
  letters: [],       // letras que existen en la lista, en el orden en que aparecen: ["A", "C", "M", "#"]
  starts: [],        // primera fila de cada letra (elemento del DOM)
  n: 0,
  cur: -1,           // letra marcada
  sel: -1,           // última letra elegida con el dedo
  visible: false, dragging: false, hover: false,
  pointer: null, rect: null,
  top: 0, height: 0, slot: 0,
  sig: "",           // firma del dibujo actual de la columna (letras + paso de etiquetas)
  hideTimer: 0, bubbleTimer: 0, raf: 0, quietUntil: 0,

  init() {
    if (this.el) return;
    const el = document.createElement("div");
    el.id = "alpha-index";
    el.className = "alpha";
    el.dataset.show = "0";
    el.setAttribute("aria-hidden", "true"); // ayuda táctil; con teclado o lector de pantalla está el buscador
    el.innerHTML = '<div class="alpha-probe"></div><div class="alpha-track"></div><div class="alpha-thumb"><span></span></div><div class="alpha-bubble"><div><b></b></div></div>';
    document.body.appendChild(el);
    this.el = el;
    this.probe = el.querySelector(".alpha-probe");
    this.track = el.querySelector(".alpha-track");
    this.thumb = el.querySelector(".alpha-thumb");
    this.bubble = el.querySelector(".alpha-bubble");
    this.letterEl = this.bubble.querySelector("b");

    el.addEventListener("pointerdown", (event) => this.down(event));
    el.addEventListener("pointermove", (event) => this.move(event));
    el.addEventListener("pointerup", (event) => this.up(event));
    el.addEventListener("pointercancel", (event) => this.up(event));
    el.addEventListener("lostpointercapture", (event) => this.up(event));
    // Con ratón: mientras el puntero está encima, no se esconde
    el.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") { this.hover = true; clearTimeout(this.hideTimer); } });
    el.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") { this.hover = false; this.touch(); } });

    window.addEventListener("scroll", () => this.onScroll(), { passive: true });
    window.addEventListener("resize", () => { if (this.visible && !this.layout()) this.hide(true); });
  },

  /* ----- Datos: se llama tras dibujar la lista de canciones ----- */

  // `list` = canciones tal como se dibujaron (ya ordenadas y filtradas); null = no se muestra la lista de canciones
  onRender(list) {
    if (!this.el) return;
    const state = LibrarySort.state();
    // Con «Agregado recientemente» la lista no está en orden alfabético: el indicador no tendría sentido
    if (!list || list.length < 2 || state.by === "added") { this.setGroups([], []); return; }
    const rows = UI.el.songList.querySelectorAll(":scope > .song-item");
    if (rows.length !== list.length) { this.setGroups([], []); return; }
    const letters = [], starts = [];
    let last = null;
    for (let i = 0; i < list.length; i++) {
      const letter = LibrarySort.groupOf(list[i], state.by);
      if (letter !== last) { letters.push(letter); starts.push(rows[i]); last = letter; }
    }
    this.setGroups(letters, starts);
  },

  setGroups(letters, starts) {
    this.starts = starts;
    this.letters = letters;
    this.n = letters.length;
    if (this.n < 2) { this.n = 0; this.letters = []; this.starts = []; this.sig = ""; this.hide(true); return; }
    if (this.visible && !this.layout()) this.hide(true);   // la lista cambió mientras se veía (p. ej. al escribir en el buscador)
    else if (this.visible) this.syncToScroll(true);
  },

  active() {
    return this.n >= 2 && Router.current === "library" && typeof LibraryBrowse !== "undefined" && LibraryBrowse.tab === "songs";
  },

  onRoute(name) {
    this.quietUntil = Date.now() + 700;   // el salto de scroll al abrir la pantalla no debe encenderlo
    if (name !== "library") this.hide(true);
  },

  /* ----- Aparecer y esconderse ----- */

  onScroll() {
    if (this.raf || Router.current !== "library" || this.n < 2) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.active()) { if (this.visible) this.hide(true); return; }
      if (!this.visible) {
        if (Date.now() < this.quietUntil || !this.scrollable()) return;
        if (!this.show()) return;
      }
      this.touch();
      if (!this.dragging) this.syncToScroll(false);
    });
  },

  // No tiene sentido si la lista casi cabe en pantalla
  scrollable() {
    return document.documentElement.scrollHeight - window.innerHeight > 180;
  },

  show() {
    if (!this.layout()) return false;
    this.visible = true;
    this.el.classList.add("snap");              // la primera colocación no se desliza desde la posición anterior
    this.el.dataset.show = "1";
    this.syncToScroll(true);
    requestAnimationFrame(() => this.el.classList.remove("snap"));
    return true;
  },

  hide(now) {
    clearTimeout(this.hideTimer);
    if (this.dragging && !now) return;
    if (now) { this.dragging = false; this.hover = false; }
    this.visible = false;
    this.el.dataset.show = "0";
    this.el.classList.remove("drag");
  },

  // Programa esconderse tras un momento sin actividad
  touch() {
    clearTimeout(this.hideTimer);
    if (this.dragging || this.hover) return;
    this.hideTimer = setTimeout(() => this.hide(), 1600);
  },

  /* ----- Medidas ----- */

  safeTop() { return this.probe ? this.probe.offsetHeight : 0; },   // el sondeo tiene padding-top: env(safe-area-inset-top)

  // Coloca la columna en el hueco libre del lado derecho (sin tapar el mini reproductor ni la barra inferior)
  layout() {
    const n = this.n;
    if (n < 2) return false;
    const vh = window.innerHeight;
    const topLimit = this.safeTop() + 76;
    let bottomLimit = vh - 16;
    const nav = document.querySelector(".bottom-nav");
    if (nav) bottomLimit = Math.min(bottomLimit, nav.getBoundingClientRect().top - 12);
    const mini = UI.el.miniPlayer;
    if (mini && !mini.classList.contains("hidden")) bottomLimit = Math.min(bottomLimit, mini.getBoundingClientRect().top - 12);
    const available = bottomLimit - topLimit;
    if (available < 110) return false;           // pantalla demasiado baja (p. ej. horizontal con teclado)

    const height = Math.round(Math.min(available, Math.max(140, n * 24)));
    const top = Math.round(topLimit + (available - height) / 2);
    const slot = height / n;
    const step = slot >= 15 ? 1 : Math.ceil(15 / slot);   // si no caben todas las letras, se etiquetan alternas y el resto son puntos
    this.el.style.top = top + "px";
    this.el.style.height = height + "px";
    this.top = top; this.height = height; this.slot = slot;

    const sig = this.letters.join("") + "|" + step;
    if (sig !== this.sig) { this.sig = sig; this.buildTrack(step); }
    return true;
  },

  buildTrack(step) {
    const n = this.n;
    const labelled = new Set();
    for (let i = 0; i < n; i += step) labelled.add(i);
    if (step > 1 && !labelled.has(n - 1)) { labelled.delete(Math.floor((n - 1) / step) * step); labelled.add(n - 1); }
    this.track.innerHTML = this.letters
      .map((letter, i) => labelled.has(i) ? `<i data-i="${i}">${letter}</i>` : `<i class="dot" data-i="${i}"></i>`)
      .join("");
    this.cur = -1;
  },

  /* ----- Posición actual ----- */

  anchorY() { return this.safeTop() + 110; },   // línea de referencia cerca del borde de arriba

  // Marca la letra que corresponde al punto de la lista donde está la pantalla
  syncToScroll(force) {
    if (this.n < 2 || !this.starts.length) return;
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    let index = 0;
    if (atBottom) index = this.n - 1;
    else {
      const anchor = this.anchorY();
      for (let i = this.n - 1; i >= 0; i--) {
        const row = this.starts[i];
        if (!row || !row.isConnected) return;
        if (row.getBoundingClientRect().top <= anchor) { index = i; break; }
      }
    }
    this.setCurrent(index, force);
  },

  setCurrent(index, force) {
    if (index === this.cur && !force) return;
    const children = this.track.children;
    if (this.cur >= 0 && children[this.cur]) children[this.cur].classList.remove("on");
    this.cur = index;
    if (children[index]) children[index].classList.add("on");
    const y = (index + 0.5) * this.slot;
    this.thumb.style.transform = `translate3d(0, ${(y - 11).toFixed(1)}px, 0)`;
    this.bubble.style.transform = `translate3d(0, ${(y - 30).toFixed(1)}px, 0)`;
  },

  /* ----- Dedo (o ratón) sobre la columna ----- */

  down(event) {
    if (!this.visible || this.n < 2) return;
    event.preventDefault();
    this.dragging = true;
    this.pointer = event.pointerId;
    this.sel = -1;
    try { this.el.setPointerCapture(event.pointerId); } catch (error) { /* no crítico */ }
    clearTimeout(this.hideTimer);
    clearTimeout(this.bubbleTimer);
    this.rect = this.el.getBoundingClientRect();
    this.el.classList.add("drag");
    this.pick(event.clientY);
  },

  move(event) {
    if (!this.dragging || event.pointerId !== this.pointer) return;
    event.preventDefault();
    this.pick(event.clientY);
  },

  up(event) {
    if (!this.dragging || (event && event.pointerId !== undefined && event.pointerId !== this.pointer)) return;
    this.dragging = false;
    try { this.el.releasePointerCapture(this.pointer); } catch (error) { /* ya liberado */ }
    // La burbuja se queda un instante y se desvanece; la columna se esconde un poco después
    this.bubbleTimer = setTimeout(() => this.el.classList.remove("drag"), 260);
    this.touch();
  },

  // Letra bajo el dedo → burbuja, círculo y salto en la lista
  pick(y) {
    const relative = (y - this.rect.top) / Math.max(1, this.rect.height);
    const index = Math.max(0, Math.min(this.n - 1, Math.floor(relative * this.n)));
    if (index === this.sel) return;
    const direction = index >= this.sel ? 1 : -1;
    this.sel = index;
    this.setCurrent(index, true);
    this.pop(this.letters[index], direction);
    this.jump(index);
  },

  // La letra de la burbuja entra desde el lado hacia donde te mueves (animación propia, ver .alpha-bubble b.pop)
  pop(letter, direction) {
    const el = this.letterEl;
    el.textContent = letter;
    el.style.setProperty("--dy", (direction * 16) + "px");
    el.classList.remove("pop");
    void el.offsetWidth;   // reinicia la animación aunque cambie de letra muy rápido
    el.classList.add("pop");
  },

  // Lleva la primera canción de esa letra al borde de arriba
  jump(index) {
    const row = this.starts[index];
    if (!row || !row.isConnected) return;
    const y = row.getBoundingClientRect().top + window.scrollY - (this.safeTop() + 14);
    window.scrollTo({ top: Math.max(0, y), behavior: "auto" });
  }
};

/* ---------------------------------------------------------
   LIBRARY TOOLS — punto de entrada
   --------------------------------------------------------- */
const LibraryTools = {
  ICONS: {
    list: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11M4 12h8M4 17h6"/><path d="M19 17.2V8.6l2.4-.7"/><circle cx="17.2" cy="17.4" r="1.9"/></g>',
    person: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M5.2 19.5c.8-3.5 3.3-5.2 6.8-5.2s6 1.7 6.8 5.2z"/></g>',
    clock: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.1 1.9"/></g>',
    up: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19.5v-15M6 10.5l6-6 6 6"/></g>',
    down: '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v15M6 13.5l6 6 6-6"/></g>'
  },

  icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (this.ICONS[name] || "") + "</svg>";
  },

  fail(where, error) {
    console.error("Pulsar RM:", where, error);
    try {
      if (typeof Diagnostics !== "undefined") Diagnostics.log(where, error && error.message ? error.message : String(error), error && error.stack ? String(error.stack).split("\n")[1] : "");
    } catch (ignored) { /* el registro nunca debe fallar */ }
  },

  init() {
    // Cambiar el orden vuelve a dibujar la lista al instante (al cargar los ajustes guardados no hace falta: la app dibuja después)
    Settings.watch(["sortBy", "sortDir"], (value, key, initial) => {
      if (initial) return;
      UI.el.songList.classList.remove("animate");   // sin animación de entrada: el cambio se ve inmediato
      UI.renderLibrary();
    });
    SortMenu.init();
    AlphaIndex.init();
  },

  // Lista ordenada para dibujar. Si el orden fallara, se devuelve la lista tal cual (la biblioteca nunca queda en blanco).
  sorted(songs) {
    try { return LibrarySort.sorted(songs); } catch (error) { this.fail("orden de canciones", error); return songs; }
  },

  // Después de dibujar «Canciones» (list = canciones mostradas) o cualquier otra pestaña (list = null)
  onRender(list) {
    try {
      const button = $("sort-button");
      if (button) {
        button.classList.toggle("hidden", list === null || Library.songs.length < 2);
        const state = LibrarySort.state();
        const text = `Ordenar canciones: ${LibrarySort.label(state.by)}, ${state.dir === "desc" ? "descendente" : "ascendente"}`;
        button.setAttribute("aria-label", text);
        button.title = text;
      }
      AlphaIndex.onRender(list);
    } catch (error) { this.fail("indicador alfabético", error); }
  },

  onRoute(name) {
    SortMenu.close(true);
    AlphaIndex.onRoute(name);
  }
};
