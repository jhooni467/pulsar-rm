/* =========================================================
   NATIVE (v1.04) — puente con la app Android (PulsarNative)
   Todo lo que necesita Android pasa por aquí: notificación y controles multimedia, foco de
   audio, carpetas autorizadas, lectura de archivos, frecuencia de la pantalla…
   En el navegador (o con un APK antiguo) las funciones nativas no existen: Native.has()
   lo comprueba y la app sigue funcionando sin ellas.
   Android responde llamando a window.PulsarBridge.onNative(tipo, json).
   Contrato completo: docs/NATIVE_API.md
   ========================================================= */
"use strict";


/* =========================================================
   DIAGNÓSTICO (v1.04.1)
   Guarda los últimos errores de la app (aunque ocurran al arrancar) para verlos en Ajustes → Acerca de.
   ========================================================= */
const Diagnostics = {
  KEY: "pulsar-diag",
  items: [],

  load() {
    try { this.items = JSON.parse(localStorage.getItem(this.KEY) || "[]").slice(-25); } catch (error) { this.items = []; }
  },

  log(kind, message, where) {
    const text = String(message || "").slice(0, 300);
    const last = this.items[this.items.length - 1];
    if (last && last.m === text && last.k === kind) { last.n = (last.n || 1) + 1; }
    else this.items.push({ t: Date.now(), k: kind, m: text, w: String(where || "").slice(0, 120) });
    this.items = this.items.slice(-25);
    try { localStorage.setItem(this.KEY, JSON.stringify(this.items)); } catch (error) { /* sin espacio: no crítico */ }
    this.render();
  },

  text() {
    const info = (typeof Native !== "undefined" && Native.info && Native.info()) || {};
    const head = `Pulsar RM · Android API ${info.sdk || "—"} · ${navigator.userAgent}`;
    if (!this.items.length) return head + "\nSin errores registrados.";
    return head + "\n" + this.items.map((e) => `${new Date(e.t).toLocaleTimeString("es")} [${e.k}] ${e.m}${e.n > 1 ? " ×" + e.n : ""}${e.w ? " @ " + e.w : ""}`).join("\n");
  },

  render() {
    const box = document.getElementById("diag-log");
    if (box) box.textContent = this.text();
  },

  clear() { this.items = []; try { localStorage.removeItem(this.KEY); } catch (error) { /* nada */ } this.render(); },

  async copy() {
    try { await navigator.clipboard.writeText(this.text()); return true; } catch (error) { return false; }
  }
};
Diagnostics.load();
window.addEventListener("error", (event) => {
  const where = event.filename ? event.filename.split("/").pop() + ":" + event.lineno : "";
  Diagnostics.log("error", event.message || (event.error && event.error.message), where);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  Diagnostics.log("promesa", reason && reason.message ? reason.message : reason);
});

const Native = {
  listeners: {},
  _info: undefined,

  bridge() { return window.PulsarNative || null; },

  has(name) {
    const bridge = this.bridge();
    return Boolean(bridge && typeof bridge[name] === "function");
  },

  // true solo con el APK de la v1.04 en adelante (los APK anteriores no traen getInfo)
  get available() { return this.has("getInfo"); },

  // true si la web corre dentro de una app Android (WebView) pero SIN el puente v1.04:
  // es un APK antiguo o un paquete de PWABuilder. Sirve para avisar en vez de decir "versión web".
  get oldShell() { return !this.available && /;\s*wv\)/.test(navigator.userAgent || ""); },

  call(name, ...args) {
    try {
      if (this.has(name)) return window.PulsarNative[name](...args);
    } catch (error) { console.warn("Puente nativo:", name, error); }
    return undefined;
  },

  json(name, ...args) {
    const raw = this.call(name, ...args);
    if (typeof raw !== "string" || !raw) return null;
    try { return JSON.parse(raw); } catch (error) { return null; }
  },

  // { api, sdk, notifications, display… } o null si no hay app nativa
  info(refresh) {
    if (this._info === undefined || refresh) this._info = this.available ? this.json("getInfo") : null;
    return this._info;
  },

  /* ---------- Direcciones de archivos (las sirve Android desde el mismo origen de la app) ---------- */

  b64url(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = "";
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },

  // Canción de una carpeta autorizada. Android la entrega con soporte de "Range" (buscar dentro de la canción).
  audioUrl(uri) {
    return this.available && uri ? `${location.origin}/_pulsar_media/${this.b64url(uri)}` : "";
  },

  // Carátula incrustada que Android guardó al leer la biblioteca
  coverUrl(file) {
    return this.available && file ? `${location.origin}/_pulsar_cover/${encodeURIComponent(file)}` : "";
  },

  /* ---------- Avisos que llegan desde Android ---------- */

  on(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
    return () => { this.listeners[type] = (this.listeners[type] || []).filter((fn) => fn !== handler); };
  },

  emit(type, data) {
    (this.listeners[type] || []).slice().forEach((handler) => {
      try { handler(data); } catch (error) { console.error("Aviso nativo:", type, error); }
    });
  }
};

window.PulsarBridge = {
  // Lo llama Android con evaluateJavascript: onNative("action", '{"name":"next"}')
  onNative(type, payload) {
    let data = payload;
    if (typeof payload === "string") {
      try { data = JSON.parse(payload); } catch (error) { data = payload; }
    }
    Native.emit(String(type), data);
  }
};
