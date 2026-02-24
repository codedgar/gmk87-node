/**
 * Time Sync view - Live clock and sync button
 */
const TimeSyncView = {
  _intervalId: null,

  render() {
    // Clear any previous interval
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Time Sync</h1>
        <p class="page-subtitle">Synchronize your system time to the keyboard</p>
      </div>

      <div class="card" style="text-align: center; padding: 40px 20px;">
        <div class="clock-display" id="ts-clock"></div>
        <div class="clock-date" id="ts-date"></div>
        <button class="btn btn-primary" id="ts-sync-btn">Sync Time</button>
      </div>
    `;

    this._updateClock();
    this._intervalId = setInterval(() => this._updateClock(), 1000);

    document.getElementById("ts-sync-btn").addEventListener("click", () => this._sync());
  },

  _updateClock() {
    const clockEl = document.getElementById("ts-clock");
    const dateEl = document.getElementById("ts-date");
    if (!clockEl || !dateEl) {
      if (this._intervalId) {
        clearInterval(this._intervalId);
        this._intervalId = null;
      }
      return;
    }

    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    dateEl.textContent = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  },

  async _sync() {
    const btn = document.getElementById("ts-sync-btn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Syncing...`;

    const result = await window.gmk87.syncTime();

    btn.disabled = false;
    btn.innerHTML = "Sync Time";

    if (result.success) {
      Toast.success("Time synced to keyboard");
    } else {
      Toast.error(result.error || "Failed to sync time");
    }
  },

  destroy() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  },
};
