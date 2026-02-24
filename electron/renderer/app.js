/**
 * SPA Router and view management
 */
const App = {
  _currentView: null,

  views: {
    home: HomeView,
    upload: UploadView,
    colors: ColorsView,
    timesync: TimeSyncView,
  },

  init() {
    window.addEventListener("hashchange", () => this.route());
    this.route();
  },

  route() {
    const hash = window.location.hash.slice(1) || "home";
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
    Sidebar.render(hash);
    view.render();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
