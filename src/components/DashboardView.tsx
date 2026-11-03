import React, { useState } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Terminal,
  Plus,
  Cpu,
  HardDrive,
  Activity,
  ShieldCheck,
  Clock,
  AlertCircle,
  Send,
  KeyRound,
  Cookie,
  RefreshCw,
  Bot,
  FlaskConical,
  FolderOpen,
  BatteryCharging,
  CopyPlus,
  Search,
  Globe,
  GitBranch,
} from 'lucide-react';
import { DashboardData, ProjectItem } from '../types/hub';
import { describeScheduleHuman, formatBytes, formatDurationSec } from '../utils/hubLogic';

interface DashboardViewProps {
  data: DashboardData | null;
  onStartProject: (id: number) => Promise<void>;
  onStopProject: (id: number) => Promise<void>;
  onRestartProject: (id: number) => Promise<void>;
  onCloneProject?: (id: number) => Promise<void>;
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

type ProjectFilter = 'all' | 'service' | 'job' | 'test';

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
  onStartProject,
  onStopProject,
  onRestartProject,
  onCloneProject,
  onOpenProjectWorkspace,
  onOpenCreateModal,
  onTriggerDemoAsk,
  onTriggerDemoExpiredCookie,
  onTestHubRestartSurvival,
  restartTestResult,
}) => {
  const [busyProjectId, setBusyProjectId] = useState<number | null>(null);
  const [testingRestart, setTestingRestart] = useState(false);
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  if (!data) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-24 bg-[#1e293b] border border-slate-800 rounded-xl animate-pulse" />
        <div className="h-64 bg-[#1e293b] border border-slate-800 rounded-xl animate-pulse" />
      </div>
    );
  }

  const { system, projects, upcoming_runs, recent_errors, recent_notifications } = data;
  const runningCount = projects.filter((p) => p.current_status === 'running' || p.current_status === 'waiting_input').length;
  const servicesCount = projects.filter((p) => p.type === 'service').length;
  const jobsCount = projects.filter((p) => p.type === 'job').length;
  const testCount = projects.filter((p) => p.is_test_project).length;
  const totalProjectsBytes = projects.reduce((acc, p) => acc + (p.total_size_bytes || 0), 0);

  const filteredProjects = projects.filter((p) => {
    if (filter === 'service' && p.type !== 'service') return false;
    if (filter === 'job' && p.type !== 'job') return false;
    if (filter === 'test' && !p.is_test_project) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = p.name.toLowerCase().includes(q);
      const matchDesc = (p.description || '').toLowerCase().includes(q);
      const matchGroup = (p.group_tag || '').toLowerCase().includes(q);
      return matchName || matchDesc || matchGroup;
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

  const renderStatusBadge = (status: ProjectItem['current_status']) => {
    switch (status) {
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 text-emerald-400 font-semibold text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Работает (running)
          </span>
        );
      case 'waiting_input':
        return (
          <span className="inline-flex items-center gap-1.5 text-amber-400 font-semibold text-xs">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            Ждёт ввода СМС (waiting_input)
          </span>
        );
      case 'success':
        return <span className="text-indigo-300 font-medium text-xs">Выполнен успешно (success)</span>;
      case 'failed':
        return <span className="text-red-400 font-medium text-xs">Ошибка (failed)</span>;
      case 'timeout':
        return <span className="text-amber-400 font-medium text-xs">Превышен таймаут</span>;
      case 'killed_oom':
        return <span className="text-red-400 font-semibold text-xs">Остановлен (превышен лимит ОЗУ)</span>;
      default:
        return <span className="text-slate-400 text-xs">Остановлен (stopped)</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Сводка ресурсов устройства и самой панели Hub */}
      <section aria-label="Метрики устройства и процесса Hub" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Память самой панели Hub</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono tabular-nums" data-testid="hub-rss-mb">
              {system.hub_rss_mb} МБ
            </span>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              из {system.hub_ram_budget_mb} МБ лимита
            </span>
          </div>
          <div className="mt-2 w-full bg-slate-900 h-1.5 rounded-full overflow-hidden">
            <div
              className={`h-full ${system.hub_rss_mb < 80 ? 'bg-emerald-500' : 'bg-red-500'}`}
              style={{ width: `${Math.min(100, (system.hub_rss_mb / 80) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Лёгкий сервер <code className="font-mono text-slate-300">PID {system.hub_pid}</code> · WAL:{' '}
            <code className="font-mono text-slate-300">{system.disk.wal_size_kb ?? 0} КБ</code>
          </p>
        </div>

        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Нагрузка процессора и ОЗУ</span>
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
            <div
              className="h-full bg-indigo-500"
              style={{ width: `${Math.min(100, system.ram_percent)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400 font-mono tabular-nums">
            ОЗУ: {Math.round(system.ram_used_mb)}/{Math.round(system.ram_total_mb)} МБ · ZRAM:{' '}
            {system.hardware?.swap_used_mb ?? 0}/{system.hardware?.swap_total_mb ?? 0} МБ
          </p>
        </div>

        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Диск и размер всех проектов</span>
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
                  ? 'bg-red-500'
                  : system.disk.state === 'warning'
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, system.disk.percent)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Все проекты и логи занимают: <strong className="text-slate-200 font-mono">{formatBytes(totalProjectsBytes)}</strong>
          </p>
        </div>

        <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              {system.hardware?.available
                ? `${system.hardware.device_model || 'Android'} и Прокси`
                : 'Питание и Прокси'}
            </span>
            <BatteryCharging className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white font-mono tabular-nums">
              {system.hardware?.available && system.hardware.battery_percent !== null
                ? `${system.hardware.battery_percent}%`
                : 'N/A'}
            </span>
            <span
              className={`text-xs font-mono truncate ${
                system.hardware?.thermal_state === 'critical'
                  ? 'text-red-400 font-bold'
                  : system.hardware?.thermal_state === 'warning'
                  ? 'text-amber-300'
                  : 'text-slate-400'
              }`}
            >
              {system.hardware?.available && system.hardware.battery_temp_c !== null
                ? `· ${system.hardware.battery_temp_c}°C${system.hardware.voltage_mv ? ` · ${system.hardware.voltage_mv} мВ` : ''}`
                : '· датчики АКБ: N/A'}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-200 truncate" title={system.hardware?.cycle_label}>
            {system.hardware?.cycle_label || 'Стационарное питание (N/A)'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400 font-mono flex items-center justify-between">
            <span>Прокси 10808: {system.proxy_status?.online ? 'Онлайн' : 'Ожидание туннеля'}</span>
            <span>Аптайм: {system.hardware?.uptime_human || `${runningCount}/${projects.length}`}</span>
          </p>
        </div>
      </section>

      {/* 2. Главный блок проектов с понятным разделением типов, расписания, индивидуальных куки и места на диске */}
      <section className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-800 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white">Ваши программы и скрипты</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Нажмите на название проекта, чтобы открыть его код, индивидуальные куки, Telegram-настройки или расписание
              </p>
            </div>

            <button
              type="button"
              onClick={onOpenCreateModal}
              className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-auto"
            >
              <Plus className="w-4 h-4" />
              Создать проект
            </button>
          </div>

          {/* Наглядная подсказка-аннотация: чем отличаются Постоянные программы от Скриптов по расписанию */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 bg-slate-900/60 border border-slate-800/90 rounded-xl text-xs">
            <div className="flex items-start gap-2.5">
              <Bot className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-white">Постоянные программы 24/7 (Service):</span>{' '}
                <span className="text-slate-300">
                  работают непрерывно (боты, демоны, парсеры реального времени). Панель следит за ними и сама перезапускает при сбое.
                </span>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <Clock className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-white">Скрипты по расписанию или кнопке (Job):</span>{' '}
                <span className="text-slate-300">
                  запускаются на время задачи (например, каждые 15 минут или в 09:00), делают дело и выключаются, не занимая ОЗУ.
                </span>
              </div>
            </div>
          </div>

          {/* Фильтры по категориям + быстрые кнопки проверки на тестовых проектах */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  filter === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-300 hover:text-white'
                }`}
              >
                Все ({projects.length})
              </button>
              <button
                type="button"
                onClick={() => setFilter('service')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  filter === 'service' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-slate-300 hover:text-white'
                }`}
              >
                <Bot className="w-3.5 h-3.5" />
                Постоянные программы 24/7 ({servicesCount})
              </button>
              <button
                type="button"
                onClick={() => setFilter('job')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  filter === 'job' ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-300 hover:text-white'
                }`}
              >
                <Clock className="w-3.5 h-3.5" />
                Скрипты по расписанию ({jobsCount})
              </button>
              <button
                type="button"
                onClick={() => setFilter('test')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
                  filter === 'test' ? 'bg-amber-600 text-white' : 'bg-slate-900 text-slate-300 hover:text-white'
                }`}
              >
                <FlaskConical className="w-3.5 h-3.5" />
                Тестовые примеры ({testCount})
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
                <input
                  type="text"
                  placeholder="Поиск проекта или группы..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none w-48"
                />
              </div>

              <button
                type="button"
                onClick={onTriggerDemoAsk}
                title="Запускает тестовый проект sms-auth-bot, который попросит ввести СМС-код в жёлтом баннере сверху"
                className="px-3 py-1.5 text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <KeyRound className="w-3.5 h-3.5" />
                Тест запроса СМС (hub.ask)
              </button>

              <button
                type="button"
                onClick={onTriggerDemoExpiredCookie}
                title="Помечает куки истёкшими и показывает красный баннер быстрой замены куки сверху"
                className="px-3 py-1.5 text-xs font-medium bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Cookie className="w-3.5 h-3.5" />
                Тест протухших куки
              </button>

              <button
                type="button"
                disabled={testingRestart}
                onClick={handleHubRestartTest}
                title="Перезапускает сам процесс панели и проверяет, что фоновые программы продолжают работать без разрыва"
                className="px-3 py-1.5 text-xs font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testingRestart ? 'animate-spin' : ''}`} />
                {testingRestart ? 'Перезапуск...' : 'Тест рестарта панели'}
              </button>
            </div>
          </div>

          {restartTestResult && (
            <div className="p-3 bg-slate-950/80 border border-emerald-500/30 rounded-lg text-xs text-slate-200 font-mono">
              <span className="text-emerald-400 font-semibold">[Проверка живучести пройдена]</span> Панель перезапущена (старый PID={restartTestResult.old_hub_pid} → новый PID=
              {restartTestResult.new_hub_pid}). Постоянные программы продолжили работу без остановки:{' '}
              {restartTestResult.running_after.map((s) => `${s.name} (PID=${s.pid})`).join(', ') || 'нет активных'}.
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900/50">
                <th className="py-3 px-4 font-medium">Проект и Назначение</th>
                <th className="py-3 px-3 font-medium">Категория и Режим работы</th>
                <th className="py-3 px-3 font-medium">Текущий статус</th>
                <th className="py-3 px-3 font-medium">Куки и ТГ скрипта</th>
                <th className="py-3 px-3 font-medium">Место на диске / ОЗУ</th>
                <th className="py-3 px-4 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-sm">
              {filteredProjects.map((p) => {
                const isRunning = p.current_status === 'running' || p.current_status === 'waiting_input';
                const isBusy = busyProjectId === p.id;
                const hasCustomTg = Boolean(p.env?.BOT_TOKEN || p.env?.TG_CHAT_ID || p.env?.TG_API_ID);
                const cookieInfo = p.cookie_status;

                return (
                  <tr key={p.id} className="hover:bg-slate-800/40 transition-colors align-top">
                    {/* 1. Название и понятное описание */}
                    <td className="py-3.5 px-4 max-w-[260px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => onOpenProjectWorkspace(p, 'editor')}
                          className="font-bold text-white hover:text-indigo-400 transition-colors text-left cursor-pointer"
                        >
                          {p.name}
                        </button>
                        <span className="text-[11px] font-mono text-slate-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                          {p.runtime}
                        </span>
                        {p.group_tag && (
                          <span className="text-[10px] text-indigo-300 bg-indigo-950/60 border border-indigo-500/30 px-1.5 py-0.5 rounded">
                            {p.group_tag}
                          </span>
                        )}
                        {p.git_repo_url && (
                          <span className="text-[10px] text-emerald-300 bg-emerald-950/60 border border-emerald-500/30 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                            <GitBranch className="w-2.5 h-2.5" />
                            GitHub
                          </span>
                        )}
                        {p.is_test_project && (
                          <span className="text-[11px] text-amber-300 bg-amber-950/60 border border-amber-500/30 px-1.5 py-0.5 rounded">
                            Тестовый пример
                          </span>
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

                    {/* 2. Категория (Программа 24/7 vs Скрипт по расписанию) и понятное расписание */}
                    <td className="py-3.5 px-3 text-xs">
                      {p.type === 'service' ? (
                        <div className="inline-flex items-center gap-1.5 text-emerald-300 font-semibold">
                          <Bot className="w-3.5 h-3.5 shrink-0" />
                          Постоянная программа 24/7
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5 text-indigo-300 font-semibold">
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                          Скрипт по расписанию / заданию
                        </div>
                      )}
                      <div className="mt-1 text-slate-300">
                        {describeScheduleHuman(p.type, p.schedule_type, p.schedule_expr, p.restart_policy, p.autostart)}
                      </div>
                    </td>

                    {/* 3. Статус и PID */}
                    <td className="py-3.5 px-3 whitespace-nowrap">
                      <div>{renderStatusBadge(p.current_status)}</div>
                      <div className="mt-1 text-[11px] font-mono text-slate-400">
                        {p.pid ? `PID ${p.pid} (группа ${p.pgid})` : 'Процесс не активен'}
                      </div>
                    </td>

                    {/* 4. Индивидуальные Куки и Telegram самого скрипта */}
                    <td className="py-3.5 px-3 text-xs">
                      <div className="space-y-1">
                        {cookieInfo?.has_cookies ? (
                          <button
                            type="button"
                            onClick={() => onOpenProjectWorkspace(p, 'cookies_tg')}
                            className={`inline-flex items-center gap-1 text-xs font-medium cursor-pointer hover:underline ${
                              cookieInfo.is_expired ? 'text-red-400' : 'text-emerald-300'
                            }`}
                          >
                            <Cookie className="w-3.5 h-3.5 shrink-0" />
                            {cookieInfo.is_expired ? 'Куки протухли (заменить)' : `Свои куки (${formatBytes(cookieInfo.size_bytes)})`}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onOpenProjectWorkspace(p, 'cookies_tg')}
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-indigo-300 cursor-pointer"
                          >
                            <Cookie className="w-3.5 h-3.5 shrink-0" />
                            + Добавить куки скрипту
                          </button>
                        )}

                        {hasCustomTg && (
                          <div className="text-[11px] text-indigo-300 flex items-center gap-1">
                            <Send className="w-3 h-3 shrink-0" />
                            Свой ТГ-бот скрипта настроен
                          </div>
                        )}

                        {p.has_browser_profile && (
                          <div className="text-[11px] text-emerald-300 flex items-center gap-1">
                            <Globe className="w-3 h-3 shrink-0" />
                            Профиль Антибот/Storage сохранён
                          </div>
                        )}

                        {p.use_proxy === 1 && (
                          <div className="text-[11px] text-slate-400 font-mono truncate max-w-[180px]">
                            Прокси: {p.custom_proxy || '127.0.0.1:10808'}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* 5. Занимаемое место на диске и потребление памяти */}
                    <td className="py-3.5 px-3 text-xs whitespace-nowrap">
                      <div className="font-mono font-semibold text-white">
                        Диск: {formatBytes(p.total_size_bytes || 0)}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                        Файлы: {formatBytes(p.code_size_bytes || 0)} · Логи: {formatBytes(p.logs_size_bytes || 0)}
                      </div>
                      <div className="text-[11px] text-slate-300 font-mono mt-1">
                        ОЗУ сейчас: {isRunning ? `${p.rss_mb} МБ` : '0 МБ'}
                        {p.ram_limit_mb > 0 ? ` (лимит ${p.ram_limit_mb} МБ)` : ''}
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
                              className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors inline-flex items-center gap-1 cursor-pointer"
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
                            title="Клонировать проект в 1 клик (например, под 2-й аккаунт со своими куками и прокси)"
                            onClick={() => handleAction(p.id, onCloneProject)}
                            className="p-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition-colors cursor-pointer"
                          >
                            <CopyPlus className="w-3.5 h-3.5" />
                          </button>
                        )}

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
      </section>

      {/* 3. Нижняя сетка: Понятный календарь ближайших запусков по расписанию и Журнал уведомлений панели */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">Очередь скриптов по расписанию</h3>
                <p className="text-[11px] text-slate-400">Когда именно включатся ваши периодические задачи</p>
              </div>
            </div>
          </div>

          {upcoming_runs.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              Нет скриптов с автоматическим расписанием. Вы можете настроить расписание внутри любого проекта.
            </p>
          ) : (
            <div className="mt-3 divide-y divide-slate-800/70">
              {upcoming_runs.map((u) => (
                <div key={u.project_id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                  <div>
                    <div className="font-semibold text-white">{u.project_name}</div>
                    <div className="text-[11px] text-indigo-300 mt-0.5">
                      {describeScheduleHuman('job', u.schedule_type, u.schedule_expr)}
                    </div>
                  </div>
                  <div className="text-right font-mono text-slate-200 tabular-nums shrink-0">
                    <div>через {formatDurationSec(u.in_seconds)}</div>
                    <div className="text-[11px] text-slate-400">
                      в{' '}
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

        <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Журнал событий и уведомлений системного бота панели
                </h3>
                <p className="text-[11px] text-slate-400">
                  Уведомления о сбоях и сообщениях из скриптов (отправляются через прокси 127.0.0.1:10808)
                </p>
              </div>
            </div>
            <span className="text-xs text-slate-400 font-mono tabular-nums">
              Ошибок: {recent_errors.length}
            </span>
          </div>

          <div className="mt-3 space-y-2.5 max-h-[240px] overflow-y-auto">
            {recent_errors.map((err) => (
              <div
                key={`err-${err.id}`}
                className="p-2.5 bg-slate-900/80 border border-red-500/30 rounded-lg text-xs"
              >
                <div className="flex items-center justify-between text-red-300 font-mono">
                  <span>
                    {err.project_name} · Запуск #{err.id} ({err.status}, код={err.exit_code})
                  </span>
                  <span>
                    {new Date(err.started_at * 1000).toLocaleTimeString('ru-RU')}
                  </span>
                </div>
                {err.error_summary && (
                  <div className="mt-1 text-slate-300 font-mono truncate">{err.error_summary}</div>
                )}
              </div>
            ))}

            {recent_notifications.map((n, idx) => (
              <div
                key={`notif-${idx}`}
                className="p-2.5 bg-slate-900/50 border border-slate-800 rounded-lg text-xs"
              >
                <div className="flex items-center justify-between text-slate-400 font-mono">
                  <span className="inline-flex items-center gap-1.5 text-indigo-300">
                    <Send className="w-3 h-3" />
                    {n.channel} {n.proxy_used ? `(${n.proxy_used})` : ''}
                  </span>
                  <span>{new Date(n.timestamp * 1000).toLocaleTimeString('ru-RU')}</span>
                </div>
                <div className="mt-1 text-slate-200 font-mono whitespace-pre-wrap line-clamp-2">
                  {n.text}
                </div>
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
