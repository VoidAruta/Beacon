import React, { useState } from 'react';
import {
  Plus,
  X,
  Bot,
  Clock,
  Cookie,
  FileCode,
  Terminal,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Send,
} from 'lucide-react';
import { describeScheduleHuman, validateCookieEditorJson } from '../utils/hubLogic';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: Record<string, any>) => Promise<void>;
}

type SchedulePreset = 'manual' | 'every_minutes' | 'every_hours' | 'daily_time' | 'custom_cron';

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'service' | 'job'>('service');
  const [template, setTemplate] = useState<'python' | 'cookie_parser' | 'tg_bot' | 'node' | 'bash'>('python');
  const [useProxy, setUseProxy] = useState(false);

  // Понятный конструктор расписания для скриптов (job)
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('every_minutes');
  const [everyMinutes, setEveryMinutes] = useState<number>(15);
  const [everyHours, setEveryHours] = useState<number>(1);
  const [dailyTime, setDailyTime] = useState<string>('09:00');
  const [customCron, setCustomCron] = useState<string>('*/15 * * * *');

  // Простые настройки для постоянной программы (service)
  const [autostart, setAutostart] = useState(true);
  const [restartPolicy, setRestartPolicy] = useState<'always' | 'on-failure' | 'no'>('on-failure');

  // Опциональные индивидуальные данные проекта (Куки и Telegram самого скрипта)
  const [showOptionalData, setShowOptionalData] = useState(false);
  const [initialCookieJson, setInitialCookieJson] = useState('');
  const [projBotToken, setProjBotToken] = useState('');
  const [projChatId, setProjChatId] = useState('');

  // Расширенные настройки для продвинутых
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ramLimitMb, setRamLimitMb] = useState(128);
  const [customCmd, setCustomCmd] = useState('');

  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const runtimeMap: Record<typeof template, 'python' | 'node' | 'bash'> = {
    python: 'python',
    cookie_parser: 'python',
    tg_bot: 'python',
    node: 'node',
    bash: 'bash',
  };

  const computeScheduleConfig = (): { schedule_type: 'manual' | 'cron' | 'interval'; schedule_expr: string } => {
    if (type === 'service') {
      return { schedule_type: 'manual', schedule_expr: '' };
    }
    switch (schedulePreset) {
      case 'manual':
        return { schedule_type: 'manual', schedule_expr: '' };
      case 'every_minutes': {
        const mins = Math.max(1, Math.min(59, Number(everyMinutes) || 15));
        return { schedule_type: 'cron', schedule_expr: `*/${mins} * * * *` };
      }
      case 'every_hours': {
        const hrs = Math.max(1, Math.min(24, Number(everyHours) || 1));
        return { schedule_type: 'interval', schedule_expr: String(hrs * 3600) };
      }
      case 'daily_time': {
        const [hhStr, mmStr] = (dailyTime || '09:00').split(':');
        const hh = Math.max(0, Math.min(23, Number(hhStr) || 9));
        const mm = Math.max(0, Math.min(59, Number(mmStr) || 0));
        return { schedule_type: 'cron', schedule_expr: `${mm} ${hh} * * *` };
      }
      case 'custom_cron':
        return { schedule_type: 'cron', schedule_expr: customCron.trim() || '*/15 * * * *' };
    }
  };

  const currentSched = computeScheduleConfig();
  const humanPreview = describeScheduleHuman(
    type,
    currentSched.schedule_type,
    currentSched.schedule_expr,
    restartPolicy,
    autostart
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const cleanName = name.trim();
    if (!cleanName) {
      setError('Укажите короткое имя проекта латиницей (например: my-parser или tg-helper)');
      return;
    }

    if (initialCookieJson.trim()) {
      const check = validateCookieEditorJson(initialCookieJson);
      if (!check.valid) {
        setError(`Ошибка в JSON куки: ${check.error}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const envObj: Record<string, string> = {};
      if (description.trim()) {
        envObj.PROJECT_DESCRIPTION = description.trim();
      }
      if (projBotToken.trim()) {
        envObj.BOT_TOKEN = projBotToken.trim();
      }
      if (projChatId.trim()) {
        envObj.TG_CHAT_ID = projChatId.trim();
      }

      await onCreate({
        name: cleanName,
        type,
        runtime: runtimeMap[template],
        template,
        cmd: customCmd.trim() || undefined,
        use_proxy: template === 'tg_bot' || template === 'cookie_parser' ? true : useProxy,
        ram_limit_mb: ramLimitMb,
        schedule_type: currentSched.schedule_type,
        schedule_expr: currentSched.schedule_expr,
        autostart: type === 'service' ? autostart : false,
        restart_policy: type === 'service' ? restartPolicy : 'no',
        env: envObj,
        initial_cookies_json: initialCookieJson.trim() || undefined,
      });
      setName('');
      setDescription('');
      setInitialCookieJson('');
      setProjBotToken('');
      setProjChatId('');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Ошибка создания проекта');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Создание нового проекта"
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-[#1e293b] border border-slate-700 rounded-xl max-w-2xl w-full p-6 shadow-2xl my-8 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-bold text-white">Мастер создания нового проекта</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Выберите тип работы (постоянная программа или скрипт по расписанию), шаблон и нужные настройки
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрыть модальное окно"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-5">
          {/* ШАГ 1: Понятный выбор типа проекта с объяснением разницы */}
          <div>
            <label className="block text-xs font-semibold text-slate-200 mb-2">
              1. Как должен работать этот проект? (В чём разница)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setType('service')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                  type === 'service'
                    ? 'bg-emerald-950/40 border-emerald-500/60 ring-1 ring-emerald-500/40'
                    : 'bg-[#0f172a] border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Bot className={`w-4 h-4 ${type === 'service' ? 'text-emerald-400' : 'text-slate-400'}`} />
                  <span className="text-xs font-bold text-white">Постоянная программа 24/7</span>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-300 leading-relaxed">
                  Запускается и <strong>работает без остановки</strong> (Telegram-бот, слушатель событий, демон). Если упадёт — панель сама перезапустит её.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setType('job')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                  type === 'job'
                    ? 'bg-indigo-950/40 border-indigo-500/60 ring-1 ring-indigo-500/40'
                    : 'bg-[#0f172a] border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Clock className={`w-4 h-4 ${type === 'job' ? 'text-indigo-400' : 'text-slate-400'}`} />
                  <span className="text-xs font-bold text-white">Скрипт по расписанию / кнопке</span>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-300 leading-relaxed">
                  <strong>Включается → выполняет задачу → выключается</strong>. Можно запускать каждые N минут, раз в день в нужное время или вручную.
                </p>
              </button>
            </div>
          </div>

          {/* ШАГ 2: Имя и понятное описание */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="proj-name-input" className="block text-xs font-medium text-slate-200 mb-1">
                2. Короткое имя папки (латиницей)
              </label>
              <input
                id="proj-name-input"
                type="text"
                placeholder="my-shop-parser"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white focus:border-indigo-500 focus:outline-none"
              />
              <span className="block mt-1 text-[11px] text-slate-400">
                Создаст папку <code className="font-mono text-slate-300">/opt/hub/projects/{name || 'имя'}</code>
              </span>
            </div>

            <div>
              <label htmlFor="proj-desc-input" className="block text-xs font-medium text-slate-200 mb-1">
                Понятная заметка (что делает скрипт?)
              </label>
              <input
                id="proj-desc-input"
                type="text"
                placeholder="Например: Проверяет заказы и шлёт отчёт в ТГ"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
              <span className="block mt-1 text-[11px] text-slate-400">
                Отображается в списке проектов для удобства
              </span>
            </div>
          </div>

          {/* ШАГ 3: Шаблон проекта с аннотацией */}
          <div>
            <label htmlFor="proj-template-select" className="block text-xs font-semibold text-slate-200 mb-1.5">
              3. Готовый шаблон кода (с подсказками внутри)
            </label>
            <select
              id="proj-template-select"
              value={template}
              onChange={(e) => {
                const val = e.target.value as typeof template;
                setTemplate(val);
                if (val === 'tg_bot' || val === 'cookie_parser') {
                  setUseProxy(true);
                  setShowOptionalData(true);
                }
              }}
              className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="python">Python 3 — Стандартный скрипт (main.py + SDK hub)</option>
              <option value="cookie_parser">
                Python + Индивидуальные Куки и СМС-код — для сайтов с авторизацией (Cookie-Editor + hub.ask)
              </option>
              <option value="tg_bot">
                Telegram-бот проекта — со своим BOT_TOKEN и прокси 127.0.0.1:10808 (bot.py)
              </option>
              <option value="node">Node.js — Скрипт на JavaScript (index.js + SDK hub.js)</option>
              <option value="bash">Bash — Системный скрипт командной строки Linux (main.sh)</option>
            </select>
          </div>

          {/* ШАГ 4: Понятная настройка режима / расписания */}
          <div className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                4. {type === 'service' ? 'Поведение постоянной программы' : 'Когда запускать этот скрипт?'}
              </span>
              <span className="text-[11px] font-mono text-indigo-300">{humanPreview}</span>
            </div>

            {type === 'service' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Если программа внезапно закрылась:</label>
                  <select
                    value={restartPolicy}
                    onChange={(e) => setRestartPolicy(e.target.value as any)}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="on-failure">Перезапускать только при ошибке (рекомендуется)</option>
                    <option value="always">Перезапускать вообще всегда (даже при коде 0)</option>
                    <option value="no">Не перезапускать автоматически</option>
                  </select>
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autostart}
                      onChange={(e) => setAutostart(e.target.checked)}
                    />
                    Включать сам при запуске сервера (Автостарт)
                  </label>
                </div>
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => setSchedulePreset('every_minutes')}
                    className={`px-2.5 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedulePreset === 'every_minutes'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Каждые N минут
                  </button>
                  <button
                    type="button"
                    onClick={() => setSchedulePreset('every_hours')}
                    className={`px-2.5 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedulePreset === 'every_hours'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Каждые N часов
                  </button>
                  <button
                    type="button"
                    onClick={() => setSchedulePreset('daily_time')}
                    className={`px-2.5 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedulePreset === 'daily_time'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Раз в день по времени
                  </button>
                  <button
                    type="button"
                    onClick={() => setSchedulePreset('manual')}
                    className={`px-2.5 py-2 rounded-lg text-xs font-medium border cursor-pointer ${
                      schedulePreset === 'manual'
                        ? 'bg-indigo-600 text-white border-indigo-500'
                        : 'bg-[#0f172a] text-slate-300 border-slate-800'
                    }`}
                  >
                    Только по кнопке
                  </button>
                </div>

                {schedulePreset === 'every_minutes' && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-300">Запускать каждые:</span>
                    <input
                      type="number"
                      min={1}
                      max={59}
                      value={everyMinutes}
                      onChange={(e) => setEveryMinutes(Number(e.target.value))}
                      className="w-24 bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                    <span className="text-xs text-slate-300">минут (1–59)</span>
                  </div>
                )}

                {schedulePreset === 'every_hours' && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-300">Запускать каждые:</span>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={everyHours}
                      onChange={(e) => setEveryHours(Number(e.target.value))}
                      className="w-24 bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                    <span className="text-xs text-slate-300">часов</span>
                  </div>
                )}

                {schedulePreset === 'daily_time' && (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-300">Запускать каждый день в:</span>
                    <input
                      type="time"
                      value={dailyTime}
                      onChange={(e) => setDailyTime(e.target.value)}
                      className="bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                )}

                {schedulePreset === 'custom_cron' && (
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">Своё Cron-выражение (5 полей):</label>
                    <input
                      type="text"
                      value={customCron}
                      onChange={(e) => setCustomCron(e.target.value)}
                      placeholder="*/15 * * * *"
                      className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-slate-400">
                    Итог: <strong className="text-slate-200">{humanPreview}</strong>
                  </span>
                  {schedulePreset !== 'custom_cron' && (
                    <button
                      type="button"
                      onClick={() => setSchedulePreset('custom_cron')}
                      className="text-[11px] text-indigo-400 hover:underline cursor-pointer"
                    >
                      Ввести свой Cron вручную
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-slate-800/80">
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={template === 'tg_bot' || template === 'cookie_parser' ? true : useProxy}
                  onChange={(e) => setUseProxy(e.target.checked)}
                />
                Маршрутизировать трафик этого проекта через локальный прокси <code className="font-mono text-indigo-300">127.0.0.1:10808</code>
              </label>
            </div>
          </div>

          {/* ОПЦИОНАЛЬНО: Сразу прикрепить индивидуальные Куки или Telegram-данные к этому проекту */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowOptionalData(!showOptionalData)}
              className="w-full px-4 py-2.5 bg-slate-900/50 hover:bg-slate-900 flex items-center justify-between text-xs font-medium text-slate-200 cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Cookie className="w-3.5 h-3.5 text-amber-400" />
                Индивидуальные Куки и Telegram-токен для этого проекта (можно заполнить сейчас или позже)
              </span>
              {showOptionalData ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showOptionalData && (
              <div className="p-4 bg-[#0f172a]/70 space-y-3 border-t border-slate-800">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      Токен бота для этого скрипта (BOT_TOKEN)
                    </label>
                    <input
                      type="text"
                      placeholder="123456789:AAH... (только для этого проекта)"
                      value={projBotToken}
                      onChange={(e) => setProjBotToken(e.target.value)}
                      className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      ID чата/канала для этого скрипта (TG_CHAT_ID)
                    </label>
                    <input
                      type="text"
                      placeholder="Например: 192837465"
                      value={projChatId}
                      onChange={(e) => setProjChatId(e.target.value)}
                      className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Индивидуальные куки этого скрипта из Cookie-Editor (сохранятся как <code className="font-mono text-indigo-300">{name.trim() || 'project'}_cookies</code>)
                  </label>
                  <textarea
                    rows={3}
                    placeholder='Вставьте JSON-массив из расширения Cookie-Editor: [{"name": "session", "value": "...", "domain": ".site.com"}]'
                    value={initialCookieJson}
                    onChange={(e) => setInitialCookieJson(e.target.value)}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg p-2.5 text-xs font-mono text-white"
                  />
                </div>
              </div>
            )}
          </div>

          {/* РАСШИРЕННЫЕ НАСТРОЙКИ (для опытных пользователей) */}
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-4 py-2.5 bg-slate-900/50 hover:bg-slate-900 flex items-center justify-between text-xs font-medium text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-slate-400" />
                Расширенные настройки (лимит ОЗУ, своя команда запуска)
              </span>
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvanced && (
              <div className="p-4 bg-[#0f172a]/70 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-slate-800">
                <div>
                  <label htmlFor="proj-ram-input" className="block text-xs text-slate-300 mb-1">
                    Лимит памяти ОЗУ (МБ, 0 = без ограничений)
                  </label>
                  <input
                    id="proj-ram-input"
                    type="number"
                    min={0}
                    value={ramLimitMb}
                    onChange={(e) => setRamLimitMb(Number(e.target.value))}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Своя команда запуска (оставьте пустым для стандартной)
                  </label>
                  <input
                    type="text"
                    placeholder="По умолчанию выберется автоматически"
                    value={customCmd}
                    onChange={(e) => setCustomCmd(e.target.value)}
                    className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="p-3 bg-red-950/60 border border-red-500/40 rounded-lg text-xs text-red-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              {submitting ? 'Создание...' : 'Создать проект'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
