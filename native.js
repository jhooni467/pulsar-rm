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
