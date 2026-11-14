/* =========================================================
   NOVA INTELLIGENCE — RED (etapa 1: PREPARADA Y BLOQUEADA)
   Será el ÚNICO punto por donde Nova hable con internet. Ya trae las reglas de seguridad:
     · solo https y solo hacia los dominios que el proveedor declaró (hosts)
     · nada sale si Nova está apagado o la persona no dio su consentimiento
     · solo peticiones GET, sin cookies ni credenciales, sin referer
     · una petición a la vez por proveedor, con pausa mínima entre ellas
     · tiempo límite, respuesta máxima de 2 MB, y respeto a «Retry-After» (429/503) con variación aleatoria
     · las claves nunca viajan en el código: se leen de la configuración de la persona (auth)
     · el «transporte» es intercambiable: hoy `fetch` del navegador; más adelante, el puente nativo de Android
   BLOQUEO DE LA ETAPA 1: LOCKED = true. Mientras sea true, request() rechaza SIEMPRE con net_locked
   y no llama a ningún transporte. Se desbloquea en una etapa posterior, con autorización.
   ========================================================= */
"use strict";

(function () {
  if (typeof Nova === "undefined") return;

  const LOCKED = true;                   // ← etapa 1: ninguna petición sale de la app
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_WAIT_MS = 20000;             // si el servidor pide esperar más, no se espera: se avisa
  const SECRET_HEADER_RE = /authorization|api[-_]?key|secret|token|password|cookie/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /* ---------- Transportes ---------- */

  // Transporte por defecto: fetch del navegador. Sin credenciales, sin referer, sin caché del navegador.
  const fetchTransport = {
    id: "fetch",
    available() { return typeof fetch === "function"; },
    async send(req) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = setTimeout(() => { if (controller) controller.abort(); }, req.timeoutMs);
      if (req.signal && controller) {
        if (req.signal.aborted) controller.abort();
        else req.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      try {
        const response = await fetch(req.url, {
          method: "GET",
          headers: req.headers,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "follow",
          signal: controller ? controller.signal : undefined
        });
        const declared = Number(response.headers.get("content-length"));
        if (isFinite(declared) && declared > MAX_BYTES) throw new Nova.Error("too_large", "La respuesta es demasiado grande");
        const text = await response.text();
        if (text.length > MAX_BYTES) throw new Nova.Error("too_large", "La respuesta es demasiado grande");
        return {
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          retryAfter: response.headers.get("retry-after") || "",
          text
        };
      } catch (error) {
        if (error instanceof Nova.Error) throw error;
        if (error && error.name === "AbortError") throw new Nova.Error("timeout", "El servidor tardó demasiado en responder");
        throw new Nova.Error("network", "No se pudo conectar");
      } finally {
        clearTimeout(timer);
      }
    }
  };

  /* ---------- Fábrica (la usan la red real y el autotest) ---------- */

  function createNet(options) {
    const locked = options.locked !== false;
    const registry = options.providers;
    const config = options.config;
    const transports = new Map();
    const lanes = new Map();   // una cola por proveedor
    (options.transports || []).forEach((t) => transports.set(t.id, t));

    // Cola por proveedor: una petición a la vez y con pausa mínima entre ellas
    function schedule(provider, job) {
      const lane = lanes.get(provider.id) || { tail: Promise.resolve(), last: 0 };
      lanes.set(provider.id, lane);
      const run = lane.tail.then(async () => {
        const wait = lane.last + provider.rateLimit.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        try { return await job(); } finally { lane.last = Date.now(); }
      });
      lane.tail = run.catch(() => {});
      return run;
    }

    function pickTransport(provider) {
      const wanted = provider.transport;
      if (wanted !== "auto" && transports.has(wanted) && transports.get(wanted).available()) return transports.get(wanted);
      if (wanted === "auto") {
        // Preferencia: el nativo (si existe y está disponible) y, si no, fetch
        const native = transports.get("native");
        if (native && native.available()) return native;
        const web = transports.get("fetch");
        if (web && web.available()) return web;
      }
      throw new Nova.Error("no_transport", "No hay un método de conexión disponible");
    }

    // Todas las razones por las que NO se puede salir a internet
    function check(providerId) {
      if (locked) return { ok: false, code: "net_locked", reason: "La red de Nova está bloqueada en esta etapa" };
      if (!config.get("enabled")) return { ok: false, code: "net_disabled", reason: "Nova Intelligence está apagado" };
      if (!config.get("consent")) return { ok: false, code: "no_consent", reason: "Falta el consentimiento de la persona" };
      const provider = registry.get(providerId);
      if (!provider) return { ok: false, code: "provider_unknown", reason: "Proveedor desconocido: " + providerId };
      if (!config.providerEnabled(provider.id)) return { ok: false, code: "provider_disabled", reason: "El proveedor «" + provider.id + "» está desactivado" };
      if (!provider.hosts.length) return { ok: false, code: "provider_local", reason: "El proveedor «" + provider.id + "» es local (no usa red)" };
      if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, code: "offline", reason: "Sin conexión" };
      if (config.get("wifiOnly") && typeof navigator !== "undefined" && navigator.connection && (navigator.connection.type === "cellular" || navigator.connection.saveData === true)) {
        return { ok: false, code: "metered", reason: "Solo se usa Wi‑Fi (ajuste de Nova) y ahora hay datos móviles" };
      }
      return { ok: true, code: "ok", reason: "" };
    }

    // Construye la dirección: siempre https, siempre un dominio declarado por el proveedor
    function buildUrl(provider, spec) {
      const host = String(spec.host || provider.hosts[0] || "").toLowerCase();
      if (provider.hosts.indexOf(host) < 0) throw new Nova.Error("host_not_allowed", "El dominio «" + host + "» no está declarado por el proveedor");
      const path = String(spec.path || "/");
      if (path.charAt(0) !== "/" || path.charAt(1) === "/" || /[\s\\@]/.test(path)) throw new Nova.Error("bad_path", "Ruta no válida");
      const url = new URL("https://" + host + path);
      if (url.protocol !== "https:" || url.hostname !== host) throw new Nova.Error("host_not_allowed", "Dirección no permitida");
      const query = spec.query || {};
      Object.keys(query).forEach((key) => {
        if (query[key] !== undefined && query[key] !== null) url.searchParams.set(key, String(query[key]));
      });
      return url.toString();
    }

    // Cabeceras: las fijas del proveedor + (si aplica) su identificador/clave, que sale de la configuración de la persona
    function buildHeaders(provider, spec) {
      const headers = Object.assign({ Accept: "application/json" }, provider.headers);
      Object.keys(spec.headers || {}).forEach((name) => {
        if (SECRET_HEADER_RE.test(name)) throw new Nova.Error("secret", "No se permiten claves en las cabeceras de una petición");
        headers[name] = String(spec.headers[name]);
      });
      if (provider.auth.type !== "none") {
        const entry = config.entry("providers", provider.id);
        const value = provider.auth.type === "public-id" ? entry.appId : entry.userKey;
        if (typeof value === "string" && value) headers[provider.auth.header] = value;
        else if (provider.auth.type === "user-key") throw new Nova.Error("missing_key", "Falta la clave del proveedor «" + provider.id + "»");
      }
      return headers;
    }

    function retryDelay(retryAfter) {
      const seconds = Number(retryAfter);
      const base = isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
      return { base, wait: Math.round(base + Math.random() * base * 0.3) };   // variación de hasta 30 %
    }

    function interpret(res, provider, spec) {
      if (res.status === 404) throw new Nova.Error("not_found", "No encontrado", { status: 404 });
      if (res.status === 401 || res.status === 403) throw new Nova.Error("unauthorized", "El proveedor rechazó la identificación", { status: res.status });
      if (res.status === 400) throw new Nova.Error("bad_request", "El proveedor no aceptó la consulta", { status: 400 });
      if (res.status >= 500) throw new Nova.Error("server", "Error del servidor del proveedor", { status: res.status });
      if (res.status < 200 || res.status > 299) throw new Nova.Error("http_" + res.status, "Respuesta inesperada (" + res.status + ")", { status: res.status });
      if ((spec.parse || "json") === "text") return { status: res.status, data: res.text };
      if (!/json/i.test(res.contentType)) throw new Nova.Error("bad_response", "La respuesta no es JSON");
      try { return { status: res.status, data: JSON.parse(res.text) }; } catch (error) { throw new Nova.Error("bad_response", "JSON no válido"); }
    }

    async function attempt(provider, req, spec) {
      const transport = pickTransport(provider);
      let retries = 0;
      for (;;) {
        const res = await transport.send(req);
        if (res.status === 429 || res.status === 503) {
          const delay = retryDelay(res.retryAfter);
          if (retries >= provider.rateLimit.maxRetries || delay.base > MAX_WAIT_MS) {
            throw new Nova.Error(res.status === 429 ? "rate_limited" : "busy", res.status === 429 ? "Demasiadas peticiones: espera un momento" : "El servidor está ocupado", { retryAfterMs: delay.base });
          }
          retries++;
          await sleep(delay.wait);
          continue;
        }
        return interpret(res, provider, spec);
      }
    }

    return {
      isLocked() { return locked; },
      // ¿Podría Nova usar internet ahora mismo? (no desbloqueada, encendida y con consentimiento)
      available() { return !locked && config.canUseNetwork(); },
      check,
      buildUrl, buildHeaders,
      registerTransport(transport) { if (transport && transport.id && typeof transport.send === "function") transports.set(transport.id, transport); },
      transports() { return Array.from(transports.keys()); },

      // request("lrclib", { path: "/api/get", query: {...}, timeoutMs, signal, parse })
      async request(providerId, spec) {
        const verdict = check(providerId);
        if (!verdict.ok) throw new Nova.Error(verdict.code, verdict.reason);
        const provider = registry.get(providerId);
        const opts = spec || {};
        if (opts.method && String(opts.method).toUpperCase() !== "GET") throw new Nova.Error("method_not_allowed", "Solo se permiten peticiones GET");
        const req = {
          url: buildUrl(provider, opts),
          headers: buildHeaders(provider, opts),
          timeoutMs: clamp(Number(opts.timeoutMs) || 10000, 1000, 30000),
          signal: opts.signal || null
        };
        return schedule(provider, () => attempt(provider, req, opts));
      }
    };
  }

  /* ---------- Red real (bloqueada) ---------- */

  const net = createNet({ locked: LOCKED, providers: Nova.providers, config: Nova.config, transports: [fetchTransport] });
  net.create = createNet;

  // Autotest: una red de PRUEBA con transporte falso. Verifica las reglas sin salir nunca a internet.
  net.selfTest = async function () {
    const checks = [];
    const ok = (name, value, detail) => checks.push({ name, ok: Boolean(value), detail: detail ? String(detail) : "" });
    const code = async (promise) => { try { await promise; return "ok"; } catch (error) { return error && error.code ? error.code : "error"; } };

    // 1) La red REAL está bloqueada y no llama a ningún transporte
    let realCalls = 0;
    const spy = { id: "fetch", available: () => true, send: async () => { realCalls++; return { status: 200, contentType: "application/json", retryAfter: "", text: "{}" }; } };
    const locked = createNet({ locked: true, providers: Nova.providers, config: Nova.config, transports: [spy] });
    ok("red real: bloqueada", net.isLocked() === LOCKED && LOCKED === true);
    ok("red bloqueada: rechaza con net_locked", (await code(locked.request("cualquiera", { path: "/" }))) === "net_locked" && realCalls === 0);

    // 2) Reglas con una red de prueba desbloqueada y un transporte falso
    const registry = Nova.createRegistry("proveedor", Nova.validate.provider);
    registry.register({ id: "prueba", name: "Prueba", hosts: ["api.ejemplo.com"], headers: { "X-Cliente": "Pulsar RM" }, rateLimit: { minIntervalMs: 0, maxRetries: 1 }, handlers: { lyrics: { find() { return []; } } } });
    const probeConfig = Nova.createConfig("pulsar-nova-config-autotest-net");
    let calls = 0;
    let script = [];
    const fake = {
      id: "fetch", available: () => true,
      send: async (req) => { calls++; fake.last = req; return script.shift() || { status: 200, contentType: "application/json", retryAfter: "", text: "[]" }; }
    };
    const probe = createNet({ locked: false, providers: registry, config: probeConfig, transports: [fake] });

    ok("apagado: net_disabled", (await code(probe.request("prueba", { path: "/x" }))) === "net_disabled");
    probeConfig.set("enabled", true);
    ok("sin consentimiento: no_consent", (await code(probe.request("prueba", { path: "/x" }))) === "no_consent");
    probeConfig.set("consent", true);
    ok("proveedor desactivado: provider_disabled", (await code(probe.request("prueba", { path: "/x" }))) === "provider_disabled");
    ok("nada salió en los casos anteriores", calls === 0);

    probeConfig.setEntry("providers", "prueba", { enabled: true });
    script = [{ status: 200, contentType: "application/json; charset=utf-8", retryAfter: "", text: "[{\"id\":1}]" }];
    let result = null;
    try { result = await probe.request("prueba", { path: "/api/search", query: { q: "a b", vacio: null } }); } catch (error) { result = null; }
    ok("petición válida: datos y 1 sola llamada", result && Array.isArray(result.data) && calls === 1);
    ok("dirección https y con el host declarado", fake.last && fake.last.url === "https://api.ejemplo.com/api/search?q=a+b");
    ok("cabecera fija del proveedor", fake.last && fake.last.headers["X-Cliente"] === "Pulsar RM");
    ok("host no declarado se rechaza", (await code(probe.request("prueba", { host: "malo.com", path: "/" }))) === "host_not_allowed");
    ok("ruta con // o @ se rechaza", (await code(probe.request("prueba", { path: "//malo.com/x" }))) === "bad_path" && (await code(probe.request("prueba", { path: "/a@b" }))) === "bad_path");
    ok("POST se rechaza", (await code(probe.request("prueba", { path: "/x", method: "POST" }))) === "method_not_allowed");
    ok("clave en cabecera de petición se rechaza", (await code(probe.request("prueba", { path: "/x", headers: { "X-Api-Key": "z" } }))) === "secret");

    calls = 0;
    script = [
      { status: 429, contentType: "application/json", retryAfter: "0", text: "{}" },
      { status: 200, contentType: "application/json", retryAfter: "", text: "{\"ok\":true}" }
    ];
    result = null;
    try { result = await probe.request("prueba", { path: "/x" }); } catch (error) { result = null; }
    ok("429 con Retry-After: reintenta y responde", result && result.data && result.data.ok === true && calls === 2);

    calls = 0;
    script = [
      { status: 429, contentType: "application/json", retryAfter: "0", text: "{}" },
      { status: 429, contentType: "application/json", retryAfter: "0", text: "{}" }
    ];
    ok("429 repetido: rate_limited (no insiste)", (await code(probe.request("prueba", { path: "/x" }))) === "rate_limited" && calls === 2);
    script = [{ status: 404, contentType: "application/json", retryAfter: "", text: "{}" }];
    ok("404: not_found", (await code(probe.request("prueba", { path: "/x" }))) === "not_found");
    script = [{ status: 200, contentType: "text/html", retryAfter: "", text: "<html>" }];
    ok("respuesta no JSON: bad_response", (await code(probe.request("prueba", { path: "/x" }))) === "bad_response");

    try { localStorage.removeItem("pulsar-nova-config-autotest-net"); } catch (error) { /* nada */ }
    return { checks };
  };

  Nova.use("net", net);
})();
