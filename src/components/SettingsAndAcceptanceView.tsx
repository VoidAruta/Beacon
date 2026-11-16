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
  isDefaultPassword?: boolean;
  currentUsername?: string;
  onCsrfUpdate?: (token: string) => void;
  onRefreshDashboard: () => Promise<void>;
  onStartProject: (id: number) => Promise<any>;
  onOpenProjectWorkspace: (
    p: ProjectItem,
    tab?: 'editor' | 'cookies_tg' | 'simple_cfg' | 'advanced_cfg'
  ) => void;
}

interface RbacUserItem {
  id: number;
  username: string;
  role: 'viewer' | 'operator' | 'admin';
  created_at: number;
}

export const SettingsAndAcceptanceView: React.FC<SettingsAndAcceptanceViewProps> = ({
  mode,
  projects,
  apiFetch,
  isDefaultPassword = false,
  currentUsername = 'admin',
  onCsrfUpdate,
  onRefreshDashboard,
  onStartProject,
  onOpenProjectWorkspace,
}) => {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [lockoutPrompt, setLockoutPrompt] = useState<string>('');
  const [notifyMsg, setNotifyMsg] = useState<string>('');
  const [cleanupMsg, setCleanupMsg] = useState<string>('');
  const [tgCmdPreview, setTgCmdPreview] = useState<string>('');
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [auditSearch, setAuditSearch] = useState<string>('');
  const [settingsSubTab, setSettingsSubTab] = useState<
    'all' | 'security_net' | 'notifications' | 'resources_power' | 'rbac_backup' | 'audit'
  >('security_net');
  const [showTgHelp, setShowTgHelp] = useState<boolean>(false);
  const [systemdInfo, setSystemdInfo] = useState<{ path: string; content: string } | null>(null);
  const [downloadingBackup, setDownloadingBackup] = useState<boolean>(false);

  // Пользователи и RBAC
  const [users, setUsers] = useState<RbacUserItem[]>([]);
  const [newUserName, setNewUserName] = useState<string>('');
  const [newUserPassword, setNewUserPassword] = useState<string>('');
  const [newUserRole, setNewUserRole] = useState<'viewer' | 'operator' | 'admin'>('viewer');
  const [userMsg, setUserMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editUserRole, setEditUserRole] = useState<'viewer' | 'operator' | 'admin'>('viewer');
  const [editUserPassword, setEditUserPassword] = useState<string>('');

  // Самодиагностика среды (beacon doctor)
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
      const [sRes, aRes, uRes] = await Promise.all([
        apiFetch('/api/settings'),
        apiFetch('/api/system/audit'),
        apiFetch('/api/users'),
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
      if (uRes.ok) {
        const uData = await uRes.json();
        if (Array.isArray(uData)) {
          setUsers(uData);
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

  const submitSettingsRequest = async (confirmLockout: boolean = false) => {
    setSaveMsg(null);
    setLockoutPrompt('');
    const portCheck = isPortAllowed(Number(settings.port || 8050), settings.reserved_ports || '');
    if (!portCheck.allowed) {
      setSaveMsg({ type: 'err', text: portCheck.reason || 'Запрещённый порт' });
      return;
    }

    const payload: Record<string, any> = { ...settings };
    if (confirmLockout) {
      payload.confirm_lockout = true;
    }
    if (newPassword.trim()) {
      const pwValid = validateNewPassword(newPassword.trim());
      if (!pwValid.valid) {
        setSaveMsg({ type: 'err', text: pwValid.error || 'Пароль должен содержать минимум 8 символов' });
        return;
      }
      if (!isDefaultPassword && !currentPassword) {
        setSaveMsg({ type: 'err', text: 'Для смены пароля введите действующий текущий пароль' });
        return;
      }
      payload.new_password = newPassword.trim();
      if (currentPassword) {
        payload.current_password = currentPassword;
      }
    }

    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.csrf_token && onCsrfUpdate) {
        onCsrfUpdate(data.csrf_token);
      }
      setNewPassword('');
      setCurrentPassword('');
      setSaveMsg({ type: 'ok', text: 'Системные настройки панели успешно сохранены!' });
      await loadSettingsAndAudit();
      await onRefreshDashboard();
    } else {
      const err = await res.json().catch(() => ({}));
      const detail = String(err.detail || 'Ошибка сохранения настроек');
      if (detail.includes('lockout_warning')) {
        setLockoutPrompt(detail);
      } else {
        setSaveMsg({ type: 'err', text: detail });
      }
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitSettingsRequest(false);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUserMsg(null);
    const res = await apiFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: newUserName.trim(),
        password: newUserPassword,
        role: newUserRole,
      }),
    });
    if (res.ok) {
      setNewUserName('');
      setNewUserPassword('');
      setNewUserRole('viewer');
      setUserMsg({ type: 'ok', text: 'Пользователь создан.' });
      await loadSettingsAndAudit();
    } else {
      const err = await res.json().catch(() => ({}));
      setUserMsg({ type: 'err', text: err.detail || 'Не удалось создать пользователя' });
    }
  };

  const handleSaveUserEdit = async (userId: number) => {
    setUserMsg(null);
    const body: Record<string, any> = { role: editUserRole };
    if (editUserPassword.trim()) {
      body.password = editUserPassword.trim();
    }
    const res = await apiFetch(`/api/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setEditingUserId(null);
      setEditUserPassword('');
      setUserMsg({ type: 'ok', text: 'Учётная запись обновлена.' });
      await loadSettingsAndAudit();
    } else {
      const err = await res.json().catch(() => ({}));
      setUserMsg({ type: 'err', text: err.detail || 'Ошибка обновления пользователя' });
    }
  };

  const handleDeleteUser = async (userId: number) => {
    setUserMsg(null);
    const res = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
    if (res.ok) {
      setUserMsg({ type: 'ok', text: 'Пользователь удалён.' });
      await loadSettingsAndAudit();
    } else {
      const err = await res.json().catch(() => ({}));
      setUserMsg({ type: 'err', text: err.detail || 'Не удалось удалить пользователя' });
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
        a.download = `beacon_backup_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setCleanupMsg('Архив бэкапа (.zip: SQLite snapshot + data/secrets/ + проекты без .venv) успешно сформирован и скачан.');
      } else {
        const err = await res.json().catch(() => ({}));
        setCleanupMsg(err.detail || 'Не удалось сформировать архив бэкапа.');
      }
    } finally {
      setDownloadingBackup(false);
    }
  };

  if (mode === 'acceptance') {
    const testProjects = projects.filter((p) => p.is_test_project);

    return (
      <div className="space-y-6">
        {/* 0. Адаптивная самодиагностика среды (beacon doctor) */}
        <section className="bg-[#111622] border border-slate-800 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Shield className="w-5 h-5 text-emerald-400" />
                Адаптивная самодиагностика среды (<code className="font-mono text-indigo-300">python3 -m beacon doctor</code>)
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
              {runningDoctor ? 'Проверка среды...' : 'Запустить beacon doctor'}
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
                Проверяет в реальном времени: убийство дерева процессов по PGID, выживание при рестарте панели, уведомления при падении, импорт Cookie-Editor + сигнал <code className="font-mono">cookies_expired()</code>, интерактивный <code className="font-mono">beacon.ask()</code> и память &lt; 80 МБ.
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

        {/* 3. Просмотрщик структуры и исходного кода /opt/beacon */}
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-indigo-400" />
              <div>
                <h3 className="text-sm font-bold text-white">
                  Исходные файлы дистрибутива Beacon (для переноса на сервер)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Здесь можно посмотреть готовый код бэкенда, SDK и скрипта установки <code className="font-mono">install.sh</code>
                </p>
              </div>
            </div>

            <select
              aria-label="Выбор файла дистрибутива Beacon"
              value={selectedBundleFile}
              onChange={(e) => loadBundleFile(e.target.value)}
              className="bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
            >
              {bundleFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
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

  const filteredAuditLogs = auditLogs.filter((a) => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      (a.action || '').toLowerCase().includes(q) ||
      (a.details || '').toLowerCase().includes(q) ||
      (a.ip || '').toLowerCase().includes(q) ||
      (a.actor || '').toLowerCase().includes(q)
    );
  });

  const showSecNet = settingsSubTab === 'all' || settingsSubTab === 'security_net';
  const showNotif = settingsSubTab === 'all' || settingsSubTab === 'notifications';
  const showResPower = settingsSubTab === 'all' || settingsSubTab === 'resources_power';
  const showRbacBackup = settingsSubTab === 'all' || settingsSubTab === 'rbac_backup';
  const showAudit = settingsSubTab === 'all' || settingsSubTab === 'audit';

  return (
    <div className="space-y-5">
      {/* Шапка настроек + навигация по подразделам + единая кнопка сохранения */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Sliders className="w-5 h-5 text-indigo-400" />
              Конфигурация сервера Beacon, Уведомления и RBAC
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Все параметры разделены по логическим категориям. После изменения полей нажмите «Сохранить настройки панели».
            </p>
          </div>

          <button
            type="button"
            onClick={() => submitSettingsRequest(false)}
            className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer self-start sm:self-auto shrink-0 shadow-sm"
          >
            <Save className="w-4 h-4" />
            Сохранить настройки панели
          </button>
        </div>

        {/* Переключатель подразделов настроек */}
        <div className="flex flex-wrap items-center gap-1.5 pt-3 border-t border-slate-800">
          {(
            [
              { id: 'security_net', label: '1. Пароль, Сеть и Прокси' },
              { id: 'notifications', label: '2. Telegram-бот и Оповещения' },
              { id: 'resources_power', label: '3. Диск, Логи и Питание' },
              { id: 'rbac_backup', label: `4. Пользователи (${users.length}), Бэкап и Systemd` },
              { id: 'audit', label: `5. Журнал аудита (${auditLogs.length})` },
              { id: 'all', label: 'Все разделы сразу' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSettingsSubTab(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                settingsSubTab === tab.id
                  ? 'bg-indigo-600 text-white'
                  : 'bg-[#0f172a] text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {saveMsg && (
          <div
            className={`p-3 rounded-lg text-xs font-medium border flex items-center justify-between ${
              saveMsg.type === 'ok'
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
                : 'bg-red-950/60 border-red-500/40 text-red-200'
            }`}
          >
            <span>{saveMsg.text}</span>
            <button
              type="button"
              onClick={() => setSaveMsg(null)}
              className="text-slate-400 hover:text-white text-xs cursor-pointer"
            >
              Скрыть
            </button>
          </div>
        )}

        {(notifyMsg || cleanupMsg) && (
          <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-emerald-300 flex items-center justify-between gap-2">
            <div className="space-y-1">
              {notifyMsg && <div>{notifyMsg}</div>}
              {cleanupMsg && <div>{cleanupMsg}</div>}
            </div>
            <button
              type="button"
              onClick={() => {
                setNotifyMsg('');
                setCleanupMsg('');
              }}
              className="text-slate-400 hover:text-white text-xs font-sans cursor-pointer shrink-0"
            >
              Закрыть
            </button>
          </div>
        )}

        {lockoutPrompt && (
          <div className="p-4 rounded-xl bg-amber-950/60 border border-amber-500/50 text-xs text-amber-100 space-y-2.5">
            <div className="font-semibold text-amber-300">
              Внимание: новые сетевые правила могут заблокировать ваш текущий IP!
            </div>
            <div className="font-mono text-[11px]">{lockoutPrompt}</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => submitSettingsRequest(true)}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold rounded-lg cursor-pointer"
              >
                Подтвердить и применить (confirm_lockout)
              </button>
              <button
                type="button"
                onClick={() => setLockoutPrompt('')}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg cursor-pointer"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ФОРМА НАСТРОЕК (разделы 1, 2, 3) */}
      {(showSecNet || showNotif || showResPower) && (
        <form onSubmit={handleSaveSettings} className="space-y-5">
          {/* РАЗДЕЛ 1: ПАРОЛЬ, СЕТЬ, TAILSCALE И ПРОКСИ */}
          {showSecNet && (
            <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-5">
              <div className="pb-3 border-b border-slate-800">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Shield className="w-4 h-4 text-indigo-400" />
                  1. Пароль администратора, Сетевой доступ (CIDR / Tailscale) и Прокси
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Управление входом в панель, разрешёнными IP-подсетями и глобальным SOCKS5/HTTP прокси для проектов
                </p>
              </div>

              {/* Смена пароля + глобальный прокси */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="p-4 bg-[#0f172a]/80 border border-slate-800 rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">
                      Смена пароля главного администратора (<code className="font-mono text-indigo-300">admin</code>)
                    </span>
                    {isDefaultPassword && (
                      <span className="px-2 py-0.5 text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded">
                        Установлен стандартный пароль!
                      </span>
                    )}
                  </div>

                  {!isDefaultPassword && (
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-1">
                        Действующий пароль (нужен только если вы меняете пароль)
                      </label>
                      <input
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder="Введите текущий пароль..."
                        className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Новый пароль (от 8 символов; оставьте пустым, чтобы не менять)
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Минимум 8 символов (PBKDF2-SHA256)"
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                {/* Глобальный исходящий прокси */}
                <div className="p-4 bg-[#0f172a]/80 border border-slate-800 rounded-xl space-y-3">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Глобальный исходящий прокси для проектов и Telegram
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Передаётся в <code className="font-mono">HTTP_PROXY / ALL_PROXY</code> всем проектам, у которых включён флаг «Использовать прокси»
                    </p>
                  </div>

                  <input
                    type="text"
                    placeholder="socks5://127.0.0.1:10808 или http://user:pass@ip:port"
                    value={settings.proxy_url || ''}
                    onChange={(e) => setSettings({ ...settings, proxy_url: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-400 mr-1">Быстрые шаблоны:</span>
                    {[
                      { label: 'v2ray / Xray (:10808)', val: 'socks5://127.0.0.1:10808' },
                      { label: 'Clash (:7890)', val: 'http://127.0.0.1:7890' },
                      { label: 'Tor (:9050)', val: 'socks5://127.0.0.1:9050' },
                      { label: 'Отключить прокси', val: '' },
                    ].map((pr) => (
                      <button
                        key={pr.label}
                        type="button"
                        onClick={() => setSettings({ ...settings, proxy_url: pr.val })}
                        className="px-2 py-1 text-[11px] font-mono bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded cursor-pointer"
                      >
                        {pr.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Сетевой фильтр CIDR, Tailscale, Порт и Прокси */}
              <div className="p-4 bg-[#0f172a]/80 border border-slate-800 rounded-xl space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Сетевой фильтр доступа к панели (Разрешённые подсети CIDR)
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Определяет, с каких IP-адресов разрешён вход в веб-панель и к API
                    </p>
                  </div>

                  {/* Пресеты подсетей в 1 клик */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setSettings({
                          ...settings,
                          allowed_subnets: '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,::1/128',
                          allow_tailscale: '1',
                        })
                      }
                      className="px-2.5 py-1 text-[11px] bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded cursor-pointer"
                    >
                      Локальная сеть + Tailscale
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings({
                          ...settings,
                          allowed_subnets: '127.0.0.1/32,::1/128',
                          allow_tailscale: '0',
                        })
                      }
                      className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded cursor-pointer"
                    >
                      Только localhost
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings({
                          ...settings,
                          allowed_subnets: '0.0.0.0/0,::/0',
                        })
                      }
                      className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 rounded cursor-pointer"
                    >
                      Любой IP (0.0.0.0/0)
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-300 mb-1">
                      Список разрешённых подсетей CIDR (через запятую)
                    </label>
                    <input
                      type="text"
                      value={settings.allowed_subnets || ''}
                      onChange={(e) => setSettings({ ...settings, allowed_subnets: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Порт веб-панели (по умолчанию 8050)
                    </label>
                    <input
                      type="number"
                      value={settings.port || '8050'}
                      onChange={(e) => setSettings({ ...settings, port: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Пользователь ОС для запуска проектов
                    </label>
                    <select
                      value={settings.run_as_user || 'root'}
                      onChange={(e) => setSettings({ ...settings, run_as_user: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                    >
                      <option value="beacon-runner">beacon-runner (изолированный юзер)</option>
                      <option value="hub-runner">hub-runner (совместимость со старой версией)</option>
                      <option value="root">root (без понижения привилегий)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Доверенные обратные прокси (Nginx / Caddy IP)
                    </label>
                    <input
                      type="text"
                      placeholder="Пусто или 127.0.0.1/32"
                      value={settings.trusted_proxies || ''}
                      onChange={(e) => setSettings({ ...settings, trusted_proxies: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Зарезервированные системные порты
                    </label>
                    <input
                      type="text"
                      placeholder="22, 80, 443, 5432"
                      value={settings.reserved_ports || ''}
                      onChange={(e) => setSettings({ ...settings, reserved_ports: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer p-2.5 bg-[#0b0f17] border border-slate-800 rounded-lg">
                    <input
                      type="checkbox"
                      checked={settings.allow_tailscale === '1'}
                      onChange={(e) => setSettings({ ...settings, allow_tailscale: e.target.checked ? '1' : '0' })}
                    />
                    Разрешить VPN Tailscale (100.64.0.0/10)
                  </label>

                  <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer p-2.5 bg-[#0b0f17] border border-slate-800 rounded-lg">
                    <input
                      type="checkbox"
                      checked={settings.cookie_secure === '1'}
                      onChange={(e) => setSettings({ ...settings, cookie_secure: e.target.checked ? '1' : '0' })}
                    />
                    Флаг Secure для cookie (только HTTPS)
                  </label>

                  <label className="flex items-center gap-2 text-xs text-amber-200 cursor-pointer p-2.5 bg-[#0b0f17] border border-amber-700/40 rounded-lg">
                    <input
                      type="checkbox"
                      checked={settings.safe_mode === '1'}
                      onChange={(e) => setSettings({ ...settings, safe_mode: e.target.checked ? '1' : '0' })}
                    />
                    Safe Mode (отключить автостарт проектов)
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* РАЗДЕЛ 2: СИСТЕМНЫЙ TELEGRAM-БОТ, NTFY И WEBHOOK */}
          {showNotif && (
            <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Bot className="w-4 h-4 text-emerald-400" />
                    2. Системный Telegram-бот панели и внешние каналы оповещений
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Доставка уведомлений о падениях проектов, запрос 2FA-кодов (<code className="font-mono">beacon.ask</code>) и управление сервером из чата
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTestNotify}
                    className="px-3 py-1.5 text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Проверить отправку
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTgHelp(!showTgHelp)}
                    className="px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg cursor-pointer"
                  >
                    {showTgHelp ? 'Скрыть подсказку' : 'Где взять Token и Chat ID?'}
                  </button>
                </div>
              </div>

              {showTgHelp && (
                <div className="p-3.5 bg-indigo-950/30 border border-indigo-500/30 rounded-xl text-xs text-slate-300 space-y-1.5">
                  <div className="font-semibold text-indigo-300">Пошаговое подключение системного бота:</div>
                  <div>1. Откройте в Telegram <code className="font-mono text-white">@BotFather</code>, отправьте <code className="font-mono text-emerald-300">/newbot</code> и скопируйте выданный HTTP API Token.</div>
                  <div>2. Напишите вашему новому боту любое сообщение (например, <code className="font-mono">/start</code>).</div>
                  <div>3. Узнайте свой числовой ID через <code className="font-mono text-white">@userinfobot</code> и вставьте его в поле «Admin Chat ID» ниже.</div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Токен системного бота (<code className="font-mono text-emerald-300">tg_bot_token</code>)
                  </label>
                  <input
                    type="password"
                    placeholder="123456789:AAH... (из @BotFather)"
                    value={settings.tg_bot_token || ''}
                    onChange={(e) => setSettings({ ...settings, tg_bot_token: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Личный Admin Chat ID (<code className="font-mono text-emerald-300">tg_chat_id</code>)
                  </label>
                  <input
                    type="text"
                    placeholder="Например: 482910492"
                    value={settings.tg_chat_id || ''}
                    onChange={(e) => setSettings({ ...settings, tg_chat_id: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Доп. разрешённые ID (<code className="font-mono text-indigo-300">tg_allowed_user_ids</code>)
                  </label>
                  <input
                    type="text"
                    placeholder="Через запятую (опционально)"
                    value={settings.tg_allowed_user_ids || ''}
                    onChange={(e) => setSettings({ ...settings, tg_allowed_user_ids: e.target.value })}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                  />
                </div>

                <div className="flex flex-col justify-end">
                  <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer p-2 bg-[#0f172a] border border-slate-700 rounded-lg">
                    <input
                      type="checkbox"
                      checked={settings.tg_use_proxy !== '0'}
                      onChange={(e) => setSettings({ ...settings, tg_use_proxy: e.target.checked ? '1' : '0' })}
                    />
                    Отправлять в ТГ через глобальный прокси
                  </label>
                </div>
              </div>

              {/* Интерактивная проверка команд бота */}
              <div className="p-3.5 bg-[#0f172a] border border-slate-800 rounded-xl space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-300">
                    Быстрый эмулятор команд Telegram-бота (проверка ответа без телефона):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {['/status', '/projects', '/doctor'].map((cmd) => (
                      <button
                        key={cmd}
                        type="button"
                        onClick={() => handleTestTgCommand(cmd)}
                        className="px-2.5 py-1 text-xs font-mono bg-slate-800 hover:bg-indigo-600/30 text-indigo-300 border border-slate-700 rounded cursor-pointer"
                      >
                        Тест {cmd}
                      </button>
                    ))}
                  </div>
                </div>
                {tgCmdPreview && (
                  <pre className="p-3 bg-[#070b14] border border-slate-800 rounded-lg text-xs font-mono text-emerald-300 whitespace-pre-wrap">
                    {tgCmdPreview}
                  </pre>
                )}
              </div>

              {/* Дополнительные каналы: ntfy, Webhook, внешний Heartbeat */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-slate-800">
                <div className="p-3.5 bg-[#0f172a]/80 border border-slate-800 rounded-xl space-y-2">
                  <div className="text-xs font-semibold text-white">Push-уведомления ntfy.sh</div>
                  <p className="text-[11px] text-slate-400">Резервный канал уведомлений на смартфон или ПК</p>
                  <input
                    type="text"
                    placeholder="Сервер (https://ntfy.sh)"
                    value={settings.ntfy_url || ''}
                    onChange={(e) => setSettings({ ...settings, ntfy_url: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                  />
                  <input
                    type="text"
                    placeholder="Имя топика (my_secret_topic)"
                    value={settings.ntfy_topic || ''}
                    onChange={(e) => setSettings({ ...settings, ntfy_topic: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                  />
                </div>

                <div className="p-3.5 bg-[#0f172a]/80 border border-slate-800 rounded-xl space-y-2">
                  <div className="text-xs font-semibold text-white">Внешний Webhook для алертов</div>
                  <p className="text-[11px] text-slate-400">POST JSON при сбоях, OOM и истечении кук</p>
                  <input
                    type="text"
                    placeholder="https://example.com/api/alerts"
                    value={settings.webhook_url || ''}
                    onChange={(e) => setSettings({ ...settings, webhook_url: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                  />
                </div>

                <div className="p-3.5 bg-[#0f172a]/80 border border-slate-800 rounded-xl space-y-2">
                  <div className="text-xs font-semibold text-white">Внешний мониторинг (Uptime Kuma / Healthchecks)</div>
                  <p className="text-[11px] text-slate-400">Панель периодически пингует этот URL, пока жива</p>
                  <input
                    type="text"
                    placeholder="https://hc-ping.com/ваш-uuid"
                    value={settings.outbound_heartbeat_url || ''}
                    onChange={(e) => setSettings({ ...settings, outbound_heartbeat_url: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              </div>
            </div>
          )}

          {/* РАЗДЕЛ 3: ДИСК, РОТАЦИЯ ЛОГОВ, АВТОСТАРТ И ПИТАНИЕ */}
          {showResPower && (
            <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    3. Контроль диска (Disk Guard), ротация логов, планировщик и питание
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Настройка квот хранения логов, плавного старта тяжёлых проектов и защиты по температуре/батарее
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleCleanup}
                  className="px-3.5 py-2 text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 rounded-lg inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Очистить кэш pip / npm, логи и SQLite WAL
                </button>
              </div>

              {/* Диск и ротация логов */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
                <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Предупреждение о диске (МБ)
                  </label>
                  <input
                    type="number"
                    value={settings.disk_warn_mb || '500'}
                    onChange={(e) => setSettings({ ...settings, disk_warn_mb: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <span className="block text-[10px] text-slate-400 mt-1">Жёлтый баннер при нехватке места</span>
                </div>

                <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Критическая блокировка (МБ)
                  </label>
                  <input
                    type="number"
                    value={settings.disk_crit_mb || '150'}
                    onChange={(e) => setSettings({ ...settings, disk_crit_mb: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <span className="block text-[10px] text-slate-400 mt-1">Пауза фоновых задач для защиты БД</span>
                </div>

                <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Макс. размер лог-файла (МБ)
                  </label>
                  <input
                    type="number"
                    value={settings.log_max_size_mb || '10'}
                    onChange={(e) => setSettings({ ...settings, log_max_size_mb: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <span className="block text-[10px] text-slate-400 mt-1">Автоусечение длинных логов</span>
                </div>

                <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Хранить запусков проекта
                  </label>
                  <input
                    type="number"
                    value={settings.log_keep_runs || '20'}
                    onChange={(e) => setSettings({ ...settings, log_keep_runs: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <span className="block text-[10px] text-slate-400 mt-1">Количество историй на каждый проект</span>
                </div>

                <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Срок хранения логов (дней)
                  </label>
                  <input
                    type="number"
                    value={settings.log_keep_days || '14'}
                    onChange={(e) => setSettings({ ...settings, log_keep_days: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                  <span className="block text-[10px] text-slate-400 mt-1">Удаление старых архивов</span>
                </div>
              </div>

              {/* Поведение автозапуска и планировщика */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3.5 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-semibold text-white mb-1">
                    Плавный старт: задержка между автозапусками проектов (сек)
                  </label>
                  <p className="text-[11px] text-slate-400 mb-2">
                    Защищает процессор и диск от пиковой перегрузки при одновременном старте десятков ботов и сайтов
                  </p>
                  <input
                    type="number"
                    min={0}
                    max={300}
                    value={settings.autostart_stagger_sec ?? '2'}
                    onChange={(e) => setSettings({ ...settings, autostart_stagger_sec: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>

                <div className="p-3.5 bg-[#0f172a] border border-slate-800 rounded-xl">
                  <label className="block text-xs font-semibold text-white mb-1">
                    Пропущенные задачи расписания при выключенном сервере (<code className="font-mono text-indigo-300">run_missed</code>)
                  </label>
                  <p className="text-[11px] text-slate-400 mb-2">
                    Что делать с периодическими Job-проектами, чей запуск пришёлся на время простоя сервера
                  </p>
                  <select
                    value={settings.run_missed || 'none'}
                    onChange={(e) => setSettings({ ...settings, run_missed: e.target.value })}
                    className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                  >
                    <option value="none">Ждать следующего планового окна по расписанию (рекомендуется)</option>
                    <option value="once">Запустить пропущенную задачу 1 раз сразу при старте панели</option>
                  </select>
                </div>
              </div>

              {/* Пороги батареи и термозащиты */}
              <div className="p-4 bg-[#0f172a]/70 border border-slate-800 rounded-xl space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Контроль батареи и защита от перегрева (актуально для мобильных серверов и узлов с датчиками)
                    </div>
                    <p className="text-[11px] text-slate-400">
                      На обычных облачных VPS без аккумулятора эти пороги автоматически игнорируются
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-amber-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.thermal_auto_stop !== '0'}
                      onChange={(e) =>
                        setSettings({ ...settings, thermal_auto_stop: e.target.checked ? '1' : '0' })
                      }
                    />
                    Авто-стоп задач при критическом перегреве
                  </label>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Мин. цикл (%)</label>
                    <input
                      type="number"
                      value={settings.battery_min_pct || '40'}
                      onChange={(e) => setSettings({ ...settings, battery_min_pct: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Макс. цикл (%)</label>
                    <input
                      type="number"
                      value={settings.battery_max_pct || '60'}
                      onChange={(e) => setSettings({ ...settings, battery_max_pct: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Тревога разряда (%)</label>
                    <input
                      type="number"
                      value={settings.battery_alert_below_pct || '35'}
                      onChange={(e) => setSettings({ ...settings, battery_alert_below_pct: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Блок запуска (%)</label>
                    <input
                      type="number"
                      value={settings.battery_low_pct || '20'}
                      onChange={(e) => setSettings({ ...settings, battery_low_pct: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Нагрев Warn (°C)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={settings.battery_warn_temp_c || '43'}
                      onChange={(e) => setSettings({ ...settings, battery_warn_temp_c: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Перегрев Crit (°C)</label>
                    <input
                      type="number"
                      step="0.5"
                      value={settings.battery_crit_temp_c || '47'}
                      onChange={(e) => setSettings({ ...settings, battery_crit_temp_c: e.target.value })}
                      className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </form>
      )}

      {/* РАЗДЕЛ 4: ПОЛЬЗОВАТЕЛИ (RBAC), ПОЛНЫЙ БЭКАП И SYSTEMD */}
      {showRbacBackup && (
        <div className="space-y-5">
          {/* Резервное копирование (.zip) и генератор systemd */}
          <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-slate-800">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Download className="w-4 h-4 text-indigo-400" />
                  Резервное копирование сервера (.zip) и служба автозапуска Linux (<code className="font-mono text-indigo-300">systemd</code>)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Архив включает консистентный слепок БД (<code className="font-mono">hub.db</code>), все файлы из <code className="font-mono">data/secrets/</code> и исходный код проектов (без тяжёлых папок <code className="font-mono">.venv / node_modules</code>).
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
                  Предпросмотр beacon.service (systemd)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Интервал автоматического бэкапа (часов, 0 = выключено)
                </label>
                <input
                  type="number"
                  min={0}
                  max={8760}
                  value={settings.auto_backup_interval_hours ?? '24'}
                  onChange={(e) => setSettings({ ...settings, auto_backup_interval_hours: e.target.value })}
                  className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div className="p-3 bg-[#0f172a] border border-slate-800 rounded-xl">
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Сколько последних архивов автобэкапа хранить на диске (шт.)
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={settings.auto_backup_keep ?? '5'}
                  onChange={(e) => setSettings({ ...settings, auto_backup_keep: e.target.value })}
                  className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                />
              </div>
            </div>

            {systemdInfo && (
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between text-xs text-slate-300">
                  <span>
                    Готовый юнит <code className="font-mono text-indigo-300">{systemdInfo.path}</code> (<code className="font-mono text-emerald-300">KillMode=process</code> сохраняет запущенные сервисы при рестарте панели):
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
          </section>

          {/* Управление пользователями и ролями (RBAC) */}
          <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Shield className="w-4 h-4 text-indigo-400" />
                  Пользователи и роли доступа (RBAC)
                </h3>
                <p className="text-xs text-slate-400">
                  <code className="font-mono text-slate-300">viewer</code> — только просмотр,{' '}
                  <code className="font-mono text-slate-300">operator</code> — управление запусками и 2FA-ответами,{' '}
                  <code className="font-mono text-slate-300">admin</code> — полный доступ.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-400">Всего учётных записей: {users.length}</span>
            </div>

            <form onSubmit={handleCreateUser} className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
              <div className="sm:col-span-3">
                <label className="block text-xs text-slate-300 mb-1">Логин (латиница)</label>
                <input
                  type="text"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="operator1"
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div className="sm:col-span-4">
                <label className="block text-xs text-slate-300 mb-1">Пароль (от 8 символов)</label>
                <input
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="Минимум 8 символов"
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                />
              </div>
              <div className="sm:col-span-3">
                <label className="block text-xs text-slate-300 mb-1">Роль доступа</label>
                <select
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value as 'viewer' | 'operator' | 'admin')}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                >
                  <option value="viewer">viewer (только чтение)</option>
                  <option value="operator">operator (запуск и 2FA)</option>
                  <option value="admin">admin (полный доступ)</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  disabled={!newUserName.trim() || newUserPassword.length < 8}
                  className="w-full px-3 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg cursor-pointer"
                >
                  Добавить
                </button>
              </div>
            </form>

            {userMsg && (
              <div
                className={`p-2.5 rounded-lg text-xs ${
                  userMsg.type === 'ok'
                    ? 'bg-emerald-950/50 border border-emerald-500/40 text-emerald-200'
                    : 'bg-red-950/50 border border-red-500/40 text-red-200'
                }`}
              >
                {userMsg.text}
              </div>
            )}

            {users.length > 0 && (
              <div className="overflow-x-auto border border-slate-800 rounded-lg">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="bg-slate-900/60 border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-3">Пользователь</th>
                      <th className="py-2.5 px-3">Роль</th>
                      <th className="py-2.5 px-3">Создан</th>
                      <th className="py-2.5 px-3 text-right">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {users.map((u) => {
                      const isSelf = u.username === currentUsername;
                      const isEditing = editingUserId === u.id;
                      return (
                        <tr key={u.id} className="hover:bg-slate-800/30">
                          <td className="py-2.5 px-3 text-white font-semibold">
                            {u.username}
                            {isSelf && <span className="ml-2 text-[10px] text-indigo-300">(вы)</span>}
                          </td>
                          <td className="py-2.5 px-3">
                            {isEditing ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={editUserRole}
                                  onChange={(e) => setEditUserRole(e.target.value as 'viewer' | 'operator' | 'admin')}
                                  className="bg-[#0f172a] border border-slate-700 rounded px-2 py-1 text-xs text-white"
                                >
                                  <option value="viewer">viewer</option>
                                  <option value="operator">operator</option>
                                  <option value="admin">admin</option>
                                </select>
                                <input
                                  type="password"
                                  value={editUserPassword}
                                  onChange={(e) => setEditUserPassword(e.target.value)}
                                  placeholder="Новый пароль (опц.)"
                                  className="bg-[#0f172a] border border-slate-700 rounded px-2 py-1 text-xs text-white"
                                />
                              </div>
                            ) : (
                              <span className="text-indigo-300">{u.role}</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-400">
                            {new Date(u.created_at * 1000).toLocaleDateString('ru-RU')}
                          </td>
                          <td className="py-2.5 px-3 text-right space-x-2">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleSaveUserEdit(u.id)}
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded cursor-pointer"
                                >
                                  Сохранить
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingUserId(null);
                                    setEditUserPassword('');
                                  }}
                                  className="px-2.5 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded cursor-pointer"
                                >
                                  Отмена
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingUserId(u.id);
                                    setEditUserRole(u.role);
                                    setEditUserPassword('');
                                  }}
                                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded cursor-pointer"
                                >
                                  Изменить
                                </button>
                                <button
                                  type="button"
                                  disabled={isSelf}
                                  onClick={() => handleDeleteUser(u.id)}
                                  className="px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900 disabled:opacity-40 text-rose-200 border border-rose-700/50 rounded cursor-pointer"
                                  title={isSelf ? 'Нельзя удалить собственную учётную запись' : 'Удалить пользователя'}
                                >
                                  Удалить
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {/* РАЗДЕЛ 5: ЖУРНАЛ АУДИТА БЕЗОПАСНОСТИ (отделён от форм и подсказок) */}
      {showAudit && (
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Журнал безопасности и действий в панели ({filteredAuditLogs.length})
                </h3>
                <p className="text-xs text-slate-400">
                  Запись входов, изменений настроек, операций с секретами и запусков проектов
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Фильтр по событию, IP, актору..."
                className="bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 w-56"
              />
              <button
                type="button"
                onClick={loadSettingsAndAudit}
                title="Обновить журнал"
                className="p-2 text-slate-400 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="overflow-x-auto max-h-[380px] overflow-y-auto bg-[#0b0f17]">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900/80 sticky top-0">
                  <th className="py-2.5 px-4 font-medium">Время</th>
                  <th className="py-2.5 px-4 font-medium">Пользователь</th>
                  <th className="py-2.5 px-4 font-medium">IP-адрес</th>
                  <th className="py-2.5 px-4 font-medium">Событие</th>
                  <th className="py-2.5 px-4 font-medium">Подробности</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-xs font-mono">
                {filteredAuditLogs.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-800/30">
                    <td className="py-2 px-4 text-slate-400 whitespace-nowrap">
                      {new Date(a.timestamp * 1000).toLocaleString('ru-RU')}
                    </td>
                    <td className="py-2 px-4 text-emerald-300 whitespace-nowrap">{a.actor || '—'}</td>
                    <td className="py-2 px-4 text-slate-300 whitespace-nowrap">{a.ip}</td>
                    <td className="py-2 px-4 text-indigo-300 font-semibold whitespace-nowrap">{a.action}</td>
                    <td className="py-2 px-4 text-slate-200">{a.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};

