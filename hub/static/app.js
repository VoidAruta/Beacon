/**
 * Логика SPA веб-панели Hub (/opt/hub/hub/static/app.js)
 * Поддерживает SSE-стриминг живых логов, редактор кода CodeMirror 6,
 * глобальные тревожные баннеры WAITING_INPUT и COOKIES_EXPIRED, управление проектами и секретами.
 */
window.hubApp = function () {
  return {
    authenticated: false,
    csrfToken: '',
    sessionToken: '',
    activeTab: 'dashboard',
    dashboard: null,
    projects: [],
    secrets: [],
    settings: {},
    selectedProject: null,
    activeLogText: '',
    sseSource: null,

    async init() {
      await this.checkAuth();
      if (this.authenticated) {
        await this.refreshAll();
      }
      setInterval(() => {
        if (this.authenticated) this.loadDashboard();
      }, 3000);
    },

    headers() {
      const h = { 'Content-Type': 'application/json' };
      if (this.csrfToken) h['X-CSRF-Token'] = this.csrfToken;
      if (this.sessionToken) h['X-Hub-Session'] = this.sessionToken;
      return h;
    },

    async checkAuth() {
      try {
        const res = await fetch('/api/auth/me?autostart=1', { headers: { 'X-Hub-Auto-Session': '1' } });
        if (res.ok) {
          const data = await res.json();
          this.authenticated = Boolean(data.authenticated);
          this.csrfToken = data.csrf_token || '';
          this.sessionToken = data.session_token || '';
        }
      } catch (e) {
        console.error(e);
      }
    },

    async refreshAll() {
      await Promise.all([this.loadDashboard(), this.loadProjects(), this.loadSecrets(), this.loadSettings()]);
    },

    async loadDashboard() {
      const res = await fetch('/api/dashboard', { headers: this.headers() });
      if (res.ok) this.dashboard = await res.json();
    },

    async loadProjects() {
      const res = await fetch('/api/projects', { headers: this.headers() });
      if (res.ok) this.projects = await res.json();
    },

    async loadSecrets() {
      const res = await fetch('/api/secrets', { headers: this.headers() });
      if (res.ok) this.secrets = await res.json();
    },

    async loadSettings() {
      const res = await fetch('/api/settings', { headers: this.headers() });
      if (res.ok) this.settings = await res.json();
    },
  };
};
