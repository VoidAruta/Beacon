import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Trash2,
  Save,
  FolderCode,
  FileText,
  Terminal,
  Plus,
  Copy,
  Send,
  Settings2,
  Cookie,
  Upload,
  AlertTriangle,
  Bot,
  Clock,
  Globe,
  Package,
  Search,
  Database,
  Maximize2,
  Minimize2,
  FolderPlus,
  FilePlus,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Folder,
  FolderOpen,
  FileCode,
  Download,
  Edit3,
  X,
  Check,
  Sparkles,
  ShieldCheck,
  Columns,
  PanelLeftClose,
  PanelLeftOpen,
  Cpu,
  Activity,
  Sliders,
  Zap,
  ArrowUp,
  ArrowDown,
  MoreVertical,
  KeyRound,
} from 'lucide-react';
import { ProjectItem, RunItem, SecretItem, SystemStatus, WorkspaceSubTab, WebAuthSession } from '../types/hub';
import { formatBytes } from '../utils/hubLogic';
import {
  DEFAULTS,
  LABELS,
  FileTreeNode,
  FlatFileEntry,
  formatShortTime,
  formatLiveUptime,
  statusBadge,
  flattenFileTree,
  getFileLanguageMeta,
  getDepsButtonMeta,
  generateBeaconFileTemplate,
  getRuntimeSdkSnippets,
  findNextInCode,
  findAndReplaceInCode,
} from './projects/projectWorkspaceUtils';
import {
  StatusNoticeBanner,
  DirtyDeployBanner,
  DeleteEntryConfirmModal,
  FuzzyFileModal,
  SyntaxCodeEditor,
} from './projects/ProjectWorkspaceModals';

interface ProjectsWorkspaceProps {
  projects: ProjectItem[];
  secrets: SecretItem[];
  system?: SystemStatus | null;
  selectedProject: ProjectItem | null;
  initialSubTab?: WorkspaceSubTab;
  onSelectProject: (p: ProjectItem) => void;
  onOpenCreateModal: () => void;
  onImportExamples?: () => Promise<any>;
  onStartProject: (id: number, params?: Record<string, string>) => Promise<any>;
  onStopProject: (id: number) => Promise<any>;
  onRestartProject: (id: number) => Promise<any>;
  onUpdateProject: (id: number, data: Record<string, any>) => Promise<any>;
  onDeleteProject: (id: number, deleteFiles?: boolean) => Promise<any>;
  onCloneProject?: (id: number) => Promise<any>;
  onRefreshAll: () => void;
  onOpenSecretsVault?: () => void;
  apiFetch: (path: string, options?: RequestInit) => Promise<Response>;
}

const DEFAULT_COOKIE_SAMPLE = JSON.stringify(
  [
    {
      domain: '.example.com',
      name: 'session_id',
      value: 'paste_real_cookie_here',
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
  system = null,
  selectedProject,
  initialSubTab = 'editor',
  onSelectProject,
  onOpenCreateModal,
  onImportExamples,
  onStartProject,
  onStopProject,
  onRestartProject,
  onUpdateProject,
  onDeleteProject,
  onCloneProject,
  onRefreshAll,
  onOpenSecretsVault,
  apiFetch,
}) => {
  const [subTab, setSubTab] = useState<WorkspaceSubTab>(initialSubTab);

  // Адаптивная компоновка рабочей области (экономия места на экране)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState<boolean>(false);
  const [splitConsoleMode, setSplitConsoleMode] = useState<boolean>(false);
  const [editorHeightMode, setEditorHeightMode] = useState<'normal' | 'tall' | 'fullscreen'>('normal');
  const [goToLineInput, setGoToLineInput] = useState<string>('');

  // Поиск, фильтрация и сортировка в левой панели проектов
  const [projectSearch, setProjectSearch] = useState<string>('');
  const [projectTypeFilter, setProjectTypeFilter] = useState<'all' | 'service' | 'web' | 'job'>('all');
  const [projectStatusFilter, setProjectStatusFilter] = useState<'all' | 'running' | 'failed' | 'stopped'>('all');
  const [projectSortBy, setProjectSortBy] = useState<'status' | 'ram' | 'name'>('status');
  const [importingExamples, setImportingExamples] = useState<boolean>(false);

  // Всегда берём актуальный объект проекта из свежего массива projects
  const activeProj: ProjectItem | null =
    (selectedProject ? projects.find((p) => p.id === selectedProject.id) : null) ||
    selectedProject ||
    projects[0] ||
    null;

  // Защита от двойного нажатия (Audit #3)
  const [procActionBusy, setProcActionBusy] = useState<'start' | 'stop' | 'restart' | 'clone' | 'export' | null>(null);
  const [savingFileBusy, setSavingFileBusy] = useState<boolean>(false);
  const [savingConfigBusy, setSavingConfigBusy] = useState<boolean>(false);
  const [savingCookiesBusy, setSavingCookiesBusy] = useState<boolean>(false);
  const [savingTgBusy, setSavingTgBusy] = useState<boolean>(false);
  const [savingKvBusy, setSavingKvBusy] = useState<boolean>(false);
  const [clearingLogsBusy, setClearingLogsBusy] = useState<boolean>(false);
  const [deletingEntryBusy, setDeletingEntryBusy] = useState<boolean>(false);

  // Выпадающее меню дополнительных действий в шапке (Audit #7)
  const [actionsMenuOpen, setActionsMenuOpen] = useState<boolean>(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);

  // Индикатор Dirty Deploy (Audit #12): хранит timestamp сохранения кода/конфига во время работы процесса
  const [dirtyDeployMap, setDirtyDeployMap] = useState<Record<number, string>>({});

  // Живой тикер Uptime (Audit #18)
  const [uptimeNowMs, setUptimeNowMs] = useState<number>(() => Date.now());

  // Живая проверка Healthcheck и запуск с параметрами PARAM_*
  const [healthcheckTesting, setHealthcheckTesting] = useState<boolean>(false);
  const [healthcheckResult, setHealthcheckResult] = useState<{
    ok: boolean;
    status_code: number;
    latency_ms: number;
    url: string;
    error?: string;
  } | null>(null);
  const [showRunParamsBar, setShowRunParamsBar] = useState<boolean>(false);
  const [runParamValues, setRunParamValues] = useState<Record<string, string>>({});

  // Вкладка 1: Файлы, проводник и редактор кода
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [files, setFiles] = useState<FlatFileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [selectedDir, setSelectedDir] = useState<string>('');
  const [explorerFilter, setExplorerFilter] = useState<string>('');
  const [activeFilePath, setActiveFilePath] = useState<string>('');
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [savedContents, setSavedContents] = useState<Record<string, string>>({});
  const [draftContents, setDraftContents] = useState<Record<string, string>>({});
  const [fileContent, setFileContent] = useState<string>('');
  const [fileStatus, setFileStatus] = useState<string>('');
  const [newFileName, setNewFileName] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [fileActionMode, setFileActionMode] = useState<'none' | 'new_file' | 'new_folder'>('none');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameTargetValue, setRenameTargetValue] = useState<string>('');
  const [zipUploadStatus, setZipUploadStatus] = useState<string>('');
  const [explorerDragOver, setExplorerDragOver] = useState<boolean>(false);
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<{ path: string; isDir: boolean } | null>(null);
  const [fuzzyFinderOpen, setFuzzyFinderOpen] = useState<boolean>(false);
  const [showSdkCheatsheet, setShowSdkCheatsheet] = useState<boolean>(false);
  const [showFindBar, setShowFindBar] = useState<boolean>(false);
  const [findQuery, setFindQuery] = useState<string>('');
  const [replaceQuery, setReplaceQuery] = useState<string>('');
  const [findCaseSensitive, setFindCaseSensitive] = useState<boolean>(false);
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [wordWrap, setWordWrap] = useState<boolean>(false);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorGutterRef = useRef<HTMLPreElement | null>(null);

  // История запусков и живой лог (с пагинацией Audit #17)
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [visibleRunsCount, setVisibleRunsCount] = useState<number>(DEFAULTS.RUNS_PAGE_SIZE);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [stdinInput, setStdinInput] = useState<string>('');
  const [stdinStatus, setStdinStatus] = useState<string>('');
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  // Вкладка 2: Куки, HTTP-проверка и Telegram
  const [cookieSecretName, setCookieSecretName] = useState<string>('');
  const [cookieJsonText, setCookieJsonText] = useState<string>('');
  const [cookieSaveStatus, setCookieSaveStatus] = useState<string>('');
  const cookieFileInputRef = useRef<HTMLInputElement | null>(null);

  const [tgBotToken, setTgBotToken] = useState<string>('');
  const [tgChatId, setTgChatId] = useState<string>('');
  const [tgApiId, setTgApiId] = useState<string>('');
  const [tgApiHash, setTgApiHash] = useState<string>('');
  const [customProxyUrl, setCustomProxyUrl] = useState<string>('');
  const [tgSaveStatus, setTgSaveStatus] = useState<string>('');

  // HTTP-проверка сайта и захват Set-Cookie
  const [webAuthUrl, setWebAuthUrl] = useState<string>('https://example.com');
  const [webAuthProxy, setWebAuthProxy] = useState<string>('');
  const [webAuthSession, setWebAuthSession] = useState<WebAuthSession | null>(null);
  const [webAuthLoading, setWebAuthLoading] = useState<boolean>(false);
  const [webAuthStatusMsg, setWebAuthStatusMsg] = useState<string>('');

  // Вкладка 3: Терминал и Git
  const [cliCommand, setCliCommand] = useState<string>('pip install -r requirements.txt');
  const [cliRunning, setCliRunning] = useState<boolean>(false);
  const [cliOutput, setCliOutput] = useState<string>('');

  // Вкладка 4/5: Настройки, Расписание, Супервизор, Лимиты и Секреты (используем DEFAULTS Audit #19)
  const [cfgName, setCfgName] = useState<string>('');
  const [cfgType, setCfgType] = useState<'service' | 'web' | 'job'>('service');
  const [cfgRuntime, setCfgRuntime] = useState<string>('python');
  const [cfgCommand, setCfgCommand] = useState<string>('');
  const [cfgWorkdir, setCfgWorkdir] = useState<string>('');
  const [cfgScheduleType, setCfgScheduleType] = useState<string>('manual');
  const [cfgScheduleExpr, setCfgScheduleExpr] = useState<string>('');
  const [cfgPort, setCfgPort] = useState<string>('');
  const [cfgHealthcheckUrl, setCfgHealthcheckUrl] = useState<string>('');
  const [cfgHealthcheckIntervalSec, setCfgHealthcheckIntervalSec] = useState<number>(DEFAULTS.HEALTHCHECK_INTERVAL_SEC);
  const [cfgAutostart, setCfgAutostart] = useState<boolean>(false);
  const [cfgUseProxy, setCfgUseProxy] = useState<boolean>(false);
  const [cfgRestartPolicy, setCfgRestartPolicy] = useState<string>('on-failure');
  const [cfgCronRestart, setCfgCronRestart] = useState<string>('');
  const [cfgMinUptimeSec, setCfgMinUptimeSec] = useState<number>(DEFAULTS.MIN_UPTIME_SEC);
  const [cfgMaxRestarts, setCfgMaxRestarts] = useState<number>(DEFAULTS.MAX_RESTARTS);
  const [cfgRestartDelaySec, setCfgRestartDelaySec] = useState<number>(DEFAULTS.RESTART_DELAY_SEC);
  const [cfgBackoffMinSec, setCfgBackoffMinSec] = useState<number>(DEFAULTS.BACKOFF_MIN_SEC);
  const [cfgBackoffMaxSec, setCfgBackoffMaxSec] = useState<number>(DEFAULTS.BACKOFF_MAX_SEC);
  const [cfgMaxRetries, setCfgMaxRetries] = useState<number>(DEFAULTS.MAX_RETRIES);
  const [cfgRetryDelaySec, setCfgRetryDelaySec] = useState<number>(DEFAULTS.RETRY_DELAY_SEC);
  const [cfgMaxRam, setCfgMaxRam] = useState<number>(DEFAULTS.RAM_LIMIT_MB);
  const [cfgTimeout, setCfgTimeout] = useState<number>(DEFAULTS.TIMEOUT_SEC);
  const [cfgHeartbeatIntervalSec, setCfgHeartbeatIntervalSec] = useState<number>(DEFAULTS.HEARTBEAT_INTERVAL_SEC);
  const [cfgHeartbeatGraceSec, setCfgHeartbeatGraceSec] = useState<number>(DEFAULTS.HEARTBEAT_GRACE_SEC);
  const [cfgOnSuccessProjectId, setCfgOnSuccessProjectId] = useState<number | null>(null);
  const [cfgNotifyOnError, setCfgNotifyOnError] = useState<boolean>(true);
  const [cfgNotifyOnCrash, setCfgNotifyOnCrash] = useState<boolean>(true);
  const [cfgNotifyOnSuccess, setCfgNotifyOnSuccess] = useState<boolean>(false);
  const [cfgEnvJson, setCfgEnvJson] = useState<string>('{}');
  const [envEditorMode, setEnvEditorMode] = useState<'visual' | 'json'>('visual');
  const [newEnvKey, setNewEnvKey] = useState<string>('');
  const [newEnvVal, setNewEnvVal] = useState<string>('');
  const [cfgSelectedSecrets, setCfgSelectedSecrets] = useState<string[]>([]);
  const [cfgWebhookHmacSecret, setCfgWebhookHmacSecret] = useState<string>('');
  const [cfgParamsSchema, setCfgParamsSchema] = useState<Array<{ name: string; label: string; default: string }>>([]);
  const [cfgStatus, setCfgStatus] = useState<string>('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<boolean>(false);
  const [deleteFilesCheckbox, setDeleteFilesCheckbox] = useState<boolean>(false);

  // Конструктор расписания
  const [schedBuilderMode, setSchedBuilderMode] = useState<'minutes' | 'hours' | 'daily' | 'interval' | 'raw'>('minutes');
  const [schedEveryMin, setSchedEveryMin] = useState<number>(DEFAULTS.SCHED_EVERY_MIN);
  const [schedEveryHour, setSchedEveryHour] = useState<number>(DEFAULTS.SCHED_EVERY_HOUR);
  const [schedDailyTime, setSchedDailyTime] = useState<string>(DEFAULTS.SCHED_DAILY_TIME);
  const [schedIntervalSec, setSchedIntervalSec] = useState<number>(DEFAULTS.SCHED_INTERVAL_SEC);

  // Нижняя консоль (Лог / beacon.state / Быстрый Shell)
  const [bottomConsoleTab, setBottomConsoleTab] = useState<'logs' | 'kv' | 'shell'>('logs');
  const [consoleExpanded, setConsoleExpanded] = useState<boolean>(false);
  const [logSearchQuery, setLogSearchQuery] = useState<string>('');
  const [kvItems, setKvItems] = useState<Array<{ key: string; value: any; updated_at: number }>>([]);
  const [newKvKey, setNewKvKey] = useState<string>('');
  const [newKvVal, setNewKvVal] = useState<string>('');
  const [kvStatus, setKvStatus] = useState<string>('');
  const [venvSetupRunning, setVenvSetupRunning] = useState<boolean>(false);

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  // Закрытие выпадающего меню «⋮ Действия» при клике вне его
  useEffect(() => {
    if (!actionsMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [actionsMenuOpen]);

  // Живой секундный тикер для Uptime работающего проекта (Audit #18)
  useEffect(() => {
    const isRunning =
      activeProj?.current_status === 'running' || activeProj?.current_status === 'waiting_input';
    if (!isRunning) return;
    const timer = setInterval(() => setUptimeNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeProj?.current_status]);

  // Инициализация полей при смене выбранного проекта
  useEffect(() => {
    if (!activeProj) return;
    setCfgName(activeProj.name);
    const pType = (activeProj.type === 'web' ? 'web' : activeProj.type === 'job' ? 'job' : 'service') as
      | 'service'
      | 'web'
      | 'job';
    setCfgType(pType);
    setCfgRuntime(activeProj.runtime || 'python');
    setCfgCommand(activeProj.cmd || 'python3 main.py');
    setCfgWorkdir(activeProj.workdir);
    setCfgScheduleType(activeProj.schedule_type || (pType === 'job' ? 'cron' : 'manual'));
    setCfgScheduleExpr(activeProj.schedule_expr || (pType === 'job' ? '*/15 * * * *' : ''));
    setCfgPort(activeProj.port ? String(activeProj.port) : '');
    setCfgHealthcheckUrl(activeProj.healthcheck_url || '');
    setCfgHealthcheckIntervalSec(activeProj.healthcheck_interval_sec ?? DEFAULTS.HEALTHCHECK_INTERVAL_SEC);
    setCfgAutostart(Boolean(activeProj.autostart));
    setCfgUseProxy(Boolean(activeProj.use_proxy));
    setCfgRestartPolicy(activeProj.restart_policy || 'on-failure');
    setCfgCronRestart(activeProj.cron_restart || '');
    setCfgMinUptimeSec(activeProj.min_uptime_sec ?? DEFAULTS.MIN_UPTIME_SEC);
    setCfgMaxRestarts(activeProj.max_restarts ?? DEFAULTS.MAX_RESTARTS);
    setCfgRestartDelaySec(activeProj.restart_delay_sec ?? DEFAULTS.RESTART_DELAY_SEC);
    setCfgBackoffMinSec(activeProj.backoff_min_sec ?? DEFAULTS.BACKOFF_MIN_SEC);
    setCfgBackoffMaxSec(activeProj.backoff_max_sec ?? DEFAULTS.BACKOFF_MAX_SEC);
    setCfgMaxRetries(activeProj.max_retries ?? DEFAULTS.MAX_RETRIES);
    setCfgRetryDelaySec(activeProj.retry_delay_sec ?? DEFAULTS.RETRY_DELAY_SEC);
    setCfgMaxRam(
      activeProj.ram_limit_mb !== undefined && activeProj.ram_limit_mb !== null
        ? Number(activeProj.ram_limit_mb)
        : DEFAULTS.RAM_LIMIT_MB
    );
    setCfgTimeout(activeProj.timeout_sec || DEFAULTS.TIMEOUT_SEC);
    setCfgHeartbeatIntervalSec(activeProj.heartbeat_interval_sec ?? DEFAULTS.HEARTBEAT_INTERVAL_SEC);
    setCfgHeartbeatGraceSec(activeProj.heartbeat_grace_sec ?? DEFAULTS.HEARTBEAT_GRACE_SEC);
    setCfgOnSuccessProjectId(activeProj.on_success_project_id ?? null);
    setCfgNotifyOnError(activeProj.notify_on_error === undefined ? true : Boolean(activeProj.notify_on_error));
    setCfgNotifyOnCrash(activeProj.notify_on_crash === undefined ? true : Boolean(activeProj.notify_on_crash));
    setCfgNotifyOnSuccess(Boolean(activeProj.notify_on_success));
    setCfgEnvJson(activeProj.env_json || '{}');
    setCfgWebhookHmacSecret(activeProj.webhook_hmac_secret || '');
    const schemaList = Array.isArray(activeProj.params_schema)
      ? activeProj.params_schema.map((item) => ({
          name: String(item.name || ''),
          label: String(item.label || ''),
          default: String(item.default || ''),
        }))
      : [];
    setCfgParamsSchema(schemaList);
    const defaultParamVals: Record<string, string> = {};
    for (const item of schemaList) {
      if (item.name) {
        defaultParamVals[item.name] = item.default || '';
      }
    }
    setRunParamValues(defaultParamVals);
    setShowRunParamsBar(false);
    setHealthcheckResult(null);
    setDeleteConfirmOpen(false);
    setDeleteFilesCheckbox(false);
    setPendingDeleteEntry(null);
    setActionsMenuOpen(false);
    setVisibleRunsCount(DEFAULTS.RUNS_PAGE_SIZE);

    const expr = (activeProj.schedule_expr || '').trim();
    if (activeProj.schedule_type === 'interval') {
      setSchedBuilderMode('interval');
      setSchedIntervalSec(Number(expr) || DEFAULTS.SCHED_INTERVAL_SEC);
    } else if (activeProj.schedule_type === 'daily') {
      setSchedBuilderMode('daily');
      setSchedDailyTime(/^\d{1,2}:\d{2}$/.test(expr) ? expr : DEFAULTS.SCHED_DAILY_TIME);
    } else if (/^\*\/(\d+) \* \* \* \*$/.test(expr)) {
      const m = expr.match(/^\*\/(\d+) \* \* \* \*$/);
      setSchedBuilderMode('minutes');
      setSchedEveryMin(Number(m?.[1] || DEFAULTS.SCHED_EVERY_MIN));
    } else if (/^0 \*\/(\d+) \* \* \*$/.test(expr)) {
      const m = expr.match(/^0 \*\/(\d+) \* \* \*$/);
      setSchedBuilderMode('hours');
      setSchedEveryHour(Number(m?.[1] || DEFAULTS.SCHED_EVERY_HOUR));
    } else if (/^(\d+) (\d+) \* \* \*$/.test(expr)) {
      const m = expr.match(/^(\d+) (\d+) \* \* \*$/);
      const mm = String(m?.[1] || '0').padStart(2, '0');
      const hh = String(m?.[2] || '9').padStart(2, '0');
      setSchedBuilderMode('daily');
      setSchedDailyTime(`${hh}:${mm}`);
    } else if (expr) {
      setSchedBuilderMode('raw');
    } else {
      setSchedBuilderMode('minutes');
    }

    try {
      const parsedEnv = JSON.parse(activeProj.env_json || '{}');
      setTgBotToken(parsedEnv.BOT_TOKEN || parsedEnv.TG_BOT_TOKEN || '');
      setTgChatId(parsedEnv.TG_CHAT_ID || parsedEnv.ADMIN_CHAT_ID || '');
      setTgApiId(parsedEnv.TG_API_ID || '');
      setTgApiHash(parsedEnv.TG_API_HASH || '');
      setCustomProxyUrl(
        parsedEnv.CUSTOM_PROXY_URL || parsedEnv.HTTPS_PROXY || parsedEnv.HTTP_PROXY || parsedEnv.ALL_PROXY || ''
      );
      if (parsedEnv.CUSTOM_PROXY_URL || parsedEnv.HTTPS_PROXY || parsedEnv.ALL_PROXY) {
        setWebAuthProxy(parsedEnv.CUSTOM_PROXY_URL || parsedEnv.HTTPS_PROXY || parsedEnv.ALL_PROXY);
      }
    } catch {
      setTgBotToken('');
      setTgChatId('');
      setTgApiId('');
      setTgApiHash('');
      setCustomProxyUrl('');
    }

    let secList: string[] = [];
    try {
      const parsed = JSON.parse(activeProj.secrets_json || '[]');
      if (Array.isArray(parsed)) secList = parsed;
    } catch {
      secList = [];
    }
    setCfgSelectedSecrets(secList);

    const defaultCookieName =
      activeProj.cookie_status?.secret_name ||
      secList.find((s) => s.includes('cookie')) ||
      `${activeProj.name}_cookies`;
    setCookieSecretName(defaultCookieName);
    setCookieJsonText('');
    setCookieSaveStatus('');
    setTgSaveStatus('');
    setCfgStatus('');
    setCliOutput('');
    setZipUploadStatus('');
    setWebAuthSession(null);
    setWebAuthStatusMsg('');
    setSelectedDir('');
    setExplorerFilter('');
    setOpenTabs([]);
    setSavedContents({});
    setDraftContents({});
    setRenamingPath(null);
    setFileActionMode('none');

    loadProjectFiles(activeProj.id);
    loadProjectRuns(activeProj.id);
    loadProjectKv(activeProj.id);
  }, [activeProj?.id]);

  // Защищённые обёртки действий над процессом (Audit #2, #3, #12)
  const triggerStartProjectSafe = useCallback(
    async (projId: number, params?: Record<string, string>) => {
      if (procActionBusy) return;
      setProcActionBusy('start');
      try {
        await onStartProject(projId, params);
        setDirtyDeployMap((prev) => {
          const next = { ...prev };
          delete next[projId];
          return next;
        });
      } catch (err: any) {
        setFileStatus(`Ошибка запуска: ${err?.message || 'Сбой сети'}`);
      } finally {
        setProcActionBusy(null);
      }
    },
    [onStartProject, procActionBusy]
  );

  const triggerStopProjectSafe = useCallback(
    async (projId: number) => {
      if (procActionBusy) return;
      setProcActionBusy('stop');
      try {
        await onStopProject(projId);
        setDirtyDeployMap((prev) => {
          const next = { ...prev };
          delete next[projId];
          return next;
        });
      } catch (err: any) {
        setFileStatus(`Ошибка остановки: ${err?.message || 'Сбой сети'}`);
      } finally {
        setProcActionBusy(null);
      }
    },
    [onStopProject, procActionBusy]
  );

  const triggerRestartProjectSafe = useCallback(
    async (projId: number) => {
      if (procActionBusy) return;
      setProcActionBusy('restart');
      try {
        await onRestartProject(projId);
        setDirtyDeployMap((prev) => {
          const next = { ...prev };
          delete next[projId];
          return next;
        });
      } catch (err: any) {
        setFileStatus(`Ошибка перезапуска: ${err?.message || 'Сбой сети'}`);
      } finally {
        setProcActionBusy(null);
      }
    },
    [onRestartProject, procActionBusy]
  );

  const loadProjectKv = async (projId: number) => {
    try {
      const res = await apiFetch(`/api/projects/${projId}/kv`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setKvItems(data);
        } else if (data && Array.isArray(data.items)) {
          setKvItems(data.items);
        }
      }
    } catch {
      // ignore initial load error
    }
  };

  const handleSaveKv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newKvKey.trim() || savingKvBusy) return;
    setSavingKvBusy(true);
    setKvStatus(LABELS.SAVING);
    let parsedValue: any = newKvVal;
    try {
      parsedValue = JSON.parse(newKvVal);
    } catch {
      parsedValue = newKvVal;
    }
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/kv/${encodeURIComponent(newKvKey.trim())}`, {
        method: 'PUT',
        body: JSON.stringify({ value: parsedValue }),
      });
      if (res.ok) {
        setNewKvKey('');
        setNewKvVal('');
        setKvStatus('Ключ сохранён в beacon.state');
        await loadProjectKv(activeProj.id);
        setTimeout(() => setKvStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setKvStatus(`Ошибка сохранения: ${err.detail || res.statusText || 'Сбой запроса'}`);
      }
    } catch (err: any) {
      setKvStatus(`Ошибка сети при сохранении ключа: ${err?.message || 'Проверьте соединение'}`);
    } finally {
      setSavingKvBusy(false);
    }
  };

  const handleDeleteKv = async (key: string) => {
    if (!activeProj || savingKvBusy) return;
    setSavingKvBusy(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/kv/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setKvStatus(`Удалён ключ «${key}»`);
        await loadProjectKv(activeProj.id);
        setTimeout(() => setKvStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setKvStatus(`Ошибка удаления ключа: ${err.detail || 'Не удалось удалить'}`);
      }
    } catch (err: any) {
      setKvStatus(`Ошибка сети при удалении ключа: ${err?.message || 'Сбой сети'}`);
    } finally {
      setSavingKvBusy(false);
    }
  };

  const handleQuickSetupVenv = async () => {
    if (!activeProj || venvSetupRunning) return;
    setVenvSetupRunning(true);
    setBottomConsoleTab('logs');
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/install_deps`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.run) {
        await loadProjectRuns(activeProj.id);
        setSelectedRunId(data.run.id);
        onRefreshAll();
      } else {
        setCliOutput(`[ОШИБКА] ${data.detail || 'Не удалось запустить установку зависимостей'}`);
      }
    } catch (e: any) {
      setCliOutput(`[ОШИБКА] ${e?.message || 'Сбой запроса'}`);
    } finally {
      setVenvSetupRunning(false);
    }
  };

  const handleClearOldLogs = async () => {
    if (!activeProj || clearingLogsBusy) return;
    setClearingLogsBusy(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/clear_logs`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setFileStatus('Старые логи очищены');
        await loadProjectRuns(activeProj.id);
        onRefreshAll();
        setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setFileStatus(`Ошибка очистки логов: ${err.detail || 'Не удалось очистить логи'}`);
      }
    } catch (err: any) {
      setFileStatus(`Ошибка сети при очистке логов: ${err?.message || 'Сбой сети'}`);
    } finally {
      setClearingLogsBusy(false);
    }
  };

  const expandParentDirsForPath = (relPath: string) => {
    if (!relPath || !relPath.includes('/')) return;
    const parts = relPath.split('/');
    setExpandedDirs((prev) => {
      const next = { ...prev };
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next[acc] = true;
      }
      return next;
    });
  };

  const loadProjectFiles = async (projId: number, preferPath?: string) => {
    try {
      const res = await apiFetch(`/api/projects/${projId}/files`);
      if (res.ok) {
        const data = await res.json();
        const treeNodes: FileTreeNode[] = Array.isArray(data.tree) ? data.tree : [];
        const list: FlatFileEntry[] =
          treeNodes.length > 0
            ? flattenFileTree(treeNodes)
            : Array.isArray(data.files)
            ? data.files
            : [];
        setFileTree(treeNodes);
        setFiles(list);

        // По умолчанию раскрываем папки первого уровня
        setExpandedDirs((prev) => {
          const next = { ...prev };
          for (const node of treeNodes) {
            if (node.type === 'dir' && next[node.path] === undefined) {
              next[node.path] = true;
            }
          }
          return next;
        });

        const onlyFiles = list.filter((f) => !f.is_dir);
        if (preferPath && onlyFiles.some((f) => f.path === preferPath)) {
          loadSingleFile(projId, preferPath);
        } else if (activeFilePath && onlyFiles.some((f) => f.path === activeFilePath)) {
          loadSingleFile(projId, activeFilePath);
        } else if (onlyFiles.length > 0) {
          const mainFile =
            onlyFiles.find(
              (f) => f.path === 'main.py' || f.path === 'bot.py' || f.path === 'index.js' || f.path === 'main.sh'
            ) || onlyFiles[0];
          loadSingleFile(projId, mainFile.path);
        } else {
          setActiveFilePath('');
          setFileContent('');
        }
      }
    } catch (err: any) {
      setFileStatus(`Ошибка загрузки дерева файлов: ${err?.message || 'Сбой сети'}`);
    }
  };

  const loadSingleFile = async (projId: number, relPath: string, forceReload = false) => {
    if (!relPath) return;
    setActiveFilePath(relPath);
    expandParentDirsForPath(relPath);
    if (relPath.includes('/')) {
      setSelectedDir(relPath.slice(0, relPath.lastIndexOf('/')));
    }
    setOpenTabs((prev) => (prev.includes(relPath) ? prev : [...prev, relPath]));

    // Если есть локальный черновик и не запрошена принудительная перезагрузка, показываем его
    if (!forceReload && draftContents[relPath] !== undefined) {
      setFileContent(draftContents[relPath]);
      setFileStatus('');
      return;
    }

    setFileStatus(LABELS.LOADING);
    try {
      const res = await apiFetch(`/api/projects/${projId}/files/content?path=${encodeURIComponent(relPath)}`);
      if (res.ok) {
        const data = await res.json();
        const text = data.content ?? '';
        setFileContent(text);
        setSavedContents((prev) => ({ ...prev, [relPath]: text }));
        setDraftContents((prev) => ({ ...prev, [relPath]: text }));
        setFileStatus('');
      } else {
        setFileStatus('Ошибка: не удалось прочитать файл');
      }
    } catch {
      setFileStatus('Ошибка чтения файла (проверьте сеть)');
    }
  };

  const updateEditorContent = useCallback(
    (nextText: string) => {
      setFileContent(nextText);
      if (activeFilePath) {
        setDraftContents((prev) => ({ ...prev, [activeFilePath]: nextText }));
      }
    },
    [activeFilePath]
  );

  const handleCloseTab = useCallback(
    (tabPath: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      const nextTabs = openTabs.filter((t) => t !== tabPath);
      setOpenTabs(nextTabs);
      if (activeFilePath === tabPath && activeProj) {
        if (nextTabs.length > 0) {
          const fallback = nextTabs[nextTabs.length - 1];
          loadSingleFile(activeProj.id, fallback);
        } else {
          setActiveFilePath('');
          setFileContent('');
        }
      }
    },
    [activeFilePath, activeProj, openTabs]
  );

  const handleSaveFile = async (pathOverride?: string, contentOverride?: string, restartAfterSave = false) => {
    if (!activeProj || savingFileBusy) return;
    const targetPath = pathOverride || activeFilePath;
    const targetContent = contentOverride !== undefined ? contentOverride : fileContent;
    if (!targetPath) return;

    setSavingFileBusy(true);
    setFileStatus(LABELS.SAVING);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({ path: targetPath, content: targetContent }),
      });
      if (res.ok) {
        setFileStatus(restartAfterSave ? 'Сохранено — перезапуск процесса...' : LABELS.SAVED);
        setSavedContents((prev) => ({ ...prev, [targetPath]: targetContent }));
        setDraftContents((prev) => ({ ...prev, [targetPath]: targetContent }));
        loadProjectFiles(activeProj.id, targetPath);
        onRefreshAll();

        const isRunningNow =
          activeProj.current_status === 'running' || activeProj.current_status === 'waiting_input';
        if (restartAfterSave) {
          await triggerRestartProjectSafe(activeProj.id);
          setFileStatus('Файл сохранён и проект перезапущен!');
        } else if (isRunningNow) {
          setDirtyDeployMap((prev) => ({
            ...prev,
            [activeProj.id]: `Файл «${targetPath}» изменён (${formatShortTime(Date.now())})`,
          }));
        }

        setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setFileStatus(`Ошибка сохранения: ${err.detail || 'Не удалось записать файл'}`);
      }
    } catch (err: any) {
      setFileStatus(`Ошибка сети при сохранении файла: ${err?.message || 'Сбой сети'}`);
    } finally {
      setSavingFileBusy(false);
    }
  };

  const buildPathInSelectedDir = (rawInput: string): string => {
    const clean = rawInput.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean) return '';
    if (clean.includes('/') || !selectedDir) {
      return clean;
    }
    return `${selectedDir}/${clean}`;
  };

  const handleCreateNewFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newFileName.trim()) return;
    const targetPath = buildPathInSelectedDir(newFileName);
    if (!targetPath) return;
    const initialBody = generateBeaconFileTemplate(targetPath, activeProj);
    await handleSaveFile(targetPath, initialBody);
    expandParentDirsForPath(targetPath);
    setNewFileName('');
    setFileActionMode('none');
  };

  const handleQuickCreateTemplateFile = async (templateFileName: string) => {
    if (!activeProj) return;
    const targetPath = buildPathInSelectedDir(templateFileName);
    if (!targetPath) return;
    const existing = files.find((f) => !f.is_dir && f.path === targetPath);
    if (existing) {
      await loadSingleFile(activeProj.id, targetPath);
      setFileActionMode('none');
      return;
    }
    const body = generateBeaconFileTemplate(targetPath, activeProj);
    await handleSaveFile(targetPath, body);
    expandParentDirsForPath(targetPath);
    setNewFileName('');
    setFileActionMode('none');
  };

  const handleCreateNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newFolderName.trim()) return;
    const targetDir = buildPathInSelectedDir(newFolderName);
    if (!targetDir) return;
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ path: targetDir }),
      });
      if (res.ok) {
        setNewFolderName('');
        setFileActionMode('none');
        setExpandedDirs((prev) => ({ ...prev, [targetDir]: true }));
        expandParentDirsForPath(targetDir);
        setSelectedDir(targetDir);
        setFileStatus(`Создана папка: ${targetDir}`);
        loadProjectFiles(activeProj.id, activeFilePath);
        setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setFileStatus(`Ошибка создания папки: ${err.detail || 'Не удалось создать папку'}`);
      }
    } catch (err: any) {
      setFileStatus(`Ошибка сети при создании папки: ${err?.message || 'Сбой сети'}`);
    }
  };

  const handleRenameEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !renamingPath || !renameTargetValue.trim()) return;
    const cleanNew = renameTargetValue.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleanNew || cleanNew === renamingPath) {
      setRenamingPath(null);
      return;
    }
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/rename`, {
        method: 'POST',
        body: JSON.stringify({ old_path: renamingPath, new_path: cleanNew }),
      });
      if (res.ok) {
        const oldPath = renamingPath;
        setRenamingPath(null);
        setRenameTargetValue('');
        setFileStatus(`Переименовано: ${oldPath} → ${cleanNew}`);
        setOpenTabs((prev) =>
          prev.map((t) => {
            if (t === oldPath) return cleanNew;
            if (t.startsWith(`${oldPath}/`)) return `${cleanNew}${t.slice(oldPath.length)}`;
            return t;
          })
        );
        if (selectedDir === oldPath) {
          setSelectedDir(cleanNew);
        } else if (selectedDir.startsWith(`${oldPath}/`)) {
          setSelectedDir(`${cleanNew}${selectedDir.slice(oldPath.length)}`);
        }
        const nextActive =
          activeFilePath === oldPath
            ? cleanNew
            : activeFilePath.startsWith(`${oldPath}/`)
            ? `${cleanNew}${activeFilePath.slice(oldPath.length)}`
            : activeFilePath;
        await loadProjectFiles(activeProj.id, nextActive);
        onRefreshAll();
        setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setFileStatus(`Ошибка переименования: ${err.detail || 'Не удалось переименовать'}`);
      }
    } catch (err: any) {
      setFileStatus(`Ошибка сети при переименовании: ${err?.message || 'Сбой сети'}`);
    }
  };

  // Запрос подтверждения перед удалением файла или папки (Audit #1)
  const requestDeleteFileOrFolder = (relPath: string, isDir = false) => {
    if (!activeProj || !relPath) return;
    setPendingDeleteEntry({ path: relPath, isDir });
  };

  const executeConfirmedDeleteEntry = async () => {
    if (!activeProj || !pendingDeleteEntry || deletingEntryBusy) return;
    const { path: relPath, isDir } = pendingDeleteEntry;
    setDeletingEntryBusy(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files?path=${encodeURIComponent(relPath)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setPendingDeleteEntry(null);
        setFileStatus(`Удалено: ${relPath}`);
        setOpenTabs((prev) => prev.filter((t) => t !== relPath && !t.startsWith(`${relPath}/`)));
        if (selectedDir === relPath || selectedDir.startsWith(`${relPath}/`)) {
          setSelectedDir('');
        }
        const nextPrefer =
          activeFilePath === relPath || (isDir && activeFilePath.startsWith(`${relPath}/`))
            ? undefined
            : activeFilePath;
        await loadProjectFiles(activeProj.id, nextPrefer);
        onRefreshAll();
        setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setPendingDeleteEntry(null);
        setFileStatus(`Ошибка удаления: ${err.detail || 'Не удалось удалить объект'}`);
      }
    } catch (err: any) {
      setPendingDeleteEntry(null);
      setFileStatus(`Ошибка сети при удалении: ${err?.message || 'Сбой сети'}`);
    } finally {
      setDeletingEntryBusy(false);
    }
  };

  const handleDownloadProjectOrFolderZip = async (subpath = '') => {
    if (!activeProj || procActionBusy === 'export') return;
    setProcActionBusy('export');
    try {
      const query = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
      const res = await apiFetch(`/api/projects/${activeProj.id}/export${query}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const suffix = subpath ? `_${subpath.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '_project';
        a.download = `${activeProj.name}${suffix}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setFileStatus(`Скачан архив ${a.download}`);
        setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setFileStatus(`Ошибка скачивания архива: ${err.detail || 'Не удалось сформировать .zip'}`);
      }
    } catch (err: any) {
      setFileStatus(`Ошибка сети при экспорте .zip: ${err?.message || 'Сбой сети'}`);
    } finally {
      setProcActionBusy(null);
    }
  };

  const handleDownloadSingleFile = async (relPath?: string) => {
    if (!activeProj) return;
    const targetPath = relPath || activeFilePath;
    if (!targetPath) return;
    try {
      let contentToDownload = targetPath === activeFilePath ? fileContent : draftContents[targetPath];
      if (contentToDownload === undefined) {
        const res = await apiFetch(`/api/projects/${activeProj.id}/files/content?path=${encodeURIComponent(targetPath)}`);
        if (!res.ok) {
          setFileStatus('Ошибка скачивания файла');
          return;
        }
        const data = await res.json();
        contentToDownload = data.content ?? '';
      }
      const blob = new Blob([contentToDownload], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = targetPath.split('/').pop() || targetPath;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setFileStatus(`Ошибка скачивания файла: ${err?.message || 'Сбой сети'}`);
    }
  };

  // Универсальная загрузка одного или нескольких файлов / .zip (для кнопки и Drag&Drop Audit #16)
  const uploadFilesListToExplorer = async (fileList: FileList | File[]) => {
    if (!activeProj) return;
    const arr = Array.from(fileList || []);
    if (arr.length === 0) return;
    const targetFolder = selectedDir;
    let lastUploadedPath = activeFilePath;

    for (const file of arr) {
      setZipUploadStatus(`Загрузка ${file.name}${targetFolder ? ` в ${targetFolder}/` : ''}...`);
      try {
        const base64Part = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const rawUrl = String(reader.result || '');
            resolve(rawUrl.includes(',') ? rawUrl.split(',')[1] : rawUrl);
          };
          reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
          reader.readAsDataURL(file);
        });
        const isZip = file.name.toLowerCase().endsWith('.zip');
        const res = await apiFetch(`/api/projects/${activeProj.id}/files/upload?extract=${isZip ? 'true' : 'false'}`, {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            content_base64: base64Part,
            extract: isZip,
            target_dir: targetFolder,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const uploadedPath = targetFolder ? `${targetFolder}/${file.name}` : file.name;
          if (!isZip) lastUploadedPath = uploadedPath;
          setZipUploadStatus(
            isZip
              ? `Распаковано файлов: ${data.files?.length || 0}${targetFolder ? ` в ${targetFolder}/` : ''}`
              : `Загружен файл: ${uploadedPath}`
          );
        } else {
          const err = await res.json().catch(() => ({}));
          setZipUploadStatus(`Ошибка загрузки ${file.name}: ${err.detail || 'Сбой'}`);
        }
      } catch (err: any) {
        setZipUploadStatus(`Ошибка загрузки ${file.name}: ${err?.message || 'Сбой сети'}`);
      }
    }

    await loadProjectFiles(activeProj.id, lastUploadedPath);
    onRefreshAll();
    setTimeout(() => setZipUploadStatus(''), 3500);
    if (zipInputRef.current) {
      zipInputRef.current.value = '';
    }
  };

  const handleUploadZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    await uploadFilesListToExplorer(e.target.files);
  };

  const handleExplorerDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setExplorerDragOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      await uploadFilesListToExplorer(e.dataTransfer.files);
    }
  };

  const loadProjectRuns = async (projId: number) => {
    try {
      const res = await apiFetch(`/api/projects/${projId}/runs`);
      if (res.ok) {
        const list: RunItem[] = await res.json();
        setRuns(list);
        if (list.length > 0) {
          setSelectedRunId((prev) => {
            if (prev && list.some((r) => r.id === prev)) return prev;
            return list[0].id;
          });
        } else {
          setSelectedRunId(null);
          setLogText('Запусков ещё не было. Нажмите «Запустить сейчас» в шапке проекта.');
        }
      }
    } catch {
      // ignore
    }
  };

  // Опрашиваем runs только когда пользователь находится на вкладках с консолью/историей (Audit #5)
  useEffect(() => {
    if (!activeProj) return;
    if (subTab !== 'editor' && subTab !== 'terminal_git') return;
    const timer = setInterval(() => {
      loadProjectRuns(activeProj.id);
    }, DEFAULTS.POLL_RUNS_MS);
    return () => clearInterval(timer);
  }, [activeProj?.id, subTab]);

  // Загрузка лога и live-обновление: SSE по умолчанию, а setInterval ТОЛЬКО как fallback при ошибке SSE (Audit #4)
  useEffect(() => {
    if (!selectedRunId) return;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const startFallbackPolling = () => {
      if (cancelled || pollTimer) return;
      pollTimer = setInterval(async () => {
        if (cancelled) return;
        try {
          const rRes = await apiFetch(`/api/runs/${selectedRunId}/log`);
          if (rRes.ok && !cancelled) {
            const rData = await rRes.json();
            if (typeof rData.log === 'string') {
              setLogText(rData.log);
            }
          }
        } catch {
          // ignore transient poll error
        }
      }, DEFAULTS.POLL_LOG_MS);
    };

    const loadLogAndStream = async () => {
      let startOffset = 0;
      try {
        const res = await apiFetch(`/api/runs/${selectedRunId}/log`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setLogText(data.log || '');
          startOffset = Number(data.log_size || 0);
        }
      } catch {
        // ignore initial log fetch error
      }

      if (cancelled) return;

      let ticket = '';
      try {
        const tRes = await apiFetch('/api/auth/stream_ticket', {
          method: 'POST',
          body: JSON.stringify({ run_id: selectedRunId }),
        });
        if (tRes.ok) {
          const tData = await tRes.json();
          ticket = String(tData.ticket || '');
        }
      } catch {
        // fallback if stream_ticket fails
      }

      if (cancelled) return;

      try {
        const streamUrl = `/api/runs/${selectedRunId}/stream?offset=${startOffset}${
          ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''
        }`;
        es = new EventSource(streamUrl);
        es.onmessage = (ev) => {
          try {
            const payload = JSON.parse(ev.data);
            if (payload.type === 'log' && payload.data) {
              setLogText((prev) => prev + payload.data);
              if (logBoxRef.current) {
                logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
              }
            } else if (payload.chunk) {
              setLogText((prev) => prev + payload.chunk);
            }
            if (payload.type === 'eof' || payload.eof) {
              es?.close();
            }
          } catch {
            // ignore malformed event
          }
        };
        es.onerror = () => {
          // Если SSE недоступен или оборвался за прокси — закрываем EventSource и включаем fallback-опрос
          es?.close();
          es = null;
          startFallbackPolling();
        };
      } catch {
        startFallbackPolling();
      }
    };

    loadLogAndStream();

    return () => {
      cancelled = true;
      if (es) es.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [selectedRunId]);

  const handleSendStdin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRunId || !stdinInput.trim()) return;
    const text = stdinInput;
    setStdinInput('');
    setStdinStatus('Отправка в FIFO...');
    try {
      const res = await apiFetch(`/api/runs/${selectedRunId}/stdin`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        setStdinStatus('Отправлено в stdin процесса');
        setTimeout(() => setStdinStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      } else {
        const err = await res.json().catch(() => ({}));
        setStdinStatus(err.detail || 'Процесс не ожидает ввод');
      }
    } catch (err: any) {
      setStdinStatus(`Ошибка отправки stdin: ${err?.message || 'Сбой сети'}`);
    }
  };

  // Сохранение кук (и привязка к проекту через /api/projects/{id}/cookies)
  const handleSaveAndAttachCookies = async () => {
    if (!activeProj || !cookieSecretName.trim() || savingCookiesBusy) return;
    const raw = cookieJsonText.trim() || DEFAULT_COOKIE_SAMPLE;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setCookieSaveStatus('Ошибка: JSON должен быть массивом объектов Cookie [...]');
        return;
      }
    } catch {
      setCookieSaveStatus('Ошибка: невалидный JSON. Скопируйте экспорт из расширения Cookie-Editor');
      return;
    }

    setSavingCookiesBusy(true);
    setCookieSaveStatus('Сохранение в сейф и запись cookies.json (0600)...');
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/cookies`, {
        method: 'POST',
        body: JSON.stringify({
          name: cookieSecretName.trim(),
          cookies_json: raw,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setCookieSaveStatus(`Ошибка сохранения кук: ${err.detail || 'Не удалось сохранить'}`);
        return;
      }

      const updatedSecrets = Array.from(new Set([...cfgSelectedSecrets, cookieSecretName.trim()]));
      setCfgSelectedSecrets(updatedSecrets);
      onRefreshAll();
      loadProjectFiles(activeProj.id, activeFilePath);
      setCookieSaveStatus(`Куки сохранены в «${cookieSecretName.trim()}» (права 0600) и подключены к проекту!`);
    } catch (err: any) {
      setCookieSaveStatus(`Ошибка сети при сохранении кук: ${err?.message || 'Сбой сети'}`);
    } finally {
      setSavingCookiesBusy(false);
    }
  };

  const handleCookieFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      setCookieJsonText(txt);
      setCookieSaveStatus(`Загружен файл ${file.name}. Нажмите «Сохранить и привязать куки к проекту».`);
    };
    reader.readAsText(file);
  };

  // HTTP-проверка сайта и захват Set-Cookie через прокси
  const handleStartWebAuth = async () => {
    if (!activeProj || webAuthLoading) return;
    setWebAuthLoading(true);
    setWebAuthStatusMsg('Выполнение HTTP-запроса и захват заголовков Set-Cookie...');
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/web_auth/start`, {
        method: 'POST',
        body: JSON.stringify({
          url: webAuthUrl.trim(),
          proxy_mode: webAuthProxy.trim() ? 'custom' : 'system',
          custom_proxy: webAuthProxy.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.session) {
        setWebAuthSession(data.session);
        setWebAuthStatusMsg(data.session.last_action || 'Проверка выполнена');
      } else {
        setWebAuthStatusMsg(`Ошибка HTTP-проверки: ${data.detail || 'Не удалось подключиться'}`);
      }
    } catch (err: any) {
      setWebAuthStatusMsg(`Ошибка сети: ${err?.message || 'Сбой запроса'}`);
    } finally {
      setWebAuthLoading(false);
    }
  };

  const handleSaveWebAuth = async () => {
    if (!activeProj || !webAuthSession || webAuthLoading) return;
    setWebAuthLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/web_auth/save`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setCookieJsonText(JSON.stringify(webAuthSession.cookies || [], null, 2));
        setWebAuthStatusMsg(
          `Перехваченные куки (${data.cookies_saved || webAuthSession.cookies?.length || 0} шт.) сохранены в «${data.cookie_secret}»!`
        );
        onRefreshAll();
      } else {
        setWebAuthStatusMsg(`Ошибка сохранения сессии: ${data.detail || 'Сбой'}`);
      }
    } catch (err: any) {
      setWebAuthStatusMsg(`Ошибка сети при сохранении Set-Cookie: ${err?.message || 'Сбой сети'}`);
    } finally {
      setWebAuthLoading(false);
    }
  };

  // Сохранение Telegram-параметров и прокси в ENV проекта
  const handleSaveTelegramAndProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || savingTgBusy) return;
    setSavingTgBusy(true);
    setTgSaveStatus(LABELS.SAVING);
    let envObj: Record<string, string> = {};
    try {
      envObj = JSON.parse(cfgEnvJson || '{}');
    } catch {
      envObj = {};
    }

    if (tgBotToken.trim()) envObj.BOT_TOKEN = tgBotToken.trim();
    else delete envObj.BOT_TOKEN;

    if (tgChatId.trim()) envObj.TG_CHAT_ID = tgChatId.trim();
    else delete envObj.TG_CHAT_ID;

    if (tgApiId.trim()) envObj.TG_API_ID = tgApiId.trim();
    else delete envObj.TG_API_ID;

    if (tgApiHash.trim()) envObj.TG_API_HASH = tgApiHash.trim();
    else delete envObj.TG_API_HASH;

    if (customProxyUrl.trim()) {
      envObj.CUSTOM_PROXY_URL = customProxyUrl.trim();
      envObj.HTTPS_PROXY = customProxyUrl.trim();
      envObj.HTTP_PROXY = customProxyUrl.trim();
      envObj.ALL_PROXY = customProxyUrl.trim();
    } else {
      delete envObj.CUSTOM_PROXY_URL;
      delete envObj.HTTPS_PROXY;
      delete envObj.HTTP_PROXY;
      delete envObj.ALL_PROXY;
    }

    const updatedEnvStr = JSON.stringify(envObj, null, 2);
    setCfgEnvJson(updatedEnvStr);
    try {
      await onUpdateProject(activeProj.id, { env_json: updatedEnvStr });
      setTgSaveStatus('Настройки Telegram и прокси сохранены в переменные окружения проекта');
      if (activeProj.current_status === 'running' || activeProj.current_status === 'waiting_input') {
        setDirtyDeployMap((prev) => ({
          ...prev,
          [activeProj.id]: `Переменные Telegram/прокси обновлены (${formatShortTime(Date.now())})`,
        }));
      }
    } catch (err: any) {
      setTgSaveStatus(`Ошибка сохранения Telegram/прокси: ${err?.message || 'Сбой сети'}`);
    } finally {
      setSavingTgBusy(false);
    }
  };

  // Терминал и быстрые команды в рабочей папке проекта
  const runProjectCommand = async (cmd: string) => {
    if (!activeProj || !cmd.trim() || cliRunning) return;
    setCliCommand(cmd);
    setCliRunning(true);
    setCliOutput(`$ ${cmd}\nЗапуск в ${activeProj.workdir}...\n`);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/exec`, {
        method: 'POST',
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      if (res.ok && data.run) {
        const rId = data.run.id;
        setSelectedRunId(rId);
        setCliOutput(
          `$ ${cmd}\nЗапущен процесс Run #${rId} (PID ${data.run.pid || '—'}). Ожидание вывода...\n`
        );
        await new Promise((r) => setTimeout(r, 900));
        const logRes = await apiFetch(`/api/runs/${rId}/log`);
        if (logRes.ok) {
          const logData = await logRes.json();
          setCliOutput(`$ ${cmd}\n[Run #${rId} · ${logData.status}]\n\n${logData.log || 'Выполнено.'}`);
          setLogText(logData.log || '');
        }
        loadProjectRuns(activeProj.id);
        loadProjectFiles(activeProj.id, activeFilePath);
        onRefreshAll();
      } else {
        setCliOutput(`$ ${cmd}\n[Ошибка]: ${data.detail || 'Не удалось выполнить команду'}`);
      }
    } catch (e: any) {
      setCliOutput(`$ ${cmd}\n[Ошибка]: ${e?.message || 'Сбой сети'}`);
    } finally {
      setCliRunning(false);
    }
  };

  const handleExecCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    await runProjectCommand(cliCommand);
  };

  // Переключение режима конструктора расписания
  const applyScheduleBuilder = (
    mode: 'minutes' | 'hours' | 'daily' | 'interval' | 'raw',
    minVal = schedEveryMin,
    hourVal = schedEveryHour,
    dailyVal = schedDailyTime,
    intVal = schedIntervalSec
  ) => {
    setSchedBuilderMode(mode);
    if (mode === 'minutes') {
      setCfgScheduleType('cron');
      setCfgScheduleExpr(`*/${Math.max(1, minVal)} * * * *`);
    } else if (mode === 'hours') {
      setCfgScheduleType('cron');
      setCfgScheduleExpr(`0 */${Math.max(1, hourVal)} * * *`);
    } else if (mode === 'daily') {
      setCfgScheduleType('daily');
      setCfgScheduleExpr((dailyVal || DEFAULTS.SCHED_DAILY_TIME).trim());
    } else if (mode === 'interval') {
      setCfgScheduleType('interval');
      setCfgScheduleExpr(String(Math.max(5, intVal)));
    } else {
      setCfgScheduleType('cron');
      if (!cfgScheduleExpr.trim() || /^\d{1,2}:\d{2}$/.test(cfgScheduleExpr.trim())) {
        setCfgScheduleExpr('*/15 * * * *');
      }
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || savingConfigBusy) return;
    setSavingConfigBusy(true);
    setCfgStatus('Сохранение конфигурации...');
    try {
      const parsedPort = cfgPort.trim() ? Number(cfgPort.trim()) : 0;
      const finalSchedType = cfgType === 'job' ? (cfgScheduleType === 'manual' ? 'cron' : cfgScheduleType) : 'manual';
      const finalSchedExpr =
        cfgType === 'job'
          ? cfgScheduleExpr.trim() || (finalSchedType === 'daily' ? DEFAULTS.SCHED_DAILY_TIME : '*/15 * * * *')
          : '';
      const cleanParams = cfgParamsSchema
        .filter((p) => p.name.trim())
        .map((p) => ({ name: p.name.trim(), label: p.label.trim(), default: p.default }));

      await onUpdateProject(activeProj.id, {
        name: cfgName,
        type: cfgType,
        runtime: cfgRuntime,
        cmd: cfgCommand,
        workdir: cfgWorkdir,
        schedule_type: finalSchedType,
        schedule_expr: finalSchedExpr,
        port: parsedPort,
        healthcheck_url: cfgHealthcheckUrl.trim(),
        healthcheck_interval_sec: Math.max(5, Number(cfgHealthcheckIntervalSec) || DEFAULTS.HEALTHCHECK_INTERVAL_SEC),
        autostart: cfgAutostart ? 1 : 0,
        use_proxy: cfgUseProxy ? 1 : 0,
        restart_policy: cfgRestartPolicy,
        cron_restart: cfgCronRestart.trim(),
        min_uptime_sec: Math.max(1, Number(cfgMinUptimeSec) || DEFAULTS.MIN_UPTIME_SEC),
        max_restarts: Math.max(0, Number(cfgMaxRestarts) || DEFAULTS.MAX_RESTARTS),
        restart_delay_sec: Math.max(1, Number(cfgRestartDelaySec) || DEFAULTS.RESTART_DELAY_SEC),
        backoff_min_sec: Math.max(1, Number(cfgBackoffMinSec) || DEFAULTS.BACKOFF_MIN_SEC),
        backoff_max_sec: Math.max(5, Number(cfgBackoffMaxSec) || DEFAULTS.BACKOFF_MAX_SEC),
        max_retries: Math.max(0, Number(cfgMaxRetries) || DEFAULTS.MAX_RETRIES),
        retry_delay_sec: Math.max(1, Number(cfgRetryDelaySec) || DEFAULTS.RETRY_DELAY_SEC),
        ram_limit_mb: Math.max(0, Number(cfgMaxRam) || 0),
        timeout_sec: Math.max(0, Number(cfgTimeout) || 0),
        heartbeat_interval_sec: Math.max(0, Number(cfgHeartbeatIntervalSec) || 0),
        heartbeat_grace_sec: Math.max(10, Number(cfgHeartbeatGraceSec) || DEFAULTS.HEARTBEAT_GRACE_SEC),
        on_success_project_id: cfgOnSuccessProjectId || null,
        notify_on_error: cfgNotifyOnError ? 1 : 0,
        notify_on_crash: cfgNotifyOnCrash ? 1 : 0,
        notify_on_success: cfgNotifyOnSuccess ? 1 : 0,
        env_json: cfgEnvJson,
        secrets_json: JSON.stringify(cfgSelectedSecrets),
        webhook_hmac_secret: cfgWebhookHmacSecret.trim(),
        params_schema: cleanParams,
      });
      setCfgStatus('Конфигурация проекта успешно сохранена');
      if (activeProj.current_status === 'running' || activeProj.current_status === 'waiting_input') {
        setDirtyDeployMap((prev) => ({
          ...prev,
          [activeProj.id]: `Конфигурация project.yaml обновлена (${formatShortTime(Date.now())})`,
        }));
      }
      setTimeout(() => setCfgStatus(''), 3000);
    } catch (err: any) {
      setCfgStatus(`Ошибка сохранения конфигурации: ${err?.message || 'Сбой сети'}`);
    } finally {
      setSavingConfigBusy(false);
    }
  };

  const handleProbeHealthcheckNow = async () => {
    if (!activeProj || healthcheckTesting) return;
    setHealthcheckTesting(true);
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/healthcheck_now`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok) {
        setHealthcheckResult({
          ok: Boolean(data.ok),
          status_code: Number(data.status_code || 0),
          latency_ms: Number(data.latency_ms || 0),
          url: String(data.url || ''),
          error: data.error ? String(data.error) : undefined,
        });
      } else {
        setHealthcheckResult({
          ok: false,
          status_code: 0,
          latency_ms: 0,
          url: cfgHealthcheckUrl || '',
          error: data.detail || 'Ошибка запроса',
        });
      }
    } catch (e: any) {
      setHealthcheckResult({
        ok: false,
        status_code: 0,
        latency_ms: 0,
        url: cfgHealthcheckUrl || '',
        error: e?.message || 'Сбой сети',
      });
    } finally {
      setHealthcheckTesting(false);
    }
  };

  const handleJumpToLine = (targetLineRaw?: string | number) => {
    const ta = editorTextareaRef.current;
    if (!ta) return;
    const lines = fileContent.split('\n');
    const maxLine = Math.max(1, lines.length);
    const desired = Math.max(
      1,
      Math.min(maxLine, Number(targetLineRaw !== undefined ? targetLineRaw : goToLineInput) || 1)
    );
    let charIdx = 0;
    for (let i = 0; i < desired - 1; i++) {
      charIdx += (lines[i]?.length || 0) + 1;
    }
    ta.focus();
    ta.setSelectionRange(charIdx, charIdx + (lines[desired - 1]?.length || 0));
    const approxLineHeight = 19.5;
    const nextScroll = Math.max(0, (desired - 5) * approxLineHeight);
    ta.scrollTop = nextScroll;
    if (editorGutterRef.current) {
      editorGutterRef.current.scrollTop = nextScroll;
    }
    setCursorPos({ line: desired, col: 1 });
  };

  // Мемоизированный парсинг ENV (Audit #21)
  const parsedEnvObject = useMemo<Record<string, string>>(() => {
    try {
      const obj = JSON.parse(cfgEnvJson || '{}');
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const res: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          res[String(k)] = String(v ?? '');
        }
        return res;
      }
    } catch {
      // ignore
    }
    return {};
  }, [cfgEnvJson]);

  const handleUpsertEnvVar = useCallback(
    (key: string, val: string) => {
      const cleanKey = key.trim();
      if (!cleanKey) return;
      const current = { ...parsedEnvObject, [cleanKey]: val };
      setCfgEnvJson(JSON.stringify(current, null, 2));
    },
    [parsedEnvObject]
  );

  const handleDeleteEnvVar = useCallback(
    (key: string) => {
      const current = { ...parsedEnvObject };
      delete current[key];
      setCfgEnvJson(JSON.stringify(current, null, 2));
    },
    [parsedEnvObject]
  );

  const toggleSecretAttachment = (secName: string) => {
    setCfgSelectedSecrets((prev) =>
      prev.includes(secName) ? prev.filter((x) => x !== secName) : [...prev, secName]
    );
  };

  const insertSdkSnippet = (snippet: string) => {
    updateEditorContent(`${fileContent.trimEnd()}\n\n${snippet}\n`);
    setFileStatus('Сниппет вставлен в конец файла — нажмите Сохранить (Ctrl+S)');
  };

  const updateCursorMetrics = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    const pos = textarea.selectionStart || 0;
    const before = textarea.value.slice(0, pos);
    const lines = before.split('\n');
    setCursorPos({
      line: lines.length,
      col: (lines[lines.length - 1]?.length || 0) + 1,
    });
  }, []);

  // Унифицированный поиск и замена с поддержкой регистра (Audit #10)
  const handleFindNext = () => {
    if (!findQuery || !editorTextareaRef.current) return;
    const ta = editorTextareaRef.current;
    const startIdx = ta.selectionEnd || 0;
    const idx = findNextInCode(fileContent, findQuery, startIdx, findCaseSensitive);
    if (idx !== -1) {
      ta.focus();
      ta.setSelectionRange(idx, idx + findQuery.length);
      updateCursorMetrics(ta);
    } else {
      setFileStatus(`Предупреждение: совпадений «${findQuery}» не найдено`);
      setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
    }
  };

  const handleReplaceAllInEditor = () => {
    if (!findQuery) return;
    const { nextText, count } = findAndReplaceInCode(fileContent, findQuery, replaceQuery, findCaseSensitive);
    if (count === 0) {
      setFileStatus(`Предупреждение: совпадений «${findQuery}» не найдено`);
      setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
      return;
    }
    updateEditorContent(nextText);
    setFileStatus(`Заменено совпадений: ${count}`);
  };

  // Глобальные горячие клавиши внутри вкладки «Проекты и Консоль» (Audit #15)
  useEffect(() => {
    if (!activeProj) return;
    const onWorkspaceKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteConfirmOpen) {
          setDeleteConfirmOpen(false);
          return;
        }
        if (actionsMenuOpen) {
          setActionsMenuOpen(false);
          return;
        }
        if (showFindBar) {
          setShowFindBar(false);
          return;
        }
        if (showSdkCheatsheet) {
          setShowSdkCheatsheet(false);
          return;
        }
        if (editorHeightMode === 'fullscreen') {
          setEditorHeightMode('normal');
          return;
        }
      }

      // Ctrl+S / Ctrl+Shift+S — Сохранить файл (и перезапустить при Shift)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (subTab === 'editor' && activeFilePath) {
          handleSaveFile(undefined, undefined, e.shiftKey);
        }
        return;
      }

      // Ctrl+Enter — Запустить или перезапустить проект
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const isRunning =
          activeProj.current_status === 'running' || activeProj.current_status === 'waiting_input';
        if (isRunning) {
          triggerRestartProjectSafe(activeProj.id);
        } else {
          const hasFilledParams = Object.keys(runParamValues).some((k) => runParamValues[k]?.trim());
          triggerStartProjectSafe(activeProj.id, hasFilledParams ? runParamValues : undefined);
        }
        return;
      }

      // Alt+P или Ctrl+P — Быстрый поиск файла по имени (Fuzzy File Finder)
      if ((e.altKey || e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setSubTab('editor');
        setFuzzyFinderOpen(true);
        return;
      }

      // Alt+W — Закрыть активную вкладку файла (не закрывая вкладку браузера!)
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === 'w' || e.code === 'KeyW')) {
        e.preventDefault();
        if (subTab === 'editor' && activeFilePath) {
          handleCloseTab(activeFilePath);
        }
        return;
      }

      // Alt+F — Поиск и замена по коду
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
        e.preventDefault();
        if (subTab === 'editor' && activeFilePath) {
          setShowFindBar((v) => !v);
        }
      }
    };

    window.addEventListener('keydown', onWorkspaceKeyDown);
    return () => window.removeEventListener('keydown', onWorkspaceKeyDown);
  }, [
    activeProj,
    subTab,
    activeFilePath,
    fileContent,
    deleteConfirmOpen,
    actionsMenuOpen,
    showFindBar,
    showSdkCheatsheet,
    editorHeightMode,
    runParamValues,
    handleCloseTab,
    triggerRestartProjectSafe,
    triggerStartProjectSafe,
  ]);

  const filteredProjects = projects
    .filter((p) => {
      if (projectTypeFilter !== 'all' && p.type !== projectTypeFilter) return false;
      const st = (p.current_status || 'stopped').toLowerCase();
      if (projectStatusFilter === 'running' && st !== 'running' && st !== 'waiting_input') return false;
      if (
        projectStatusFilter === 'failed' &&
        st !== 'failed' &&
        st !== 'crashed' &&
        st !== 'crash_loop' &&
        st !== 'killed_oom' &&
        st !== 'timeout'
      ) {
        return false;
      }
      if (projectStatusFilter === 'stopped' && st !== 'stopped' && st !== 'success' && st !== 'completed') {
        return false;
      }
      if (!projectSearch.trim()) return true;
      const q = projectSearch.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        (p.cmd || '').toLowerCase().includes(q) ||
        (p.runtime || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (projectSortBy === 'ram') {
        return Number(b.rss_mb || 0) - Number(a.rss_mb || 0);
      }
      if (projectSortBy === 'name') {
        return a.name.localeCompare(b.name);
      }
      const rank = (s: string | undefined) => {
        const v = (s || 'stopped').toLowerCase();
        if (v === 'waiting_input' || v === 'crash_loop') return 0;
        if (v === 'running') return 1;
        if (v === 'failed' || v === 'crashed' || v === 'killed_oom' || v === 'timeout') return 2;
        return 3;
      };
      const diff = rank(a.current_status) - rank(b.current_status);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

  if (!activeProj) {
    return (
      <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-10 text-center space-y-4">
        <FolderCode className="w-10 h-10 text-indigo-400 mx-auto" />
        <div className="space-y-1">
          <h3 className="text-base font-bold text-white">Рабочая область проектов пуста</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Создайте новый проект (бота, веб-сервис с портом $PORT или периодическую задачу) либо загрузите готовые
            эталонные шаблоны в один клик.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <button
            type="button"
            onClick={onOpenCreateModal}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Создать новый проект
          </button>
          {onImportExamples && (
            <button
              type="button"
              disabled={importingExamples}
              onClick={async () => {
                setImportingExamples(true);
                try {
                  await onImportExamples();
                } finally {
                  setImportingExamples(false);
                }
              }}
              className="px-4 py-2 text-xs font-semibold text-slate-200 bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-indigo-400" />
              {importingExamples ? 'Импорт шаблонов...' : 'Импортировать 5 демо-проектов'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const webhookUrl = `${window.location.origin}/api/webhook/${activeProj.webhook_token}`;
  const pingUrl = `${window.location.origin}/api/ping/${activeProj.ping_token || '<ping_token>'}`;
  const isConfigTab = subTab === 'simple_cfg' || subTab === 'advanced_cfg';

  const getProjectTypeMeta = (p: ProjectItem) => {
    if (p.type === 'web') {
      return {
        label: p.port ? `Web API :${p.port}` : 'Web API (:PORT)',
        color: 'text-cyan-300',
      };
    }
    if (p.type === 'service') {
      return {
        label: 'Service 24/7',
        color: 'text-indigo-300',
      };
    }
    return {
      label: p.schedule_expr
        ? p.schedule_type === 'interval'
          ? `Каждые ${p.schedule_expr}с`
          : p.schedule_type === 'daily'
          ? `Ежедневно ${p.schedule_expr}`
          : `Cron (${p.schedule_expr})`
        : 'Job / Скрипт',
      color: 'text-amber-300',
    };
  };

  const activeTypeMeta = getProjectTypeMeta(activeProj);
  const activeStatus = activeProj.current_status || 'stopped';
  const activeCookieInfo = activeProj.cookie_status;
  const activeRamUsed = Number(activeProj.rss_mb || 0);
  const activeRamLimit = Number(activeProj.ram_limit_mb ?? 128);
  const activeRamPct =
    activeRamLimit > 0 ? Math.min(100, Math.round((activeRamUsed / activeRamLimit) * 100)) : 0;
  const activeCpuPct = Number(activeProj.cpu_percent || 0);
  const activeProcCount = Number(activeProj.proc_count || (activeProj.pid ? 1 : 0));
  const depsMeta = getDepsButtonMeta(activeProj.runtime);
  const activeRunItem =
    runs.find((r) => r.status === 'running' || r.status === 'waiting_input') || runs[0] || null;
  const isProjectCurrentlyRunning =
    activeStatus === 'running' || activeStatus === 'waiting_input';
  const liveUptimeStr = isProjectCurrentlyRunning
    ? formatLiveUptime(activeRunItem?.started_at, uptimeNowMs)
    : '';
  const dirtyDeployReason = dirtyDeployMap[activeProj.id] || '';
  const runningCountTotal = projects.filter(
    (p) => p.current_status === 'running' || p.current_status === 'waiting_input'
  ).length;
  const failedCountTotal = projects.filter((p) =>
    ['failed', 'crashed', 'crash_loop', 'killed_oom', 'timeout'].includes(
      (p.current_status || '').toLowerCase()
    )
  ).length;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
      {/* Модальное окно подтверждения удаления файла или папки (#1) */}
      <DeleteEntryConfirmModal
        entry={pendingDeleteEntry}
        projectName={activeProj.name}
        busy={deletingEntryBusy}
        onCancel={() => setPendingDeleteEntry(null)}
        onConfirm={executeConfirmedDeleteEntry}
      />

      {/* Быстрый переход к файлу по имени (Alt+P / Ctrl+P) (#15) */}
      <FuzzyFileModal
        open={fuzzyFinderOpen}
        projectName={activeProj.name}
        files={files}
        activeFilePath={activeFilePath}
        onSelectFile={(path) => loadSingleFile(activeProj.id, path)}
        onClose={() => setFuzzyFinderOpen(false)}
      />

      {/* Левая колонка: Навигатор проектов (сворачиваемый для максимального места под код и логи) */}
      {!sidebarCollapsed && (
        <aside className="xl:col-span-3 bg-[#111622] border border-[#1e2638] rounded-xl p-3 space-y-2.5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200 whitespace-nowrap">
                Проекты ({projects.length})
              </h2>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={onOpenCreateModal}
                  className="px-2.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Создать
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  aria-label="Свернуть список проектов"
                  className="p-1 text-slate-400 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg cursor-pointer hidden xl:inline-flex"
                  title="Свернуть список проектов, чтобы расширить редактор кода"
                >
                  <PanelLeftClose className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap text-[11px] font-mono">
              <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                В работе: {runningCountTotal}
              </span>
              {failedCountTotal > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800/60">
                  Сбоев: {failedCountTotal}
                </span>
              )}
            </div>
          </div>

          {/* Поиск по имени/команде + Сортировка */}
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="Фильтр проектов..."
                className="w-full bg-[#0b0f17] border border-[#1e2638] focus:border-indigo-500 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-white placeholder-slate-500 outline-none"
              />
            </div>
            <select
              value={projectSortBy}
              onChange={(e) => setProjectSortBy(e.target.value as any)}
              aria-label="Сортировка проектов"
              className="bg-[#0b0f17] border border-[#1e2638] rounded-lg px-2 py-1.5 text-[11px] font-mono text-slate-300 outline-none cursor-pointer"
              title="Сортировка списка проектов"
            >
              <option value="status">По статусу</option>
              <option value="ram">По ОЗУ</option>
              <option value="name">По имени</option>
            </select>
          </div>

          {/* Быстрый фильтр по архитектуре и статусу */}
          <div className="grid grid-cols-4 gap-1 bg-[#0b0f17] p-1 rounded-lg border border-[#1e2638]">
            {[
              { id: 'all', label: 'Все' },
              { id: 'service', label: '24/7' },
              { id: 'web', label: 'Web' },
              { id: 'job', label: 'Jobs' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setProjectTypeFilter(tab.id as any)}
                className={`py-1 rounded text-[11px] font-semibold transition-colors cursor-pointer ${
                  projectTypeFilter === tab.id
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-4 gap-1 text-[10px] font-mono">
            {[
              { id: 'all', label: 'Любой ст.' },
              { id: 'running', label: 'Работают' },
              { id: 'failed', label: 'Сбои' },
              { id: 'stopped', label: 'Стоп' },
            ].map((stTab) => (
              <button
                key={stTab.id}
                type="button"
                onClick={() => setProjectStatusFilter(stTab.id as any)}
                className={`py-1 rounded border transition-colors cursor-pointer ${
                  projectStatusFilter === stTab.id
                    ? 'bg-slate-800 text-white border-slate-600 font-semibold'
                    : 'bg-[#0b0f17]/60 text-slate-400 border-[#1e2638] hover:text-slate-200'
                }`}
              >
                {stTab.label}
              </button>
            ))}
          </div>

          {/* Список карточек проектов с быстрыми кнопками Старт/Стоп */}
          <div className="space-y-1.5 max-h-[640px] overflow-y-auto pr-0.5">
            {filteredProjects.map((p) => {
              const isSelected = p.id === activeProj.id;
              const pStatus = p.current_status || 'stopped';
              const st = statusBadge(pStatus);
              const tMeta = getProjectTypeMeta(p);
              const isRunning = pStatus === 'running' || pStatus === 'waiting_input';

              return (
                <div
                  key={p.id}
                  onClick={() => onSelectProject(p)}
                  className={`group rounded-lg p-2.5 border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-indigo-950/35 border-indigo-500/60 shadow-sm'
                      : 'bg-[#0b0f17]/80 border-[#1e2638] hover:border-slate-700 hover:bg-[#0b0f17]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          pStatus === 'running'
                            ? 'bg-emerald-400'
                            : pStatus === 'waiting_input'
                            ? 'bg-amber-400 animate-pulse'
                            : pStatus === 'failed' || pStatus === 'killed_oom' || pStatus === 'crash_loop'
                            ? 'bg-rose-500'
                            : 'bg-slate-600'
                        }`}
                      />
                      <span className="text-xs font-bold text-white truncate">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={Boolean(procActionBusy)}
                        aria-label={isRunning ? `Остановить ${p.name}` : `Запустить ${p.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isRunning) {
                            triggerStopProjectSafe(p.id);
                          } else {
                            triggerStartProjectSafe(p.id);
                          }
                        }}
                        className={`p-1 rounded border transition-colors cursor-pointer disabled:opacity-40 ${
                          isRunning
                            ? 'bg-rose-950/50 hover:bg-rose-800/70 text-rose-300 border-rose-800/60'
                            : 'bg-emerald-950/50 hover:bg-emerald-800/70 text-emerald-300 border-emerald-800/60'
                        }`}
                        title={isRunning ? `Остановить ${p.name}` : `Запустить ${p.name}`}
                      >
                        {isRunning ? <Square className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5" />}
                      </button>
                      <span className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${st.cls}`}>{st.label}</span>
                    </div>
                  </div>

                  <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                    <span className={tMeta.color}>{tMeta.label}</span>
                    <span>
                      {isRunning
                        ? `${p.cpu_percent ? `${p.cpu_percent.toFixed(1)}% CPU · ` : ''}${p.rss_mb || 0} МБ`
                        : formatBytes(p.total_size_bytes || 0)}
                    </span>
                  </div>

                  {p.cookie_status?.has_cookies && p.cookie_status.is_expired === 1 && (
                    <div className="mt-1.5 text-[10px] font-mono text-rose-300 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span>Куки истекли — обновите JSON</span>
                    </div>
                  )}
                </div>
              );
            })}

            {filteredProjects.length === 0 && (
              <div className="py-6 text-center text-xs text-slate-400">
                Проекты по фильтру не найдены
              </div>
            )}
          </div>
        </aside>
      )}

      {/* Правая колонка: Рабочее пространство выбранного проекта */}
      <div className={`${sidebarCollapsed ? 'xl:col-span-12' : 'xl:col-span-9'} space-y-3.5 min-w-0`}>
        {/* Верхний паспорт и панель управления проектом */}
        <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-3.5 space-y-2.5">
          {/* Ряд 1: Переключатель проекта, статусы и главные кнопки управления */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <button
                type="button"
                onClick={() => setSidebarCollapsed((v) => !v)}
                aria-label={sidebarCollapsed ? 'Показать боковую панель проектов' : 'Скрыть боковую панель проектов'}
                className="p-1.5 text-slate-300 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg hidden xl:inline-flex items-center gap-1 text-xs font-mono cursor-pointer shrink-0"
                title={sidebarCollapsed ? 'Показать боковую панель проектов' : 'Скрыть боковую панель проектов'}
              >
                {sidebarCollapsed ? (
                  <>
                    <PanelLeftOpen className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Список ({projects.length})</span>
                  </>
                ) : (
                  <PanelLeftClose className="w-3.5 h-3.5 text-slate-400" />
                )}
              </button>

              {/* Быстрый переключатель проекта прямо в шапке */}
              <select
                value={activeProj.id}
                onChange={(e) => {
                  const found = projects.find((x) => x.id === Number(e.target.value));
                  if (found) onSelectProject(found);
                }}
                aria-label="Быстрое переключение активного проекта"
                className="bg-[#0b0f17] border border-[#1e2638] hover:border-indigo-500/60 rounded-lg px-2.5 py-1.5 text-sm font-bold text-white outline-none cursor-pointer"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.type === 'web' ? `Web :${p.port || ''}` : p.type === 'service' ? '24/7' : 'Job'})
                  </option>
                ))}
              </select>

              <span className={`px-2 py-0.5 text-xs font-mono rounded ${statusBadge(activeStatus).cls}`}>
                {statusBadge(activeStatus).label}
              </span>

              {activeProj.autostart === 1 && (
                <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-indigo-950/50 text-indigo-300 border border-indigo-800/60">
                  Автостарт
                </span>
              )}

              {activeProj.use_proxy === 1 && (
                <span className="px-2 py-0.5 text-[11px] font-mono rounded bg-cyan-950/50 text-cyan-300 border border-cyan-800/60">
                  Прокси вкл.
                </span>
              )}

              {activeCookieInfo?.has_cookies && (
                <span
                  className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                    activeCookieInfo.is_expired === 0
                      ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800/60'
                      : 'bg-rose-950/60 text-rose-300 border-rose-800/70'
                  }`}
                >
                  Cookies: {activeCookieInfo.is_expired === 0 ? `OK (${formatBytes(activeCookieInfo.size_bytes)})` : 'ИСТЕКЛИ'}
                </span>
              )}

              {healthcheckResult && (
                <span
                  className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                    healthcheckResult.ok
                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/70'
                      : 'bg-rose-950/60 text-rose-300 border-rose-700/70'
                  }`}
                  title={healthcheckResult.url}
                >
                  {healthcheckResult.ok
                    ? `Health OK (${healthcheckResult.status_code} · ${healthcheckResult.latency_ms} мс)`
                    : `Health FAIL (${healthcheckResult.error || healthcheckResult.status_code})`}
                </span>
              )}
            </div>

            {/* Главные кнопки управления процессом + Компактное меню «⋮ Действия» (#3, #7, #9) */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {isProjectCurrentlyRunning ? (
                <>
                  <button
                    type="button"
                    disabled={Boolean(procActionBusy)}
                    onClick={() => triggerStopProjectSafe(activeProj.id)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <Square className="w-3.5 h-3.5" />
                    {procActionBusy === 'stop' ? 'Остановка...' : LABELS.stopBtn}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(procActionBusy)}
                    onClick={() => triggerRestartProjectSafe(activeProj.id)}
                    className="px-2.5 py-1.5 text-xs font-semibold text-slate-200 bg-[#0b0f17] hover:bg-slate-800 disabled:opacity-50 border border-[#1e2638] rounded-lg inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    title="Перезапустить процесс (Ctrl+Enter)"
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${procActionBusy === 'restart' ? 'animate-spin' : ''}`} />
                    {procActionBusy === 'restart' ? 'Рестарт...' : LABELS.restartBtn}
                  </button>
                </>
              ) : (
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    disabled={Boolean(procActionBusy)}
                    onClick={() => {
                      const hasFilledParams = Object.keys(runParamValues).some((k) => runParamValues[k]?.trim());
                      triggerStartProjectSafe(activeProj.id, hasFilledParams ? runParamValues : undefined);
                    }}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                    title="Запустить процесс сейчас (Ctrl+Enter)"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {procActionBusy === 'start' ? 'Запуск...' : LABELS.startNowBtn}
                  </button>
                  {cfgParamsSchema.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowRunParamsBar((v) => !v)}
                      className={`px-2 py-1.5 text-xs font-mono rounded-lg border inline-flex items-center gap-1 cursor-pointer ${
                        showRunParamsBar
                          ? 'bg-emerald-950/60 text-emerald-200 border-emerald-600'
                          : 'bg-[#0b0f17] text-slate-300 border-[#1e2638] hover:text-white'
                      }`}
                      title="Задать параметры PARAM_* перед запуском"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>PARAM ({cfgParamsSchema.length})</span>
                    </button>
                  )}
                </div>
              )}

              {(activeProj.type === 'web' || (activeProj.port || 0) > 0 || Boolean(activeProj.healthcheck_url)) && (
                <button
                  type="button"
                  disabled={healthcheckTesting}
                  onClick={handleProbeHealthcheckNow}
                  className="px-2.5 py-1.5 text-xs font-semibold text-cyan-200 bg-cyan-950/40 hover:bg-cyan-900/60 border border-cyan-800/60 rounded-lg inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  title="Проверить HTTP/TCP доступность порта $PORT или Healthcheck URL прямо сейчас"
                >
                  <Activity className="w-3.5 h-3.5 text-cyan-400" />
                  {healthcheckTesting ? 'Проверка...' : LABELS.healthProbeBtn}
                </button>
              )}

              {depsMeta.show && (
                <button
                  type="button"
                  disabled={venvSetupRunning}
                  onClick={handleQuickSetupVenv}
                  className="px-2.5 py-1.5 text-xs font-semibold text-indigo-200 bg-indigo-950/50 hover:bg-indigo-900/60 border border-indigo-800/60 rounded-lg inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  title={depsMeta.title}
                >
                  <Package className="w-3.5 h-3.5 text-indigo-400" />
                  {venvSetupRunning ? 'Установка...' : depsMeta.label}
                </button>
              )}

              {/* Выпадающее меню второстепенных операций «⋮ Действия» (#7) */}
              <div ref={actionsMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setActionsMenuOpen((v) => !v)}
                  aria-label="Дополнительные действия с проектом"
                  aria-expanded={actionsMenuOpen}
                  className="px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1 cursor-pointer"
                  title="Клонирование, экспорт .zip, быстрый переход к файлу (Alt+P), очистка логов и удаление"
                >
                  <span>⋮ {LABELS.moreActionsBtn}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                </button>

                {actionsMenuOpen && (
                  <div className="absolute right-0 mt-1.5 w-64 bg-[#0b0f17] border border-[#1e2638] rounded-xl shadow-2xl py-1.5 z-40 text-xs font-mono">
                    <button
                      type="button"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        setFuzzyFinderOpen(true);
                      }}
                      className="w-full px-3 py-2 text-left text-slate-200 hover:bg-[#111622] hover:text-white flex items-center justify-between cursor-pointer"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Search className="w-3.5 h-3.5 text-indigo-400" />
                        Найти файл...
                      </span>
                      <kbd className="text-[10px] text-slate-400 bg-[#111622] px-1.5 py-0.5 rounded border border-[#1e2638]">
                        Alt+P
                      </kbd>
                    </button>

                    {onCloneProject && (
                      <button
                        type="button"
                        onClick={() => {
                          setActionsMenuOpen(false);
                          onCloneProject(activeProj.id);
                        }}
                        className="w-full px-3 py-2 text-left text-slate-200 hover:bg-[#111622] hover:text-white flex items-center gap-2 cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Клонировать проект</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        handleDownloadProjectOrFolderZip('');
                      }}
                      className="w-full px-3 py-2 text-left text-slate-200 hover:bg-[#111622] hover:text-white flex items-center gap-2 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Экспортировать проект (.zip)</span>
                    </button>

                    <button
                      type="button"
                      disabled={clearingLogsBusy}
                      onClick={() => {
                        setActionsMenuOpen(false);
                        handleClearOldLogs();
                      }}
                      className="w-full px-3 py-2 text-left text-slate-200 hover:bg-[#111622] hover:text-white flex items-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                      <span>Очистить историю старых логов</span>
                    </button>

                    <div className="my-1 border-t border-[#1e2638]" />

                    <button
                      type="button"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        setDeleteFilesCheckbox(false);
                        setDeleteConfirmOpen(true);
                      }}
                      className="w-full px-3 py-2 text-left text-rose-300 hover:bg-rose-950/40 hover:text-rose-200 flex items-center gap-2 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                      <span>Удалить проект...</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Ряд 2: Живая телеметрия процесса, аптайм (#18) и ресурсы группы PGID */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-mono text-slate-300 tabular-nums pt-1.5 border-t border-[#1e2638]/60">
            <span className={activeTypeMeta.color}>{activeTypeMeta.label}</span>
            <span className="text-slate-600">·</span>
            <span>{activeProj.runtime}</span>
            <span className="text-slate-600">·</span>
            <code className="text-slate-300 bg-[#0b0f17] px-1.5 py-0.5 rounded border border-[#1e2638] truncate max-w-md" title={activeProj.cmd}>
              {activeProj.cmd}
            </code>
            {activeProj.pid && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-emerald-300">
                  PID {activeProj.pid} / PGID {activeProj.pgid || activeProj.pid}
                  {activeProcCount > 1 ? ` (${activeProcCount} воркера)` : ''}
                </span>
              </>
            )}
            {liveUptimeStr && (
              <>
                <span className="text-slate-600">·</span>
                <span
                  className="px-1.5 py-0.5 rounded bg-emerald-950/50 text-emerald-300 border border-emerald-800/60"
                  title="Время непрерывной работы текущего процесса"
                >
                  ⏱ Uptime {liveUptimeStr}
                </span>
              </>
            )}
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1">
              <Cpu className="w-3 h-3 text-indigo-400" />
              <span>CPU {activeCpuPct.toFixed(1)}%</span>
            </span>
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span>
                ОЗУ {activeRamUsed} / {activeRamLimit > 0 ? `${activeRamLimit} МБ` : 'Без лимита'}
              </span>
              {activeRamLimit > 0 && (
                <span className="w-14 h-1.5 bg-slate-800 rounded-full overflow-hidden inline-block align-middle">
                  <span
                    style={{ width: `${activeRamPct}%` }}
                    className={`block h-full ${
                      activeRamPct > 85
                        ? 'bg-rose-500'
                        : activeRamPct > 65
                        ? 'bg-amber-400'
                        : 'bg-emerald-400'
                    }`}
                  />
                </span>
              )}
            </span>
            <span className="text-slate-600">·</span>
            <span>Диск {formatBytes(activeProj.total_size_bytes || 0)}</span>
          </div>

          {/* Индикатор Dirty Deploy (#12): предупреждение, когда код или конфиг сохранён, а процесс ещё работает на старой версии */}
          {isProjectCurrentlyRunning && dirtyDeployReason && (
            <DirtyDeployBanner
              reason={dirtyDeployReason}
              busy={Boolean(procActionBusy)}
              onRestartNow={() => triggerRestartProjectSafe(activeProj.id)}
              onDismiss={() =>
                setDirtyDeployMap((prev) => {
                  const next = { ...prev };
                  delete next[activeProj.id];
                  return next;
                })
              }
            />
          )}

          {deleteConfirmOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`Удаление проекта ${activeProj.name}`}
              className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
            >
              <div className="bg-[#111622] border border-rose-500/50 rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl">
                <div className="flex items-center gap-2.5 text-rose-300">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <h3 className="text-sm font-bold text-white">Удалить проект «{activeProj.name}»?</h3>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Запущенные процессы будут остановлены по PGID, а запись о проекте и история запусков будут удалены из базы данных Beacon.
                </p>
                <label className="flex items-start gap-2.5 p-3 bg-[#0b0f17] border border-slate-800 rounded-lg text-xs text-rose-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteFilesCheckbox}
                    onChange={(e) => setDeleteFilesCheckbox(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Также удалить рабочую папку с диска (<code className="font-mono text-rose-300">{activeProj.workdir}</code>)
                  </span>
                </label>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmOpen(false)}
                    className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setDeleteConfirmOpen(false);
                      await onDeleteProject(activeProj.id, deleteFilesCheckbox);
                    }}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg cursor-pointer"
                  >
                    Подтвердить удаление
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Выдвижная панель передачи параметров PARAM_* перед запуском */}
          {showRunParamsBar && cfgParamsSchema.length > 0 && (
            <div className="p-3 bg-[#0b0f17] border border-emerald-700/50 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5" />
                  Параметры запуска (передаются в окружение как PARAM_*)
                </span>
                <button
                  type="button"
                  onClick={() => setShowRunParamsBar(false)}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                {cfgParamsSchema.map((param) => (
                  <div key={param.name} className="space-y-1">
                    <label className="block text-[11px] font-mono text-slate-300">
                      PARAM_{param.name}{' '}
                      {param.label ? <span className="text-slate-500">({param.label})</span> : null}
                    </label>
                    <input
                      type="text"
                      value={runParamValues[param.name] ?? param.default ?? ''}
                      onChange={(e) =>
                        setRunParamValues((prev) => ({
                          ...prev,
                          [param.name]: e.target.value,
                        }))
                      }
                      placeholder={param.default || 'Значение...'}
                      className="w-full bg-[#111622] border border-[#1e2638] focus:border-emerald-500 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white outline-none"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Навигация по 4 рабочим вкладкам проекта + Переключатели компоновки экрана */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#1e2638]">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSubTab('editor')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer ${
                  subTab === 'editor'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-[#0b0f17] hover:text-white'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                Код и Файлы ({files.filter((f) => !f.is_dir).length})
              </button>

              <button
                type="button"
                onClick={() => setSubTab('simple_cfg')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer ${
                  isConfigTab
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-[#0b0f17] hover:text-white'
                }`}
              >
                <Settings2 className="w-3.5 h-3.5" />
                Конфигурация и Супервизор
              </button>

              <button
                type="button"
                onClick={() => setSubTab('cookies_tg')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer ${
                  subTab === 'cookies_tg'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-[#0b0f17] hover:text-white'
                }`}
              >
                <Cookie className="w-3.5 h-3.5" />
                Куки, Прокси и Telegram
                {activeCookieInfo?.has_cookies && activeCookieInfo.is_expired === 1 && (
                  <span className="w-2 h-2 rounded-full bg-rose-400 animate-ping" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setSubTab('terminal_git')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer ${
                  subTab === 'terminal_git'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-[#0b0f17] hover:text-white'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                Терминал, Git и История ({runs.length})
              </button>
            </div>

            {/* Управление рабочей областью (Проводник, Split-View с логами, Высота редактора) */}
            {subTab === 'editor' && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setExplorerCollapsed((v) => !v)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-mono border inline-flex items-center gap-1.5 cursor-pointer ${
                    explorerCollapsed
                      ? 'bg-indigo-950/50 text-indigo-200 border-indigo-700/60'
                      : 'bg-[#0b0f17] text-slate-300 border-[#1e2638] hover:text-white'
                  }`}
                  title={explorerCollapsed ? 'Показать проводник файлов' : 'Скрыть проводник файлов для расширения кода'}
                >
                  <FolderCode className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{explorerCollapsed ? 'Показать проводник' : 'Скрыть проводник'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSplitConsoleMode((v) => !v)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-mono border inline-flex items-center gap-1.5 cursor-pointer ${
                    splitConsoleMode
                      ? 'bg-emerald-950/60 text-emerald-200 border-emerald-600/70'
                      : 'bg-[#0b0f17] text-slate-300 border-[#1e2638] hover:text-white'
                  }`}
                  title="Разместить консоль живого лога справа от кода (Split-View) или снизу"
                >
                  <Columns className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{splitConsoleMode ? 'Код + Логи рядом' : 'Логи сбоку (Split)'}</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setEditorHeightMode((prev) =>
                      prev === 'normal' ? 'tall' : prev === 'tall' ? 'normal' : 'normal'
                    )
                  }
                  className="px-2.5 py-1.5 rounded-lg text-xs font-mono bg-[#0b0f17] text-slate-300 hover:text-white border border-[#1e2638] inline-flex items-center gap-1 cursor-pointer"
                  title="Переключить высоту окна кода (Компактный 500px / Высокий 700px)"
                >
                  <span>{editorHeightMode === 'tall' ? 'Высота: 700px' : 'Высота: 500px'}</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setEditorHeightMode((prev) => (prev === 'fullscreen' ? 'normal' : 'fullscreen'))
                  }
                  className={`p-1.5 rounded-lg text-xs font-mono border inline-flex items-center gap-1 cursor-pointer ${
                    editorHeightMode === 'fullscreen'
                      ? 'bg-indigo-600 text-white border-indigo-500'
                      : 'bg-[#0b0f17] text-slate-300 hover:text-white border-[#1e2638]'
                  }`}
                  title={
                    editorHeightMode === 'fullscreen'
                      ? 'Выйти из полноэкранного режима IDE'
                      : 'Развернуть редактор кода и логи на весь экран'
                  }
                >
                  {editorHeightMode === 'fullscreen' ? (
                    <Minimize2 className="w-3.5 h-3.5" />
                  ) : (
                    <Maximize2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Вспомогательный рендер консоли логов / beacon.state / Быстрого Shell (используется либо сбоку в Split-View, либо снизу) */}
        {(() => {
          const renderConsolePanel = (isSideBySide: boolean) => {
            const logHeightCls = isSideBySide
              ? editorHeightMode === 'fullscreen'
                ? 'flex-1 min-h-0'
                : editorHeightMode === 'tall'
                ? 'h-[590px]'
                : 'h-[410px]'
              : consoleExpanded
              ? 'h-[460px]'
              : 'h-60';

            return (
              <div
                className={`bg-[#111622] border border-[#1e2638] rounded-xl overflow-hidden flex flex-col ${
                  isSideBySide ? 'h-full border-0 rounded-none bg-[#070b14]' : ''
                }`}
              >
                <div className="px-3.5 py-2 bg-[#0b0f17] border-b border-[#1e2638] flex flex-wrap items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setBottomConsoleTab('logs')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                        bottomConsoleTab === 'logs'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-[#111622]'
                      }`}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      Живой лог
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setBottomConsoleTab('kv');
                        loadProjectKv(activeProj.id);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                        bottomConsoleTab === 'kv'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-[#111622]'
                      }`}
                    >
                      <Database className="w-3.5 h-3.5" />
                      state ({kvItems.length})
                    </button>

                    <button
                      type="button"
                      onClick={() => setBottomConsoleTab('shell')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                        bottomConsoleTab === 'shell'
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-[#111622]'
                      }`}
                    >
                      <Package className="w-3.5 h-3.5" />
                      Shell
                    </button>
                  </div>

                  {bottomConsoleTab === 'logs' && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="text"
                        value={logSearchQuery}
                        onChange={(e) => setLogSearchQuery(e.target.value)}
                        placeholder="Фильтр лога..."
                        className="bg-[#111622] border border-[#1e2638] rounded-lg px-2 py-1 text-xs text-white font-mono w-28 sm:w-36"
                      />
                      <select
                        value={selectedRunId || ''}
                        onChange={(e) => setSelectedRunId(Number(e.target.value))}
                        aria-label="Выбор запуска для просмотра лога"
                        className="bg-[#111622] border border-[#1e2638] rounded-lg px-2 py-1 text-xs font-mono text-slate-200 max-w-[190px]"
                      >
                        {runs.map((r) => (
                          <option key={r.id} value={r.id}>
                            #{r.id} · {r.status} ({formatShortTime(r.started_at)})
                          </option>
                        ))}
                      </select>
                      {!isSideBySide && (
                        <button
                          type="button"
                          onClick={() => setConsoleExpanded((v) => !v)}
                          className="p-1 text-slate-400 hover:text-white bg-[#111622] border border-[#1e2638] rounded-lg cursor-pointer"
                          title={consoleExpanded ? 'Свернуть консоль' : 'Развернуть консоль по высоте'}
                        >
                          {consoleExpanded ? (
                            <Minimize2 className="w-3.5 h-3.5" />
                          ) : (
                            <Maximize2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {bottomConsoleTab === 'logs' && (
                  <div className="flex flex-col flex-1 min-h-0">
                    <pre
                      ref={logBoxRef}
                      className={`p-3.5 text-xs font-mono text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed bg-[#070b14] ${logHeightCls}`}
                    >
                      {(logSearchQuery.trim()
                        ? (logText || '')
                            .split('\n')
                            .filter((line) => line.toLowerCase().includes(logSearchQuery.toLowerCase()))
                            .join('\n')
                        : logText) || 'Ожидание вывода процесса...'}
                    </pre>

                    <form
                      onSubmit={handleSendStdin}
                      className="px-3.5 py-2 bg-[#0b0f17] border-t border-[#1e2638] flex items-center gap-2 shrink-0"
                    >
                      <span className="text-xs font-mono text-indigo-400 shrink-0">stdin &gt;</span>
                      <input
                        type="text"
                        value={stdinInput}
                        onChange={(e) => setStdinInput(e.target.value)}
                        placeholder="Отправить 2FA код / строку в stdin..."
                        className="flex-1 bg-transparent text-xs font-mono text-white focus:outline-none min-w-0"
                      />
                      {stdinStatus && <StatusNoticeBanner text={stdinStatus} compact />}
                      <button
                        type="submit"
                        className="px-2.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        <Send className="w-3 h-3" />
                        Ввод
                      </button>
                    </form>
                  </div>
                )}

                {bottomConsoleTab === 'kv' && (
                  <div className="p-3.5 space-y-3 bg-[#070b14] flex-1 overflow-y-auto">
                    <form onSubmit={handleSaveKv} className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={newKvKey}
                        onChange={(e) => setNewKvKey(e.target.value)}
                        placeholder="Ключ (last_id, cursor)"
                        className="bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white flex-1 min-w-[130px]"
                      />
                      <input
                        type="text"
                        value={newKvVal}
                        onChange={(e) => setNewKvVal(e.target.value)}
                        placeholder="Значение (JSON или строка)"
                        className="bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white flex-1 min-w-[150px]"
                      />
                      <button
                        type="submit"
                        disabled={savingKvBusy}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold cursor-pointer"
                      >
                        {savingKvBusy ? 'Сохранение...' : 'Сохранить'}
                      </button>
                      {kvStatus && <StatusNoticeBanner text={kvStatus} compact />}
                    </form>

                    {kvItems.length === 0 ? (
                      <div className="text-xs text-slate-400 py-4 text-center font-mono">
                        Хранилище beacon.state пусто. В коде:{' '}
                        <code className="text-indigo-300">beacon.state.set(&quot;key&quot;, &quot;val&quot;)</code>
                      </div>
                    ) : (
                      <div className="max-h-52 overflow-y-auto border border-[#1e2638] rounded-lg">
                        <table className="w-full text-left border-collapse text-xs font-mono">
                          <thead>
                            <tr className="border-b border-[#1e2638] bg-[#111622] text-slate-400">
                              <th className="py-1.5 px-2.5">Ключ</th>
                              <th className="py-1.5 px-2.5">Значение</th>
                              <th className="py-1.5 px-2.5 text-right">Действие</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#1e2638]">
                            {kvItems.map((item) => (
                              <tr key={item.key} className="hover:bg-[#111622]/60">
                                <td className="py-1.5 px-2.5 text-indigo-300 font-semibold">{item.key}</td>
                                <td className="py-1.5 px-2.5 text-slate-200 break-all">
                                  {typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}
                                </td>
                                <td className="py-1.5 px-2.5 text-right">
                                  <button
                                    type="button"
                                    disabled={savingKvBusy}
                                    onClick={() => handleDeleteKv(item.key)}
                                    className="text-rose-400 hover:text-rose-300 disabled:opacity-40 cursor-pointer"
                                  >
                                    Удалить
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {bottomConsoleTab === 'shell' && (
                  <div className="p-3.5 space-y-3 bg-[#070b14] flex-1 overflow-y-auto">
                    <form onSubmit={handleExecCommand} className="flex items-center gap-2">
                      <span className="text-xs font-mono text-emerald-400 shrink-0">.venv $</span>
                      <input
                        type="text"
                        value={cliCommand}
                        onChange={(e) => setCliCommand(e.target.value)}
                        placeholder="pip install ..., python3 -m ..., git status"
                        className="flex-1 bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white min-w-0"
                      />
                      <button
                        type="submit"
                        disabled={cliRunning}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50 shrink-0"
                      >
                        {cliRunning ? '...' : 'Выполнить'}
                      </button>
                    </form>
                    <pre className="text-xs font-mono text-slate-300 max-h-48 overflow-y-auto whitespace-pre-wrap">
                      {cliOutput || 'Введите команду выше для запуска внутри рабочего окружения проекта.'}
                    </pre>
                  </div>
                )}
              </div>
            );
          };

          const recommendedWorkers = Math.max(2, Math.min(16, Number(system?.cpu_count || 2)));

          return (
            <>
              {/* ==================== ВКЛАДКА 1: КОД И ФАЙЛЫ (IDE С ФИКСИРОВАННОЙ ВЫСОТОЙ И SPLIT-VIEW) ==================== */}
              {subTab === 'editor' && (() => {
                const langMeta = getFileLanguageMeta(activeFilePath);
                const lineCount = Math.max(1, fileContent.split('\n').length);
                const isDirty =
                  Boolean(activeFilePath) &&
                  savedContents[activeFilePath] !== undefined &&
                  fileContent !== savedContents[activeFilePath];
                const filterQuery = explorerFilter.trim().toLowerCase();

                const filterTreeNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
                  if (!filterQuery) return nodes;
                  const res: FileTreeNode[] = [];
                  for (const n of nodes) {
                    if (n.type === 'dir') {
                      const filteredChildren = filterTreeNodes(n.children || []);
                      if (n.path.toLowerCase().includes(filterQuery) || filteredChildren.length > 0) {
                        res.push({ ...n, children: filteredChildren });
                      }
                    } else if (n.path.toLowerCase().includes(filterQuery)) {
                      res.push(n);
                    }
                  }
                  return res;
                };

                const visibleTree = filterTreeNodes(fileTree);

                const renderExplorerNode = (node: FileTreeNode, depth = 0): React.ReactNode => {
                  const indentPx = depth * 12;
                  const isRenamingThis = renamingPath === node.path;

                  if (isRenamingThis) {
                    return (
                      <form
                        key={`rename-${node.path}`}
                        onSubmit={handleRenameEntry}
                        style={{ paddingLeft: `${indentPx}px` }}
                        className="flex items-center gap-1 py-1 pr-1"
                      >
                        <input
                          type="text"
                          value={renameTargetValue}
                          onChange={(e) => setRenameTargetValue(e.target.value)}
                          autoFocus
                          className="flex-1 min-w-0 bg-[#070b14] border border-indigo-500 rounded px-2 py-1 text-[11px] font-mono text-white outline-none"
                        />
                        <button
                          type="submit"
                          className="p-1 text-emerald-400 hover:text-emerald-200 bg-[#111622] border border-[#1e2638] rounded cursor-pointer"
                          title="Сохранить новое имя"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingPath(null)}
                          className="p-1 text-slate-400 hover:text-white bg-[#111622] border border-[#1e2638] rounded cursor-pointer"
                          title="Отмена"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </form>
                    );
                  }

                  if (node.type === 'dir') {
                    const isExpanded = Boolean(filterQuery) || Boolean(expandedDirs[node.path]);
                    const isSelectedFolder = selectedDir === node.path;
                    const childCount = node.children?.length || 0;

                    return (
                      <div key={node.path} className="select-none">
                        <div
                          style={{ paddingLeft: `${indentPx + 6}px` }}
                          onClick={() => {
                            setExpandedDirs((prev) => ({ ...prev, [node.path]: !isExpanded }));
                            setSelectedDir(node.path);
                          }}
                          className={`group flex items-center justify-between gap-1.5 pr-2 py-1.5 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                            isSelectedFolder
                              ? 'bg-amber-950/40 text-amber-200 border border-amber-700/50'
                              : 'text-amber-300/90 hover:bg-[#111622] hover:text-amber-200 border border-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            )}
                            {isExpanded ? (
                              <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            ) : (
                              <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            )}
                            <span className="truncate font-semibold" title={node.path}>
                              {node.name}/
                            </span>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-[10px] text-slate-500 group-hover:hidden">
                              {childCount} ф.
                            </span>
                            <div
                              className="hidden group-hover:flex items-center gap-0.5"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                aria-label={`Создать файл в папке ${node.path}`}
                                onClick={() => {
                                  setSelectedDir(node.path);
                                  setExpandedDirs((prev) => ({ ...prev, [node.path]: true }));
                                  setNewFileName('');
                                  setFileActionMode('new_file');
                                }}
                                className="p-0.5 text-slate-400 hover:text-indigo-300 rounded cursor-pointer"
                                title={`Создать файл в папке ${node.path}/`}
                              >
                                <FilePlus className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Скачать папку ${node.path} как .zip`}
                                onClick={() => handleDownloadProjectOrFolderZip(node.path)}
                                className="p-0.5 text-slate-400 hover:text-emerald-300 rounded cursor-pointer"
                                title={`Скачать папку ${node.path} как .zip`}
                              >
                                <Download className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Переименовать папку ${node.path}`}
                                onClick={() => {
                                  setRenamingPath(node.path);
                                  setRenameTargetValue(node.path);
                                }}
                                className="p-0.5 text-slate-400 hover:text-white rounded cursor-pointer"
                                title="Переименовать или переместить папку"
                              >
                                <Edit3 className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Удалить папку ${node.path}`}
                                onClick={() => requestDeleteFileOrFolder(node.path, true)}
                                className="p-0.5 text-slate-400 hover:text-rose-400 rounded cursor-pointer"
                                title={`Удалить папку ${node.path}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="mt-0.5 space-y-0.5">
                            {node.children && node.children.length > 0 ? (
                              node.children.map((child) => renderExplorerNode(child, depth + 1))
                            ) : (
                              <div
                                style={{ paddingLeft: `${indentPx + 28}px` }}
                                className="py-1 text-[11px] font-mono text-slate-500 flex items-center justify-between pr-2"
                              >
                                <span>Пустая папка</span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedDir(node.path);
                                    setFileActionMode('new_file');
                                  }}
                                  className="text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                                >
                                  + файл
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }

                  const active = node.path === activeFilePath;
                  const fileUnsaved =
                    savedContents[node.path] !== undefined &&
                    draftContents[node.path] !== undefined &&
                    savedContents[node.path] !== draftContents[node.path];

                  return (
                    <div
                      key={node.path}
                      style={{ paddingLeft: `${indentPx + 8}px` }}
                      onClick={() => loadSingleFile(activeProj.id, node.path)}
                      className={`group flex items-center justify-between gap-1.5 pr-2 py-1.5 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                        active
                          ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                          : 'text-slate-300 hover:bg-[#111622] hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <FileCode
                          className={`w-3.5 h-3.5 shrink-0 ${
                            active
                              ? 'text-white'
                              : node.name.endsWith('.py')
                              ? 'text-indigo-400'
                              : node.name.endsWith('.js')
                              ? 'text-amber-400'
                              : node.name.endsWith('.json') || node.name.endsWith('.yaml')
                              ? 'text-emerald-400'
                              : 'text-slate-400'
                          }`}
                        />
                        <span className="truncate" title={node.path}>
                          {node.name}
                        </span>
                        {fileUnsaved && (
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${active ? 'bg-amber-300' : 'bg-amber-400'}`}
                            title="Есть несохранённые изменения"
                          />
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-[10px] group-hover:hidden ${
                            active ? 'text-indigo-100' : 'text-slate-400'
                          }`}
                        >
                          {formatBytes(node.size || 0)}
                        </span>
                        <div
                          className="hidden group-hover:flex items-center gap-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            aria-label={`Скачать файл ${node.path}`}
                            onClick={() => handleDownloadSingleFile(node.path)}
                            className={`p-0.5 rounded cursor-pointer ${
                              active ? 'text-indigo-100 hover:text-white' : 'text-slate-400 hover:text-emerald-300'
                            }`}
                            title="Скачать этот файл"
                          >
                            <Download className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Переименовать файл ${node.path}`}
                            onClick={() => {
                              setRenamingPath(node.path);
                              setRenameTargetValue(node.path);
                            }}
                            className={`p-0.5 rounded cursor-pointer ${
                              active ? 'text-indigo-100 hover:text-white' : 'text-slate-400 hover:text-white'
                            }`}
                            title="Переименовать или переместить файл"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Удалить файл ${node.path}`}
                            onClick={() => requestDeleteFileOrFolder(node.path, false)}
                            className={`p-0.5 rounded cursor-pointer ${
                              active ? 'text-indigo-100 hover:text-rose-200' : 'text-slate-400 hover:text-rose-400'
                            }`}
                            title="Удалить файл (с подтверждением)"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                };

                // Вычисляем классы колонок внутри IDE в зависимости от проводника и Split-View логов
                const explorerColCls = 'lg:col-span-3 xl:col-span-3';
                const editorColCls = explorerCollapsed
                  ? splitConsoleMode
                    ? 'lg:col-span-7 xl:col-span-7'
                    : 'lg:col-span-12 xl:col-span-12'
                  : splitConsoleMode
                  ? 'lg:col-span-5 xl:col-span-5'
                  : 'lg:col-span-9 xl:col-span-9';
                const splitConsoleColCls = explorerCollapsed
                  ? 'lg:col-span-5 xl:col-span-5'
                  : 'lg:col-span-4 xl:col-span-4';

                const codeViewportHeightCls =
                  editorHeightMode === 'fullscreen'
                    ? 'flex-1 min-h-0'
                    : editorHeightMode === 'tall'
                    ? 'h-[660px]'
                    : 'h-[470px]';

                return (
                  <div
                    className={`bg-[#111622] border border-[#1e2638] rounded-xl overflow-hidden ${
                      editorHeightMode === 'fullscreen'
                        ? 'fixed inset-3 z-50 flex flex-col shadow-2xl border-indigo-500/50'
                        : ''
                    }`}
                  >
                    {editorHeightMode === 'fullscreen' && (
                      <div className="px-4 py-2 bg-[#0b0f17] border-b border-[#1e2638] flex items-center justify-between gap-2 shrink-0">
                        <div className="flex items-center gap-2 text-xs font-mono text-white">
                          <FolderCode className="w-4 h-4 text-indigo-400" />
                          <span className="font-bold">{activeProj.name}</span>
                          <span className="text-slate-500">— Полноэкранный режим IDE (Esc для выхода)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setSplitConsoleMode((v) => !v)}
                            className="px-2.5 py-1 text-xs font-mono bg-[#111622] hover:bg-slate-800 text-emerald-300 border border-[#1e2638] rounded-lg cursor-pointer"
                          >
                            {splitConsoleMode ? 'Скрыть лог сбоку' : 'Показать лог сбоку'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditorHeightMode('normal')}
                            className="px-3 py-1 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Minimize2 className="w-3.5 h-3.5" />
                            Свернуть окно
                          </button>
                        </div>
                      </div>
                    )}

                    <div
                      className={`grid grid-cols-1 lg:grid-cols-12 ${
                        editorHeightMode === 'fullscreen' ? 'flex-1 min-h-0' : ''
                      }`}
                    >
                      {/* Левая боковая панель проводника файлов и папок с поддержкой Drag & Drop (#16) */}
                      {!explorerCollapsed && (
                        <div
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!explorerDragOver) setExplorerDragOver(true);
                          }}
                          onDragLeave={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setExplorerDragOver(false);
                          }}
                          onDrop={handleExplorerDrop}
                          className={`${explorerColCls} border-b lg:border-b-0 lg:border-r border-[#1e2638] bg-[#0b0f17]/75 p-3 flex flex-col justify-between gap-2.5 min-h-0 transition-colors ${
                            explorerDragOver ? 'ring-2 ring-inset ring-indigo-500 bg-indigo-950/25' : ''
                          }`}
                        >
                          <div className="space-y-2 flex flex-col flex-1 min-h-0">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5 whitespace-nowrap">
                                <FolderCode className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                Проводник
                              </span>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setFuzzyFinderOpen(true)}
                                  className="px-1.5 py-0.5 text-[10px] font-mono text-indigo-300 hover:text-white bg-[#111622] border border-[#1e2638] rounded cursor-pointer"
                                  title="Быстрый переход к файлу по имени (Alt+P или Ctrl+P)"
                                >
                                  Alt+P
                                </button>
                                <span className="text-[10px] font-mono text-slate-400">
                                  {files.filter((f) => !f.is_dir).length} ф. / {files.filter((f) => f.is_dir).length} п.
                                </span>
                              </div>
                              <input
                                ref={zipInputRef}
                                type="file"
                                multiple
                                accept=".zip,.py,.js,.ts,.json,.yaml,.yml,.txt,.md,.sh,.env"
                                onChange={handleUploadZip}
                                className="hidden"
                              />
                            </div>

                            {explorerDragOver && (
                              <div className="p-2.5 rounded-lg border border-dashed border-indigo-400 bg-indigo-950/60 text-[11px] font-mono text-indigo-200 text-center">
                                Отпустите файлы или .zip для загрузки в{' '}
                                <strong>{selectedDir ? `${selectedDir}/` : '/ (корень)'}</strong>
                              </div>
                            )}

                            {/* Сетка 2x2 всех действий проводника: без обрезания на узких экранах */}
                            <div className="grid grid-cols-2 gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setNewFileName('');
                                  setFileActionMode(fileActionMode === 'new_file' ? 'none' : 'new_file');
                                }}
                                className="px-2 py-1.5 text-[11px] font-semibold text-slate-200 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                                title={selectedDir ? `Новый файл в ${selectedDir}/` : 'Новый файл в корне проекта'}
                              >
                                <FilePlus className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                <span>+ Файл</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setNewFolderName('');
                                  setFileActionMode(fileActionMode === 'new_folder' ? 'none' : 'new_folder');
                                }}
                                className="px-2 py-1.5 text-[11px] font-semibold text-slate-200 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                                title={selectedDir ? `Новая подпапка в ${selectedDir}/` : 'Новая папка в корне проекта'}
                              >
                                <FolderPlus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                <span>+ Папка</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => zipInputRef.current?.click()}
                                className="px-2 py-1.5 text-[11px] font-semibold text-slate-200 bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                                title={
                                  selectedDir
                                    ? `Загрузить файлы или распаковать .zip в папку ${selectedDir}/ (можно перетащить мышью)`
                                    : 'Загрузить файлы или распаковать .zip в корень проекта (можно перетащить мышью)'
                                }
                              >
                                <Upload className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                <span>Загрузить</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadProjectOrFolderZip('')}
                                className="px-2 py-1.5 text-[11px] font-semibold text-slate-200 bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                                title="Скачать весь проект со всеми папками в .zip"
                              >
                                <Download className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                                <span>Скачать .zip</span>
                              </button>
                            </div>

                            {/* Индикатор выбранной целевой папки и быстрые действия с папкой */}
                            <div className="px-2.5 py-1.5 rounded-lg bg-[#111622] border border-[#1e2638] text-[11px] font-mono space-y-1.5">
                              <div className="flex items-center justify-between gap-1.5">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                  <span className="text-slate-400 shrink-0">Папка:</span>
                                  <span className="text-amber-300 font-semibold truncate" title={selectedDir || '/'}>
                                    {selectedDir ? `/${selectedDir}` : '/ (корень)'}
                                  </span>
                                </div>
                                {selectedDir && (
                                  <button
                                    type="button"
                                    onClick={() => setSelectedDir('')}
                                    className="text-[10px] text-slate-300 hover:text-white px-1.5 py-0.5 rounded bg-[#0b0f17] border border-[#1e2638] shrink-0 cursor-pointer"
                                    title="Сбросить выбор на корневую папку проекта"
                                  >
                                    В корень
                                  </button>
                                )}
                              </div>

                              {selectedDir && (
                                <div className="flex items-center justify-between gap-1 pt-1 border-t border-[#1e2638]/80 text-[10px]">
                                  <button
                                    type="button"
                                    onClick={() => handleDownloadProjectOrFolderZip(selectedDir)}
                                    className="px-1.5 py-0.5 rounded bg-[#0b0f17] hover:bg-slate-800 text-emerald-300 border border-[#1e2638] inline-flex items-center gap-1 cursor-pointer"
                                    title={`Скачать папку ${selectedDir} как .zip`}
                                  >
                                    <Download className="w-2.5 h-2.5" />
                                    <span>Архив</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setRenamingPath(selectedDir);
                                      setRenameTargetValue(selectedDir);
                                    }}
                                    className="px-1.5 py-0.5 rounded bg-[#0b0f17] hover:bg-slate-800 text-slate-300 hover:text-white border border-[#1e2638] inline-flex items-center gap-1 cursor-pointer"
                                    title="Переименовать папку"
                                  >
                                    <Edit3 className="w-2.5 h-2.5" />
                                    <span>Имя</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => requestDeleteFileOrFolder(selectedDir, true)}
                                    className="px-1.5 py-0.5 rounded bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/50 inline-flex items-center gap-1 cursor-pointer"
                                    title={`Удалить папку ${selectedDir}`}
                                  >
                                    <Trash2 className="w-2.5 h-2.5" />
                                    <span>Удалить</span>
                                  </button>
                                </div>
                              )}
                            </div>

                            {/* Поиск по файлам и папкам */}
                            <div className="relative">
                              <Search className="w-3 h-3 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                              <input
                                type="text"
                                value={explorerFilter}
                                onChange={(e) => setExplorerFilter(e.target.value)}
                                placeholder="Фильтр файлов и папок..."
                                className="w-full bg-[#111622] border border-[#1e2638] focus:border-indigo-500 rounded-lg pl-7 pr-6 py-1 text-[11px] font-mono text-white placeholder-slate-500 outline-none"
                              />
                              {explorerFilter && (
                                <button
                                  type="button"
                                  aria-label="Очистить фильтр проводника"
                                  onClick={() => setExplorerFilter('')}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </div>

                            {/* Создание нового файла + быстрые шаблоны (#13) */}
                            {fileActionMode === 'new_file' && (
                              <form
                                onSubmit={handleCreateNewFile}
                                className="p-2 bg-[#111622] border border-indigo-500/60 rounded-lg space-y-2"
                              >
                                <div className="text-[10px] font-mono text-indigo-300 flex items-center justify-between">
                                  <span>Создание файла в: {selectedDir ? `${selectedDir}/` : '/'}</span>
                                  <button
                                    type="button"
                                    aria-label="Закрыть создание файла"
                                    onClick={() => setFileActionMode('none')}
                                    className="text-slate-400 hover:text-white cursor-pointer"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    value={newFileName}
                                    onChange={(e) => setNewFileName(e.target.value)}
                                    placeholder="script.py или utils/helper.py"
                                    autoFocus
                                    className="flex-1 min-w-0 bg-[#070b14] border border-[#1e2638] rounded px-2 py-1 text-xs font-mono text-white outline-none"
                                  />
                                  <button
                                    type="submit"
                                    className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold cursor-pointer"
                                  >
                                    Создать
                                  </button>
                                </div>
                                <div className="space-y-1 pt-1 border-t border-[#1e2638]/80">
                                  <div className="text-[10px] font-mono text-slate-400">
                                    Или создать готовый шаблон в 1 клик:
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {[
                                      'main.py',
                                      'requirements.txt',
                                      'project.yaml',
                                      'index.js',
                                      'package.json',
                                      'run.sh',
                                    ].map((tpl) => (
                                      <button
                                        key={tpl}
                                        type="button"
                                        onClick={() => handleQuickCreateTemplateFile(tpl)}
                                        className="px-1.5 py-0.5 text-[10px] font-mono bg-[#0b0f17] hover:bg-indigo-950/60 text-indigo-300 border border-[#1e2638] rounded cursor-pointer"
                                      >
                                        + {tpl}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </form>
                            )}

                            {fileActionMode === 'new_folder' && (
                              <form
                                onSubmit={handleCreateNewFolder}
                                className="p-2 bg-[#111622] border border-amber-500/60 rounded-lg space-y-1.5"
                              >
                                <div className="text-[10px] font-mono text-amber-300 flex items-center justify-between">
                                  <span>Новая папка в: {selectedDir ? `${selectedDir}/` : '/'}</span>
                                  <button
                                    type="button"
                                    aria-label="Закрыть создание папки"
                                    onClick={() => setFileActionMode('none')}
                                    className="text-slate-400 hover:text-white cursor-pointer"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    value={newFolderName}
                                    onChange={(e) => setNewFolderName(e.target.value)}
                                    placeholder="modules или services/api"
                                    autoFocus
                                    className="flex-1 min-w-0 bg-[#070b14] border border-[#1e2638] rounded px-2 py-1 text-xs font-mono text-white outline-none"
                                  />
                                  <button
                                    type="submit"
                                    className="px-2.5 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-semibold cursor-pointer"
                                  >
                                    Создать
                                  </button>
                                </div>
                              </form>
                            )}

                            {zipUploadStatus && <StatusNoticeBanner text={zipUploadStatus} compact />}

                            {/* Иерархическое дерево папок и файлов с собственным скроллом */}
                            <div className="space-y-0.5 max-h-[340px] overflow-y-auto pr-0.5 flex-1">
                              {visibleTree.length > 0 ? (
                                visibleTree.map((node) => renderExplorerNode(node, 0))
                              ) : (
                                <div className="py-6 text-center text-xs font-mono text-slate-500">
                                  {filterQuery ? 'Ничего не найдено' : 'В проекте пока нет файлов'}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="pt-2 border-t border-[#1e2638] space-y-1 shrink-0">
                            <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                              <span>Файлов: {files.filter((f) => !f.is_dir).length}</span>
                              <span>Drag &amp; Drop: активен</span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 truncate" title={activeProj.workdir}>
                              Путь: {activeProj.workdir}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Центральная часть: Многовкладочный редактор кода с подсветкой синтаксиса (#8) */}
                      <div
                        className={`${editorColCls} flex flex-col justify-between bg-[#070b14] min-w-0 min-h-0 ${
                          splitConsoleMode ? 'border-b lg:border-b-0 lg:border-r border-[#1e2638]' : ''
                        }`}
                      >
                        <div className="flex flex-col flex-1 min-h-0">
                          {/* Полоса открытых вкладок (Tab Bar) */}
                          {openTabs.length > 0 && (
                            <div className="flex items-center gap-1 px-2 pt-1.5 bg-[#0b0f17] border-b border-[#1e2638] overflow-x-auto shrink-0">
                              {openTabs.map((tabPath) => {
                                const isTabActive = tabPath === activeFilePath;
                                const tabName = tabPath.split('/').pop() || tabPath;
                                const tabDirty =
                                  savedContents[tabPath] !== undefined &&
                                  draftContents[tabPath] !== undefined &&
                                  savedContents[tabPath] !== draftContents[tabPath];
                                return (
                                  <div
                                    key={tabPath}
                                    onClick={() => loadSingleFile(activeProj.id, tabPath)}
                                    title={`${tabPath} (Alt+W — закрыть вкладку)`}
                                    className={`group flex items-center gap-2 px-3 py-1.5 rounded-t-lg text-xs font-mono border-t border-x cursor-pointer shrink-0 transition-colors ${
                                      isTabActive
                                        ? 'bg-[#111622] text-white border-[#1e2638] font-semibold'
                                        : 'bg-[#070b14]/60 text-slate-400 border-transparent hover:text-slate-200 hover:bg-[#111622]/50'
                                    }`}
                                  >
                                    <span className="truncate max-w-[160px]">{tabName}</span>
                                    {tabDirty && (
                                      <span
                                        className="w-2 h-2 rounded-full bg-amber-400 shrink-0"
                                        title="Несохранённые изменения"
                                      />
                                    )}
                                    <button
                                      type="button"
                                      aria-label={`Закрыть вкладку ${tabName}`}
                                      onClick={(e) => handleCloseTab(tabPath, e)}
                                      className="text-slate-500 hover:text-white rounded p-0.5 cursor-pointer"
                                      title="Закрыть вкладку файла (Alt+W)"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Верхняя панель инструментов редактора с хлебными крошками */}
                          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 bg-[#111622] border-b border-[#1e2638] shrink-0">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                              <span className="text-xs font-mono text-slate-400">{activeProj.name}</span>
                              <span className="text-slate-600">/</span>
                              <span className="text-xs font-mono font-bold text-indigo-300 truncate">
                                {activeFilePath || 'Файл не выбран'}
                              </span>
                              {activeFilePath && (
                                <span className={`px-2 py-0.5 text-[10px] font-mono rounded border ${langMeta.badgeCls}`}>
                                  {langMeta.label}
                                </span>
                              )}
                              {isDirty && (
                                <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-amber-950/60 text-amber-300 border border-amber-700/60">
                                  Не сохранено
                                </span>
                              )}
                              {fileStatus && <StatusNoticeBanner text={fileStatus} compact />}
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              {/* Быстрый переход к строке для больших файлов */}
                              {activeFilePath && lineCount > 15 && (
                                <div className="inline-flex items-center bg-[#0b0f17] border border-[#1e2638] rounded-lg px-1.5 py-0.5">
                                  <input
                                    type="number"
                                    min={1}
                                    max={lineCount}
                                    value={goToLineInput}
                                    onChange={(e) => setGoToLineInput(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleJumpToLine();
                                      }
                                    }}
                                    placeholder={`Стр 1..${lineCount}`}
                                    className="w-20 bg-transparent text-[11px] font-mono text-white outline-none px-1"
                                    title="Введите номер строки и нажмите Enter"
                                  />
                                  <button
                                    type="button"
                                    aria-label="В начало файла"
                                    onClick={() => handleJumpToLine(1)}
                                    className="p-0.5 text-slate-400 hover:text-white cursor-pointer"
                                    title="В самое начало файла (строка 1)"
                                  >
                                    <ArrowUp className="w-3 h-3" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label="В конец файла"
                                    onClick={() => handleJumpToLine(lineCount)}
                                    className="p-0.5 text-slate-400 hover:text-white cursor-pointer"
                                    title={`В самый конец файла (строка ${lineCount})`}
                                  >
                                    <ArrowDown className="w-3 h-3" />
                                  </button>
                                </div>
                              )}

                              <button
                                type="button"
                                onClick={() => setShowFindBar((v) => !v)}
                                disabled={!activeFilePath}
                                className={`px-2 py-1 text-[11px] font-mono border rounded-lg inline-flex items-center gap-1 cursor-pointer disabled:opacity-40 ${
                                  showFindBar
                                    ? 'bg-indigo-950/60 text-indigo-200 border-indigo-600/60'
                                    : 'text-slate-300 hover:text-white bg-[#0b0f17] border-[#1e2638]'
                                }`}
                                title="Поиск и замена по коду (Alt+F или Ctrl+F)"
                              >
                                <Search className="w-3 h-3" />
                                <span>Поиск</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setWordWrap((v) => !v)}
                                disabled={!activeFilePath}
                                className={`px-2 py-1 text-[11px] font-mono border rounded-lg inline-flex items-center gap-1 cursor-pointer disabled:opacity-40 ${
                                  wordWrap
                                    ? 'bg-indigo-950/60 text-indigo-200 border-indigo-600/60'
                                    : 'text-slate-300 hover:text-white bg-[#0b0f17] border-[#1e2638]'
                                }`}
                                title="Перенос длинных строк"
                              >
                                <span>Перенос</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setShowSdkCheatsheet((v) => !v)}
                                className="px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white bg-[#0b0f17] border border-[#1e2638] rounded-lg inline-flex items-center gap-1 cursor-pointer"
                                title="Готовые сниппеты встроенного Beacon SDK (адаптированы под язык проекта)"
                              >
                                <span>SDK</span>
                                {showSdkCheatsheet ? (
                                  <ChevronUp className="w-3 h-3" />
                                ) : (
                                  <ChevronDown className="w-3 h-3" />
                                )}
                              </button>

                              {activeFilePath && (
                                <>
                                  <button
                                    type="button"
                                    aria-label="Скопировать содержимое файла"
                                    onClick={() => {
                                      navigator.clipboard?.writeText(fileContent);
                                      setFileStatus('Код скопирован');
                                      setTimeout(() => setFileStatus(''), DEFAULTS.STATUS_CLEAR_MS);
                                    }}
                                    className="p-1.5 text-slate-300 hover:text-white bg-[#0b0f17] border border-[#1e2638] rounded-lg cursor-pointer"
                                    title="Скопировать содержимое файла"
                                  >
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    aria-label="Скачать открытый файл"
                                    onClick={() => handleDownloadSingleFile(activeFilePath)}
                                    className="p-1.5 text-slate-300 hover:text-emerald-300 bg-[#0b0f17] border border-[#1e2638] rounded-lg cursor-pointer"
                                    title="Скачать открытый файл"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    aria-label="Переименовать открытый файл"
                                    onClick={() => {
                                      setRenamingPath(activeFilePath);
                                      setRenameTargetValue(activeFilePath);
                                    }}
                                    className="p-1.5 text-slate-300 hover:text-white bg-[#0b0f17] border border-[#1e2638] rounded-lg cursor-pointer"
                                    title="Переименовать или переместить файл"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    aria-label="Удалить открытый файл"
                                    onClick={() => requestDeleteFileOrFolder(activeFilePath, false)}
                                    className="p-1.5 text-rose-300 hover:text-white bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/50 rounded-lg cursor-pointer"
                                    title="Удалить текущий файл (с подтверждением)"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}

                              <button
                                type="button"
                                onClick={() => handleSaveFile()}
                                disabled={!activeFilePath || savingFileBusy}
                                className="px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                                title="Сохранить файл на диск (Ctrl+S)"
                              >
                                <Save className="w-3.5 h-3.5" />
                                {savingFileBusy ? 'Сохранение...' : LABELS.saveFileBtn}
                              </button>

                              {isProjectCurrentlyRunning && activeFilePath && (
                                <button
                                  type="button"
                                  onClick={() => handleSaveFile(undefined, undefined, true)}
                                  disabled={savingFileBusy || Boolean(procActionBusy)}
                                  className="px-2.5 py-1.5 text-xs font-semibold text-amber-200 bg-amber-950/60 hover:bg-amber-900/70 border border-amber-700/60 disabled:opacity-40 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                                  title="Сохранить файл и сразу перезапустить работающий процесс (Ctrl+Shift+S)"
                                >
                                  <RotateCcw className="w-3.5 h-3.5 text-amber-300" />
                                  <span>+ Рестарт</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Панель поиска и замены по коду с переключателем регистра Aa (#10) */}
                          {showFindBar && (
                            <div className="px-3.5 py-2 bg-[#0b0f17] border-b border-[#1e2638] flex flex-wrap items-center gap-2 shrink-0">
                              <div className="flex items-center gap-1.5 flex-1 min-w-[160px]">
                                <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                <input
                                  type="text"
                                  value={findQuery}
                                  onChange={(e) => setFindQuery(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      handleFindNext();
                                    }
                                  }}
                                  placeholder="Найти в файле..."
                                  className="w-full bg-[#111622] border border-[#1e2638] rounded px-2.5 py-1 text-xs font-mono text-white outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() => setFindCaseSensitive((v) => !v)}
                                  aria-label="Учитывать регистр при поиске и замене"
                                  className={`px-2 py-1 text-xs font-mono rounded border cursor-pointer shrink-0 ${
                                    findCaseSensitive
                                      ? 'bg-indigo-600 text-white border-indigo-400 font-bold'
                                      : 'bg-[#111622] text-slate-400 border-[#1e2638] hover:text-white'
                                  }`}
                                  title={
                                    findCaseSensitive
                                      ? 'Учёт регистра ВКЛЮЧЁН (и для поиска, и для замены)'
                                      : 'Учёт регистра ВЫКЛЮЧЕН (регистронезависимый поиск и замена)'
                                  }
                                >
                                  Aa
                                </button>
                              </div>
                              <div className="flex items-center gap-1.5 flex-1 min-w-[160px]">
                                <input
                                  type="text"
                                  value={replaceQuery}
                                  onChange={(e) => setReplaceQuery(e.target.value)}
                                  placeholder="Заменить на..."
                                  className="w-full bg-[#111622] border border-[#1e2638] rounded px-2.5 py-1 text-xs font-mono text-white outline-none"
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={handleFindNext}
                                  className="px-2.5 py-1 text-xs font-mono bg-[#111622] hover:bg-slate-800 text-indigo-300 border border-[#1e2638] rounded cursor-pointer"
                                >
                                  Найти далее
                                </button>
                                <button
                                  type="button"
                                  onClick={handleReplaceAllInEditor}
                                  className="px-2.5 py-1 text-xs font-mono bg-[#111622] hover:bg-slate-800 text-amber-300 border border-[#1e2638] rounded cursor-pointer"
                                >
                                  Заменить все
                                </button>
                                <button
                                  type="button"
                                  aria-label="Закрыть панель поиска"
                                  onClick={() => setShowFindBar(false)}
                                  className="p-1 text-slate-400 hover:text-white cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Выдвижная панель всех 6 вызовов Beacon SDK с адаптацией под Python / Node.js (#14) */}
                          {showSdkCheatsheet && (
                            <div className="px-3.5 py-2 bg-[#0b0f17] border-b border-[#1e2638] flex flex-wrap items-center gap-1.5 shrink-0">
                              <span className="text-[11px] text-slate-400 mr-1">
                                Вставить ({activeProj.runtime === 'node' ? 'Node.js SDK' : 'Python SDK'}):
                              </span>
                              {getRuntimeSdkSnippets(
                                activeProj.runtime,
                                cookieSecretName || `${activeProj.name}_cookies`
                              ).map((snip) => (
                                <button
                                  key={snip.id}
                                  type="button"
                                  onClick={() => insertSdkSnippet(snip.code)}
                                  className={`px-2 py-1 text-[11px] font-mono bg-[#111622] hover:bg-slate-800 border rounded cursor-pointer ${snip.colorCls}`}
                                >
                                  {snip.label}
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Мемоизированный редактор кода с подсветкой синтаксиса, <pre>-гуттером и автодополнением beacon.* (#8, #21) */}
                          <SyntaxCodeEditor
                            value={fileContent}
                            filePath={activeFilePath}
                            langLabel={langMeta.label}
                            tabSize={langMeta.tabSize}
                            wordWrap={wordWrap}
                            viewportHeightCls={codeViewportHeightCls}
                            cursorLine={cursorPos.line}
                            textareaRef={editorTextareaRef}
                            gutterRef={editorGutterRef}
                            onChange={(nextVal) => updateEditorContent(nextVal)}
                            onCursorChange={(ta) => updateCursorMetrics(ta)}
                            onSave={() => handleSaveFile()}
                            onSaveAndRestart={() => handleSaveFile(undefined, undefined, true)}
                            onOpenFind={() => setShowFindBar(true)}
                            onCloseActiveTab={() => {
                              if (activeFilePath) handleCloseTab(activeFilePath);
                            }}
                          />
                        </div>

                        {/* Нижняя строка состояния редактора (Status Bar) */}
                        <div className="px-3.5 py-1.5 bg-[#0b0f17] border-t border-[#1e2638] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400 tabular-nums shrink-0">
                          <div className="flex items-center gap-2.5">
                            <span>
                              Стр {cursorPos.line}/{lineCount}, Стлб {cursorPos.col}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span>{formatBytes(new Blob([fileContent]).size)}</span>
                            {lineCount > 30 && (
                              <>
                                <span className="text-slate-600">·</span>
                                <button
                                  type="button"
                                  onClick={() => handleJumpToLine(1)}
                                  className="text-indigo-300 hover:underline cursor-pointer"
                                >
                                  ↑ В начало
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleJumpToLine(lineCount)}
                                  className="text-indigo-300 hover:underline cursor-pointer"
                                >
                                  ↓ В конец
                                </button>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5">
                            <span className="hidden sm:inline text-slate-500">
                              Ctrl+S сохр. · Alt+P файл · Alt+W закр.
                            </span>
                            <span className="text-slate-600 hidden sm:inline">·</span>
                            <span>Отступ: {langMeta.tabSize} пр.</span>
                            <span className="text-slate-600">·</span>
                            <span>UTF-8</span>
                            <span className="text-slate-600">·</span>
                            <span className="text-indigo-300">{langMeta.label}</span>
                          </div>
                        </div>
                      </div>

                      {/* Правая колонка в режиме Split-View: Живой лог, stdin и beacon.state прямо рядом с кодом */}
                      {splitConsoleMode && (
                        <div className={`${splitConsoleColCls} flex flex-col min-w-0 min-h-0 bg-[#070b14]`}>
                          {renderConsolePanel(true)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* ==================== ВКЛАДКА 2: КОНФИГУРАЦИЯ, МАСШТАБИРОВАНИЕ И СУПЕРВИЗОР ==================== */}
              {isConfigTab && (
                <form
                  onSubmit={handleSaveConfig}
                  className="bg-[#111622] border border-[#1e2638] rounded-xl p-5 space-y-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e2638] pb-3.5">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Архитектура, команда запуска, расписание и супервизор
                      </h3>
                      <p className="text-xs text-slate-400">
                        Настройте режим ({cfgType === 'service' ? 'Service 24/7' : cfgType === 'web' ? 'Web / API (:PORT)' : 'Scheduled Job'}), пресеты воркеров, профили ОЗУ и политику отказоустойчивости
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="flex items-center bg-[#0b0f17] p-1 rounded-lg border border-[#1e2638]">
                        <button
                          type="button"
                          onClick={() => setSubTab('simple_cfg')}
                          className={`px-3 py-1 rounded text-xs font-semibold cursor-pointer ${
                            subTab === 'simple_cfg' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          Основные и Ресурсы
                        </button>
                        <button
                          type="button"
                          onClick={() => setSubTab('advanced_cfg')}
                          className={`px-3 py-1 rounded text-xs font-semibold cursor-pointer ${
                            subTab === 'advanced_cfg' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          ENV, Секреты и Супервизор
                        </button>
                      </div>

                      <button
                        type="submit"
                        disabled={savingConfigBusy}
                        className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {savingConfigBusy ? 'Сохранение...' : LABELS.saveConfigBtn}
                      </button>
                    </div>
                  </div>

                  {cfgStatus && <StatusNoticeBanner text={cfgStatus} />}

                  {subTab === 'simple_cfg' ? (
                    <div className="space-y-5">
                      {/* Выбор типа архитектуры: Service / Web / Job */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setCfgType('service');
                            setCfgScheduleType('manual');
                          }}
                          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                            cfgType === 'service'
                              ? 'bg-indigo-950/40 border-indigo-500 text-white'
                              : 'bg-[#0b0f17] border-[#1e2638] text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-bold text-indigo-300">1. Постоянный сервис (Service 24/7)</div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Telegram-боты, юзерботы, Celery-воркеры и тяжёлые фоновые демоны с авто-рестартом.
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setCfgType('web');
                            setCfgScheduleType('manual');
                            if (!cfgPort || cfgPort === '0') setCfgPort('18081');
                          }}
                          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                            cfgType === 'web'
                              ? 'bg-cyan-950/35 border-cyan-500 text-white'
                              : 'bg-[#0b0f17] border-[#1e2638] text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-bold text-cyan-300">2. Веб-сервис / Сайт / API (:PORT)</div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            FastAPI/Uvicorn, Gunicorn, Next.js/Node.js или Go-сервер с портом $PORT и проверкой /health.
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setCfgType('job');
                            if (!cfgScheduleExpr.trim()) {
                              applyScheduleBuilder('minutes', 15);
                            } else if (cfgScheduleType === 'manual') {
                              setCfgScheduleType('cron');
                            }
                          }}
                          className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                            cfgType === 'job'
                              ? 'bg-amber-950/35 border-amber-500 text-white'
                              : 'bg-[#0b0f17] border-[#1e2638] text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-bold text-amber-300">3. Задача по расписанию (Cron / Job)</div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Парсеры, чекеры кук, бэкапы и пайплайны. Отрабатывает по таймеру и полностью освобождает ОЗУ.
                          </p>
                        </button>
                      </div>

                      {/* Имя, Среда и Команда + Готовые пресеты команд */}
                      <div className="space-y-2.5">
                        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                          <div className="md:col-span-3">
                            <label className="block text-xs text-slate-400 mb-1">Название проекта</label>
                            <input
                              type="text"
                              value={cfgName}
                              onChange={(e) => setCfgName(e.target.value)}
                              className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs text-white font-mono"
                            />
                          </div>
                          <div className="md:col-span-3">
                            <label className="block text-xs text-slate-400 mb-1">Рантайм и изоляция</label>
                            <select
                              value={cfgRuntime}
                              onChange={(e) => setCfgRuntime(e.target.value)}
                              className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs text-white font-mono"
                            >
                              <option value="python">Python (.venv / uv)</option>
                              <option value="node">Node.js (npm / tsx)</option>
                              <option value="bash">Bash / Shell</option>
                              <option value="custom">Custom / Бинарник</option>
                            </select>
                          </div>
                          <div className="md:col-span-6">
                            <label className="block text-xs text-slate-400 mb-1">
                              Команда запуска (поддерживает .venv/bin, $PORT и пайплайны &&)
                            </label>
                            <input
                              type="text"
                              value={cfgCommand}
                              onChange={(e) => setCfgCommand(e.target.value)}
                              placeholder="python3 -u main.py"
                              className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs text-white font-mono"
                            />
                          </div>
                        </div>

                        {/* Пресеты команд под ботов, многопроцессные сайты и тяжёлые воркеры */}
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                          <span className="text-slate-400 mr-1">Шаблоны команд:</span>
                          {[
                            {
                              label: 'Python (без буфера)',
                              cmd: 'python3 -u main.py',
                            },
                            {
                              label: `Uvicorn (${recommendedWorkers} воркера)`,
                              cmd: `uvicorn main:app --host 0.0.0.0 --port $PORT --workers ${recommendedWorkers}`,
                            },
                            {
                              label: `Gunicorn + Uvicorn (${recommendedWorkers} воркера)`,
                              cmd: `gunicorn main:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT --workers ${recommendedWorkers}`,
                            },
                            {
                              label: `Celery Worker (${recommendedWorkers} потока)`,
                              cmd: `celery -A tasks worker --loglevel=info --concurrency=${recommendedWorkers}`,
                            },
                            {
                              label: 'Node.js',
                              cmd: 'node index.js',
                            },
                            {
                              label: 'npm start',
                              cmd: 'npm start',
                            },
                          ].map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              onClick={() => setCfgCommand(preset.cmd)}
                              className={`px-2 py-1 rounded border cursor-pointer ${
                                cfgCommand === preset.cmd
                                  ? 'bg-indigo-950/60 text-indigo-200 border-indigo-600'
                                  : 'bg-[#0b0f17] text-slate-300 border-[#1e2638] hover:text-white'
                              }`}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Быстрые переключатели Автостарта, Прокси и Telegram-уведомлений */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 p-3.5 bg-[#0b0f17] border border-[#1e2638] rounded-xl">
                        <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfgAutostart}
                            onChange={(e) => setCfgAutostart(e.target.checked)}
                            className="mt-0.5"
                          />
                          <div>
                            <div className="font-semibold text-white">Автостарт с сервером</div>
                            <div className="text-[11px] text-slate-400">Запускать при старте Beacon</div>
                          </div>
                        </label>

                        <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfgUseProxy}
                            onChange={(e) => setCfgUseProxy(e.target.checked)}
                            className="mt-0.5"
                          />
                          <div>
                            <div className="font-semibold text-cyan-300">Проксировать трафик</div>
                            <div className="text-[11px] text-slate-400">HTTP_PROXY / ALL_PROXY</div>
                          </div>
                        </label>

                        <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfgNotifyOnError || cfgNotifyOnCrash}
                            onChange={(e) => {
                              setCfgNotifyOnError(e.target.checked);
                              setCfgNotifyOnCrash(e.target.checked);
                            }}
                            className="mt-0.5"
                          />
                          <div>
                            <div className="font-semibold text-rose-200">Алерты о сбоях</div>
                            <div className="text-[11px] text-slate-400">Уведомлять при падении / OOM</div>
                          </div>
                        </label>

                        <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfgNotifyOnSuccess}
                            onChange={(e) => setCfgNotifyOnSuccess(e.target.checked)}
                            className="mt-0.5"
                          />
                          <div>
                            <div className="font-semibold text-emerald-200">Отчёт об успехе</div>
                            <div className="text-[11px] text-slate-400">Уведомлять при коде выхода 0</div>
                          </div>
                        </label>
                      </div>

                      {/* Блок для Web / API (:PORT) с кнопкой живой проверки */}
                      {cfgType === 'web' && (
                        <div className="bg-[#0b0f17] border border-cyan-900/50 rounded-xl p-4 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
                          <div className="md:col-span-3">
                            <label className="block text-xs font-semibold text-cyan-300 mb-1">
                              Порт веб-сервиса ($PORT)
                            </label>
                            <input
                              type="number"
                              value={cfgPort}
                              onChange={(e) => {
                                const nextP = e.target.value;
                                setCfgPort(nextP);
                                if (!cfgHealthcheckUrl || cfgHealthcheckUrl.startsWith('http://127.0.0.1:')) {
                                  setCfgHealthcheckUrl(nextP ? `http://127.0.0.1:${nextP}/health` : '');
                                }
                              }}
                              placeholder="18081"
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>
                          <div className="md:col-span-5">
                            <label className="block text-xs font-semibold text-cyan-300 mb-1">
                              Healthcheck URL (HTTP 200..399 или tcp://127.0.0.1:PORT)
                            </label>
                            <input
                              type="text"
                              value={cfgHealthcheckUrl}
                              onChange={(e) => setCfgHealthcheckUrl(e.target.value)}
                              placeholder="http://127.0.0.1:18081/health"
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-xs font-semibold text-cyan-300 mb-1">
                              Интервал (сек)
                            </label>
                            <input
                              type="number"
                              min={5}
                              max={3600}
                              value={cfgHealthcheckIntervalSec}
                              onChange={(e) => setCfgHealthcheckIntervalSec(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>
                          <div className="md:col-span-2">
                            <button
                              type="button"
                              disabled={healthcheckTesting}
                              onClick={handleProbeHealthcheckNow}
                              className="w-full py-2 px-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                            >
                              <Activity className="w-3.5 h-3.5" />
                              {healthcheckTesting ? 'Тест...' : 'Проверить'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Визуальный конструктор расписания для Job */}
                      {cfgType === 'job' && (
                        <div className="bg-[#0b0f17] border border-amber-900/50 rounded-xl p-4 space-y-3.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                              <Clock className="w-4 h-4" />
                              Расписание автоматического запуска
                            </div>
                            <span className="text-xs font-mono text-slate-300 bg-[#111622] px-2.5 py-1 rounded border border-[#1e2638]">
                              Активно: {cfgScheduleType} ({cfgScheduleExpr || '*/15 * * * *'})
                            </span>
                          </div>

                          <div className="flex flex-wrap gap-1.5">
                            {[
                              { id: 'minutes', label: 'Каждые N минут' },
                              { id: 'hours', label: 'Каждые N часов' },
                              { id: 'daily', label: 'Раз в сутки в HH:MM' },
                              { id: 'interval', label: 'Интервал в секундах' },
                              { id: 'raw', label: 'Своя Cron-строка' },
                            ].map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => applyScheduleBuilder(m.id as any)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                  schedBuilderMode === m.id
                                    ? 'bg-amber-600 text-white'
                                    : 'bg-[#111622] text-slate-300 border border-[#1e2638] hover:text-white'
                                }`}
                              >
                                {m.label}
                              </button>
                            ))}
                          </div>

                          {schedBuilderMode === 'minutes' && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              {[5, 10, 15, 30, 45].map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => {
                                    setSchedEveryMin(m);
                                    applyScheduleBuilder('minutes', m);
                                  }}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-mono cursor-pointer ${
                                    schedEveryMin === m
                                      ? 'bg-indigo-600 text-white font-bold'
                                      : 'bg-[#111622] text-slate-300 border border-[#1e2638]'
                                  }`}
                                >
                                  Каждые {m} мин
                                </button>
                              ))}
                            </div>
                          )}

                          {schedBuilderMode === 'hours' && (
                            <div className="flex flex-wrap items-center gap-2 pt-1">
                              {[1, 2, 4, 6, 12].map((h) => (
                                <button
                                  key={h}
                                  type="button"
                                  onClick={() => {
                                    setSchedEveryHour(h);
                                    applyScheduleBuilder('hours', schedEveryMin, h);
                                  }}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-mono cursor-pointer ${
                                    schedEveryHour === h
                                      ? 'bg-indigo-600 text-white font-bold'
                                      : 'bg-[#111622] text-slate-300 border border-[#1e2638]'
                                  }`}
                                >
                                  Каждые {h} ч.
                                </button>
                              ))}
                            </div>
                          )}

                          {schedBuilderMode === 'daily' && (
                            <div className="flex items-center gap-3 pt-1">
                              <span className="text-xs text-slate-300">Время запуска (UTC/сервер):</span>
                              <input
                                type="time"
                                value={schedDailyTime}
                                onChange={(e) => {
                                  setSchedDailyTime(e.target.value);
                                  applyScheduleBuilder('daily', schedEveryMin, schedEveryHour, e.target.value);
                                }}
                                className="bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                              />
                            </div>
                          )}

                          {schedBuilderMode === 'interval' && (
                            <div className="flex items-center gap-3 pt-1">
                              <span className="text-xs text-slate-300">Каждые (секунд):</span>
                              <input
                                type="number"
                                min={5}
                                value={schedIntervalSec}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setSchedIntervalSec(v);
                                  applyScheduleBuilder('interval', schedEveryMin, schedEveryHour, schedDailyTime, v);
                                }}
                                className="w-32 bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                              />
                            </div>
                          )}

                          {schedBuilderMode === 'raw' && (
                            <div className="pt-1">
                              <input
                                type="text"
                                value={cfgScheduleExpr}
                                onChange={(e) => {
                                  setCfgScheduleType('cron');
                                  setCfgScheduleExpr(e.target.value);
                                }}
                                placeholder="*/15 * * * *"
                                className="w-full max-w-sm bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Профили ресурсов ОЗУ (от лёгких скриптов до мощных серверов 64+ ГБ) */}
                      <div className="p-4 bg-[#0b0f17] border border-[#1e2638] rounded-xl space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-bold text-white flex items-center gap-1.5">
                              <Zap className="w-3.5 h-3.5 text-amber-400" />
                              Лимит памяти дерева процессов PGID и масштабирование под железо
                            </div>
                            <p className="text-[11px] text-slate-400">
                              Контролируется суммарный RSS всех дочерних воркеров группы PGID (без RLIMIT_AS, совместимо с Node.js/V8 и PyTorch)
                            </p>
                          </div>
                          {system && (
                            <span className="px-2.5 py-1 text-[11px] font-mono rounded bg-[#111622] text-indigo-300 border border-[#1e2638]">
                              Железо сервера: {system.cpu_count || 1} ядер CPU ·{' '}
                              {Math.round(system.ram_total_mb || 0)} МБ ОЗУ
                            </span>
                          )}
                        </div>

                        {/* Быстрые кнопки профилей памяти */}
                        <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
                          <span className="text-slate-400 text-[11px] mr-1">Профили ОЗУ:</span>
                          {[
                            { label: '128 МБ (Лёгкий бот)', val: 128 },
                            { label: '512 МБ (Стандарт)', val: 512 },
                            { label: '2 ГБ (Web / Парсер)', val: 2048 },
                            { label: '8 ГБ (Тяжёлый сервис)', val: 8192 },
                            { label: '16 ГБ (High-Load)', val: 16384 },
                            { label: 'Без лимита (0 МБ)', val: 0 },
                          ].map((prof) => (
                            <button
                              key={prof.val}
                              type="button"
                              onClick={() => setCfgMaxRam(prof.val)}
                              className={`px-2.5 py-1 rounded-lg border cursor-pointer transition-colors ${
                                Number(cfgMaxRam) === prof.val
                                  ? 'bg-indigo-600 text-white border-indigo-500 font-semibold'
                                  : 'bg-[#111622] text-slate-300 border-[#1e2638] hover:text-white'
                              }`}
                            >
                              {prof.label}
                            </button>
                          ))}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-1">
                          <div>
                            <label className="block text-xs text-slate-400 mb-1">
                              Лимит ОЗУ PGID (МБ, 0 = без лимита)
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={262144}
                              value={cfgMaxRam}
                              onChange={(e) => setCfgMaxRam(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>

                          <div>
                            <label className="block text-xs text-slate-400 mb-1">Политика перезапуска</label>
                            <select
                              value={cfgRestartPolicy}
                              onChange={(e) => setCfgRestartPolicy(e.target.value)}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            >
                              <option value="always">always (всегда)</option>
                              <option value="on-failure">on-failure (при сбое)</option>
                              <option value="no">no (без авто-рестарта)</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-xs text-slate-400 mb-1">
                              Макс. рестартов подряд (Crash Loop)
                            </label>
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={cfgMaxRestarts}
                              onChange={(e) => setCfgMaxRestarts(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>

                          <div>
                            <label className="block text-xs text-slate-400 mb-1">
                              Таймаут выполнения (сек, 0 = ∞)
                            </label>
                            <input
                              type="number"
                              min={0}
                              value={cfgTimeout}
                              onChange={(e) => setCfgTimeout(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Вкладка ENV (Визуальный + JSON), Секреты, Супервизор, Цепочки и Параметры */
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                        {/* Визуальный и JSON редактор переменных окружения + Пресеты производительности */}
                        <div className="lg:col-span-7 bg-[#0b0f17] border border-[#1e2638] rounded-xl p-3.5 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-semibold text-white">
                                Переменные окружения процесса (ENV)
                              </div>
                              <div className="text-[11px] text-slate-400">
                                Передаются дочерним процессам при старте вместе с BEACON_*
                              </div>
                            </div>
                            <div className="flex items-center gap-1 bg-[#111622] p-0.5 rounded-lg border border-[#1e2638]">
                              <button
                                type="button"
                                onClick={() => setEnvEditorMode('visual')}
                                className={`px-2.5 py-1 rounded text-[11px] font-mono cursor-pointer ${
                                  envEditorMode === 'visual'
                                    ? 'bg-indigo-600 text-white font-semibold'
                                    : 'text-slate-400 hover:text-white'
                                }`}
                              >
                                Таблица
                              </button>
                              <button
                                type="button"
                                onClick={() => setEnvEditorMode('json')}
                                className={`px-2.5 py-1 rounded text-[11px] font-mono cursor-pointer ${
                                  envEditorMode === 'json'
                                    ? 'bg-indigo-600 text-white font-semibold'
                                    : 'text-slate-400 hover:text-white'
                                }`}
                              >
                                JSON
                              </button>
                            </div>
                          </div>

                          {/* Быстрые пресеты переменных окружения для нагруженных программ */}
                          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                            <span className="text-slate-400">Добавить пресет:</span>
                            {[
                              { k: 'PYTHONUNBUFFERED', v: '1', label: '+ PYTHONUNBUFFERED=1' },
                              { k: 'UV_THREADPOOL_SIZE', v: '16', label: '+ UV_THREADPOOL_SIZE=16' },
                              {
                                k: 'NODE_OPTIONS',
                                v: '--max-old-space-size=4096',
                                label: '+ NODE_OPTIONS (4 ГБ V8)',
                              },
                              {
                                k: 'OMP_NUM_THREADS',
                                v: String(recommendedWorkers),
                                label: `+ OMP_NUM_THREADS=${recommendedWorkers}`,
                              },
                            ].map((item) => (
                              <button
                                key={item.k}
                                type="button"
                                onClick={() => handleUpsertEnvVar(item.k, item.v)}
                                className="px-2 py-0.5 rounded bg-[#111622] hover:bg-slate-800 text-indigo-300 border border-[#1e2638] cursor-pointer"
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>

                          {envEditorMode === 'visual' ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value={newEnvKey}
                                  onChange={(e) => setNewEnvKey(e.target.value)}
                                  placeholder="КЛЮЧ (напр. LOG_LEVEL)"
                                  className="bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white w-44"
                                />
                                <input
                                  type="text"
                                  value={newEnvVal}
                                  onChange={(e) => setNewEnvVal(e.target.value)}
                                  placeholder="Значение..."
                                  className="bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white flex-1 min-w-0"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!newEnvKey.trim()) return;
                                    handleUpsertEnvVar(newEnvKey, newEnvVal);
                                    setNewEnvKey('');
                                    setNewEnvVal('');
                                  }}
                                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold cursor-pointer shrink-0"
                                >
                                  + Добавить
                                </button>
                              </div>

                              <div className="max-h-44 overflow-y-auto border border-[#1e2638] rounded-lg divide-y divide-[#1e2638]">
                                {Object.entries(parsedEnvObject).map(([k, v]) => (
                                  <div
                                    key={k}
                                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-[#070b14] text-xs font-mono"
                                  >
                                    <span className="text-indigo-300 font-semibold shrink-0">{k}</span>
                                    <input
                                      type="text"
                                      value={v}
                                      onChange={(e) => handleUpsertEnvVar(k, e.target.value)}
                                      className="flex-1 min-w-0 bg-[#111622] border border-[#1e2638] rounded px-2 py-0.5 text-xs text-slate-200 font-mono"
                                    />
                                    <button
                                      type="button"
                                      aria-label={`Удалить переменную ${k}`}
                                      onClick={() => handleDeleteEnvVar(k)}
                                      className="text-rose-400 hover:text-rose-200 p-1 cursor-pointer shrink-0"
                                      title={`Удалить ${k}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                ))}
                                {Object.keys(parsedEnvObject).length === 0 && (
                                  <div className="py-4 text-center text-xs text-slate-500 font-mono">
                                    Переменные окружения не заданы
                                  </div>
                                )}
                              </div>
                            </div>
                          ) : (
                            <textarea
                              rows={6}
                              value={cfgEnvJson}
                              onChange={(e) => setCfgEnvJson(e.target.value)}
                              spellCheck={false}
                              className="w-full bg-[#070b14] border border-[#1e2638] rounded-lg p-3 text-xs font-mono text-slate-200"
                            />
                          )}
                        </div>

                        {/* Привязанные секреты из Сейфа */}
                        <div className="lg:col-span-5 bg-[#0b0f17] border border-[#1e2638] rounded-xl p-3.5 space-y-2.5">
                          <div>
                            <label className="block text-xs font-semibold text-white">
                              Привязанные секреты из Сейфа (beacon.secret)
                            </label>
                            <p className="text-[11px] text-slate-400">
                              Изолированы по ACL: проект может читать только отмеченные секреты
                            </p>
                          </div>
                          <div className="bg-[#070b14] border border-[#1e2638] rounded-lg p-2.5 max-h-[195px] overflow-y-auto space-y-1">
                            {secrets.map((s) => {
                              const checked = cfgSelectedSecrets.includes(s.name);
                              return (
                                <label
                                  key={s.name}
                                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded hover:bg-[#111622] cursor-pointer text-xs font-mono"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleSecretAttachment(s.name)}
                                      className="rounded border-slate-700"
                                    />
                                    <span className="text-white truncate">{s.name}</span>
                                  </div>
                                  <span className="text-[10px] text-slate-400 shrink-0">{s.type}</span>
                                </label>
                              );
                            })}
                            {secrets.length === 0 && (
                              <div className="text-xs text-slate-400 py-4 text-center">
                                В сейфе пока нет секретов
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Расширенные настройки супервизора: Профилактический Cron-рестарт, Dead Man's Switch, Цепочка запуска и Backoff */}
                      <div className="bg-[#0b0f17] border border-[#1e2638] rounded-xl p-4 space-y-3.5">
                        <div className="text-xs font-bold text-white">
                          Тонкая настройка супервизора, профилактического рестарта и цепочек запуска (Pipelines)
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {/* Плановый профилактический рестарт для 24/7 сервисов */}
                          <div className="space-y-1.5">
                            <label className="block text-xs text-slate-300">
                              Профилактический рестарт по Cron (<code className="font-mono text-indigo-300">cron_restart</code>)
                            </label>
                            <input
                              type="text"
                              value={cfgCronRestart}
                              onChange={(e) => setCfgCronRestart(e.target.value)}
                              placeholder="Пусто = выкл (напр. 0 4 * * *)"
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                            />
                            <div className="flex flex-wrap gap-1 text-[10px] font-mono">
                              {[
                                { label: 'Выкл', val: '' },
                                { label: 'В 04:00 ночи', val: '0 4 * * *' },
                                { label: 'Каждые 12ч', val: '0 */12 * * *' },
                              ].map((cr) => (
                                <button
                                  key={cr.label}
                                  type="button"
                                  onClick={() => setCfgCronRestart(cr.val)}
                                  className="px-2 py-0.5 rounded bg-[#111622] hover:bg-slate-800 text-slate-300 border border-[#1e2638] cursor-pointer"
                                >
                                  {cr.label}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Цепочка запуска: какой проект запустить после успеха */}
                          <div className="space-y-1.5">
                            <label className="block text-xs text-slate-300">
                              Запустить по цепочке после успеха (<code className="font-mono text-emerald-300">on_success</code>)
                            </label>
                            <select
                              value={cfgOnSuccessProjectId || ''}
                              onChange={(e) =>
                                setCfgOnSuccessProjectId(e.target.value ? Number(e.target.value) : null)
                              }
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                            >
                              <option value="">— Не запускать другой проект —</option>
                              {projects
                                .filter((p) => p.id !== activeProj.id)
                                .map((p) => (
                                  <option key={p.id} value={p.id}>
                                    #{p.id} {p.name} ({p.type})
                                  </option>
                                ))}
                            </select>
                            <span className="block text-[10px] text-slate-400">
                              Позволяет строить пайплайны: Сбор кук → Парсер → Отчёт
                            </span>
                          </div>

                          {/* Контроль зависаний Dead Man's Switch (beacon.ping) */}
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-slate-300 mb-1">
                                Ожидание ping (сек, 0=выкл)
                              </label>
                              <input
                                type="number"
                                min={0}
                                value={cfgHeartbeatIntervalSec}
                                onChange={(e) => setCfgHeartbeatIntervalSec(Number(e.target.value))}
                                className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-slate-300 mb-1">
                                Grace-период (сек)
                              </label>
                              <input
                                type="number"
                                min={10}
                                value={cfgHeartbeatGraceSec}
                                onChange={(e) => setCfgHeartbeatGraceSec(Number(e.target.value))}
                                className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#1e2638]">
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Мин. аптайм без сбоя (сек)
                            </label>
                            <input
                              type="number"
                              min={1}
                              value={cfgMinUptimeSec}
                              onChange={(e) => setCfgMinUptimeSec(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1 text-xs font-mono text-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Базовая пауза рестарта (сек)
                            </label>
                            <input
                              type="number"
                              min={1}
                              value={cfgRestartDelaySec}
                              onChange={(e) => setCfgRestartDelaySec(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1 text-xs font-mono text-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Backoff мин. (сек)
                            </label>
                            <input
                              type="number"
                              min={1}
                              value={cfgBackoffMinSec}
                              onChange={(e) => setCfgBackoffMinSec(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1 text-xs font-mono text-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Backoff макс. (сек)
                            </label>
                            <input
                              type="number"
                              min={5}
                              value={cfgBackoffMaxSec}
                              onChange={(e) => setCfgBackoffMaxSec(Number(e.target.value))}
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1 text-xs font-mono text-white"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Webhook URL, HMAC-секрет и Dead Man's Switch ping_token */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="bg-[#0b0f17] border border-[#1e2638] rounded-lg p-3.5 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-slate-300">
                                Внешний Webhook URL (POST)
                              </div>
                              <div className="text-xs font-mono text-indigo-300 truncate mt-0.5">{webhookUrl}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => navigator.clipboard?.writeText(webhookUrl)}
                              className="px-2.5 py-1.5 text-xs font-mono text-slate-200 bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1 cursor-pointer shrink-0"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              URL
                            </button>
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              Секрет подписи <code className="font-mono text-indigo-300">X-Beacon-Signature</code> (HMAC-SHA256)
                            </label>
                            <input
                              type="password"
                              value={cfgWebhookHmacSecret}
                              onChange={(e) => setCfgWebhookHmacSecret(e.target.value)}
                              placeholder="Оставьте пустым для обычного токена URL"
                              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                            />
                          </div>
                        </div>

                        <div className="bg-[#0b0f17] border border-[#1e2638] rounded-lg p-3.5 flex flex-col justify-between gap-2">
                          <div>
                            <div className="text-xs font-semibold text-slate-300">
                              Dead Man&apos;s Switch URL (<code className="font-mono text-cyan-300">beacon.ping()</code>)
                            </div>
                            <div className="text-xs font-mono text-cyan-300 truncate mt-1">{pingUrl}</div>
                            <p className="text-[11px] text-slate-400 mt-1">
                              Передаётся в процесс через <code className="font-mono text-slate-300">BEACON_PING_TOKEN</code>.
                            </p>
                          </div>
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={() => navigator.clipboard?.writeText(pingUrl)}
                              className="px-3 py-1.5 text-xs font-mono text-slate-200 bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Copy className="w-3.5 h-3.5" />
                              Копировать Ping URL
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Редактор разрешённых параметров запуска (params_schema) */}
                      <div className="bg-[#0b0f17] border border-[#1e2638] rounded-lg p-3.5 space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-xs font-semibold text-slate-200">
                              Схема параметров запуска (<code className="font-mono text-indigo-300">params_schema</code>)
                            </div>
                            <div className="text-[11px] text-slate-400">
                              Только объявленные имена разрешены для передачи как <code className="font-mono">PARAM_*</code> при старте или через Webhook
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setCfgParamsSchema((prev) => [...prev, { name: '', label: '', default: '' }])
                            }
                            className="px-2.5 py-1 text-xs font-semibold text-indigo-200 bg-indigo-950/60 hover:bg-indigo-900/70 border border-indigo-700/50 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Добавить параметр
                          </button>
                        </div>

                        {cfgParamsSchema.length > 0 && (
                          <div className="space-y-2">
                            {cfgParamsSchema.map((param, idx) => (
                              <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                                <input
                                  type="text"
                                  value={param.name}
                                  onChange={(e) => {
                                    const next = [...cfgParamsSchema];
                                    next[idx] = { ...next[idx], name: e.target.value };
                                    setCfgParamsSchema(next);
                                  }}
                                  placeholder="имя (напр. LIMIT)"
                                  className="sm:col-span-3 bg-[#111622] border border-[#1e2638] rounded px-2.5 py-1 text-xs font-mono text-white"
                                />
                                <input
                                  type="text"
                                  value={param.label}
                                  onChange={(e) => {
                                    const next = [...cfgParamsSchema];
                                    next[idx] = { ...next[idx], label: e.target.value };
                                    setCfgParamsSchema(next);
                                  }}
                                  placeholder="Подпись для UI"
                                  className="sm:col-span-4 bg-[#111622] border border-[#1e2638] rounded px-2.5 py-1 text-xs text-white"
                                />
                                <input
                                  type="text"
                                  value={param.default}
                                  onChange={(e) => {
                                    const next = [...cfgParamsSchema];
                                    next[idx] = { ...next[idx], default: e.target.value };
                                    setCfgParamsSchema(next);
                                  }}
                                  placeholder="Значение по умолчанию"
                                  className="sm:col-span-4 bg-[#111622] border border-[#1e2638] rounded px-2.5 py-1 text-xs font-mono text-white"
                                />
                                <button
                                  type="button"
                                  onClick={() => setCfgParamsSchema((prev) => prev.filter((_, i) => i !== idx))}
                                  className="sm:col-span-1 p-1.5 text-rose-400 hover:text-rose-200 bg-[#111622] border border-[#1e2638] rounded flex items-center justify-center cursor-pointer"
                                  title="Удалить параметр"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </form>
              )}

              {/* ==================== ВКЛАДКА 3: КУКИ, ПРОКСИ И TELEGRAM (#24) ==================== */}
              {subTab === 'cookies_tg' && (
                <div className="space-y-3.5">
                  {/* Разъясняющий баннер: связь быстрой привязки проекта с глобальным Сейфом Кук и Секретов (#24) */}
                  <div className="bg-[#111622] border border-indigo-500/40 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-xs font-bold text-indigo-200 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-indigo-400 shrink-0" />
                        <span>Быстрая настройка сетевой авторизации проекта «{activeProj.name}»</span>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Здесь настраиваются куки, прокси и Telegram-переменные конкретно для этого проекта. Все ключи шифруются и сохраняются в едином глобальном хранилище Beacon (<code className="font-mono text-slate-300">chmod 0600</code>).
                      </p>
                    </div>
                    {onOpenSecretsVault && (
                      <button
                        type="button"
                        onClick={onOpenSecretsVault}
                        className="px-3 py-1.5 text-xs font-semibold text-indigo-200 bg-indigo-950/60 hover:bg-indigo-900/70 border border-indigo-700/60 rounded-lg inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                      >
                        <Cookie className="w-3.5 h-3.5 text-amber-400" />
                        <span>Открыть глобальный Сейф секретов (Alt+3)</span>
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    {/* Левая половина: Менеджер Cookie-Editor JSON + HTTP-проверка Set-Cookie */}
                    <div className="lg:col-span-7 bg-[#111622] border border-[#1e2638] rounded-xl p-4 space-y-4">
                      <div className="flex items-center justify-between gap-2 border-b border-[#1e2638] pb-3">
                        <div>
                          <h3 className="text-sm font-bold text-white flex items-center gap-2">
                            <Cookie className="w-4 h-4 text-amber-400" />
                            Куки авторизации (Cookie-Editor JSON · 0600)
                          </h3>
                          <p className="text-xs text-slate-400">
                            Хранятся в защищённом файле и читаются скриптом через <code className="text-indigo-300">beacon.secret(&quot;{cookieSecretName}&quot;)</code>
                          </p>
                        </div>
                        <input
                          ref={cookieFileInputRef}
                          type="file"
                          accept=".json,.txt"
                          onChange={handleCookieFileUpload}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => cookieFileInputRef.current?.click()}
                          className="px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1.5 cursor-pointer shrink-0"
                        >
                          <Upload className="w-3.5 h-3.5 text-indigo-400" />
                          Загрузить .json
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-1">Имя секрета в Сейфе</label>
                          <input
                            type="text"
                            value={cookieSecretName}
                            onChange={(e) => setCookieSecretName(e.target.value)}
                            className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                          />
                        </div>
                        <div className="flex items-end">
                          <button
                            type="button"
                            onClick={() => setCookieJsonText(DEFAULT_COOKIE_SAMPLE)}
                            className="w-full py-1.5 px-3 text-xs font-mono text-slate-300 hover:text-white bg-[#0b0f17] border border-[#1e2638] rounded-lg cursor-pointer"
                          >
                            Вставить шаблон Cookie JSON
                          </button>
                        </div>
                      </div>

                      <textarea
                        rows={7}
                        value={cookieJsonText}
                        onChange={(e) => setCookieJsonText(e.target.value)}
                        spellCheck={false}
                        placeholder='Вставьте JSON-массив кук из браузерного расширения Cookie-Editor: [{"domain": ".site.com", "name": "sid", "value": "..."}]'
                        className="w-full bg-[#070b14] border border-[#1e2638] rounded-lg p-3 text-xs font-mono text-slate-200"
                      />

                      {cookieSaveStatus && <StatusNoticeBanner text={cookieSaveStatus} />}

                      <button
                        type="button"
                        disabled={savingCookiesBusy}
                        onClick={handleSaveAndAttachCookies}
                        className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <ShieldCheck className="w-4 h-4" />
                        {savingCookiesBusy ? 'Сохранение в Сейф...' : LABELS.saveCookiesBtn}
                      </button>

                      {/* Реальный HTTP-инспектор и захват Set-Cookie через прокси */}
                      <div className="pt-3 border-t border-[#1e2638] space-y-3">
                        <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                          <Globe className="w-3.5 h-3.5 text-cyan-400" />
                          Проверка доступности сайта и захват первичных Set-Cookie через прокси
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                          <input
                            type="text"
                            value={webAuthUrl}
                            onChange={(e) => setWebAuthUrl(e.target.value)}
                            placeholder="https://example.com"
                            className="sm:col-span-6 bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                          />
                          <input
                            type="text"
                            value={webAuthProxy}
                            onChange={(e) => setWebAuthProxy(e.target.value)}
                            placeholder="Прокси (опционально)"
                            className="sm:col-span-4 bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                          />
                          <button
                            type="button"
                            disabled={webAuthLoading}
                            onClick={handleStartWebAuth}
                            className="sm:col-span-2 py-1.5 px-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50"
                          >
                            {webAuthLoading ? '...' : 'Проверить'}
                          </button>
                        </div>

                        {webAuthStatusMsg && <StatusNoticeBanner text={webAuthStatusMsg} />}

                        {webAuthSession && (
                          <div className="bg-[#0b0f17] border border-[#1e2638] rounded-lg p-3 space-y-2 text-xs font-mono">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
                              <span>HTTP статус: <strong className="text-white">{webAuthSession.http_status || 0}</strong></span>
                              <span>Заголовок: <strong className="text-white">{webAuthSession.page_title || '—'}</strong></span>
                              <span>Set-Cookie: <strong className="text-emerald-300">{webAuthSession.cookies?.length || 0} шт.</strong></span>
                            </div>
                            {(webAuthSession.cookies?.length || 0) > 0 && (
                              <button
                                type="button"
                                onClick={handleSaveWebAuth}
                                className="w-full py-1.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-semibold cursor-pointer"
                              >
                                Сохранить перехваченные Set-Cookie ({webAuthSession.cookies?.length || 0} шт.) в сейф
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Правая половина: Telegram-интеграция и Прокси проекта */}
                    <form
                      onSubmit={handleSaveTelegramAndProxy}
                      className="lg:col-span-5 bg-[#111622] border border-[#1e2638] rounded-xl p-4 space-y-3.5"
                    >
                      <div className="border-b border-[#1e2638] pb-3">
                        <h3 className="text-sm font-bold text-white flex items-center gap-2">
                          <Bot className="w-4 h-4 text-indigo-400" />
                          Telegram-токен и Прокси проекта
                        </h3>
                        <p className="text-xs text-slate-400">
                          Автоматически пробрасываются в окружение (BOT_TOKEN, TG_CHAT_ID, HTTPS_PROXY)
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs text-slate-400 mb-1">BOT_TOKEN (от @BotFather)</label>
                        <input
                          type="password"
                          value={tgBotToken}
                          onChange={(e) => setTgBotToken(e.target.value)}
                          placeholder="123456789:AAH..."
                          className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                        />
                      </div>

                      <div>
                        <label className="block text-xs text-slate-400 mb-1">TG_CHAT_ID (ID чата или администратора)</label>
                        <input
                          type="text"
                          value={tgChatId}
                          onChange={(e) => setTgChatId(e.target.value)}
                          placeholder="Например: 987654321"
                          className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">TG_API_ID (Telethon/Pyrogram)</label>
                          <input
                            type="text"
                            value={tgApiId}
                            onChange={(e) => setTgApiId(e.target.value)}
                            placeholder="Опционально"
                            className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">TG_API_HASH</label>
                          <input
                            type="password"
                            value={tgApiHash}
                            onChange={(e) => setTgApiHash(e.target.value)}
                            placeholder="Опционально"
                            className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Индивидуальный прокси проекта (HTTPS_PROXY / ALL_PROXY)
                        </label>
                        <input
                          type="text"
                          value={customProxyUrl}
                          onChange={(e) => setCustomProxyUrl(e.target.value)}
                          placeholder="socks5://user:pass@ip:1080 или http://ip:8080"
                          className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                        />
                      </div>

                      {tgSaveStatus && <StatusNoticeBanner text={tgSaveStatus} />}

                      <button
                        type="submit"
                        disabled={savingTgBusy}
                        className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {savingTgBusy ? 'Сохранение...' : LABELS.saveTelegramProxyBtn}
                      </button>
                    </form>
                  </div>
                </div>
              )}

              {/* ==================== ВКЛАДКА 4: ТЕРМИНАЛ, GIT И ИСТОРИЯ ЗАПУСКОВ (#17) ==================== */}
              {subTab === 'terminal_git' && (
                <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-bold text-white">
                        Командная строка в изолированном окружении ({activeProj.workdir})
                      </h3>
                      <p className="text-xs text-slate-400">
                        Команды выполняются с автоматически подключённым <code className="text-indigo-300">.venv/bin</code> в PATH
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {[
                        { label: 'pip install -r requirements.txt', cmd: 'pip install -r requirements.txt' },
                        { label: 'git status', cmd: 'git status' },
                        { label: 'git pull', cmd: 'git pull' },
                        { label: 'ls -la', cmd: 'ls -la' },
                      ].map((btn) => (
                        <button
                          key={btn.label}
                          type="button"
                          onClick={() => runProjectCommand(btn.cmd)}
                          className="px-2.5 py-1 text-[11px] font-mono text-slate-200 bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg cursor-pointer"
                        >
                          {btn.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <form onSubmit={handleExecCommand} className="flex items-center gap-2">
                    <div className="flex-1 flex items-center bg-[#070b14] border border-[#1e2638] rounded-lg px-3 py-2">
                      <span className="text-xs font-mono text-indigo-400 mr-2">$</span>
                      <input
                        type="text"
                        value={cliCommand}
                        onChange={(e) => setCliCommand(e.target.value)}
                        placeholder="Введите команду (например: pip install httpx или git pull)..."
                        className="w-full bg-transparent text-xs font-mono text-white focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={cliRunning}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold cursor-pointer"
                    >
                      {cliRunning ? 'Выполнение...' : 'Выполнить'}
                    </button>
                  </form>

                  {cliOutput && (
                    <pre className="bg-[#070b14] border border-[#1e2638] rounded-lg p-3.5 text-xs font-mono text-slate-200 max-h-56 overflow-y-auto whitespace-pre-wrap">
                      {cliOutput}
                    </pre>
                  )}

                  {/* Таблица истории запусков с пагинацией (#17) */}
                  <div className="pt-3 border-t border-[#1e2638] space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                        История запусков (показано {Math.min(visibleRunsCount, runs.length)} из {runs.length})
                      </span>
                      <button
                        type="button"
                        disabled={clearingLogsBusy}
                        onClick={handleClearOldLogs}
                        className="text-xs text-slate-400 hover:text-rose-300 disabled:opacity-40 font-mono cursor-pointer"
                      >
                        {clearingLogsBusy ? 'Очистка...' : 'Очистить старые логи'}
                      </button>
                    </div>

                    <div className="overflow-x-auto border border-[#1e2638] rounded-lg">
                      <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
                        <thead>
                          <tr className="bg-[#0b0f17] text-slate-400 border-b border-[#1e2638]">
                            <th className="py-2 px-3">Run ID</th>
                            <th className="py-2 px-3">Статус</th>
                            <th className="py-2 px-3">Триггер</th>
                            <th className="py-2 px-3">PID / PGID</th>
                            <th className="py-2 px-3">Старт</th>
                            <th className="py-2 px-3">Код выхода</th>
                            <th className="py-2 px-3 text-right">Лог</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1e2638]">
                          {runs.slice(0, visibleRunsCount).map((r) => {
                            const st = statusBadge(r.status);
                            const isSel = r.id === selectedRunId;
                            return (
                              <tr
                                key={r.id}
                                onClick={() => {
                                  setSelectedRunId(r.id);
                                  setBottomConsoleTab('logs');
                                }}
                                className={`cursor-pointer transition-colors ${
                                  isSel ? 'bg-indigo-950/35' : 'hover:bg-[#0b0f17]/70'
                                }`}
                              >
                                <td className="py-2 px-3 font-bold text-white">#{r.id}</td>
                                <td className="py-2 px-3">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${st.cls}`}>{st.label}</span>
                                </td>
                                <td className="py-2 px-3 text-slate-300">{r.trigger}</td>
                                <td className="py-2 px-3 text-slate-400">
                                  {r.pid || '—'} / {r.pgid || '—'}
                                </td>
                                <td className="py-2 px-3 text-slate-400">{formatShortTime(r.started_at)}</td>
                                <td className="py-2 px-3 text-slate-300">
                                  {r.exit_code !== null && r.exit_code !== undefined ? r.exit_code : '—'}
                                </td>
                                <td className="py-2 px-3 text-right">
                                  <span className="text-indigo-400 hover:underline">Открыть лог</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {runs.length > visibleRunsCount && (
                      <div className="flex items-center justify-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setVisibleRunsCount((prev) => prev + DEFAULTS.RUNS_PAGE_SIZE)}
                          className="px-3.5 py-1.5 text-xs font-mono text-indigo-200 bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg cursor-pointer"
                        >
                          Показать ещё (+{DEFAULTS.RUNS_PAGE_SIZE})
                        </button>
                        <button
                          type="button"
                          onClick={() => setVisibleRunsCount(runs.length)}
                          className="px-3 py-1.5 text-xs font-mono text-slate-300 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg cursor-pointer"
                        >
                          Показать все ({runs.length})
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ==================== НИЖНЯЯ ДОК-КОНСОЛЬ (если не включён режим Split-View в редакторе) ==================== */}
              {!(subTab === 'editor' && splitConsoleMode) && renderConsolePanel(false)}
            </>
          );
        })()}
      </div>
    </div>
  );
};

