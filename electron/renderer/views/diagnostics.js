/**
 * Diagnostics view - read-only check and full function test, produces a shareable JSON report
 * Layout follows the app's references: VIA-style setting rows, SteelSeries GG-style
 * segmented mode switch and bottom action bar.
 */
const DiagnosticsView = {
  _mode: "read",
  _tests: { lighting: true, time: true, image: false },
  _running: false,
  _report: null,
  _unsubscribe: null,
  _tickId: null,
  _runStart: 0,
  _done: 0,
  _total: 0,

  _lastIssue: null,
  _autoReport: false,

  NEW_ISSUE_URL: "https://github.com/codedgar/gmk87-node/issues/new",
  /** Must match .github/ISSUE_TEMPLATE/bug_report.yml (file name and field ids) */
  ISSUE_TEMPLATE: "bug_report.yml",
  GITHUB_COMMENT_LIMIT: 65536,
  /** GitHub rejects very long new-issue URLs; the full report goes on the clipboard */
  MAX_ISSUE_URL: 7000,

  /** Steps the read-only check always reports (see src/lib/diagnostics.js) */
  READ_STEPS: 7,

  TESTS: [
    { id: "lighting", name: "Lighting", desc: "Change colors and restore them" },
    { id: "time", name: "Time sync", desc: "Set the clock to this computer's time" },
    { id: "image", name: "Image upload", desc: "Upload two test patterns" },
  ],

  render() {
    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">Diagnostics</h1>
        <p class="page-subtitle">Check the connection and report problems</p>
      </div>

      <div class="card diag-panel section-gap">
        <div class="diag-row" id="diag-last-issue" hidden>
          <div class="diag-row-text">
            <div class="diag-row-label">Last problem</div>
            <div class="diag-row-desc" id="diag-last-issue-desc"></div>
          </div>
          <span class="material-icons diag-icon-fail" aria-hidden="true">error_outline</span>
        </div>
        <div class="diag-row">
          <div class="diag-row-text">
            <div class="diag-row-label">Mode</div>
            <div class="diag-row-desc" id="diag-mode-desc"></div>
          </div>
          <div class="toggle-group" role="radiogroup" aria-label="Diagnostics mode">
            <button class="toggle-btn" role="radio" data-mode="read">Read-only</button>
            <button class="toggle-btn" role="radio" data-mode="full">Full test</button>
          </div>
        </div>

        <div id="diag-tests">
          ${this.TESTS.map((t) => `
            <div class="diag-row">
              <div class="diag-row-text">
                <div class="diag-row-label">${t.name}</div>
                <div class="diag-row-desc" id="diag-desc-${t.id}">${t.desc}</div>
              </div>
              <label class="switch">
                <input type="checkbox" data-test="${t.id}" aria-label="Test ${t.name}">
                <span class="switch-track"></span>
              </label>
            </div>`).join("")}
        </div>

        <div class="diag-actionbar">
          <span class="diag-actionbar-note" id="diag-note"></span>
          <button class="btn btn-primary" id="diag-run"></button>
        </div>
      </div>

      <div id="diag-status"></div>
      <div id="diag-result"></div>
    `;

    content.querySelectorAll("[data-mode]").forEach((el) => {
      el.addEventListener("click", () => {
        if (this._running) return;
        this._mode = el.dataset.mode;
        this._syncControls();
      });
    });
    content.querySelectorAll("[data-test]").forEach((el) => {
      el.checked = this._tests[el.dataset.test];
      el.addEventListener("change", () => {
        this._tests[el.dataset.test] = el.checked;
        this._syncControls();
      });
    });
    document.getElementById("diag-run").addEventListener("click", () => this._start());

    this._syncControls();
    this._showLastIssue();

    if (this._autoReport) {
      this._autoReport = false;
      this._mode = "read";
      this._syncControls();
      this._start();
    } else if (this._report) {
      this._renderFinished(this._report);
    }
  },

  /**
   * Called from a "Report this problem" toast: opens this page and runs the
   * read-only check, which picks up the failed operation automatically.
   */
  startReport() {
    if (this._running) return;
    this._report = null;
    this._autoReport = true;
    if (window.location.hash === "#diagnostics") this.render();
    else window.location.hash = "diagnostics";
  },

  async _showLastIssue() {
    this._lastIssue = await window.gmk87.getLastIssue();
    const row = document.getElementById("diag-last-issue");
    if (!row) return;
    const li = this._lastIssue;
    row.hidden = !li;
    if (!li) return;
    const when = new Date(li.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const what = li.error || `No response to ${li.noResponse.join(", ")}`;
    document.getElementById("diag-last-issue-desc").textContent = `${li.operation}, ${when}: ${what}`;
  },

  _syncControls() {
    const full = this._mode === "full";
    document.querySelectorAll("[data-mode]").forEach((el) => {
      const on = el.dataset.mode === this._mode;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
      el.disabled = this._running;
    });

    document.getElementById("diag-mode-desc").textContent = full
      ? "Changes settings, then restores them"
      : "Reads settings only";

    document.getElementById("diag-tests").hidden = !full;
    document.querySelectorAll("[data-test]").forEach((i) => { i.disabled = this._running; });

    const imageDesc = document.getElementById("diag-desc-image");
    const erase = this._tests.image;
    imageDesc.classList.toggle("diag-row-desc-warn", erase);
    imageDesc.textContent = erase
      ? "Erases both slots and the factory animations"
      : this.TESTS[2].desc;

    const picked = Object.values(this._tests).some(Boolean);
    const note = document.getElementById("diag-note");
    if (!full) note.textContent = "About 10 s";
    else if (!picked) note.textContent = "Select a feature";
    else note.textContent = this._tests.image ? "About 1 min" : "About 15 s";

    const btn = document.getElementById("diag-run");
    btn.disabled = this._running || (full && !picked);
    if (!this._running) btn.textContent = full ? "Run full test" : "Run check";
  },

  _confirmFull() {
    const items = [];
    if (this._tests.lighting) items.push("<li>Lighting (restored after)</li>");
    if (this._tests.time) items.push("<li>Clock (set to this computer's time)</li>");
    if (this._tests.image) items.push("<li><strong>Both image slots (erased, can't be undone)</strong></li>");

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="diag-confirm-title">
          <div class="modal-title" id="diag-confirm-title">Run full test?</div>
          <div class="modal-text">
            Changes:
            <ul class="diag-confirm-list">${items.join("")}</ul>
            Keep the keyboard plugged in.
          </div>
          <div class="modal-actions">
            <button class="btn" id="diag-cancel">Cancel</button>
            <button class="btn btn-primary" id="diag-confirm">Run test</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector("#diag-cancel").focus();
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector("#diag-cancel").addEventListener("click", () => close(false));
      overlay.querySelector("#diag-confirm").addEventListener("click", () => close(true));
      overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(false); });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    });
  },

  async _start() {
    if (this._running) return;
    if (this._mode === "full" && !(await this._confirmFull())) return;

    const tests = this._mode === "full" ? this._tests : {};
    const writeCount = Object.values(tests).filter(Boolean).length;
    this._total = this.READ_STEPS + writeCount + (writeCount ? 1 : 0);
    this._done = 0;
    this._runStart = Date.now();

    this._running = true;
    this._report = null;
    App.locked = true;
    document.getElementById("diag-result").innerHTML = "";
    this._syncControls();
    document.getElementById("diag-run").innerHTML = `<span class="spinner"></span> Running`;

    this._renderRunning();
    this._updateMeta();
    this._tickId = setInterval(() => this._updateMeta(), 500);

    this._unsubscribe = window.gmk87.onDiagnosticsProgress((p) => this._onProgress(p));
    const result = await window.gmk87.runDiagnostics({ mode: this._mode, tests: this._mode === "full" ? this._tests : {} });

    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    this._stopTick();
    this._running = false;
    App.locked = false;

    if (!document.getElementById("diag-run")) return;
    this._syncControls();

    if (!result.success) {
      document.getElementById("diag-status").innerHTML = "";
      Toast.error(result.error || "Diagnostics failed to run");
      return;
    }
    this._report = result.data;
    this._renderFinished(this._report);
  },

  _renderRunning() {
    document.getElementById("diag-status").innerHTML = `
      <div class="card diag-panel section-gap">
        <div class="diag-status-head">
          <span class="diag-status-icon"><span class="spinner"></span></span>
          <div class="diag-status-text">
            <div class="diag-status-title" id="diag-current">Starting</div>
            <div class="diag-live" id="diag-live" aria-live="polite"></div>
          </div>
          <span class="diag-status-meta" id="diag-meta"></span>
        </div>
        <div class="diag-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${this._total}" aria-valuenow="0">
          <span id="diag-bar-fill"></span>
        </div>
      </div>
    `;
  },

  _onProgress(p) {
    const current = document.getElementById("diag-current");
    const live = document.getElementById("diag-live");
    if (!current) return;

    if (p.type === "step-start") {
      current.textContent = p.name;
      live.textContent = "";
    } else if (p.type === "step-end") {
      this._done = Math.min(this._total, this._done + 1);
      const bar = document.getElementById("diag-bar-fill");
      bar.style.width = `${(this._done / this._total) * 100}%`;
      bar.parentElement.setAttribute("aria-valuenow", String(this._done));
      this._updateMeta();
    } else if (p.type === "command") {
      live.textContent = p.ok
        ? `${p.cmd}: ${p.ms} ms`
        : `${p.cmd}: no response (${Math.round(p.ms / 1000)} s)`;
    } else if (p.type === "frames") {
      live.textContent = `Image data: ${p.count} chunks${p.failed ? `, ${p.failed} failed` : ""}`;
    }
  },

  _updateMeta() {
    const meta = document.getElementById("diag-meta");
    if (!meta) return this._stopTick();
    const s = Math.floor((Date.now() - this._runStart) / 1000);
    meta.textContent = `${this._done} of ${this._total} · ${s}s`;
  },

  _stopTick() {
    if (this._tickId) { clearInterval(this._tickId); this._tickId = null; }
  },

  _statusIcon(status) {
    const map = { pass: "check_circle", warn: "error_outline", fail: "cancel", skip: "remove_circle_outline" };
    return `<span class="material-icons diag-icon-${status}" aria-label="${status}">${map[status] || "help_outline"}</span>`;
  },

  _fmtMs(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms} ms`;
  },

  _esc(str) {
    const d = document.createElement("div");
    d.textContent = String(str);
    return d.innerHTML;
  },

  _stepRow(st) {
    const detail = st.error || (st.details && (st.details.note || st.details.reason)) || "";
    return `
      <li class="diag-step diag-step-${st.status}">
        ${this._statusIcon(st.status)}
        <span class="diag-step-name">${this._esc(st.name)}</span>
        <span class="diag-step-ms">${st.status === "skip" ? "skipped" : this._fmtMs(st.ms)}</span>
        ${detail ? `<span class="diag-step-detail">${this._esc(detail)}</span>` : ""}
      </li>`;
  },

  /** Collapses progress into a summary and shows the report */
  _renderFinished(report) {
    const s = report.summary || {};
    const steps = report.steps || [];
    const problems = steps.filter((x) => x.status === "fail" || x.status === "warn");
    const fo = report.failedOperation;
    if (fo) {
      problems.unshift({
        name: `Last ${fo.operation.toLowerCase()}`,
        status: "fail",
        ms: fo.durationMs,
        error: fo.error || `No response to ${fo.noResponse.join(", ")}`,
      });
    }
    const headline = fo && s.result === "pass"
      ? `${fo.operation} failed`
      : { pass: "All checks passed", warn: "Passed with warnings", fail: "Checks failed" }[s.result] || "Done";
    const counts = [
      `${s.passed} passed`,
      s.warnings ? `${s.warnings} warnings` : null,
      s.failed ? `${s.failed} failed` : null,
      s.skipped ? `${s.skipped} skipped` : null,
    ].filter(Boolean).join(" · ");

    const status = document.getElementById("diag-status");
    status.innerHTML = `
      <div class="card diag-panel section-gap">
        <div class="diag-status-head">
          <span class="diag-status-icon">${this._statusIcon(fo && s.result === "pass" ? "warn" : s.result === "pass" ? "pass" : s.result === "warn" ? "warn" : "fail")}</span>
          <div class="diag-status-text">
            <div class="diag-status-title">${headline}</div>
          </div>
          <span class="diag-status-meta">${counts} · ${this._fmtMs(s.durationMs || 0)}</span>
        </div>
        ${problems.length ? `<ul class="diag-steps">${problems.map((st) => this._stepRow(st)).join("")}</ul>` : ""}
        <details class="diag-all-steps">
          <summary>All steps (${steps.length})</summary>
          <ul class="diag-steps">${steps.map((st) => this._stepRow(st)).join("")}</ul>
        </details>
      </div>
    `;

    const json = JSON.stringify(report, null, 2);
    const fenced = "```json\n" + json + "\n```";
    const tooLong = fenced.length > this.GITHUB_COMMENT_LIMIT;
    const result = document.getElementById("diag-result");
    result.innerHTML = `
      <div class="card diag-panel">
        <div class="diag-report-head">
          <div class="card-title">Report</div>
          <div class="diag-report-actions">
            <button class="btn btn-sm" id="diag-save">Save .json</button>
            <button class="btn btn-sm" id="diag-copy">Copy</button>
            <button class="btn btn-sm btn-primary" id="diag-issue">Report on GitHub</button>
          </div>
        </div>
        <p class="diag-report-hint">
          ${tooLong
            ? "Too long to paste. Save it and attach the file to the issue."
            : "Opens a new issue and copies the report for you to paste."}
          No serial numbers or usernames.
        </p>
        <pre class="diag-report" tabindex="0" aria-label="Report JSON"></pre>
      </div>
    `;
    result.querySelector(".diag-report").textContent = json;

    result.querySelector("#diag-copy").addEventListener("click", async () => {
      await window.gmk87.copyText(fenced);
      Toast.success("Report copied");
    });
    result.querySelector("#diag-issue").addEventListener("click", async () => {
      if (!tooLong) await window.gmk87.copyText(json);
      window.gmk87.openExternal(this._issueUrl(report));
      Toast.success(tooLong ? "Save the report and attach it" : "Report copied");
    });
    result.querySelector("#diag-save").addEventListener("click", async () => {
      const r = await window.gmk87.saveDiagnostics(json);
      if (r.success && r.data) Toast.success("Report saved");
      else if (!r.success) Toast.error(r.error || "Could not save report");
    });
  },

  _platformName(p) {
    return { win32: "Windows", darwin: "macOS", linux: "Linux" }[p] || p || "Unknown OS";
  },

  /** The main problem in one line: the failed operation, else the first failed step */
  _headlineProblem(report) {
    const fo = report.failedOperation;
    if (fo) {
      const what = fo.error || `keyboard didn't respond to ${fo.noResponse.join(", ")}`;
      return { title: `${fo.operation}: ${what}`, operation: fo.operation, error: what };
    }
    const bad = (report.steps || []).find((x) => x.status === "fail") || (report.steps || []).find((x) => x.status === "warn");
    if (bad) {
      const what = bad.error || (bad.details && (bad.details.note || bad.details.reason)) || bad.status;
      return { title: `${bad.name}: ${what}`, operation: null, error: what };
    }
    return { title: "Diagnostics report", operation: null, error: null };
  },

  /** Short markdown summary that fits in the new-issue URL */
  _issueSummary(report) {
    const a = report.app || {};
    const sys = report.system || {};
    const hid = report.hid || {};
    const sel = hid.selected;
    const s = report.summary || {};
    const fo = report.failedOperation;
    const lines = [];
    if (fo) {
      lines.push(`**Failed operation:** ${fo.operation} (${Math.round(fo.durationMs / 1000)}s)`);
      if (fo.error) lines.push(`**Error:** ${fo.error}`);
      if (fo.noResponse.length) lines.push(`**No response to:** ${fo.noResponse.join(", ")}`);
      if (fo.frameData) lines.push(`**Image data:** ${fo.frameData.count} chunks, ${fo.frameData.failed} failed`);
    }
    lines.push(`**App:** ${a.version || "?"}${a.packaged === false ? " (dev)" : ""}`);
    lines.push(`**OS:** ${this._platformName(sys.platform)} ${sys.osRelease || ""} ${sys.arch || ""}`.trim());
    lines.push(sel
      ? `**Keyboard:** ${sel.vendorId}:${sel.productId}, firmware ${sel.release}, interface ${sel.interface} (HID interfaces found: ${hid.vendorInterfaces ? hid.vendorInterfaces.length : "?"})`
      : "**Keyboard:** not found");
    const failed = (report.steps || []).filter((x) => x.status === "fail" || x.status === "warn");
    lines.push(`**Read-only check:** ${s.result || "?"} (${s.passed || 0} passed, ${s.warnings || 0} warnings, ${s.failed || 0} failed)`);
    failed.slice(0, 5).forEach((x) => {
      const why = x.error || (x.details && (x.details.note || x.details.reason)) || "";
      lines.push(`- ${x.status}: ${x.name}${why ? `: ${why}` : ""}`);
    });
    return lines.join("\n");
  },

  _issueUrl(report) {
    const p = this._headlineProblem(report);
    const sys = report.system || {};
    const version = (report.app && report.app.version) ? ` (v${report.app.version})` : "";
    const title = `[${this._platformName(sys.platform)}] ${p.title}${version}`.slice(0, 200);
    const description = p.operation
      ? `${p.operation}: ${p.error}\n\n<!-- Your setup: USB hub or port, cable or dongle. Did it work before? -->`
      : "";

    const build = (summary) => {
      const q = new URLSearchParams({ template: this.ISSUE_TEMPLATE, title, description, summary });
      return `${this.NEW_ISSUE_URL}?${q.toString()}`;
    };
    let summary = this._issueSummary(report);
    let url = build(summary);
    while (url.length > this.MAX_ISSUE_URL && summary.includes("\n")) {
      summary = summary.slice(0, summary.lastIndexOf("\n"));
      url = build(summary);
    }
    return url;
  },

  destroy() {
    this._stopTick();
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
  },
};
