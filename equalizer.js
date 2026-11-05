/*
 * PULSAR RM — Ecualizador de 6 bandas
 * Integración para Pulsar RM 0.4b.
 * Se carga después de script.js desde index.html.
 * Los ajustes van de -12 dB a +12 dB y se guardan en este dispositivo.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "pulsar-rm-equalizer-6band-v1";
  const BANDS = [
    { label: "60", frequency: 60, type: "lowshelf", q: 0.7 },
    { label: "250", frequency: 250, type: "peaking", q: 1.0 },
    { label: "1k", frequency: 1000, type: "peaking", q: 1.0 },
    { label: "4k", frequency: 4000, type: "peaking", q: 1.0 },
    { label: "8k", frequency: 8000, type: "peaking", q: 1.0 },
    { label: "16k", frequency: 16000, type: "highshelf", q: 0.7 }
  ];

  const state = {
    gains: [0, 0, 0, 0, 0, 0],
    context: null,
    source: null,
    filters: [],
    initialized: false
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function formatDb(value) {
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(1)} dB`;
  }

  function showNotice(message) {
    if (typeof UI !== "undefined" && typeof UI.toast === "function") {
      UI.toast(message);
    } else {
      console.warn(message);
    }
  }

  function loadSavedGains() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (Array.isArray(saved) && saved.length === BANDS.length) {
        state.gains = saved.map((value) => {
          const number = Number(value);
          return Number.isFinite(number) ? clamp(number, -12, 12) : 0;
        });
      }
    } catch (error) {
      console.warn("No se pudieron cargar los ajustes del ecualizador:", error);
    }
  }

  function saveGains() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.gains));
    } catch (error) {
      console.warn("No se pudieron guardar los ajustes del ecualizador:", error);
    }
  }

  function injectStyles() {
    if (document.getElementById("pulsar-eq-6band-styles")) return;

    const style = document.createElement("style");
    style.id = "pulsar-eq-6band-styles";
    style.textContent = `
      .pulsar-eq-toggle {
        width: 100%;
        min-height: 46px;
        margin-top: 14px;
        padding: 11px 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 9px;
        border: 1px solid #2b3550;
        border-radius: 15px;
        background: #151d30;
        color: #d8d0f5;
        font-size: 13px;
        font-weight: 600;
      }

      .pulsar-eq-toggle[aria-expanded="true"] {
        border-color: var(--accent, #a18aff);
        background: #1b1a36;
      }

      .pulsar-eq-toggle .pulsar-eq-chevron {
        display: inline-block;
        margin-left: 2px;
        opacity: .7;
        transition: transform .2s ease;
      }

      .pulsar-eq-toggle[aria-expanded="true"] .pulsar-eq-chevron {
        transform: rotate(180deg);
      }

      .pulsar-eq-panel {
        margin: 11px 0 0;
        padding: 14px 9px 12px;
        border: 1px solid #292f49;
        border-radius: 17px;
        background: linear-gradient(145deg, #151426, #101522);
        text-align: left;
      }

      .pulsar-eq-panel[hidden] {
        display: none !important;
      }

      .pulsar-eq-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 3px 10px;
        color: #c9c3dc;
        font-size: 10px;
        letter-spacing: .7px;
      }

      .pulsar-eq-range-note {
        color: #8f89a5;
        font-size: 9px;
        letter-spacing: 0;
        white-space: nowrap;
      }

      .pulsar-eq-bands {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        align-items: end;
        gap: 3px;
      }

      .pulsar-eq-band {
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-end;
        gap: 7px;
      }

      .pulsar-eq-band output {
        min-height: 12px;
        color: #c7b8ff;
        font-size: 9px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .pulsar-eq-band input[type="range"] {
        display: block;
        width: 25px;
        height: 138px;
        margin: 0;
        padding: 0;
        appearance: slider-vertical;
        -webkit-appearance: slider-vertical;
        writing-mode: vertical-lr;
        direction: rtl;
        accent-color: var(--accent, #a18aff);
        background: transparent;
        touch-action: pan-y;
        cursor: pointer;
      }

      .pulsar-eq-band small {
        color: #a9a1bd;
        font-size: 10px;
        line-height: 1;
        white-space: nowrap;
      }

      @media (max-width: 360px) {
        .pulsar-eq-panel { padding-right: 5px; padding-left: 5px; }
        .pulsar-eq-bands { gap: 1px; }
        .pulsar-eq-band input[type="range"] { width: 22px; height: 126px; }
        .pulsar-eq-band output { font-size: 8px; }
        .pulsar-eq-band small { font-size: 9px; }
        .pulsar-eq-range-note { font-size: 8px; }
      }
    `;

    document.head.appendChild(style);
  }

  function applyGains() {
    if (!state.initialized) return;

    state.filters.forEach((filter, index) => {
      const parameter = filter.gain;
      const value = state.gains[index];
      if (parameter && state.context) {
        parameter.setTargetAtTime(value, state.context.currentTime, 0.025);
      }
    });
  }

  function initializeAudioGraph() {
    if (state.initialized) return true;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || typeof Player === "undefined" || !Player.audio) {
      showNotice("Este navegador no admite el ecualizador de audio.");
      return false;
    }

    let context = null;
    let source = null;

    try {
      context = new AudioContextClass();
      source = context.createMediaElementSource(Player.audio);

      const filters = BANDS.map((band) => {
        const filter = context.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = Math.min(band.frequency, context.sampleRate * 0.45);
        filter.Q.value = band.q;
        filter.gain.value = 0;
        return filter;
      });

      let previousNode = source;
      filters.forEach((filter) => {
        previousNode.connect(filter);
        previousNode = filter;
      });
      previousNode.connect(context.destination);

      state.context = context;
      state.source = source;
      state.filters = filters;
      state.initialized = true;
      applyGains();
      return true;
    } catch (error) {
      console.error("No se pudo iniciar el ecualizador:", error);

      // Si el nodo de origen llegó a crearse, mantener el audio audible sin EQ.
      if (source && context) {
        try { source.connect(context.destination); } catch (fallbackError) {
          console.warn("No se pudo restaurar la salida de audio:", fallbackError);
        }
      }
      if (context) context.close().catch(() => {});

      showNotice("No se pudo activar el ecualizador. La reproducción seguirá sin cambios.");
      return false;
    }
  }

  async function resumeAudioContext() {
    if (!initializeAudioGraph()) return;

    if (state.context && state.context.state === "suspended") {
      try {
        await state.context.resume();
      } catch (error) {
        console.warn("No se pudo reanudar el audio:", error);
      }
    }
  }

  function createInterface() {
    const player = document.querySelector("#view-player .now-playing");
    const controls = player && player.querySelector(".controls");
    if (!player || !controls || document.getElementById("pulsar-eq-toggle")) return;

    injectStyles();

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = "pulsar-eq-toggle";
    toggle.className = "pulsar-eq-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", "pulsar-eq-panel");
    toggle.innerHTML = '<span aria-hidden="true">♫</span><span>Ecualizador</span><span class="pulsar-eq-chevron" aria-hidden="true">⌄</span>';

    const panel = document.createElement("div");
    panel.id = "pulsar-eq-panel";
    panel.className = "pulsar-eq-panel";
    panel.hidden = true;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Ecualizador de seis bandas");
    panel.innerHTML = `
      <div class="pulsar-eq-heading">
        <span>GANANCIA POR FRECUENCIA</span>
        <span class="pulsar-eq-range-note">−12 dB a +12 dB</span>
      </div>
      <div class="pulsar-eq-bands">
        ${BANDS.map((band, index) => `
          <label class="pulsar-eq-band" for="pulsar-eq-band-${index}">
            <output id="pulsar-eq-value-${index}" for="pulsar-eq-band-${index}">${formatDb(state.gains[index])}</output>
            <input
              id="pulsar-eq-band-${index}"
              type="range"
              min="-12"
              max="12"
              step="0.5"
              value="${state.gains[index]}"
              aria-label="Ganancia de ${band.label} Hz"
            >
            <small>${band.label}</small>
          </label>
        `).join("")}
      </div>
    `;

    controls.insertAdjacentElement("afterend", toggle);
    toggle.insertAdjacentElement("afterend", panel);

    toggle.addEventListener("click", async () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
      if (opening) await resumeAudioContext();
    });

    BANDS.forEach((band, index) => {
      const slider = document.getElementById(`pulsar-eq-band-${index}`);
      const output = document.getElementById(`pulsar-eq-value-${index}`);

      slider.addEventListener("input", () => {
        state.gains[index] = clamp(Number(slider.value), -12, 12);
        output.textContent = formatDb(state.gains[index]);
        saveGains();
        applyGains();
      });
    });
  }

  loadSavedGains();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createInterface, { once: true });
  } else {
    createInterface();
  }
})();
