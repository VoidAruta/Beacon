import React, { useState } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Plus,
  Cpu,
  HardDrive,
  Activity,
  Clock,
  AlertCircle,
  Send,
  KeyRound,
  Cookie,
  RefreshCw,
  Bot,
  FolderOpen,
  BatteryCharging,
  CopyPlus,
  Search,
  Server,
  Download,
  Terminal,
} from 'lucide-react';
import { DashboardData, ProjectItem } from '../types/hub';
import { describeScheduleHuman, formatBytes, formatDurationSec } from '../utils/hubLogic';

interface DashboardViewProps {
  data: DashboardData | null;
  onStartProject: (id: number) => Promise<void>;
  onStopProject: (id: number) => Promise<void>;
  onRestartProject: (id: number) => Promise<void>;
  onCloneProject?: (id: number) => Promise<void>;
  onImportExamples?: () => Promise<void>;
  onOpenCommandPalette?: () => void;
  onOpenProjectWorkspace: (
    project: ProjectItem,
    initialSubTab?: 'editor' | 'cookies_tg' | 'terminal_git' | 'simple_cfg' | 'advanced_cfg'
  ) => void;
  onOpenCreateModal: () => void;
  onTriggerDemoAsk: () => Promise<void>;
  onTriggerDemoExpiredCookie: () => Promise<void>;
  onTestHubRestartSurvival: () => Promise<void>;
  restartTestResult: {
    old_hub_pid: number;
    new_hub_pid: number;
    survived_without_sigpipe: boolean;
    running_after: Array<{ name: string; pid: number }>;
  } | null;
}

type ProjectFilter = 'all' | 'service' | 'web' | 'job';

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
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
  const [busyProjectId, setBusyProjectId] = useState<number | null>(null);
  const [testingRestart, setTestingRestart] = useState(false);
  const [importingExamples, setImportingExamples] = useState(false);
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  if (!data) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-24 bg-[#111622] border border-slate-800 rounded-xl animate-pulse" />
        <div className="h-64 bg-[#111622] border border-slate-800 rounded-xl animate-pulse" />
      </div>
    );
  }

  const { system, projects, upcoming_runs, recent_errors, recent_notifications, env_profile } = data;
  const runningCount = projects.filter(
    (p) => p.current_status === 'running' || p.current_status === 'waiting_input'
  ).length;
  const servicesCount = projects.filter((p) => p.type === 'service').length;
  const webCount = projects.filter((p) => p.type === 'web').length;
  const jobsCount = projects.filter((p) => p.type === 'job').length;
  const totalProjectsBytes = projects.reduce((acc, p) => acc + (p.total_size_bytes || 0), 0);

  const filteredProjects = projects.filter((p) => {
    if (filter === 'service' && p.type !== 'service') return false;
    if (filter === 'web' && p.type !== 'web') return false;
    if (filter === 'job' && p.type !== 'job') return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = p.name.toLowerCase().includes(q);
      const matchDesc = (p.description || '').toLowerCase().includes(q);
      const matchGroup = (p.group_tag || '').toLowerCase().includes(q);
      const matchPort = p.port ? String(p.port).includes(q) : false;
      return matchName || matchDesc || matchGroup || matchPort;
    }
    return true;
  });

  const handleAction = async (id: number, fn: (pid: number) => Promise<void>) => {
    setBusyProjectId(id);
    try {
      await fn(id);
    } finally {
      setBusyProjectId(null);
    }
  };

  const handleHubRestartTest = async () => {
    setTestingRestart(true);
    try {
      await onTestHubRestartSurvival();
    } finally {
      setTestingRestart(false);
    }
  };

  const handleImportExamplesClick = async () => {
    if (!onImportExamples) return;
    setImportingExamples(true);
    try {
      await onImportExamples();
    } finally {
      setImportingExamples(false);
    }
  };

  const renderStatusText = (p: ProjectItem) => {
    switch (p.current_status) {
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 text-emerald-400 font-semibold text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            running
          </span>
        );
      case 'waiting_input':
        return (
          <span className="inline-flex items-center gap-1.5 text-amber-400 font-semibold text-xs">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            waiting_input (hub.ask)
          </span>
        );
      case 'success':
        return <span className="text-indigo-300 font-medium text-xs">success (0)</span>;
      case 'failed':
        return <span className="text-rose-400 font-medium text-xs">failed</span>;
      case 'timeout':
        return <span className="text-amber-400 font-medium text-xs">timeout</span>;
      case 'killed_oom':
        return <span className="text-rose-400 font-semibold text-xs">killed_oom (RAM limit)</span>;
      default:
        return <span className="text-slate-400 text-xs">stopped</span>;
    }
  };

  const hasRealAndroidBattery = Boolean(system.hardware?.available && system.hardware.battery_percent !== null);

  return (
    <div className="space-y-6">
      {/* 1. Адаптивная сводка телеметрии и профиля среды */}
      <section aria-label="Метрики устройства и процесса Hub" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111622] border border-slate-800/90 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Память супервизора Hub</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono tabular-nums" data-testid="hub-rss-mb">
              {system.hub_rss_mb} МБ
            </span>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              / {system.hub_ram_budget_mb} МБ лимит
            </span>
          </div>
          <div className="mt-2 w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full ${system.hub_rss_mb < 80 ? 'bg-emerald-500' : 'bg-rose-500'}`}
              style={{ width: `${Math.min(100, (system.hub_rss_mb / 80) * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400 font-mono tabular-nums">
            <span>PID {system.hub_pid}</span>
            <span aria-hidden="true">·</span>
            <span>WAL {system.disk.wal_size_kb ?? 0} КБ</span>
            <span aria-hidden="true">·</span>
            <span>Активно: {runningCount}/{projects.length}</span>
          </div>
        </div>

        <div className="bg-[#111622] border border-slate-800/90 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Процессор и ОЗУ хоста</span>
            <Cpu className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono tabular-nums whitespace-nowrap">
              {system.cpu_percent}% CPU
            </span>
            <span className="text-xs text-slate-400 font-mono tabular-nums whitespace-nowrap truncate">
              · своб. {Math.round(system.ram_available_mb)} МБ
            </span>
          </div>
          <div className="mt-2 w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, system.ram_percent)}%` }} />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400 font-mono tabular-nums truncate">
            <span>ОЗУ {Math.round(system.ram_used_mb)}/{Math.round(system.ram_total_mb)} МБ</span>
            <span aria-hidden="true">·</span>
            <span>Swap {system.hardware?.swap_used_mb ?? 0}/{system.hardware?.swap_total_mb ?? 0} МБ</span>
          </div>
        </div>

        <div className="bg-[#111622] border border-slate-800/90 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Файловая система и проекты</span>
            <HardDrive className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono tabular-nums">
              {system.disk.free_mb} МБ
            </span>
            <span className="text-xs text-slate-400">свободно</span>
          </div>
          <div className="mt-2 w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full ${
                system.disk.state === 'critical'
                  ? 'bg-rose-500'
                  : system.disk.state === 'warning'
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, system.disk.percent)}%` }}
            />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400 font-mono tabular-nums">
            <span>Проекты + логи: {formatBytes(totalProjectsBytes)}</span>
            <span aria-hidden="true">·</span>
            <span>Занято {system.disk.percent}%</span>
          </div>
        </div>

        {/* 4-я карточка адаптируется под среду: Android sysfs батарея vs Linux Host / Container профиль */}
        <div className="bg-[#111622] border border-slate-800/90 rounded-xl p-4">
          {hasRealAndroidBattery ? (
            <>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{system.hardware?.device_model || 'Android Chroot'} · Питание</span>
                <BatteryCharging className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold text-white font-mono tabular-nums">
                  {system.hardware?.battery_percent}%
                </span>
                <span className="text-xs font-mono text-slate-300 tabular-nums">
                  {system.hardware?.battery_temp_c !== null ? `· ${system.hardware?.battery_temp_c}°C` : ''}
                  {system.hardware?.voltage_mv ? ` · ${system.hardware?.voltage_mv} мВ` : ''}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-300 truncate">{system.hardware?.cycle_label}</p>
              <div className="mt-1 text-[11px] text-slate-400 font-mono flex items-center justify-between">
                <span>Прокси 10808: {system.proxy_status?.online ? 'Онлайн' : 'Оффлайн'}</span>
                <span>Аптайм: {system.hardware?.uptime_human}</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Профиль среды выполнения</span>
                <Server className="w-4 h-4 text-cyan-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-lg font-bold text-white truncate">
                  {env_profile?.env_label || 'Linux Host / Container'}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-300 font-mono">
                <span>{env_profile?.arch || 'x86_64'}</span>
                <span aria-hidden="true">·</span>
                <span>{env_profile?.has_uv ? 'uv: активен' : 'venv: stdlib'}</span>
                <span aria-hidden="true">·</span>
                <span>{env_profile?.has_systemd ? 'systemd' : 'no-systemd'}</span>
              </div>
              <div className="mt-1.5 text-[11px] text-slate-400 font-mono flex items-center justify-between">
                <span>Прокси 10808: {system.proxy_status?.online ? 'Онлайн' : 'Ожидание'}</span>
                <span>АКБ: N/A</span>
              </div>
            </>
          )}
        </div>
      </section>

      {/* 2. Реестр проектов (Service 24/7 / Web API / Job) */}
      <section className="bg-[#111622] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-800 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white">Реестр управляемых процессов (Containerless PaaS)</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Изолированные рабочие каталоги (<code className="font-mono text-slate-300">.venv</code>,{' '}
                <code className="font-mono text-slate-300">.tmp</code>, <code className="font-mono text-slate-300">.home</code>),
                контроль дерева процессов по <code className="font-mono text-slate-300">PGID</code> и{' '}
                <code className="font-mono text-slate-300">_HUB_PROJECT_ID</code>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
              {onOpenCommandPalette && (
                <button
                  type="button"
                  onClick={onOpenCommandPalette}
                  className="px-3 py-2 text-xs font-mono text-slate-300 hover:text-white bg-[#0b0f17] border border-slate-800 hover:border-slate-700 rounded-lg transition-colors inline-flex items-center gap-2 cursor-pointer"
                >
                  <Search className="w-3.5 h-3.5 text-slate-400" />
                  <span>Быстрый переход</span>
                  <kbd className="text-[10px] text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                    Ctrl+K
                  </kbd>
                </button>
              )}

              {onImportExamples && (
                <button
                  type="button"
                  disabled={importingExamples}
                  onClick={handleImportExamplesClick}
                  className="px-3 py-2 text-xs font-medium text-slate-200 hover:text-white bg-slate-800/90 hover:bg-slate-700 rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                  title="Импортировать демонстрационные примеры из каталога projects/examples/"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  {importingExamples ? 'Импорт...' : 'Импорт примеров'}
                </button>
              )}

              <button
                type="button"
                onClick={onOpenCreateModal}
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Создать проект
              </button>
            </div>
          </div>

          {/* Сегментированный фильтр типов + поиск + быстрые проверки */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-1">
            <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#0b0f17] border border-slate-800/90 rounded-lg">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  filter === 'all' ? 'bg-slate-800 text-white shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                Все ({projects.length})
              </button>
              <button
                type="button"
                onClick={() => setFilter('service')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  filter === 'service' ? 'bg-slate-800 text-emerald-300 shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Bot className="w-3.5 h-3.5" />
                Services 24/7 ({servicesCount})
              </button>
              <button
                type="button"
                onClick={() => setFilter('web')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  filter === 'web' ? 'bg-slate-800 text-cyan-300 shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Server className="w-3.5 h-3.5" />
                Web / API ({webCount})
              </button>
              <button
                type="button"
                onClick={() => setFilter('job')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  filter === 'job' ? 'bg-slate-800 text-indigo-300 shadow-xs' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                Jobs / Cron ({jobsCount})
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
                <input
                  type="text"
                  placeholder="Фильтр по имени, группе, :порту..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-[#0b0f17] border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none w-56"
                />
              </div>

              <button
                type="button"
                onClick={onTriggerDemoAsk}
                title="Запускает проект sms-auth-bot, вызывающий интерактивный запрос hub.ask()"
                className="px-3 py-1.5 text-xs font-medium bg-[#0b0f17] hover:bg-slate-800 text-amber-300 border border-slate-800 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                Тест hub.ask()
              </button>

              <button
                type="button"
                onClick={onTriggerDemoExpiredCookie}
                title="Симулирует сигнал hub.cookies_expired() для проверки баннера замены куки"
                className="px-3 py-1.5 text-xs font-medium bg-[#0b0f17] hover:bg-slate-800 text-rose-300 border border-slate-800 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Cookie className="w-3.5 h-3.5" />
                Тест протухших куки
              </button>

              <button
                type="button"
                disabled={testingRestart}
                onClick={handleHubRestartTest}
                title="Перезагружает супервизор и проверяет сохранение дочерних сервисов без SIGPIPE"
                className="px-3 py-1.5 text-xs font-medium bg-[#0b0f17] hover:bg-slate-800 text-emerald-300 border border-slate-800 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testingRestart ? 'animate-spin' : ''}`} />
                {testingRestart ? 'Проверка...' : 'Тест рестарта без SIGPIPE'}
              </button>
            </div>
          </div>

          {restartTestResult && (
            <div className="p-3 bg-[#0b0f17] border border-emerald-500/30 rounded-lg text-xs text-slate-200 font-mono">
              <span className="text-emerald-400 font-semibold">[Direct FD Recovery OK]</span> Старый PID=
              {restartTestResult.old_hub_pid} → Новый PID={restartTestResult.new_hub_pid}. Сохранены процессы:{' '}
              {restartTestResult.running_after.map((s) => `${s.name} (PID=${s.pid})`).join(', ') || 'нет активных'}.
            </div>
          )}
        </div>

        {filteredProjects.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <div className="text-sm font-semibold text-slate-200">
              {projects.length === 0 ? 'В рабочей базе пока нет проектов' : 'По выбранному фильтру ничего не найдено'}
            </div>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Создайте новый сервис, веб-бэкенд или задачу с нуля, склонируйте репозиторий с GitHub или импортируйте готовые примеры из каталога <code className="font-mono text-slate-300">projects/examples/</code>.
            </p>
            <div className="flex items-center justify-center gap-3 pt-1">
              <button
                type="button"
                onClick={onOpenCreateModal}
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Создать проект
              </button>
              {onImportExamples && (
                <button
                  type="button"
                  disabled={importingExamples}
                  onClick={handleImportExamplesClick}
                  className="px-4 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-4 h-4 text-emerald-400" />
                  Импортировать 4 примера из projects/examples/
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400 bg-[#0b0f17]/70">
                  <th className="py-3 px-4 font-medium">Проект и метаданные</th>
                  <th className="py-3 px-3 font-medium">Архитектура / Порт</th>
                  <th className="py-3 px-3 font-medium">Статус и PGID</th>
                  <th className="py-3 px-3 font-medium">Изоляция и Сессии</th>
                  <th className="py-3 px-3 font-medium">ОЗУ / Диск</th>
                  <th className="py-3 px-4 font-medium text-right">Операции</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-sm">
                {filteredProjects.map((p) => {
                  const isRunning = p.current_status === 'running' || p.current_status === 'waiting_input';
                  const isBusy = busyProjectId === p.id;
                  const cookieInfo = p.cookie_status;

                  return (
                    <tr key={p.id} className="hover:bg-slate-800/30 transition-colors align-top">
                      {/* 1. Название и чистые некапсульные метаданные (Zero-Pill discipline) */}
                      <td className="py-3.5 px-4 max-w-[290px]">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onOpenProjectWorkspace(p, 'editor')}
                            className="font-bold text-white hover:text-indigo-400 transition-colors text-left cursor-pointer"
                          >
                            {p.name}
                          </button>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400 font-mono">
                          <span className="text-slate-300">{p.runtime}</span>
                          {p.group_tag && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{p.group_tag}</span>
                            </>
                          )}
                          {p.git_repo_url && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-emerald-400">git</span>
                            </>
                          )}
                        </div>
                        {p.description ? (
                          <p className="mt-1 text-xs text-slate-300 leading-relaxed line-clamp-2" title={p.description}>
                            {p.description}
                          </p>
                        ) : (
                          <div className="mt-1 text-xs text-slate-400 font-mono truncate">{p.cmd}</div>
                        )}
                      </td>

                      {/* 2. Архитектура (Service / Web / Job) и расписание / порт */}
                      <td className="py-3.5 px-3 text-xs">
                        {p.type === 'web' ? (
                          <div className="text-cyan-300 font-semibold font-mono">
                            Web / API {p.port ? `:${p.port}` : ''}
                          </div>
                        ) : p.type === 'service' ? (
                          <div className="text-emerald-300 font-semibold">Service 24/7</div>
                        ) : (
                          <div className="text-indigo-300 font-semibold">Scheduled Job</div>
                        )}
                        <div className="mt-1 text-slate-400 text-[11px]">
                          {p.type === 'web' && p.healthcheck_url
                            ? `Healthcheck: ${p.healthcheck_url}`
                            : describeScheduleHuman(p.type, p.schedule_type, p.schedule_expr, p.restart_policy, p.autostart)}
                        </div>
                      </td>

                      {/* 3. Статус, Healthcheck и PID/PGID */}
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <div>{renderStatusText(p)}</div>
                        <div className="mt-1 text-[11px] font-mono text-slate-400 tabular-nums">
                          {p.pid ? `PID ${p.pid} · PGID ${p.pgid}` : 'не запущен'}
                        </div>
                        {p.type === 'web' && p.port && p.port > 0 ? (
                          <div className="mt-0.5 text-[11px] font-mono text-cyan-300/90">
                            health: {p.health_status || 'unknown'}
                          </div>
                        ) : null}
                      </td>

                      {/* 4. Куки, прокси, .venv/state */}
                      <td className="py-3.5 px-3 text-xs">
                        <div className="space-y-1">
                          {cookieInfo?.has_cookies ? (
                            <button
                              type="button"
                              onClick={() => onOpenProjectWorkspace(p, 'cookies_tg')}
                              className={`text-xs font-medium cursor-pointer hover:underline block ${
                                cookieInfo.is_expired ? 'text-rose-400' : 'text-emerald-300'
                              }`}
                            >
                              {cookieInfo.is_expired
                                ? 'Куки истекли (обновить)'
                                : `Куки: ${formatBytes(cookieInfo.size_bytes)}`}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onOpenProjectWorkspace(p, 'cookies_tg')}
                              className="text-slate-400 hover:text-indigo-300 cursor-pointer block"
                            >
                              + Привязать куки
                            </button>
                          )}

                          <div className="text-[11px] text-slate-400 font-mono truncate max-w-[190px]">
                            {p.use_proxy === 1 ? `Прокси: ${p.custom_proxy || '127.0.0.1:10808'}` : 'Прямая сеть · .tmp/.home'}
                          </div>
                        </div>
                      </td>

                      {/* 5. ОЗУ и Диск (tabular-nums) */}
                      <td className="py-3.5 px-3 text-xs whitespace-nowrap font-mono tabular-nums">
                        <div className="font-semibold text-white">
                          ОЗУ: {isRunning ? `${p.rss_mb} МБ` : '0 МБ'}
                          {p.ram_limit_mb > 0 ? ` / ${p.ram_limit_mb}` : ''}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Диск: {formatBytes(p.total_size_bytes || 0)} (логи {formatBytes(p.logs_size_bytes || 0)})
                        </div>
                      </td>

                      {/* 6. Кнопки управления */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {!isRunning ? (
                            <button
                              type="button"
                              disabled={isBusy}
                              aria-label={`Старт ${p.name}`}
                              onClick={() => handleAction(p.id, onStartProject)}
                              className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg transition-colors inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                              Старт
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                aria-label={`Стоп ${p.name}`}
                                onClick={() => handleAction(p.id, onStopProject)}
                                className="px-3 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-lg transition-colors inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Square className="w-3.5 h-3.5" />
                                Стоп
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                aria-label={`Рестарт ${p.name}`}
                                onClick={() => handleAction(p.id, onRestartProject)}
                                className="p-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors cursor-pointer"
                                title="Перезапустить"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}

                          {onCloneProject && (
                            <button
                              type="button"
                              disabled={isBusy}
                              aria-label={`Клонировать ${p.name}`}
                              title="Клонировать проект"
                              onClick={() => handleAction(p.id, onCloneProject)}
                              className="p-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition-colors cursor-pointer"
                            >
                              <CopyPlus className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
                            type="button"
                            aria-label={`Открыть консоль ${p.name}`}
                            onClick={() => onOpenProjectWorkspace(p, 'terminal_git')}
                            title="Терминал и .venv/uv"
                            className="p-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition-colors cursor-pointer"
                          >
                            <Terminal className="w-3.5 h-3.5" />
                          </button>

                          <button
                            type="button"
                            aria-label={`Открыть проект ${p.name}`}
                            onClick={() => onOpenProjectWorkspace(p, 'editor')}
                            className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                            Открыть
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Нижняя сетка: Очередь задач по расписанию и Журнал событий */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-[#111622] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">Очередь планировщика (Cron / Interval)</h3>
                <p className="text-[11px] text-slate-400">Расчёт ближайших автоматических запусков</p>
              </div>
            </div>
          </div>

          {upcoming_runs.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              Нет активных периодических задач в очереди.
            </p>
          ) : (
            <div className="mt-3 divide-y divide-slate-800/70">
              {upcoming_runs.map((u) => (
                <div key={u.project_id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                  <div>
                    <div className="font-semibold text-white">{u.project_name}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {describeScheduleHuman('job', u.schedule_type, u.schedule_expr)}
                    </div>
                  </div>
                  <div className="text-right font-mono text-slate-200 tabular-nums shrink-0">
                    <div>через {formatDurationSec(u.in_seconds)}</div>
                    <div className="text-[11px] text-slate-400">
                      {new Date(u.next_run_at * 1000).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-[#111622] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">Журнал инцидентов и Telegram-уведомлений</h3>
                <p className="text-[11px] text-slate-400">Последние сбои запуска и вызовы hub.notify()</p>
              </div>
            </div>
            <span className="text-xs text-slate-400 font-mono tabular-nums">Сбоев: {recent_errors.length}</span>
          </div>

          <div className="mt-3 space-y-2.5 max-h-[240px] overflow-y-auto">
            {recent_errors.map((err) => (
              <div key={`err-${err.id}`} className="p-2.5 bg-[#0b0f17] border border-rose-500/30 rounded-lg text-xs">
                <div className="flex items-center justify-between text-rose-300 font-mono tabular-nums">
                  <span>
                    {err.project_name} · Run #{err.id} ({err.status}, exit={err.exit_code})
                  </span>
                  <span>{new Date(err.started_at * 1000).toLocaleTimeString('ru-RU')}</span>
                </div>
                {err.error_summary && (
                  <div className="mt-1 text-slate-300 font-mono truncate">{err.error_summary}</div>
                )}
              </div>
            ))}

            {recent_notifications.map((n, idx) => (
              <div key={`notif-${idx}`} className="p-2.5 bg-[#0b0f17] border border-slate-800 rounded-lg text-xs">
                <div className="flex items-center justify-between text-slate-400 font-mono tabular-nums">
                  <span className="inline-flex items-center gap-1.5 text-indigo-300">
                    <Send className="w-3 h-3" />
                    {n.channel} {n.proxy_used ? `(${n.proxy_used})` : ''}
                  </span>
                  <span>{new Date(n.timestamp * 1000).toLocaleTimeString('ru-RU')}</span>
                </div>
                <div className="mt-1 text-slate-200 font-mono whitespace-pre-wrap line-clamp-2">{n.text}</div>
              </div>
            ))}

            {recent_errors.length === 0 && recent_notifications.length === 0 && (
              <p className="text-xs text-slate-400 py-6 text-center">
                Сбоев выполнения и тревожных уведомлений нет — все процессы работают штатно.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
