import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  FolderCode,
  KeyRound,
  Settings,
  CheckSquare,
  LogOut,
  Plus,
  Lock,
  FlaskConical,
} from 'lucide-react';
import { DashboardData, ProjectItem, SecretItem } from './types/hub';
import { GlobalAlertBanners } from './components/GlobalAlertBanners';
import { DashboardView } from './components/DashboardView';
import { ProjectsWorkspace, WorkspaceSubTab } from './components/ProjectsWorkspace';
import { SecretsView } from './components/SecretsView';
import { SettingsAndAcceptanceView } from './components/SettingsAndAcceptanceView';
import { CreateProjectModal } from './components/CreateProjectModal';

type NavTab = 'dashboard' | 'projects' | 'secrets' | 'settings' | 'acceptance';

const TAB_META: Record<NavTab, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Обзор и Проекты',
    subtitle: 'Мониторинг ресурсов, постоянные программы 24/7, скрипты по расписанию и занимаемое место на диске',
  },
  projects: {
    title: 'Проекты, Код и Расписание',
    subtitle: 'Редактор файлов, индивидуальные куки и Telegram-токен скрипта, конструктор расписания и живые логи',
  },
  secrets: {
    title: 'Куки проектов и Секреты',
    subtitle: 'Импорт куки Cookie-Editor для конкретных скриптов и безопасное хранение API-ключей (права 0600)',
  },
  settings: {
    title: 'Настройки Панели и Системный Telegram',
    subtitle: 'Настройка главного Telegram-бота для уведомлений и управления панелью, прокси 127.0.0.1:10808 и очистка диска',
  },
  acceptance: {
    title: 'Тестовый полигон и Приёмка',
    subtitle: 'Готовые тестовые проекты для проверки всех функций, автопрогон 6 тестов ТЗ и исходники /opt/hub',
  },
};

async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // Если прокси-сервер во время перезапуска контейнера вернул HTML-заглушку вместо JSON для /api/*
  if (urlStr.startsWith('/api/') && contentType.includes('text/html')) {
    try {
      Object.defineProperty(res, 'ok', { value: false, configurable: true });
    } catch {
      // ignore if read-only
    }
  }

  const origText = res.text.bind(res);
  let cachedTextPromise: Promise<string> | null = null;
  const getSafeText = () => {
    if (!cachedTextPromise) {
      cachedTextPromise = origText().catch(() => '');
    }
    return cachedTextPromise;
  };

  res.text = getSafeText;
  res.json = async () => {
    const raw = await getSafeText();
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('<')) {
      try {
        Object.defineProperty(res, 'ok', { value: false, configurable: true });
      } catch {
        // ignore
      }
      return {
        __html_fallback: true,
        detail: 'Сервер инициализируется, повторите попытку через секунду',
      };
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return {
        __invalid_json: true,
        detail: 'Некорректный JSON-ответ от сервера',
      };
    }
  };

  return res;
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [csrfToken, setCsrfToken] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [mustChangePassword, setMustChangePassword] = useState<boolean>(false);
  const [initPwInput, setInitPwInput] = useState<string>('');
  const [initPwStatus, setInitPwStatus] = useState<string>('');

  const [loginPassword, setLoginPassword] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [workspaceSubTab, setWorkspaceSubTab] = useState<WorkspaceSubTab>('editor');
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
  const [restartTestResult, setRestartTestResult] = useState<any>(null);

  const apiFetch = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const headers = new Headers(options.headers || {});
      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json');
      }
      if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
        headers.set('Content-Type', 'application/json; charset=utf-8');
      }
      if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
      if (sessionToken) headers.set('X-Hub-Session', sessionToken);
      return safeFetch(path, {
        ...options,
        headers,
        credentials: 'same-origin',
      });
    },
    [csrfToken, sessionToken]
  );

  const loadAllData = useCallback(
    async (overrideCsrf?: string, overrideSession?: string) => {
      try {
        const hdrs: Record<string, string> = { Accept: 'application/json' };
        if (overrideCsrf || csrfToken) hdrs['X-CSRF-Token'] = overrideCsrf || csrfToken;
        if (overrideSession || sessionToken) hdrs['X-Hub-Session'] = overrideSession || sessionToken;

        const [dRes, pRes, sRes] = await Promise.all([
          safeFetch('/api/dashboard', { headers: hdrs }),
          safeFetch('/api/projects', { headers: hdrs }),
          safeFetch('/api/secrets', { headers: hdrs }),
        ]);

        if (dRes.ok) {
          const dData = await dRes.json();
          if (dData && typeof dData === 'object' && 'system' in dData) {
            setDashboard(dData as DashboardData);
          }
        }
        if (pRes.ok) {
          const pData = await pRes.json();
          if (Array.isArray(pData)) {
            setProjects(pData as ProjectItem[]);
            setSelectedProject((prev) => {
              if (!prev) return pData[0] || null;
              return pData.find((x: ProjectItem) => x.id === prev.id) || pData[0] || null;
            });
          }
        }
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData)) {
            setSecrets(sData as SecretItem[]);
          }
        }
      } catch {
        // Игнорируем кратковременные обрывы сети во время перезапуска демона
      }
    },
    [csrfToken, sessionToken]
  );

  useEffect(() => {
    const initAuth = async () => {
      try {
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await safeFetch('/api/auth/me', {
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
          });
          const data = await res.json();
          if (data && !data.__html_fallback) {
            if (res.ok && data.authenticated) {
              setAuthenticated(true);
              setCsrfToken(data.csrf_token || '');
              setSessionToken(data.session_token || '');
              setMustChangePassword(Boolean(data.must_change_password));
              await loadAllData(data.csrf_token, data.session_token);
            }
            break;
          }
          await new Promise((r) => setTimeout(r, 600));
        }
      } catch (e) {
        console.error(e);
      } finally {
        setAuthChecking(false);
      }
    };
    initAuth();
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => {
      loadAllData();
    }, 2000);
    return () => clearInterval(timer);
  }, [authenticated, loadAllData]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    const res = await safeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password: loginPassword }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.authenticated) {
        setAuthenticated(true);
        setCsrfToken(data.csrf_token || '');
        setSessionToken(data.session_token || '');
        setMustChangePassword(Boolean(data.must_change_password));
        await loadAllData(data.csrf_token, data.session_token);
      } else {
        setLoginError(data?.detail || 'Ошибка авторизации');
      }
    } else {
      const err = await res.json().catch(() => ({}));
      setLoginError(err?.detail || 'Ошибка авторизации');
    }
  };

  const handleChangeInitialPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setInitPwStatus('');
    const res = await apiFetch('/api/auth/change_initial_password', {
      method: 'POST',
      body: JSON.stringify({ new_password: initPwInput }),
    });
    if (res.ok) {
      setMustChangePassword(false);
      setInitPwInput('');
      setInitPwStatus('');
    } else {
      const err = await res.json().catch(() => ({}));
      setInitPwStatus(err.detail || 'Не удалось сменить пароль');
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    setAuthenticated(false);
    setCsrfToken('');
    setSessionToken('');
  };

  const handleStartProject = async (id: number) => {
    const res = await apiFetch(`/api/projects/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const data = await res.json();
    await loadAllData();
    return data;
  };

  const handleStopProject = async (id: number) => {
    const res = await apiFetch(`/api/projects/${id}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const data = await res.json();
    await loadAllData();
    return data;
  };

  const handleRestartProject = async (id: number) => {
    const res = await apiFetch(`/api/projects/${id}/restart`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const data = await res.json();
    await loadAllData();
    return data;
  };

  const handleCreateProject = async (payload: Record<string, any>) => {
    const { initial_cookies_json, create_from_github, ...projectPayload } = payload;

    if (create_from_github) {
      const res = await apiFetch('/api/projects/git_clone', {
        method: 'POST',
        body: JSON.stringify(projectPayload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Ошибка клонирования GitHub-репозитория');
      }
      const created: ProjectItem = await res.json();
      if (initial_cookies_json) {
        await apiFetch(`/api/projects/${created.id}/cookies`, {
          method: 'POST',
          body: JSON.stringify({
            name: `${created.name}_cookies`,
            cookies_json: initial_cookies_json,
          }),
        });
      }
      await loadAllData();
      setSelectedProject(created);
      setWorkspaceSubTab('terminal_git');
      setActiveTab('projects');
      return;
    }

    const res = await apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify(projectPayload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Ошибка создания проекта');
    }
    const created: ProjectItem = await res.json();

    // Если в мастере создания сразу вставили индивидуальные куки — сохраняем их для этого проекта
    if (initial_cookies_json) {
      await apiFetch(`/api/projects/${created.id}/cookies`, {
        method: 'POST',
        body: JSON.stringify({
          name: `${created.name}_cookies`,
          cookies_json: initial_cookies_json,
        }),
      });
    }

    await loadAllData();
    setSelectedProject(created);
    setWorkspaceSubTab('editor');
    setActiveTab('projects');
  };

  const handleCloneProject = async (id: number) => {
    const res = await apiFetch(`/api/projects/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const cloned: ProjectItem = await res.json();
      await loadAllData();
      setSelectedProject(cloned);
      setWorkspaceSubTab('cookies_tg');
      setActiveTab('projects');
    }
  };

  const handleUpdateProject = async (id: number, payload: Record<string, any>) => {
    const res = await apiFetch(`/api/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Ошибка сохранения настроек проекта');
    }
    const updated: ProjectItem = await res.json();
    await loadAllData();
    setSelectedProject(updated);
    return updated;
  };

  const handleDeleteProject = async (id: number) => {
    await apiFetch(`/api/projects/${id}`, { method: 'DELETE' });
    await loadAllData();
    setActiveTab('dashboard');
  };

  const handleAnswerAsk = async (askId: string, answer: string) => {
    await apiFetch(`/api/asks/${askId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
    await loadAllData();
  };

  const handleImportCookieJson = async (secretName: string, rawJson: string, targetProjectId?: number) => {
    if (targetProjectId) {
      const res = await apiFetch(`/api/projects/${targetProjectId}/cookies`, {
        method: 'POST',
        body: JSON.stringify({ name: secretName, cookies_json: rawJson }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Ошибка импорта индивидуальных куки проекта');
      }
      await loadAllData();
      return;
    }

    const res = await apiFetch('/api/secrets/cookies', {
      method: 'POST',
      body: JSON.stringify({ name: secretName, cookies_json: rawJson }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Ошибка импорта куки');
    }
    await loadAllData();
  };

  const handleSaveSecret = async (
    name: string,
    type: 'text' | 'file' | 'cookie_json',
    value: string,
    targetProjectId?: number
  ) => {
    const res = await apiFetch('/api/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, type, value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Ошибка сохранения секрета');
    }

    if (targetProjectId) {
      const proj = projects.find((p) => p.id === targetProjectId);
      if (proj) {
        const nextSecrets = Array.from(new Set([...(proj.secrets || []), name]));
        await apiFetch(`/api/projects/${targetProjectId}`, {
          method: 'PUT',
          body: JSON.stringify({ secrets: nextSecrets }),
        });
      }
    }
    await loadAllData();
  };

  const handleExpireCookie = async (name: string) => {
    await apiFetch(`/api/secrets/${encodeURIComponent(name)}/expire`, {
      method: 'POST',
      body: JSON.stringify({ note: 'Вызван сигнал hub.cookies_expired()' }),
    });
    await loadAllData();
  };

  const handleDeleteSecret = async (name: string) => {
    await apiFetch(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadAllData();
  };

  const handleTriggerDemoAsk = async () => {
    const smsProj = projects.find((p) => p.name === 'sms-auth-bot');
    if (smsProj) {
      if (smsProj.current_status === 'running' || smsProj.current_status === 'waiting_input') {
        await handleRestartProject(smsProj.id);
      } else {
        await handleStartProject(smsProj.id);
      }
      setTimeout(() => loadAllData(), 600);
    }
  };

  const handleTestHubRestartSurvival = async () => {
    const res = await apiFetch('/api/system/restart_hub_daemon', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      setRestartTestResult(data);
      await loadAllData();
    }
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-200 flex items-center justify-center">
        <span className="font-mono text-sm">Инициализация Hub (:8050)...</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#0f172a] text-slate-100 flex items-center justify-center p-4">
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl max-w-md w-full p-6">
          <div className="flex items-center gap-2.5 pb-4 border-b border-slate-800">
            <Lock className="w-5 h-5 text-indigo-400" />
            <div>
              <h1 className="text-lg font-bold text-white">Hub Control Panel</h1>
              <p className="text-xs text-slate-400">Автономная панель управления программами и скриптами</p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="mt-5 space-y-4">
            <div>
              <label htmlFor="hub-login-password" className="block text-xs text-slate-300 mb-1">
                Пароль администратора (при первом старте сохранён в <code className="font-mono text-indigo-300">data/initial_password</code>)
              </label>
              <input
                id="hub-login-password"
                type="password"
                placeholder="Введите пароль администратора..."
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            {loginError && (
              <div className="p-3 bg-red-950/70 border border-red-500/40 rounded-lg text-xs text-red-200">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              className="w-full py-2.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors cursor-pointer"
            >
              Войти в панель
            </button>
          </form>
        </div>
      </div>
    );
  }

  const currentMeta = TAB_META[activeTab];

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col pb-16 lg:pb-0">
      {/* Баннер смены начального пароля при первом входе */}
      {mustChangePassword && (
        <div className="bg-amber-950/90 border-b border-amber-500/40 px-4 py-2.5">
          <form
            onSubmit={handleChangeInitialPassword}
            className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2 text-xs text-amber-200">
              <Lock className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong>Безопасность (первый вход):</strong> вы вошли по одноразовому начальному паролю из{' '}
                <code className="font-mono bg-amber-900/60 px-1.5 py-0.5 rounded">data/initial_password</code>. Задайте постоянный пароль
                (от 6 символов):
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={initPwInput}
                onChange={(e) => setInitPwInput(e.target.value)}
                placeholder="Новый пароль (мин. 6 симв.)"
                className="bg-slate-900/90 border border-amber-500/40 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                className="px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg transition-colors cursor-pointer"
              >
                Сохранить пароль
              </button>
              <button
                type="button"
                onClick={() => setMustChangePassword(false)}
                className="px-2 py-1.5 text-xs text-amber-300/80 hover:text-white cursor-pointer"
              >
                Позже
              </button>
            </div>
            {initPwStatus && <div className="w-full text-xs text-rose-300 font-medium">{initPwStatus}</div>}
          </form>
        </div>
      )}

      {/* Глобальные тревожные баннеры (WAITING_INPUT и COOKIES_EXPIRED) */}
      <GlobalAlertBanners
        pendingAsks={dashboard?.pending_asks || []}
        expiredCookies={dashboard?.expired_cookies || []}
        onAnswerAsk={handleAnswerAsk}
        onImportCookieJson={(name, json) => handleImportCookieJson(name, json)}
      />

      <div className="flex-1 flex">
        {/* Единое боковое меню на ПК с понятными аннотациями каждого раздела (без дублирования сверху!) */}
        <aside
          aria-label="Основная навигация"
          className="hidden lg:flex w-68 shrink-0 bg-[#1e293b]/70 border-r border-slate-800 flex-col justify-between p-4"
        >
          <div className="space-y-5">
            <div className="px-2 pt-1 flex items-center justify-between border-b border-slate-800/80 pb-3.5">
              <div>
                <div className="text-base font-bold tracking-tight text-white">Hub Control Panel</div>
                <div className="text-[11px] text-slate-400">Poco X3 NFC · Ubuntu chroot</div>
              </div>
              <span className="text-xs font-mono text-indigo-300 bg-indigo-950/60 border border-indigo-500/30 px-2 py-0.5 rounded">
                :8050
              </span>
            </div>

            <nav className="space-y-1.5">
              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'dashboard'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <LayoutDashboard className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold">Обзор и Проекты</div>
                  <div
                    className={`text-[11px] leading-snug mt-0.5 ${
                      activeTab === 'dashboard' ? 'text-indigo-100' : 'text-slate-400'
                    }`}
                  >
                    Программы 24/7, задачи, Poco X3 (45–55%)
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('projects')}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'projects'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <FolderCode className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold">Проекты и Код</div>
                  <div
                    className={`text-[11px] leading-snug mt-0.5 ${
                      activeTab === 'projects' ? 'text-indigo-100' : 'text-slate-400'
                    }`}
                  >
                    Код, вход на сайте, терминал GitHub, ТГ
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('secrets')}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'secrets'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <KeyRound className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold">Куки и Секреты</div>
                  <div
                    className={`text-[11px] leading-snug mt-0.5 ${
                      activeTab === 'secrets' ? 'text-indigo-100' : 'text-slate-400'
                    }`}
                  >
                    Привязка куки к скриптам и ключи
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'settings'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <Settings className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold">Настройки и ТГ Панели</div>
                  <div
                    className={`text-[11px] leading-snug mt-0.5 ${
                      activeTab === 'settings' ? 'text-indigo-100' : 'text-slate-400'
                    }`}
                  >
                    Бот управления панелью, прокси, диск
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('acceptance')}
                className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'acceptance'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <FlaskConical className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="text-xs font-semibold">Тестовый полигон</div>
                  <div
                    className={`text-[11px] leading-snug mt-0.5 ${
                      activeTab === 'acceptance' ? 'text-indigo-100' : 'text-slate-400'
                    }`}
                  >
                    Тестовые проекты и 6 проверок ТЗ
                  </div>
                </div>
              </button>
            </nav>
          </div>

          <div className="pt-4 border-t border-slate-800 space-y-2">
            <div className="px-2 text-[11px] font-mono text-slate-400">
              Poco X3 NFC (surya) · Root 45–55%
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              Выйти из сессии
            </button>
          </div>
        </aside>

        {/* Основная рабочая область (Верхняя шапка больше НЕ дублирует вкладки меню!) */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="flex items-center justify-between gap-4 px-4 sm:px-6 py-3.5 border-b border-slate-800 bg-[#0f172a]">
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight text-white truncate">
                {currentMeta.title}
              </h1>
              <p className="text-xs text-slate-400 truncate hidden sm:block">
                {currentMeta.subtitle}
              </p>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {dashboard?.system && (
                <div className="hidden md:flex items-center gap-3 text-xs font-mono text-slate-300 bg-[#1e293b] border border-slate-800 px-3 py-1.5 rounded-lg">
                  {dashboard.hardware && (
                    <>
                      <span className="text-emerald-300">
                        Аккум.: {dashboard.hardware.battery.capacity_pct}% (45–55%)
                      </span>
                      <span className="text-slate-600">·</span>
                    </>
                  )}
                  <span>ОЗУ Hub: {dashboard.system.hub_rss_mb} МБ</span>
                  <span className="text-slate-600">·</span>
                  <span>Диск своб.: {dashboard.system.disk.free_mb} МБ</span>
                </div>
              )}

              <button
                type="button"
                onClick={() => setCreateModalOpen(true)}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Новый проект
              </button>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
            {activeTab === 'dashboard' && (
              <DashboardView
                data={dashboard}
                onStartProject={handleStartProject}
                onStopProject={handleStopProject}
                onRestartProject={handleRestartProject}
                onCloneProject={handleCloneProject}
                onOpenProjectWorkspace={(p, subTab = 'editor') => {
                  setSelectedProject(p);
                  setWorkspaceSubTab(subTab);
                  setActiveTab('projects');
                }}
                onOpenCreateModal={() => setCreateModalOpen(true)}
                onTriggerDemoAsk={handleTriggerDemoAsk}
                onTriggerDemoExpiredCookie={() => handleExpireCookie('cookie-checker-job_cookies')}
                onTestHubRestartSurvival={handleTestHubRestartSurvival}
                restartTestResult={restartTestResult}
              />
            )}

            {activeTab === 'projects' && (
              <ProjectsWorkspace
                projects={projects}
                secrets={secrets}
                selectedProject={selectedProject}
                initialSubTab={workspaceSubTab}
                onSelectProject={setSelectedProject}
                onOpenCreateModal={() => setCreateModalOpen(true)}
                onStartProject={handleStartProject}
                onStopProject={handleStopProject}
                onRestartProject={handleRestartProject}
                onUpdateProject={handleUpdateProject}
                onDeleteProject={handleDeleteProject}
                onCloneProject={handleCloneProject}
                onRefreshAll={() => loadAllData()}
                apiFetch={apiFetch}
              />
            )}

            {activeTab === 'secrets' && (
              <SecretsView
                secrets={secrets}
                projects={projects}
                onSaveSecret={handleSaveSecret}
                onImportCookieJson={handleImportCookieJson}
                onExpireCookie={handleExpireCookie}
                onDeleteSecret={handleDeleteSecret}
              />
            )}

            {(activeTab === 'settings' || activeTab === 'acceptance') && (
              <SettingsAndAcceptanceView
                mode={activeTab}
                projects={projects}
                apiFetch={apiFetch}
                onRefreshDashboard={() => loadAllData()}
                onStartProject={handleStartProject}
                onOpenProjectWorkspace={(p, tab = 'editor') => {
                  setSelectedProject(p);
                  setWorkspaceSubTab(tab);
                  setActiveTab('projects');
                }}
              />
            )}
          </main>
        </div>
      </div>

      {/* Нижний таб-бар только на мобильных экранах (< lg) */}
      <nav
        aria-label="Мобильная навигация"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-[#1e293b] border-t border-slate-800 grid grid-cols-5"
      >
        <button
          type="button"
          onClick={() => setActiveTab('dashboard')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'dashboard' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          Обзор
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('projects')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'projects' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <FolderCode className="w-4 h-4" />
          Проекты
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('secrets')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'secrets' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <KeyRound className="w-4 h-4" />
          Куки
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'settings' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <Settings className="w-4 h-4" />
          Настройки
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('acceptance')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'acceptance' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <CheckSquare className="w-4 h-4" />
          Тесты
        </button>
      </nav>

      <CreateProjectModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateProject}
      />
    </div>
  );
}

export default App;
