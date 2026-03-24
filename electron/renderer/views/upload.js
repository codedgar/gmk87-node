/**
 * Upload Image view
 * Supports independent file selection for each slot (0 and 1)
 */
const UploadView = {
  _slot0File: null,
  _slot1File: null,
  _slot0IsGif: false,
  _slot1IsGif: false,
  _frameDuration: 100,
  _uploading: false,

  render() {
    this._slot0File = null;
    this._slot1File = null;
    this._slot0IsGif = false;
    this._slot1IsGif = false;
    this._frameDuration = 100;
    this._uploading = false;

    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Upload Image</h1>
        <p class="page-subtitle">Upload a PNG, JPG, or GIF to the keyboard display</p>
      </div>

      <div class="card section-gap">
        <div class="card-title">Slot 0</div>
        <div class="file-picker">
          <button class="btn" id="upload-pick-slot0">Choose File</button>
          <span class="file-name" id="upload-slot0-name">No file selected</span>
          <button class="btn btn-sm upload-clear-btn" id="upload-clear-slot0" style="display:none;">Clear</button>
        </div>
      </div>

      <div class="card section-gap">
        <div class="card-title">Slot 1</div>
        <div class="file-picker">
          <button class="btn" id="upload-pick-slot1">Choose File</button>
          <span class="file-name" id="upload-slot1-name">No file selected</span>
          <button class="btn btn-sm upload-clear-btn" id="upload-clear-slot1" style="display:none;">Clear</button>
        </div>
      </div>

      <div class="card section-gap frame-delay-section" id="upload-gif-section">
        <div class="card-title">GIF Frame Delay</div>
        <div class="form-group">
          <div class="range-wrapper">
            <input type="range" id="upload-frame-delay" min="60" max="1000" step="10" value="100">
            <span class="range-value" id="upload-frame-delay-value">100ms</span>
          </div>
        </div>
      </div>

      <button class="btn btn-primary" id="upload-btn" disabled>
        Upload
      </button>
    `;

    this._bind();
  },

  _updateGifSection() {
    const gifSection = document.getElementById("upload-gif-section");
    if (this._slot0IsGif || this._slot1IsGif) {
      gifSection.classList.add("visible");
    } else {
      gifSection.classList.remove("visible");
    }
  },

  _updateUploadBtn() {
    const btn = document.getElementById("upload-btn");
    btn.disabled = this._uploading || (!this._slot0File && !this._slot1File);
  },

  _bind() {
    // Slot 0 file picker
    document.getElementById("upload-pick-slot0").addEventListener("click", async () => {
      if (this._uploading) return;
      const result = await window.gmk87.openFile();
      if (result.success && result.data) {
        this._slot0File = result.data;
        this._slot0IsGif = result.data.toLowerCase().endsWith(".gif");
        document.getElementById("upload-slot0-name").textContent = result.data.split(/[/\\]/).pop();
        document.getElementById("upload-clear-slot0").style.display = "";
        this._updateGifSection();
        this._updateUploadBtn();
      }
    });

    // Slot 1 file picker
    document.getElementById("upload-pick-slot1").addEventListener("click", async () => {
      if (this._uploading) return;
      const result = await window.gmk87.openFile();
      if (result.success && result.data) {
        this._slot1File = result.data;
        this._slot1IsGif = result.data.toLowerCase().endsWith(".gif");
        document.getElementById("upload-slot1-name").textContent = result.data.split(/[/\\]/).pop();
        document.getElementById("upload-clear-slot1").style.display = "";
        this._updateGifSection();
        this._updateUploadBtn();
      }
    });

    // Clear buttons
    document.getElementById("upload-clear-slot0").addEventListener("click", () => {
      if (this._uploading) return;
      this._slot0File = null;
      this._slot0IsGif = false;
      document.getElementById("upload-slot0-name").textContent = "No file selected";
      document.getElementById("upload-clear-slot0").style.display = "none";
      this._updateGifSection();
      this._updateUploadBtn();
    });

    document.getElementById("upload-clear-slot1").addEventListener("click", () => {
      if (this._uploading) return;
      this._slot1File = null;
      this._slot1IsGif = false;
      document.getElementById("upload-slot1-name").textContent = "No file selected";
      document.getElementById("upload-clear-slot1").style.display = "none";
      this._updateGifSection();
      this._updateUploadBtn();
    });

    // Frame delay slider
    const delaySlider = document.getElementById("upload-frame-delay");
    const delayValue = document.getElementById("upload-frame-delay-value");
    delaySlider.addEventListener("input", () => {
      this._frameDuration = parseInt(delaySlider.value);
      delayValue.textContent = `${delaySlider.value}ms`;
    });

    // Upload button
    document.getElementById("upload-btn").addEventListener("click", () => this._upload());
  },

  async _upload() {
    if ((!this._slot0File && !this._slot1File) || this._uploading) return;

    this._uploading = true;
    const btn = document.getElementById("upload-btn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Uploading...`;

    // Disable all controls during upload
    document.getElementById("upload-pick-slot0").disabled = true;
    document.getElementById("upload-pick-slot1").disabled = true;
    document.getElementById("upload-clear-slot0").disabled = true;
    document.getElementById("upload-clear-slot1").disabled = true;

    const hasGif = this._slot0IsGif || this._slot1IsGif;

    const result = await window.gmk87.uploadImage({
      slot0File: this._slot0File,
      slot1File: this._slot1File,
      frameDuration: hasGif ? this._frameDuration : undefined,
    });

    this._uploading = false;
    btn.disabled = false;
    btn.innerHTML = "Upload";
    document.getElementById("upload-pick-slot0").disabled = false;
    document.getElementById("upload-pick-slot1").disabled = false;
    document.getElementById("upload-clear-slot0").disabled = false;
    document.getElementById("upload-clear-slot1").disabled = false;
    this._updateUploadBtn();

    if (result.success) {
      Toast.success("Image uploaded successfully");
    } else {
      Toast.error(result.error || "Upload failed");
    }
  },
};
