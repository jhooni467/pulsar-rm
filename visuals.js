/* =========================================================
   PULSAR RM v1.06 — Animated Covers y Canvas (contenido visual compartido)

   Un solo sistema para los dos reproductores (Pulsar RM e Inmersive): ellos ponen la interfaz, esto guarda y reproduce el contenido.
     · ANIMATED COVER: video corto o imagen animada que sustituye a la portada de una canción. Se agrega tocando la portada.
     · CANVAS: video vertical en bucle asociado a una canción (como Spotify Canvas). Se gestiona desde el menú ⋯ del reproductor:
       Agregar · Activar · Desactivar · Cambiar. Desactivar NO borra el archivo.
   Todo queda guardado por canción en el almacenamiento de la app (IndexedDB), igual que el resto de la biblioteca:
     setting «visualIndex»  → { [idCanción]: { a: datos Animated Cover, c: datos Canvas, on: Canvas activo } }
     setting «visual:a:<id>» / «visual:c:<id>» → el archivo (Blob)
   El audio NO se toca: los videos van siempre en silencio (muted) para no pedir foco de audio ni cortar la música, y solo se
   reproducen mientras la música suena y la pantalla del reproductor está a la vista (se liberan al salir).
   ========================================================= */
const Visuals = {
  MAX_BYTES: 120 * 1024 * 1024,
  ACCEPT: "video/mp4,video/webm,video/quicktime,video/*,image/gif,image/webp,image/apng,image/avif,.mp4,.m4v,.mov,.webm,.gif,.webp,.apng,.avif",
  EXT: { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", gif: "image/gif", webp: "image/webp", apng: "image/apng", png: "image/png", avif: "image/avif" },
  ready: false,
  index: {},
  urls: new Map(),
  mounted: {},
  listeners: [],
  syncToken: 0,

  /* ---------- Arranque ---------- */

  async init() {
    if (this.ready) return;
    try {
      const saved = await Store.getSetting("visualIndex");
      this.index = saved && typeof saved === "object" ? saved : {};
    } catch (error) { this.index = {}; }
    this.ready = true;

    // El reproductor actualiza su portada / estado: aquí se actualiza el contenido visual (sin tocar el código original)
    this.wrap(UI, "refreshNowPlayingInfo", () => this.sync());
    this.wrap(UI, "resetNowPlaying", () => this.sync());
    this.wrap(UI, "updatePlayState", () => this.syncPlayback());
    this.wrap(UI, "toggleMenu", () => this.renderMenus());
    // Al quitar canciones de la biblioteca se borran también sus archivos visuales
    ["removeSong", "removeSongs"].forEach((name) => {
      const original = Store[name];
      if (typeof original !== "function") return;
      Store[name] = (...args) => {
        const result = original.apply(Store, args);
        const ids = Array.isArray(args[0]) ? args[0] : [args[0]];
        Promise.resolve(result).then(() => this.purge(ids), () => {});
        return result;
      };
    });
    const clear = Store.clearAll;
    if (typeof clear === "function") {
      Store.clearAll = (...args) => {
        const result = clear.apply(Store, args);
        Promise.resolve(result).then(() => this.purge(Object.keys(this.index)), () => {});
        return result;
      };
    }
    document.addEventListener("visibilitychange", () => this.syncPlayback());
    this.bindCovers();
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-vs]");
      if (button) this.handle(button.dataset.vs);
    });
    this.sync();
  },

  wrap(target, name, after) {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
      const result = original.apply(this, args);
      try { after(...args); } catch (error) { console.warn("Visuals:", name, error); }
      return result;
    };
  },

  on(listener) { this.listeners.push(listener); },
  emit() { this.listeners.forEach((fn) => { try { fn(); } catch (error) { console.warn("Visuals:", error); } }); },

  /* ---------- Datos ---------- */

  currentSong() { return Player.currentId !== null ? Library.byId(Player.currentId) : null; },
  entry(id) { return id === null || id === undefined ? null : this.index[id] || null; },
  hasCover(id) { const e = this.entry(id); return Boolean(e && e.a); },
  hasCanvas(id) { const e = this.entry(id); return Boolean(e && e.c); },
  canvasOn(id) { const e = this.entry(id); return Boolean(e && e.c && e.on); },
  key(kind, id) { return "visual:" + kind + ":" + id; },
  save() { return Store.setSetting("visualIndex", this.index); },

  async urlOf(kind, id) {
    const cacheKey = kind + ":" + id;
    if (this.urls.has(cacheKey)) return this.urls.get(cacheKey);
    const blob = await Store.getSetting(this.key(kind, id));
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    this.urls.set(cacheKey, url);
    return url;
  },

  dropUrl(kind, id) {
    const cacheKey = kind + ":" + id;
    const url = this.urls.get(cacheKey);
    if (url) { URL.revokeObjectURL(url); this.urls.delete(cacheKey); }
  },

  // Libera los archivos de canciones que ya no son la actual (cada video se carga solo cuando hace falta)
  trimUrls(keepId) {
    for (const cacheKey of [...this.urls.keys()]) {
      if (cacheKey.split(":")[1] !== String(keepId)) { URL.revokeObjectURL(this.urls.get(cacheKey)); this.urls.delete(cacheKey); }
    }
  },

  /* ---------- Importar ---------- */

  typeOf(file) {
    const ext = String(file.name || "").split(".").pop().toLowerCase();
    if (/^(video\/|image\/(gif|webp|apng|png|avif))/.test(file.type || "")) return file.type;
    return this.EXT[ext] || "";
  },

  // Comprueba que el dispositivo puede mostrar el archivo y mide su tamaño en pantalla
  probe(file) {
    const type = this.typeOf(file);
    if (!type) return Promise.reject(new Error("formato"));
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      let timer = 0;
      const done = (fn, value) => { clearTimeout(timer); URL.revokeObjectURL(url); fn(value); };
      timer = setTimeout(() => done(reject, new Error("tiempo")), 12000);
      if (type.startsWith("video/")) {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.onloadeddata = () => (video.videoWidth ? done(resolve, { type, w: video.videoWidth, h: video.videoHeight, d: video.duration || 0 }) : done(reject, new Error("sin imagen")));
        video.onerror = () => done(reject, new Error("no reproducible"));
        video.src = url;
      } else {
        const image = new Image();
        image.onload = () => done(resolve, { type, w: image.naturalWidth, h: image.naturalHeight, d: 0 });
        image.onerror = () => done(reject, new Error("no reproducible"));
        image.src = url;
      }
    });
  },

  // Abre el selector de archivos del dispositivo. Devuelve el archivo o null si se cancela.
  pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = this.ACCEPT;
      input.style.display = "none";
      const finish = (file) => { input.remove(); resolve(file); };
      input.addEventListener("change", () => finish((input.files && input.files[0]) || null));
      input.addEventListener("cancel", () => finish(null));
      document.body.appendChild(input);
      input.click();
    });
  },

  async add(kind, id, file, activate) {
    if (file.size > this.MAX_BYTES) throw new Error("grande");
    const info = await this.probe(file);
    await Store.setSetting(this.key(kind, id), new Blob([file], { type: info.type }));
    const entry = this.index[id] || (this.index[id] = {});
    entry[kind] = { name: file.name || "archivo", type: info.type, size: file.size, w: info.w, h: info.h, d: info.d, t: Date.now() };
    if (kind === "c" && activate) entry.on = true;
    this.dropUrl(kind, id);
    await this.save();
    this.sync();
    this.emit();
  },

  async remove(kind, id) {
    const entry = this.index[id];
    if (!entry) return;
    await Store.setSetting(this.key(kind, id), null);
    delete entry[kind];
    if (kind === "c") delete entry.on;
    if (!entry.a && !entry.c) delete this.index[id];
    this.dropUrl(kind, id);
    await this.save();
    this.sync();
    this.emit();
  },

  async purge(ids) {
    let changed = false;
    for (const raw of ids) {
      const id = String(raw);
      if (!this.index[id]) continue;
      for (const kind of ["a", "c"]) { this.dropUrl(kind, id); try { await Store.setSetting(this.key(kind, id), null); } catch (error) { /* nada */ } }
      delete this.index[id];
      changed = true;
    }
    if (changed) { await this.save(); this.sync(); this.emit(); }
  },

  async setCanvasActive(id, on) {
    const entry = this.index[id];
    if (!entry || !entry.c) return;
    entry.on = Boolean(on);
    await this.save();
    this.sync();
    this.emit();
  },

  // Elegir archivo → comprobarlo → guardarlo. kind: «a» Animated Cover · «c» Canvas
  async importFor(kind, activate) {
    const song = this.currentSong();
    if (!song) { UI.toast("Reproduce una canción primero."); return false; }
    const file = await this.pickFile();
    if (!file) return false;
    UI.toast(kind === "c" ? "Preparando Canvas…" : "Preparando Animated Cover…", true);
    try {
      await this.add(kind, song.id, file, activate);
      UI.toast(kind === "c" ? (activate ? "Canvas agregado y activado" : "Canvas actualizado") : "Animated Cover agregado");
      return true;
    } catch (error) {
      const why = error && error.message;
      Diagnostics.log("visual", String(why));
      UI.toast(why === "grande" ? "El archivo es demasiado grande (máximo 120 MB)." : "No se pudo usar ese archivo. Prueba con MP4 (H.264), WebM, GIF o WebP animado.");
      return false;
    }
  },

  /* ---------- Acciones de los menús ---------- */

  async handle(action) {
    if (typeof UI.closeMenu === "function") UI.closeMenu();
    if (typeof PlayerStyle !== "undefined" && PlayerStyle.ready) PlayerStyle.closeMenu();
    const song = this.currentSong();
    if (!song) { UI.toast("Reproduce una canción primero."); return; }
    switch (action) {
      case "cover": this.openCoverSheet(); break;
      case "canvas-add": await this.importFor("c", true); break;
      case "canvas-change": await this.importFor("c", false); break;
      case "canvas-on": await this.setCanvasActive(song.id, true); UI.toast("Canvas activado"); break;
      case "canvas-off": await this.setCanvasActive(song.id, false); UI.toast("Canvas desactivado"); break;
      default: break;
    }
  },

  icon(name) {
    const paths = {
      film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M8 4.5v15M16 4.5v15M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5"/>',
      off: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M4 20L20 4"/>',
      swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
      image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><circle cx="9" cy="10" r="1.7"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>'
    };
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + "</g></svg>";
  },

  // Las opciones de Canvas y Animated Cover se agregan al menú ⋯ de cada reproductor, con su propio aspecto
  renderMenus() {
    const song = this.currentSong();
    const entry = song ? this.entry(song.id) : null;
    const items = [];
    if (song) {
      if (!(entry && entry.c)) items.push(["canvas-add", "film", "Agregar Canvas"]);
      else {
        items.push(entry.on ? ["canvas-off", "off", "Desactivar Canvas"] : ["canvas-on", "film", "Activar Canvas"]);
        items.push(["canvas-change", "swap", "Cambiar Canvas"]);
      }
      items.push(["cover", "image", entry && entry.a ? "Cambiar Animated Cover" : "Agregar Animated Cover"]);
    }
    ["player-menu", "im-menu"].forEach((id) => {
      const menu = document.getElementById(id);
      if (!menu) return;
      const old = menu.querySelector(".vs-menu-items");
      if (old) old.remove();
      if (!items.length) return;
      const box = document.createElement("div");
      box.className = "vs-menu-items";
      box.setAttribute("role", "none");
      box.innerHTML = '<hr class="vs-sep">' + items.map(([action, icon, label]) => `<button type="button" role="menuitem" data-vs="${action}">${this.icon(icon)}<span>${label}</span></button>`).join("");
      menu.appendChild(box);
    });
  },

  /* ---------- «Agregar Animated Cover» ---------- */

  bindCovers() {
    ["big-cover", "im-cover"].forEach((id) => {
      const cover = document.getElementById(id);
      if (!cover) return;
      cover.setAttribute("role", "button");
      cover.tabIndex = 0;
      cover.setAttribute("aria-label", "Portada. Toca para agregar un Animated Cover");
      cover.addEventListener("click", () => this.openCoverSheet());
      cover.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openCoverSheet(); } });
    });
  },

  async openCoverSheet() {
    const song = this.currentSong();
    if (!song) { UI.toast("Reproduce una canción para agregar un Animated Cover."); return; }
    const has = this.hasCover(song.id);
    const still = Covers.get(song);
    const sheet = UI.openSheet(`
      <div class="sheet-head"><h3>${has ? "Animated Cover" : "Agregar Animated Cover"}</h3><button type="button" class="icon-btn" data-sheet-close aria-label="Cerrar">${Icons.close}</button></div>
      <div class="vs-sheet">
        <div class="vs-sheet-preview${still ? "" : " empty"}">${still ? `<img alt="" src="${still}">` : Icons.art}<span class="vs-sheet-media"></span></div>
        <p class="vs-sheet-text"><strong>${UI.escapeHTML(song.name || "Sin título")}</strong><br>Elige un video corto o una imagen animada: sustituirá su portada mientras suena y se repetirá en bucle. Formatos: MP4, WebM, GIF o WebP animado. Se ve mejor en formato cuadrado.</p>
        <button type="button" class="chip-btn" data-vs-choose>${has ? "Cambiar archivo" : "Elegir archivo"}</button>
        ${has ? '<button type="button" class="chip-btn muted" data-vs-remove>Quitar Animated Cover</button>' : ""}
      </div>`);
    const media = sheet.el.querySelector(".vs-sheet-media");
    if (has) this.urlOf("a", song.id).then((url) => { if (url && media.isConnected) media.appendChild(this.makeMedia(this.entry(song.id).a, url, true)); });
    sheet.el.addEventListener("click", async (event) => {
      if (event.target.closest("[data-sheet-close]")) { sheet.close(); return; }
      if (event.target.closest("[data-vs-choose]")) { if (await this.importFor("a", false)) sheet.close(); return; }
      if (event.target.closest("[data-vs-remove]")) { await this.remove("a", song.id); UI.toast("Animated Cover quitado"); sheet.close(); }
    });
  },

  /* ---------- Mostrar el contenido en cada reproductor ---------- */

  makeMedia(meta, url, plain) {
    let media;
    if (meta && String(meta.type).startsWith("video/")) {
      media = document.createElement("video");
      media.muted = true;           // siempre en silencio: no pide foco de audio ni interrumpe la música
      media.defaultMuted = true;
      media.loop = true;
      media.playsInline = true;
      media.autoplay = true;
      media.preload = "auto";
      media.disablePictureInPicture = true;
      media.setAttribute("disableremoteplayback", "");
      media.setAttribute("muted", "");
    } else {
      media = document.createElement("img");
      media.alt = "";
      media.decoding = "async";
      media.draggable = false;
    }
    media.className = "vs-media";
    media.tabIndex = -1;
    media.setAttribute("aria-hidden", "true");
    media.src = url;
    if (plain && media.tagName === "VIDEO") { media.play().catch(() => {}); }
    return media;
  },

  // Qué se muestra y dónde, según la canción, el diseño elegido y la pantalla actual
  plan() {
    const song = this.currentSong();
    const entry = song ? this.entry(song.id) : null;
    const onPlayer = Router.current === "player";
    const inmersive = typeof PlayerStyle !== "undefined" && PlayerStyle.ready && PlayerStyle.active;
    const canvas = Boolean(entry && entry.c && entry.on);
    return {
      id: song ? song.id : null,
      entry,
      canvas,
      targets: {
        pCover: { host: document.getElementById("big-cover"), kind: "a", show: Boolean(entry && entry.a) && onPlayer && !inmersive },
        iCover: { host: document.getElementById("im-cover"), kind: "a", show: Boolean(entry && entry.a) && onPlayer && inmersive },
        pCanvas: { host: document.getElementById("vs-p-canvas"), kind: "c", show: canvas && onPlayer && !inmersive },
        iCanvas: { host: document.querySelector("#vs-canvas-layer .vs-canvas-media"), kind: "c", show: canvas && onPlayer && inmersive }
      }
    };
  },

  async sync() {
    if (!this.ready) return;
    const token = ++this.syncToken;
    await Promise.resolve(); // deja que el reproductor termine de dibujar su portada primero
    if (token !== this.syncToken) return;
    const plan = this.plan();
    const root = document.documentElement;
    root.classList.toggle("vs-canvas", plan.canvas);
    const stage = document.getElementById("stage");
    if (stage) stage.dataset.vsCanvas = plan.canvas ? "on" : "off";
    document.querySelectorAll("#big-cover, #im-cover").forEach((cover) => cover.classList.toggle("has-anim", false));
    if (plan.id !== null) this.trimUrls(plan.id);
    for (const name of Object.keys(plan.targets)) await this.mount(name, plan.targets[name], plan, token);
    if (token !== this.syncToken) return;
    this.syncPlayback();
    this.renderMenus();
    this.emit();
  },

  unmount(name) {
    const old = this.mounted[name];
    if (!old) return;
    delete this.mounted[name];
    old.layer.classList.remove("on");
    setTimeout(() => old.layer.remove(), 650);
  },

  async mount(name, target, plan, token) {
    const current = this.mounted[name];
    const meta = plan.entry && plan.entry[target.kind];
    if (!target.host || !target.show || !meta) { if (current) this.unmount(name); return; }
    const key = target.kind + ":" + plan.id + ":" + meta.t;
    if (current && current.key === key && current.layer.isConnected && target.host.contains(current.layer)) {
      if (target.kind === "a") target.host.classList.add("has-anim");
      return;
    }
    const url = await this.urlOf(target.kind, plan.id);
    if (token !== this.syncToken) return;
    if (!url) { if (current) this.unmount(name); return; }
    if (current) this.unmount(name);
    const layer = document.createElement("div");
    layer.className = "vs-layer" + (target.kind === "a" ? " vs-anim" : "");
    const media = this.makeMedia(meta, url);
    layer.appendChild(media);
    target.host.appendChild(layer);
    if (target.kind === "a") target.host.classList.add("has-anim");
    this.mounted[name] = { key, layer, media };
    // aparece con un fundido cuando ya hay imagen (sin parpadeos ni cuadros vacíos)
    const show = () => layer.classList.add("on");
    if (media.tagName === "VIDEO") { media.addEventListener("loadeddata", show, { once: true }); setTimeout(show, 1500); } else if (media.complete) show(); else media.addEventListener("load", show, { once: true });
  },

  // Los videos solo corren mientras suena la música y el reproductor está a la vista (ahorra batería y CPU)
  syncPlayback() {
    const playing = Player.currentId !== null && !Player.audio.paused && !document.hidden && Router.current === "player";
    Object.values(this.mounted).forEach(({ media }) => {
      if (media.tagName !== "VIDEO") return;
      if (playing) { if (media.paused) media.play().catch(() => {}); } else if (!media.paused) media.pause();
    });
  },

  onRoute() { if (this.ready) this.sync(); }
};
