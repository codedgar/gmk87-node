/**
 * Color Options view - Underglow, LED, Presets, Display
 */

const EFFECT_OPTIONS = [
  "Off",
  "Horizontal Dimming Wave",
  "Horizontal Pulse Wave",
  "Waterfall",
  "Full Cycling Colors",
  "Breathing",
  "Full One Color",
  "Glow Pressed Key",
  "Glow Spreading",
  "Glow Row",
  "Random Pattern",
  "Rainbow Cycle",
  "Rainbow Waterfall",
  "Wave from Center",
  "Circling JK",
  "Raining",
  "Wave Left-Right",
  "Slow Saturation Cycle",
  "Slow Rainbow from Center",
];

const LED_MODE_OPTIONS = [
  "Blinking One Color",
  "Pulse Rainbow",
  "Blinking One Color Alt",
  "Fixed Color",
  "Fixed Color Alt",
];

const COLOR_NAMES = [
  "Red", "Orange", "Yellow", "Green", "Teal", "Blue", "Purple", "White", "Off",
];

const HUE_SWATCHES = [
  { name: "Red", rgb: { red: 255, green: 0, blue: 0 }, hex: "#ff0000" },
  { name: "Orange", rgb: { red: 255, green: 128, blue: 0 }, hex: "#ff8000" },
  { name: "Yellow", rgb: { red: 255, green: 255, blue: 0 }, hex: "#ffff00" },
  { name: "Green", rgb: { red: 0, green: 255, blue: 0 }, hex: "#00ff00" },
  { name: "Cyan", rgb: { red: 0, green: 255, blue: 255 }, hex: "#00ffff" },
  { name: "Blue", rgb: { red: 0, green: 0, blue: 255 }, hex: "#0000ff" },
  { name: "Purple", rgb: { red: 128, green: 0, blue: 255 }, hex: "#8000ff" },
  { name: "White", rgb: { red: 255, green: 255, blue: 255 }, hex: "#ffffff" },
];

const ColorsView = {
  _presets: null,
  _busy: false,
  _colorPicker: null,

  // Current form state
  _ug: { effect: 0, brightness: 5, speed: 5, orientation: 1, rainbow: 0, hue: { red: 255, green: 255, blue: 255 } },
  _led: { mode: 3, color: 0, saturation: 5, rainbow: 0 },
  _display: 0,

  async render() {
    this._busy = false;
    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Color Options</h1>
        <p class="page-subtitle">Configure underglow, LED, and display settings</p>
      </div>
      <div id="colors-body">
        <div class="empty-state">
          <div class="spinner" style="margin: 0 auto 16px;"></div>
          <p class="empty-state-desc">Loading...</p>
        </div>
      </div>
    `;

    // Load presets and current config in parallel
    const [presetsResult, configResult] = await Promise.all([
      window.gmk87.getPresets(),
      window.gmk87.readConfig(),
    ]);

    if (presetsResult.success) {
      this._presets = presetsResult.data;
    }

    if (configResult.success) {
      const cfg = configResult.data;
      if (cfg.underglow) {
        this._ug = { ...this._ug, ...cfg.underglow };
        if (cfg.underglow.hue) {
          this._ug.hue = { ...this._ug.hue, ...cfg.underglow.hue };
        }
      }
      if (cfg.led) {
        this._led = { ...this._led, ...cfg.led };
      }
      this._display = cfg.showImage ?? 0;
    }

    this._renderBody();
  },

  _renderBody() {
    const body = document.getElementById("colors-body");
    if (!body) return;
    this._colorPicker = null;

    body.innerHTML = `
      ${this._renderPresets()}
      ${this._renderUnderglow()}
      ${this._renderLed()}
      ${this._renderDisplay()}
      <button class="btn btn-primary" id="colors-apply">Apply Changes</button>
    `;

    this._bind();
  },

  _renderPresets() {
    if (!this._presets) return "";
    const names = Object.keys(this._presets);
    return `
      <div class="card section-gap">
        <div class="card-title">Presets</div>
        <div class="pill-row">
          ${names.map((name) => `<button class="pill" data-preset="${name}">${name}</button>`).join("")}
        </div>
      </div>
    `;
  },

  _renderUnderglow() {
    const ug = this._ug;
    // Detect if current hue matches a preset swatch
    const activeSwatchIndex = HUE_SWATCHES.findIndex(
      (s) => s.rgb.red === ug.hue.red && s.rgb.green === ug.hue.green && s.rgb.blue === ug.hue.blue
    );
    const isCustom = activeSwatchIndex === -1;
    return `
      <div class="card section-gap">
        <div class="card-title">Underglow</div>
        <div class="form-group">
          <label class="form-label">Effect</label>
          <select id="ug-effect">
            ${EFFECT_OPTIONS.map((name, i) => `<option value="${i}" ${i === ug.effect ? "selected" : ""}>${name}</option>`).join("")}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Brightness</label>
            <div class="range-wrapper">
              <input type="range" id="ug-brightness" min="0" max="9" value="${ug.brightness}">
              <span class="range-value" id="ug-brightness-val">${ug.brightness}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Speed</label>
            <div class="range-wrapper">
              <input type="range" id="ug-speed" min="0" max="9" value="${ug.speed}">
              <span class="range-value" id="ug-speed-val">${ug.speed}</span>
            </div>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <div class="switch-row">
              <span class="form-label" style="margin-bottom:0">Orientation</span>
              <label class="switch">
                <input type="checkbox" id="ug-orientation" ${ug.orientation ? "checked" : ""}>
                <span class="switch-track"></span>
              </label>
            </div>
          </div>
          <div class="form-group">
            <div class="switch-row">
              <span class="form-label" style="margin-bottom:0">Rainbow</span>
              <label class="switch">
                <input type="checkbox" id="ug-rainbow" ${ug.rainbow ? "checked" : ""}>
                <span class="switch-track"></span>
              </label>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Hue Color</label>
          <div class="color-swatches" id="ug-hue-swatches">
            ${HUE_SWATCHES.map((s, i) => `<button class="hue-swatch ${i === activeSwatchIndex ? "active" : ""}" data-hue="${i}" title="${s.name}" style="background:${s.hex}"></button>`).join("")}
            <button class="hue-swatch custom ${isCustom ? "active" : ""}" data-hue="custom" title="Custom"></button>
          </div>
          <div id="ug-hue-picker" class="${isCustom ? "" : "hidden"} ${ug.rainbow ? "dimmed" : ""}"></div>
        </div>
      </div>
    `;
  },

  _renderLed() {
    const led = this._led;
    return `
      <div class="card section-gap">
        <div class="card-title">LED</div>
        <div class="form-group">
          <label class="form-label">Mode</label>
          <select id="led-mode">
            ${LED_MODE_OPTIONS.map((name, i) => `<option value="${i}" ${i === led.mode ? "selected" : ""}>${name}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Color</label>
          <div class="color-swatches">
            ${COLOR_NAMES.map((name, i) => `<button class="color-swatch ${i === led.color ? "active" : ""}" data-color="${i}" title="${name}"></button>`).join("")}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Saturation</label>
          <div class="range-wrapper">
            <input type="range" id="led-saturation" min="0" max="9" value="${led.saturation}">
            <span class="range-value" id="led-saturation-val">${led.saturation}</span>
          </div>
        </div>
        <div class="form-group">
          <div class="switch-row">
            <span class="form-label" style="margin-bottom:0">Rainbow</span>
            <label class="switch">
              <input type="checkbox" id="led-rainbow" ${led.rainbow ? "checked" : ""}>
              <span class="switch-track"></span>
            </label>
          </div>
        </div>
      </div>
    `;
  },

  _renderDisplay() {
    return `
      <div class="card section-gap">
        <div class="card-title">Display Slot</div>
        <div class="toggle-group">
          <button class="toggle-btn ${this._display === 0 ? "active" : ""}" data-display="0">Clock</button>
          <button class="toggle-btn ${this._display === 1 ? "active" : ""}" data-display="1">Slot 0</button>
          <button class="toggle-btn ${this._display === 2 ? "active" : ""}" data-display="2">Slot 1</button>
        </div>
      </div>
    `;
  },

  _bind() {
    // Presets
    document.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => this._applyPreset(btn.dataset.preset));
    });

    // Underglow
    const ugEffect = document.getElementById("ug-effect");
    const ugBrightness = document.getElementById("ug-brightness");
    const ugSpeed = document.getElementById("ug-speed");
    const ugOrientation = document.getElementById("ug-orientation");
    const ugRainbow = document.getElementById("ug-rainbow");
    const ugHueContainer = document.getElementById("ug-hue-picker");

    ugEffect.addEventListener("change", () => { this._ug.effect = parseInt(ugEffect.value); });
    ugBrightness.addEventListener("input", () => {
      this._ug.brightness = parseInt(ugBrightness.value);
      document.getElementById("ug-brightness-val").textContent = ugBrightness.value;
    });
    ugSpeed.addEventListener("input", () => {
      this._ug.speed = parseInt(ugSpeed.value);
      document.getElementById("ug-speed-val").textContent = ugSpeed.value;
    });
    ugOrientation.addEventListener("change", () => { this._ug.orientation = ugOrientation.checked ? 1 : 0; });
    ugRainbow.addEventListener("change", () => {
      this._ug.rainbow = ugRainbow.checked ? 1 : 0;
      ugHueContainer.classList.toggle("dimmed", ugRainbow.checked);
    });

    // Hue swatches
    document.querySelectorAll("#ug-hue-swatches .hue-swatch").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        document.querySelectorAll("#ug-hue-swatches .hue-swatch").forEach((s) => s.classList.remove("active"));
        swatch.classList.add("active");

        if (swatch.dataset.hue === "custom") {
          ugHueContainer.classList.remove("hidden");
          this._initColorPicker();
        } else {
          ugHueContainer.classList.add("hidden");
          const idx = parseInt(swatch.dataset.hue);
          this._ug.hue = { ...HUE_SWATCHES[idx].rgb };
        }
      });
    });

    // Initialize color picker if Custom is already active
    if (document.querySelector('#ug-hue-swatches .hue-swatch.custom.active')) {
      this._initColorPicker();
    }

    // LED
    const ledMode = document.getElementById("led-mode");
    const ledSaturation = document.getElementById("led-saturation");
    const ledRainbow = document.getElementById("led-rainbow");

    ledMode.addEventListener("change", () => { this._led.mode = parseInt(ledMode.value); });
    ledSaturation.addEventListener("input", () => {
      this._led.saturation = parseInt(ledSaturation.value);
      document.getElementById("led-saturation-val").textContent = ledSaturation.value;
    });
    ledRainbow.addEventListener("change", () => { this._led.rainbow = ledRainbow.checked ? 1 : 0; });

    document.querySelectorAll(".color-swatch").forEach((swatch) => {
      swatch.addEventListener("click", () => {
        document.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("active"));
        swatch.classList.add("active");
        this._led.color = parseInt(swatch.dataset.color);
      });
    });

    // Display
    document.querySelectorAll("[data-display]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-display]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this._display = parseInt(btn.dataset.display);
      });
    });

    // Apply
    document.getElementById("colors-apply").addEventListener("click", () => this._apply());
  },

  async _applyPreset(name) {
    if (this._busy) return;

    const confirmed = await this._showConfirmModal(name);
    if (!confirmed) return;

    this._busy = true;
    this._setAllDisabled(true);

    const result = await window.gmk87.applyPreset(name);
    this._busy = false;
    this._setAllDisabled(false);

    if (result.success) {
      Toast.success(`Preset "${name}" applied`);
      // Reload config to reflect changes
      const cfgResult = await window.gmk87.readConfig();
      if (cfgResult.success) {
        const cfg = cfgResult.data;
        if (cfg.underglow) {
          this._ug = { ...this._ug, ...cfg.underglow };
          if (cfg.underglow.hue) this._ug.hue = { ...this._ug.hue, ...cfg.underglow.hue };
        }
        if (cfg.led) this._led = { ...this._led, ...cfg.led };
        this._display = cfg.showImage ?? 0;
        this._renderBody();
      }
    } else {
      Toast.error(result.error || "Failed to apply preset");
    }
  },

  _showConfirmModal(presetName) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-title">Apply Preset</div>
          <div class="modal-text">This will overwrite your current settings with the "${presetName}" preset. Continue?</div>
          <div class="modal-actions">
            <button class="btn" id="modal-cancel">Cancel</button>
            <button class="btn btn-primary" id="modal-apply">Apply</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };

      overlay.querySelector("#modal-cancel").addEventListener("click", () => close(false));
      overlay.querySelector("#modal-apply").addEventListener("click", () => close(true));
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(false);
      });
    });
  },

  async _apply() {
    if (this._busy) return;
    this._busy = true;

    const btn = document.getElementById("colors-apply");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Applying...`;
    this._setAllDisabled(true);

    const result = await window.gmk87.setLighting({
      underglow: { ...this._ug },
      led: { ...this._led },
      showImage: this._display,
    });

    this._busy = false;
    btn.disabled = false;
    btn.innerHTML = "Apply Changes";
    this._setAllDisabled(false);

    if (result.success) {
      Toast.success("Lighting applied");
    } else {
      Toast.error(result.error || "Failed to apply lighting");
    }
  },

  _setAllDisabled(disabled) {
    const body = document.getElementById("colors-body");
    if (!body) return;
    body.querySelectorAll("button, select, input").forEach((el) => {
      if (el.id === "colors-apply") return;
      el.disabled = disabled;
    });
  },

  _initColorPicker() {
    if (this._colorPicker) return;
    const hueHex = this._rgbToHex(this._ug.hue.red, this._ug.hue.green, this._ug.hue.blue);
    this._colorPicker = new iro.ColorPicker("#ug-hue-picker", {
      width: 160,
      color: hueHex,
      borderWidth: 2,
      borderColor: "#333333",
      handleRadius: 8,
      layoutDirection: "horizontal",
      layout: [
        { component: iro.ui.Wheel, options: {} },
      ],
    });
    this._colorPicker.on("color:change", (color) => {
      this._ug.hue = { red: color.rgb.r, green: color.rgb.g, blue: color.rgb.b };
    });
  },

  _rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");
  },

};
