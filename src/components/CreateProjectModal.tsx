import React, { useState } from 'react';
import {
  Plus,
  X,
  Bot,
  Clock,
  Cookie,
  Terminal,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Layers,
  Globe,
} from 'lucide-react';
import { describeScheduleHuman, parseGitHubRepoUrl, validateCookieEditorJson } from '../utils/hubLogic';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: Record<string, any>) => Promise<void>;
}

type CreateMode = 'template' | 'github';
type SchedulePreset = 'manual' | 'every_minutes' | 'every_hours' | 'daily_time' | 'custom_cron';

const GROUP_OPTIONS = ['Боты 24/7', 'Парсеры', 'Домашний сервер', 'GitHub', 'Бэкапы', 'Тесты'];

export const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ isOpen, onClose, onCreate }) => {
  const [createMode, setCreateMode] = useState<CreateMode>('template');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [groupTag, setGroupTag] = useState('Боты 24/7');
  const [type, setType] = useState<'service' | 'job'>('service');
  const [template, setTemplate] = useState<'python' | 'cookie_parser' | 'tg_bot' | 'node' | 'bash'>('python');
  const [useProxy, setUseProxy] = useState(true);
  const [customProxy, setCustomProxy] = useState('');

  // Режим установки из GitHub репозитория
  const [gitRepoUrl, setGitRepoUrl] = useState('');

  // Понятный конструктор расписания для скриптов (job)
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('every_minutes');
  const [everyMinutes, setEveryMinutes] = useState<number>(15);
  const [everyHours, setEveryHours] = useState<number>(1);
  const [dailyTime, setDailyTime] = useState<string>('09:00');
  const [customCron, setCustomCron] = useState<string>('*/15 * * * *');

  // Простые настройки для постоянной программы (service)
  const [autostart, setAutostart] = useState(true);
  const [restartPolicy, setRestartPolicy] = useState<'always' | 'on-failure' | 'no'>('on-failure');

  // Опциональные индивидуальные данные проекта (Куки, Индивидуальный прокси и Telegram самого скрипта)
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

  const handleGitUrlChange = (val: string) => {
    setGitRepoUrl(val);
    const parsed = parseGitHubRepoUrl(val);
    if (parsed.valid && !name.trim()) {
      setName(parsed.suggestedName);
    }
    if (parsed.valid && !description.trim()) {
      setDescription(`Установлен из GitHub (${parsed.owner}/${parsed.repo})`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (createMode === 'github') {
      const parsedGit = parseGitHubRepoUrl(gitRepoUrl);
      if (!parsedGit.valid) {
        setError(parsedGit.error || 'Укажите корректную ссылку на GitHub-репозиторий');
        return;
      }
      const targetName = name.trim() || parsedGit.suggestedName;
      setSubmitting(true);
      try {
        await onCreate({
          create_from_github: true,
          repo_url: parsedGit.cleanUrl,
          name: targetName,
          type,
          use_proxy: useProxy,
          custom_proxy: customProxy.trim() || undefined,
          group_tag: groupTag || 'GitHub',
          description: description.trim() || `Программа из GitHub (${parsedGit.owner}/${parsedGit.repo})`,
          cmd: customCmd.trim() || undefined,
          initial_cookies_json: initialCookieJson.trim() || undefined,
        });
        setGitRepoUrl('');
        setName('');
        setDescription('');
        onClose();
      } catch (err: any) {
        setError(err?.message || 'Ошибка клонирования GitHub-репозитория');
      } finally {
        setSubmitting(false);
      }
      return;
    }

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
      const envObj: Record<string, string> = {
        PROJECT_GROUP: groupTag,
      };
      if (description.trim()) {
        envObj.PROJECT_DESCRIPTION = description.trim();
      }
      if (projBotToken.trim()) {
        envObj.BOT_TOKEN = projBotToken.trim();
      }
      if (projChatId.trim()) {
        envObj.TG_CHAT_ID = projChatId.trim();
      }
      if (customProxy.trim()) {
        envObj.CUSTOM_PROXY_URL = customProxy.trim();
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
      setCustomProxy('');
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
            <h2 className="text-base font-bold text-white">Мастер создания и установки проекта</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Создайте скрипт по готовому шаблону или установите готовую программу напрямую из GitHub (git clone)
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

        {/* Переключатель источника: Готовый шаблон vs Установка из GitHub */}
        <div className="mt-4 grid grid-cols-2 gap-2 p-1 bg-slate-900 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setCreateMode('template')}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
              createMode === 'template'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Из готового шаблона
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateMode('github');
              setGroupTag('GitHub');
            }}
            className={`py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
              createMode === 'github'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            Установить из GitHub (git clone)
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-5">
          {createMode === 'github' && (
            <div className="p-4 bg-emerald-950/25 border border-emerald-500/30 rounded-xl space-y-3">
              <div>
                <label htmlFor="github-repo-url-input" className="block text-xs font-semibold text-emerald-200 mb-1">
                  Ссылка на репозиторий GitHub (клонируется через прокси 127.0.0.1:10808):
                </label>
                <input
                  id="github-repo-url-input"
                  type="text"
                  placeholder="https://github.com/author/my-telegram-bot"
                  value={gitRepoUrl}
                  onChange={(e) => handleGitUrlChange(e.target.value)}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                <span className="text-slate-400">Быстрые примеры для теста:</span>
                {[
                  { label: 'bot-template', url: 'https://github.com/example/poco-tg-userbot' },
                  { label: 'market-Monitor', url: 'https://github.com/example/antibot-price-monitor' },
                ].map((sample) => (
                  <button
                    key={sample.label}
                    type="button"
                    onClick={() => handleGitUrlChange(sample.url)}
                    className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded font-mono cursor-pointer"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>

              <p className="text-[11px] text-slate-300 leading-relaxed">
                После создания откроется вкладка <strong>«3. Терминал и GitHub»</strong>, где можно в 1 клик поставить зависимости (<code className="font-mono text-emerald-300">pip install -r requirements.txt</code>), обновить код (<code className="font-mono text-emerald-300">git pull</code>) и вводить команды в консоль.
              </p>
            </div>
          )}

          {/* ШАГ 1: Понятный выбор типа проекта с объяснением разницы */}
          <div>
            <label className="block text-xs font-semibold text-slate-200 mb-2">
              1. Как должен работать этот проект?
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

          {/* ШАГ 2: Имя, Группа и понятное описание */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
              <span className="block mt-1 text-[11px] text-slate-400 truncate">
                <code className="font-mono text-slate-300">/opt/hub/projects/{name || 'имя'}</code>
              </span>
            </div>

            <div>
              <label htmlFor="proj-group-select" className="block text-xs font-medium text-slate-200 mb-1">
                Группа / Категория
              </label>
              <select
                id="proj-group-select"
                value={groupTag}
                onChange={(e) => setGroupTag(e.target.value)}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              >
                {GROUP_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <span className="block mt-1 text-[11px] text-slate-400">Для удобной фильтрации в списке</span>
            </div>

            <div>
              <label htmlFor="proj-desc-input" className="block text-xs font-medium text-slate-200 mb-1">
                Понятная заметка
              </label>
              <input
                id="proj-desc-input"
                type="text"
                placeholder="Проверяет заказы и шлёт в ТГ"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
              <span className="block mt-1 text-[11px] text-slate-400">Что делает этот проект</span>
            </div>
          </div>

          {/* ШАГ 3: Шаблон проекта с аннотацией (если не из GitHub) */}
          {createMode === 'template' && (
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
                  Python + Сайты с Антиботом/Куками — поддержка интерактивного входа на сайте и hub.ask()
                </option>
                <option value="tg_bot">
                  Telegram-бот проекта — со своим BOT_TOKEN и прокси 127.0.0.1:10808 (bot.py)
                </option>
                <option value="node">Node.js — Скрипт на JavaScript (index.js + SDK hub.js)</option>
                <option value="bash">Bash — Системный скрипт командной строки Linux (main.sh)</option>
              </select>
            </div>
          )}

          {/* ШАГ 4: Понятная настройка режима / расписания */}
          <div className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                {type === 'service' ? 'Поведение постоянной программы' : 'Когда запускать этот скрипт?'}
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
              </div>
            )}

            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={template === 'tg_bot' || template === 'cookie_parser' ? true : useProxy}
                  onChange={(e) => setUseProxy(e.target.checked)}
                />
                Маршрутизировать трафик через прокси (по умолчанию системный <code className="font-mono text-indigo-300">127.0.0.1:10808</code>)
              </label>

              {useProxy && (
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <input
                    type="text"
                    placeholder="Свой индивидуальный прокси проекта (необязательно, например http://user:pass@ip:port)"
                    value={customProxy}
                    onChange={(e) => setCustomProxy(e.target.value)}
                    className="flex-1 bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white"
                  />
                </div>
              )}
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
                    Индивидуальные куки этого скрипта из Cookie-Editor (либо авторизуйтесь прямо на сайте после создания проекта):
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

          {/* РАСШИРЕННЫЕ НАСТРОЙКИ */}
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
                    Своя команда запуска (оставьте пустым для автоопределения)
                  </label>
                  <input
                    type="text"
                    placeholder="Например: python3 main.py --mode prod"
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
              {submitting
                ? createMode === 'github'
                  ? 'Клонирование из GitHub...'
                  : 'Создание...'
                : createMode === 'github'
                ? 'Склонировать и создать проект'
                : 'Создать проект'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
