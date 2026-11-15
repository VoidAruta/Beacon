import React, { useEffect, useState, useRef } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Trash2,
  Save,
  FolderCode,
  Folder,
  FolderOpen,
  FileCode2,
  Download,
  RefreshCw,
  ChevronRight,
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
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { ProjectItem, RunItem, SecretItem, WorkspaceSubTab, WebAuthSession, FileTreeNode } from '../types/hub';
import { formatBytes } from '../utils/hubLogic';

function formatShortTime(ts: number | string | null | undefined): string {
  if (!ts) return '—';
  try {
    const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(ts);
  }
}

function statusBadge(status: string | undefined): { label: string; cls: string } {
  const s = (status || 'stopped').toLowerCase();
  if (s === 'running') {
    return {
      label: 'РАБОТАЕТ',
      cls: 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/70',
    };
  }
  if (s === 'waiting_input') {
    return {
      label: 'ЖДЁТ ВВОД',
      cls: 'bg-amber-950/70 text-amber-300 border border-amber-700/70',
    };
  }
  if (s === 'crash_loop') {
    return {
      label: 'CRASH LOOP',
      cls: 'bg-rose-950/90 text-rose-200 border border-rose-500/80 animate-pulse',
    };
  }
  if (s === 'failed' || s === 'crashed' || s === 'killed_oom' || s === 'timeout') {
    return {
      label: s === 'killed_oom' ? 'OOM KILL' : s === 'timeout' ? 'ТАЙМАУТ' : 'СБОЙ',
      cls: 'bg-rose-950/70 text-rose-300 border border-rose-800/70',
    };
  }
  if (s === 'success' || s === 'completed') {
    return {
      label: 'УСПЕХ',
      cls: 'bg-indigo-950/60 text-indigo-300 border border-indigo-800/70',
    };
  }
  return {
    label: 'ОСТАНОВЛЕН',
    cls: 'bg-slate-800/80 text-slate-300 border border-slate-700/70',
  };
}

interface FlatFileEntry {
  path: string;
  name: string;
  size: number;
  is_dir: boolean;
}

function sortFileTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru');
    })
    .map((node) => ({
      ...node,
      children: node.children ? sortFileTree(node.children) : undefined,
    }));
}

function normalizeFileTree(nodes: any[]): FileTreeNode[] {
  return sortFileTree(
    (nodes || [])
      .filter((item) => item && typeof item === 'object' && item.path && item.name)
      .map((item) => {
        const isDir = item.type === 'dir' || item.is_dir === true;
        return {
          name: String(item.name),
          path: String(item.path).replace(/^\/+|\/+$/g, ''),
          type: isDir ? 'dir' : 'file',
          size: Number(item.size || 0),
          children: isDir && Array.isArray(item.children) ? normalizeFileTree(item.children) : undefined,
        } as FileTreeNode;
      })
  );
}

function buildFileTreeFromFlat(files: any[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const findOrCreate = (list: FileTreeNode[], name: string, path: string, type: 'file' | 'dir', size = 0) => {
    let node = list.find((item) => item.path === path);
    if (!node) {
      node = { name, path, type, size, ...(type === 'dir' ? { children: [] } : {}) };
      list.push(node);
    } else if (type === 'dir') {
      node.type = 'dir';
      node.children ||= [];
    }
    return node;
  };

  for (const raw of files || []) {
    if (!raw || typeof raw !== 'object') continue;
    const rawPath = String(raw.path || raw.name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!rawPath) continue;
    const parts = rawPath.split('/').filter(Boolean);
    let parent = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isDirectory = index < parts.length - 1 || raw.is_dir === true || raw.type === 'dir';
      const node = findOrCreate(parent, part, currentPath, isDirectory ? 'dir' : 'file', Number(raw.size || 0));
      if (isDirectory) {
        node.type = 'dir';
        node.children ||= [];
        parent = node.children;
      }
    });
  }
  return sortFileTree(root);
}

function flattenFileTree(nodes: FileTreeNode[]): FlatFileEntry[] {
  const result: FlatFileEntry[] = [];
  const walk = (list: FileTreeNode[]) => {
    for (const item of list || []) {
      const isDir = item.type === 'dir';
      result.push({
        path: item.path,
        name: item.name,
        size: isDir ? 0 : Number(item.size || 0),
        is_dir: isDir,
      });
      if (isDir && Array.isArray(item.children)) walk(item.children);
    }
  };
  walk(nodes);
  return result;
}

interface ProjectFileTreeProps {
  nodes: FileTreeNode[];
  selectedFilePath: string;
  selectedFolderPath: string;
  expandedFolders: Set<string>;
  depth?: number;
  onToggleFolder: (node: FileTreeNode) => void;
  onSelectFile: (path: string) => void;
}

const ProjectFileTree: React.FC<ProjectFileTreeProps> = ({
  nodes,
  selectedFilePath,
  selectedFolderPath,
  expandedFolders,
  depth = 0,
  onToggleFolder,
  onSelectFile,
}) => (
  <div className="space-y-0.5">
    {sortFileTree(nodes).map((node) => {
      const isDir = node.type === 'dir';
      const isOpen = isDir && expandedFolders.has(node.path);
      const isSelected = isDir ? selectedFolderPath === node.path : selectedFilePath === node.path;
      return (
        <React.Fragment key={node.path}>
          <button
            type="button"
            title={node.path}
            onClick={() => (isDir ? onToggleFolder(node) : onSelectFile(node.path))}
            className={`w-full flex items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs transition-colors ${
              isSelected
                ? 'bg-indigo-600/20 text-indigo-100 ring-1 ring-inset ring-indigo-500/40'
                : 'text-slate-300 hover:bg-[#182131] hover:text-white'
            }`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            {isDir ? (
              <>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-amber-300" /> : <Folder className="h-4 w-4 shrink-0 text-amber-300" />}
              </>
            ) : (
              <>
                <span className="w-3.5 shrink-0" />
                <FileCode2 className={`h-4 w-4 shrink-0 ${isSelected ? 'text-indigo-200' : 'text-slate-500'}`} />
              </>
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {!isDir && <span className="shrink-0 text-[10px] tabular-nums text-slate-500">{formatBytes(node.size || 0)}</span>}
            {isDir && <span className="shrink-0 text-[10px] text-slate-600">{node.children?.length || 0}</span>}
          </button>
          {isDir && isOpen && (node.children?.length ? (
            <ProjectFileTree
              nodes={node.children}
              selectedFilePath={selectedFilePath}
              selectedFolderPath={selectedFolderPath}
              expandedFolders={expandedFolders}
              depth={depth + 1}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
            />
          ) : (
            <div className="py-1 text-[11px] italic text-slate-600" style={{ paddingLeft: `${37 + depth * 14}px` }}>
              Папка пуста
            </div>
          ))}
        </React.Fragment>
      );
    })}
  </div>
);

function joinProjectPath(basePath: string, inputPath: string): string {
  const normalizedInput = inputPath.trim().replace(/\\/g, '/');
  const parts = `${basePath ? `${basePath}/` : ''}${normalizedInput}`
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('Укажите корректный относительный путь без . и ..');
  }
  return parts.join('/');
}

function fileLanguageLabel(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const labels: Record<string, string> = {
    py: 'PYTHON', js: 'JAVASCRIPT', jsx: 'REACT JSX', ts: 'TYPESCRIPT', tsx: 'REACT TSX',
    json: 'JSON', html: 'HTML', css: 'CSS', scss: 'SCSS', md: 'MARKDOWN', yml: 'YAML', yaml: 'YAML',
    sh: 'SHELL', bash: 'SHELL', toml: 'TOML', txt: 'TEXT', sql: 'SQL',
  };
  return labels[ext] || (ext ? ext.toUpperCase() : 'TEXT');
}

interface ProjectsWorkspaceProps {
  projects: ProjectItem[];
  secrets: SecretItem[];
  selectedProject: ProjectItem | null;
  initialSubTab?: WorkspaceSubTab;
  onSelectProject: (p: ProjectItem) => void;
  onOpenCreateModal: () => void;
  onImportExamples?: () => Promise<any>;
  onStartProject: (id: number) => Promise<any>;
  onStopProject: (id: number) => Promise<any>;
  onRestartProject: (id: number) => Promise<any>;
  onUpdateProject: (id: number, data: Record<string, any>) => Promise<any>;
  onDeleteProject: (id: number, deleteFiles?: boolean) => Promise<any>;
  onCloneProject?: (id: number) => Promise<any>;
  onRefreshAll: () => void;
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
  apiFetch,
}) => {
  const [subTab, setSubTab] = useState<WorkspaceSubTab>(initialSubTab);

  // Поиск и фильтрация в левой панели проектов
  const [projectSearch, setProjectSearch] = useState<string>('');
  const [projectTypeFilter, setProjectTypeFilter] = useState<'all' | 'service' | 'web' | 'job'>('all');
  const [importingExamples, setImportingExamples] = useState<boolean>(false);

  // Всегда берём актуальный объект проекта из свежего массива projects
  const activeProj: ProjectItem | null =
    (selectedProject ? projects.find((p) => p.id === selectedProject.id) : null) ||
    selectedProject ||
    projects[0] ||
    null;
  const activeProjectIdRef = useRef<number | null>(activeProj?.id ?? null);
  activeProjectIdRef.current = activeProj?.id ?? null;

  // Вкладка 1: Файлы и код
  const [files, setFiles] = useState<FlatFileEntry[]>([]);
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [activeFolderPath, setActiveFolderPath] = useState<string>('');
  const [activeFilePath, setActiveFilePath] = useState<string>('');
  const [fileContent, setFileContent] = useState<string>('');
  const [savedFileContent, setSavedFileContent] = useState<string>('');
  const [fileStatus, setFileStatus] = useState<string>('');
  const [exportingProject, setExportingProject] = useState<boolean>(false);
  const [editorFontSize, setEditorFontSize] = useState<number>(13);
  const [editorWrap, setEditorWrap] = useState<boolean>(false);
  const [editorScrollTop, setEditorScrollTop] = useState<number>(0);
  const [editorCursor, setEditorCursor] = useState<{ line: number; column: number }>({ line: 1, column: 1 });
  const fileRequestIdRef = useRef<number>(0);
  const fileListRequestIdRef = useRef<number>(0);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const isFileDirty = Boolean(activeFilePath) && fileContent !== savedFileContent;
  const [newFileName, setNewFileName] = useState<string>('');
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [fileActionMode, setFileActionMode] = useState<'none' | 'new_file' | 'new_folder'>('none');
  const [zipUploadStatus, setZipUploadStatus] = useState<string>('');
  const [showSdkCheatsheet, setShowSdkCheatsheet] = useState<boolean>(false);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  // История запусков и живой лог
  const [runs, setRuns] = useState<RunItem[]>([]);
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
  const [cliRunId, setCliRunId] = useState<number | null>(null);

  // Вкладка 4/5: Настройки, Расписание, Лимиты и Секреты
  const [cfgName, setCfgName] = useState<string>('');
  const [cfgType, setCfgType] = useState<'service' | 'web' | 'job'>('service');
  const [cfgRuntime, setCfgRuntime] = useState<string>('python');
  const [cfgCommand, setCfgCommand] = useState<string>('');
  const [cfgWorkdir, setCfgWorkdir] = useState<string>('');
  const [cfgScheduleType, setCfgScheduleType] = useState<string>('manual');
  const [cfgScheduleExpr, setCfgScheduleExpr] = useState<string>('');
  const [cfgPort, setCfgPort] = useState<string>('');
  const [cfgHealthcheckUrl, setCfgHealthcheckUrl] = useState<string>('');
  const [cfgRestartPolicy, setCfgRestartPolicy] = useState<string>('on-failure');
  const [cfgMaxRetries, setCfgMaxRetries] = useState<number>(3);
  const [cfgRetryDelaySec, setCfgRetryDelaySec] = useState<number>(30);
  const [cfgMaxRam, setCfgMaxRam] = useState<number>(128);
  const [cfgTimeout, setCfgTimeout] = useState<number>(0);
  const [cfgEnvJson, setCfgEnvJson] = useState<string>('{}');
  const [cfgSelectedSecrets, setCfgSelectedSecrets] = useState<string[]>([]);
  const [cfgWebhookHmacSecret, setCfgWebhookHmacSecret] = useState<string>('');
  const [cfgParamsSchema, setCfgParamsSchema] = useState<Array<{ name: string; label: string; default: string }>>([]);
  const [cfgStatus, setCfgStatus] = useState<string>('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<boolean>(false);
  const [deleteFilesCheckbox, setDeleteFilesCheckbox] = useState<boolean>(false);

  // Конструктор расписания
  const [schedBuilderMode, setSchedBuilderMode] = useState<'minutes' | 'hours' | 'daily' | 'interval' | 'raw'>('minutes');
  const [schedEveryMin, setSchedEveryMin] = useState<number>(15);
  const [schedEveryHour, setSchedEveryHour] = useState<number>(2);
  const [schedDailyTime, setSchedDailyTime] = useState<string>('09:00');
  const [schedIntervalSec, setSchedIntervalSec] = useState<number>(300);

  // Нижняя консоль (Лог / hub.state / Быстрый Shell)
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

  // Инициализация полей при смене выбранного проекта
  useEffect(() => {
    if (!activeProj) return;
    // Отменяем логически все ответы от предыдущего проекта.
    fileRequestIdRef.current += 1;
    fileListRequestIdRef.current += 1;
    setEditorScrollTop(0);
    setEditorCursor({ line: 1, column: 1 });
    setFiles([]);
    setFileTree([]);
    setExpandedFolders(new Set());
    setActiveFolderPath('');
    setActiveFilePath('');
    setFileContent('');
    setSavedFileContent('');
    setFileStatus('');
    setFileActionMode('none');
    setNewFileName('');
    setNewFolderName('');
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
    setCfgRestartPolicy(activeProj.restart_policy || 'on-failure');
    setCfgMaxRetries(activeProj.max_retries ?? 3);
    setCfgRetryDelaySec(activeProj.retry_delay_sec ?? 30);
    setCfgMaxRam(activeProj.ram_limit_mb || 128);
    setCfgTimeout(activeProj.timeout_sec || 0);
    setCfgEnvJson(activeProj.env_json || '{}');
    setCfgWebhookHmacSecret(activeProj.webhook_hmac_secret || '');
    setCfgParamsSchema(
      Array.isArray(activeProj.params_schema)
        ? activeProj.params_schema.map((item) => ({
            name: String(item.name || ''),
            label: String(item.label || ''),
            default: String(item.default || ''),
          }))
        : []
    );
    setDeleteConfirmOpen(false);
    setDeleteFilesCheckbox(false);

    const expr = (activeProj.schedule_expr || '').trim();
    if (activeProj.schedule_type === 'interval') {
      setSchedBuilderMode('interval');
      setSchedIntervalSec(Number(expr) || 300);
    } else if (activeProj.schedule_type === 'daily') {
      setSchedBuilderMode('daily');
      setSchedDailyTime(/^\d{1,2}:\d{2}$/.test(expr) ? expr : '09:00');
    } else if (/^\*\/(\d+) \* \* \* \*$/.test(expr)) {
      const m = expr.match(/^\*\/(\d+) \* \* \* \*$/);
      setSchedBuilderMode('minutes');
      setSchedEveryMin(Number(m?.[1] || 15));
    } else if (/^0 \*\/(\d+) \* \* \*$/.test(expr)) {
      const m = expr.match(/^0 \*\/(\d+) \* \* \*$/);
      setSchedBuilderMode('hours');
      setSchedEveryHour(Number(m?.[1] || 2));
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
    setCliRunId(null);
    setZipUploadStatus('');
    setWebAuthSession(null);
    setWebAuthStatusMsg('');

    loadProjectFiles(activeProj.id, undefined, true);
    loadProjectRuns(activeProj.id);
    loadProjectKv(activeProj.id);
  }, [activeProj?.id]);

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
      // ignore
    }
  };

  const handleSaveKv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newKvKey.trim()) return;
    setKvStatus('Сохранение...');
    let parsedValue: any = newKvVal;
    try {
      parsedValue = JSON.parse(newKvVal);
    } catch {
      parsedValue = newKvVal;
    }
    const res = await apiFetch(`/api/projects/${activeProj.id}/kv/${encodeURIComponent(newKvKey.trim())}`, {
      method: 'PUT',
      body: JSON.stringify({ value: parsedValue }),
    });
    if (res.ok) {
      setNewKvKey('');
      setNewKvVal('');
      setKvStatus('Ключ сохранён в beacon.state');
      await loadProjectKv(activeProj.id);
      setTimeout(() => setKvStatus(''), 2500);
    } else {
      setKvStatus('Ошибка сохранения ключа');
    }
  };

  const handleDeleteKv = async (key: string) => {
    if (!activeProj) return;
    const res = await apiFetch(`/api/projects/${activeProj.id}/kv/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      await loadProjectKv(activeProj.id);
    }
  };

  const handleQuickSetupVenv = async () => {
    if (!activeProj) return;
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
        setCliRunId(data.run.id);
        setCliOutput(`Установка зависимостей · Run #${data.run.id}\nВывод процесса поступает в реальном времени ниже.`);
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
    if (!activeProj) return;
    const res = await apiFetch(`/api/projects/${activeProj.id}/clear_logs`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      await loadProjectRuns(activeProj.id);
      onRefreshAll();
    }
  };

  const loadProjectFiles = async (projId: number, preferPath?: string, forceReload = false) => {
    if (projId !== activeProjectIdRef.current) return;
    const requestId = ++fileListRequestIdRef.current;
    try {
      const res = await apiFetch(`/api/projects/${projId}/files`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Не удалось получить список файлов');
      }

      const data = await res.json();
      if (requestId !== fileListRequestIdRef.current || projId !== activeProjectIdRef.current) return;
      const tree: FileTreeNode[] = Array.isArray(data.tree)
        ? normalizeFileTree(data.tree)
        : buildFileTreeFromFlat(Array.isArray(data.files) ? data.files : []);
      const list = flattenFileTree(tree);
      const fileEntries = list.filter((entry) => !entry.is_dir);
      const validFolders = new Set(list.filter((entry) => entry.is_dir).map((entry) => entry.path));

      setFileTree(tree);
      setFiles(list);
      setExpandedFolders((prev) => {
        const next = new Set([...prev].filter((path) => validFolders.has(path)));
        tree.filter((node) => node.type === 'dir').forEach((node) => next.add(node.path));
        return next;
      });
      if (activeFolderPath && !validFolders.has(activeFolderPath)) setActiveFolderPath('');

      if (fileEntries.length === 0) {
        if (!forceReload && isFileDirty && activeFilePath) {
          setFileStatus('Список файлов пуст: несохранённый текст оставлен в редакторе');
          return;
        }
        setActiveFilePath('');
        setFileContent('');
        setSavedFileContent('');
        setFileStatus('В проекте пока нет файлов');
        return;
      }

      const preferred = preferPath && fileEntries.find((entry) => entry.path === preferPath);
      const current = activeFilePath ? fileEntries.find((entry) => entry.path === activeFilePath) : undefined;
      const mainFile =
        fileEntries.find((entry) => entry.path === 'main.py' || entry.path === 'index.js' || entry.path === 'run.sh') ||
        fileEntries[0];
      const target = preferred || current || mainFile;

      // Обновление дерева не должно сбрасывать открытый документ. Перечитываем его
      // только по явному предпочтительному пути или при чистом буфере после force-refresh.
      const shouldLoad = Boolean(preferred) || !current || (forceReload && !isFileDirty);
      if (target && shouldLoad) {
        const bypassDirtyPrompt = Boolean(preferred) || (forceReload && !isFileDirty);
        await loadSingleFile(projId, target.path, bypassDirtyPrompt);
      }
    } catch (e: any) {
      if (requestId !== fileListRequestIdRef.current || projId !== activeProjectIdRef.current) return;
      setFileStatus(e?.message || 'Ошибка загрузки списка файлов');
    }
  };

  const loadSingleFile = async (projId: number, relPath: string, force = false) => {
    if (projId !== activeProjectIdRef.current || !relPath) return;
    if (!force && relPath === activeFilePath) return;
    if (!force && isFileDirty && !window.confirm('В файле есть несохранённые изменения. Переключиться и потерять их?')) {
      return;
    }

    const requestId = ++fileRequestIdRef.current;
    setActiveFilePath(relPath);
    setFileContent('');
    setSavedFileContent('');
    setEditorScrollTop(0);
    setEditorCursor({ line: 1, column: 1 });
    setFileStatus('Загрузка файла...');
    try {
      const res = await apiFetch(`/api/projects/${projId}/files/content?path=${encodeURIComponent(relPath)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Не удалось прочитать файл');
      }
      const data = await res.json();
      if (requestId !== fileRequestIdRef.current || projId !== activeProjectIdRef.current) return;
      const content = typeof data.content === 'string' ? data.content : '';
      setFileContent(content);
      setSavedFileContent(content);
      setFileStatus('');
    } catch (e: any) {
      if (requestId !== fileRequestIdRef.current || projId !== activeProjectIdRef.current) return;
      setFileStatus(e?.message || 'Ошибка чтения файла');
    }
  };

  const handleSaveFile = async (pathOverride?: string, contentOverride?: string) => {
    if (!activeProj) return;
    const targetPath = pathOverride || activeFilePath;
    const targetContent = contentOverride !== undefined ? contentOverride : fileContent;
    if (!targetPath) return;

    setFileStatus('Сохранение...');
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/content`, {
        method: 'PUT',
        body: JSON.stringify({ path: targetPath, content: targetContent }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Ошибка сохранения файла');
      }
      if (activeProjectIdRef.current !== activeProj.id) return;
      if (targetPath === activeFilePath) setSavedFileContent(targetContent);
      setFileStatus('Сохранено');
      await loadProjectFiles(activeProj.id, targetPath === activeFilePath ? undefined : targetPath, false);
      onRefreshAll();
      window.setTimeout(() => setFileStatus((current) => current === 'Сохранено' ? '' : current), 2000);
    } catch (e: any) {
      setFileStatus(e?.message || 'Ошибка сохранения файла');
    }
  };

  const handleCreateNewFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newFileName.trim()) return;
    if (isFileDirty && !window.confirm('Текущий файл содержит несохранённые изменения. Продолжить создание файла и переключиться на него?')) return;
    let clean = '';
    try {
      clean = joinProjectPath(activeFolderPath, newFileName);
    } catch (err: any) {
      setFileStatus(err?.message || 'Некорректный путь к файлу');
      return;
    }
    const initialBody = clean.endsWith('.py')
      ? '# -*- coding: utf-8 -*-\nimport beacon\n\nprint("Запуск скрипта...", flush=True)\n'
      : clean.endsWith('.json')
      ? '{\n  \n}\n'
      : '';
    await handleSaveFile(clean, initialBody);
    setNewFileName('');
    setFileActionMode('none');
  };

  const handleCreateNewFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj || !newFolderName.trim()) return;
    let folderPath = '';
    try {
      folderPath = joinProjectPath(activeFolderPath, newFolderName);
    } catch (err: any) {
      setFileStatus(err?.message || 'Некорректный путь к папке');
      return;
    }
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ path: folderPath }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Ошибка создания папки');
      }
      if (activeProjectIdRef.current !== activeProj.id) return;
      setNewFolderName('');
      setFileActionMode('none');
      setActiveFolderPath(folderPath);
      setExpandedFolders((prev) => new Set([...prev, ...folderPath.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))]));
      await loadProjectFiles(activeProj.id);
    } catch (e: any) {
      setFileStatus(e?.message || 'Ошибка создания папки');
    }
  };

  const handleToggleFolder = (node: FileTreeNode) => {
    setActiveFolderPath(node.path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const handleDeleteFile = async (relPath: string) => {
    if (!activeProj || !relPath) return;
    if (!window.confirm(`Удалить файл «${relPath}»? Это действие нельзя отменить.`)) return;
    if (relPath === activeFilePath && isFileDirty && !window.confirm('В файле есть несохранённые изменения. Всё равно удалить его?')) return;
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/files?path=${encodeURIComponent(relPath)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Ошибка удаления файла');
      }
      if (activeProjectIdRef.current !== activeProj.id) return;
      if (relPath === activeFilePath) {
        setActiveFilePath('');
        setFileContent('');
        setSavedFileContent('');
      }
      setFileStatus(`Удалено: ${relPath}`);
      await loadProjectFiles(activeProj.id, undefined, true);
      onRefreshAll();
    } catch (e: any) {
      setFileStatus(e?.message || 'Ошибка удаления файла');
    }
  };

  const handleUploadZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeProj) return;
    setZipUploadStatus(`Загрузка ${file.name}...`);
    try {
      const base64Part = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const rawUrl = String(reader.result || '');
          resolve(rawUrl.includes(',') ? rawUrl.split(',')[1] : rawUrl);
        };
        reader.onerror = () => reject(new Error('Не удалось прочитать выбранный файл'));
        reader.readAsDataURL(file);
      });
      const isZip = file.name.toLowerCase().endsWith('.zip');
      const res = await apiFetch(`/api/projects/${activeProj.id}/files/upload?extract=${isZip ? 'true' : 'false'}`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, content_base64: base64Part, extract: isZip }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Ошибка загрузки файла');
      }
      const data = await res.json().catch(() => ({}));
      if (activeProjectIdRef.current !== activeProj.id) return;
      setZipUploadStatus(isZip ? `Распаковано файлов: ${data.files?.length || 0}` : `Загружен файл: ${file.name}`);
      await loadProjectFiles(activeProj.id, undefined, true);
      onRefreshAll();
    } catch (err: any) {
      setZipUploadStatus(err?.message || 'Ошибка загрузки файла');
    } finally {
      e.target.value = '';
    }
  };

  const handleDownloadActiveFile = () => {
    if (!activeFilePath) return;
    const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = activeFilePath.split('/').pop() || 'project-file.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleExportProject = async () => {
    if (!activeProj || exportingProject) return;
    if (isFileDirty) {
      setZipUploadStatus('Перед экспортом сохраните изменения в открытом файле.');
      return;
    }
    setExportingProject(true);
    setZipUploadStatus('Подготовка ZIP-архива проекта...');
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Не удалось экспортировать проект');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${activeProj.name.replace(/[\\/:*?"<>|]+/g, '_')}_project.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setZipUploadStatus('Архив проекта скачан');
    } catch (err: any) {
      setZipUploadStatus(err?.message || 'Ошибка экспорта проекта');
    } finally {
      setExportingProject(false);
    }
  };

  const updateEditorCursor = (target: HTMLTextAreaElement) => {
    const beforeCursor = target.value.slice(0, target.selectionStart);
    const lines = beforeCursor.split('\n');
    setEditorCursor({ line: lines.length, column: lines[lines.length - 1].length + 1 });
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void handleSaveFile();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const inserted = '    ';
      const nextValue = `${fileContent.slice(0, start)}${inserted}${fileContent.slice(end)}`;
      setFileContent(nextValue);
      requestAnimationFrame(() => {
        target.focus();
        target.setSelectionRange(start + inserted.length, start + inserted.length);
        updateEditorCursor(target);
      });
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const lineStart = fileContent.lastIndexOf('\n', start - 1) + 1;
      const currentLinePrefix = fileContent.slice(lineStart, start);
      const indentation = currentLinePrefix.match(/^\s*/)?.[0] || '';
      const extraIndent = /:\s*$/.test(currentLinePrefix.trimEnd()) ? '    ' : '';
      const inserted = `\n${indentation}${extraIndent}`;
      const nextValue = `${fileContent.slice(0, start)}${inserted}${fileContent.slice(end)}`;
      setFileContent(nextValue);
      requestAnimationFrame(() => {
        const nextCursor = start + inserted.length;
        target.focus();
        target.setSelectionRange(nextCursor, nextCursor);
        updateEditorCursor(target);
      });
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

  useEffect(() => {
    if (!activeProj) return;
    const timer = setInterval(() => {
      loadProjectRuns(activeProj.id);
    }, 2500);
    return () => clearInterval(timer);
  }, [activeProj?.id]);

  // SSE используется как основной канал. Опрос включается только при ошибке SSE,
  // чтобы два источника не дублировали друг другу одни и те же фрагменты лога.
  useEffect(() => {
    if (!selectedRunId) return;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const pollLogs = async () => {
      if (cancelled) return;
      try {
        const response = await apiFetch(`/api/runs/${selectedRunId}/log`);
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (!cancelled && typeof data.log === 'string') setLogText(data.log);
      } catch {
        // Следующий интервал повторит запрос.
      }
    };

    const startPollingFallback = () => {
      if (cancelled || pollTimer) return;
      es?.close();
      es = null;
      void pollLogs();
      pollTimer = setInterval(pollLogs, 2000);
    };

    const loadLogAndStream = async () => {
      try {
        const response = await apiFetch(`/api/runs/${selectedRunId}/log`);
        let startOffset = 0;
        if (response.ok && !cancelled) {
          const data = await response.json();
          if (cancelled) return;
          setLogText(typeof data.log === 'string' ? data.log : '');
          startOffset = Number(data.log_size || 0);
        }

        if (cancelled) return;
        let ticket = '';
        try {
          const ticketResponse = await apiFetch('/api/auth/stream_ticket', {
            method: 'POST',
            body: JSON.stringify({ run_id: selectedRunId }),
          });
          if (ticketResponse.ok) {
            const ticketData = await ticketResponse.json();
            ticket = String(ticketData.ticket || '');
          }
        } catch {
          // Без ticket пробуем SSE, затем при ошибке переключаемся на опрос.
        }

        if (cancelled) return;
        const streamUrl = `/api/runs/${selectedRunId}/stream?offset=${startOffset}${
          ticket ? `&ticket=${encodeURIComponent(ticket)}` : ''
        }`;
        try {
          es = new EventSource(streamUrl);
          es.onmessage = (event) => {
            try {
              const payload = JSON.parse(event.data);
              const chunk = payload.type === 'log' ? payload.data : payload.chunk;
              if (typeof chunk === 'string' && chunk.length) {
                setLogText((previous) => previous + chunk);
              }
              if (payload.type === 'eof' || payload.eof) es?.close();
            } catch {
              // Игнорируем некорректное SSE-событие, не ломая просмотр лога.
            }
          };
          es.onerror = startPollingFallback;
        } catch {
          startPollingFallback();
        }
      } catch {
        startPollingFallback();
      }
    };

    void loadLogAndStream();
    return () => {
      cancelled = true;
      es?.close();
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
        setTimeout(() => setStdinStatus(''), 2500);
      } else {
        const err = await res.json().catch(() => ({}));
        setStdinStatus(err.detail || 'Процесс не ожидает ввод');
      }
    } catch (error: any) {
      setStdinStatus(error?.message || 'Не удалось отправить ввод в процесс');
    }
  };

  // Сохранение кук (и привязка к проекту через /api/projects/{id}/cookies)
  const handleSaveAndAttachCookies = async () => {
    if (!activeProj) return;
    if (!cookieSecretName.trim()) {
      setCookieSaveStatus('Укажите имя секрета в Сейфе.');
      return;
    }
    const raw = cookieJsonText.trim();
    if (!raw) {
      setCookieSaveStatus('Вставьте реальные Cookies или загрузите JSON-файл. Шаблон не будет сохранён автоматически.');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((cookie) => cookie && typeof cookie === 'object' && !Array.isArray(cookie))) {
        setCookieSaveStatus('Ошибка: JSON должен быть массивом объектов Cookie [...]');
        return;
      }
    } catch {
      setCookieSaveStatus('Ошибка: невалидный JSON. Скопируйте экспорт из расширения Cookie-Editor');
      return;
    }

    setCookieSaveStatus('Сохранение в сейф и запись cookies.json (0600)...');
    try {
      const res = await apiFetch(`/api/projects/${activeProj.id}/cookies`, {
        method: 'POST',
        body: JSON.stringify({ name: cookieSecretName.trim(), cookies_json: raw }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setCookieSaveStatus(err.detail || 'Ошибка сохранения кук');
        return;
      }
      const updatedSecrets = Array.from(new Set([...cfgSelectedSecrets, cookieSecretName.trim()]));
      setCfgSelectedSecrets(updatedSecrets);
      onRefreshAll();
      void loadProjectFiles(activeProj.id);
      setCookieSaveStatus(`Куки сохранены в «${cookieSecretName.trim()}» и подключены к проекту.`);
    } catch (error: any) {
      setCookieSaveStatus(error?.message || 'Не удалось связаться с сервером при сохранении Cookies');
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
    if (!activeProj) return;
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
        setWebAuthStatusMsg(data.detail || 'Ошибка HTTP-проверки');
      }
    } catch (error: any) {
      setWebAuthStatusMsg(error?.message || 'Не удалось выполнить HTTP-проверку');
    } finally {
      setWebAuthLoading(false);
    }
  };

  const handleSaveWebAuth = async () => {
    if (!activeProj || !webAuthSession) return;
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
        setWebAuthStatusMsg(data.detail || 'Ошибка сохранения сессии');
      }
    } catch (error: any) {
      setWebAuthStatusMsg(error?.message || 'Не удалось сохранить данные HTTP-сессии');
    } finally {
      setWebAuthLoading(false);
    }
  };

  // Сохранение Telegram-параметров и прокси в ENV проекта
  const handleSaveTelegramAndProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeProj) return;
    setTgSaveStatus('Сохранение...');
    let envObj: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(cfgEnvJson || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ENV должен быть JSON-объектом');
      envObj = parsed as Record<string, string>;
    } catch (error: any) {
      setTgSaveStatus(error?.message || 'Ошибка JSON в ENV. Исправьте формат: текущие переменные не изменены.');
      return;
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
    try {
      await onUpdateProject(activeProj.id, { env_json: updatedEnvStr });
      setCfgEnvJson(updatedEnvStr);
      setTgSaveStatus('Настройки Telegram и прокси сохранены в переменные окружения проекта');
    } catch (error: any) {
      setTgSaveStatus(error?.message || 'Не удалось сохранить настройки Telegram и прокси');
    }
  };

  // Терминал и быстрые команды в рабочей папке проекта
  const runProjectCommand = async (cmd: string) => {
    if (!activeProj || !cmd.trim() || cliRunning) return;
    setCliCommand(cmd);
    setCliRunId(null);
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
        setCliRunId(rId);
        setSelectedRunId(rId);
        setCliOutput(`$ ${cmd}\nRun #${rId} · PID ${data.run.pid || '—'}\nПоток вывода подключается...\n`);
        void loadProjectRuns(activeProj.id);
        void loadProjectFiles(activeProj.id);
        onRefreshAll();
      } else {
        setCliRunId(null);
        setCliOutput(`$ ${cmd}\n[Ошибка]: ${data.detail || 'Не удалось выполнить команду'}`);
      }
    } catch (e: any) {
      setCliRunId(null);
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
      setCfgScheduleExpr((dailyVal || '09:00').trim());
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
    if (!activeProj) return;
    setCfgStatus('Сохранение конфигурации...');
    try {
      const parsedEnv: unknown = JSON.parse(cfgEnvJson || '{}');
      if (!parsedEnv || typeof parsedEnv !== 'object' || Array.isArray(parsedEnv)) {
        throw new Error('ENV должен быть корректным JSON-объектом. Конфигурация не сохранена.');
      }
      const parsedPort = cfgPort.trim() ? Number(cfgPort.trim()) : 0;
      const finalSchedType = cfgType === 'job' ? (cfgScheduleType === 'manual' ? 'cron' : cfgScheduleType) : 'manual';
      const finalSchedExpr =
        cfgType === 'job' ? (cfgScheduleExpr.trim() || (finalSchedType === 'daily' ? '09:00' : '*/15 * * * *')) : '';
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
        restart_policy: cfgRestartPolicy,
        max_retries: Number(cfgMaxRetries),
        retry_delay_sec: Number(cfgRetryDelaySec),
        ram_limit_mb: Number(cfgMaxRam),
        timeout_sec: Number(cfgTimeout),
        env_json: cfgEnvJson,
        secrets_json: JSON.stringify(cfgSelectedSecrets),
        webhook_hmac_secret: cfgWebhookHmacSecret.trim(),
        params_schema: cleanParams,
      });
      setCfgStatus('Конфигурация проекта успешно сохранена');
      setTimeout(() => setCfgStatus(''), 3000);
    } catch (err: any) {
      setCfgStatus(err?.message || 'Ошибка сохранения конфигурации');
    }
  };

  const toggleSecretAttachment = (secName: string) => {
    setCfgSelectedSecrets((prev) =>
      prev.includes(secName) ? prev.filter((x) => x !== secName) : [...prev, secName]
    );
  };

  const insertSdkSnippet = (snippet: string) => {
    setFileContent((prev) => `${prev.trimEnd()}\n\n${snippet}\n`);
    setFileStatus('Сниппет вставлен в конец файла — нажмите Сохранить');
  };

  const filteredProjects = projects.filter((p) => {
    if (projectTypeFilter !== 'all' && p.type !== projectTypeFilter) return false;
    if (!projectSearch.trim()) return true;
    const q = projectSearch.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.cmd || '').toLowerCase().includes(q) ||
      (p.runtime || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    );
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

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
      {/* Левая колонка: Навигатор проектов */}
      <aside className="xl:col-span-3 bg-[#111622] border border-[#1e2638] rounded-xl p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">
              Проекты ({projects.length})
            </h2>
            <p className="text-[11px] text-slate-400">Выберите сервис или скрипт</p>
          </div>
          <button
            type="button"
            onClick={onOpenCreateModal}
            className="px-2.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1 cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Создать
          </button>
        </div>

        {/* Поиск по имени/команде */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={projectSearch}
            onChange={(e) => setProjectSearch(e.target.value)}
            placeholder="Фильтр проектов..."
            className="w-full bg-[#0b0f17] border border-[#1e2638] focus:border-indigo-500 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-400 outline-none"
          />
        </div>

        {/* Быстрый фильтр по архитектуре */}
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

        {/* Список карточек проектов */}
        <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-0.5">
          {filteredProjects.map((p) => {
            const isSelected = p.id === activeProj.id;
            const pStatus = p.current_status || 'stopped';
            const st = statusBadge(pStatus);
            const tMeta = getProjectTypeMeta(p);
            const isRunning = pStatus === 'running' || pStatus === 'waiting_input';

            return (
              <div
                key={p.id}
                onClick={() => {
                  if (p.id !== activeProj.id && isFileDirty && !window.confirm('В редакторе есть несохранённые изменения. Переключить проект и потерять их?')) return;
                  onSelectProject(p);
                }}
                className={`group rounded-lg p-2.5 border transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-indigo-950/35 border-indigo-500/60 shadow-sm'
                    : 'bg-[#0b0f17]/80 border-[#1e2638] hover:border-slate-700 hover:bg-[#0b0f17]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        pStatus === 'running'
                          ? 'bg-emerald-400'
                          : pStatus === 'waiting_input'
                          ? 'bg-amber-400 animate-pulse'
                          : pStatus === 'failed' || pStatus === 'killed_oom'
                          ? 'bg-rose-500'
                          : 'bg-slate-600'
                      }`}
                    />
                    <span className="text-xs font-bold text-white truncate">{p.name}</span>
                  </div>
                  <span className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${st.cls}`}>{st.label}</span>
                </div>

                <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums">
                  <span className={tMeta.color}>{tMeta.label}</span>
                  <span>
                    {isRunning && p.rss_mb ? `${p.rss_mb} МБ · ` : ''}
                    {formatBytes(p.total_size_bytes || 0)}
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

      {/* Правая колонка: Рабочее пространство выбранного проекта */}
      <div className="xl:col-span-9 space-y-4">
        {/* Верхний паспорт и панель управления проектом */}
        <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-4 space-y-3.5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-lg font-bold tracking-tight text-white">{activeProj.name}</h2>
                <span className={`px-2 py-0.5 text-xs font-mono rounded ${statusBadge(activeStatus).cls}`}>
                  {statusBadge(activeStatus).label}
                </span>
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
              </div>

              {/* Метаданные одной строкой без визуального мусора */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono text-slate-300 tabular-nums">
                <span className={activeTypeMeta.color}>{activeTypeMeta.label}</span>
                <span className="text-slate-600">·</span>
                <span>{activeProj.runtime}</span>
                <span className="text-slate-600">·</span>
                <span className="text-slate-400 truncate max-w-xs" title={activeProj.cmd}>
                  {activeProj.cmd}
                </span>
                {activeProj.pid && (
                  <>
                    <span className="text-slate-600">·</span>
                    <span className="text-emerald-300">
                      PID {activeProj.pid} (PGID {activeProj.pgid || activeProj.pid})
                    </span>
                  </>
                )}
                <span className="text-slate-600">·</span>
                <span>
                  ОЗУ {activeProj.rss_mb || 0}/{activeProj.ram_limit_mb || 128} МБ
                </span>
                <span className="text-slate-600">·</span>
                <span>Диск {formatBytes(activeProj.total_size_bytes || 0)}</span>
              </div>
            </div>

            {/* Главные кнопки управления процессом */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activeStatus === 'running' || activeStatus === 'waiting_input' ? (
                <>
                  <button
                    type="button"
                    onClick={() => onStopProject(activeProj.id)}
                    className="px-3.5 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <Square className="w-3.5 h-3.5" />
                    Остановить
                  </button>
                  <button
                    type="button"
                    onClick={() => onRestartProject(activeProj.id)}
                    className="px-3 py-2 text-xs font-semibold text-slate-200 bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Рестарт
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onStartProject(activeProj.id)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Play className="w-3.5 h-3.5" />
                  Запустить сейчас
                </button>
              )}

              <button
                type="button"
                disabled={venvSetupRunning}
                onClick={handleQuickSetupVenv}
                className="px-3 py-2 text-xs font-semibold text-indigo-200 bg-indigo-950/50 hover:bg-indigo-900/60 border border-indigo-800/60 rounded-lg inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                title="Создать изолированный .venv и установить зависимости через uv / pip"
              >
                <Package className="w-3.5 h-3.5 text-indigo-400" />
                {venvSetupRunning ? 'Установка...' : '.venv / Пакеты'}
              </button>

              {onCloneProject && (
                <button
                  type="button"
                  onClick={() => onCloneProject(activeProj.id)}
                  className="px-2.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1 cursor-pointer"
                  title="Создать копию проекта"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Клон
                </button>
              )}

              <button
                type="button"
                onClick={handleExportProject}
                disabled={exportingProject}
                className="px-2.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                title="Экспортировать проект в .zip с project.yaml (без значений секретов)"
              >
                <FileText className="w-3.5 h-3.5 text-emerald-400" />
                Экспорт .zip
              </button>

              <button
                type="button"
                onClick={() => {
                  setDeleteFilesCheckbox(false);
                  setDeleteConfirmOpen(true);
                }}
                className="p-2 text-xs text-rose-400 hover:text-rose-200 bg-rose-950/30 hover:bg-rose-900/50 border border-rose-900/50 rounded-lg inline-flex items-center cursor-pointer"
                title="Удалить проект"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

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

          {/* Навигация по 4 рабочим вкладкам проекта */}
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-[#1e2638]">
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
              Конфигурация и Расписание
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
        </div>

        {/* ==================== ВКЛАДКА 1: КОД И ФАЙЛЫ (IDE SPLIT VIEW) ==================== */}
        {subTab === 'editor' && (
          <div className="bg-[#111622] border border-[#1e2638] rounded-xl overflow-hidden">
            <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[430px]">
              {/* Левая боковая панель: полноценное дерево файлов */}
              <div className="lg:col-span-4 xl:col-span-3 border-b lg:border-b-0 lg:border-r border-[#1e2638] bg-[#0b0f17]/70 p-3 flex flex-col gap-3 min-h-[560px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Проводник</div>
                    <div className="text-[10px] text-slate-500">{files.filter((f) => !f.is_dir).length} файлов · {files.filter((f) => f.is_dir).length} папок</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setFileActionMode(fileActionMode === 'new_file' ? 'none' : 'new_file')}
                      className="p-1.5 text-slate-300 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-md cursor-pointer"
                      title={`Новый файл в ${activeFolderPath || 'корне проекта'}`}
                    >
                      <FilePlus className="h-4 w-4 text-indigo-300" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFileActionMode(fileActionMode === 'new_folder' ? 'none' : 'new_folder')}
                      className="p-1.5 text-slate-300 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-md cursor-pointer"
                      title="Новая папка внутри выбранной папки"
                    >
                      <FolderPlus className="h-4 w-4 text-amber-300" />
                    </button>
                    <input
                      ref={zipInputRef}
                      type="file"
                      onChange={handleUploadZip}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => zipInputRef.current?.click()}
                      className="p-1.5 text-slate-300 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-md cursor-pointer"
                      title="Загрузить файл или ZIP-архив"
                    >
                      <Upload className="h-4 w-4 text-emerald-300" />
                    </button>
                    <button
                      type="button"
                      onClick={handleExportProject}
                      disabled={exportingProject}
                      className="p-1.5 text-slate-300 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-md cursor-pointer disabled:opacity-50"
                      title="Скачать весь проект в ZIP"
                    >
                      <Download className="h-4 w-4 text-cyan-300" />
                      <span className="text-[10px] font-semibold">ZIP</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => loadProjectFiles(activeProj.id)}
                      className="p-1.5 text-slate-300 hover:text-white bg-[#111622] hover:bg-slate-800 border border-[#1e2638] rounded-md cursor-pointer"
                      title="Обновить дерево файлов"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-md border border-[#1e2638] bg-[#111622] px-2 py-1.5 text-[10px] font-mono">
                  <button
                    type="button"
                    onClick={() => setActiveFolderPath('')}
                    className={`shrink-0 hover:text-white ${activeFolderPath ? 'text-slate-400' : 'text-indigo-300'}`}
                    title="Корень проекта"
                  >
                    {activeProj.name}
                  </button>
                  {activeFolderPath.split('/').filter(Boolean).map((part, index, parts) => {
                    const path = parts.slice(0, index + 1).join('/');
                    return (
                      <React.Fragment key={path}>
                        <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
                        <button
                          type="button"
                          onClick={() => {
                            setActiveFolderPath(path);
                            setExpandedFolders((previous) => new Set([...previous, ...parts.slice(0, index + 1).map((_, parentIndex) => parts.slice(0, parentIndex + 1).join('/'))]));
                          }}
                          className={`max-w-[120px] shrink-0 truncate hover:text-white ${index === parts.length - 1 ? 'text-indigo-300' : 'text-slate-400'}`}
                          title={path}
                        >
                          {part}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>

                {fileActionMode === 'new_file' && (
                  <form onSubmit={handleCreateNewFile} className="space-y-1.5 rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-2">
                    <div className="text-[10px] text-indigo-200">Создание файла в: {activeFolderPath || 'корне проекта'}</div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newFileName}
                        onChange={(e) => setNewFileName(e.target.value)}
                        placeholder="script.py или utils/db.py"
                        autoFocus
                        className="min-w-0 flex-1 bg-[#0b0f17] border border-indigo-500/50 rounded px-2 py-1.5 text-xs font-mono text-white outline-none focus:border-indigo-400"
                      />
                      <button type="submit" className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold cursor-pointer">Создать</button>
                    </div>
                  </form>
                )}

                {fileActionMode === 'new_folder' && (
                  <form onSubmit={handleCreateNewFolder} className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-950/10 p-2">
                    <div className="text-[10px] text-amber-200">Создание папки в: {activeFolderPath || 'корне проекта'}</div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        placeholder="modules или modules/utils"
                        autoFocus
                        className="min-w-0 flex-1 bg-[#0b0f17] border border-amber-500/50 rounded px-2 py-1.5 text-xs font-mono text-white outline-none focus:border-amber-400"
                      />
                      <button type="submit" className="px-2.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-semibold cursor-pointer">Создать</button>
                    </div>
                  </form>
                )}

                {zipUploadStatus && (
                  <div className="text-[10px] font-mono text-slate-300 bg-[#111622] border border-[#1e2638] rounded-md px-2.5 py-2 break-words">
                    {zipUploadStatus}
                  </div>
                )}

                <div className="flex-1 min-h-[220px] max-h-[520px] overflow-y-auto rounded-lg border border-[#1e2638] bg-[#080c14] p-1.5">
                  {fileTree.length ? (
                    <ProjectFileTree
                      nodes={fileTree}
                      selectedFilePath={activeFilePath}
                      selectedFolderPath={activeFolderPath}
                      expandedFolders={expandedFolders}
                      onToggleFolder={handleToggleFolder}
                      onSelectFile={(path) => loadSingleFile(activeProj.id, path)}
                    />
                  ) : (
                    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-4 text-center">
                      <FolderCode className="h-8 w-8 text-slate-600" />
                      <div className="text-xs text-slate-400">Папка проекта пуста</div>
                      <div className="text-[10px] text-slate-600">Создайте файл, папку или загрузите ZIP-архив</div>
                    </div>
                  )}
                </div>

                <div className="border-t border-[#1e2638] pt-2 text-[10px] font-mono text-slate-500" title={activeProj.workdir}>
                  <div className="truncate">{activeProj.workdir}</div>
                </div>
              </div>

              {/* Правая часть: Редактор кода */}
              <div className="lg:col-span-8 xl:col-span-9 flex flex-col justify-between bg-[#070b14]">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-[#111622] border-b border-[#1e2638]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-mono font-bold text-indigo-300 truncate" title={activeFilePath}>
                      {activeFilePath || 'Файл не выбран'}
                    </span>
                    {activeFilePath && (
                      <span className="shrink-0 rounded border border-[#293449] bg-[#0b0f17] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-slate-400">
                        {fileLanguageLabel(activeFilePath)}
                      </span>
                    )}
                    {isFileDirty && <span className="shrink-0 text-[10px] font-semibold text-amber-300">● Не сохранено</span>}
                    {fileStatus && (
                      <span className={`text-[11px] font-mono ${fileStatus.toLowerCase().includes('ошибка') || fileStatus.toLowerCase().includes('не удалось') ? 'text-rose-300' : fileStatus.toLowerCase().includes('загрузка') || fileStatus.toLowerCase().includes('сохранение') ? 'text-amber-300' : 'text-emerald-400'}`}>{fileStatus}</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <div className="flex items-center rounded-lg border border-[#1e2638] bg-[#0b0f17] p-0.5">
                      <button type="button" onClick={() => setEditorFontSize((size) => Math.max(10, size - 1))} disabled={editorFontSize <= 10} className="h-7 w-7 rounded text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-30" title="Уменьшить шрифт">A−</button>
                      <span className="min-w-8 text-center text-[10px] font-mono text-slate-500">{editorFontSize}</span>
                      <button type="button" onClick={() => setEditorFontSize((size) => Math.min(20, size + 1))} disabled={editorFontSize >= 20} className="h-7 w-7 rounded text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-30" title="Увеличить шрифт">A+</button>
                    </div>
                    <button type="button" onClick={() => setEditorWrap((value) => !value)} className={`px-2 py-1.5 text-[10px] rounded-md border cursor-pointer ${editorWrap ? 'border-indigo-500/60 bg-indigo-950/40 text-indigo-200' : 'border-[#1e2638] bg-[#0b0f17] text-slate-400 hover:text-white'}`} title="Переключить перенос строк">Перенос {editorWrap ? 'вкл.' : 'выкл.'}</button>
                    <button type="button" onClick={handleDownloadActiveFile} disabled={!activeFilePath} className="px-2 py-1.5 text-[10px] rounded-md border border-[#1e2638] bg-[#0b0f17] text-slate-300 hover:text-white disabled:opacity-40 cursor-pointer inline-flex items-center gap-1" title="Скачать текущий файл"><Download className="h-3.5 w-3.5" />Скачать</button>
                    <button type="button" onClick={() => { if (isFileDirty && !window.confirm('Перечитать файл с сервера и потерять несохранённые изменения?')) return; void loadSingleFile(activeProj.id, activeFilePath, true); }} disabled={!activeFilePath} className="p-1.5 rounded-md border border-[#1e2638] bg-[#0b0f17] text-slate-400 hover:text-white disabled:opacity-40 cursor-pointer" title="Перечитать файл с сервера"><RefreshCw className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => setShowSdkCheatsheet((v) => !v)} className="px-2 py-1.5 text-[10px] rounded-md border border-[#1e2638] bg-[#0b0f17] text-slate-300 hover:text-white cursor-pointer inline-flex items-center gap-1">
                      <span>SDK</span>{showSdkCheatsheet ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    {activeFilePath && (
                      <button type="button" onClick={() => handleDeleteFile(activeFilePath)} className="px-2 py-1.5 text-[10px] rounded-md border border-rose-800/50 bg-rose-950/30 text-rose-300 hover:text-white cursor-pointer inline-flex items-center gap-1">
                        <Trash2 className="w-3 h-3" />Удалить
                      </button>
                    )}
                    <button type="button" onClick={() => handleSaveFile()} disabled={!activeFilePath || !isFileDirty} className="px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg inline-flex items-center gap-1.5 cursor-pointer">
                      <Save className="w-3.5 h-3.5" />Сохранить
                    </button>
                  </div>
                </div>

                {/* Выдвижная панель быстрых сниппетов Beacon SDK */}
                {showSdkCheatsheet && (
                  <div className="px-4 py-2.5 bg-[#0b0f17] border-b border-[#1e2638] flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-slate-400 mr-1">Вставить в код:</span>
                    <button
                      type="button"
                      onClick={() =>
                        insertSdkSnippet(
                          'import beacon\n# Чтение и запись постоянного состояния (переживает рестарты):\ncount = int(beacon.state.get("processed_count", 0))\nbeacon.state.set("processed_count", count + 1)'
                        )
                      }
                      className="px-2 py-1 text-[11px] font-mono bg-[#111622] hover:bg-slate-800 text-indigo-300 border border-[#1e2638] rounded cursor-pointer"
                    >
                      + beacon.state.get/set
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        insertSdkSnippet(
                          'import beacon\n# Запрос 2FA/капчи в веб-панель и Telegram:\ncode = beacon.ask("Введите код подтверждения из SMS:")\nprint("Получен код:", code, flush=True)'
                        )
                      }
                      className="px-2 py-1 text-[11px] font-mono bg-[#111622] hover:bg-slate-800 text-amber-300 border border-[#1e2638] rounded cursor-pointer"
                    >
                      + beacon.ask("2FA код")
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        insertSdkSnippet(
                          `import beacon, json\n# Чтение кук из защищённого хранилища:\nraw_cookies = beacon.secret("${cookieSecretName || activeProj.name + '_cookies'}")\ncookies = json.loads(raw_cookies) if isinstance(raw_cookies, str) and raw_cookies else (raw_cookies or [])`
                        )
                      }
                      className="px-2 py-1 text-[11px] font-mono bg-[#111622] hover:bg-slate-800 text-emerald-300 border border-[#1e2638] rounded cursor-pointer"
                    >
                      + beacon.secret("cookies")
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        insertSdkSnippet(
                          `import beacon\n# Сигнал об истечении кук (вызовет тревогу в панели):\nbeacon.cookies_expired("${cookieSecretName || activeProj.name + '_cookies'}", "Требуется свежий экспорт Cookie-Editor")`
                        )
                      }
                      className="px-2 py-1 text-[11px] font-mono bg-[#111622] hover:bg-slate-800 text-rose-300 border border-[#1e2638] rounded cursor-pointer"
                    >
                      + beacon.cookies_expired()
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        insertSdkSnippet(
                          'import beacon\n# Сигнал Dead Man\'s Switch (использует BEACON_PING_TOKEN):\nbeacon.ping()'
                        )
                      }
                      className="px-2 py-1 text-[11px] font-mono bg-[#111622] hover:bg-slate-800 text-cyan-300 border border-[#1e2638] rounded cursor-pointer"
                    >
                      + beacon.ping()
                    </button>
                  </div>
                )}

                <div className="flex min-h-[460px] flex-1 overflow-hidden bg-[#070b14]">
                  <div className="w-12 shrink-0 overflow-hidden border-r border-[#1b2433] bg-[#0a0f19] text-right text-slate-600 select-none" aria-hidden="true">
                    <div className="px-2 pt-3 font-mono leading-7" style={{ fontSize: `${editorFontSize}px`, transform: `translateY(-${editorScrollTop}px)` }}>
                      {Array.from({ length: Math.max(1, fileContent.split('\n').length) }, (_, index) => (
                        <div key={index + 1} className={`h-7 ${editorCursor.line === index + 1 ? 'text-indigo-300' : ''}`}>{index + 1}</div>
                      ))}
                    </div>
                  </div>
                  <textarea
                    ref={editorRef}
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    onKeyDown={handleEditorKeyDown}
                    onScroll={(e) => setEditorScrollTop(e.currentTarget.scrollTop)}
                    onClick={(e) => updateEditorCursor(e.currentTarget)}
                    onKeyUp={(e) => updateEditorCursor(e.currentTarget)}
                    onSelect={(e) => updateEditorCursor(e.currentTarget)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    disabled={!activeFilePath}
                    placeholder="Выберите файл в проводнике слева или создайте новый..."
                    wrap={editorWrap ? 'soft' : 'off'}
                    style={{ fontSize: `${editorFontSize}px` }}
                    className={`min-w-0 flex-1 min-h-[460px] bg-transparent px-4 py-3 font-mono leading-7 text-slate-100 caret-indigo-400 focus:outline-none resize-none disabled:cursor-default disabled:opacity-50 ${editorWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'}`}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1b2433] bg-[#0b0f17] px-3 py-1.5 text-[10px] font-mono text-slate-500">
                  <div className="flex items-center gap-3">
                    <span>{activeFilePath ? fileLanguageLabel(activeFilePath) : 'Нет файла'}</span>
                    <span>{fileContent.split('\n').length} строк</span>
                    <span>{fileContent.length.toLocaleString('ru-RU')} символов</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span>Строка {editorCursor.line}, столбец {editorCursor.column}</span>
                    <span>{isFileDirty ? 'Изменения не сохранены' : 'Синхронизировано'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== ВКЛАДКА 2: КОНФИГУРАЦИЯ И РАСПИСАНИЕ ==================== */}
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
                  Настройте режим работы ({cfgType === 'service' ? 'Service 24/7' : cfgType === 'web' ? 'Web / API (:PORT)' : 'Scheduled Job'}), изоляцию и лимиты ОЗУ
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
                    Основные
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubTab('advanced_cfg')}
                    className={`px-3 py-1 rounded text-xs font-semibold cursor-pointer ${
                      subTab === 'advanced_cfg' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    ENV, Секреты и Webhook
                  </button>
                </div>

                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Сохранить настройки
                </button>
              </div>
            </div>

            {cfgStatus && (
              <div className={`px-3.5 py-2 rounded-lg border text-xs font-mono ${cfgStatus.toLowerCase().includes('ошибка') || cfgStatus.toLowerCase().includes('не сохранена') ? 'bg-rose-950/30 border-rose-800/60 text-rose-300' : 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'}`}>
                {cfgStatus}
              </div>
            )}

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
                      Telegram-боты, воркеры и демоны. Супервизор автоматически перезапускает процесс при падении.
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
                    <div className="text-xs font-bold text-cyan-300">2. Веб-сервис / API (:PORT)</div>
                    <p className="text-[11px] text-slate-400 mt-1">
                      FastAPI, Flask, Node.js, Go или бинарник с передачей переменной $PORT и HTTP Healthcheck.
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
                      Парсеры, чекеры кук и отчёты. Запускается по таймеру, выполняет работу и освобождает ОЗУ.
                    </p>
                  </button>
                </div>

                {/* Имя, Среда и Команда */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                  <div className="md:col-span-4">
                    <label className="block text-xs text-slate-400 mb-1">Название проекта</label>
                    <input
                      type="text"
                      value={cfgName}
                      onChange={(e) => setCfgName(e.target.value)}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs text-white font-mono"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="block text-xs text-slate-400 mb-1">Рантайм</label>
                    <select
                      value={cfgRuntime}
                      onChange={(e) => setCfgRuntime(e.target.value)}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs text-white font-mono"
                    >
                      <option value="python">Python (.venv / uv)</option>
                      <option value="node">Node.js (npm)</option>
                      <option value="bash">Bash / Shell</option>
                      <option value="custom">Custom / Бинарник</option>
                    </select>
                  </div>
                  <div className="md:col-span-5">
                    <label className="block text-xs text-slate-400 mb-1">Команда запуска (внутри рабочей папки)</label>
                    <input
                      type="text"
                      value={cfgCommand}
                      onChange={(e) => setCfgCommand(e.target.value)}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs text-white font-mono"
                    />
                  </div>
                </div>

                {/* Блок для Web / API (:PORT) */}
                {cfgType === 'web' && (
                  <div className="bg-[#0b0f17] border border-cyan-900/50 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-cyan-300 mb-1">
                        Порт веб-сервиса ($PORT)
                      </label>
                      <input
                        type="number"
                        value={cfgPort}
                        onChange={(e) => setCfgPort(e.target.value)}
                        placeholder="18081"
                        className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                      />
                      <span className="text-[11px] text-slate-400 mt-1 block">
                        Доступен процессу через переменную окружения <code className="text-cyan-300">$PORT</code>
                      </span>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-cyan-300 mb-1">
                        Healthcheck URL (опционально)
                      </label>
                      <input
                        type="text"
                        value={cfgHealthcheckUrl}
                        onChange={(e) => setCfgHealthcheckUrl(e.target.value)}
                        placeholder="http://127.0.0.1:18081/health"
                        className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                      />
                      <span className="text-[11px] text-slate-400 mt-1 block">
                        При падении проверки супервизор перезапустит сервис согласно политике
                      </span>
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

                {/* Супервизор, Политика рестарта и Лимит памяти PGID */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-2 border-t border-[#1e2638]">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Политика перезапуска</label>
                    <select
                      value={cfgRestartPolicy}
                      onChange={(e) => setCfgRestartPolicy(e.target.value)}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                    >
                      <option value="always">always (всегда)</option>
                      <option value="on-failure">on-failure (при сбое)</option>
                      <option value="no">no (без авто-рестарта)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Лимит ОЗУ дерева PGID (МБ)</label>
                    <input
                      type="number"
                      min={16}
                      max={4096}
                      value={cfgMaxRam}
                      onChange={(e) => setCfgMaxRam(Number(e.target.value))}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Макс. попыток (Retries)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={cfgMaxRetries}
                      onChange={(e) => setCfgMaxRetries(Number(e.target.value))}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Таймаут выполнения (0 = без лимита)</label>
                    <input
                      type="number"
                      min={0}
                      value={cfgTimeout}
                      onChange={(e) => setCfgTimeout(Number(e.target.value))}
                      className="w-full bg-[#0b0f17] border border-[#1e2638] rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>
                </div>
              </div>
            ) : (
              /* Вкладка ENV, Секреты, Webhook и Параметры */
              <div className="space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Переменные окружения (ENV JSON)
                    </label>
                    <textarea
                      rows={7}
                      value={cfgEnvJson}
                      onChange={(e) => setCfgEnvJson(e.target.value)}
                      spellCheck={false}
                      className="w-full bg-[#070b14] border border-[#1e2638] rounded-lg p-3 text-xs font-mono text-slate-200"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      Привязанные секреты из Сейфа (доступны через beacon.secret)
                    </label>
                    <div className="bg-[#0b0f17] border border-[#1e2638] rounded-lg p-3 max-h-[172px] overflow-y-auto space-y-1.5">
                      {secrets.map((s) => {
                        const checked = cfgSelectedSecrets.includes(s.name);
                        return (
                          <label
                            key={s.name}
                            className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded hover:bg-[#111622] cursor-pointer text-xs font-mono"
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSecretAttachment(s.name)}
                                className="rounded border-slate-700"
                              />
                              <span className="text-white">{s.name}</span>
                            </div>
                            <span className="text-[10px] text-slate-400">{s.type}</span>
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
                        Только объявленные имена разрешены для передачи как <code className="font-mono">PARAM_*</code> при старте
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

        {/* ==================== ВКЛАДКА 3: КУКИ, ПРОКСИ И TELEGRAM ==================== */}
        {subTab === 'cookies_tg' && (
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

              {cookieSaveStatus && (
                <div className={`text-xs font-mono rounded-lg px-3 py-2 border ${cookieSaveStatus.toLowerCase().includes('ошибка') || cookieSaveStatus.toLowerCase().includes('вставьте') ? 'text-rose-300 bg-rose-950/30 border-rose-800/50' : 'text-emerald-300 bg-emerald-950/30 border-emerald-800/50'}`}>
                  {cookieSaveStatus}
                </div>
              )}

              <button
                type="button"
                onClick={handleSaveAndAttachCookies}
                className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4" />
                Сохранить и привязать куки к проекту
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

                {webAuthStatusMsg && (
                  <div className="text-[11px] font-mono text-cyan-300 bg-cyan-950/30 border border-cyan-800/50 rounded-lg px-3 py-2">
                    {webAuthStatusMsg}
                  </div>
                )}

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

              {tgSaveStatus && (
                <div className={`text-xs font-mono rounded-lg px-3 py-2 border ${tgSaveStatus.toLowerCase().includes('ошибка') || tgSaveStatus.toLowerCase().includes('не удалось') || tgSaveStatus.toLowerCase().includes('должен') ? 'text-rose-300 bg-rose-950/30 border-rose-800/50' : 'text-emerald-300 bg-emerald-950/30 border-emerald-800/50'}`}>
                  {tgSaveStatus}
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                Сохранить Telegram и Прокси в ENV
              </button>
            </form>
          </div>
        )}

        {/* ==================== ВКЛАДКА 4: ТЕРМИНАЛ, GIT И ИСТОРИЯ ЗАПУСКОВ ==================== */}
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
                    disabled={cliRunning}
                    onClick={() => runProjectCommand(btn.cmd)}
                    className="px-2.5 py-1 text-[11px] font-mono text-slate-200 bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
              <div className="overflow-hidden rounded-lg border border-[#1e2638] bg-[#070b14]">
                <div className="flex items-center justify-between gap-2 border-b border-[#1e2638] bg-[#0b0f17] px-3 py-1.5">
                  <span className="text-[10px] font-mono text-slate-400">Вывод команды {cliRunId ? `· Run #${cliRunId}` : ''}</span>
                  {cliRunId && cliRunId === selectedRunId && <button type="button" onClick={() => setBottomConsoleTab('logs')} className="text-[10px] text-indigo-300 hover:text-white">Открыть большой лог ↓</button>}
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3.5 text-xs font-mono text-slate-200">
                  {cliOutput}{cliRunId && cliRunId === selectedRunId ? (logText || '\nОжидание вывода процесса...') : ''}
                </pre>
              </div>
            )}

            {/* Таблица истории запусков */}
            <div className="pt-3 border-t border-[#1e2638] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  История запусков ({runs.length})
                </span>
                <button
                  type="button"
                  onClick={handleClearOldLogs}
                  className="text-xs text-slate-400 hover:text-rose-300 font-mono cursor-pointer"
                >
                  Очистить старые логи
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
                    {runs.slice(0, 15).map((r) => {
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
            </div>
          </div>
        )}

        {/* ==================== НИЖНЯЯ ДОК-КОНСОЛЬ (ЖИВОЙ ЛОГ / HUB.STATE / БЫСТРЫЙ SHELL) ==================== */}
        <div className="bg-[#111622] border border-[#1e2638] rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-[#0b0f17] border-b border-[#1e2638] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setBottomConsoleTab('logs')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                  bottomConsoleTab === 'logs'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-[#111622]'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                Живой лог и stdin
              </button>

              <button
                type="button"
                onClick={() => {
                  setBottomConsoleTab('kv');
                  loadProjectKv(activeProj.id);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                  bottomConsoleTab === 'kv'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-[#111622]'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Хранилище beacon.state ({kvItems.length})
              </button>

              <button
                type="button"
                onClick={() => setBottomConsoleTab('shell')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                  bottomConsoleTab === 'shell'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-[#111622]'
                }`}
              >
                <Package className="w-3.5 h-3.5" />
                Быстрый Shell (.venv / uv)
              </button>
            </div>

            {bottomConsoleTab === 'logs' && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={logSearchQuery}
                  onChange={(e) => setLogSearchQuery(e.target.value)}
                  placeholder="Поиск в логе..."
                  className="bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1 text-xs text-white font-mono w-36 sm:w-44"
                />
                <select
                  value={selectedRunId || ''}
                  onChange={(e) => setSelectedRunId(Number(e.target.value))}
                  aria-label="Выбор запуска для просмотра лога"
                  className="bg-[#111622] border border-[#1e2638] rounded-lg px-2.5 py-1 text-xs font-mono text-slate-200"
                >
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      Запуск #{r.id} · {r.status} ({formatShortTime(r.started_at)})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setConsoleExpanded((v) => !v)}
                  className="p-1.5 text-slate-400 hover:text-white bg-[#111622] border border-[#1e2638] rounded-lg cursor-pointer"
                  title={consoleExpanded ? 'Свернуть консоль' : 'Развернуть консоль по высоте'}
                >
                  {consoleExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
          </div>

          {bottomConsoleTab === 'logs' && (
            <>
              <pre
                ref={logBoxRef}
                className={`p-4 text-xs font-mono text-slate-200 overflow-y-auto whitespace-pre-wrap leading-relaxed bg-[#070b14] transition-all ${
                  consoleExpanded ? 'h-[420px]' : 'h-56'
                }`}
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
                className="px-4 py-2.5 bg-[#0b0f17] border-t border-[#1e2638] flex items-center gap-2"
              >
                <span className="text-xs font-mono text-indigo-400 shrink-0">stdin (FIFO) &gt;</span>
                <input
                  type="text"
                  value={stdinInput}
                  onChange={(e) => setStdinInput(e.target.value)}
                  placeholder="Введите строку (2FA код, ответ на input() или команду) и нажмите Enter..."
                  className="flex-1 bg-transparent text-xs font-mono text-white focus:outline-none"
                />
                {stdinStatus && <span className="text-[11px] font-mono text-emerald-400">{stdinStatus}</span>}
                <button
                  type="submit"
                  className="px-3 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Send className="w-3 h-3" />
                  Отправить
                </button>
              </form>
            </>
          )}

          {bottomConsoleTab === 'kv' && (
            <div className="p-4 space-y-3 bg-[#070b14]">
              <form onSubmit={handleSaveKv} className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={newKvKey}
                  onChange={(e) => setNewKvKey(e.target.value)}
                  placeholder="Ключ (например: last_id или cursor)"
                  className="bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white flex-1 min-w-[180px]"
                />
                <input
                  type="text"
                  value={newKvVal}
                  onChange={(e) => setNewKvVal(e.target.value)}
                  placeholder="Значение (JSON или строка)"
                  className="bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white flex-1 min-w-[220px]"
                />
                <button
                  type="submit"
                  className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
                >
                  Сохранить в beacon.state
                </button>
                {kvStatus && <span className="text-xs font-mono text-emerald-400">{kvStatus}</span>}
              </form>

              {kvItems.length === 0 ? (
                <div className="text-xs text-slate-400 py-4 text-center font-mono">
                  Хранилище beacon.state для этого проекта пусто. Используйте в Python:{' '}
                  <code className="text-indigo-300">beacon.state.set(&quot;key&quot;, &quot;value&quot;)</code>
                </div>
              ) : (
                <div className="max-h-44 overflow-y-auto border border-[#1e2638] rounded-lg">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead>
                      <tr className="border-b border-[#1e2638] bg-[#111622] text-slate-400">
                        <th className="py-1.5 px-3">Ключ</th>
                        <th className="py-1.5 px-3">Значение</th>
                        <th className="py-1.5 px-3">Обновлено</th>
                        <th className="py-1.5 px-3 text-right">Действие</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2638]">
                      {kvItems.map((item) => (
                        <tr key={item.key} className="hover:bg-[#111622]/60">
                          <td className="py-1.5 px-3 text-indigo-300 font-semibold">{item.key}</td>
                          <td className="py-1.5 px-3 text-slate-200 break-all">
                            {typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}
                          </td>
                          <td className="py-1.5 px-3 text-slate-400">{formatShortTime(item.updated_at)}</td>
                          <td className="py-1.5 px-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteKv(item.key)}
                              className="text-rose-400 hover:text-rose-300 cursor-pointer"
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
            <div className="p-4 space-y-3 bg-[#070b14]">
              <form onSubmit={handleExecCommand} className="flex items-center gap-2">
                <span className="text-xs font-mono text-emerald-400 shrink-0">.venv $</span>
                <input
                  type="text"
                  value={cliCommand}
                  onChange={(e) => setCliCommand(e.target.value)}
                  placeholder="pip install ..., python3 -m ..., git status"
                  className="flex-1 bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                />
                <button
                  type="submit"
                  disabled={cliRunning}
                  className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  {cliRunning ? 'Выполнение...' : 'Выполнить'}
                </button>
              </form>
              <pre className="text-xs font-mono text-slate-300 max-h-40 overflow-y-auto whitespace-pre-wrap">
                {cliOutput || 'Введите команду выше для выполнения внутри изолированного окружения проекта.'}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
