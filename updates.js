/* =========================================================
   PULSAR RM — Aviso de nuevas versiones (updates.js)

   Solo DETECTA y AVISA. No descarga ni instala nada por su cuenta: «Descargar ahora» abre la descarga
   en el navegador del sistema y Android hace la instalación (el APK está firmado con la llave fija y se instala encima).

   Fuente de versiones: los Releases del repositorio oficial en GitHub.
     GET https://api.github.com/repos/<dueño>/<repo>/releases/latest
   El workflow «Build APK» crea un Release por cada compilación (etiqueta vX.YY-buildN) y copia en sus notas el bloque de esa
   versión de «Version History» del README. Para avisar de una versión nueva solo hay que publicar su APK.

   Reglas:
   - Compara la versión instalada (resolveAppVersion) con la del último Release: avisa solo si es MAYOR.
   - Comprueba como máximo cada 6 horas y sin bloquear el arranque (a los 4 s de abrir). Sin conexión o con error: no dice nada.
   - «Recordar más tarde» (y también descargar, o cerrar con Atrás) silencia esa versión 24 h. Una versión aún más nueva avisa de inmediato.
   - El aviso nunca interrumpe el reproductor, la letra, la cola, etc.: solo aparece en Inicio o Biblioteca.
   - Ajustes → Acerca de → «Buscar actualizaciones» comprueba a petición (ignora el silencio).
   ========================================================= */

"use strict";

const UpdateCheck = {
  // El workflow cambia este texto por «dueño/repositorio» al compilar el APK (ver build-apk.yml).
  // En la web alojada en GitHub Pages se deduce de la dirección; si no se puede saber, el aviso queda desactivado.
  REPO: "__PULSAR_REPO__",

  INTERVAL: 6 * 3600 * 1000,    // cada cuánto se consulta GitHub como máximo
  SNOOZE: 24 * 3600 * 1000,     // silencio tras «Recordar más tarde»
  TIMEOUT: 9000,

  info: null,       // último Release más nuevo que el instalado (null = la app está al día o aún no se sabe)
  busy: false,
  handle: null,     // diálogo abierto (también está en UI.overlays)

  /* ---------- Repositorio y versiones ---------- */

  repo() {
    if (/^[\w.-]+\/[\w.-]+$/.test(this.REPO)) return this.REPO;
    // https://<dueño>.github.io/<repositorio>/…
    const match = /^([\w-]+)\.github\.io$/i.exec(location.hostname || "");
    const name = (location.pathname.split("/")[1] || "").trim();
    if (match && /^[\w.-]+$/.test(name) && !/\.html?$/i.test(name)) return match[1] + "/" + name;
    return "";
  },

  installed() { return resolveAppVersion(); },

  // «v1.06-build12» → [1, 6, 0]
  parse(text) {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ""));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
  },

  format(parts) {
    return parts[0] + "." + String(parts[1]).padStart(2, "0") + (parts[2] ? "." + parts[2] : "");
  },

  isNewer(candidate, current) {
    const a = this.parse(candidate), b = this.parse(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  },

  // Solo enlaces de GitHub: lo que llegue de internet no puede mandar a otro sitio
  safeUrl(url) { return typeof url === "string" && /^https:\/\/github\.com\//.test(url) ? url : ""; },

  /* ---------- Consulta ---------- */

  async fetchLatest(repo) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => { if (controller) controller.abort(); }, this.TIMEOUT);
    try {
      const response = await fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      if (response.status === 404) return null;           // todavía no hay Releases
      if (!response.ok) throw new Error("GitHub respondió " + response.status);
      const data = await response.json();
      const parts = this.parse(data.tag_name) || this.parse(data.name);
      if (!parts) return null;
      const apk = (Array.isArray(data.assets) ? data.assets : []).find((asset) => /\.apk$/i.test(String(asset && asset.name)));
      return {
        version: this.format(parts),
        notes: String(data.body || "").slice(0, 6000),
        page: this.safeUrl(data.html_url),
        apk: apk ? this.safeUrl(apk.browser_download_url) : ""
      };
    } finally {
      clearTimeout(timer);
    }
  },

  // Devuelve { state: available | current | offline | off | error | busy, info? }
  async check(force) {
    const repo = this.repo();
    if (!repo) return { state: "off" };
    if (this.busy) return { state: "busy" };
    this.busy = true;
    try {
      const cache = Settings.values.updateCache;
      const fresh = !force && cache && typeof cache.at === "number" && cache.at <= Date.now() && Date.now() - cache.at < this.INTERVAL;
      let latest;
      if (fresh) latest = cache.info || null;
      else {
        if (navigator.onLine === false) return { state: "offline" };
        latest = await this.fetchLatest(repo);
        Settings.set("updateCache", { at: Date.now(), info: latest });
      }
      this.info = latest && this.isNewer(latest.version, this.installed()) ? latest : null;
      return this.info ? { state: "available", info: this.info } : { state: "current" };
    } catch (error) {
      console.warn("Pulsar RM: no se pudo comprobar la versión", error);
      return { state: "error" };
    } finally {
      this.busy = false;
    }
  },

  snoozed(info) {
    const snooze = Settings.values.updateSnooze;
    if (!snooze || snooze.v !== info.version || typeof snooze.until !== "number") return false;
    const left = snooze.until - Date.now();
    return left > 0 && left <= this.SNOOZE + 60000;   // un reloj cambiado no puede silenciar el aviso para siempre
  },

  /* ---------- Cuándo avisar ---------- */

  // Al abrir la app (lo llama Features.afterLoad)
  start() {
    setTimeout(async () => {
      const result = await this.check(false);
      if (result.state === "available") this.maybeNotify();
    }, 4000);
  },

  // Al cambiar de pantalla: si había un aviso pendiente (porque estabas en el reproductor, por ejemplo), se muestra al volver
  onRoute() {
    if (this.info) setTimeout(() => this.maybeNotify(), 700);
  },

  maybeNotify() {
    const info = this.info;
    if (!info || this.handle || this.snoozed(info)) return;
    if (Router.current !== "home" && Router.current !== "library") return;   // nunca encima del reproductor, letras, cola…
    if (UI.overlays.length || UI.dismissConfirm) return;
    this.show(info);
  },

  /* ---------- Diálogo (referencia: 2.ª imagen del collage) ---------- */

  // Markdown sencillo de las notas del Release → HTML seguro (todo se escapa antes)
  notesHTML(text) {
    const esc = (value) => UI.escapeHTML(value);
    const inline = (value) => esc(value)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    let list = false;
    const closeList = () => { if (list) { out.push("</ul>"); list = false; } };
    String(text || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").split("\n").forEach((raw) => {
      const line = raw.trim();
      let match;
      if (!line || /^(-{3,}|\*{3,})$/.test(line)) { closeList(); return; }
      if ((match = /^#{1,6}\s+(.*)$/.exec(line))) { closeList(); out.push("<h4>" + inline(match[1]) + "</h4>"); }
      else if ((match = /^(?:[-*•]|\d+\.)\s+(.*)$/.exec(line))) {
        if (!list) { out.push("<ul>"); list = true; }
        out.push("<li>" + inline(match[1]) + "</li>");
      } else { closeList(); out.push("<p>" + inline(line) + "</p>"); }
    });
    closeList();
    return out.join("") || '<p class="upd-none">Esta versión no incluye notas de cambios.</p>';
  },

  show(info) {
    if (this.handle) return;
    const box = document.createElement("div");
    box.className = "upd";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "upd-title");
    box.innerHTML = `
      <div class="upd-backdrop"></div>
      <div class="upd-panel">
        <header class="upd-head">
          <h3 id="upd-title">Actualización de software</h3>
          <p>Pulsar RM ${UI.escapeHTML(info.version)} está disponible para descargar.</p>
        </header>
        <section class="upd-sec upd-news">
          <small class="upd-label">Novedades</small>
          <div class="upd-notes" tabindex="0">${this.notesHTML(info.notes)}</div>
        </section>
        <div class="upd-actions">
          <button type="button" class="upd-go" data-upd="go">Descargar ahora</button>
          <button type="button" class="upd-later" data-upd="later">Recordar más tarde</button>
        </div>
      </div>`;

    // Atrás de Android, Escape o tocar fuera = «Recordar más tarde» (se registra como las demás hojas)
    const handle = { el: box, close: () => this.dismiss("later") };
    this.handle = handle;
    UI.overlays.push(handle);
    document.body.classList.add("no-scroll");
    document.body.appendChild(box);

    box.querySelector(".upd-backdrop").addEventListener("click", () => this.dismiss("later"));
    box.querySelectorAll("[data-upd]").forEach((button) => {
      button.addEventListener("click", () => this.dismiss(button.dataset.upd));
    });
    const primary = box.querySelector(".upd-go");
    if (primary) primary.focus({ preventScroll: true });
  },

  dismiss(action) {
    const handle = this.handle;
    if (!handle) return;
    this.handle = null;
    const index = UI.overlays.indexOf(handle);
    if (index >= 0) UI.overlays.splice(index, 1);
    if (!UI.overlays.length) document.body.classList.remove("no-scroll");

    const info = this.info;
    if (info) {
      // En los dos casos se silencia 24 h: quien descarga ya sabe de la versión y quien pospone pidió que no insista
      Settings.set("updateSnooze", { v: info.version, until: Date.now() + this.SNOOZE });
      if (action === "go") this.openDownload(info);
    }

    if (UI.prefersReducedMotion()) { handle.el.remove(); return; }
    handle.el.classList.add("out");
    setTimeout(() => handle.el.remove(), 230);
  },

  // Abre el APK del Release (o su página) en el navegador del sistema; allí se descarga y Android lo instala
  openDownload(info) {
    const url = info.apk || info.page;
    if (!url) { UI.toast("No se encontró el enlace de descarga."); return; }
    try {
      window.open(url, "_blank");   // en el APK, Capacitor entrega los enlaces externos al navegador del sistema
    } catch (error) {
      const link = document.createElement("a");
      link.href = url; link.target = "_blank"; link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
  },

  /* ---------- Ajustes → Acerca de → «Buscar actualizaciones» ---------- */

  init() {
    document.addEventListener("click", (event) => {
      const button = event.target && event.target.closest && event.target.closest("[data-update-check]");
      if (button) { event.preventDefault(); this.manual(); }
    });
  },

  async manual() {
    const status = $("update-status"), button = $("update-check");
    const say = (text) => { if (status) status.textContent = text; };
    if (this.busy) return;
    if (!this.repo()) { say("Esta copia de la app no tiene repositorio de actualizaciones configurado."); return; }
    if (button) button.disabled = true;
    say("Comprobando…");
    const result = await this.check(true);
    if (button) button.disabled = false;
    if (result.state === "available") {
      say("Hay una versión nueva: " + result.info.version + ".");
      this.show(result.info);
    } else if (result.state === "current") say("Tienes la última versión (" + this.installed() + ").");
    else if (result.state === "offline") say("Sin conexión. Inténtalo de nuevo cuando tengas internet.");
    else say("No se pudo comprobar ahora. Inténtalo más tarde.");
  }
};
