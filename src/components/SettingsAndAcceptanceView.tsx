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
  Download,
  Terminal,
} from 'lucide-react';
import { AcceptanceCheckItem, AuditEntry, ProjectItem } from '../types/hub';
import { describeScheduleHuman, formatBytes, isPortAllowed, validateNewPassword } from '../utils/hubLogic';

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
  const [tgCmdPreview, setTgCmdPreview] = useState<string>('');
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [showAdvancedSystem, setShowAdvancedSystem] = useState<boolean>(false);
  const [systemdInfo, setSystemdInfo] = useState<{ path: string; content: string } | null>(null);
  const [downloadingBackup, setDownloadingBackup] = useState<boolean>(false);

  // Самодиагностика среды (hub doctor)
  const [doctorReport, setDoctorReport] = useState<any | null>(null);
  const [runningDoctor, setRunningDoctor] = useState(false);

  // Тестовый полигон и 6 пунктов приёмки
  const [runningSuite, setRunningSuite] = useState(false);
  const [suiteResults, setSuiteResults] = useState<AcceptanceCheckItem[] | null>(null);
  const [bundleFiles, setBundleFiles] = useState<string[]>([]);
  const [selectedBundleFile, setSelectedBundleFile] = useState<string>('hub/process_mgr.py');
  const [bundleContent, setBundleContent] = useState<string>('');
  const [busyTestProjId, setBusyTestProjId] = useState<number | null>(null);

  const loadSettingsAndAudit = async () => {
    try {
      const [sRes, aRes] = await Promise.all([
        apiFetch('/api/settings'),
        apiFetch('/api/system/audit'),
      ]);
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData && typeof sData === 'object' && !sData.__html_fallback) {
          setSettings(sData);
        }
      }
      if (aRes.ok) {
        const aData = await aRes.json();
        if (Array.isArray(aData)) {
          setAuditLogs(aData);
        }
      }
    } catch {
      // ignore transient errors
    }
  };

  const handleRunDoctor = async () => {
    setRunningDoctor(true);
    try {
      const res = await apiFetch('/api/system/doctor');
      if (res.ok) {
        setDoctorReport(await res.json());
      }
    } finally {
      setRunningDoctor(false);
    }
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
      handleRunDoctor();
    }
  }, [mode]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMsg(null);
    const portCheck = isPortAllowed(Number(settings.port || 8050), settings.reserved_ports || '');
    if (!portCheck.allowed) {
      setSaveMsg({ type: 'err', text: portCheck.reason || 'Запрещённый порт' });
      return;
    }

    const payload = { ...settings };
    if (newPassword.trim()) {
      const pwValid = validateNewPassword(newPassword.trim());
      if (!pwValid.valid) {
        setSaveMsg({ type: 'err', text: pwValid.reason || 'Пароль должен содержать минимум 8 символов' });
        return;
      }
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

  const handleTestTgCommand = async (command: string) => {
    setTgCmdPreview(`Выполнение команды ${command}...`);
    const res = await apiFetch('/api/settings/test_tg_command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    if (res.ok) {
      const data = await res.json();
      setTgCmdPreview(data.reply || '');
    } else {
      setTgCmdPreview('Ошибка выполнения команды бота');
    }
  };

  const handleCleanup = async () => {
    setCleanupMsg('Выполняется очистка кэша pip/npm, старых логов и SQLite WAL...');
    const res = await apiFetch('/api/system/cleanup', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      const walNote = data.wal_checkpoint
        ? ` WAL: ${data.wal_checkpoint.wal_size_before_kb} -> ${data.wal_checkpoint.wal_size_after_kb} КБ.`
        : '';
      setCleanupMsg(
        `Очистка завершена: удалено старых запусков ${data.deleted_runs}, усечено логов ${data.rotated_files}.${walNote} Свободно на диске: ${data.disk?.free_mb} МБ.`
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

  const handleGenerateSystemd = async () => {
    const res = await apiFetch('/api/system/systemd_unit');
    if (res.ok) {
      const data = await res.json();
      setSystemdInfo({ path: data.path, content: data.content });
    }
  };

  const handleDownloadBackup = async () => {
    setDownloadingBackup(true);
    try {
      const res = await apiFetch('/api/system/backup');
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hub_backup_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setCleanupMsg('Архив бэкапа (.zip: SQLite БД + data/secrets/ + код проектов без .venv) успешно сформирован и скачан.');
      }
    } finally {
      setDownloadingBackup(false);
    }
  };

  if (mode === 'acceptance') {
    const testProjects = projects.filter((p) => p.is_test_project);

    return (
      <div className="space-y-6">
        {/* 0. Адаптивная самодиагностика среды (hub doctor) */}
        <section className="bg-[#111622] border border-slate-800 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Shield className="w-5 h-5 text-emerald-400" />
                Адаптивная самодиагностика среды (<code className="font-mono text-indigo-300">python3 -m hub doctor</code>)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Автоматически определяет профиль ОС (Android Chroot vs Standard Linux) и проверяет точки монтирования, права <code className="font-mono">0700/0600</code> на секреты, чекпоинт SQLite WAL, наличие <code className="font-mono">uv</code>, прокси и датчики.
              </p>
            </div>
            <button
              type="button"
              disabled={runningDoctor}
              onClick={handleRunDoctor}
              className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-2 shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${runningDoctor ? 'animate-spin' : ''}`} />
              {runningDoctor ? 'Проверка среды...' : 'Запустить hub doctor'}
            </button>
          </div>

          {doctorReport ? (
            <div className="mt-4 space-y-3">
              {doctorReport.env_profile && (
                <div className="p-3 bg-[#0b0f17] border border-slate-800 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                  <div className="text-slate-200">
                    Профиль среды:{' '}
                    <span className="text-indigo-300 font-semibold">{doctorReport.env_profile.env_label}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-slate-400">
                    <span>Arch: {doctorReport.env_profile.arch}</span>
                    <span>·</span>
                    <span>uv: {doctorReport.env_profile.has_uv ? 'Доступен' : 'Fallback venv'}</span>
                    <span>·</span>
                    <span>systemd: {doctorReport.env_profile.has_systemd ? 'Да' : 'Chroot init'}</span>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                <span className="px-2.5 py-1 rounded bg-emerald-950/60 border border-emerald-500/40 text-emerald-300">
                  OK: {doctorReport.ok_count}
                </span>
                <span className="px-2.5 py-1 rounded bg-amber-950/60 border border-amber-500/40 text-amber-300">
                  WARN: {doctorReport.warn_count}
                </span>
                <span className="px-2.5 py-1 rounded bg-red-950/60 border border-red-500/40 text-red-300">
                  ERROR: {doctorReport.error_count}
                </span>
                <span className="text-slate-400">
                  Время проверки: {doctorReport.duration_ms} мс · Директория: {doctorReport.base_dir}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(doctorReport.checks || []).map((chk: any) => {
                  const isOk = chk.status === 'ok';
                  const isWarn = chk.status === 'warn';
                  return (
                    <div
                      key={chk.id}
                      className={`p-3.5 rounded-lg border text-xs ${
                        isOk
                          ? 'bg-emerald-950/20 border-emerald-500/30'
                          : isWarn
                          ? 'bg-amber-950/25 border-amber-500/40'
                          : 'bg-red-950/30 border-red-500/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-white">{chk.title}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold ${
                            isOk
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : isWarn
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-red-500/20 text-red-300'
                          }`}
                        >
                          {chk.status}
                        </span>
                      </div>
                      <p className="mt-1.5 text-slate-300 leading-relaxed">{chk.summary}</p>
                      {!isOk && chk.fix_hint && (
                        <div className="mt-2 p-2 bg-slate-950/70 rounded font-mono text-[11px] text-amber-200">
                          Подсказка: {chk.fix_hint}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-4 text-xs text-slate-400">Загрузка отчёта самодиагностики...</div>
          )}
        </section>

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
              Настройка бота для получения уведомлений от самой панели и управления ею, а также сетевого прокси, термозащиты смартфона и очистки диска
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
          <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-lg text-xs text-slate-300 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-white">
                Что умеет системный Telegram-бот панели (нажмите для предпросмотра ответа):
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                <button
                  type="button"
                  onClick={() => handleTestTgCommand('/status')}
                  className="px-2 py-0.5 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 cursor-pointer"
                >
                  Тест /status
                </button>
                <button
                  type="button"
                  onClick={() => handleTestTgCommand('/projects')}
                  className="px-2 py-0.5 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 cursor-pointer"
                >
                  Тест /projects
                </button>
                <button
                  type="button"
                  onClick={() => handleTestTgCommand('/doctor')}
                  className="px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 cursor-pointer"
                >
                  Тест /doctor
                </button>
              </div>
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
            {tgCmdPreview && (
              <pre className="p-2.5 bg-slate-950 border border-slate-800 rounded text-[11px] font-mono text-emerald-200 whitespace-pre-wrap">
                {tgCmdPreview}
              </pre>
            )}
          </div>
        </div>

        {/* БЛОК 2: Термозащита и сторож питания смартфона (Android Thermal & Battery Guard) */}
        <div className="p-5 bg-slate-900/70 border border-emerald-500/30 rounded-xl space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" />
              2. Аппаратная термозащита и сторож батареи смартфона (Poco X3 NFC · 24/7)
            </h3>
            <p className="text-xs text-slate-300 mt-1">
              Защищает аккумулятор от вздутия при круглосуточной работе на зарядке: отправляет предупреждение при нагреве выше порога <code className="font-mono text-amber-300">warn</code> и автоматически останавливает некритичные задачи при достижении критической температуры <code className="font-mono text-red-300">crit</code>.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Порог предупреждения T° батареи (°C)
              </label>
              <input
                type="number"
                step="0.5"
                value={settings.battery_warn_temp_c || '43'}
                onChange={(e) => setSettings({ ...settings, battery_warn_temp_c: e.target.value })}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Критический перегрев T° батареи (°C)
              </label>
              <input
                type="number"
                step="0.5"
                value={settings.battery_crit_temp_c || '47'}
                onChange={(e) => setSettings({ ...settings, battery_crit_temp_c: e.target.value })}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-300 mb-1">
                Тревога потери питания 220В (&lt;= %)
              </label>
              <input
                type="number"
                value={settings.battery_low_pct || '20'}
                onChange={(e) => setSettings({ ...settings, battery_low_pct: e.target.value })}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
              />
            </div>

            <div className="flex flex-col justify-end">
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer p-2 bg-[#0f172a] border border-slate-700 rounded-lg">
                <input
                  type="checkbox"
                  checked={settings.thermal_auto_stop !== '0'}
                  onChange={(e) =>
                    setSettings({ ...settings, thermal_auto_stop: e.target.checked ? '1' : '0' })
                  }
                />
                Авто-стоп задач при перегреве &gt;= {settings.battery_crit_temp_c || '47'}°C
              </label>
            </div>
          </div>
        </div>

        {/* БЛОК 3: Стандартные настройки панели (Прокси, Пароль, Очистка диска + SQLite WAL) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-200 mb-1">
              Адрес локального HTTP-прокси (по умолчанию пусто)
            </label>
            <input
              type="text"
              placeholder="Например: http://127.0.0.1:10808"
              value={settings.proxy_url || ''}
              onChange={(e) => setSettings({ ...settings, proxy_url: e.target.value })}
              className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-200 mb-1">
              Сменить пароль входа в веб-панель (мин. 8 символов; дефолт <code className="font-mono text-indigo-300">admin</code>)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Новый пароль (минимум 8 символов)"
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
              Очистить кэш pip / npm, логи и SQLite WAL
            </button>
          </div>
        </div>

        {/* БЛОК 3.5: Резервное копирование (.zip) и генератор systemd unit (hub.service) */}
        <div className="p-5 bg-slate-900/70 border border-slate-800 rounded-xl space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Download className="w-4 h-4 text-indigo-400" />
                3. Резервное копирование (.zip) и автозапуск в Linux (<code className="font-mono text-indigo-300">systemd</code>)
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Полный архив включает SQLite БД (<code className="font-mono">hub.db</code> после WAL checkpoint), файлы секретов (<code className="font-mono">0600</code>) и исходники всех проектов (без тяжёлых папок <code className="font-mono">.venv / node_modules</code>).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={downloadingBackup}
                onClick={handleDownloadBackup}
                className="px-3.5 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {downloadingBackup ? 'Сборка архива...' : 'Скачать полный бэкап (.zip)'}
              </button>
              <button
                type="button"
                onClick={handleGenerateSystemd}
                className="px-3.5 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                Сгенерировать hub.service (systemd)
              </button>
            </div>
          </div>

          {systemdInfo && (
            <div className="space-y-2 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span>
                  Юнит сохранён в <code className="font-mono text-indigo-300">{systemdInfo.path}</code> (<code className="font-mono text-emerald-300">KillMode=process</code> сохраняет дочерние сервисы при рестарте Hub):
                </span>
                <button
                  type="button"
                  onClick={() => setSystemdInfo(null)}
                  className="text-slate-400 hover:text-white text-xs cursor-pointer"
                >
                  Скрыть
                </button>
              </div>
              <pre className="p-3 bg-[#0b0f17] border border-slate-800 rounded-lg text-[11px] font-mono text-slate-200 overflow-x-auto">
                {systemdInfo.content}
              </pre>
            </div>
          )}
        </div>

        {(notifyMsg || cleanupMsg) && (
          <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-emerald-300 space-y-1">
            {notifyMsg && <div>{notifyMsg}</div>}
            {cleanupMsg && <div>{cleanupMsg}</div>}
          </div>
        )}

        {/* БЛОК 4: Расширенные технические настройки сервера (Скрыты по умолчанию, чтобы не перегружать интерфейс) */}
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
                    Порт панели (по умолчанию 8050)
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
                    Пользователь запуска процессов (при наличии hub-runner используется по умолчанию)
                  </label>
                  <select
                    value={settings.run_as_user || 'root'}
                    onChange={(e) => setSettings({ ...settings, run_as_user: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="hub-runner">hub-runner (изолированный юзер с группой 3003 aid_inet)</option>
                    <option value="root">root (полные права)</option>
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

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Доверенные обратные прокси (<code className="font-mono text-indigo-300">trusted_proxies</code>)
                  </label>
                  <input
                    type="text"
                    placeholder="Пусто (или 127.0.0.1/32 для локального nginx/caddy)"
                    value={settings.trusted_proxies || ''}
                    onChange={(e) => setSettings({ ...settings, trusted_proxies: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Зарезервированные порты (<code className="font-mono text-indigo-300">reserved_ports</code>)
                  </label>
                  <input
                    type="text"
                    placeholder="Через запятую, например: 22, 80, 443"
                    value={settings.reserved_ports || ''}
                    onChange={(e) => setSettings({ ...settings, reserved_ports: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Внешний Heartbeat Ping URL (Uptime Kuma / Healthchecks)
                  </label>
                  <input
                    type="text"
                    placeholder="https://hc-ping.com/..."
                    value={settings.outbound_heartbeat_url || ''}
                    onChange={(e) => setSettings({ ...settings, outbound_heartbeat_url: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer p-2.5 bg-[#0f172a] border border-slate-700 rounded-lg">
                  <input
                    type="checkbox"
                    checked={settings.allow_tailscale === '1'}
                    onChange={(e) => setSettings({ ...settings, allow_tailscale: e.target.checked ? '1' : '0' })}
                  />
                  Разрешить подсеть Tailscale (100.64.0.0/10)
                </label>

                <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer p-2.5 bg-[#0f172a] border border-slate-700 rounded-lg">
                  <input
                    type="checkbox"
                    checked={settings.cookie_secure === '1'}
                    onChange={(e) => setSettings({ ...settings, cookie_secure: e.target.checked ? '1' : '0' })}
                  />
                  Принудительный флаг Secure для cookie сессии
                </label>

                <label className="flex items-center gap-2 text-xs text-amber-200 cursor-pointer p-2.5 bg-[#0f172a] border border-amber-700/40 rounded-lg">
                  <input
                    type="checkbox"
                    checked={settings.safe_mode === '1'}
                    onChange={(e) => setSettings({ ...settings, safe_mode: e.target.checked ? '1' : '0' })}
                  />
                  Safe Mode (отключить автозапуск всех проектов)
                </label>
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

