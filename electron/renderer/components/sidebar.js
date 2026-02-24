/**
 * Sidebar navigation component
 */
const Sidebar = {
  items: [
    {
      id: "home",
      label: "Home",
      icon: `<span class="material-icons">home</span>`,
    },
    {
      id: "upload",
      label: "Upload Image",
      icon: `<span class="material-icons">upload</span>`,
    },
    {
      id: "colors",
      label: "Color Options",
      icon: `<span class="material-icons">palette</span>`,
    },
    {
      id: "timesync",
      label: "Time Sync",
      icon: `<span class="material-icons">schedule</span>`,
    },
  ],

  async render(activeId) {
    const sidebar = document.getElementById("sidebar");
    const version = await window.gmk87.getVersion();

    sidebar.innerHTML = `
      <div class="sidebar-title">GMK87 Configurator</div>
      <nav class="sidebar-nav">
        ${this.items
          .map(
            (item) => `
          <button class="sidebar-item ${item.id === activeId ? "active" : ""}" data-view="${item.id}">
            ${item.icon}
            <span>${item.label}</span>
          </button>`
          )
          .join("")}
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-footer">
        <div class="sidebar-version">v${version}</div>
        <button class="sidebar-item" id="show-logs">
          <span class="material-icons">terminal</span>
          <span>Logs</span>
        </button>
        <button class="sidebar-item" id="report-issue">
          <span class="material-icons">bug_report</span>
          <span>Report Issue</span>
        </button>
      </div>
    `;

    // Nav click handlers
    sidebar.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.location.hash = btn.dataset.view;
      });
    });

    // Logs handler
    document.getElementById("show-logs").addEventListener("click", () => {
      Sidebar.showLogsModal();
    });

    // Report issue handler
    document.getElementById("report-issue").addEventListener("click", () => {
      window.gmk87.openExternal("https://github.com/codedgar/gmk87-node/issues");
    });
  },

  async showLogsModal() {
    const logs = await window.gmk87.getLogs();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const logLines = logs.length === 0
      ? '<span class="log-empty">No logs yet</span>'
      : logs.map((l) => {
          const t = new Date(l.time).toLocaleTimeString();
          return `<div class="log-line log-${l.level}"><span class="log-time">${t}</span> ${this._escapeHtml(l.msg)}</div>`;
        }).join("");

    overlay.innerHTML = `
      <div class="modal logs-modal">
        <div class="modal-title">Backend Logs</div>
        <div class="logs-container">${logLines}</div>
        <div class="modal-actions">
          <button class="btn" id="logs-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Scroll to bottom
    const container = overlay.querySelector(".logs-container");
    container.scrollTop = container.scrollHeight;

    const close = () => overlay.remove();
    overlay.querySelector("#logs-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  },

  _escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
