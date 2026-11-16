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
  Search,
  Bot,
  AlertTriangle,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  BookOpen,
} from 'lucide-react';
import { DashboardData, ProjectItem, SecretItem, WorkspaceSubTab } from './types/hub';
import { GlobalAlertBanners } from './components/GlobalAlertBanners';
import { DashboardView } from './components/DashboardView';
import { ProjectsWorkspace } from './components/ProjectsWorkspace';
import { SecretsView } from './components/SecretsView';
import { SettingsAndAcceptanceView } from './components/SettingsAndAcceptanceView';
import { AiAccessView } from './components/AiAccessView';
import { DocumentationView } from './components/DocumentationView';
import { CreateProjectModal } from './components/CreateProjectModal';
import { CommandPaletteModal } from './components/CommandPaletteModal';

type NavTab = 'dashboard' | 'projects' | 'secrets' | 'ai_access' | 'settings' | 'acceptance' | 'docs';

const TAB_META: Record<NavTab, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Обзор, Сеть и Проекты',
    subtitle: 'Мониторинг ресурсов и сетевой нагрузки RX/TX, постоянные сервисы 24/7, веб-сайты и задачи Cron',
  },
  projects: {
    title: 'Проекты, Код и Расписание',
    subtitle: 'Редактор файлов, project.yaml, индивидуальные куки, защита от crash-loop и живые логи',
  },
  secrets: {
    title: 'Куки проектов и Секреты (0600)',
    subtitle: 'Импорт куки Cookie-Editor с инспектором доменов, хранение API-ключей и привязка доступа по проектам',
  },
  ai_access: {
    title: 'Доступ ИИ (MCP и /api/v1/)',
    subtitle: 'Подключение Claude Code / Cursor / Windsurf, токены с правами, очередь подтверждений с diff и Kill-Switch',
  },
  settings: {
    title: 'Настройки Панели, Безопасность и Пользователи',
    subtitle: 'Смена пароля администратора, фильтр подсетей и Tailscale, роли RBAC, Telegram-бот и бэкап',
  },
  acceptance: {
    title: 'Тестовый полигон и Beacon Doctor',
    subtitle: 'Автономный прогон 6 проверок супервизора, диагностика среды и просмотр исходников',
  },
  docs: {
    title: 'Документация и Справочник Beacon',
    subtitle: 'Полное руководство по проектам, встроенному SDK (import beacon), кукам, супервизору и MCP с поиском',
  },
};

let previewSessionToken = '';
try {
  previewSessionToken = sessionStorage.getItem('beacon_preview_session') || '';
} catch {
  // ignore storage errors in restricted iframes
}

async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  let finalInit = init;
  if (urlStr.startsWith('/api/') && previewSessionToken) {
    const headers = new Headers(init?.headers || {});
    if (!headers.has('X-Beacon-Session')) {
      headers.set('X-Beacon-Session', previewSessionToken);
    }
    finalInit = { ...init, headers };
  }

  const res = await fetch(input, finalInit);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

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
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.session_token === 'string' && parsed.session_token) {
          previewSessionToken = parsed.session_token;
          try {
            sessionStorage.setItem('beacon_preview_session', previewSessionToken);
          } catch {
            // ignore
          }
        } else if (urlStr === '/api/auth/logout') {
          previewSessionToken = '';
          try {
            sessionStorage.removeItem('beacon_preview_session');
          } catch {
            // ignore
          }
        }
      }
      return parsed;
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
  const [userRole, setUserRole] = useState<string>('admin');
  const [username, setUsername] = useState<string>('admin');
  const [isDefaultPassword, setIsDefaultPassword] = useState<boolean>(false);
  const [quickPwInput, setQuickPwInput] = useState<string>('');
  const [quickPwMsg, setQuickPwMsg] = useState<string>('');

  const [loginUsername, setLoginUsername] = useState<string>('admin');
  const [loginPassword, setLoginPassword] = useState<string>('admin');
  const [loginError, setLoginError] = useState<string>('');

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [workspaceSubTab, setWorkspaceSubTab] = useState<WorkspaceSubTab>('editor');
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState<boolean>(false);
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
      return safeFetch(path, {
        ...options,
        headers,
        credentials: 'same-origin',
      });
    },
    [csrfToken]
  );

  const loadAllData = useCallback(
    async (overrideCsrf?: string) => {
      try {
        const hdrs: Record<string, string> = { Accept: 'application/json' };
        if (overrideCsrf || csrfToken) hdrs['X-CSRF-Token'] = overrideCsrf || csrfToken;

        const [dRes, sRes] = await Promise.all([
          safeFetch('/api/dashboard', { headers: hdrs, credentials: 'same-origin' }),
          safeFetch('/api/secrets', { headers: hdrs, credentials: 'same-origin' }),
        ]);

        let projectsUpdated = false;
        if (dRes.ok) {
          const dData = await dRes.json();
          if (dData && typeof dData === 'object' && 'system' in dData) {
            setDashboard(dData as DashboardData);
            if (typeof dData.system?.is_default_password === 'boolean') {
              setIsDefaultPassword(dData.system.is_default_password);
            }
            if (Array.isArray(dData.projects)) {
              const pList = dData.projects as ProjectItem[];
              setProjects(pList);
              setSelectedProject((prev) => {
                if (!prev) return pList[0] || null;
                return pList.find((x: ProjectItem) => x.id === prev.id) || pList[0] || null;
              });
              projectsUpdated = true;
            }
          }
        }
        if (!projectsUpdated) {
          const pRes = await safeFetch('/api/projects', { headers: hdrs, credentials: 'same-origin' });
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
        }
        if (sRes.ok) {
          const sData = await sRes.json();
          if (Array.isArray(sData)) {
            setSecrets(sData as SecretItem[]);
          }
        }
      } catch {
        // ignore transient network errors
      }
    },
    [csrfToken]
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
          if (data && data.__html_fallback) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          if (res.ok && data.authenticated) {
            const cToken = data.csrf_token || '';
            setAuthenticated(true);
            setCsrfToken(cToken);
            setUserRole(data.role || 'admin');
            setUsername(data.username || 'admin');
            setIsDefaultPassword(Boolean(data.is_default_password));
            await loadAllData(cToken);
            break;
          }

          // Вход с дефолтным паролем 'admin' (если ещё не изменён владельцем)
          if (data?.is_default_password) {
            const loginRes = await safeFetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ username: 'admin', password: 'admin' }),
              credentials: 'same-origin',
            });
            const loginData = await loginRes.json();
            if (loginData && loginData.__html_fallback) {
              await new Promise((r) => setTimeout(r, 600));
              continue;
            }
            if (loginRes.ok && loginData && loginData.authenticated) {
              const cToken = loginData.csrf_token || '';
              setAuthenticated(true);
              setCsrfToken(cToken);
              setUserRole(loginData.role || 'admin');
              setUsername(loginData.username || 'admin');
              setIsDefaultPassword(Boolean(loginData.is_default_password));
              await loadAllData(cToken);
            }
          }
          break;
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
      body: JSON.stringify({ username: loginUsername.trim() || 'admin', password: loginPassword }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.authenticated) {
        const cToken = data.csrf_token || '';
        setAuthenticated(true);
        setCsrfToken(cToken);
        setUserRole(data.role || 'admin');
        setUsername(data.username || 'admin');
        setIsDefaultPassword(Boolean(data.is_default_password));
        await loadAllData(cToken);
      } else {
        setLoginError(data?.detail || 'Ошибка авторизации');
      }
    } else {
      const err = await res.json().catch(() => ({}));
      setLoginError(err?.detail || 'Ошибка авторизации');
    }
  };

  const handleQuickChangeDefaultPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setQuickPwMsg('');
    const res = await apiFetch('/api/auth/change_initial_password', {
      method: 'POST',
      body: JSON.stringify({ new_password: quickPwInput }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const nextCsrf = data?.csrf_token || csrfToken;
      if (data?.csrf_token) setCsrfToken(data.csrf_token);
      setIsDefaultPassword(false);
      setQuickPwInput('');
      setQuickPwMsg('');
      await loadAllData(nextCsrf);
    } else {
      const err = await res.json().catch(() => ({}));
      setQuickPwMsg(err.detail || 'Не удалось сменить пароль (минимум 8 символов)');
    }
  };

  const handleToggleAiPauseHeader = async () => {
    const currentlyPaused = Boolean(dashboard?.system?.ai_access_paused);
    const res = await apiFetch('/api/ai/pause', {
      method: 'POST',
      body: JSON.stringify({ paused: !currentlyPaused }),
    });
    if (res.ok) {
      await loadAllData();
    }
  };

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    previewSessionToken = '';
    try {
      sessionStorage.removeItem('beacon_preview_session');
    } catch {
      // ignore
    }
    setAuthenticated(false);
    setCsrfToken('');
  };

  const handleStartProject = async (id: number, params?: Record<string, string>) => {
    const res = await apiFetch(`/api/projects/${id}/start`, {
      method: 'POST',
      body: JSON.stringify(params ? { params } : {}),
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
      const resData = await res.json();
      const created: ProjectItem = resData.project || resData;
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
      const data = await res.json();
      const cloned: ProjectItem = data.project || data;
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

  const handleDeleteProject = async (id: number, deleteFiles: boolean = false) => {
    const query = deleteFiles ? '?delete_files=true' : '';
    await apiFetch(`/api/projects/${id}${query}`, { method: 'DELETE' });
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
      body: JSON.stringify({ note: 'Вызван сигнал beacon.cookies_expired()' }),
    });
    await loadAllData();
  };

  const handleDeleteSecret = async (name: string) => {
    await apiFetch(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadAllData();
  };

  useEffect(() => {
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }

      if (e.key === 'Escape') {
        setCommandPaletteOpen((prev) => (prev ? false : prev));
        setCreateModalOpen((prev) => (prev ? false : prev));
        return;
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const codeMap: Record<string, NavTab> = {
          Digit1: 'dashboard',
          Digit2: 'projects',
          Digit3: 'secrets',
          Digit4: 'ai_access',
          Digit5: 'settings',
          Digit6: 'acceptance',
          Digit7: 'docs',
          '1': 'dashboard',
          '2': 'projects',
          '3': 'secrets',
          '4': 'ai_access',
          '5': 'settings',
          '6': 'acceptance',
          '7': 'docs',
        };
        const targetTab = codeMap[e.code] || codeMap[e.key];
        if (targetTab) {
          e.preventDefault();
          setActiveTab(targetTab);
        }
      }
    };
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, []);

  const handleImportExamples = async () => {
    const res = await apiFetch('/api/projects/import_examples', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      await loadAllData();
    }
  };

  const handleTriggerDemoAsk = async () => {
    let smsProj = projects.find((p) => p.name === 'sms-auth-bot');
    if (!smsProj) {
      await handleImportExamples();
      const pRes = await apiFetch('/api/projects');
      if (pRes.ok) {
        const list = (await pRes.json()) as ProjectItem[];
        smsProj = list.find((p) => p.name === 'sms-auth-bot');
      }
    }
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
      <div className="min-h-screen bg-[#0b0f17] text-slate-200 flex items-center justify-center">
        <span className="font-mono text-sm">Инициализация Beacon Control Panel...</span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#0b0f17] text-slate-100 flex items-center justify-center p-4">
        <div className="bg-[#111622] border border-slate-800 rounded-xl max-w-md w-full p-6">
          <div className="flex items-center gap-2.5 pb-4 border-b border-slate-800">
            <Lock className="w-5 h-5 text-indigo-400" />
            <div>
              <h1 className="text-lg font-bold text-white">Beacon Control Panel</h1>
              <p className="text-xs text-slate-400">Lightweight Operations Console & MCP Server</p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="mt-5 space-y-4">
            <div>
              <label htmlFor="beacon-login-username" className="block text-xs text-slate-300 mb-1">
                Имя пользователя
              </label>
              <input
                id="beacon-login-username"
                type="text"
                placeholder="admin"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label htmlFor="beacon-login-password" className="block text-xs text-slate-300 mb-1">
                Пароль (по умолчанию <code className="font-mono text-indigo-300">admin</code>, меняется в разделе «Настройки»)
              </label>
              <input
                id="beacon-login-password"
                type="password"
                placeholder="Введите пароль..."
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
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
  const envLabel = dashboard?.system?.env_profile?.env_label || 'Linux / Containerless PaaS';
  const pendingAiApprovalsCount = dashboard?.system?.pending_ai_approvals_count || 0;

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-[#0b0f17] text-slate-100 flex flex-col pb-16 lg:pb-0">
      {/* Постоянный жёлтый баннер при использовании пароля по умолчанию 'admin' (Фаза A.1(в)) */}
      {isDefaultPassword && (
        <div
          role="region"
          aria-label="Предупреждение о пароле по умолчанию"
          className="bg-amber-950/90 border-b border-amber-500/50 px-4 py-2.5"
        >
          <form
            onSubmit={handleQuickChangeDefaultPassword}
            className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2.5 text-xs text-amber-100">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong className="text-amber-300">Внимание: используется стандартный пароль «admin»!</strong> Вход
                ограничен локальной сетью (RFC1918/loopback), а доступ для ИИ (MCP) заблокирован. Задайте новый пароль
                (мин. 8 символов):
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={quickPwInput}
                onChange={(e) => setQuickPwInput(e.target.value)}
                placeholder="Новый пароль (от 8 симв.)"
                className="bg-slate-950/90 border border-amber-500/50 rounded-lg px-3 py-1 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                className="px-3 py-1 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg transition-colors cursor-pointer"
              >
                Сменить пароль
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className="px-2.5 py-1 text-xs text-amber-300 hover:text-white underline cursor-pointer"
              >
                В Настройки
              </button>
            </div>
            {quickPwMsg && <div className="w-full text-xs text-rose-300 font-medium">{quickPwMsg}</div>}
          </form>
        </div>
      )}

      {/* Баннер безопасного режима (--safe-mode) */}
      {dashboard?.system?.safe_mode && (
        <div className="bg-indigo-950/90 border-b border-indigo-500/40 px-4 py-2 text-xs text-indigo-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-indigo-400" />
            <span>
              <strong>Безопасный режим (Safe Mode) активен:</strong> автоматический запуск сервисов и фоновых задач по
              расписанию временно отключён.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className="text-indigo-300 hover:text-white underline cursor-pointer"
          >
            Отключить в Настройках
          </button>
        </div>
      )}

      {/* Красный баннер при запуске проектов от имени root */}
      {dashboard?.system?.run_as_user === 'root' && (
        <div
          role="region"
          aria-label="Предупреждение о запуске проектов от root"
          className="bg-red-950/90 border-b border-red-500/50 px-4 py-2 text-xs text-red-100"
        >
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
              <span>
                <strong className="text-red-300">ERROR: Проекты запускаются от root!</strong> Для изоляции процессов создайте непривилегированного пользователя{' '}
                <code className="font-mono bg-slate-950/80 px-1.5 py-0.5 rounded text-red-200">
                  useradd -r -s /usr/sbin/nologin beacon-runner
                </code>{' '}
                и выберите его в Настройках.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className="text-red-200 hover:text-white underline cursor-pointer shrink-0"
            >
              Переключить в Настройках
            </button>
          </div>
        </div>
      )}

      {/* Глобальные тревожные баннеры (WAITING_INPUT и COOKIES_EXPIRED) */}
      <GlobalAlertBanners
        pendingAsks={dashboard?.pending_asks || []}
        expiredCookies={dashboard?.expired_cookies || []}
        onAnswerAsk={handleAnswerAsk}
        onImportCookieJson={(name, json) => handleImportCookieJson(name, json)}
      />

      <div className="flex-1 flex min-h-0">
        {/* Боковая панель Beacon Control Panel */}
        <aside
          aria-label="Основная навигация"
          className="hidden lg:flex w-68 shrink-0 bg-[#111622] border-r border-slate-800/90 flex-col justify-between p-3.5 h-full overflow-y-auto"
        >
          <div className="space-y-3.5">
            <div className="px-2 pt-0.5 flex items-center justify-between border-b border-slate-800/80 pb-2.5">
              <div className="min-w-0">
                <div className="text-base font-bold tracking-tight text-white">Beacon Control Panel</div>
                <div className="text-[11px] text-slate-400 truncate" title={envLabel}>
                  {envLabel}
                </div>
              </div>
              <span className="text-xs font-mono text-indigo-300 tabular-nums shrink-0">v2.2</span>
            </div>

            {/* Кнопка быстрого вызова командной палитры Ctrl+K */}
            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
              className="w-full flex items-center justify-between gap-2 px-3 py-1.5 bg-[#0b0f17] hover:bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-300 transition-colors cursor-pointer"
            >
              <span className="inline-flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-indigo-400" />
                <span>Поиск и команды...</span>
              </span>
              <kbd className="text-[10px] font-mono text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                Ctrl+K
              </kbd>
            </button>

            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                title="Перейти на Дашборд (Alt+1)"
                className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'dashboard'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <LayoutDashboard className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Дашборд и Реестр</div>
                    <div
                      className={`text-[11px] leading-snug mt-0.5 truncate ${
                        activeTab === 'dashboard' ? 'text-indigo-100' : 'text-slate-400'
                      }`}
                    >
                      Services 24/7, Web API (:PORT), Jobs
                    </div>
                  </div>
                </div>
                <kbd className="text-[10px] font-mono opacity-60 shrink-0 mt-0.5">Alt+1</kbd>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('projects')}
                title="Перейти в Проекты и Консоль (Alt+2)"
                className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'projects'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <FolderCode className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Проекты и Консоль</div>
                    <div
                      className={`text-[11px] leading-snug mt-0.5 truncate ${
                        activeTab === 'projects' ? 'text-indigo-100' : 'text-slate-400'
                      }`}
                    >
                      Код, project.yaml, живые логи, stdin
                    </div>
                  </div>
                </div>
                <kbd className="text-[10px] font-mono opacity-60 shrink-0 mt-0.5">Alt+2</kbd>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('secrets')}
                title="Перейти в Куки и Секреты (Alt+3)"
                className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'secrets'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <KeyRound className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Куки и Секреты (0600)</div>
                    <div
                      className={`text-[11px] leading-snug mt-0.5 truncate ${
                        activeTab === 'secrets' ? 'text-indigo-100' : 'text-slate-400'
                      }`}
                    >
                      Изоляция секретов и Cookie-Editor
                    </div>
                  </div>
                </div>
                <kbd className="text-[10px] font-mono opacity-60 shrink-0 mt-0.5">Alt+3</kbd>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('ai_access')}
                title="Перейти в Доступ ИИ (Alt+4)"
                className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'ai_access'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <Bot className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Доступ ИИ (MCP)</div>
                    <div
                      className={`text-[11px] leading-snug mt-0.5 truncate ${
                        activeTab === 'ai_access' ? 'text-indigo-100' : 'text-slate-400'
                      }`}
                    >
                      Токены, diff-одобрение, Kill-Switch
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                  {pendingAiApprovalsCount > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono font-bold bg-amber-500 text-slate-950 rounded-full">
                      {pendingAiApprovalsCount}
                    </span>
                  )}
                  <kbd className="text-[10px] font-mono opacity-60">Alt+4</kbd>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                title="Перейти в Настройки (Alt+5)"
                className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'settings'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <Settings className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Настройки, Пароль и RBAC</div>
                    <div
                      className={`text-[11px] leading-snug mt-0.5 truncate ${
                        activeTab === 'settings' ? 'text-indigo-100' : 'text-slate-400'
                      }`}
                    >
                      Смена пароля, Tailscale, роли, бэкап
                    </div>
                  </div>
                </div>
                <kbd className="text-[10px] font-mono opacity-60 shrink-0 mt-0.5">Alt+5</kbd>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('acceptance')}
                title="Перейти в Приёмку и Doctor (Alt+6)"
                className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                  activeTab === 'acceptance'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <FlaskConical className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold">Приёмка и Doctor</div>
                    <div
                      className={`text-[11px] leading-snug mt-0.5 truncate ${
                        activeTab === 'acceptance' ? 'text-indigo-100' : 'text-slate-400'
                      }`}
                    >
                      Автотесты ТЗ и диагностика среды
                    </div>
                  </div>
                </div>
                <kbd className="text-[10px] font-mono opacity-60 shrink-0 mt-0.5">Alt+6</kbd>
              </button>
            </nav>
          </div>

          <div className="pt-2.5 border-t border-slate-800 space-y-1.5 mt-2">
            {/* Вкладка документации в левом нижнем углу меню */}
            <button
              type="button"
              onClick={() => setActiveTab('docs')}
              title="Открыть Документацию по панели (Alt+7)"
              className={`w-full flex items-start justify-between gap-2 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                activeTab === 'docs'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900/90 text-slate-200 hover:bg-slate-800 hover:text-white border border-indigo-500/30'
              }`}
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <BookOpen className={`w-4 h-4 mt-0.5 shrink-0 ${activeTab === 'docs' ? 'text-white' : 'text-indigo-400'}`} />
                <div className="min-w-0">
                  <div className="text-xs font-semibold">Документация по панели</div>
                  <div
                    className={`text-[11px] leading-snug mt-0.5 truncate ${
                      activeTab === 'docs' ? 'text-indigo-100' : 'text-slate-400'
                    }`}
                  >
                    Разделы, SDK, примеры и поиск
                  </div>
                </div>
              </div>
              <kbd className="text-[10px] font-mono opacity-60 shrink-0 mt-0.5">Alt+7</kbd>
            </button>

            <div className="px-2 pt-0.5 flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span className="truncate">
                {username} ({userRole})
              </span>
              <span>{dashboard?.system?.env_profile?.arch || 'linux'}</span>
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

        {/* Основная рабочая область */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-y-auto">
          <header className="flex items-center justify-between gap-4 px-4 sm:px-6 py-3.5 border-b border-slate-800/90 bg-[#0b0f17]">
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight text-white truncate">{currentMeta.title}</h1>
              <p className="text-xs text-slate-400 truncate hidden sm:block">{currentMeta.subtitle}</p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              {dashboard?.system && (
                <div className="hidden md:flex items-center gap-2 text-xs font-mono text-slate-300 tabular-nums">
                  {dashboard.system.hardware?.available && dashboard.system.hardware.battery_percent !== null && (
                    <>
                      <span className="text-emerald-300">АКБ {dashboard.system.hardware.battery_percent}%</span>
                      <span className="text-slate-600" aria-hidden="true">
                        ·
                      </span>
                    </>
                  )}
                  <span>Beacon {dashboard.system.hub_rss_mb} МБ</span>
                  <span className="text-slate-600" aria-hidden="true">
                    ·
                  </span>
                  <span>Диск {dashboard.system.disk.free_mb} МБ</span>
                </div>
              )}

              {/* Кнопка экстренной блокировки ИИ (Пауза ИИ) в шапке (Фаза B.6) */}
              <button
                type="button"
                onClick={handleToggleAiPauseHeader}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  dashboard?.system?.ai_access_paused
                    ? 'bg-amber-950/80 text-amber-300 border-amber-500/50 hover:bg-amber-900'
                    : 'bg-[#111622] text-slate-300 hover:text-white border-slate-800'
                }`}
                title="Мгновенно заблокировать или возобновить все запросы ИИ (/mcp и /api/v1/)"
              >
                {dashboard?.system?.ai_access_paused ? (
                  <>
                    <PlayCircle className="w-3.5 h-3.5 text-amber-400" />
                    <span className="hidden sm:inline">ИИ на паузе</span>
                  </>
                ) : (
                  <>
                    <PauseCircle className="w-3.5 h-3.5 text-rose-400" />
                    <span className="hidden sm:inline">Пауза ИИ</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => setCommandPaletteOpen(true)}
                className="px-2.5 py-1.5 text-xs font-mono text-slate-300 hover:text-white bg-[#111622] border border-slate-800 rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                title="Открыть командную палитру (Ctrl+K)"
              >
                <Search className="w-3.5 h-3.5 text-indigo-400" />
                <span className="hidden sm:inline">Ctrl+K</span>
              </button>

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

          <main className="flex-1 p-3.5 sm:p-5 max-w-[1920px] w-full mx-auto">
            {activeTab === 'dashboard' && (
              <DashboardView
                data={dashboard}
                onStartProject={handleStartProject}
                onStopProject={handleStopProject}
                onRestartProject={handleRestartProject}
                onCloneProject={handleCloneProject}
                onImportExamples={handleImportExamples}
                onOpenCommandPalette={() => setCommandPaletteOpen(true)}
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
                system={dashboard?.system || null}
                selectedProject={selectedProject}
                initialSubTab={workspaceSubTab}
                onSelectProject={setSelectedProject}
                onOpenCreateModal={() => setCreateModalOpen(true)}
                onImportExamples={handleImportExamples}
                onStartProject={handleStartProject}
                onStopProject={handleStopProject}
                onRestartProject={handleRestartProject}
                onUpdateProject={handleUpdateProject}
                onDeleteProject={handleDeleteProject}
                onCloneProject={handleCloneProject}
                onRefreshAll={() => loadAllData()}
                onOpenSecretsVault={() => setActiveTab('secrets')}
                apiFetch={apiFetch}
              />
            )}

            {activeTab === 'secrets' && (
              <SecretsView
                secrets={secrets}
                projects={projects}
                pendingAsks={dashboard?.pending_asks || []}
                onAnswerAsk={handleAnswerAsk}
                onSaveSecret={handleSaveSecret}
                onImportCookieJson={handleImportCookieJson}
                onExpireCookie={handleExpireCookie}
                onDeleteSecret={handleDeleteSecret}
                onUpdateProject={handleUpdateProject}
              />
            )}

            {activeTab === 'ai_access' && (
              <AiAccessView
                projects={projects}
                apiFetch={apiFetch}
                aiAccessPaused={Boolean(dashboard?.system?.ai_access_paused)}
                isDefaultPassword={isDefaultPassword}
                userRole={userRole}
                onRefreshDashboard={() => loadAllData()}
                onOpenSettingsTab={() => setActiveTab('settings')}
              />
            )}

            {(activeTab === 'settings' || activeTab === 'acceptance') && (
              <SettingsAndAcceptanceView
                mode={activeTab}
                projects={projects}
                apiFetch={apiFetch}
                isDefaultPassword={isDefaultPassword}
                currentUsername={username}
                onCsrfUpdate={(token) => setCsrfToken(token)}
                onRefreshDashboard={() => loadAllData()}
                onStartProject={handleStartProject}
                onOpenProjectWorkspace={(p, tab = 'editor') => {
                  setSelectedProject(p);
                  setWorkspaceSubTab(tab);
                  setActiveTab('projects');
                }}
              />
            )}

            {activeTab === 'docs' && (
              <DocumentationView onNavigateTab={(tab) => setActiveTab(tab)} />
            )}
          </main>
        </div>
      </div>

      {/* Нижний таб-бар только на мобильных экранах (< lg) */}
      <nav
        aria-label="Мобильная навигация"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-[#111622] border-t border-slate-800 grid grid-cols-7"
      >
        <button
          type="button"
          onClick={() => setActiveTab('dashboard')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'dashboard' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          Дашборд
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
          Секреты
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('ai_access')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'ai_access' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <Bot className="w-4 h-4" />
          MCP / ИИ
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
          Doctor
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('docs')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${
            activeTab === 'docs' ? 'text-indigo-400' : 'text-slate-400'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          Справка
        </button>
      </nav>

      <CreateProjectModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreate={handleCreateProject}
      />

      <CommandPaletteModal
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        projects={projects}
        onNavigateTab={(tab) => setActiveTab(tab as NavTab)}
        onOpenProject={(p, subTab = 'editor') => {
          setSelectedProject(p);
          setWorkspaceSubTab(subTab);
          setActiveTab('projects');
        }}
        onStartProject={handleStartProject}
        onStopProject={handleStopProject}
        onRestartProject={handleRestartProject}
        onOpenCreateModal={() => setCreateModalOpen(true)}
        onImportExamples={handleImportExamples}
        onTestHubRestartSurvival={handleTestHubRestartSurvival}
      />
    </div>
  );
}

export default App;
