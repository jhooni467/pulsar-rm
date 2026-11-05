/*
 * PULSAR RM — Ecualizador de 10 bandas
 * Compatible con la estructura actual de Pulsar RM 0.4a.
 * Requiere que script.js se cargue antes que este archivo.
 */
(() => {
  "use strict";

  const FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
  const STORAGE_KEY = "pulsar-rm-equalizer-v1";

  const PRESETS = {
    Normal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "Bass Boost": [5, 5, 4, 2, 0, 0, 0, 1, 1, 1],
    Pop: [-1, 1, 3, 4, 2, 0, 1, 2, 2, 1],
    Rock: [4, 3, 1, -1, -2, 1, 3, 4, 3, 3],
    Classical: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3],
    Vocal: [-2, -1, 0, 2, 4, 4, 3, 2, 1, 0],
    Electronic: [4, 4, 1, 0, -1, 1, 0, 3, 4, 4]
  };

  const state = {
    enabled: true,
    mode: "bars",
    gains: [...PRESETS.Normal],
    preamp: 0,
    preset: "Normal",
    profiles: {},
    context: null,
    source: null,
    filters: [],
    preampNode: null,
    compressor: null,
    initialized: false,
    processingAvailable: false
  };

  const $ = (id) => document.getElementById(id);

  // Registrar la ruta antes de inicializar el Router.
  if (
    typeof Router !== "undefined" &&
    Array.isArray(Router.views) &&
    !Router.views.includes("equalizer")
  ) {
    Router.views.push("equalizer");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function cleanGain(value) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, -12, 12) : 0;
  }

  function dbText(value) {
    const number = Number(value);
    return `${number > 0 ? "+" : ""}${number.toFixed(1)} dB`;
  }

  function toast(message) {
    if (typeof UI !== "undefined" && typeof UI.toast === "function") {
      UI.toast(message);
    } else {
      console.warn(message);
    }
  }

  // Cargar ajustes guardados.
  function loadSaved() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "{}"
      );

      if (Array.isArray(saved.gains) && saved.gains.length === 10) {
        state.gains = saved.gains.map(cleanGain);
      }

      if (typeof saved.enabled === "boolean") {
        state.enabled = saved.enabled;
      }

      if (Number.isFinite(Number(saved.preamp))) {
        state.preamp = clamp(Number(saved.preamp), -12, 6);
      }

      if (saved.mode === "curve" || saved.mode === "bars") {
        state.mode = saved.mode;
      }

      if (typeof saved.preset === "string") {
        state.preset = saved.preset;
      }

      if (
        saved.profiles &&
        typeof saved.profiles === "object" &&
        !Array.isArray(saved.profiles)
      ) {
        for (const [name, values] of Object.entries(saved.profiles)) {
          const cleanName = String(name).trim().slice(0, 28);

          if (cleanName && Array.isArray(values) && values.length === 10) {
            state.profiles[cleanName] = values.map(cleanGain);
          }
        }
      }
    } catch (error) {
      console.warn("No se pudieron cargar los ajustes:", error);
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        mode: state.mode,
        gains: state.gains,
        preamp: state.preamp,
        preset: state.preset,
        profiles: state.profiles
      }));
    } catch (error) {
      console.warn("No se pudieron guardar los ajustes:", error);
      toast("No se pudieron guardar los ajustes del ecualizador.");
    }
  }

  // ESTILOS
  function injectStyles() {
    if ($("pulsar-eq-styles")) return;

    const style = document.createElement("style");
    style.id = "pulsar-eq-styles";

    style.textContent = `
      .eq-open-btn {
        margin-left: auto;
        padding: 8px 12px;
        border: 1px solid #393052;
        border-radius: 20px;
        color: #c3b2ff;
        background: #171426;
        font-size: 12px;
      }

      #view-equalizer {
        padding-top: 18px;
      }

      .eq-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 22px;
      }

      .eq-top h2 {
        font-size: 22px;
      }

      .eq-back {
        color: #b8a4ff;
        padding: 9px 12px;
        border-radius: 20px;
        background: #171426;
      }

      .eq-card {
        background: linear-gradient(145deg, #151426, #101522);
        border: 1px solid #2c2942;
        border-radius: 20px;
        padding: 16px;
        margin: 14px 0;
      }

      .eq-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }

      .eq-switch {
        display: flex;
        align-items: center;
        gap: 9px;
        color: #c9c3dc;
        font-size: 13px;
      }

      .eq-switch input {
        accent-color: #a18aff;
        width: 18px;
        height: 18px;
      }

      .eq-select {
        background: #211d34;
        color: #f5f5fa;
        border: 1px solid #393052;
        border-radius: 12px;
        padding: 11px;
        max-width: 58%;
        font-size: 13px;
      }

      .eq-modes {
        display: flex;
        gap: 8px;
        margin-top: 14px;
      }

      .eq-modes button {
        flex: 1;
        padding: 10px;
        border-radius: 12px;
        background: #171426;
        color: #a9a1bd;
        font-size: 12px;
      }

      .eq-modes button.active {
        background: #a18aff;
        color: #080b16;
        font-weight: bold;
      }

      .eq-bands {
        display: flex;
        justify-content: space-between;
        gap: 4px;
        min-height: 225px;
        padding: 16px 2px 8px;
      }

      .eq-band {
        display: flex;
        flex: 1;
        min-width: 0;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .eq-band output {
        font-size: 9px;
        color: #c7b8ff;
        white-space: nowrap;
      }

      .eq-band input {
        appearance: slider-vertical;
        -webkit-appearance: slider-vertical;
        writing-mode: vertical-lr;
        direction: rtl;
        width: 25px;
        height: 145px;
        accent-color: #a18aff;
        touch-action: pan-y;
      }

      .eq-band small {
        font-size: 9px;
        color: #a9a1bd;
      }

      .eq-preamp {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 12px;
        color: #c9c3dc;
        font-size: 12px;
      }

      .eq-preamp input {
        flex: 1;
        accent-color: #a18aff;
        min-width: 0;
      }

      .eq-curve-wrap {
        width: 100%;
        overflow: hidden;
      }

      .eq-curve {
        display: block;
        width: 100%;
        height: auto;
        touch-action: none;
        cursor: crosshair;
      }

      .eq-note {
        font-size: 11px;
        line-height: 1.5;
        color: #89839e;
        margin-top: 12px;
      }

      .eq-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 14px;
      }

      .eq-actions button {
        background: #211d34;
        color: #d8d0f5;
        border: 1px solid #393052;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 11px;
      }

      .eq-actions button.primary {
        background: #a18aff;
        color: #080b16;
        border-color: #a18aff;
        font-weight: bold;
      }

      .eq-hidden {
        display: none !important;
      }

      @media(max-width:390px) {
        .eq-bands {
          gap: 1px;
        }

        .eq-band input {
          height: 128px;
          width: 21px;
        }

        .eq-band small {
          font-size: 8px;
        }

        .eq-band output {
          font-size: 8px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // CREAR INTERFAZ
  function createInterface() {
    if ($("view-equalizer")) return;
    if (typeof Router === "undefined" || typeof Player === "undefined") return;

    const playerView = $("view-player");
    const main = document.querySelector("main");
    const settingsView = $("view-settings");

    if (!playerView || !main) return;

    if (!Router.views.includes("equalizer")) {
      Router.views.push("equalizer");
    }

    const playerHeader = playerView.querySelector(".player-header");

    if (
      playerHeader &&
      !playerHeader.querySelector("[data-view='equalizer']")
    ) {
      const openButton = document.createElement("button");

      openButton.type = "button";
      openButton.className = "eq-open-btn";
      openButton.dataset.view = "equalizer";
      openButton.textContent = "♫ EQ";
      openButton.setAttribute("aria-label", "Abrir ecualizador");

      playerHeader.appendChild(openButton);
    }

    const view = document.createElement("section");

    view.id = "view-equalizer";
    view.className = "view";
    view.dataset.viewName = "equalizer";

    view.innerHTML = `
      <div class="eq-top">
        <button type="button" class="eq-back" data-view="player">
          ← Reproductor
        </button>
        <h2>Ecualizador</h2>
      </div>

      <div class="eq-card">
        <div class="eq-toolbar">
          <label class="eq-switch">
            <input id="eq-enabled" type="checkbox">
            <span>Ecualizador activado</span>
          </label>

          <select id="eq-preset" class="eq-select"
                  aria-label="Preajuste"></select>
        </div>

        <div class="eq-modes">
          <button type="button" data-eq-mode="bars">Barras</button>
          <button type="button" data-eq-mode="curve">Curva</button>
        </div>

        <div id="eq-bars" class="eq-bands"></div>

        <div id="eq-curve-panel"
             class="eq-curve-wrap eq-hidden">

          <svg id="eq-curve"
               class="eq-curve"
               viewBox="0 0 340 190"
               role="img"
               aria-label="Curva editable de ecualización">

            <g stroke="#343047" stroke-width="1">
              <path d="M20 30H320 M20 70H320 M20 110H320 M20 150H320"/>
              <path d="M20 15V160 M95 15V160 M170 15V160 M245 15V160 M320 15V160"/>
            </g>

            <path d="M20 90H320"
                  stroke="#777087"
                  stroke-dasharray="4 4"/>

            <path id="eq-curve-path"
                  d=""
                  fill="none"
                  stroke="#b6a0ff"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"/>

            <g id="eq-curve-points"></g>

            <g fill="#9a91ad" font-size="9">
              <text x="20" y="178">31</text>
              <text x="92" y="178">125</text>
              <text x="164" y="178">500</text>
              <text x="238" y="178">2k</text>
              <text x="305" y="178">16k</text>
              <text x="2" y="33">+12</text>
              <text x="7" y="93">0</text>
              <text x="2" y="153">-12</text>
            </g>
          </svg>

          <p class="eq-note">
            Arrastra los puntos de la curva para ajustar cada frecuencia.
          </p>
        </div>

        <div class="eq-preamp">
          <span>Preamp</span>
          <input id="eq-preamp" type="range"
                 min="-12" max="6" step="0.5">
          <output id="eq-preamp-value">0.0 dB</output>
        </div>

        <div class="eq-actions">
          <button type="button" id="eq-reset">Restablecer</button>
          <button type="button" id="eq-save" class="primary">
            Guardar perfil
          </button>
        </div>

        <p class="eq-note">
          Procesa el audio reproducido dentro de Pulsar RM.
          No modifica el sonido de otras aplicaciones.
        </p>
      </div>
    `;

    main.insertBefore(view, settingsView || null);

    const bars = $("eq-bars");

    bars.innerHTML = FREQUENCIES.map((frequency, index) => `
      <label class="eq-band">
        <output id="eq-value-${index}">0.0 dB</output>

        <input id="eq-band-${index}"
               type="range"
               min="-12"
               max="12"
               step="0.5"
               value="0"
               aria-label="Banda ${frequency} Hz">

        <small>${LABELS[index]}</small>
      </label>
    `).join("");

    const preset = $("eq-preset");

    preset.innerHTML =
      `<option value="custom-current">Personalizado</option>` +
      Object.keys(PRESETS)
        .map(name => `<option value="${name}">${name}</option>`)
        .join("");

    for (const name of Object.keys(state.profiles)) {
      const option = document.createElement("option");
      option.value = `custom:${name}`;
      option.textContent = name;
      preset.appendChild(option);
    }

    // Deslizadores.
    FREQUENCIES.forEach((frequency, index) => {
      $(`eq-band-${index}`).addEventListener("input", event => {
        setGain(index, Number(event.target.value));
      });
    });

    // Encendido y apagado.
    $("eq-enabled").addEventListener("change", event => {
      state.enabled = event.target.checked;
      applyValues();
      persist();
    });

    // Preamp.
    $("eq-preamp").addEventListener("input", event => {
      state.preamp = clamp(Number(event.target.value), -12, 6);
      $("eq-preamp-value").textContent = dbText(state.preamp);
      applyValues();
      persist();
    });

    // Selección de presets.
    preset.addEventListener("change", () => {
      const value = preset.value;
      const customName = value.startsWith("custom:")
        ? value.slice(7)
        : null;

      const gains = customName
        ? state.profiles[customName]
        : PRESETS[value];

      if (!Array.isArray(gains) || gains.length !== 10) return;

      state.gains = gains.map(cleanGain);
      state.preset = customName ||
        (value === "custom-current" ? "Personalizado" : value);

      renderValues();
      applyValues();
      persist();
    });

    // Restablecer.
    $("eq-reset").addEventListener("click", () => {
      state.gains = [...PRESETS.Normal];
      state.preamp = 0;
      state.preset = "Normal";
      state.enabled = true;

      renderValues();
      applyValues();
      persist();
    });

    // Guardar perfil.
    $("eq-save").addEventListener("click", () => {
      const enteredName = window.prompt("Nombre para este perfil:");

      if (!enteredName || !enteredName.trim()) return;

      const name = enteredName.trim().slice(0, 28);

      state.profiles[name] = [...state.gains];
      state.preset = name;

      persist();
      addProfileOption(name);

      preset.value = `custom:${name}`;

      toast(`Perfil "${name}" guardado.`);
    });

    // Control táctil de la curva.
    const curve = $("eq-curve");
    let dragging = false;

    curve.addEventListener("pointerdown", event => {
      dragging = true;

      if (curve.setPointerCapture) {
        curve.setPointerCapture(event.pointerId);
      }

      setCurveFromPointer(event);
    });

    curve.addEventListener("pointermove", event => {
      if (dragging) setCurveFromPointer(event);
    });

    curve.addEventListener("pointerup", () => {
      dragging = false;
    });

    curve.addEventListener("pointercancel", () => {
      dragging = false;
    });

    $("eq-enabled").checked = state.enabled;

    renderValues();
    setMode(state.mode);
  }

  function addProfileOption(name) {
    const select = $("eq-preset");
    if (!select) return;

    const value = `custom:${name}`;

    let option = [...select.options].find(
      item => item.value === value
    );

    if (!option) {
      option = document.createElement("option");
      option.value = value;
      select.appendChild(option);
    }

    option.textContent = name;
  }

  // Cambiar una banda.
  function setGain(index, value) {
    if (index < 0 || index >= state.gains.length) return;

    state.gains[index] = clamp(
      Math.round(cleanGain(value) * 2) / 2,
      -12,
      12
    );

    state.preset = "Personalizado";

    const slider = $(`eq-band-${index}`);
    if (slider) slider.value = state.gains[index];

    const output = $(`eq-value-${index}`);
    if (output) output.textContent = dbText(state.gains[index]);

    const preset = $("eq-preset");
    if (preset) preset.value = "custom-current";

    applyValues();
    drawCurve();
    persist();
  }

  // Alternar las visualizaciones.
  function setMode(mode) {
    state.mode = mode === "curve" ? "curve" : "bars";

    $("eq-bars").classList.toggle(
      "eq-hidden",
      state.mode !== "bars"
    );

    $("eq-curve-panel").classList.toggle(
      "eq-hidden",
      state.mode !== "curve"
    );

    document.querySelectorAll("[data-eq-mode]").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.eqMode === state.mode
      );
    });

    persist();
  }

  // Actualizar controles e interfaz.
  function renderValues() {
    state.gains.forEach((gain, index) => {
      const slider = $(`eq-band-${index}`);
      const output = $(`eq-value-${index}`);

      if (slider) slider.value = gain;
      if (output) output.textContent = dbText(gain);
    });

    const preamp = $("eq-preamp");
    const preampValue = $("eq-preamp-value");
    const enabled = $("eq-enabled");

    if (preamp) preamp.value = state.preamp;

    if (preampValue) {
      preampValue.textContent = dbText(state.preamp);
    }

    if (enabled) enabled.checked = state.enabled;

    const preset = $("eq-preset");

    if (preset) {
      if (state.profiles[state.preset]) {
        preset.value = `custom:${state.preset}`;
      } else if (PRESETS[state.preset]) {
        preset.value = state.preset;
      } else {
        preset.value = "custom-current";
      }
    }

    drawCurve();
  }

  // Dibujar curva de frecuencias.
  function drawCurve() {
    const path = $("eq-curve-path");
    const points = $("eq-curve-points");

    if (!path || !points) return;

    const coordinates = state.gains.map((gain, index) => ({
      x: 20 + (index / (state.gains.length - 1)) * 300,
      y: 90 - (gain / 12) * 60
    }));

    path.setAttribute(
      "d",
      coordinates.map((point, index) =>
        `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`
      ).join(" ")
    );

    points.innerHTML = coordinates.map((point, index) =>
      `<circle cx="${point.x}" cy="${point.y}" r="5"
        fill="#c6b5ff" stroke="#171426" stroke-width="2">
        <title>${FREQUENCIES[index]} Hz: ${dbText(state.gains[index])}</title>
      </circle>`
    ).join("");
  }

  // Modificar la curva arrastrando sus puntos.
  function setCurveFromPointer(event) {
    const curve = $("eq-curve");
    if (!curve) return;

    const rect = curve.getBoundingClientRect();

    if (!rect.width || !rect.height) return;

    const x = ((event.clientX - rect.left) / rect.width) * 340;
    const y = ((event.clientY - rect.top) / rect.height) * 190;

    if (x < 20 || x > 320 || y < 25 || y > 155) return;

    const index = clamp(
      Math.round(((x - 20) / 300) * 9),
      0,
      9
    );

    const gain = clamp(
      Math.round(((90 - y) / 5) * 2) / 2,
      -12,
      12
    );

    setGain(index, gain);
  }

  // MOTOR DE AUDIO REAL.
  function ensureAudioGraph() {
    if (state.initialized) {
      if (state.context && state.context.state === "suspended") {
        state.context.resume().catch(error => {
          console.warn("No se pudo reanudar AudioContext:", error);
        });
      }
      return;
    }

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (
      !AudioContextClass ||
      typeof Player === "undefined" ||
      !Player.audio
    ) {
      toast("Este navegador no admite el ecualizador de audio.");
      return;
    }

    let source = null;
    let contex
