import React, { useMemo, useState } from 'react';
import {
  Cpu,
  HardDrive,
  Activity,
  Play,
  Square,
  RotateCw,
  Clock,
  AlertCircle,
  Sparkles,
  FolderOpen,
  ShieldCheck,
  Search,
  Send,
  BatteryCharging,
  Thermometer,
  Wifi,
  Copy,
  Terminal,
  Cookie,
  Globe,
  ArrowDownLeft,
  ArrowUpRight,
  Network,
  ChevronDown,
  ChevronUp,
  Layers,
  FlaskConical,
  HelpCircle,
} from 'lucide-react';
import { DashboardData, ProjectItem, WorkspaceSubTab } from '../types/hub';
import {
  filterDashboardProjects,
  formatBytes,
  formatDurationSeconds,
  getRunStatusBadge,
  ProjectTypeFilter,
} from '../utils/hubLogic';

interface DashboardViewProps {
  data: DashboardData | null;
  userRole?: string;
  productionMode?: boolean;
  onToggleProductionMode?: (next: boolean) => void;
  onOpenSettingsTab?: () => void;
  onOpenAiAccessTab?: () => void;
  onStartProject: (id: number) => void;
  onStopProject: (id: number) => void;
  onRestartProject: (id: number) => void;
  onCloneProject: (id: number, newName: string) => void;
  onImportExamples: () => void;
  onOpenCommandPalette: () => void;
  onOpenProjectWorkspace: (project: ProjectItem, subTab?: WorkspaceSubTab) => void;
  onOpenCreateModal: () => void;
  onTriggerDemoAsk: () => void;
  onTriggerDemoExpiredCookie: () => void;
  onTestHubRestartSurvival: () => void;
  restartTestResult: string | null;
}

function formatRateKbps(kbps: number): string {
  if (!kbps || kbps < 0.05) return '0.0 КБ/с';
  if (kbps >= 1024) {
    return `${(kbps / 1024).toFixed(2)} МБ/с`;
  }
  return `${kbps.toFixed(1)} КБ/с`;
}

function formatTrafficMb(mb: number): string {
  if (!mb || mb <= 0) return '0 МБ';
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} ГБ`;
  }
  return `${mb.toFixed(1)} МБ`;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
  userRole = 'admin',
  productionMode = false,
  onToggleProductionMode,
  onOpenSettingsTab,
  onOpenAiAccessTab,
  onStartProject,
  onStopProject,
  onRestartProject,
  onCloneProject,
  onImportExamples,
  onOpenCommandPalette,
  onOpenProjectWorkspace,
  onOpenCreateModal,
  onTriggerDemoAsk,
  onTriggerDemoExpiredCookie,
  onTestHubRestartSurvival,
  restartTestResult,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ProjectTypeFilter>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [hideTests, setHideTests] = useState(false);
  const [cloningProjectId, setCloningProjectId] = useState<number | null>(null);
  const [cloneNameInput, setCloneNameInput] = useState('');
  const [activeLogTab, setActiveLogTab] = useState<'errors' | 'notifications' | 'schedule'>('errors');
  const [showSelfTestDrawer, setShowSelfTestDrawer] = useState(false);
  const [showDashboardHelp, setShowDashboardHelp] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('beacon_onboarding_dismissed') === '1';
    } catch {
      return false;
    }
  });

  const isViewer = userRole === 'viewer';
  const isAdmin = userRole === 'admin';
  const effectiveHideTests = hideTests || productionMode;

  const projects = data?.projects ?? [];

  const availableGroups = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) {
      const g = (p.group_tag || '').trim();
      if (g) set.add(g);
    }
    return Array.from(set).sort();
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const base = filterDashboardProjects(projects, searchQuery, typeFilter, effectiveHideTests);
    if (groupFilter === 'all') return base;
    return base.filter((p) => (p.group_tag || '').trim() === groupFilter);
  }, [projects, searchQuery, typeFilter, effectiveHideTests, groupFilter]);

  // Суммарное потребление ОЗУ и CPU всеми запущенными дочерними проектами
  const projectsWorkload = useMemo(() => {
    let totalRssMb = 0;
    let totalCpuPct = 0;
    let totalProcs = 0;
    let runningCount = 0;
    let crashCount = 0;
    for (const p of projects) {
      if (p.current_status === 'running' || p.current_status === 'waiting_input') {
        runningCount += 1;
        totalRssMb += Number(p.rss_mb || 0);
        totalCpuPct += Number(p.cpu_percent || 0);
        totalProcs += Number(p.proc_count || 1);
      } else if (p.current_status === 'failed' || p.current_status === 'crash_loop' || p.current_status === 'killed_oom') {
        crashCount += 1;
      }
    }
    return {
      runningCount,
      crashCount,
      totalRssMb: Math.round(totalRssMb * 10) / 10,
      totalCpuPct: Math.round(totalCpuPct * 10) / 10,
      totalProcs,
    };
  }, [projects]);

  if (!data) {
    return (
      <div className="p-8 text-center text-slate-400 font-mono text-sm">
        Загрузка телеметрии Beacon...
      </div>
    );
  }

  const { system, upcoming_runs, recent_errors, recent_notifications } = data;
  const hubRamOk = system.hub_rss_mb < system.hub_ram_budget_mb;
  const hw = system.hardware;
  const net = system.network;
  const netHistory = net?.history || [];
  const maxRateInHistory = Math.max(
    10,
    ...netHistory.map((h) => Math.max(h.rx_kbps || 0, h.tx_kbps || 0))
  );

  return (
    <div className="space-y-5">
      {/* Верхняя полоса контекста окружения + переключатель краткой справки */}
      {system.env_profile && (
        <div className="px-4 py-2.5 bg-slate-900/90 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="px-2 py-0.5 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-500/30 font-mono font-semibold">
              {system.env_profile.env_label}
            </span>
            <span className="text-slate-400 font-mono">
              Ядро: {system.env_profile.kernel} ({system.cpu_count || 1} ядер CPU)
            </span>
            {system.env_profile.has_uv && (
              <span className="px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-500/30 font-mono">
                uv ускоритель активен
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-slate-400">
            <span>
              Изоляция юзера: <strong className="text-slate-200">{system.run_as_user}</strong>
            </span>
            {onToggleProductionMode && (
              <label
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800/90 hover:bg-slate-700 text-slate-200 font-sans cursor-pointer select-none"
                title="Скрыть учебные демо-кнопки, тестовые проекты и вкладку Приёмки"
              >
                <input
                  type="checkbox"
                  checked={productionMode}
                  onChange={(e) => onToggleProductionMode(e.target.checked)}
                  className="rounded border-slate-600"
                />
                <span>Чистый режим (Prod)</span>
              </label>
            )}
            <button
              type="button"
              onClick={() => setShowDashboardHelp(!showDashboardHelp)}
              className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white inline-flex items-center gap-1 font-sans transition-colors cursor-pointer"
            >
              <HelpCircle className="w-3.5 h-3.5 text-indigo-400" />
              {showDashboardHelp ? 'Скрыть подсказки' : 'Справка по метрикам'}
            </button>
          </div>
        </div>
      )}

      {/* Мастер быстрого старта (Quick-Start Onboarding Checklist) для новых установок */}
      {!onboardingDismissed && !productionMode && (system.is_default_password || projects.length === 0) && (
        <div className="p-4 bg-[#111622] border border-indigo-500/40 rounded-xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <h3 className="text-xs sm:text-sm font-bold text-white">
                Быстрый старт Beacon: 3 шага к готовому серверу процессов
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setOnboardingDismissed(true);
                try {
                  localStorage.setItem('beacon_onboarding_dismissed', '1');
                } catch {
                  // ignore
                }
              }}
              className="text-xs text-slate-400 hover:text-white cursor-pointer"
            >
              Скрыть чеклист
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div
              className={`p-3 rounded-lg border flex flex-col justify-between gap-2 ${
                !system.is_default_password
                  ? 'bg-emerald-950/25 border-emerald-500/40 text-emerald-200'
                  : 'bg-[#0b0f17] border-amber-500/40 text-slate-200'
              }`}
            >
              <div>
                <div className="font-bold flex items-center justify-between">
                  <span>1. Защита панели паролем</span>
                  <span className="font-mono text-[10px] uppercase">
                    {!system.is_default_password ? 'Готово' : 'Требуется'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Смените стандартный пароль «admin» (от 8 символов), чтобы разблокировать удалённый доступ и MCP для ИИ.
                </p>
              </div>
              {system.is_default_password && onOpenSettingsTab && (
                <button
                  type="button"
                  onClick={onOpenSettingsTab}
                  className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs self-start cursor-pointer"
                >
                  Задать пароль
                </button>
              )}
            </div>

            <div
              className={`p-3 rounded-lg border flex flex-col justify-between gap-2 ${
                projects.length > 0
                  ? 'bg-emerald-950/25 border-emerald-500/40 text-emerald-200'
                  : 'bg-[#0b0f17] border-indigo-500/40 text-slate-200'
              }`}
            >
              <div>
                <div className="font-bold flex items-center justify-between">
                  <span>2. Первый сервис или API</span>
                  <span className="font-mono text-[10px] uppercase">
                    {projects.length > 0 ? `Проектов: ${projects.length}` : 'Шаг 2'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Создайте сервис из шаблона (FastAPI, Node.js, Worker 24/7, Cron) или склонируйте готовый репозиторий с GitHub.
                </p>
              </div>
              {!isViewer && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onOpenCreateModal}
                    className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs cursor-pointer"
                  >
                    + Создать проект
                  </button>
                  {projects.length === 0 && (
                    <button
                      type="button"
                      onClick={onImportExamples}
                      className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs cursor-pointer"
                    >
                      Демо-примеры
                    </button>
                  )}
                </div>
              )}
            </div>

            <div
              className={`p-3 rounded-lg border flex flex-col justify-between gap-2 ${
                system.ai_access_enabled
                  ? 'bg-emerald-950/25 border-emerald-500/40 text-emerald-200'
                  : 'bg-[#0b0f17] border-slate-800 text-slate-200'
              }`}
            >
              <div>
                <div className="font-bold flex items-center justify-between">
                  <span>3. ИИ-напарник (MCP) и Алерты</span>
                  <span className="font-mono text-[10px] uppercase">
                    {system.ai_access_enabled ? 'MCP Активен' : 'Опционально'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Подключите Claude Code / Cursor по Streamable HTTP MCP с проверкой diff или настройте Telegram-уведомления.
                </p>
              </div>
              {isAdmin && onOpenAiAccessTab && (
                <button
                  type="button"
                  onClick={onOpenAiAccessTab}
                  className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 font-semibold text-xs self-start cursor-pointer"
                >
                  Настроить MCP / ИИ
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Сворачиваемый справочный блок (отделён от рабочих данных и логов) */}
      {showDashboardHelp && (
        <div className="p-4 bg-indigo-950/25 border border-indigo-500/30 rounded-xl grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3 bg-[#0f172a]/80 border border-slate-800 rounded-lg space-y-1">
            <div className="font-semibold text-indigo-300">Как считается ОЗУ и CPU</div>
            <p className="text-slate-300 leading-relaxed">
              Панель отдельно контролирует собственный процесс Beacon (лимит &lt; 80 МБ) и суммирует физическую память (RSS) каждой группы процессов проекта по её <code className="font-mono text-indigo-200">PGID</code>.
            </p>
          </div>
          <div className="p-3 bg-[#0f172a]/80 border border-slate-800 rounded-lg space-y-1">
            <div className="font-semibold text-emerald-300">Откуда берётся сетевая статистика</div>
            <p className="text-slate-300 leading-relaxed">
              Счётчики входящего (<code className="font-mono text-emerald-200">RX</code>) и исходящего (<code className="font-mono text-indigo-200">TX</code>) трафика снимаются напрямую из ядра Linux (<code className="font-mono">/proc/net/dev</code> и <code className="font-mono">/proc/net/tcp</code>) каждые 2 секунды без накладных расходов.
            </p>
          </div>
          <div className="p-3 bg-[#0f172a]/80 border border-slate-800 rounded-lg space-y-1">
            <div className="font-semibold text-amber-300">Быстрые действия с проектами</div>
            <p className="text-slate-300 leading-relaxed">
              Кликните по имени любого проекта в таблице ниже, чтобы открыть полноценную IDE, редактор кода, живой терминал и превью веб-сервиса.
            </p>
          </div>
        </div>
      )}

      {/* БЛОК 1: Карточки системных ресурсов (CPU, RAM, Бюджет Beacon, Диск) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* CPU */}
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Процессор ({system.cpu_count || 1} ядер)
            </span>
            <Cpu className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <div className="text-2xl font-bold font-mono text-white">
                {system.cpu_percent.toFixed(1)}%
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                Проекты: {projectsWorkload.totalCpuPct}% ({projectsWorkload.totalProcs} проц.)
              </span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full mt-2 overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all duration-300"
                style={{ width: `${Math.min(100, system.cpu_percent)}%` }}
              />
            </div>
          </div>
        </div>

        {/* ОЗУ */}
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              ОЗУ системы
            </span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-white">
              {system.ram_used_mb.toFixed(0)}{' '}
              <span className="text-xs font-normal text-slate-400">
                / {system.ram_total_mb.toFixed(0)} МБ ({system.ram_percent.toFixed(0)}%)
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-mono mt-0.5 flex items-center justify-between">
              <span>Свободно: {system.ram_available_mb.toFixed(0)} МБ</span>
              <span className="text-indigo-300">Проекты: {projectsWorkload.totalRssMb} МБ</span>
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${Math.min(100, system.ram_percent)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Бюджет ОЗУ самого Beacon */}
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Процесс Beacon (PID {system.hub_pid})
            </span>
            <ShieldCheck className={`w-4 h-4 ${hubRamOk ? 'text-emerald-400' : 'text-red-400'}`} />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-bold font-mono ${hubRamOk ? 'text-emerald-400' : 'text-red-400'}`}>
                {system.hub_rss_mb} МБ
              </span>
              <span className="text-xs font-mono text-slate-400">
                / лимит {system.hub_ram_budget_mb} МБ
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
              <span>Статус бюджета ОЗУ: {hubRamOk ? 'В норме' : 'Превышен'}</span>
              <span className="text-emerald-300 font-mono">Активно: {projectsWorkload.runningCount}</span>
            </div>
          </div>
        </div>

        {/* Свободное место на диске */}
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Хранилище и SQLite WAL
            </span>
            <HardDrive
              className={`w-4 h-4 ${
                system.disk.state === 'ok'
                  ? 'text-sky-400'
                  : system.disk.state === 'warning'
                  ? 'text-amber-400'
                  : 'text-red-400'
              }`}
            />
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-white">
              {(system.disk.free_mb / 1024).toFixed(2)} ГБ{' '}
              <span className="text-xs font-normal text-slate-400">свободно</span>
            </div>
            <div className="text-[11px] font-mono text-slate-400 mt-1 flex items-center justify-between">
              <span>Занято: {system.disk.percent}%</span>
              <span>WAL: {system.disk.wal_size_kb ?? 0} КБ</span>
            </div>
          </div>
        </div>
      </div>

      {/* БЛОК 2: СЕТЕВАЯ СТАТИСТИКА И НАГРУЗКА В РЕАЛЬНОМ ВРЕМЕНИ */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <Network className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                Сетевая статистика и нагрузка трафика
                <span className="px-2 py-0.5 text-[10px] font-mono bg-emerald-950/70 text-emerald-300 border border-emerald-500/30 rounded">
                  LIVE 2c
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Скорость приёма/отдачи по интерфейсам ядра, открытые TCP-соединения и порты запущенных веб-проектов
              </p>
            </div>
          </div>

          {/* Статус глобального прокси */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <span
              className={`px-2.5 py-1 rounded-lg border inline-flex items-center gap-1.5 ${
                !system.proxy_url
                  ? 'bg-slate-900/70 border-slate-800 text-slate-400'
                  : system.proxy_status?.online
                  ? 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300'
                  : 'bg-red-950/50 border-red-500/30 text-red-300'
              }`}
            >
              <Wifi className="w-3.5 h-3.5" />
              {!system.proxy_url
                ? 'Прокси: выкл (прямой канал)'
                : system.proxy_status?.online
                ? `Прокси ONLINE (${system.proxy_status.latency_ms} мс)`
                : `Прокси OFFLINE (${system.proxy_url})`}
            </span>
          </div>
        </div>

        {/* 4 ключевых показателя сети + живой график нагрузки */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          {/* Метрики RX / TX / TCP / Порты */}
          <div className="lg:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Входящий поток RX */}
            <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Приём (RX)</span>
                <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="my-1.5">
                <div className="text-base sm:text-lg font-bold font-mono text-emerald-400">
                  {formatRateKbps(net?.rx_kbps || 0)}
                </div>
                <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                  Всего: {formatTrafficMb(net?.rx_mb || 0)}
                </div>
              </div>
              <div className="text-[10px] font-mono text-slate-400">
                Пакетов: {(net?.rx_packets || 0).toLocaleString('ru-RU')}
              </div>
            </div>

            {/* Исходящий поток TX */}
            <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Отдача (TX)</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-indigo-400" />
              </div>
              <div className="my-1.5">
                <div className="text-base sm:text-lg font-bold font-mono text-indigo-300">
                  {formatRateKbps(net?.tx_kbps || 0)}
                </div>
                <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                  Всего: {formatTrafficMb(net?.tx_mb || 0)}
                </div>
              </div>
              <div className="text-[10px] font-mono text-slate-400">
                Пакетов: {(net?.tx_packets || 0).toLocaleString('ru-RU')}
              </div>
            </div>

            {/* Активные TCP-сокеты */}
            <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Соединения TCP</span>
                <Activity className="w-3.5 h-3.5 text-sky-400" />
              </div>
              <div className="my-1.5">
                <div className="text-base sm:text-lg font-bold font-mono text-white">
                  {net?.tcp_established ?? 0}{' '}
                  <span className="text-[11px] font-normal text-slate-400">актив.</span>
                </div>
                <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                  Слушают (LISTEN): {net?.tcp_listen ?? 0}
                </div>
              </div>
              <div className="text-[10px] font-mono text-sky-300">
                /proc/net/tcp + tcp6
              </div>
            </div>

            {/* Веб-порты проектов */}
            <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl flex flex-col justify-between">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Веб-порты (Web)</span>
                <Globe className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="my-1.5">
                <div className="text-base sm:text-lg font-bold font-mono text-white">
                  {(net?.active_web_ports || []).filter((w) => w.status === 'running').length}{' '}
                  <span className="text-[11px] font-normal text-slate-400">
                    / {(net?.active_web_ports || []).length}
                  </span>
                </div>
                <div className="text-[11px] font-mono text-slate-400 mt-0.5 truncate">
                  {(net?.active_web_ports || []).length > 0
                    ? (net?.active_web_ports || []).map((w) => `:${w.port}`).join(', ')
                    : 'Нет веб-проектов'}
                </div>
              </div>
              <div className="text-[10px] font-mono text-purple-300">
                Панель: :{window.location.port || '8765'}
              </div>
            </div>
          </div>

          {/* Живая гистограмма сетевой нагрузки (последние замеры) + список интерфейсов */}
          <div className="lg:col-span-5 p-3 bg-[#0f172a] border border-slate-800 rounded-xl flex flex-col justify-between gap-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-300 font-medium">
                Динамика сетевого потока (RX / TX)
              </span>
              <span className="font-mono text-slate-400">
                Пик: {formatRateKbps(maxRateInHistory)}
              </span>
            </div>

            {/* Полоски истории трафика */}
            <div className="h-12 flex items-end gap-1 pt-2 border-b border-slate-800/80">
              {(netHistory.length > 0 ? netHistory : [{ ts: 0, rx_kbps: 0, tx_kbps: 0 }]).map((pt, idx) => {
                const totalPt = (pt.rx_kbps || 0) + (pt.tx_kbps || 0);
                const heightPct = Math.max(10, Math.min(100, Math.round((totalPt / maxRateInHistory) * 100)));
                return (
                  <div
                    key={`${pt.ts}-${idx}`}
                    title={`RX: ${formatRateKbps(pt.rx_kbps)} | TX: ${formatRateKbps(pt.tx_kbps)}`}
                    className="flex-1 bg-slate-800/70 rounded-t overflow-hidden flex flex-col justify-end h-full"
                  >
                    <div
                      className="w-full bg-gradient-to-t from-emerald-500 to-indigo-400 transition-all duration-300 rounded-t"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>

            {/* Сетевые интерфейсы */}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
              {(net?.interfaces || []).length === 0 ? (
                <span className="text-slate-400">Интерфейсы: lo (локальный контур)</span>
              ) : (
                (net?.interfaces || []).map((ifc) => (
                  <span
                    key={ifc.name}
                    className={`px-2 py-0.5 rounded border inline-flex items-center gap-1.5 ${
                      ifc.is_tunnel
                        ? 'bg-indigo-950/60 border-indigo-500/40 text-indigo-200'
                        : 'bg-slate-900 border-slate-800 text-slate-300'
                    }`}
                  >
                    <strong className="text-white">{ifc.name}</strong>
                    {ifc.is_tunnel && <span className="text-[9px] uppercase text-indigo-400">VPN</span>}
                    <span className="text-emerald-400">↓{formatTrafficMb(ifc.rx_mb)}</span>
                    <span className="text-indigo-300">↑{formatTrafficMb(ifc.tx_mb)}</span>
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Аппаратный виджет (показывается компактно только если есть реальные датчики температуры или батареи) */}
      {hw && hw.available !== false && (hw.battery_percent !== null || hw.cpu_temp_c !== null) && (
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5">
            <BatteryCharging
              className={`w-4 h-4 ${hw.should_alert ? 'text-red-400 animate-pulse' : 'text-emerald-400'}`}
            />
            <span className="font-semibold text-white">Датчики питания и температуры ({hw.device_model}):</span>
            {hw.battery_percent !== null && (
              <span className="font-mono text-emerald-300">
                Заряд: {hw.battery_percent}% ({hw.power_plugged ? 'AC подключён' : 'От батареи'})
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 font-mono text-slate-300">
            {hw.cpu_temp_c !== null && (
              <span className="inline-flex items-center gap-1">
                <Thermometer className="w-3.5 h-3.5 text-amber-400" />
                CPU: {hw.cpu_temp_c}°C
              </span>
            )}
            {hw.uptime_human && <span>Uptime ОС: {hw.uptime_human}</span>}
          </div>
        </div>
      )}

      {/* БЛОК 3: Реестр проектов с чистой панелью фильтрации */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-white">
              Проекты на сервере ({filteredProjects.length} из {projects.length})
            </h2>
            {projectsWorkload.runningCount > 0 && (
              <span className="px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono">
                Работают: {projectsWorkload.runningCount}
              </span>
            )}
            {projectsWorkload.crashCount > 0 && (
              <span className="px-2 py-0.5 rounded bg-red-950/70 text-red-300 border border-red-500/30 text-[11px] font-mono">
                Требуют внимания: {projectsWorkload.crashCount}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Поиск */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск проекта..."
                className="bg-[#0f172a] border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-44 sm:w-52"
              />
            </div>

            {/* Фильтр типа */}
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as ProjectTypeFilter)}
              aria-label="Фильтр по типу проекта"
              className="bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
            >
              <option value="all">Все типы</option>
              <option value="service">Services (Демоны)</option>
              <option value="web">Web / HTTP API</option>
              <option value="job">Jobs (По расписанию)</option>
            </select>

            {availableGroups.length > 0 && (
              <select
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
                aria-label="Фильтр по группе"
                className="bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
              >
                <option value="all">Все группы</option>
                {availableGroups.map((g) => (
                  <option key={g} value={g}>
                    Группа: {g}
                  </option>
                ))}
              </select>
            )}

            {!productionMode && (
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none px-2 py-1 bg-[#0f172a] border border-slate-800 rounded-lg">
                <input
                  type="checkbox"
                  checked={hideTests}
                  onChange={(e) => setHideTests(e.target.checked)}
                  className="rounded border-slate-700"
                />
                Скрыть примеры
              </label>
            )}

            {!productionMode && !isViewer && (
              <button
                type="button"
                onClick={onImportExamples}
                className="px-2.5 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                Загрузить 4 примера
              </button>
            )}
          </div>
        </div>

        {/* Таблица проектов */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-900/50">
                <th className="py-3 px-4">Проект</th>
                <th className="py-3 px-3">Тип / Порт</th>
                <th className="py-3 px-3">Статус</th>
                <th className="py-3 px-3">PID / PGID</th>
                <th className="py-3 px-3">Нагрузка (RSS / CPU)</th>
                <th className="py-3 px-3">Куки / Расписание</th>
                <th className="py-3 px-3">Диск</th>
                <th className="py-3 px-4 text-right">Управление</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-sm">
              {filteredProjects.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-400 text-xs">
                    Проекты не найдены. Нажмите «Новый проект» в шапке или «Загрузить 4 примера».
                  </td>
                </tr>
              ) : (
                filteredProjects.map((proj) => {
                  const badge = getRunStatusBadge(proj.current_status);
                  const isRunning = proj.current_status === 'running' || proj.current_status === 'waiting_input';
                  const cookieSt = proj.cookie_status;
                  const isCloning = cloningProjectId === proj.id;

                  return (
                    <tr key={proj.id} className="hover:bg-slate-800/35 transition-colors">
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenProjectWorkspace(proj, 'editor')}
                            className="font-mono font-semibold text-white hover:text-indigo-400 text-left cursor-pointer"
                          >
                            {proj.name}
                          </button>
                          {proj.group_tag && (
                            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-indigo-950/80 text-indigo-300 border border-indigo-500/30 rounded">
                              {proj.group_tag}
                            </span>
                          )}
                          {proj.is_test_project && (
                            <span className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-800 text-slate-400 rounded">
                              пример
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 truncate max-w-xs">
                          {proj.description || proj.cmd}
                        </div>

                        {isCloning && (
                          <div className="mt-2 flex items-center gap-1.5">
                            <input
                              type="text"
                              value={cloneNameInput}
                              onChange={(e) => setCloneNameInput(e.target.value)}
                              placeholder="Имя копии..."
                              className="bg-[#0f172a] border border-indigo-500/60 rounded px-2 py-1 text-xs font-mono text-white w-36"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                if (cloneNameInput.trim()) {
                                  onCloneProject(proj.id, cloneNameInput.trim());
                                  setCloningProjectId(null);
                                }
                              }}
                              className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded cursor-pointer"
                            >
                              ОК
                            </button>
                            <button
                              type="button"
                              onClick={() => setCloningProjectId(null)}
                              className="px-2 py-1 text-xs bg-slate-800 text-slate-300 rounded cursor-pointer"
                            >
                              Отмена
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-3 font-mono text-xs">
                        <span
                          className={`px-2 py-0.5 rounded font-medium ${
                            proj.type === 'service'
                              ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30'
                              : proj.type === 'web'
                              ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                              : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                          }`}
                        >
                          {proj.type}
                        </span>
                        {(proj.port ?? 0) > 0 && (
                          <span className="ml-1.5 text-sky-300">:{proj.port}</span>
                        )}
                      </td>

                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono border ${badge.colorClass}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${badge.dotClass}`} />
                          {badge.label}
                        </span>
                      </td>

                      <td className="py-3 px-3 font-mono text-xs text-slate-300">
                        {proj.pid ? (
                          <div>
                            <span>
                              {proj.pid} <span className="text-slate-400">/ {proj.pgid}</span>
                            </span>
                            {(proj.proc_count || 1) > 1 && (
                              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-indigo-950/80 text-indigo-300 rounded">
                                {proj.proc_count} проц.
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>

                      <td className="py-3 px-3 font-mono text-xs">
                        {isRunning ? (
                          <div>
                            <div className="text-emerald-300">
                              {proj.rss_mb} / {proj.ram_limit_mb} МБ
                            </div>
                            <div className="text-[11px] text-slate-400">CPU: {proj.cpu_percent}%</div>
                          </div>
                        ) : (
                          <span className="text-slate-400">Лимит {proj.ram_limit_mb} МБ</span>
                        )}
                      </td>

                      <td className="py-3 px-3 font-mono text-xs text-slate-300">
                        <div className="space-y-1">
                          {cookieSt && cookieSt.has_cookies ? (
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ${
                                cookieSt.is_expired === 1
                                  ? 'bg-red-950/80 text-red-300 border border-red-500/40'
                                  : 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30'
                              }`}
                            >
                              <Cookie className="w-3 h-3" />
                              {cookieSt.is_expired === 1 ? 'Куки истекли' : 'Куки ОК'}
                            </span>
                          ) : null}
                          <div className="text-[11px] text-slate-400">
                            {proj.type === 'service' || proj.type === 'web'
                              ? `restart=${proj.restart_policy}`
                              : `${proj.schedule_type}: ${proj.schedule_expr || 'вручную'}`}
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-3 font-mono text-xs text-slate-300">
                        <div>{formatBytes(proj.total_size_bytes)}</div>
                        <div className="text-[11px] text-slate-400">
                          логи: {formatBytes(proj.logs_size_bytes)}
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {!isViewer && (
                            <>
                              {!isRunning ? (
                                <button
                                  type="button"
                                  onClick={() => onStartProject(proj.id)}
                                  title="Запустить"
                                  className="p-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-500/30 cursor-pointer"
                                >
                                  <Play className="w-3.5 h-3.5" />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onStopProject(proj.id)}
                                  title="Остановить группу процессов (PGID)"
                                  className="p-1.5 rounded-lg bg-red-600/20 text-red-300 hover:bg-red-600/30 border border-red-500/30 cursor-pointer"
                                >
                                  <Square className="w-3.5 h-3.5" />
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => onRestartProject(proj.id)}
                                title="Перезапустить"
                                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>

                              {isAdmin && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCloningProjectId(proj.id);
                                    setCloneNameInput(`${proj.name}-copy`);
                                  }}
                                  title="Клонировать проект"
                                  className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
                          )}

                          <button
                            type="button"
                            onClick={() => onOpenProjectWorkspace(proj, 'editor')}
                            title="Открыть IDE, файлы и терминал"
                            className="px-2.5 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/30 text-xs font-medium inline-flex items-center gap-1 cursor-pointer"
                          >
                            <FolderOpen className="w-3.5 h-3.5" />
                            Открыть
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* БЛОК 4: ЖУРНАЛ ОПЕРАЦИОННЫХ СОБЫТИЙ, СБОЕВ И РАСПИСАНИЯ (чётко отделён от подсказок) */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-900/60">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-white">
              Операционный журнал сервера
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActiveLogTab('errors')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer ${
                activeLogTab === 'errors'
                  ? 'bg-red-500/20 text-red-200 border border-red-500/40'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <AlertCircle className="w-3.5 h-3.5 text-red-400" />
              Сбои и OOM ({recent_errors.length})
            </button>

            <button
              type="button"
              onClick={() => setActiveLogTab('notifications')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer ${
                activeLogTab === 'notifications'
                  ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <Send className="w-3.5 h-3.5 text-emerald-400" />
              Уведомления ТГ ({(recent_notifications || []).length})
            </button>

            <button
              type="button"
              onClick={() => setActiveLogTab('schedule')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer ${
                activeLogTab === 'schedule'
                  ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/40'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-indigo-400" />
              Очередь Cron ({upcoming_runs.length})
            </button>
          </div>
        </div>

        <div className="p-4 bg-[#0b0f17]">
          {activeLogTab === 'errors' && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {recent_errors.length === 0 ? (
                <div className="text-xs font-mono text-slate-400 py-4 text-center">
                  Аварийных завершений (failed / timeout / killed_oom / crash_loop) не зафиксировано.
                </div>
              ) : (
                recent_errors.map((err) => {
                  const badge = getRunStatusBadge(err.status);
                  return (
                    <div
                      key={err.id}
                      className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-semibold">{err.project_name}</span>
                          <span className={`px-2 py-0.5 rounded text-[10px] border ${badge.colorClass}`}>
                            {badge.label} (код: {err.exit_code ?? '—'})
                          </span>
                        </div>
                        {err.error_summary && (
                          <div className="text-red-300 break-all">{err.error_summary}</div>
                        )}
                      </div>
                      <span className="text-slate-400 shrink-0">
                        {new Date(err.started_at * 1000).toLocaleTimeString('ru-RU')}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {activeLogTab === 'notifications' && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {!recent_notifications || recent_notifications.length === 0 ? (
                <div className="text-xs font-mono text-slate-400 py-4 text-center">
                  Журнал исходящих уведомлений пуст.
                </div>
              ) : (
                recent_notifications.map((n, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg bg-slate-900/90 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${
                            n.level === 'error'
                              ? 'bg-red-500/20 text-red-300'
                              : n.level === 'warn' || n.level === 'warning'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-indigo-500/20 text-indigo-300'
                          }`}
                        >
                          {n.level}
                        </span>
                        <span className="text-slate-300">{n.detail}</span>
                      </div>
                      <div className="text-slate-200 break-words">{n.text}</div>
                    </div>
                    <span className="text-slate-400 shrink-0">
                      {new Date(n.timestamp * 1000).toLocaleTimeString('ru-RU')}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}

          {activeLogTab === 'schedule' && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {upcoming_runs.length === 0 ? (
                <div className="text-xs font-mono text-slate-400 py-4 text-center">
                  Нет активных периодических задач (Cron / интервал / ежедневно).
                </div>
              ) : (
                upcoming_runs.map((item) => (
                  <div
                    key={item.project_id}
                    className="flex items-center justify-between p-3 rounded-lg bg-slate-900/90 border border-slate-800 text-xs font-mono"
                  >
                    <div>
                      <span className="text-white font-semibold">{item.project_name}</span>
                      <span className="ml-2 text-slate-400">
                        ({item.schedule_type}: {item.schedule_expr})
                      </span>
                    </div>
                    <span className="text-indigo-300">
                      через {formatDurationSeconds(item.in_seconds)}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Сворачиваемая панель быстрых самопроверок (скрывается в Чистом Production-режиме или для роли viewer) */}
      {!productionMode && !isViewer && (
        <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-900/40">
          <button
            type="button"
            onClick={() => setShowSelfTestDrawer(!showSelfTestDrawer)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <span className="flex items-center gap-2 font-medium">
              <FlaskConical className="w-3.5 h-3.5 text-indigo-400" />
              Инструменты быстрой самопроверки SDK и живучести процессов (2FA ask, протухшие куки, тест без SIGPIPE)
            </span>
            {showSelfTestDrawer ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showSelfTestDrawer && (
            <div className="p-4 border-t border-slate-800 bg-[#0f172a]/80 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onTriggerDemoAsk}
                  className="px-3 py-1.5 text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 rounded-lg cursor-pointer"
                >
                  Симулировать запрос 2FA (beacon.ask)
                </button>
                <button
                  type="button"
                  onClick={onTriggerDemoExpiredCookie}
                  className="px-3 py-1.5 text-xs font-medium bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 rounded-lg cursor-pointer"
                >
                  Симулировать протухание кук (beacon.cookies_expired)
                </button>
                <button
                  type="button"
                  onClick={onTestHubRestartSurvival}
                  className="px-3 py-1.5 text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 rounded-lg cursor-pointer"
                >
                  Проверить выживание сервисов при рестарте (без SIGPIPE)
                </button>
              </div>

              {restartTestResult && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-500/40 rounded-lg text-xs font-mono text-emerald-200">
                  {restartTestResult}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
