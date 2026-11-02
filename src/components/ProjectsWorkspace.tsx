import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Save,
  Package,
  FileCode,
  Folder,
  FolderPlus,
  FilePlus,
  Trash2,
  Upload,
  Settings2,
  Terminal,
  Plus,
  Check,
  Copy,
  RefreshCw,
  Cookie,
  Send,
  Clock,
  Bot,
  Sliders,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import { FileTreeNode, ProjectItem, RunItem, SecretItem } from '../types/hub';
import {
  describeScheduleHuman,
  formatBytes,
  validateCookieEditorJson,
  validateScheduleConfig,
} from '../utils/hubLogic';

export type WorkspaceSubTab = 'editor' | 'cookies_tg' | 'simple_cfg' | 'advanced_cfg';

interface ProjectsWorkspaceProps {
  projects: ProjectItem[];
  secrets: SecretItem[];
  selectedProject: ProjectItem | null;
  initialSubTab?: WorkspaceSubTab;
  onSelectProject: (p: ProjectItem) => void;
  onOpenCreateModal: () => void;
  onStartProject: (id: number) => Promise<any>;
  onStopProject: (id: number) => Promise<any>;
  onRestartProject: (id: number) => Promise<any>;
  onUpdateProject: (id: number, payload: Record<string, any>) => Promise<ProjectItem>;
  onDeleteProject: (id: number) => Promise<void>;
  onRefreshAll: () => Promise<void>;
  apiFetch: (path: string, options?: RequestInit) => Promise<Response>;
}

const SAMPLE_PROJECT_COOKIES = JSON.stringify(
  [
    {
      domain: '.example.com',
      name: 'session_id',
      value: 'project_individual_cookie_99182',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  ],
  null,
  2
);

export const ProjectsWorkspace: React.FC<ProjectsWorkspaceProps> = ({
  projects,
  secrets,
  selectedProject,
  initialSubTab = 'editor',
  onSelectProject,
  onOpenCreateModal,
  onStartProject,
  onStopProject,
  onRestartProject,
  onUpdateProject,
  onDeleteProject,
  onRefreshAll,
  apiFetch,
}) => {
  const activeProj = selectedProject || projects[0] || null;

  const [subTab, setSubTab] = useState<WorkspaceSubTab>(initialSubTab);
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [currentFilePath, setCurrentFilePath] = useState<string>('');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileDirty, setFileDirty] = useState<boolean>(false);
  const [savingFile, setSavingFile] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [showSdkHints, setShowSdkHints] = useState<boolean>(false);

  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [clearingLogs, setClearingLogs] = useState<boolean>(false);

  const [newFileName, setNewFileName] = useState<string>('');
  const [showNewFileInput, setShowNewFileInput] = useState<'file' | 'dir' | null>(null);
  const [mobileFilesDrawer, setMobileFilesDrawer] = useState<boolean>(false);

  // Поля конфигурации проекта (Простые + Расширенные)
  const [cfgDescription, setCfgDescription] = useState<string>('');
  const [cfgCmd, setCfgCmd] = useState<string>('');
  const [cfgType, setCfgType] = useState<'job' | 'service'>('service');
  const [cfgRuntime, setCfgRuntime] = useState<'python' | 'node' | 'bash' | 'custom'>('python');
  const [cfgUseProxy, setCfgUseProxy] = useState<boolean>(false);
  const [cfgRamLimit, setCfgRamLimit] = useState<number>(0);
  const [cfgScheduleType, setCfgScheduleType] = useState<'manual' | 'cron' | 'interval'>('manual');
  const [cfgScheduleExpr, setCfgScheduleExpr] = useState<string>('');
  const [cfgTimeoutSec, setCfgTimeoutSec] = useState<number>(0);
  const [cfgMaxRetries, setCfgMaxRetries] = useState<number>(0);
  const [cfgRetryDelay, setCfgRetryDelay] = useState<number>(30);
  const [cfgAutostart, setCfgAutostart] = useState<boolean>(false);
  const [cfgRestartPolicy, setCfgRestartPolicy] = useState<'no' | 'on-failure' | 'always'>('on-failure');
  const [cfgBackoffMin, setCfgBackoffMin] = useState<number>(2);
  const [cfgBackoffMax, setCfgBackoffMax] = useState<number>(300);
  const [cfgNotifyError, setCfgNotifyError] = useState<boolean>(true);
  const [cfgNotifySuccess, setCfgNotifySuccess] = useState<boolean>(false);
  const [cfgSecrets, setCfgSecrets] = useState<string[]>([]);
  const [cfgEnvJson, setCfgEnvJson] = useState<string>('{}');
  const [cfgError, setCfgError] = useState<string>('');
  const [cfgSaved, setCfgSaved] = useState<boolean>(false);
  const [copiedWebhook, setCopiedWebhook] = useState<boolean>(false);

  // Визуальный конструктор расписания (для простых настроек)
  const [schedBuilderMode, setSchedBuilderMode] = useState<'manual' | 'minutes' | 'hours' | 'daily' | 'custom'>('minutes');
  const [schedMinutes, setSchedMinutes] = useState<number>(15);
  const [schedHours, setSchedHours] = useState<number>(1);
  const [schedDailyTime, setSchedDailyTime] = useState<string>('09:00');

  // Индивидуальные Куки и данные Telegram самого проекта
  const [projCookieJson, setProjCookieJson] = useState<string>(SAMPLE_PROJECT_COOKIES);
  const [projCookieMsg, setProjCookieMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [projBotToken, setProjBotToken] = useState<string>('');
  const [projChatId, setProjChatId] = useState<string>('');
  const [projApiId, setProjApiId] = useState<string>('');
  const [projApiHash, setProjApiHash] = useState<string>('');
  const [projTgMsg, setProjTgMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const logContainerRef = useRef<HTMLPreElement | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  const loadFilesAndRuns = async (proj: ProjectItem) => {
    try {
      const [filesRes, runsRes] = await Promise.all([
        apiFetch(`/api/projects/${proj.id}/files`),
        apiFetch(`/api/projects/${proj.id}/runs`),
      ]);
      if (filesRes.ok) {
        const fData = await filesRes.json();
        const tree: FileTreeNode[] = fData.tree || [];
        setFileTree(tree);
        const firstFile = findFirstFile(tree);
        if (firstFile) {
          await openFile(proj.id, firstFile.path);
        } else {
          setCurrentFilePath('');
          setFileContent('');
        }
      }
      if (runsRes.ok) {
        const rList: RunItem[] = await runsRes.json();
        setRuns(rList);
        const targetRun = proj.active_run_id || (rList[0] ? rList[0].id : null);
        setSelectedRunId(targetRun);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const syncConfigState = (proj: ProjectItem) => {
    const envObj = proj.env || {};
    setCfgDescription(String(envObj.PROJECT_DESCRIPTION || proj.description || ''));
    setCfgCmd(proj.cmd);
    setCfgType(proj.type);
    setCfgRuntime(proj.runtime);
    setCfgUseProxy(proj.use_proxy === 1);
    setCfgRamLimit(proj.ram_limit_mb);
    setCfgScheduleType(proj.schedule_type);
    setCfgScheduleExpr(proj.schedule_expr);
    setCfgTimeoutSec(proj.timeout_sec);
    setCfgMaxRetries(proj.max_retries);
    setCfgRetryDelay(proj.retry_delay_sec);
    setCfgAutostart(proj.autostart === 1);
    setCfgRestartPolicy(proj.restart_policy);
    setCfgBackoffMin(proj.backoff_min_sec);
    setCfgBackoffMax(proj.backoff_max_sec);
    setCfgNotifyError(proj.notify_on_error === 1);
    setCfgNotifySuccess(proj.notify_on_success === 1);
    setCfgSecrets(proj.secrets || []);
    setCfgEnvJson(proj.env_json || '{}');
    setCfgError('');

    // Синхронизируем поля Telegram этого проекта
    setProjBotToken(String(envObj.BOT_TOKEN || ''));
    setProjChatId(String(envObj.TG_CHAT_ID || ''));
    setProjApiId(String(envObj.TG_API_ID || ''));
    setProjApiHash(String(envObj.TG_API_HASH || ''));
    setProjCookieMsg(null);
    setProjTgMsg(null);

    // Определяем пресет конструктора расписания
    if (proj.schedule_type === 'manual') {
      setSchedBuilderMode('manual');
    } else if (proj.schedule_type === 'interval') {
      const sec = Number(proj.schedule_expr || 0);
      if (sec >= 3600 && sec % 3600 === 0) {
        setSchedBuilderMode('hours');
        setSchedHours(sec / 3600);
      } else {
        setSchedBuilderMode('minutes');
        setSchedMinutes(Math.max(1, Math.round(sec / 60)));
      }
    } else if (proj.schedule_type === 'cron') {
      const parts = (proj.schedule_expr || '').trim().split(/\s+/);
      if (parts.length === 5 && parts[0].startsWith('*/') && parts[1] === '*') {
        setSchedBuilderMode('minutes');
        setSchedMinutes(Number(parts[0].slice(2)) || 15);
      } else if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*') {
        setSchedBuilderMode('daily');
        setSchedDailyTime(`${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`);
      } else {
        setSchedBuilderMode('custom');
      }
    }
  };

  useEffect(() => {
    if (activeProj) {
      syncConfigState(activeProj);
      loadFilesAndRuns(activeProj);
    }
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [activeProj?.id]);

  // Живой лог (SSE)
  useEffect(() => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    if (!selectedRunId) {
      setLogText('// Запусков пока нет. Нажмите зелёную кнопку «Старт» вверху справа.');
      setIsStreaming(false);
      return;
    }

    let cancelled = false;

    const connectLog = async () => {
      const res = await apiFetch(`/api/runs/${selectedRunId}/log`);
      if (!res.ok || cancelled) return;
      const data = await res.json();
      setLogText(data.log || '');

      if (data.status === 'running' || data.status === 'waiting_input') {
        setIsStreaming(true);
        const es = new EventSource(`/api/runs/${selectedRunId}/stream`);
        sseRef.current = es;
        let accumulated = '';

        es.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'log') {
              accumulated += msg.data;
              setLogText(accumulated);
              if (logContainerRef.current) {
                logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
              }
            } else if (msg.type === 'status') {
              setIsStreaming(false);
              es.close();
            }
          } catch {
            // ignore keepalive
          }
        };

        es.onerror = () => {
          setIsStreaming(false);
          es.close();
        };
      } else {
        setIsStreaming(false);
      }
    };

    connectLog();

    return () => {
      cancelled = true;
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [selectedRunId]);

  const findFirstFile = (nodes: FileTreeNode[]): FileTreeNode | null => {
    for (const n of nodes) {
      if (n.type === 'file') return n;
      if (n.children) {
        const found = findFirstFile(n.children);
        if (found) return found;
      }
    }
    return null;
  };

  const openFile = async (projId: number, relPath: string) => {
    const res = await apiFetch(`/api/projects/${projId}/files/content?path=${encodeURIComponent(relPath)}`);
    if (res.ok) {
      const data = await res.json();
      setCurrentFilePath(relPath);
      setFileContent(data.content || '');
      setFileDirty(false);
      setMobileFilesDrawer(false);
    }
  };

  const handleSaveFile = async () => {
    if (!activeProj || !currentFilePath) return;
    setSavingFile(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({ path: currentFilePath, content: fileContent }),
      });
      if (res.ok) {
        setFileDirty(false);
        setSaveMessage('Файл сохранён');
        await onRefreshAll();
        setTimeout(() => setSaveMessage(''), 2000);
      }
    } finally {
      setSavingFile(false);
    }
  };

  const handleCreateFileOrDir = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newFileName.trim() || !showNewFileInput) return;
    const cleanPath = newFileName.trim();
    if (showNewFileInput === 'dir') {
      await apiFetch(`/api/projects/${activeProj.id}/files/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ path: cleanPath }),
      });
    } else {
      await apiFetch(`/api/projects/${activeProj.id}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({ path: cleanPath, content: '# Новый файл\n' }),
      });
    }
    setNewFileName('');
    setShowNewFileInput(null);
    await loadFilesAndRuns(activeProj);
    await onRefreshAll();
    if (showNewFileInput === 'file') {
      await openFile(activeProj.id, cleanPath);
    }
  };

  const handleDeleteCurrentFile = async (pathToDelete: string) => {
    if (!activeProj) return;
    await apiFetch(`/api/projects/${activeProj.id}/files?path=${encodeURIComponent(pathToDelete)}`, {
      method: 'DELETE',
    });
    await loadFilesAndRuns(activeProj);
    await onRefreshAll();
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeProj) return;
    const isZip = file.name.toLowerCase().endsWith('.zip');
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result || '').split(',')[1] || '';
      await apiFetch(`/api/projects/${activeProj.id}/files/upload`, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          content_base64: base64,
          extract: isZip,
        }),
      });
      await loadFilesAndRuns(activeProj);
      await onRefreshAll();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleClearProjectLogs = async () => {
    if (!activeProj) return;
    setClearingLogs(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/clear_logs`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        await loadFilesAndRuns(activeProj);
        await onRefreshAll();
      }
    } finally {
      setClearingLogs(false);
    }
  };

  const handleInstallDeps = async () => {
    if (!activeProj) return;
    const res = await apiFetch(`/api/projects/${activeProj.id}/install_deps`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      const runsRes = await apiFetch(`/api/projects/${activeProj.id}/runs`);
      if (runsRes.ok) setRuns(await runsRes.json());
      if (data.run?.id) setSelectedRunId(data.run.id);
    }
  };

  const handleStart = async () => {
    if (!activeProj) return;
    const res = await onStartProject(activeProj.id);
    const runsRes = await apiFetch(`/api/projects/${activeProj.id}/runs`);
    if (runsRes.ok) setRuns(await runsRes.json());
    if (res?.run?.id) setSelectedRunId(res.run.id);
  };

  const handleStop = async () => {
    if (!activeProj) return;
    await onStopProject(activeProj.id);
    const runsRes = await apiFetch(`/api/projects/${activeProj.id}/runs`);
    if (runsRes.ok) setRuns(await runsRes.json());
  };

  const handleRestart = async () => {
    if (!activeProj) return;
    const res = await onRestartProject(activeProj.id);
    const runsRes = await apiFetch(`/api/projects/${activeProj.id}/runs`);
    if (runsRes.ok) setRuns(await runsRes.json());
    if (res?.run?.id) setSelectedRunId(res.run.id);
  };

  // Сохранение индивидуальных куки именно этого проекта
  const handleSaveProjectCookies = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj) return;
    setProjCookieMsg(null);
    const check = validateCookieEditorJson(projCookieJson);
    if (!check.valid) {
      setProjCookieMsg({ type: 'err', text: check.error || 'Ошибка структуры JSON куки' });
      return;
    }

    const res = await apiFetch(`/api/projects/${activeProj.id}/cookies`, {
      method: 'POST',
      body: JSON.stringify({
        name: `${activeProj.name}_cookies`,
        cookies_json: projCookieJson,
      }),
    });
    if (res.ok) {
      await onRefreshAll();
      await loadFilesAndRuns(activeProj);
      setProjCookieMsg({
        type: 'ok',
        text: `Индивидуальные куки проекта «${activeProj.name}» сохранены (${check.cookies.length} шт. для ${check.domains.join(', ')}). Доступны в коде через hub.secret("${activeProj.name}_cookies") и в файле cookies.json.`,
      });
    } else {
      const err = await res.json().catch(() => ({}));
      setProjCookieMsg({ type: 'err', text: err.detail || 'Ошибка сохранения куки проекта' });
    }
  };

  // Сохранение индивидуальных настроек Telegram этого проекта
  const handleSaveProjectTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj) return;
    setProjTgMsg(null);
    let parsedEnv: Record<string, string> = {};
    try {
      parsedEnv = JSON.parse(cfgEnvJson || '{}');
    } catch {
      parsedEnv = { ...(activeProj.env || {}) };
    }

    if (projBotToken.trim()) parsedEnv.BOT_TOKEN = projBotToken.trim();
    else delete parsedEnv.BOT_TOKEN;

    if (projChatId.trim()) parsedEnv.TG_CHAT_ID = projChatId.trim();
    else delete parsedEnv.TG_CHAT_ID;

    if (projApiId.trim()) parsedEnv.TG_API_ID = projApiId.trim();
    else delete parsedEnv.TG_API_ID;

    if (projApiHash.trim()) parsedEnv.TG_API_HASH = projApiHash.trim();
    else delete parsedEnv.TG_API_HASH;

    try {
      const updated = await onUpdateProject(activeProj.id, {
        env: parsedEnv,
        use_proxy: cfgUseProxy ? 1 : 0,
      });
      setCfgEnvJson(updated.env_json);
      setProjTgMsg({
        type: 'ok',
        text: `Индивидуальные данные Telegram для проекта «${activeProj.name}» сохранены и будут переданы скрипту при запуске.`,
      });
    } catch (err: any) {
      setProjTgMsg({ type: 'err', text: err?.message || 'Ошибка сохранения данных Telegram' });
    }
  };

  // Применение конструктора расписания к полям cfgScheduleType / cfgScheduleExpr
  const applyBuilderToSchedule = (
    mode: typeof schedBuilderMode,
    mins: number,
    hrs: number,
    daily: string
  ) => {
    setSchedBuilderMode(mode);
    if (mode === 'manual') {
      setCfgScheduleType('manual');
      setCfgScheduleExpr('');
    } else if (mode === 'minutes') {
      const m = Math.max(1, Math.min(59, mins || 15));
      setCfgScheduleType('cron');
      setCfgScheduleExpr(`*/${m} * * * *`);
    } else if (mode === 'hours') {
      const h = Math.max(1, Math.min(24, hrs || 1));
      setCfgScheduleType('interval');
      setCfgScheduleExpr(String(h * 3600));
    } else if (mode === 'daily') {
      const [hhStr, mmStr] = (daily || '09:00').split(':');
      const hh = Math.max(0, Math.min(23, Number(hhStr) || 9));
      const mm = Math.max(0, Math.min(59, Number(mmStr) || 0));
      setCfgScheduleType('cron');
      setCfgScheduleExpr(`${mm} ${hh} * * *`);
    }
  };

  const handleSaveProjectConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj) return;
    setCfgError('');

    if (cfgType === 'job') {
      const schedCheck = validateScheduleConfig(cfgScheduleType, cfgScheduleExpr);
      if (!schedCheck.valid) {
        setCfgError(schedCheck.error || 'Ошибка расписания');
        return;
      }
    }

    let parsedEnv: Record<string, string> = {};
    try {
      parsedEnv = JSON.parse(cfgEnvJson || '{}');
    } catch {
      setCfgError('Поле переменных окружения (JSON) содержит синтаксическую ошибку');
      return;
    }

    if (cfgDescription.trim()) {
      parsedEnv.PROJECT_DESCRIPTION = cfgDescription.trim();
    }

    try {
      await onUpdateProject(activeProj.id, {
        type: cfgType,
        runtime: cfgRuntime,
        cmd: cfgCmd,
        use_proxy: cfgUseProxy ? 1 : 0,
        ram_limit_mb: cfgRamLimit,
        schedule_type: cfgScheduleType,
        schedule_expr: cfgScheduleExpr,
        timeout_sec: cfgTimeoutSec,
        max_retries: cfgMaxRetries,
        retry_delay_sec: cfgRetryDelay,
        autostart: cfgAutostart ? 1 : 0,
        restart_policy: cfgRestartPolicy,
        backoff_min_sec: cfgBackoffMin,
        backoff_max_sec: cfgBackoffMax,
        notify_on_error: cfgNotifyError ? 1 : 0,
        notify_on_success: cfgNotifySuccess ? 1 : 0,
        secrets: cfgSecrets,
        env: parsedEnv,
      });
      setCfgSaved(true);
      setTimeout(() => setCfgSaved(false), 2500);
    } catch (err: any) {
      setCfgError(err?.message || 'Ошибка сохранения настроек проекта');
    }
  };

  if (!activeProj) {
    return (
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-10 text-center">
        <p className="text-slate-300 text-sm">Проекты ещё не созданы.</p>
        <button
          type="button"
          onClick={onOpenCreateModal}
          className="mt-4 px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          Создать первый проект
        </button>
      </div>
    );
  }

  const isRunning = activeProj.current_status === 'running' || activeProj.current_status === 'waiting_input';
  const lineCount = Math.max(1, fileContent.split('\n').length);
  const cookieStatus = activeProj.cookie_status;

  const renderTreeNodes = (nodes: FileTreeNode[], depth = 0) =>
    nodes.map((node) => (
      <div key={node.path} style={{ paddingLeft: `${depth * 12}px` }}>
        {node.type === 'dir' ? (
          <div>
            <div className="flex items-center gap-1.5 py-1.5 px-2 text-xs text-slate-300 font-medium">
              <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="truncate">{node.name}</span>
            </div>
            {node.children && renderTreeNodes(node.children, depth + 1)}
          </div>
        ) : (
          <div
            className={`group flex items-center justify-between py-1.5 px-2 rounded-md text-xs transition-colors ${
              currentFilePath === node.path
                ? 'bg-indigo-600/20 text-indigo-300 font-medium'
                : 'text-slate-300 hover:bg-slate-800/70'
            }`}
          >
            <button
              type="button"
              onClick={() => openFile(activeProj.id, node.path)}
              className="flex items-center gap-1.5 truncate text-left flex-1 cursor-pointer"
            >
              <FileCode className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="font-mono truncate">{node.name}</span>
              {node.size !== undefined && (
                <span className="text-[10px] text-slate-500 font-mono ml-auto pr-1">
                  {formatBytes(node.size)}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Удалить файл ${node.name}`}
              onClick={() => handleDeleteCurrentFile(node.path)}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-500 hover:text-red-400 transition-opacity cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    ));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
      {/* ЛЕВАЯ КОЛОНКА: Наглядный список всех проектов с их типом и занимаемым местом на диске */}
      <aside className="xl:col-span-3 space-y-3">
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-3.5">
          <div className="flex items-center justify-between pb-3 mb-2.5 border-b border-slate-800">
            <div>
              <h2 className="text-xs font-bold text-white uppercase tracking-wider">Ваши проекты</h2>
              <p className="text-[11px] text-slate-400">Выберите проект для настройки</p>
            </div>
            <button
              type="button"
              onClick={onOpenCreateModal}
              className="px-2.5 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Создать
            </button>
          </div>

          <div className="space-y-1.5 max-h-[540px] overflow-y-auto pr-0.5">
            {projects.map((p) => {
              const selected = p.id === activeProj.id;
              const running = p.current_status === 'running' || p.current_status === 'waiting_input';
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelectProject(p)}
                  className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer ${
                    selected
                      ? 'bg-indigo-600/15 border-indigo-500/60 text-white'
                      : 'bg-[#0f172a]/70 border-slate-800/80 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          running
                            ? 'bg-emerald-400'
                            : p.current_status === 'failed'
                            ? 'bg-red-400'
                            : 'bg-slate-600'
                        }`}
                      />
                      <span className="font-semibold text-xs text-white truncate">{p.name}</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0">
                      {formatBytes(p.total_size_bytes || 0)}
                    </span>
                  </div>

                  <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      {p.type === 'service' ? (
                        <>
                          <Bot className="w-3 h-3 text-emerald-400" />
                          <span>Программа 24/7</span>
                        </>
                      ) : (
                        <>
                          <Clock className="w-3 h-3 text-indigo-400" />
                          <span>Скрипт по расписанию</span>
                        </>
                      )}
                    </span>
                    <span className="font-mono">{p.runtime}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* ПРАВАЯ РАБОЧАЯ ОБЛАСТЬ ПРОЕКТА */}
      <div className="xl:col-span-9 space-y-4">
        {/* Шапка выбранного проекта: название, описание, занимаемое место на диске и кнопки Старт/Стоп */}
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-white">{activeProj.name}</h2>
                {activeProj.type === 'service' ? (
                  <span className="px-2 py-0.5 text-xs font-medium bg-emerald-950/70 text-emerald-300 border border-emerald-500/30 rounded-md inline-flex items-center gap-1">
                    <Bot className="w-3 h-3" />
                    Постоянная программа 24/7
                  </span>
                ) : (
                  <span className="px-2 py-0.5 text-xs font-medium bg-indigo-950/70 text-indigo-300 border border-indigo-500/30 rounded-md inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Скрипт по расписанию / кнопке
                  </span>
                )}
                <span className="text-xs font-mono text-slate-400">
                  {describeScheduleHuman(
                    activeProj.type,
                    activeProj.schedule_type,
                    activeProj.schedule_expr,
                    activeProj.restart_policy,
                    activeProj.autostart
                  )}
                </span>
              </div>

              {activeProj.description && (
                <p className="text-xs text-slate-300">{activeProj.description}</p>
              )}

              {/* Полоска занимаемого места этим проектом на диске */}
              <div className="pt-1 flex flex-wrap items-center gap-3 text-xs text-slate-400 font-mono">
                <span className="inline-flex items-center gap-1 text-slate-200">
                  <HardDrive className="w-3.5 h-3.5 text-indigo-400" />
                  Занимает на диске: <strong>{formatBytes(activeProj.total_size_bytes || 0)}</strong>
                </span>
                <span>
                  (Файлы проекта: {formatBytes(activeProj.code_size_bytes || 0)} · Логи: {formatBytes(activeProj.logs_size_bytes || 0)})
                </span>
                {(activeProj.logs_size_bytes || 0) > 0 && (
                  <button
                    type="button"
                    disabled={clearingLogs}
                    onClick={handleClearProjectLogs}
                    className="text-amber-300 hover:underline cursor-pointer"
                  >
                    {clearingLogs ? 'Очистка...' : 'Очистить старые логи'}
                  </button>
                )}
              </div>
            </div>

            {/* Кнопки запуска, остановки и установки зависимостей */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleInstallDeps}
                title="Устанавливает библиотеки из requirements.txt или package.json"
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Package className="w-3.5 h-3.5 text-indigo-400" />
                Установить зависимости
              </button>

              {!isRunning ? (
                <button
                  type="button"
                  onClick={handleStart}
                  className="px-4 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  Старт
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleStop}
                    className="px-4 py-1.5 text-xs font-semibold bg-red-600 hover:bg-red-500 text-white rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" />
                    Стоп (PGID {activeProj.pgid})
                  </button>
                  <button
                    type="button"
                    onClick={handleRestart}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Рестарт
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 4 ПОНЯТНЫЕ ВКЛАДКИ ВНУТРИ ПРОЕКТА */}
          <div className="pt-2 border-t border-slate-800 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSubTab('editor')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                subTab === 'editor'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900/70 text-slate-300 hover:text-white'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              1. Код и Файлы
            </button>

            <button
              type="button"
              onClick={() => setSubTab('cookies_tg')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                subTab === 'cookies_tg'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900/70 text-slate-300 hover:text-white'
              }`}
            >
              <Cookie className="w-3.5 h-3.5 text-amber-400" />
              2. Куки и Telegram скрипта
              {cookieStatus?.is_expired === 1 && (
                <span className="w-2 h-2 rounded-full bg-red-400" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setSubTab('simple_cfg')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                subTab === 'simple_cfg'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900/70 text-slate-300 hover:text-white'
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-emerald-400" />
              3. Расписание и Простые настройки
            </button>

            <button
              type="button"
              onClick={() => setSubTab('advanced_cfg')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                subTab === 'advanced_cfg'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-900/70 text-slate-300 hover:text-white'
              }`}
            >
              <Sliders className="w-3.5 h-3.5 text-slate-400" />
              4. Расширенные (Для профи)
            </button>
          </div>
        </div>

        {/* СОДЕРЖИМОЕ ВКЛАДКИ 1: КОД И ФАЙЛЫ */}
        {subTab === 'editor' && (
          <div className="space-y-3">
            {/* Шпаргалка для начинающих по вызову куки и СМС в коде */}
            <div className="bg-[#1e293b] border border-slate-800 rounded-xl px-4 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-300 flex items-center gap-1.5">
                  <HelpCircle className="w-3.5 h-3.5 text-indigo-400" />
                  Подсказка: как в коде этого проекта прочитать его индивидуальные куки, Telegram-токен или запросить СМС-код?
                </span>
                <button
                  type="button"
                  onClick={() => setShowSdkHints(!showSdkHints)}
                  className="text-xs text-indigo-400 hover:underline cursor-pointer"
                >
                  {showSdkHints ? 'Скрыть примеры кода' : 'Показать готовые строчки кода'}
                </button>
              </div>
              {showSdkHints && (
                <div className="mt-2.5 pt-2.5 border-t border-slate-800 grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] font-mono text-slate-200">
                  <div className="p-2.5 bg-[#0f172a] rounded-lg border border-slate-800">
                    <div className="text-indigo-300 font-sans font-semibold mb-1">1. Прочитать куки этого проекта:</div>
                    <code>import hub</code>
                    <br />
                    <code>cookies = hub.secret("{activeProj.name}_cookies")</code>
                  </div>
                  <div className="p-2.5 bg-[#0f172a] rounded-lg border border-slate-800">
                    <div className="text-amber-300 font-sans font-semibold mb-1">2. Спросить код из СМС / 2FA:</div>
                    <code>code = hub.ask("Код из СМС?")</code>
                    <br />
                    <span className="text-slate-400 font-sans">Скрипт подождёт ваш ответ в баннере</span>
                  </div>
                  <div className="p-2.5 bg-[#0f172a] rounded-lg border border-slate-800">
                    <div className="text-emerald-300 font-sans font-semibold mb-1">3. Сообщить, что куки слетели:</div>
                    <code>hub.cookies_expired("{activeProj.name}_cookies")</code>
                    <br />
                    <span className="text-slate-400 font-sans">Включит красный баннер замены куки</span>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:hidden flex items-center justify-between bg-[#1e293b] border border-slate-800 rounded-xl px-4 py-2.5">
                <span className="text-xs font-mono text-slate-300">
                  Файл: <strong className="text-white">{currentFilePath || 'не выбран'}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => setMobileFilesDrawer(!mobileFilesDrawer)}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-indigo-300 rounded-lg cursor-pointer"
                >
                  {mobileFilesDrawer ? 'Скрыть файлы' : 'Файлы проекта'}
                </button>
              </div>

              <aside
                aria-label="Файловый менеджер проекта"
                className={`lg:col-span-3 bg-[#1e293b] border border-slate-800 rounded-xl p-3 flex flex-col justify-between ${
                  mobileFilesDrawer ? 'block' : 'hidden lg:flex'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-slate-800">
                    <span className="text-xs font-semibold text-slate-200">Файлы в папке</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title="Создать файл"
                        aria-label="Создать файл"
                        onClick={() => setShowNewFileInput('file')}
                        className="p-1 text-slate-400 hover:text-white rounded cursor-pointer"
                      >
                        <FilePlus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Создать папку"
                        aria-label="Создать папку"
                        onClick={() => setShowNewFileInput('dir')}
                        className="p-1 text-slate-400 hover:text-white rounded cursor-pointer"
                      >
                        <FolderPlus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Загрузить файл или .zip архив (распакуется сам)"
                        aria-label="Загрузить файл или архив"
                        onClick={() => fileUploadInputRef.current?.click()}
                        className="p-1 text-slate-400 hover:text-white rounded cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" />
                      </button>
                      <input
                        ref={fileUploadInputRef}
                        type="file"
                        onChange={handleUploadFile}
                        className="hidden"
                      />
                    </div>
                  </div>

                  {showNewFileInput && (
                    <form onSubmit={handleCreateFileOrDir} className="mb-2 flex items-center gap-1.5">
                      <input
                        type="text"
                        placeholder={showNewFileInput === 'dir' ? 'Имя папки...' : 'script.py'}
                        value={newFileName}
                        onChange={(e) => setNewFileName(e.target.value)}
                        className="flex-1 bg-[#0f172a] border border-slate-700 rounded px-2 py-1 text-xs font-mono text-white"
                      />
                      <button
                        type="submit"
                        className="px-2 py-1 text-xs bg-indigo-600 text-white rounded cursor-pointer"
                      >
                        OK
                      </button>
                    </form>
                  )}

                  <div className="space-y-0.5 max-h-[340px] overflow-y-auto">
                    {renderTreeNodes(fileTree)}
                  </div>
                </div>

                <div className="pt-3 mt-3 border-t border-slate-800 text-[11px] text-slate-400 font-mono truncate">
                  {activeProj.workdir}
                </div>
              </aside>

              <div className="lg:col-span-9 bg-[#1e293b] border border-slate-800 rounded-xl flex flex-col overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-mono">
                    <FileCode className="w-4 h-4 text-indigo-400" />
                    <span className="text-white font-medium">{currentFilePath || 'Выберите файл слева'}</span>
                    {fileDirty && <span className="text-amber-400">(не сохранено)</span>}
                    {saveMessage && <span className="text-emerald-400">· {saveMessage}</span>}
                  </div>

                  <button
                    type="button"
                    disabled={!currentFilePath || savingFile}
                    onClick={handleSaveFile}
                    className="px-3 py-1 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {savingFile ? 'Сохранение...' : 'Сохранить файл (Ctrl+S)'}
                  </button>
                </div>

                <div className="relative flex min-h-[300px] max-h-[400px] bg-[#0b1120] overflow-hidden">
                  <div
                    aria-hidden="true"
                    className="w-12 py-3 px-2 bg-[#080d18] border-r border-slate-800/80 text-right font-mono text-xs text-slate-500 select-none overflow-hidden leading-[1.6]"
                  >
                    {Array.from({ length: lineCount }, (_, i) => (
                      <div key={i + 1}>{i + 1}</div>
                    ))}
                  </div>
                  <textarea
                    aria-label="Редактор кода файла"
                    spellCheck={false}
                    value={fileContent}
                    onChange={(e) => {
                      setFileContent(e.target.value);
                      setFileDirty(true);
                    }}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                        e.preventDefault();
                        handleSaveFile();
                      } else if (e.key === 'Tab') {
                        e.preventDefault();
                        const start = e.currentTarget.selectionStart;
                        const end = e.currentTarget.selectionEnd;
                        const updated = fileContent.substring(0, start) + '    ' + fileContent.substring(end);
                        setFileContent(updated);
                        setFileDirty(true);
                      }
                    }}
                    className="flex-1 p-3 bg-transparent text-slate-100 font-mono text-xs leading-[1.6] focus:outline-none resize-none overflow-auto"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* СОДЕРЖИМОЕ ВКЛАДКИ 2: ИНДИВИДУАЛЬНЫЕ КУКИ И TELEGRAM ЭТОГО СКРИПТА */}
        {subTab === 'cookies_tg' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Блок А: Индивидуальные Куки этого проекта */}
            <form
              onSubmit={handleSaveProjectCookies}
              className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-800">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Cookie className="w-4 h-4 text-amber-400" />
                    Индивидуальные куки проекта «{activeProj.name}»
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Эти куки привязаны конкретно к этому скрипту (<code className="font-mono text-indigo-300">{activeProj.name}_cookies</code>) и также сохраняются в файл <code className="font-mono text-slate-300">cookies.json</code> в папке проекта.
                  </p>
                </div>
              </div>

              <div className="p-3 bg-slate-900/70 border border-slate-800 rounded-lg text-xs flex items-center justify-between">
                <div>
                  <span className="text-slate-400">Текущий статус куки скрипта: </span>
                  {cookieStatus?.has_cookies ? (
                    cookieStatus.is_expired ? (
                      <span className="text-red-400 font-semibold inline-flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Истекли ({cookieStatus.expired_note || 'нужна замена'})
                      </span>
                    ) : (
                      <span className="text-emerald-400 font-semibold">
                        Загружены и актуальны ({formatBytes(cookieStatus.size_bytes)})
                      </span>
                    )
                  ) : (
                    <span className="text-slate-400">Ещё не загружены</span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Вставьте JSON-массив куки из браузерного расширения <strong>Cookie-Editor</strong>:
                </label>
                <textarea
                  rows={6}
                  value={projCookieJson}
                  onChange={(e) => setProjCookieJson(e.target.value)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg p-3 font-mono text-xs text-white"
                />
              </div>

              {projCookieMsg && (
                <div
                  className={`p-3 rounded-lg text-xs ${
                    projCookieMsg.type === 'ok'
                      ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-200'
                      : 'bg-red-950/60 border border-red-500/40 text-red-200'
                  }`}
                >
                  {projCookieMsg.text}
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                Сохранить индивидуальные куки для «{activeProj.name}»
              </button>
            </form>

            {/* Блок Б: Индивидуальные данные Telegram этого скрипта */}
            <form
              onSubmit={handleSaveProjectTelegram}
              className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="pb-3 border-b border-slate-800">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Send className="w-4 h-4 text-indigo-400" />
                  Данные Telegram для самого скрипта «{activeProj.name}»
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Используются <strong>внутри кода вашего проекта</strong> (если этот скрипт сам является Telegram-ботом или юзерботом). Системный бот для уведомлений самой панели настраивается отдельно во вкладке «Настройки».
                </p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Токен бота этого проекта (<code className="font-mono text-indigo-300">BOT_TOKEN</code> из @BotFather)
                  </label>
                  <input
                    type="text"
                    placeholder="7100223344:AAH..."
                    value={projBotToken}
                    onChange={(e) => setProjBotToken(e.target.value)}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    ID чата / администратора (<code className="font-mono text-indigo-300">TG_CHAT_ID</code>)
                  </label>
                  <input
                    type="text"
                    placeholder="Например: 192837465"
                    value={projChatId}
                    onChange={(e) => setProjChatId(e.target.value)}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      API_ID (для Telethon / Pyrogram)
                    </label>
                    <input
                      type="text"
                      placeholder="2040"
                      value={projApiId}
                      onChange={(e) => setProjApiId(e.target.value)}
                      className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      API_HASH (my.telegram.org)
                    </label>
                    <input
                      type="text"
                      placeholder="b18441a1ff..."
                      value={projApiHash}
                      onChange={(e) => setProjApiHash(e.target.value)}
                      className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div className="pt-1">
                  <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cfgUseProxy}
                      onChange={(e) => setCfgUseProxy(e.target.checked)}
                    />
                    Включить прокси <code className="font-mono text-indigo-300">127.0.0.1:10808</code> для работы Telegram в этом проекте
                  </label>
                </div>
              </div>

              {projTgMsg && (
                <div
                  className={`p-3 rounded-lg text-xs ${
                    projTgMsg.type === 'ok'
                      ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-200'
                      : 'bg-red-950/60 border border-red-500/40 text-red-200'
                  }`}
                >
                  {projTgMsg.text}
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Save className="w-4 h-4" />
                Сохранить данные Telegram для этого проекта
              </button>
            </form>
          </div>
        )}

        {/* СОДЕРЖИМОЕ ВКЛАДКИ 3: ПРОСТЫЕ НАСТРОЙКИ И КОНСТРУКТОР РАСПИСАНИЯ */}
        {subTab === 'simple_cfg' && (
          <form
            onSubmit={handleSaveProjectConfig}
            className="bg-[#1e293b] border border-slate-800 rounded-xl p-6 space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
              <div>
                <h3 className="text-base font-bold text-white">
                  Простые настройки запуска и расписания («{activeProj.name}»)
                </h3>
                <p className="text-xs text-slate-400">
                  Понятные настройки без сложных команд. Для тонких технических лимитов есть вкладка «4. Расширенные».
                </p>
              </div>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer self-start sm:self-auto"
              >
                <Save className="w-4 h-4" />
                Сохранить изменения
              </button>
            </div>

            {cfgError && (
              <div className="p-3 bg-red-950/70 border border-red-500/40 rounded-lg text-xs text-red-200">
                {cfgError}
              </div>
            )}
            {cfgSaved && (
              <div className="p-3 bg-emerald-950/70 border border-emerald-500/40 rounded-lg text-xs text-emerald-200">
                Настройки проекта успешно сохранены!
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-200 mb-1">
                Описание проекта (понятная заметка для вас)
              </label>
              <input
                type="text"
                value={cfgDescription}
                onChange={(e) => setCfgDescription(e.target.value)}
                placeholder="Что именно делает этот проект?"
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-white"
              />
            </div>

            {/* Выбор категории с объяснением */}
            <div>
              <label className="block text-xs font-semibold text-slate-200 mb-2">
                Режим работы проекта:
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setCfgType('service')}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer ${
                    cfgType === 'service'
                      ? 'bg-emerald-950/40 border-emerald-500/60'
                      : 'bg-[#0f172a] border-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-xs text-white">
                    <Bot className="w-4 h-4 text-emerald-400" />
                    Постоянная программа 24/7 (Service)
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">
                    Работает в фоне постоянно. Если программа вылетит — панель сама запустит её снова.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setCfgType('job')}
                  className={`p-3.5 rounded-xl border text-left cursor-pointer ${
                    cfgType === 'job'
                      ? 'bg-indigo-950/40 border-indigo-500/60'
                      : 'bg-[#0f172a] border-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-xs text-white">
                    <Clock className="w-4 h-4 text-indigo-400" />
                    Скрипт по расписанию или кнопке (Job)
                  </div>
                  <p className="mt-1 text-[11px] text-slate-300">
                    Запускается через заданные промежутки времени или в точный час, выполняет скрипт и закрывается.
                  </p>
                </button>
              </div>
            </div>

            {cfgType === 'service' ? (
              <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl space-y-3">
                <h4 className="text-xs font-bold text-white">Настройки постоянной программы 24/7</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Что делать, если программа упала?</label>
                    <select
                      value={cfgRestartPolicy}
                      onChange={(e) => setCfgRestartPolicy(e.target.value as any)}
                      className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    >
                      <option value="on-failure">Автоматически перезапускать при ошибке (рекомендуется)</option>
                      <option value="always">Перезапускать всегда при любой остановке</option>
                      <option value="no">Не перезапускать</option>
                    </select>
                  </div>
                  <div className="flex items-center pt-5">
                    <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfgAutostart}
                        onChange={(e) => setCfgAutostart(e.target.checked)}
                      />
                      Запускать автоматически при включении сервера
                    </label>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-white">Конструктор расписания запуска</h4>
                  <span className="text-xs font-mono text-indigo-300">
                    {describeScheduleHuman('job', cfgScheduleType, cfgScheduleExpr)}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <button
                    type="button"
                    onClick={() => applyBuilderToSchedule('minutes', schedMinutes, schedHours, schedDailyTime)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedBuilderMode === 'minutes'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Каждые N минут
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBuilderToSchedule('hours', schedMinutes, schedHours, schedDailyTime)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedBuilderMode === 'hours'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Каждые N часов
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBuilderToSchedule('daily', schedMinutes, schedHours, schedDailyTime)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedBuilderMode === 'daily'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Раз в день в ЧЧ:ММ
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBuilderToSchedule('manual', schedMinutes, schedHours, schedDailyTime)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedBuilderMode === 'manual'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Только вручную
                  </button>
                  <button
                    type="button"
                    onClick={() => setSchedBuilderMode('custom')}
                    className={`px-3 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedBuilderMode === 'custom'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Свой Cron
                  </button>
                </div>

                {schedBuilderMode === 'minutes' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-slate-300">Запускать скрипт каждые:</span>
                    {[5, 10, 15, 30].map((presetMin) => (
                      <button
                        key={presetMin}
                        type="button"
                        onClick={() => {
                          setSchedMinutes(presetMin);
                          applyBuilderToSchedule('minutes', presetMin, schedHours, schedDailyTime);
                        }}
                        className={`px-2.5 py-1 rounded text-xs font-mono cursor-pointer ${
                          schedMinutes === presetMin
                            ? 'bg-indigo-500 text-white'
                            : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {presetMin} мин
                      </button>
                    ))}
                    <input
                      type="number"
                      min={1}
                      max={59}
                      value={schedMinutes}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setSchedMinutes(v);
                        applyBuilderToSchedule('minutes', v, schedHours, schedDailyTime);
                      }}
                      className="w-20 bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1 text-xs font-mono text-white"
                    />
                    <span className="text-xs text-slate-400">минут</span>
                  </div>
                )}

                {schedBuilderMode === 'hours' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-slate-300">Запускать скрипт каждые:</span>
                    {[1, 2, 6, 12, 24].map((presetHr) => (
                      <button
                        key={presetHr}
                        type="button"
                        onClick={() => {
                          setSchedHours(presetHr);
                          applyBuilderToSchedule('hours', schedMinutes, presetHr, schedDailyTime);
                        }}
                        className={`px-2.5 py-1 rounded text-xs font-mono cursor-pointer ${
                          schedHours === presetHr
                            ? 'bg-indigo-500 text-white'
                            : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {presetHr} ч
                      </button>
                    ))}
                  </div>
                )}

                {schedBuilderMode === 'daily' && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-300">Время ежедневного запуска:</span>
                    <input
                      type="time"
                      value={schedDailyTime}
                      onChange={(e) => {
                        setSchedDailyTime(e.target.value);
                        applyBuilderToSchedule('daily', schedMinutes, schedHours, e.target.value);
                      }}
                      className="bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                )}

                {schedBuilderMode === 'custom' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-300 mb-1">Тип расписания</label>
                      <select
                        value={cfgScheduleType}
                        onChange={(e) => setCfgScheduleType(e.target.value as any)}
                        className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                      >
                        <option value="cron">Cron (5 полей, например */15 * * * *)</option>
                        <option value="interval">Интервал в секундах (например 1800)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-300 mb-1">Выражение</label>
                      <input
                        type="text"
                        value={cfgScheduleExpr}
                        onChange={(e) => setCfgScheduleExpr(e.target.value)}
                        className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Простые переключатели прокси и уведомлений */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
              <label className="p-3 bg-slate-900/50 border border-slate-800 rounded-xl flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cfgUseProxy}
                  onChange={(e) => setCfgUseProxy(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong className="block text-white">Использовать прокси 127.0.0.1:10808</strong>
                  <span className="text-[11px] text-slate-400">Нужно для обхода блокировок Telegram и внешних API</span>
                </span>
              </label>

              <label className="p-3 bg-slate-900/50 border border-slate-800 rounded-xl flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cfgNotifyError}
                  onChange={(e) => setCfgNotifyError(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong className="block text-white">Уведомлять при ошибке / сбое</strong>
                  <span className="text-[11px] text-slate-400">Пришлёт лог ошибки в системный бот панели</span>
                </span>
              </label>

              <label className="p-3 bg-slate-900/50 border border-slate-800 rounded-xl flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cfgNotifySuccess}
                  onChange={(e) => setCfgNotifySuccess(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong className="block text-white">Уведомлять о каждом успешном запуске</strong>
                  <span className="text-[11px] text-slate-400">Полезно для редких ежедневных задач</span>
                </span>
              </label>
            </div>
          </form>
        )}

        {/* СОДЕРЖИМОЕ ВКЛАДКИ 4: РАСШИРЕННЫЕ НАСТРОЙКИ (ДЛЯ ПРОДВИНУТЫХ ПОЛЬЗОВАТЕЛЕЙ) */}
        {subTab === 'advanced_cfg' && (
          <form
            onSubmit={handleSaveProjectConfig}
            className="bg-[#1e293b] border border-slate-800 rounded-xl p-6 space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
              <div>
                <h3 className="text-base font-bold text-white">
                  Расширенные технические параметры («{activeProj.name}»)
                </h3>
                <p className="text-xs text-slate-400">
                  Тонкая настройка команды запуска, лимитов памяти OOM-сторожа, экспоненциального backoff, вебхука и сырого JSON окружения
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onDeleteProject(activeProj.id)}
                  className="px-3 py-2 text-xs font-medium bg-red-950/60 hover:bg-red-900/70 text-red-300 border border-red-500/30 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Удалить проект
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Сохранить технические настройки
                </button>
              </div>
            </div>

            {cfgError && (
              <div className="p-3 bg-red-950/70 border border-red-500/40 rounded-lg text-xs text-red-200">
                {cfgError}
              </div>
            )}
            {cfgSaved && (
              <div className="p-3 bg-emerald-950/70 border border-emerald-500/40 rounded-lg text-xs text-emerald-200">
                Технические настройки сохранены в SQLite (WAL).
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Рантайм (Runtime)</label>
                <select
                  value={cfgRuntime}
                  onChange={(e) => setCfgRuntime(e.target.value as any)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="python">python (.venv/bin/python или python3)</option>
                  <option value="node">node (Node.js)</option>
                  <option value="bash">bash (/bin/bash)</option>
                  <option value="custom">custom</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1">Команда запуска (cmd)</label>
                <input
                  type="text"
                  value={cfgCmd}
                  onChange={(e) => setCfgCmd(e.target.value)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Лимит ОЗУ группы PGID (МБ, 0 = без лимита)
                </label>
                <input
                  type="number"
                  min={0}
                  value={cfgRamLimit}
                  onChange={(e) => setCfgRamLimit(Number(e.target.value))}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 p-4 bg-slate-900/60 border border-slate-800 rounded-xl">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Backoff мин (сек)</label>
                <input
                  type="number"
                  min={1}
                  value={cfgBackoffMin}
                  onChange={(e) => setCfgBackoffMin(Number(e.target.value))}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Backoff макс (сек)</label>
                <input
                  type="number"
                  min={1}
                  value={cfgBackoffMax}
                  onChange={(e) => setCfgBackoffMax(Number(e.target.value))}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Таймаут (сек, 0=нет)</label>
                <input
                  type="number"
                  min={0}
                  value={cfgTimeoutSec}
                  onChange={(e) => setCfgTimeoutSec(Number(e.target.value))}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Повторы (retries)</label>
                <input
                  type="number"
                  min={0}
                  value={cfgMaxRetries}
                  onChange={(e) => setCfgMaxRetries(Number(e.target.value))}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Пауза повтора (сек)</label>
                <input
                  type="number"
                  min={1}
                  value={cfgRetryDelay}
                  onChange={(e) => setCfgRetryDelay(Number(e.target.value))}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                />
              </div>
            </div>

            {activeProj.webhook_token && (
              <div className="flex items-center justify-between p-3 bg-[#0f172a] border border-slate-800 rounded-lg text-xs font-mono">
                <span className="text-slate-300 truncate">
                  Внешний Webhook запуска: POST /api/webhook/{activeProj.webhook_token}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      `${window.location.origin}/api/webhook/${activeProj.webhook_token}`
                    );
                    setCopiedWebhook(true);
                    setTimeout(() => setCopiedWebhook(false), 1500);
                  }}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded inline-flex items-center gap-1 cursor-pointer"
                >
                  {copiedWebhook ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedWebhook ? 'Скопировано' : 'Копировать URL'}
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-300 mb-2">
                  Привязанные секреты из хранилища (HUB_SECRET_FILE_&lt;NAME&gt;)
                </label>
                <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-lg space-y-2 max-h-[150px] overflow-y-auto">
                  {secrets.map((sec) => (
                    <label key={sec.name} className="flex items-center gap-2 text-xs font-mono text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfgSecrets.includes(sec.name)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setCfgSecrets([...cfgSecrets, sec.name]);
                          } else {
                            setCfgSecrets(cfgSecrets.filter((s) => s !== sec.name));
                          }
                        }}
                      />
                      <span>{sec.name}</span>
                      <span className="text-slate-500">({sec.type})</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-2">
                  Сырой JSON переменных окружения (env_json)
                </label>
                <textarea
                  rows={5}
                  value={cfgEnvJson}
                  onChange={(e) => setCfgEnvJson(e.target.value)}
                  className="w-full p-3 bg-[#0f172a] border border-slate-800 rounded-lg font-mono text-xs text-white"
                />
              </div>
            </div>
          </form>
        )}

        {/* НИЖНЯЯ КОНСОЛЬ ЖИВЫХ ЛОГОВ ПРОЕКТА */}
        <section
          aria-label="Консоль живых логов"
          className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden"
        >
          <div className="px-4 py-2.5 bg-slate-900/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <Terminal className="w-4 h-4 text-emerald-400" />
              <span className="font-semibold text-white">Живой журнал вывода (Лог запуска)</span>
              {isStreaming && (
                <span className="font-mono text-emerald-400">· LIVE STREAM (обновление каждые 300мс)</span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="run-history-select" className="text-xs text-slate-400">
                История запусков:
              </label>
              <select
                id="run-history-select"
                value={selectedRunId || ''}
                onChange={(e) => setSelectedRunId(Number(e.target.value))}
                className="bg-[#0f172a] border border-slate-700 rounded px-2.5 py-1 text-xs font-mono text-slate-200"
              >
                {runs.length === 0 && <option value="">Нет запусков</option>}
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    Запуск #{r.id} · {r.status} · PID {r.pid || '—'} ({r.trigger})
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => activeProj && loadFilesAndRuns(activeProj)}
                className="p-1.5 text-slate-400 hover:text-white bg-slate-800 rounded cursor-pointer"
                title="Обновить список запусков"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <pre
            ref={logContainerRef}
            data-testid="live-log-console"
            className="p-4 bg-[#070b14] text-slate-200 font-mono text-xs leading-relaxed h-56 overflow-y-auto whitespace-pre-wrap"
          >
            {logText || '// Лог пуст'}
          </pre>
        </section>
      </div>
    </div>
  );
};
