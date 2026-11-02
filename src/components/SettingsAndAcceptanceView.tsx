import React, { useEffect, useState } from 'react';
import {
  Save,
  Send,
  Trash2,
  CheckCircle2,
  XCircle,
  PlayCircle,
  Shield,
  FileCode2,
  RefreshCw,
  Bot,
  FlaskConical,
  Play,
  FolderOpen,
  ChevronDown,
  ChevronUp,
  Sliders,
} from 'lucide-react';
import { AcceptanceCheckItem, AuditEntry, ProjectItem } from '../types/hub';
import { describeScheduleHuman, formatBytes, isPortAllowed } from '../utils/hubLogic';

interface SettingsAndAcceptanceViewProps {
  mode: 'settings' | 'acceptance';
  projects: ProjectItem[];
  apiFetch: (path: string, options?: RequestInit) => Promise<Response>;
  onRefreshDashboard: () => Promise<void>;
  onStartProject: (id: number) => Promise<any>;
  onOpenProjectWorkspace: (
    p: ProjectItem,
    tab?: 'editor' | 'cookies_tg' | 'simple_cfg' | 'advanced_cfg'
  ) => void;
}

export const SettingsAndAcceptanceView: React.FC<SettingsAndAcceptanceViewProps> = ({
  mode,
  projects,
  apiFetch,
  onRefreshDashboard,
  onStartProject,
  onOpenProjectWorkspace,
}) => {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [newPassword, setNewPassword] = useState('');
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [notifyMsg, setNotifyMsg] = useState<string>('');
  const [cleanupMsg, setCleanupMsg] = useState<string>('');
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [showAdvancedSystem, setShowAdvancedSystem] = useState<boolean>(false);

  // Тестовый полигон и 6 пунктов приёмки
  const [runningSuite, setRunningSuite] = useState(false);
  const [suiteResults, setSuiteResults] = useState<AcceptanceCheckItem[] | null>(null);
  const [bundleFiles, setBundleFiles] = useState<string[]>([]);
  const [selectedBundleFile, setSelectedBundleFile] = useState<string>('hub/process_mgr.py');
  const [bundleContent, setBundleContent] = useState<string>('');
  const [busyTestProjId, setBusyTestProjId] = useState<number | null>(null);

  const loadSettingsAndAudit = async () => {
    const [sRes, aRes] = await Promise.all([
      apiFetch('/api/settings'),
      apiFetch('/api/system/audit'),
    ]);
    if (sRes.ok) setSettings(await sRes.json());
    if (aRes.ok) setAuditLogs(await aRes.json());
  };

  const loadBundleFile = async (filePath: string) => {
    setSelectedBundleFile(filePath);
    const res = await apiFetch(`/api/system/bundle?file=${encodeURIComponent(filePath)}`);
    if (res.ok) {
      const data = await res.json();
      setBundleFiles(data.files || []);
      setBundleContent(data.content || '');
    }
  };

  useEffect(() => {
    if (mode === 'settings') {
      loadSettingsAndAudit();
    } else {
      loadBundleFile(selectedBundleFile);
    }
  }, [mode]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMsg(null);
    const portCheck = isPortAllowed(Number(settings.port || 8050));
    if (!portCheck.allowed) {
      setSaveMsg({ type: 'err', text: portCheck.reason || 'Запрещённый порт' });
      return;
    }

    const payload = { ...settings };
    if (newPassword.trim()) {
      payload.new_password = newPassword.trim();
    }

    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setNewPassword('');
      setSaveMsg({ type: 'ok', text: 'Системные настройки панели успешно сохранены!' });
      await loadSettingsAndAudit();
      await onRefreshDashboard();
    } else {
      const err = await res.json().catch(() => ({}));
      setSaveMsg({ type: 'err', text: err.detail || 'Ошибка сохранения настроек' });
    }
  };

  const handleTestNotify = async () => {
    setNotifyMsg('Отправка тестового сообщения от имени панели...');
    const res = await apiFetch('/api/settings/test_notify', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      setNotifyMsg('Тестовое уведомление отправлено! Запись появилась в журнале уведомлений на Обзоре.');
      await onRefreshDashboard();
    } else {
      setNotifyMsg('Ошибка отправки уведомления');
    }
  };

  const handleCleanup = async () => {
    setCleanupMsg('Выполняется очистка кэша pip/npm и старых логов...');
    const res = await apiFetch('/api/system/cleanup', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      setCleanupMsg(
        `Очистка завершена: удалено старых запусков ${data.deleted_runs}, усечено логов ${data.rotated_files}. Свободно на диске: ${data.disk?.free_mb} МБ.`
      );
      await loadSettingsAndAudit();
      await onRefreshDashboard();
    }
  };

  const handleRunAcceptanceSuite = async () => {
    setRunningSuite(true);
    try {
      const res = await apiFetch('/api/system/run_acceptance_suite', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        setSuiteResults(data.results || []);
        await onRefreshDashboard();
      }
    } finally {
      setRunningSuite(false);
    }
  };

  const handleRunTestProject = async (proj: ProjectItem) => {
    setBusyTestProjId(proj.id);
    try {
      await onStartProject(proj.id);
      await onRefreshDashboard();
    } finally {
      setBusyTestProjId(null);
    }
  };

  if (mode === 'acceptance') {
    const testProjects = projects.filter((p) => p.is_test_project);

    return (
      <div className="space-y-6">
        {/* 1. Набор готовых тестовых проектов с понятным объяснением, что каждый из них проверяет */}
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-6">
          <div className="pb-4 border-b border-slate-800">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <FlaskConical className="w-5 h-5 text-amber-400" />
              Готовые тестовые проекты (Песочница для ручной проверки)
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Мы подготовили 5 специальных тестовых проектов для разных сценариев: постоянная программа 24/7, запрос СМС-кода, протухание индивидуальных куки, свой Telegram-бот проекта и скрипт по расписанию.
            </p>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            {testProjects.map((tp) => {
              const isRunning = tp.current_status === 'running' || tp.current_status === 'waiting_input';
              return (
                <div
                  key={tp.id}
                  className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl flex flex-col justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-sm text-white">{tp.name}</span>
                      <span className="text-[11px] font-mono text-slate-400">
                        Диск: {formatBytes(tp.total_size_bytes || 0)}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-indigo-300 font-medium">
                      {describeScheduleHuman(
                        tp.type,
                        tp.schedule_type,
                        tp.schedule_expr,
                        tp.restart_policy,
                        tp.autostart
                      )}
                    </div>
                    <p className="mt-2 text-xs text-slate-300 leading-relaxed">
                      {tp.description || tp.cmd}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-mono text-slate-400">
                      Статус: <strong className="text-white">{tp.current_status}</strong>
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busyTestProjId === tp.id}
                        onClick={() => handleRunTestProject(tp)}
                        className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" />
                        {isRunning ? 'Запущен' : 'Запустить тест'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenProjectWorkspace(tp, 'editor')}
                        className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                        Код и Лог
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 2. Автоматический прогон 6 системных тестов приёмки */}
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-base font-bold text-white">
                Автоматический прогон 6 системных тестов приёмки (в 1 клик)
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Проверяет в реальном времени: убийство дерева процессов по PGID, выживание при рестарте панели, уведомления при падении через прокси 127.0.0.1:10808, импорт Cookie-Editor + сигнал <code className="font-mono">cookies_expired()</code>, интерактивный <code className="font-mono">hub.ask()</code> и память &lt; 80 МБ.
              </p>
            </div>

            <button
              type="button"
              disabled={runningSuite}
              onClick={handleRunAcceptanceSuite}
              className="px-4 py-2.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <PlayCircle className="w-4 h-4" />
              {runningSuite ? 'Выполнение 6 тестов (~5 сек)...' : 'Запустить все 6 тестов приёмки'}
            </button>
          </div>

          {suiteResults ? (
            <div className="mt-4 space-y-2.5">
              {suiteResults.map((item) => (
                <div
                  key={item.id}
                  className={`p-3.5 rounded-lg border flex items-start gap-3 ${
                    item.passed
                      ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-100'
                      : 'bg-red-950/40 border-red-500/40 text-red-100'
                  }`}
                >
                  {item.passed ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <div className="text-xs">
                    <div className="font-semibold text-white">{item.title}</div>
                    <div className="mt-1 font-mono text-slate-300">{item.details}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 p-4 bg-slate-900/60 border border-slate-800 rounded-lg text-xs text-slate-300">
              Нажмите зелёную кнопку <strong>«Запустить все 6 тестов приёмки»</strong>, чтобы система автоматически проверила все механизмы и вывела отчёт.
            </div>
          )}
        </section>

        {/* 3. Просмотрщик структуры и исходного кода /opt/hub */}
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-sm font-bold text-white">
                  Исходные файлы дистрибутива /opt/hub (для переноса на ваш сервер)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Здесь можно посмотреть готовый код бэкенда, SDK и скрипта установки <code className="font-mono">install.sh</code>
                </p>
              </div>
            </div>

            <select
              aria-label="Выбор файла дистрибутива /opt/hub"
              value={selectedBundleFile}
              onChange={(e) => loadBundleFile(e.target.value)}
              className="bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
            >
              {bundleFiles.map((f) => (
                <option key={f} value={f}>
                  /opt/hub/{f}
                </option>
              ))}
            </select>
          </div>

          <pre className="p-4 bg-[#070b14] text-slate-200 font-mono text-xs leading-relaxed max-h-[420px] overflow-auto">
            {bundleContent}
          </pre>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSaveSettings}
        className="bg-[#1e293b] border border-slate-800 rounded-xl p-6 space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-bold text-white">Настройки панели и Системного Telegram-бота</h2>
            <p className="text-xs text-slate-400">
              Настройка бота для получения уведомлений от самой панели и управления ею, а также сетевого прокси и очистки диска
            </p>
          </div>

          <button
            type="submit"
            className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer self-start sm:self-auto"
          >
            <Save className="w-4 h-4" />
            Сохранить настройки панели
          </button>
        </div>

        {saveMsg && (
          <div
            className={`p-3 rounded-lg text-xs ${
              saveMsg.type === 'ok'
                ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-200'
                : 'bg-red-950/60 border border-red-500/40 text-red-200'
            }`}
          >
            {saveMsg.text}
          </div>
        )}

        {/* БЛОК 1: Чёткое разделение Системного Telegram-бота Панели vs Telegram в проектах */}
        <div className="p-5 bg-slate-900/70 border border-indigo-500/30 rounded-xl space-y-4">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Bot className="w-4 h-4 text-indigo-400" />
                1. Системный Telegram-бот самой панели Hub (Уведомления и Управление)
              </h3>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                Этот бот принадлежит <strong>самой панели управления</strong>. Через него панель присылает вам отчёты о падении программ, протухших куках и вопросы <code className="font-mono text-amber-300">hub.ask("Код из СМС?")</code>, а также принимает от вас команды управления сервером.
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                💡 <em>А если вы пишете собственного Telegram-бота внутри проекта — его токен прописывается отдельно внутри самого проекта («Проекты и Код» → «2. Куки и Telegram скрипта»).</em>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Токен системного бота панели (<code className="font-mono text-indigo-300">tg_bot_token</code>)
              </label>
              <input
                type="text"
                placeholder="123456789:AAH_ваш_системный_бот..."
                value={settings.tg_bot_token || ''}
                onChange={(e) => setSettings({ ...settings, tg_bot_token: e.target.value })}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Ваш личный Chat ID администратора (<code className="font-mono text-indigo-300">tg_chat_id</code>)
              </label>
              <input
                type="text"
                placeholder="Например: 482910394"
                value={settings.tg_chat_id || ''}
                onChange={(e) => setSettings({ ...settings, tg_chat_id: e.target.value })}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
              />
            </div>

            <div className="flex flex-col justify-end space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.tg_use_proxy !== '0'}
                  onChange={(e) => setSettings({ ...settings, tg_use_proxy: e.target.checked ? '1' : '0' })}
                />
                Подключаться к Telegram через прокси 127.0.0.1:10808
              </label>
              <button
                type="button"
                onClick={handleTestNotify}
                className="px-3 py-2 text-xs font-semibold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Проверить отправку сообщения в ТГ
              </button>
            </div>
          </div>

          {/* Шпаргалка команд системного бота управления панелью */}
          <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-lg text-xs text-slate-300">
            <div className="font-semibold text-white mb-1">
              Что умеет системный Telegram-бот панели:
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px] font-mono">
              <div>
                <span className="text-indigo-300">/status</span> — память, CPU и свободное место
              </div>
              <div>
                <span className="text-indigo-300">/projects</span> — список всех программ и скриптов
              </div>
              <div>
                <span className="text-indigo-300">/start &lt;имя&gt;</span> / <span className="text-indigo-300">/stop &lt;имя&gt;</span> — запуск и стоп
              </div>
              <div>
                <span className="text-amber-300">Reply (Ответ)</span> — передаёт СМС-код в <code className="font-mono">hub.ask()</code>
              </div>
            </div>
          </div>
        </div>

        {/* БЛОК 2: Стандартные настройки панели (Прокси, Пароль, Очистка диска) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-200 mb-1">
              Адрес локального HTTP-прокси (для Telegram и скриптов)
            </label>
            <input
              type="text"
              value={settings.proxy_url || 'http://127.0.0.1:10808'}
              onChange={(e) => setSettings({ ...settings, proxy_url: e.target.value })}
              className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-200 mb-1">
              Сменить пароль входа в веб-панель
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Оставьте пустым, чтобы не менять"
              className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
            />
          </div>

          <div className="flex flex-col justify-end">
            <button
              type="button"
              onClick={handleCleanup}
              className="w-full py-2 px-3 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 rounded-lg inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Очистить кэш pip / npm и старые логи
            </button>
          </div>
        </div>

        {(notifyMsg || cleanupMsg) && (
          <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-emerald-300 space-y-1">
            {notifyMsg && <div>{notifyMsg}</div>}
            {cleanupMsg && <div>{cleanupMsg}</div>}
          </div>
        )}

        {/* БЛОК 3: Расширенные технические настройки сервера (Скрыты по умолчанию, чтобы не перегружать интерфейс) */}
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAdvancedSystem(!showAdvancedSystem)}
            className="w-full px-4 py-3 bg-slate-900/60 hover:bg-slate-900 flex items-center justify-between text-xs font-medium text-slate-300 cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-slate-400" />
              Расширенные системные настройки (Порт 8050, Подсети CIDR, Права Android aid_inet, Квоты диска, ntfy)
            </span>
            {showAdvancedSystem ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showAdvancedSystem && (
            <div className="p-5 bg-[#0f172a]/60 border-t border-slate-800 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Порт панели (запрещены: 22, 3000, 2053, 3199, 8040, 10808, 25325)
                  </label>
                  <input
                    type="number"
                    value={settings.port || '8050'}
                    onChange={(e) => setSettings({ ...settings, port: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Пользователь запуска процессов (Android chroot)
                  </label>
                  <select
                    value={settings.run_as_user || 'root'}
                    onChange={(e) => setSettings({ ...settings, run_as_user: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="root">root (по умолчанию в chroot)</option>
                    <option value="hub-runner">hub-runner (изолированный юзер с группой 3003 aid_inet)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Разрешённые подсети (CIDR через запятую)
                  </label>
                  <input
                    type="text"
                    value={settings.allowed_subnets || ''}
                    onChange={(e) => setSettings({ ...settings, allowed_subnets: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Порог warn диска (МБ)</label>
                  <input
                    type="number"
                    value={settings.disk_warn_mb || '500'}
                    onChange={(e) => setSettings({ ...settings, disk_warn_mb: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Порог crit диска (МБ)</label>
                  <input
                    type="number"
                    value={settings.disk_crit_mb || '150'}
                    onChange={(e) => setSettings({ ...settings, disk_crit_mb: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Макс. размер лога (МБ)</label>
                  <input
                    type="number"
                    value={settings.log_max_size_mb || '10'}
                    onChange={(e) => setSettings({ ...settings, log_max_size_mb: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Хранить запусков</label>
                  <input
                    type="number"
                    value={settings.log_keep_runs || '20'}
                    onChange={(e) => setSettings({ ...settings, log_keep_runs: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Хранить дней</label>
                  <input
                    type="number"
                    value={settings.log_keep_days || '14'}
                    onChange={(e) => setSettings({ ...settings, log_keep_days: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-2.5">
                  <div className="text-xs font-semibold text-white">Дополнительный канал: ntfy Push</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="https://ntfy.sh"
                      value={settings.ntfy_url || ''}
                      onChange={(e) => setSettings({ ...settings, ntfy_url: e.target.value })}
                      className="bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                    <input
                      type="text"
                      placeholder="ntfy_topic"
                      value={settings.ntfy_topic || ''}
                      onChange={(e) => setSettings({ ...settings, ntfy_topic: e.target.value })}
                      className="bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-2.5">
                  <div className="text-xs font-semibold text-white">Дополнительный канал: Webhook URL</div>
                  <input
                    type="text"
                    placeholder="https://example.com/webhook"
                    value={settings.webhook_url || ''}
                    onChange={(e) => setSettings({ ...settings, webhook_url: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </form>

      {/* Журнал аудита безопасности (audit_log) */}
      <section className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Журнал безопасности и действий в панели</h3>
          </div>
          <button
            type="button"
            onClick={loadSettingsAndAudit}
            className="p-1.5 text-slate-400 hover:text-white bg-slate-800 rounded cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="overflow-x-auto max-h-[260px] overflow-y-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900/50">
                <th className="py-2.5 px-4 font-medium">Время</th>
                <th className="py-2.5 px-4 font-medium">IP-адрес</th>
                <th className="py-2.5 px-4 font-medium">Событие</th>
                <th className="py-2.5 px-4 font-medium">Подробности</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs font-mono">
              {auditLogs.map((a) => (
                <tr key={a.id} className="hover:bg-slate-800/30">
                  <td className="py-2 px-4 text-slate-400 whitespace-nowrap">
                    {new Date(a.timestamp * 1000).toLocaleString('ru-RU')}
                  </td>
                  <td className="py-2 px-4 text-slate-300 whitespace-nowrap">{a.ip}</td>
                  <td className="py-2 px-4 text-indigo-300 font-semibold whitespace-nowrap">{a.action}</td>
                  <td className="py-2 px-4 text-slate-200">{a.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
