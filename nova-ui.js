/* =========================================================
   NOVA INTELLIGENCE — INTERFAZ (etapa 2)
   Etapa 1 dejó listo el contenedor oculto (#nova-root), los avisos y el registro de secciones.
   Etapa 2 dibuja la sección «Nova Intelligence ✨» en Ajustes:
     · nombre, icono y descripción de Nova
     · interruptor principal (apagado por defecto)
     · explicación de qué ocurre al activarlo
     · consentimiento expreso la primera vez (hoja con «Ahora no» / «Acepto y activar»)
     · retirar el permiso cuando la persona quiera
   Todo se guarda con Nova.config (clave propia de localStorage). No hay conexiones a internet:
   la red sigue bloqueada en nova-net.js. Los estilos están en nova.css (prefijo nova-).
   ========================================================= */
"use strict";

(function () {
  if (typeof Nova === "undefined") return;

  const sections = new Map();
  const refreshers = [];
  let consentOpen = false;
  let drawn = false;

  // Marca de Nova: estrella de cuatro puntas con una chispa pequeña (mismo trazo que los iconos de la app)
  const ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M10.5 3.5c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/>' +
    '<path d="M18.5 15.2c.25 1.9 1 2.65 2.9 2.9-1.9.25-2.65 1-2.9 2.9-.25-1.9-1-2.65-2.9-2.9 1.9-.25 2.65-1 2.9-2.9z"/></g></svg>';

  const CONSENT_HTML =
    '<h3>Activar Nova Intelligence ✨</h3>' +
    '<p class="nova-lead">Antes de activarlo, esto es lo que debes saber:</p>' +
    '<ul class="nova-list">' +
    '<li><b>Usará internet.</b> Cuando sus módulos estén disponibles, Nova podrá conectarse a servicios de internet para buscar letras, portadas y datos de tu música.</li>' +
    '<li><b>Comparte lo mínimo.</b> Solo el título, el artista, el álbum y la duración de la canción buscada. Nunca tus archivos de audio ni tu biblioteca completa.</li>' +
    '<li><b>Todavía no se conecta a nada.</b> En esta versión no hay ningún servicio conectado ni se hace ninguna petición a internet.</li>' +
    '<li><b>Tú decides.</b> Puedes apagar Nova o retirar tu permiso cuando quieras. Pulsar RM sigue funcionando sin conexión.</li>' +
    '</ul>' +
    '<small class="set-hint">Al pulsar «Acepto y activar» das tu permiso para que Nova use internet cuando haya servicios disponibles.</small>' +
    '<div class="sheet-actions">' +
    '<button type="button" class="ghost-btn" data-nova-decline>Ahora no</button>' +
    '<button type="button" class="add-music" data-nova-accept>Acepto y activar</button>' +
    '</div>';

  const ui = {
    root: null,

    // Crea (una sola vez) el contenedor oculto de Nova
    mount() {
      if (ui.root || typeof document === "undefined" || !document.body) return ui.root;
      const el = document.createElement("div");
      el.id = "nova-root";
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
      document.body.appendChild(el);
      ui.root = el;
      return el;
    },

    init() {
      ui.mount();
      Nova.safe("interfaz", () => {
        if (!sections.has("ajustes")) ui.addSection({ id: "ajustes", title: "Nova Intelligence ✨", render: renderSettings });
        ui.drawSettings();
        Nova.on("config", () => ui.refresh());
      });
    },

    // Aviso con el mismo estilo que el resto de la app. Si no existe, no hace nada (nunca falla).
    toast(message, sticky) {
      try {
        if (typeof UI !== "undefined" && UI && typeof UI.toast === "function" && UI.el && UI.el.toast) { UI.toast(String(message), Boolean(sticky)); return true; }
      } catch (error) { /* un aviso nunca debe romper nada */ }
      return false;
    },

    // ¿Se cargó nova.css? (el archivo define --nova-ready en :root)
    cssLoaded() {
      try { return getComputedStyle(document.documentElement).getPropertyValue("--nova-ready").trim() === "1"; } catch (error) { return false; }
    },

    // Registra una sección para Ajustes: { id, title, render(container) }. render puede devolver una función que la actualiza.
    addSection(def) {
      if (!def || typeof def.id !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(def.id) || typeof def.title !== "string" || typeof def.render !== "function") {
        Nova.report("interfaz", new Nova.Error("invalid", "Sección inválida: se esperaba { id, title, render }"));
        return false;
      }
      if (sections.has(def.id)) { Nova.report("interfaz", new Nova.Error("duplicate", "La sección «" + def.id + "» ya existe")); return false; }
      sections.set(def.id, { id: def.id, title: def.title, render: def.render });
      return true;
    },

    sections() { return Array.from(sections.values()); },

    // Dibuja las secciones en Ajustes → Nova Intelligence (el hueco #set-nova está en index.html)
    drawSettings() {
      if (drawn || typeof document === "undefined") return drawn;
      const host = document.getElementById("set-nova");
      if (!host) return false;
      host.textContent = "";
      refreshers.length = 0;
      sections.forEach((section) => {
        const refresh = Nova.safe("interfaz " + section.id, () => section.render(host));
        if (typeof refresh === "function") refreshers.push(refresh);
      });
      host.hidden = false;
      const jump = document.querySelector('#settings-nav [data-jump="nova"]');
      if (jump) jump.hidden = false;
      drawn = true;
      ui.refresh();
      return true;
    },

    // Pone al día lo que se ve con lo que dice la configuración
    refresh() {
      refreshers.forEach((fn) => Nova.safe("interfaz", () => fn()));
    },

    // Muestra la explicación de consentimiento. Solo «Acepto y activar» activa Nova; cerrar la hoja o «Ahora no» la deja apagada.
    openConsent() {
      if (consentOpen) return false;
      if (typeof UI === "undefined" || !UI || typeof UI.openSheet !== "function") {
        Nova.report("interfaz", new Nova.Error("no_sheet", "No se pudo mostrar la explicación de Nova"));
        ui.toast("No se pudo mostrar la explicación. Nova sigue apagado.");
        return false;
      }
      consentOpen = true;
      const sheet = UI.openSheet(CONSENT_HTML, () => { consentOpen = false; ui.refresh(); });
      const accept = sheet.el.querySelector("[data-nova-accept]");
      const decline = sheet.el.querySelector("[data-nova-decline]");
      let answered = false;
      if (accept) accept.addEventListener("click", () => {
        if (answered) return;
        answered = true;
        const ok = Nova.config.set("consent", true) && Nova.config.set("enabled", true);
        sheet.close();
        ui.toast(ok ? "Nova activado. Todavía no hay servicios conectados." : "No se pudo activar Nova.");
      });
      if (decline) decline.addEventListener("click", () => {
        if (answered) return;
        answered = true;
        sheet.close();
        ui.toast("Nova sigue apagado.");
      });
      return true;
    }
  };

  /* ---------- Sección «Nova Intelligence ✨» de Ajustes ---------- */

  function renderSettings(host) {
    const wrap = document.createElement("div");
    wrap.innerHTML =
      '<header class="group-head"><span class="group-ico nova-ico">' + ICON + '</span>' +
      '<div><h2 class="nova-title">Nova Intelligence ✨ <span class="nova-badge off" data-nova-badge>Apagado</span></h2>' +
      '<p>Letras, portadas y datos desde internet</p></div></header>' +

      '<div class="card">' +
      '<p>Nova es el asistente inteligente de Pulsar RM. Su función es completar tu música con ayuda de internet: letras, portadas y datos de tus canciones.</p>' +
      '<label class="eq-switch set-row"><span>Activar Nova<small data-nova-state></small></span>' +
      '<input type="checkbox" id="nova-switch" data-nova-switch aria-label="Activar Nova Intelligence">' +
      '<span class="eq-switch-ui" aria-hidden="true"></span></label>' +
      '<small class="set-hint nova-warn" data-nova-save hidden>No se pudieron guardar los ajustes en este dispositivo. Se perderán al cerrar la app.</small>' +
      '</div>' +

      '<div class="card">' +
      '<h3>¿Qué ocurre al activarlo?</h3>' +
      '<ul class="nova-list">' +
      '<li>La primera vez te pediremos tu permiso. Sin tu «sí» expreso, Nova no se activa.</li>' +
      '<li>Cuando sus módulos estén disponibles, Nova podrá usar internet para buscar letras, portadas y datos.</li>' +
      '<li>Solo compartirá el título, el artista, el álbum y la duración de la canción. Nunca tus archivos ni tu biblioteca.</li>' +
      '<li><b>Ahora mismo no hay ningún servicio conectado:</b> Nova no hace ninguna conexión a internet.</li>' +
      '<li>Pulsar RM sigue funcionando igual sin conexión. Puedes apagar Nova cuando quieras.</li>' +
      '</ul>' +
      '<div data-nova-consent hidden>' +
      '<small class="set-hint" data-nova-consent-text></small>' +
      '<div class="set-actions"><button type="button" class="chip-btn muted" data-nova-revoke>Retirar mi permiso</button></div>' +
      '</div>' +
      '</div>';
    while (wrap.firstChild) host.appendChild(wrap.firstChild);

    const q = (selector) => host.querySelector(selector);
    const input = q("[data-nova-switch]");
    const badge = q("[data-nova-badge]");
    const stateText = q("[data-nova-state]");
    const saveHint = q("[data-nova-save]");
    const consentBox = q("[data-nova-consent]");
    const consentText = q("[data-nova-consent-text]");

    function refresh() {
      const on = Nova.config.get("enabled") === true;
      const consent = Nova.config.get("consent") === true;
      input.checked = on;
      badge.textContent = on ? "Activado" : "Apagado";
      badge.classList.toggle("off", !on);
      stateText.textContent = on
        ? "Activado. Aún sin servicios conectados: no se envía ningún dato."
        : consent ? "Apagado. Tu permiso sigue guardado." : "Apagado. No usa internet ni cambia nada.";
      saveHint.hidden = Nova.config.persistent !== false;
      consentBox.hidden = !consent;
      if (consent) {
        const at = Number(Nova.config.get("consentAt"));
        let when = "";
        try { when = at > 0 ? " el " + new Date(at).toLocaleDateString("es") : ""; } catch (error) { when = ""; }
        consentText.textContent = "Permiso para usar internet: concedido" + when + ".";
      }
    }

    input.addEventListener("change", () => {
      if (input.checked) {
        if (Nova.config.get("consent") === true) {
          const ok = Nova.config.set("enabled", true);
          ui.toast(ok ? "Nova activado. Todavía no hay servicios conectados." : "No se pudo activar Nova.");
        } else {
          input.checked = false;      // no se enciende hasta que la persona acepte
          ui.openConsent();
        }
      } else {
        Nova.config.set("enabled", false);
        ui.toast("Nova apagado.");
      }
      refresh();
    });

    q("[data-nova-revoke]").addEventListener("click", () => {
      Nova.config.set("consent", false);      // apaga Nova y borra el permiso
      ui.toast("Permiso retirado. Nova está apagado.");
      refresh();
    });

    return refresh;
  }

  ui.selfTest = async function () {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ? String(detail) : "" });
    check("contenedor #nova-root oculto", Boolean(ui.root) && ui.root.hidden === true);
    check("nova.css cargado", ui.cssLoaded(), "si falla: nova.css no llegó a la app");

    // Etapa 2: la sección de Ajustes
    const host = document.getElementById("set-nova");
    const input = document.getElementById("nova-switch");
    check("ajustes: sección «Nova Intelligence» dibujada", Boolean(host) && host.hidden === false && Boolean(input), "si falla: falta #set-nova en index.html");
    check("ajustes: el interruptor refleja la configuración", Boolean(input) && input.checked === (Nova.config.get("enabled") === true));
    const jump = document.querySelector('#settings-nav [data-jump="nova"]');
    check("ajustes: acceso «Nova» en la barra de categorías", Boolean(jump) && jump.hidden === false);
    check("ajustes: la hoja de consentimiento está disponible", typeof UI !== "undefined" && Boolean(UI) && typeof UI.openSheet === "function");
    return { checks };
  };

  Nova.use("ui", ui);
})();
