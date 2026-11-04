import React, { useEffect, useState } from 'react';
import {
  Bot,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  PauseCircle,
  PlayCircle,
  Plus,
  Trash2,
  Copy,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal,
  RefreshCw,
  FileDiff,
} from 'lucide-react';
import { ProjectItem } from '../types/hub';

interface AiTokenItem {
  id: number;
  name: string;
  token_prefix: string;
  scopes: string[];
  allowed_projects: string[];
  auto_approve_projects: string[];
  allowed_ips: string;
  rate_limit_per_min: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string;
  is_revoked: number;
  created_at: number;
}

interface AiApprovalItem {
  id: string;
  token_id: number;
  token_name: string;
  action: string;
  project_name: string;
  params: Record<string, any>;
  diff_text: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  result: any;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

interface AiAuditItem {
  id: number;
  timestamp: number;
  token_id: number | null;
  token_name: string;
  ip: string;
  method: string;
  tool_or_path: string;
  project_name: string;
  params_summary: string;
  status: string;
  duration_ms: number;
}

interface AiAccessViewProps {
  projects: ProjectItem[];
  apiFetch: (path: string, options?: RequestInit) => Promise<Response>;
  onRefreshDashboard: () => Promise<void>;
  onOpenSettingsTab: () => void;
}

const AVAILABLE_SCOPES: Array<{ id: string; label: string; desc: string }> = [
  { id: 'read', label: 'read', desc: 'Статус, здоровье, список проектов, логи, имена секретов' },
  { id: 'files:read', label: 'files:read', desc: 'Чтение дерева файлов и исходного кода проектов' },
  { id: 'files:write', label: 'files:write', desc: 'Запись файлов в директории проекта (с diff и подтверждением)' },
  { id: 'run', label: 'run', desc: 'Запуск, остановка, перезапуск и install_deps' },
  { id: 'schedule:write', label: 'schedule:write', desc: 'Изменение расписания cron и restart_policy' },
  { id: 'templates:create', label: 'templates:create', desc: 'Создание проектов строго из шаблонов' },
  { id: 'ask:answer', label: 'ask:answer', desc: 'Ответы на интерактивные запросы aruta.ask()' },
];

export const AiAccessView: React.FC<AiAccessViewProps> = ({
  projects,
  apiFetch,
  onRefreshDashboard,
  onOpenSettingsTab,
}) => {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);
  const [isDefaultPassword, setIsDefaultPassword] = useState<boolean>(true);
  const [tokens, setTokens] = useState<AiTokenItem[]>([]);
  const [approvals, setApprovals] = useState<AiApprovalItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AiAuditItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Форма создания нового токена ИИ
  const [newTokenName, setNewTokenName] = useState<string>('claude-code-agent');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['read', 'files:read', 'files:write', 'run']);
  const [selectedAllowedProjects, setSelectedAllowedProjects] = useState<string[]>(['*']);
  const [selectedAutoApproveProjects, setSelectedAutoApproveProjects] = useState<string[]>([]);
  const [allowedIps, setAllowedIps] = useState<string>('');
  const [rateLimit, setRateLimit] = useState<number>(60);
  const [expiresDays, setExpiresDays] = useState<number>(90);
  const [createdPlainToken, setCreatedPlainToken] = useState<string>('');
  const [copiedConfig, setCopiedConfig] = useState<boolean>(false);

  const loadAiConfig = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/ai/config');
      if (res.ok) {
        const data = await res.json();
        setEnabled(Boolean(data.enabled));
        setPaused(Boolean(data.paused));
        setIsDefaultPassword(Boolean(data.is_default_password));
        setTokens(Array.isArray(data.tokens) ? data.tokens : []);
        setApprovals(Array.isArray(data.approvals) ? data.approvals : []);
        setAuditLogs(Array.isArray(data.audit_log) ? data.audit_log : []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAiConfig();
    const timer = setInterval(loadAiConfig, 3000);
    return () => clearInterval(timer);
  }, []);

  const handleToggleEnabled = async (nextEnabled: boolean) => {
    setStatusMsg(null);
    const res = await apiFetch('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    if (res.ok) {
      await loadAiConfig();
      await onRefreshDashboard();
      setStatusMsg({
        type: 'ok',
        text: nextEnabled ? 'Подсистема доступа ИИ (MCP и /api/v1/) включена.' : 'Доступ ИИ выключен.',
      });
    } else {
      const err = await res.json().catch(() => ({}));
      setStatusMsg({ type: 'err', text: err.detail || 'Не удалось изменить статус доступа ИИ' });
    }
  };

  const handleTogglePause = async (nextPaused: boolean) => {
    setStatusMsg(null);
    const res = await apiFetch('/api/ai/config', {
      method: 'PUT',
      body: JSON.stringify({ paused: nextPaused }),
    });
    if (res.ok) {
      await loadAiConfig();
      await onRefreshDashboard();
      setStatusMsg({
        type: 'ok',
        text: nextPaused
          ? 'Экстренная пауза ИИ включена (все запросы к /mcp и /api/v1/ заблокированы).'
          : 'Пауза ИИ снята.',
      });
    }
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    setCreatedPlainToken('');
    const res = await apiFetch('/api/ai/tokens', {
      method: 'POST',
      body: JSON.stringify({
        name: newTokenName.trim(),
        scopes: selectedScopes,
        allowed_projects: selectedAllowedProjects,
        auto_approve_projects: selectedAutoApproveProjects,
        allowed_ips: allowedIps.trim(),
        rate_limit_per_min: rateLimit,
        expires_days: expiresDays,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setCreatedPlainToken(data.token || '');
      await loadAiConfig();
      setStatusMsg({
        type: 'ok',
        text: `Токен «${data.name}» создан! Скопируйте его ниже — он больше никогда не будет показан.`,
      });
    } else {
      const err = await res.json().catch(() => ({}));
      setStatusMsg({ type: 'err', text: err.detail || 'Ошибка выпуска токена ИИ' });
    }
  };

  const handleRevokeToken = async (tokenId: number) => {
    await apiFetch(`/api/ai/tokens/${tokenId}`, { method: 'DELETE' });
    await loadAiConfig();
  };

  const handleApproveAction = async (approvalId: string) => {
    const res = await apiFetch(`/api/ai/approvals/${approvalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      await loadAiConfig();
      await onRefreshDashboard();
    }
  };

  const handleRejectAction = async (approvalId: string) => {
    const res = await apiFetch(`/api/ai/approvals/${approvalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (res.ok) {
      await loadAiConfig();
      await onRefreshDashboard();
    }
  };

  const toggleScope = (scopeId: string) => {
    setSelectedScopes((prev) => (prev.includes(scopeId) ? prev.filter((s) => s !== scopeId) : [...prev, scopeId]));
  };

  const toggleAutoApproveProject = (projName: string) => {
    setSelectedAutoApproveProjects((prev) =>
      prev.includes(projName) ? prev.filter((p) => p !== projName) : [...prev, projName]
    );
  };

  const mcpEndpointUrl = `${window.location.origin}/mcp`;
  const sampleToken = createdPlainToken || 'beacon_ai_ВАШ_ТОКЕН';
  const claudeCodeConfig = JSON.stringify(
    {
      mcpServers: {
        beacon: {
          type: 'http',
          url: mcpEndpointUrl,
          headers: {
            Authorization: `Bearer ${sampleToken}`,
          },
        },
      },
    },
    null,
    2
  );

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');

  return (
    <div className="space-y-6">
      {/* Блокирующее предупреждение при пароле по умолчанию (Фаза A.1(д)) */}
      {isDefaultPassword && (
        <div className="bg-amber-950/80 border border-amber-500/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-100 space-y-1">
              <div className="font-bold text-amber-300 text-sm">
                Доступ для ИИ заблокирован, пока установлен стандартный пароль «admin»
              </div>
              <p>
                По правилам безопасности Beacon подключение внешних ИИ-агентов (MCP и REST <code className="font-mono">/api/v1/</code>)
                недоступно до смены пароля администратора (минимум 8 символов).
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenSettingsTab}
            className="px-4 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg shrink-0 cursor-pointer"
          >
            Сменить пароль в Настройках
          </button>
        </div>
      )}

      {/* Верхняя панель управления MCP и Kill-Switch */}
      <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <Bot className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-bold text-white">Подсистема доступа ИИ (Streamable HTTP MCP & REST v1)</h2>
            <span
              className={`px-2 py-0.5 text-[11px] font-mono rounded border ${
                enabled && !paused && !isDefaultPassword
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60'
                  : paused
                  ? 'bg-amber-950/70 text-amber-300 border-amber-700/60'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
            >
              {isDefaultPassword
                ? 'ЗАБЛОКИРОВАНО (ПАРОЛЬ ADMIN)'
                : !enabled
                ? 'ВЫКЛЮЧЕНО'
                : paused
                ? 'НА ПАУЗЕ (KILL-SWITCH)'
                : 'АКТИВНО (/mcp)'}
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Точка подключения MCP: <code className="font-mono text-indigo-300">{mcpEndpointUrl}</code> · OpenAPI
            спецификация: <code className="font-mono text-indigo-300">/api/v1/openapi.json</code>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isDefaultPassword}
            onClick={() => handleToggleEnabled(!enabled)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-40 ${
              enabled
                ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {enabled ? 'Выключить доступ ИИ' : 'Разрешить доступ для ИИ'}
          </button>

          <button
            type="button"
            onClick={() => handleTogglePause(!paused)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
              paused
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-rose-600/90 hover:bg-rose-500 text-white'
            }`}
          >
            {paused ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}
            {paused ? 'Возобновить ИИ' : 'Пауза ИИ (Kill-Switch)'}
          </button>

          <button
            type="button"
            onClick={loadAiConfig}
            className="p-2 text-slate-400 hover:text-white bg-[#0b0f17] border border-slate-800 rounded-lg cursor-pointer"
            title="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {statusMsg && (
        <div
          className={`p-3.5 rounded-xl border text-xs font-medium ${
            statusMsg.type === 'ok'
              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/60 border-rose-500/40 text-rose-200'
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Очередь подтверждений действий ИИ (Approval Queue с unified diff) */}
      <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileDiff className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold text-white">
              Очередь подтверждений действий ИИ ({pendingApprovals.length} ожидают)
            </h3>
          </div>
          <span className="text-[11px] text-slate-400">
            Запись файлов, запуск, остановка и смена расписания требуют одобрения владельца
          </span>
        </div>

        {approvals.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-400 bg-[#0b0f17] rounded-lg border border-slate-800/80">
            Заявок от ИИ-агентов пока нет.
          </div>
        ) : (
          <div className="space-y-3">
            {approvals.slice(0, 15).map((item) => (
              <div
                key={item.id}
                className={`p-4 rounded-xl border space-y-3 ${
                  item.status === 'pending'
                    ? 'bg-amber-950/20 border-amber-500/40'
                    : 'bg-[#0b0f17] border-slate-800/80'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`px-2 py-0.5 font-mono text-[10px] rounded uppercase font-semibold ${
                        item.status === 'pending'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : item.status === 'approved'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {item.status}
                    </span>
                    <span className="font-mono font-bold text-indigo-300">{item.action}</span>
                    {item.project_name && (
                      <>
                        <span className="text-slate-600">·</span>
                        <span className="text-white font-semibold">Проект: {item.project_name}</span>
                      </>
                    )}
                    <span className="text-slate-600">·</span>
                    <span className="text-slate-400">Токен: {item.token_name}</span>
                  </div>

                  {item.status === 'pending' && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleApproveAction(item.id)}
                        className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Одобрить и выполнить
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRejectAction(item.id)}
                        className="px-3 py-1.5 text-xs font-semibold bg-rose-600/80 hover:bg-rose-500 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Отклонить
                      </button>
                    </div>
                  )}
                </div>

                {item.diff_text && (
                  <pre className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-[11px] font-mono text-slate-200 overflow-x-auto max-h-60">
                    {item.diff_text}
                  </pre>
                )}

                {!item.diff_text && item.params && (
                  <div className="text-[11px] font-mono text-slate-400 truncate">
                    Параметры: {JSON.stringify(item.params)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Сетка: Создание токена + Конфиг для Claude Code / Cursor */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleCreateToken}
          className="lg:col-span-7 bg-[#111622] border border-[#1e2638] rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <KeyRound className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-bold text-white">Выпустить новый API-токен для ИИ</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-300 mb-1">Название токена (агента)</label>
              <input
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="claude-code-desktop"
                className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Разрешённые IP / CIDR (пусто = любые из подсети)</label>
              <input
                type="text"
                value={allowedIps}
                onChange={(e) => setAllowedIps(e.target.value)}
                placeholder="127.0.0.1, 192.168.1.0/24"
                className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Лимит запросов в минуту (Rate Limit)</label>
              <input
                type="number"
                min={5}
                max={600}
                value={rateLimit}
                onChange={(e) => setRateLimit(Number(e.target.value))}
                className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Срок действия (дней)</label>
              <input
                type="number"
                min={1}
                max={3650}
                value={expiresDays}
                onChange={(e) => setExpiresDays(Number(e.target.value))}
                className="w-full bg-[#0b0f17] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-300">Разрешения (Scopes)</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {AVAILABLE_SCOPES.map((sc) => (
                <label
                  key={sc.id}
                  className="flex items-start gap-2 p-2 bg-[#0b0f17] border border-slate-800 rounded-lg cursor-pointer hover:border-slate-700"
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(sc.id)}
                    onChange={() => toggleScope(sc.id)}
                    className="mt-0.5"
                  />
                  <div className="text-xs">
                    <div className="font-mono font-semibold text-indigo-300">{sc.label}</div>
                    <div className="text-[11px] text-slate-400 leading-snug">{sc.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {projects.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                Проекты с авто-одобрением (без постановки в очередь подтверждений)
              </label>
              <div className="flex flex-wrap gap-2">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggleAutoApproveProject(p.name)}
                    className={`px-2.5 py-1 text-xs font-mono rounded-lg border cursor-pointer ${
                      selectedAutoApproveProjects.includes(p.name)
                        ? 'bg-emerald-950/70 text-emerald-300 border-emerald-600/60'
                        : 'bg-[#0b0f17] text-slate-400 border-slate-800'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={isDefaultPassword || !newTokenName.trim() || selectedScopes.length === 0}
            className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Создать токен ИИ (SHA-256)
          </button>

          {createdPlainToken && (
            <div className="p-3.5 bg-emerald-950/60 border border-emerald-500/50 rounded-xl space-y-2">
              <div className="text-xs font-bold text-emerald-300">
                Сохраните ваш токен (показывается только один раз):
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 p-2 bg-slate-950 rounded border border-emerald-500/40 font-mono text-xs text-white select-all break-all">
                  {createdPlainToken}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(createdPlainToken);
                    setCopiedConfig(true);
                    setTimeout(() => setCopiedConfig(false), 2000);
                  }}
                  className="px-3 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1 cursor-pointer shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copiedConfig ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
            </div>
          )}
        </form>

        {/* Правая карточка: Готовый конфиг MCP для Claude Code / Cursor */}
        <div className="lg:col-span-5 bg-[#111622] border border-[#1e2638] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-indigo-400" />
              <h3 className="text-sm font-bold text-white">Подключение Claude Code / Cursor</h3>
            </div>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(claudeCodeConfig)}
              className="px-2.5 py-1 text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded inline-flex items-center gap-1 cursor-pointer"
            >
              <Copy className="w-3 h-3" />
              JSON
            </button>
          </div>

          <p className="text-xs text-slate-400">
            Добавьте этот блок в <code className="font-mono text-slate-200">~/.claude.json</code> или{' '}
            <code className="font-mono text-slate-200">.cursor/mcp.json</code>:
          </p>

          <pre className="p-3 bg-[#0b0f17] border border-slate-800 rounded-lg font-mono text-[11px] text-indigo-200 overflow-x-auto">
            {claudeCodeConfig}
          </pre>

          <div className="p-3 bg-[#0b0f17] border border-slate-800/80 rounded-lg space-y-1.5 text-[11px] text-slate-400">
            <div className="font-semibold text-slate-200 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Гарантии защиты от Prompt Injection:
            </div>
            <ul className="list-disc list-inside space-y-1">
              <li>Значения секретов и куки никогда не передаются ИИ (только имена).</li>
              <li>Вывод логов оборачивается в теги &lt;untrusted_content&gt;.</li>
              <li>Произвольный shell exec недоступен по токену ИИ.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Список выпущенных токенов */}
      <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-bold text-white">Выпущенные токены ИИ ({tokens.length})</h3>
        {tokens.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">Активных токенов нет.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-3">Имя</th>
                  <th className="py-2 pr-3">Префикс</th>
                  <th className="py-2 pr-3">Права (Scopes)</th>
                  <th className="py-2 pr-3">Лимит</th>
                  <th className="py-2 pr-3">Статус</th>
                  <th className="py-2 text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td className="py-2.5 pr-3 font-semibold text-white">{t.name}</td>
                    <td className="py-2.5 pr-3 font-mono text-slate-300">{t.token_prefix}...</td>
                    <td className="py-2.5 pr-3 font-mono text-[11px] text-indigo-300">
                      {(t.scopes || []).join(', ')}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-slate-400">{t.rate_limit_per_min}/мин</td>
                    <td className="py-2.5 pr-3">
                      {t.is_revoked ? (
                        <span className="text-rose-400 font-mono text-[11px]">ОТОЗВАН</span>
                      ) : (
                        <span className="text-emerald-400 font-mono text-[11px]">АКТИВЕН</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {!t.is_revoked && (
                        <button
                          type="button"
                          onClick={() => handleRevokeToken(t.id)}
                          className="px-2.5 py-1 text-[11px] bg-rose-950/70 hover:bg-rose-900 text-rose-200 rounded border border-rose-700/50 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                          Отозвать
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Журнал аудита действий ИИ */}
      <div className="bg-[#111622] border border-[#1e2638] rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-bold text-white">Журнал действий ИИ (ai_audit_log)</h3>
        </div>
        {auditLogs.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center">Записей в журнале действий ИИ пока нет.</div>
        ) : (
          <div className="overflow-x-auto max-h-72">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-1.5 pr-3">Время</th>
                  <th className="py-1.5 pr-3">Токен</th>
                  <th className="py-1.5 pr-3">Инструмент / Путь</th>
                  <th className="py-1.5 pr-3">Проект</th>
                  <th className="py-1.5 pr-3">Статус</th>
                  <th className="py-1.5 text-right">Длит.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 text-[11px]">
                {auditLogs.slice(0, 40).map((log) => (
                  <tr key={log.id}>
                    <td className="py-1.5 pr-3 text-slate-400">
                      {new Date(log.timestamp * 1000).toLocaleTimeString('ru-RU')}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-200">{log.token_name}</td>
                    <td className="py-1.5 pr-3 text-indigo-300">{log.tool_or_path}</td>
                    <td className="py-1.5 pr-3 text-slate-300">{log.project_name || '—'}</td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          log.status === 'ok' || log.status === 'approved'
                            ? 'text-emerald-400'
                            : log.status === 'queued_approval'
                            ? 'text-amber-300'
                            : 'text-rose-400'
                        }
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="py-1.5 text-right text-slate-400">{log.duration_ms} мс</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
