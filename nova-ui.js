/* =========================================================
   NOVA INTELLIGENCE — INTERFAZ DISCRETA (etapa 1)
   Por ahora NO dibuja nada visible ni crea pantallas. Solo deja listo lo que vendrá después:
     · un contenedor oculto (#nova-root) donde irán las hojas y avisos de Nova
     · toast(): reutiliza el aviso de la app (UI.toast) para que Nova hable con el mismo estilo
     · addSection(): registro de secciones de Ajustes. En una etapa posterior se dibujarán en
       Ajustes → «Nova Intelligence». Hoy solo se guardan.
   Los estilos están en nova.css (todo con prefijo nova-). No se toca style.css.
   ========================================================= */
"use strict";

(function () {
  if (typeof Nova === "undefined") return;

  const sections = new Map();

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

    init() { ui.mount(); },

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

    // Registra una sección para Ajustes: { id, title, render(container) }. Se dibujará en una etapa posterior.
    addSection(def) {
      if (!def || typeof def.id !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(def.id) || typeof def.title !== "string" || typeof def.render !== "function") {
        Nova.report("interfaz", new Nova.Error("invalid", "Sección inválida: se esperaba { id, title, render }"));
        return false;
      }
      if (sections.has(def.id)) { Nova.report("interfaz", new Nova.Error("duplicate", "La sección «" + def.id + "» ya existe")); return false; }
      sections.set(def.id, { id: def.id, title: def.title, render: def.render });
      return true;
    },

    sections() { return Array.from(sections.values()); }
  };

  ui.selfTest = async function () {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ? String(detail) : "" });
    check("contenedor #nova-root oculto", Boolean(ui.root) && ui.root.hidden === true);
    check("nova.css cargado", ui.cssLoaded(), "si falla: nova.css no llegó a la app");
    return { checks };
  };

  Nova.use("ui", ui);
})();
