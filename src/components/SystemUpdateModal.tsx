import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  DownloadCloud,
  CheckCircle2,
  GitBranch,
  ShieldCheck,
  X,
  ExternalLink,
  Copy,
  Terminal,
} from 'lucide-react';
import { useI18n } from '../utils/i18n';

export interface SystemUpdateStatus {
  ok: boolean;
  version: string;
  git_available: boolean;
  is_git_repo: boolean;
  branch: string;
  commit: string;
  commit_subject: string;
  remote_url: string;
  has_update: boolean;
  behind_count: number;
  remote_commits: string[];
  dirty_files: number;
  checked_at: number;
  message: string;
}

interface SystemUpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiFetch: (path: string, options?: RequestInit) => Promise<Response>;
  onUpdated?: () => void;
}

export const SystemUpdateModal: React.FC<SystemUpdateModalProps> = ({
  isOpen,
  onClose,
  apiFetch,
  onUpdated,
}) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [checking, setChecking] = useState<boolean>(false);
  const [updating, setUpdating] = useState<boolean>(false);
  const [repoUrlInput, setRepoUrlInput] = useState<string>('https://github.com/VoidAruta/Beacon.git');
  const [branchInput, setBranchInput] = useState<string>('main');
  const [updateSteps, setUpdateSteps] = useState<string[]>([]);
  const [backupFile, setBackupFile] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [copiedCmd, setCopiedCmd] = useState<boolean>(false);

  const fetchUpdateStatus = useCallback(
    async (checkRemote: boolean = false) => {
      setChecking(true);
      setErrorMsg('');
      try {
        const res = await apiFetch(`/api/system/update_status?check_remote=${checkRemote ? '1' : '0'}`);
        if (res.ok) {
          const data: SystemUpdateStatus = await res.json();
          setStatus(data);
          if (data.remote_url) setRepoUrlInput(data.remote_url);
          if (data.branch) setBranchInput(data.branch);
        } else {
          const err = await res.json().catch(() => ({}));
          setErrorMsg(err.detail || t('Не удалось проверить статус обновлений', 'Failed to check update status'));
        }
      } catch (e: any) {
        setErrorMsg(e?.message || t('Сетевая ошибка при проверке обновлений', 'Network error checking updates'));
      } finally {
        setChecking(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    if (isOpen) {
      setUpdateSteps([]);
      setBackupFile('');
      fetchUpdateStatus(false);
    }
  }, [isOpen, fetchUpdateStatus]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !updating) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, updating, onClose]);

  if (!isOpen) return null;

  const handleRunSelfUpdate = async () => {
    if (updating) return;
    setUpdating(true);
    setErrorMsg('');
    setUpdateSteps([
      t(
        'Запуск безопасного обновления Beacon (создание резервной копии, git pull, миграция БД)...',
        'Starting safe Beacon self-update (pre-update backup, git pull, DB migration)...'
      ),
    ]);
    try {
      const res = await apiFetch('/api/system/self_update', {
        method: 'POST',
        body: JSON.stringify({
          repo_url: repoUrlInput.trim(),
          branch: branchInput.trim() || 'main',
        }),
      });
      const data = await res.json();
      if (res.ok) {
        if (Array.isArray(data.steps)) {
          setUpdateSteps(data.steps);
        }
        if (data.backup_file) {
          setBackupFile(String(data.backup_file));
        }
        if (data.status) {
          setStatus(data.status);
        }
        onUpdated?.();
      } else {
        setErrorMsg(data.detail || t('Ошибка при обновлении панели', 'Error updating panel'));
      }
    } catch (e: any) {
      setErrorMsg(e?.message || t('Сетевой сбой при выполнении обновления', 'Network error during self-update'));
    } finally {
      setUpdating(false);
    }
  };

  const cliUpdateSnippet = `git pull --ff-only origin ${branchInput || 'main'} && npm run build && python3 -m beacon migrate`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Центр обновлений Beacon', 'Beacon Update Center')}
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#111622] border border-[#1e2638] rounded-xl max-w-2xl w-full p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-[#1e2638] pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
              <DownloadCloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                {t('Центр обновлений Beacon (Self-Update)', 'Beacon Self-Update Center')}
              </h2>
              <p className="text-xs text-slate-400">
                {t(
                  'Обновление из Git в пару кликов с автоматическим бэкапом и без остановки запущенных ботов (No SIGPIPE)',
                  'Two-click Git update with automatic backup and zero-downtime process recovery (No SIGPIPE)'
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t('Закрыть окно обновлений', 'Close update modal')}
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Текущий статус версии и Git */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div className="p-3 rounded-lg bg-[#0b0f17] border border-[#1e2638]">
            <div className="text-[11px] text-slate-400 uppercase font-mono">
              {t('Текущая версия', 'Current Version')}
            </div>
            <div className="text-sm font-bold text-white font-mono mt-0.5 flex items-center gap-2">
              <span>v{status?.version || '2.4.1'}</span>
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                Stable
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0b0f17] border border-[#1e2638]">
            <div className="text-[11px] text-slate-400 uppercase font-mono">
              {t('Ветка / Коммит Git', 'Git Branch / Commit')}
            </div>
            <div className="text-sm font-bold text-indigo-300 font-mono mt-0.5 flex items-center gap-1.5 truncate">
              <GitBranch className="w-3.5 h-3.5 shrink-0" />
              <span>
                {status?.branch || 'main'} @ {status?.commit || 'standalone'}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0b0f17] border border-[#1e2638]">
            <div className="text-[11px] text-slate-400 uppercase font-mono">
              {t('Статус обновлений', 'Update Status')}
            </div>
            <div className="text-xs font-semibold mt-1">
              {status?.has_update ? (
                <span className="text-amber-300">
                  {t(`Доступно +${status.behind_count} коммитов`, `+${status.behind_count} new commits available`)}
                </span>
              ) : (
                <span className="text-emerald-300 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {t('Актуальная сборка', 'Up to date')}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Поля репозитория и ветки */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 bg-[#0b0f17] p-3.5 rounded-xl border border-[#1e2638]">
          <div className="sm:col-span-9">
            <label className="block text-[11px] text-slate-300 mb-1 font-medium">
              {t('Официальный Git-репозиторий для обновлений (origin)', 'Git Repository URL for updates (origin)')}
            </label>
            <input
              type="text"
              value={repoUrlInput}
              onChange={(e) => setRepoUrlInput(e.target.value)}
              placeholder="https://github.com/VoidAruta/Beacon.git"
              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white outline-none focus:border-indigo-500"
            />
          </div>
          <div className="sm:col-span-3">
            <label className="block text-[11px] text-slate-300 mb-1 font-medium">
              {t('Ветка', 'Branch')}
            </label>
            <input
              type="text"
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              placeholder="main"
              className="w-full bg-[#111622] border border-[#1e2638] rounded-lg px-3 py-1.5 text-xs font-mono text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div className="sm:col-span-12 flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-300">
            <span className="text-slate-400">
              {status?.message ||
                t('Нажмите «Проверить обновления», чтобы опросить удалённый Git.', 'Click "Check for Updates" to query remote Git.')}
            </span>
            {repoUrlInput.startsWith('http') && (
              <a
                href={repoUrlInput.replace(/\.git$/, '')}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-300 hover:text-white inline-flex items-center gap-1 font-mono text-[11px]"
              >
                <span>GitHub</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>

        {/* Список новых коммитов, если есть */}
        {status?.remote_commits && status.remote_commits.length > 0 && (
          <div className="p-3 bg-indigo-950/30 border border-indigo-500/40 rounded-lg space-y-1.5">
            <div className="text-xs font-semibold text-indigo-200">
              {t('Новые изменения в репозитории:', 'Incoming commits from remote:')}
            </div>
            <ul className="text-xs font-mono text-indigo-100 space-y-1 max-h-32 overflow-y-auto">
              {status.remote_commits.map((c, idx) => (
                <li key={idx} className="truncate">
                  • {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Лог выполнения обновления */}
        {updateSteps.length > 0 && (
          <div className="p-3.5 bg-[#070b14] border border-emerald-500/40 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-emerald-300">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" />
                {t('Журнал безопасного обновления:', 'Safe Update Log:')}
              </span>
              {backupFile && (
                <span className="text-[11px] font-mono text-slate-400">
                  Backup: <code className="text-emerald-300">{backupFile}</code>
                </span>
              )}
            </div>
            <div className="text-xs font-mono text-slate-200 space-y-1">
              {updateSteps.map((step, i) => (
                <div key={i}>{step}</div>
              ))}
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 bg-rose-950/60 border border-rose-500/50 rounded-lg text-xs text-rose-200 font-mono">
            {errorMsg}
          </div>
        )}

        {/* Однострочная команда для терминала */}
        <div className="p-2.5 bg-[#0b0f17] border border-[#1e2638] rounded-lg flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
          <div className="flex items-center gap-2 truncate">
            <Terminal className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span className="truncate">{cliUpdateSnippet}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(cliUpdateSnippet);
              setCopiedCmd(true);
              setTimeout(() => setCopiedCmd(false), 2000);
            }}
            className="px-2 py-1 rounded bg-[#111622] hover:bg-slate-800 text-slate-200 border border-[#1e2638] inline-flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <Copy className="w-3 h-3" />
            <span>{copiedCmd ? t('Скопировано', 'Copied') : t('Команда CLI', 'CLI Cmd')}</span>
          </button>
        </div>

        {/* Кнопки действий в 2 клика */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-[#1e2638]">
          <button
            type="button"
            disabled={checking || updating}
            onClick={() => fetchUpdateStatus(true)}
            className="px-3.5 py-2 text-xs font-semibold text-slate-200 hover:text-white bg-[#0b0f17] hover:bg-slate-800 border border-[#1e2638] rounded-lg inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-indigo-400 ${checking ? 'animate-spin' : ''}`} />
            <span>
              {checking
                ? t('Проверка Git...', 'Checking Git...')
                : t('1. Проверить обновления в Git', '1. Check for Git Updates')}
            </span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
            >
              {t('Закрыть', 'Close')}
            </button>
            <button
              type="button"
              disabled={updating}
              onClick={handleRunSelfUpdate}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <DownloadCloud className={`w-4 h-4 ${updating ? 'animate-bounce' : ''}`} />
              <span>
                {updating
                  ? t('Обновление...', 'Updating...')
                  : t('2. Обновить панель (с авто-бэкапом)', '2. Update Panel Now (with Auto-Backup)')}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
