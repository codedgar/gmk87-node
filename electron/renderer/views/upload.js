/**
 * Upload Image view
 */
const UploadView = {
  _filePath: null,
  _isGif: false,
  _slot: 0,
  _frameDuration: 100,
  _uploading: false,

  render() {
    this._filePath = null;
    this._isGif = false;
    this._slot = 0;
    this._frameDuration = 100;
    this._uploading = false;

    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Upload Image</h1>
        <p class="page-subtitle">Upload a PNG, JPG, or GIF to the keyboard display</p>
      </div>

      <div class="card section-gap">
        <div class="card-title">Image File</div>
        <div class="file-picker">
          <button class="btn" id="upload-pick-file">Choose File</button>
          <span class="file-name" id="upload-file-name">No file selected</span>
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

      <div class="card section-gap">
        <div class="card-title">Target Slot</div>
        <div class="toggle-group">
          <button class="toggle-btn active" data-slot="0">Slot 0</button>
          <button class="toggle-btn" data-slot="1">Slot 1</button>
        </div>
      </div>

      <button class="btn btn-primary" id="upload-btn" disabled>
        Upload
      </button>
    `;

    this._bind();
  },

  _bind() {
    document.getElementById("upload-pick-file").addEventListener("click", async () => {
      if (this._uploading) return;
      const result = await window.gmk87.openFile();
      if (result.success && result.data) {
        this._filePath = result.data;
        this._isGif = result.data.toLowerCase().endsWith(".gif");
        const name = result.data.split(/[/\\]/).pop();
        document.getElementById("upload-file-name").textContent = name;
        document.getElementById("upload-btn").disabled = false;

        const gifSection = document.getElementById("upload-gif-section");
        if (this._isGif) {
          gifSection.classList.add("visible");
        } else {
          gifSection.classList.remove("visible");
        }
      }
    });

    const delaySlider = document.getElementById("upload-frame-delay");
    const delayValue = document.getElementById("upload-frame-delay-value");
    delaySlider.addEventListener("input", () => {
      this._frameDuration = parseInt(delaySlider.value);
      delayValue.textContent = `${delaySlider.value}ms`;
    });

    document.querySelectorAll("[data-slot]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (this._uploading) return;
        document.querySelectorAll("[data-slot]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this._slot = parseInt(btn.dataset.slot);
      });
    });

    document.getElementById("upload-btn").addEventListener("click", () => this._upload());
  },

  async _upload() {
    if (!this._filePath || this._uploading) return;

    this._uploading = true;
    const btn = document.getElementById("upload-btn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Uploading...`;

    // Disable all controls during upload
    document.getElementById("upload-pick-file").disabled = true;
    document.querySelectorAll("[data-slot]").forEach((b) => (b.disabled = true));

    const result = await window.gmk87.uploadImage({
      filePath: this._filePath,
      slot: this._slot,
      frameDuration: this._isGif ? this._frameDuration : undefined,
    });

    this._uploading = false;
    btn.disabled = false;
    btn.innerHTML = "Upload";
    document.getElementById("upload-pick-file").disabled = false;
    document.querySelectorAll("[data-slot]").forEach((b) => (b.disabled = false));

    if (result.success) {
      Toast.success("Image uploaded successfully");
    } else {
      Toast.error(result.error || "Upload failed");
    }
  },
};
