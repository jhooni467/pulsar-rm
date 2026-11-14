/* =========================================================
   NOVA INTELLIGENCE — NÚCLEO (etapa 2 · versión 0.2.0)
   Es el único archivo de Nova que define el objeto global `Nova`. Aquí viven:
     · errores propios (Nova.Error) y aislamiento: nada de lo que falle en Nova llega al reproductor
     · eventos (Nova.on / Nova.emit)
     · configuración independiente (Nova.config, guardada aparte en localStorage)
     · registro de proveedores (Nova.registerProvider) y de módulos (Nova.registerModule)
     · arranque (Nova.init), llamado desde Features.init (features.js)
   Los demás archivos se enganchan con Nova.use(nombre, pieza):
     nova-store.js (almacenamiento propio) · nova-net.js (red) · nova-ui.js (interfaz discreta)
   Etapa 1: estructura base. Etapa 2: configuración y consentimiento (interruptor en Ajustes, persistencia).
   Siguen sin existir búsquedas, proveedores reales ni conexiones a internet (la red está bloqueada en nova-net.js).
   Documentación completa: NOVA_INTELLIGENCE.md
   ========================================================= */
"use strict";

const Nova = (function () {
  const VERSION = "0.2.0";
  const STAGE = 2;
  const NAME = "Nova Intelligence";
  // Lo que Nova sabe hacer (un módulo pide una capacidad y un proveedor la ofrece). Se amplía aquí.
  const CAPABILITIES = ["lyrics", "cover", "metadata", "artist", "library"];
  // Piezas que se esperan (si un archivo no carga, Nova sigue funcionando sin esa pieza)
  const EXPECTED_PARTS = ["store", "net", "ui"];

  const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
  const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
  // Nombres de cabecera que parecen secretos: un proveedor no puede llevarlos escritos en su definición
  const SECRET_HEADER_RE = /authorization|api[-_]?key|secret|token|password|cookie/i;
  const AUTH_TYPES = ["none", "public-id", "user-key"];
  const TRANSPORTS = ["auto", "fetch", "native"];

  /* ---------- Errores ---------- */

  class NovaError extends Error {
    constructor(code, message, details) {
      super(message || code);
      this.name = "NovaError";
      this.code = code;
      this.details = details || null;
    }
  }

  const errorLog = [];   // últimos errores de Nova (en memoria)

  // Anota el error (y lo envía al Diagnóstico de Ajustes → Acerca de). Nunca lanza.
  function record(scope, error) {
    try {
      const message = String(error && error.message ? error.message : error).slice(0, 220);
      errorLog.push({ t: Date.now(), scope: String(scope), code: (error && error.code) || "error", message });
      if (errorLog.length > 30) errorLog.shift();
      if (typeof Diagnostics !== "undefined" && Diagnostics && typeof Diagnostics.log === "function") {
        Diagnostics.log("nova " + scope, message);
      }
    } catch (ignored) { /* el registro de errores jamás debe fallar */ }
  }

  function report(scope, error) {
    record(scope, error);
    emit("error", { scope: String(scope), code: (error && error.code) || "error", message: String(error && error.message ? error.message : error) });
  }

  // Ejecuta algo de Nova aislado: si lanza (o la promesa falla) se anota y se devuelve `fallback`
  function safe(scope, work, fallback) {
    try {
      const result = work();
      if (result && typeof result.then === "function") {
        return result.then((value) => value, (error) => { report(scope, error); return fallback; });
      }
      return result;
    } catch (error) {
      report(scope, error);
      return fallback;
    }
  }

  /* ---------- Eventos ---------- */

  const listeners = {};

  function on(type, handler) {
    if (typeof handler !== "function") return function () {};
    (listeners[type] = listeners[type] || []).push(handler);
    return function off() { listeners[type] = (listeners[type] || []).filter((fn) => fn !== handler); };
  }

  function emit(type, data) {
    (listeners[type] || []).slice().forEach((handler) => {
      try { handler(data); } catch (error) { record("evento " + type, error); }   // sin emitir otra vez: evita bucles
    });
  }

  /* ---------- Utilidades ---------- */

  function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

  /* ---------- Configuración independiente ----------
     No toca Settings ni IndexedDB de Pulsar RM: vive en su propia clave de localStorage.
     Todo empieza APAGADO: Nova no hace nada hasta que la persona lo active y acepte (consent). */

  // options.requireConsent (etapa 2): la configuración REAL lo activa. Nova no puede quedar encendido sin consentimiento,
  // ni al pedirlo ni al cargar lo guardado. Las configuraciones de prueba no lo usan para poder simular estados raros.
  function createConfig(storageKey, onChange, options) {
    const strict = Boolean(options && options.requireConsent);
    const state = { v: 1, enabled: false, consent: false, consentAt: 0, wifiOnly: true, cacheDays: 30, modules: {}, providers: {} };
    const BOOLEANS = ["enabled", "consent", "wifiOnly"];
    let persistent = true;

    // Una entrada de módulo/proveedor solo admite valores simples y cortos (nunca objetos ni funciones)
    function cleanEntry(entry) {
      const out = {};
      if (!isObject(entry)) return out;
      Object.keys(entry).slice(0, 12).forEach((key) => {
        const value = entry[key];
        const simple = typeof value === "boolean" || (typeof value === "number" && isFinite(value)) || (typeof value === "string" && value.length <= 200);
        if (/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key) && simple) out[key] = value;
      });
      return out;
    }

    function cleanMap(map) {
      const out = {};
      if (!isObject(map)) return out;
      Object.keys(map).slice(0, 64).forEach((id) => { if (ID_RE.test(id)) out[id] = cleanEntry(map[id]); });
      return out;
    }

    function apply(saved) {
      if (!isObject(saved)) return;
      BOOLEANS.forEach((key) => { if (typeof saved[key] === "boolean") state[key] = saved[key]; });
      if (typeof saved.cacheDays === "number" && isFinite(saved.cacheDays)) state.cacheDays = clamp(Math.round(saved.cacheDays), 1, 365);
      if (typeof saved.consentAt === "number" && isFinite(saved.consentAt) && saved.consentAt >= 0) state.consentAt = Math.round(saved.consentAt);
      state.modules = cleanMap(saved.modules);
      state.providers = cleanMap(saved.providers);
      // Regla de la etapa 2: Nova nunca queda encendido sin el consentimiento expreso (ni aunque el dato guardado lo diga)
      if (!state.consent) { if (strict) state.enabled = false; state.consentAt = 0; }
    }

    const api = {
      key: storageKey,

      load() {
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) apply(JSON.parse(raw));
        } catch (error) { persistent = false; }   // sin almacenamiento: se usan los valores en memoria
        return api;
      },

      save() {
        try {
          localStorage.setItem(storageKey, JSON.stringify(state));
          persistent = true;
        } catch (error) { persistent = false; }
        return persistent;
      },

      get(key) { return state[key]; },

      set(key, value) {
        let accepted = false;
        // Etapa 2: encender Nova exige el consentimiento ya aceptado; nunca se activa solo
        if (strict && key === "enabled" && value === true && state.consent !== true) return false;
        if (BOOLEANS.indexOf(key) >= 0 && typeof value === "boolean") {
          if (key === "consent" && value === true && state.consent !== true) state.consentAt = Date.now();   // cuándo aceptó
          state[key] = value; accepted = true;
          // Retirar el consentimiento apaga Nova al instante
          if (key === "consent" && value === false) { state.enabled = false; state.consentAt = 0; }
        }
        else if (key === "cacheDays" && typeof value === "number" && isFinite(value)) { state.cacheDays = clamp(Math.round(value), 1, 365); accepted = true; }
        if (!accepted) return false;
        api.save();
        if (onChange) onChange({ key, value: state[key] });
        return true;
      },

      // ¿Puede Nova usar internet? Solo con el interruptor general Y el consentimiento de la persona.
      canUseNetwork() { return state.enabled === true && state.consent === true; },

      entry(kind, id) { return Object.assign({}, (state[kind] && state[kind][id]) || {}); },

      setEntry(kind, id, patch) {
        if ((kind !== "modules" && kind !== "providers") || !ID_RE.test(String(id))) return false;
        state[kind][id] = Object.assign({}, state[kind][id] || {}, cleanEntry(patch));
        api.save();
        if (onChange) onChange({ key: kind + "." + id, value: api.entry(kind, id) });
        return true;
      },

      moduleEnabled(id) { return api.entry("modules", id).enabled === true; },
      providerEnabled(id) { return api.entry("providers", id).enabled === true; },
      // Un módulo está activo solo si Nova está encendido y el módulo también
      moduleActive(id) { return state.enabled === true && api.moduleEnabled(id); },

      reset() {
        state.enabled = false; state.consent = false; state.consentAt = 0; state.wifiOnly = true; state.cacheDays = 30;
        state.modules = {}; state.providers = {};
        api.save();
        if (onChange) onChange({ key: "*", value: null });
      },

      // Comprueba que lo que hay en memoria coincide con lo que quedó guardado de verdad (se vuelve a leer el almacenamiento).
      // status: "saved" (guardado y coincide) · "default" (aún no se guardó nada y todo está en sus valores por defecto)
      //         "mismatch" (no coincide: no se está guardando bien) · "unavailable" (no hay almacenamiento en este dispositivo)
      verify() {
        let raw = null;
        try { raw = localStorage.getItem(storageKey); } catch (error) { return { ok: false, status: "unavailable", detail: "sin almacenamiento" }; }
        if (raw === null) {
          const untouched = state.enabled === false && state.consent === false && state.wifiOnly === true && state.cacheDays === 30;
          return untouched ? { ok: true, status: "default", detail: "nada guardado aún (valores por defecto)" } : { ok: false, status: "mismatch", detail: "hay cambios sin guardar" };
        }
        let saved;
        try { saved = JSON.parse(raw); } catch (error) { return { ok: false, status: "mismatch", detail: "lo guardado está dañado" }; }
        const same = isObject(saved) && ["enabled", "consent", "consentAt", "wifiOnly", "cacheDays"].every((key) => (saved[key] === undefined && key === "consentAt" ? 0 : saved[key]) === state[key]);   // lo guardado en la etapa 1 no traía consentAt
        return same ? { ok: true, status: "saved", detail: "guardado y verificado" } : { ok: false, status: "mismatch", detail: "lo guardado no coincide" };
      },

      snapshot() { return JSON.parse(JSON.stringify(state)); },
      get persistent() { return persistent; }
    };
    return api;
  }

  const config = createConfig("pulsar-nova-config", (change) => emit("config", change), { requireConsent: true }).load();

  /* ---------- Registros (módulos y proveedores) ---------- */

  function needText(value, label, max) {
    if (typeof value !== "string" || !value.trim() || value.length > (max || 80)) throw new NovaError("invalid", label + " no es válido");
    return value.trim();
  }

  function needId(value, label) {
    if (typeof value !== "string" || !ID_RE.test(value)) throw new NovaError("invalid", label + ": id inválido (minúsculas, números y guiones; 2 a 32 caracteres)");
    return value;
  }

  // Proveedor = quien sabe una o varias cosas (letras, portadas…) y de dónde (hosts). No guarda secretos.
  function validateProvider(def) {
    if (!isObject(def)) throw new NovaError("invalid", "Proveedor: se esperaba un objeto");
    const id = needId(def.id, "Proveedor");
    const name = needText(def.name, "Proveedor «" + id + "»: nombre");

    if (!isObject(def.handlers)) throw new NovaError("invalid", "Proveedor «" + id + "»: falta handlers");
    const handlers = {};
    Object.keys(def.handlers).forEach((capability) => {
      if (CAPABILITIES.indexOf(capability) < 0) throw new NovaError("invalid", "Proveedor «" + id + "»: capacidad desconocida «" + capability + "»");
      const handler = def.handlers[capability];
      if (!isObject(handler) || typeof handler.find !== "function") throw new NovaError("invalid", "Proveedor «" + id + "»: handlers." + capability + ".find debe ser una función");
      handlers[capability] = handler;
    });
    if (!Object.keys(handlers).length) throw new NovaError("invalid", "Proveedor «" + id + "»: sin ninguna capacidad");

    // hosts: solo nombres de dominio (sin https://, sin rutas). Vacío = proveedor local, sin red.
    const hosts = [];
    (Array.isArray(def.hosts) ? def.hosts : []).forEach((host) => {
      const clean = String(host).toLowerCase();
      if (!HOST_RE.test(clean)) throw new NovaError("invalid", "Proveedor «" + id + "»: host inválido «" + host + "»");
      if (hosts.indexOf(clean) < 0) hosts.push(clean);
    });

    // auth: nunca se escribe una clave aquí. "public-id" = identificador público; "user-key" = clave que pone la persona.
    const auth = { type: "none", header: "" };
    if (def.auth !== undefined) {
      if (!isObject(def.auth) || AUTH_TYPES.indexOf(def.auth.type) < 0) throw new NovaError("invalid", "Proveedor «" + id + "»: auth.type inválido");
      auth.type = def.auth.type;
      if (auth.type !== "none") {
        if (typeof def.auth.header !== "string" || !/^[A-Za-z][A-Za-z0-9-]{1,40}$/.test(def.auth.header)) throw new NovaError("invalid", "Proveedor «" + id + "»: auth.header inválido");
        auth.header = def.auth.header;
      }
    }

    // headers fijos (por ejemplo, el nombre de la app). Los que parecen secretos se rechazan.
    const headers = {};
    if (def.headers !== undefined) {
      if (!isObject(def.headers)) throw new NovaError("invalid", "Proveedor «" + id + "»: headers debe ser un objeto");
      Object.keys(def.headers).forEach((header) => {
        if (SECRET_HEADER_RE.test(header)) throw new NovaError("secret", "Proveedor «" + id + "»: la cabecera «" + header + "» parece una clave. Las claves no van en el código: usa auth.");
        if (!/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(header) || typeof def.headers[header] !== "string" || def.headers[header].length > 200) throw new NovaError("invalid", "Proveedor «" + id + "»: cabecera «" + header + "» inválida");
        headers[header] = def.headers[header];
      });
    }

    const limit = isObject(def.rateLimit) ? def.rateLimit : {};
    const rateLimit = {
      minIntervalMs: clamp(typeof limit.minIntervalMs === "number" ? limit.minIntervalMs : 400, 0, 60000),   // pausa entre peticiones al mismo proveedor
      maxRetries: clamp(typeof limit.maxRetries === "number" ? Math.round(limit.maxRetries) : 2, 0, 3)
    };

    const transport = def.transport === undefined ? "auto" : def.transport;
    if (TRANSPORTS.indexOf(transport) < 0) throw new NovaError("invalid", "Proveedor «" + id + "»: transport inválido");

    return Object.freeze({
      id, name,
      version: typeof def.version === "string" ? def.version.slice(0, 20) : "",
      homepage: typeof def.homepage === "string" ? def.homepage.slice(0, 200) : "",
      handlers: Object.freeze(handlers),
      capabilities: Object.freeze(Object.keys(handlers)),
      hosts: Object.freeze(hosts),
      auth: Object.freeze(auth),
      headers: Object.freeze(headers),
      rateLimit: Object.freeze(rateLimit),
      transport,
      priority: typeof def.priority === "number" && isFinite(def.priority) ? def.priority : 50   // menor número = se consulta antes
    });
  }

  // Módulo = una función de Nova (Lyrics Intelligence, Cover Intelligence…). Pide UNA capacidad.
  function validateModule(def) {
    if (!isObject(def)) throw new NovaError("invalid", "Módulo: se esperaba un objeto");
    const id = needId(def.id, "Módulo");
    const name = needText(def.name, "Módulo «" + id + "»: nombre");
    if (CAPABILITIES.indexOf(def.capability) < 0) throw new NovaError("invalid", "Módulo «" + id + "»: capability debe ser una de " + CAPABILITIES.join(", "));
    if (typeof def.run !== "function") throw new NovaError("invalid", "Módulo «" + id + "»: run debe ser una función");
    ["init", "stop"].forEach((hook) => {
      if (def[hook] !== undefined && typeof def[hook] !== "function") throw new NovaError("invalid", "Módulo «" + id + "»: " + hook + " debe ser una función");
    });
    return Object.freeze({
      id, name,
      version: typeof def.version === "string" ? def.version.slice(0, 20) : "",
      capability: def.capability,
      run: def.run,
      init: def.init || null,
      stop: def.stop || null
    });
  }

  // `quiet`: no anota los rechazos como errores (lo usan los autotest, que provocan rechazos a propósito)
  function createRegistry(kind, validate, notify, quiet) {
    const items = new Map();
    return {
      kind,
      // Devuelve true/false; nunca lanza (un módulo mal escrito no debe romper nada)
      register(def) {
        try {
          const clean = validate(def);
          if (items.has(clean.id)) throw new NovaError("duplicate", kind + " «" + clean.id + "» ya está registrado");
          items.set(clean.id, clean);
          if (notify) notify(clean);
          return true;
        } catch (error) {
          if (!quiet) report("registro de " + kind, error);
          return false;
        }
      },
      get(id) { return items.get(id) || null; },
      has(id) { return items.has(id); },
      list() { return Array.from(items.values()); },
      ids() { return Array.from(items.keys()); }
    };
  }

  const providers = createRegistry("proveedor", validateProvider, (p) => emit("provider:registered", { id: p.id }));
  const modules = createRegistry("módulo", validateModule, (m) => { emit("module:registered", { id: m.id }); if (state === "ready") syncModules(); });

  // Proveedores ACTIVADOS que ofrecen una capacidad, del más prioritario al menos
  function providersFor(capability) {
    return providers.list()
      .filter((p) => p.handlers[capability] && config.providerEnabled(p.id))
      .sort((a, b) => a.priority - b.priority);
  }

  /* ---------- Ciclo de vida de módulos ---------- */

  const started = new Set();

  // Inicia los módulos que están activos y detiene los que dejaron de estarlo
  function syncModules() {
    modules.list().forEach((mod) => {
      const wanted = config.moduleActive(mod.id);
      if (wanted && !started.has(mod.id)) {
        started.add(mod.id);
        if (mod.init) safe("módulo " + mod.id, () => mod.init(api));
      } else if (!wanted && started.has(mod.id)) {
        started.delete(mod.id);
        if (mod.stop) safe("módulo " + mod.id, () => mod.stop());
      }
    });
  }

  on("config", () => { if (state === "ready") syncModules(); });

  // Ejecuta un módulo sobre una canción. Siempre devuelve una promesa; un fallo se anota y llega como NovaError.
  function runModule(id, song, options) {
    const mod = modules.get(id);
    if (!mod) return Promise.reject(new NovaError("module_unknown", "Módulo desconocido: " + id));
    if (!config.moduleActive(id)) return Promise.reject(new NovaError("module_disabled", "El módulo «" + id + "» está desactivado"));
    return new Promise((resolve) => resolve(mod.run(song, { nova: api, options: options || {} }))).catch((error) => {
      report("módulo " + id, error);
      throw error instanceof NovaError ? error : new NovaError("module_failed", "El módulo «" + id + "» falló: " + (error && error.message ? error.message : error));
    });
  }

  // Lo único que se le enviaría a un proveedor sobre una canción (sirve también para mostrarlo a la persona)
  function describeSong(song) {
    if (!song) return null;
    // Textos que Pulsar RM pone cuando falta el dato: no son datos reales y no se envían
    const PLACEHOLDERS = ["archivo local", "artista desconocido", "<unknown>", "unknown"];
    const text = (value) => {
      const clean = typeof value === "string" ? value.trim().slice(0, 200) : "";
      return PLACEHOLDERS.indexOf(clean.toLowerCase()) >= 0 ? "" : clean;
    };
    const duration = Number(song.duration);
    return { title: text(song.name || song.title), artist: text(song.artist), album: text(song.album), duration: isFinite(duration) && duration > 0 ? Math.round(duration) : 0 };
  }

  /* ---------- Piezas (store, net, ui…) ---------- */

  const parts = {};

  function use(name, part) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9]{1,15}$/.test(name) || Object.prototype.hasOwnProperty.call(api, name) || !isObject(part)) {
      report("pieza", new NovaError("invalid", "Pieza inválida o reservada: " + name));
      return false;
    }
    if (parts[name]) { report("pieza", new NovaError("duplicate", "La pieza «" + name + "» ya está cargada")); return false; }
    parts[name] = part;
    api[name] = part;
    if (state === "ready" && typeof part.init === "function") safe("pieza " + name, () => part.init());
    return true;
  }

  /* ---------- Arranque ---------- */

  let state = "idle";   // idle | starting | ready

  function debugOn() {
    try {
      return /(?:^|[?&])nova=1(?:&|$)/.test(location.search || "") || localStorage.getItem("pulsar-nova-debug") === "1";
    } catch (error) { return false; }
  }

  // Lo llama Features.init (features.js). Solo prepara: no lee la biblioteca, no abre bases de datos, no usa la red.
  function init() {
    if (state !== "idle") return state === "ready";
    state = "starting";
    Object.keys(parts).forEach((name) => {
      if (typeof parts[name].init === "function") safe("pieza " + name, () => parts[name].init());
    });
    state = "ready";
    syncModules();
    emit("ready", status());
    if (debugOn()) safe("autotest", runDebug);
    return true;
  }

  // Lo llama Features.afterLoad (la biblioteca ya está cargada)
  function afterLoad() {
    if (state !== "ready") return;
    let count = 0;
    try { count = typeof Library !== "undefined" && Library.songs ? Library.songs.length : 0; } catch (error) { count = 0; }
    emit("library", { count });
  }

  function status() {
    return {
      name: NAME, version: VERSION, stage: STAGE, state,
      enabled: config.get("enabled"), consent: config.get("consent"), consentAt: config.get("consentAt"),
      saved: config.verify().status,
      parts: Object.keys(parts),
      missing: EXPECTED_PARTS.filter((name) => !parts[name]),
      modules: modules.ids(), providers: providers.ids(),
      netLocked: parts.net && typeof parts.net.isLocked === "function" ? parts.net.isLocked() : null,
      errors: errorLog.length
    };
  }

  /* ---------- Autotest (no deja rastro: usa registros y almacenes de prueba) ---------- */

  async function selfTest() {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ? String(detail) : "" });
    const throws = (fn) => { try { fn(); return false; } catch (error) { return true; } };

    // Proveedores y módulos (validación)
    const goodProvider = { id: "prueba", name: "Prueba", hosts: ["api.ejemplo.com"], handlers: { lyrics: { find() { return []; } } } };
    check("proveedor válido", !throws(() => validateProvider(goodProvider)));
    check("proveedor sin handlers se rechaza", throws(() => validateProvider({ id: "prueba", name: "P" })));
    check("host con ruta se rechaza", throws(() => validateProvider(Object.assign({}, goodProvider, { hosts: ["https://api.ejemplo.com/x"] }))));
    check("clave en cabecera se rechaza", throws(() => validateProvider(Object.assign({}, goodProvider, { headers: { "X-Api-Key": "abc" } }))));
    check("módulo válido", !throws(() => validateModule({ id: "letras", name: "L", capability: "lyrics", run() {} })));
    check("módulo con capacidad desconocida se rechaza", throws(() => validateModule({ id: "letras", name: "L", capability: "otra", run() {} })));

    // Registro (instancia aparte, sin tocar los reales)
    const probe = createRegistry("módulo", validateModule, null, true);
    const first = probe.register({ id: "uno", name: "Uno", capability: "cover", run() {} });
    const second = probe.register({ id: "uno", name: "Uno", capability: "cover", run() {} });
    check("registro: alta y duplicado", first === true && second === false && probe.ids().length === 1);

    // Configuración (instancia aparte)
    const testKey = "pulsar-nova-config-autotest";
    const probeConfig = createConfig(testKey);
    check("config: todo apagado por defecto", probeConfig.get("enabled") === false && probeConfig.get("consent") === false && probeConfig.canUseNetwork() === false);
    probeConfig.set("enabled", true);
    probeConfig.setEntry("modules", "letras", { enabled: true });
    const reload = createConfig(testKey).load();
    check("config: se guarda y se recarga", reload.get("enabled") === true && reload.moduleActive("letras") === true);
    check("config: valores inválidos se ignoran", probeConfig.set("enabled", "sí") === false && probeConfig.set("otraClave", true) === false);
    try { localStorage.removeItem(testKey); } catch (error) { /* nada */ }

    // Etapa 2: consentimiento y persistencia (configuración estricta, igual que la real; clave de prueba aparte)
    const consentKey = "pulsar-nova-config-autotest-consent";
    const wipe = () => { try { localStorage.removeItem(consentKey); } catch (error) { /* nada */ } };
    const strictConfig = () => createConfig(consentKey, null, { requireConsent: true });
    wipe();
    const cfg = strictConfig().load();
    check("config: no se enciende sin consentimiento", cfg.set("enabled", true) === false && cfg.get("enabled") === false && cfg.canUseNetwork() === false);
    cfg.set("consent", true);
    check("config: con consentimiento sí se enciende", cfg.set("enabled", true) === true && cfg.get("enabled") === true);
    const verified = cfg.verify();
    check("config: lo guardado coincide con lo que hay en memoria", verified.ok === true && verified.status === "saved", verified.detail);
    const again = strictConfig().load();
    check("config: se conserva al volver a abrir (activado, consentimiento y fecha)", again.get("enabled") === true && again.get("consent") === true && again.get("consentAt") > 0 && again.get("consentAt") === cfg.get("consentAt"));
    cfg.set("consent", false);
    check("config: retirar el consentimiento apaga Nova", cfg.get("enabled") === false && cfg.get("consent") === false && cfg.get("consentAt") === 0 && cfg.canUseNetwork() === false);
    try { localStorage.setItem(consentKey, JSON.stringify({ v: 1, enabled: true, consent: false })); } catch (error) { /* nada */ }
    const tampered = strictConfig().load();
    check("config: «encendido» sin consentimiento guardado se corrige al cargar", tampered.get("enabled") === false && tampered.canUseNetwork() === false);
    try { localStorage.setItem(consentKey, JSON.stringify({ v: 1, enabled: true, consent: true, consentAt: 5, wifiOnly: true, cacheDays: 7 })); } catch (error) { /* nada */ }
    const diverged = strictConfig().load();
    diverged.set("cacheDays", 20);
    try { localStorage.setItem(consentKey, JSON.stringify({ v: 1, enabled: false })); } catch (error) { /* nada */ }
    check("config: detecta cuando lo guardado no coincide", diverged.verify().ok === false);
    wipe();
    check("config: sin nada guardado y con valores por defecto, verify lo indica", strictConfig().verify().status === "default");
    wipe();
    check("config real: nunca encendida sin consentimiento", config.get("enabled") === false || config.get("consent") === true);

    const described = describeSong({ name: " Tema ", artist: "Archivo local", album: "", duration: 183.6 });
    check("describeSong: ignora textos de relleno", described.title === "Tema" && described.artist === "" && described.duration === 184);

    // Piezas
    EXPECTED_PARTS.forEach((name) => check("pieza «" + name + "» cargada", Boolean(parts[name])));
    for (const name of Object.keys(parts)) {
      if (typeof parts[name].selfTest === "function") {
        try {
          const result = await parts[name].selfTest();
          (result && result.checks ? result.checks : []).forEach((item) => check(name + ": " + item.name, item.ok, item.detail));
        } catch (error) { check(name + ": autotest", false, error && error.message); }
      }
    }

    const failed = checks.filter((item) => !item.ok);
    return { ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length, total: checks.length, checks };
  }

  // Con ?nova=1 (o pulsar-nova-debug = 1): el resultado queda en Ajustes → Acerca de → Diagnóstico
  async function runDebug() {
    const info = status();
    const result = await selfTest();
    const bad = result.checks.filter((item) => !item.ok).map((item) => item.name + (item.detail ? " (" + item.detail + ")" : ""));
    const saved = config.verify();
    const SAVED_TEXT = { saved: "guardados OK", default: "sin cambios guardados (valores por defecto)", mismatch: "NO SE GUARDAN BIEN (" + saved.detail + ")", unavailable: "SIN ALMACENAMIENTO" };
    const line = NAME + " " + VERSION + " (etapa " + STAGE + ") · autotest " + result.passed + "/" + result.total +
      (bad.length ? " · FALLÓ: " + bad.join("; ") : " OK") +
      " · red " + (info.netLocked === false ? "ACTIVA" : "bloqueada") + " · Nova " + (info.enabled ? "encendido" : "apagado") +
      " · consentimiento " + (info.consent ? "aceptado" : "no") + " · ajustes " + (SAVED_TEXT[saved.status] || saved.status);
    if (typeof Diagnostics !== "undefined" && Diagnostics && typeof Diagnostics.log === "function") Diagnostics.log("nova", line);
    else console.info(line);
    return result;
  }

  /* ---------- API pública ---------- */

  const api = {
    NAME, VERSION, STAGE, CAPABILITIES,
    Error: NovaError,
    config, modules, providers,
    createConfig, createRegistry,          // fábricas (las usan las piezas y los autotest)
    validate: { provider: validateProvider, module: validateModule },
    registerProvider: (def) => providers.register(def),
    registerModule: (def) => modules.register(def),
    providersFor,
    runModule,
    describeSong,
    use, init, afterLoad, status, selfTest,
    on, emit, safe, report,
    errors() { return errorLog.slice(); },
    get state() { return state; }
  };

  return api;
})();
