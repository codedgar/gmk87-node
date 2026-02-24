/**
 * Home view - Device info and current config
 */

const EFFECT_NAMES = [
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

const LED_MODE_NAMES = [
  "Blinking One Color",
  "Pulse Rainbow",
  "Blinking One Color Alt",
  "Fixed Color",
  "Fixed Color Alt",
];

const DISPLAY_SLOT_NAMES = ["Clock", "Slot 0 Image", "Slot 1 Image"];

const HomeView = {
  async render() {
    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Home</h1>
        <p class="page-subtitle">Device information and current configuration</p>
      </div>
      <div id="home-body">
        <div class="empty-state">
          <div class="spinner" style="margin: 0 auto 16px;"></div>
          <p class="empty-state-desc">Connecting to keyboard...</p>
        </div>
      </div>
    `;
    await this.loadData();
  },

  async loadData() {
    const body = document.getElementById("home-body");
    if (!body) return;

    const infoResult = await window.gmk87.getInfo();

    if (!infoResult.success) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">&#x2328;</div>
          <p class="empty-state-title">Keyboard not found</p>
          <p class="empty-state-desc">${this._escapeHtml(infoResult.error)}</p>
          <button class="btn" id="home-retry">Retry</button>
        </div>
      `;
      document.getElementById("home-retry").addEventListener("click", () => this.loadData());
      return;
    }

    const info = infoResult.data;
    let configHtml = `
      <div class="empty-state">
        <div class="spinner" style="margin: 0 auto 16px;"></div>
        <p class="empty-state-desc">Reading configuration...</p>
      </div>
    `;

    body.innerHTML = `
      <div class="card section-gap">
        <div class="card-title">Device</div>
        <div class="info-row">
          <span class="info-label">Product</span>
          <span class="info-value">${this._escapeHtml(info.product || "Unknown")}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Manufacturer</span>
          <span class="info-value">${this._escapeHtml(info.manufacturer || "Unknown")}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Vendor ID</span>
          <span class="info-value">0x${(info.vendorId || 0).toString(16).padStart(4, "0")}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Product ID</span>
          <span class="info-value">0x${(info.productId || 0).toString(16).padStart(4, "0")}</span>
        </div>
      </div>
      <div class="flex-between section-gap">
        <div class="card-title" style="margin-bottom:0">Configuration</div>
        <button class="btn btn-sm" id="home-refresh">Refresh</button>
      </div>
      <div id="config-body">${configHtml}</div>
    `;

    document.getElementById("home-refresh").addEventListener("click", () => this.loadConfig());
    await this.loadConfig();
  },

  async loadConfig() {
    const configBody = document.getElementById("config-body");
    if (!configBody) return;

    configBody.innerHTML = `
      <div class="empty-state">
        <div class="spinner" style="margin: 0 auto 16px;"></div>
        <p class="empty-state-desc">Reading configuration...</p>
      </div>
    `;

    const result = await window.gmk87.readConfig();

    if (!result.success) {
      configBody.innerHTML = `
        <div class="card">
          <p style="color: var(--error); font-size: 13px;">${this._escapeHtml(result.error)}</p>
        </div>
      `;
      return;
    }

    const cfg = result.data;
    const ug = cfg.underglow || {};
    const led = cfg.led || {};

    configBody.innerHTML = `
      <div class="card" style="margin-bottom: 16px;">
        <div class="card-title">Underglow</div>
        <div class="info-row">
          <span class="info-label">Effect</span>
          <span class="info-value">${EFFECT_NAMES[ug.effect] || `#${ug.effect}`}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Brightness</span>
          <span class="info-value">${ug.brightness ?? "?"}/9</span>
        </div>
        <div class="info-row">
          <span class="info-label">Speed</span>
          <span class="info-value">${ug.speed ?? "?"}/9</span>
        </div>
        <div class="info-row">
          <span class="info-label">Rainbow</span>
          <span class="info-value">${ug.rainbow ? "On" : "Off"}</span>
        </div>
      </div>
      <div class="card" style="margin-bottom: 16px;">
        <div class="card-title">LED</div>
        <div class="info-row">
          <span class="info-label">Mode</span>
          <span class="info-value">${LED_MODE_NAMES[led.mode] || `#${led.mode}`}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Rainbow</span>
          <span class="info-value">${led.rainbow ? "On" : "Off"}</span>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Display</div>
        <div class="info-row">
          <span class="info-label">Showing</span>
          <span class="info-value">${DISPLAY_SLOT_NAMES[cfg.showImage] || `#${cfg.showImage}`}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Slot 0 Frames</span>
          <span class="info-value">${cfg.image1Frames ?? 0}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Slot 1 Frames</span>
          <span class="info-value">${cfg.image2Frames ?? 0}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Frame Duration</span>
          <span class="info-value">${cfg.frameDuration ?? 0}ms</span>
        </div>
      </div>
    `;
  },

  _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
