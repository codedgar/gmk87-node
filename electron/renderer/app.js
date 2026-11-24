/**
 * SPA Router and view management
 */
const App = {
  _currentView: null,
  _currentHash: null,
  /** Set while a long-running operation (diagnostics) must not be interrupted */
  locked: false,

  views: {
    home: HomeView,
    upload: UploadView,
    colors: ColorsView,
    timesync: TimeSyncView,
    diagnostics: DiagnosticsView,
  },

  init() {
    window.addEventListener("hashchange", () => this.route());
    this.route();
  },

  route() {
    const hash = window.location.hash.slice(1) || "home";
    if (this.locked) {
      // Revert navigation; the revert fires another hashchange which lands here and is ignored
      if (hash !== this._currentHash) {
        window.location.hash = this._currentHash;
        Toast.error("Wait for diagnostics to finish");
      }
      return;
    }
    const view = this.views[hash];
    if (!view) {
      window.location.hash = "home";
      return;
    }

    // Destroy previous view if it has a destroy method (cleanup intervals etc.)
    if (this._currentView && this._currentView.destroy) {
      this._currentView.destroy();
    }

    this._currentView = view;
    this._currentHash = hash;
    Sidebar.render(hash);
    view.render();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
