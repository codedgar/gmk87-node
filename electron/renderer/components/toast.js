/**
 * Toast notification system
 */
const Toast = {
  /**
   * Show a success toast
   * @param {string} message
   */
  success(message) {
    this._show(message, "success");
  },

  /**
   * Show an error toast
   * @param {string} message
   */
  error(message) {
    this._show(message, "error");
  },

  /**
   * Show a toast that stays until dismissed, with a "Report this problem" button.
   * Used when a keyboard operation fails or a command gets no response.
   * @param {string} message
   * @param {"error"|"warning"} [type="error"]
   */
  problem(message, type = "error") {
    const container = document.getElementById("toast-container");
    container.querySelectorAll(".toast-problem").forEach((t) => t.remove());

    const el = document.createElement("div");
    el.className = `toast toast-problem ${type}`;
    el.setAttribute("role", "alert");
    el.innerHTML = `
      <div class="toast-problem-text"></div>
      <div class="toast-problem-actions">
        <button class="btn btn-sm" data-act="dismiss">Dismiss</button>
        <button class="btn btn-sm btn-primary" data-act="report">Report this problem</button>
      </div>`;
    el.querySelector(".toast-problem-text").textContent = message;
    container.appendChild(el);

    const close = () => {
      el.classList.add("fade-out");
      el.addEventListener("animationend", () => el.remove());
    };
    el.querySelector('[data-act="dismiss"]').addEventListener("click", close);
    el.querySelector('[data-act="report"]').addEventListener("click", () => {
      el.remove();
      DiagnosticsView.startReport();
    });
  },

  /**
   * Shows the result of a keyboard operation. Problems get the report button.
   * @param {{success: boolean, error?: string, issue?: boolean, warning?: string}} result
   * @param {string} okMessage
   * @param {string} failMessage
   */
  result(result, okMessage, failMessage) {
    if (result.success && !result.issue) return this.success(okMessage);
    if (result.success) {
      return this.problem(`${okMessage} with errors: ${result.warning}`, "warning");
    }
    if (result.issue) return this.problem(result.error || failMessage);
    this.error(result.error || failMessage);
  },

  /** @private */
  _show(message, type) {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = `toast ${type === "error" ? "error" : ""}`;
    el.textContent = message;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add("fade-out");
      el.addEventListener("animationend", () => el.remove());
    }, 3000);
  },
};
