import React, { useState } from 'react';
import {
  Key,
  Cookie,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  FolderCode,
  MessageSquareWarning,
  Send,
} from 'lucide-react';
import { PendingAsk, ProjectItem, SecretItem } from '../types/hub';
import { formatBytes, validateCookieEditorJson } from '../utils/hubLogic';

interface SecretsViewProps {
  secrets: SecretItem[];
  projects: ProjectItem[];
  pendingAsks?: PendingAsk[];
  onAnswerAsk?: (askId: string, answer: string) => Promise<void>;
  onSaveSecret: (name: string, type: 'text' | 'file' | 'cookie_json', value: string, targetProjectId?: number) => Promise<void>;
  onImportCookieJson: (name: string, rawJson: string, targetProjectId?: number) => Promise<void>;
  onExpireCookie: (name: string) => Promise<void>;
  onDeleteSecret: (name: string) => Promise<void>;
}

const DEFAULT_COOKIE_SAMPLE = JSON.stringify(
  [
    {
      domain: '.example.com',
      name: 'auth_session',
      value: 'cookie_editor_imported_token_88412',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  ],
  null,
  2
);

export const SecretsView: React.FC<SecretsViewProps> = ({
  secrets,
  projects,
  pendingAsks = [],
  onAnswerAsk,
  onSaveSecret,
  onImportCookieJson,
  onExpireCookie,
  onDeleteSecret,
}) => {
  const [name, setName] = useState('');
  const [secType, setSecType] = useState<'text' | 'file' | 'cookie_json'>('text');
  const [targetSecProjId, setTargetSecProjId] = useState<string>('global');
  const [value, setValue] = useState('');
  const [formMsg, setFormMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [askAnswers, setAskAnswers] = useState<Record<string, string>>({});

  const [cookieTargetProjId, setCookieTargetProjId] = useState<string>(
    projects[0] ? String(projects[0].id) : 'global'
  );
  const [cookieName, setCookieName] = useState(
    projects[0] ? `${projects[0].name}_cookies` : 'my_cookies'
  );
  const [cookieJson, setCookieJson] = useState(DEFAULT_COOKIE_SAMPLE);
  const [cookieMsg, setCookieMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const handleCookieProjectChange = (val: string) => {
    setCookieTargetProjId(val);
    if (val === 'global') {
      setCookieName('my_cookies');
    } else {
      const p = projects.find((x) => String(x.id) === val);
      if (p) {
        setCookieName(`${p.name}_cookies`);
      }
    }
  };

  const handleCreateSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormMsg(null);
    const cleanName = name.trim();
    if (!cleanName) {
      setFormMsg({ type: 'err', text: 'Укажите имя секрета латиницей' });
      return;
    }
    try {
      const pid = targetSecProjId !== 'global' ? Number(targetSecProjId) : undefined;
      await onSaveSecret(cleanName, secType, value, pid);
      setName('');
      setValue('');
      setFormMsg({
        type: 'ok',
        text: `Секрет «${cleanName}» сохранён в /opt/hub/data/secrets/${cleanName} (права 0600)${
          pid ? ' и привязан к выбранному проекту' : ''
        }.`,
      });
    } catch (err: any) {
      setFormMsg({ type: 'err', text: err?.message || 'Ошибка сохранения секрета' });
    }
  };

  const handleImportCookie = async (e: React.FormEvent) => {
    e.preventDefault();
    setCookieMsg(null);
    const check = validateCookieEditorJson(cookieJson);
    if (!check.valid) {
      setCookieMsg({ type: 'err', text: check.error || 'Ошибка структуры Cookie-Editor JSON' });
      return;
    }
    try {
      const pid = cookieTargetProjId !== 'global' ? Number(cookieTargetProjId) : undefined;
      await onImportCookieJson(cookieName.trim(), cookieJson, pid);
      const projObj = projects.find((x) => x.id === pid);
      setCookieMsg({
        type: 'ok',
        text: `Импортировано ${check.cookies.length} куки (${check.domains.join(', ')}) в «${cookieName.trim()}»${
          projObj ? ` специально для проекта «${projObj.name}»` : ''
        }.`,
      });
    } catch (err: any) {
      setCookieMsg({ type: 'err', text: err?.message || 'Ошибка импорта куки' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Центр событий и интерактивных запросов hub.ask() */}
      <section className="bg-[#111622] border border-slate-800 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <MessageSquareWarning className="w-4 h-4 text-amber-400" />
            <div>
              <h2 className="text-sm font-bold text-white">
                Центр событий и интерактивных запросов (<code className="font-mono text-amber-300">hub.ask()</code> / <code className="font-mono text-indigo-300">cookies_expired</code>)
              </h2>
              <p className="text-[11px] text-slate-400">
                Активные запросы на ввод одноразового кода (2FA / SMS / капча) от запущенных процессов
              </p>
            </div>
          </div>
          <span className="text-xs font-mono text-slate-400 tabular-nums">
            Ожидают ответа: {pendingAsks.length} · Протухших куки: {secrets.filter((s) => s.is_expired === 1).length}
          </span>
        </div>

        {pendingAsks.length > 0 ? (
          <div className="mt-3 space-y-2.5">
            {pendingAsks.map((ask) => (
              <div
                key={ask.id}
                className="p-3 bg-amber-950/30 border border-amber-500/40 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="text-xs">
                  <div className="font-semibold text-amber-200">
                    Проект <span className="font-mono text-white">{ask.project_name}</span> ожидает ввод (Run #{ask.run_id}):
                  </div>
                  <div className="text-slate-200 mt-0.5 font-mono">{ask.prompt}</div>
                </div>
                {onAnswerAsk && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const val = (askAnswers[ask.id] || '').trim();
                      if (!val) return;
                      await onAnswerAsk(ask.id, val);
                      setAskAnswers((prev) => ({ ...prev, [ask.id]: '' }));
                    }}
                    className="flex items-center gap-2 shrink-0"
                  >
                    <input
                      type="text"
                      value={askAnswers[ask.id] || ''}
                      onChange={(e) => setAskAnswers((prev) => ({ ...prev, [ask.id]: e.target.value }))}
                      placeholder="Введите код / ответ..."
                      className="bg-[#0b0f17] border border-amber-500/40 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Отправить
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 text-xs text-slate-400 flex items-center justify-between">
            <span>Нет зависших на вводе процессов (WAITING_INPUT = 0). Все боты и парсеры работают штатно.</span>
          </div>
        )}
      </section>

      {/* Поясняющая плашка: Индивидуальные куки скриптов vs Общие секреты */}
      <div className="bg-[#111622] border border-slate-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div className="flex items-start gap-2.5">
          <Cookie className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-white">Индивидуальные куки для конкретного скрипта:</span>{' '}
            <span className="text-slate-300">
              у каждого парсера или бота обычно свой аккаунт и свои куки. Выберите нужный проект в списке ниже (или прямо внутри вкладки «Проекты и Код» → «2. Куки и Telegram скрипта»), и куки привяжутся только к нему.
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <Key className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-white">Текстовые секреты и API-ключи:</span>{' '}
            <span className="text-slate-300">
              все значения хранятся на диске с правами <code className="font-mono">0600</code> и автоматически вырезаются из всех логов (<code className="font-mono">***SECRET:имя***</code>), чтобы ваши токены случайно не утекли.
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 1. Импорт Cookie-Editor с выбором целевого проекта */}
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-800">
            <Cookie className="w-4 h-4 text-amber-400" />
            <div>
              <h2 className="text-sm font-bold text-white">
                Импорт куки из расширения Cookie-Editor (для выбранного скрипта)
              </h2>
              <p className="text-[11px] text-slate-400">
                Скопируйте JSON из расширения Cookie-Editor в браузере и выберите, для какого скрипта эти куки
              </p>
            </div>
          </div>

          <form onSubmit={handleImportCookie} className="mt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cookie-project-select" className="block text-xs text-slate-300 mb-1">
                  Для какого проекта эти куки?
                </label>
                <select
                  id="cookie-project-select"
                  value={cookieTargetProjId}
                  onChange={(e) => handleCookieProjectChange(e.target.value)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      Проект: {p.name} (индивидуальные куки)
                    </option>
                  ))}
                  <option value="global">Общие куки (для нескольких скриптов)</option>
                </select>
              </div>

              <div>
                <label htmlFor="cookie-secret-name" className="block text-xs text-slate-300 mb-1">
                  Имя секрета (<code className="font-mono text-indigo-300">hub.secret("...")</code>)
                </label>
                <input
                  id="cookie-secret-name"
                  type="text"
                  value={cookieName}
                  onChange={(e) => setCookieName(e.target.value)}
                  placeholder="sms-auth-bot_cookies"
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                />
              </div>
            </div>

            <div>
              <label htmlFor="cookie-json-input" className="block text-xs text-slate-300 mb-1">
                JSON-массив куки (автоматическая проверка полей <code className="font-mono">name, value, domain</code>)
              </label>
              <textarea
                id="cookie-json-input"
                rows={6}
                value={cookieJson}
                onChange={(e) => setCookieJson(e.target.value)}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg p-3 font-mono text-xs text-slate-100"
              />
            </div>

            {cookieMsg && (
              <div
                className={`p-2.5 rounded-lg text-xs ${
                  cookieMsg.type === 'ok'
                    ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-200'
                    : 'bg-red-950/60 border border-red-500/40 text-red-200'
                }`}
              >
                {cookieMsg.text}
              </div>
            )}

            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              Сохранить куки и привязать к скрипту
            </button>
          </form>
        </section>

        {/* 2. Создание / обновление текстового или файлового секрета */}
        <section className="bg-[#1e293b] border border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 pb-3 border-b border-slate-800">
            <Key className="w-4 h-4 text-emerald-400" />
            <div>
              <h2 className="text-sm font-bold text-white">
                Добавить API-ключ, пароль или токен (с авто-маскировкой в логах)
              </h2>
              <p className="text-[11px] text-slate-400">
                Любая строка длиной от 4 символов будет скрыта в консоли вывода как ***SECRET:имя***
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateSecret} className="mt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="new-secret-name" className="block text-xs text-slate-300 mb-1">
                  Имя секрета
                </label>
                <input
                  id="new-secret-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="openai_api_key"
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                />
              </div>

              <div>
                <label htmlFor="new-secret-type" className="block text-xs text-slate-300 mb-1">
                  Тип данных
                </label>
                <select
                  id="new-secret-type"
                  value={secType}
                  onChange={(e) => setSecType(e.target.value as any)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="text">Текстовый ключ / токен</option>
                  <option value="file">Секретный файл (0600)</option>
                  <option value="cookie_json">JSON куки</option>
                </select>
              </div>

              <div>
                <label htmlFor="new-secret-proj" className="block text-xs text-slate-300 mb-1">
                  Привязать к проекту
                </label>
                <select
                  id="new-secret-proj"
                  value={targetSecProjId}
                  onChange={(e) => setTargetSecProjId(e.target.value)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="global">Общий (выбрать в проекте)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      Только для: {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="new-secret-val" className="block text-xs text-slate-300 mb-1">
                Значение секрета (сохраняется в <code className="font-mono">/opt/hub/data/secrets/&lt;имя&gt;</code>)
              </label>
              <textarea
                id="new-secret-val"
                rows={5}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Вставьте сюда токен, пароль или содержимое ключа..."
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg p-3 font-mono text-xs text-slate-100"
              />
            </div>

            {formMsg && (
              <div
                className={`p-2.5 rounded-lg text-xs ${
                  formMsg.type === 'ok'
                    ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-200'
                    : 'bg-red-950/60 border border-red-500/40 text-red-200'
                }`}
              >
                {formMsg.text}
              </div>
            )}

            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Сохранить секрет
            </button>
          </form>
        </section>
      </div>

      {/* 3. Таблица всех куки и секретов с указанием, какому проекту они принадлежат */}
      <section className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white">Все куки проектов и секреты (/opt/hub/data/secrets)</h3>
            <p className="text-xs text-slate-400">
              Видно, к какому конкретному скрипту привязаны куки и каков их текущий статус
            </p>
          </div>
          <span className="text-xs font-mono text-slate-400 tabular-nums">Всего записей: {secrets.length}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 bg-slate-900/50">
                <th className="py-3 px-4 font-medium">Имя в коде</th>
                <th className="py-3 px-4 font-medium">Тип</th>
                <th className="py-3 px-4 font-medium">Какому проекту принадлежит</th>
                <th className="py-3 px-4 font-medium">Размер и файл (0600)</th>
                <th className="py-3 px-4 font-medium">Статус</th>
                <th className="py-3 px-4 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-sm">
              {secrets.map((s) => {
                const usedBy = s.used_by_projects || [];
                return (
                  <tr key={s.name} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-mono font-semibold text-white">{s.name}</td>
                    <td className="py-3 px-4 font-mono text-xs text-indigo-300">
                      {s.type === 'cookie_json' ? 'Куки (JSON)' : s.type === 'text' ? 'Текст / Токен' : 'Файл'}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {usedBy.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {usedBy.map((projName) => (
                            <span
                              key={projName}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-950/70 text-indigo-200 border border-indigo-500/30 rounded font-mono text-[11px]"
                            >
                              <FolderCode className="w-3 h-3 text-indigo-400" />
                              {projName}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-400">Общий (не привязан)</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-400">
                      <div>{formatBytes(s.size_bytes)} · {s.masked_value}</div>
                      <div className="text-[11px] text-slate-500 truncate max-w-[220px]">{s.file_path}</div>
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {s.is_expired === 1 ? (
                        <span className="text-red-400 font-medium inline-flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          ИСТЕКЛИ ({s.expired_note || 'требуется замена'})
                        </span>
                      ) : (
                        <span className="text-emerald-400 font-medium">Актуален (OK)</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        {s.type === 'cookie_json' && s.is_expired === 0 && (
                          <button
                            type="button"
                            onClick={() => onExpireCookie(s.name)}
                            className="px-2.5 py-1 text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            Симулировать протухание
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Удалить секрет ${s.name}`}
                          onClick={() => onDeleteSecret(s.name)}
                          className="p-1.5 text-slate-400 hover:text-red-400 bg-slate-800 rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
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
    </div>
  );
};
