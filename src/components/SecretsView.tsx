import React, { useMemo, useRef, useState } from 'react';
import {
  KeyRound,
  Cookie,
  ShieldAlert,
  Trash2,
  Plus,
  Send,
  Clock,
  FileKey,
  CheckCircle2,
  AlertTriangle,
  Search,
  Copy,
  Check,
  Upload,
  Wand2,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  FolderCode,
  RefreshCw,
  Code2,
} from 'lucide-react';
import { PendingAsk, ProjectItem, SecretItem } from '../types/hub';
import { formatBytes, formatDurationSeconds } from '../utils/hubLogic';

interface SecretsViewProps {
  secrets: SecretItem[];
  projects: ProjectItem[];
  pendingAsks: PendingAsk[];
  onAnswerAsk: (askId: string, answer: string) => Promise<void>;
  onSaveSecret: (name: string, type: 'text' | 'file' | 'cookie_json', value: string) => Promise<void>;
  onImportCookieJson: (name: string, rawJson: string) => Promise<void>;
  onExpireCookie: (name: string) => Promise<void>;
  onDeleteSecret: (name: string) => Promise<void>;
  onUpdateProject?: (projectId: number, payload: Record<string, unknown>) => Promise<unknown>;
}

const SECRET_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const SecretsView: React.FC<SecretsViewProps> = ({
  secrets,
  projects,
  pendingAsks,
  onAnswerAsk,
  onSaveSecret,
  onImportCookieJson,
  onExpireCookie,
  onDeleteSecret,
  onUpdateProject,
}) => {
  // Состояние формы обычного секрета (API-ключ / файл)
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'text' | 'file'>('text');
  const [newValue, setNewValue] = useState('');
  const [selectedProjectsForNew, setSelectedProjectsForNew] = useState<number[]>([]);
  const [savingSecret, setSavingSecret] = useState(false);

  // Состояние импорта Cookie-Editor JSON
  const [cookieSecretName, setCookieSecretName] = useState(
    projects[0] ? `${projects[0].name}_cookies` : 'account_cookies'
  );
  const [cookieJsonText, setCookieJsonText] = useState('');
  const [autoBindCookieProject, setAutoBindCookieProject] = useState<number | ''>(
    projects[0]?.id ?? ''
  );
  const [importingCookies, setImportingCookies] = useState(false);

  // Поиск и фильтрация таблицы секретов
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'cookie_json' | 'text' | 'file' | 'expired'>('all');
  const [copiedCodeName, setCopiedCodeName] = useState<string | null>(null);
  const [editingAclSecret, setEditingAclSecret] = useState<string | null>(null);
  const [showHelpGuide, setShowHelpGuide] = useState(false);

  // Уведомления и ответы на 2FA
  const [askAnswers, setAskAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const cookieFileInputRef = useRef<HTMLInputElement | null>(null);
  const secretFileInputRef = useRef<HTMLInputElement | null>(null);

  // Живой разбор вставленного JSON из Cookie-Editor до сохранения
  const cookiePreview = useMemo(() => {
    const raw = cookieJsonText.trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { valid: false, error: 'JSON должен быть непустым массивом объектов куки [...]' };
      }
      const domains = new Set<string>();
      let secureCount = 0;
      let httpOnlyCount = 0;
      let earliestExp: number | null = null;

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== 'object') {
          return { valid: false, error: `Элемент #${i} не является объектом` };
        }
        if (!('name' in item) || !('value' in item) || !('domain' in item)) {
          return {
            valid: false,
            error: `Кука #${i} должна содержать обязательные поля "name", "value" и "domain"`,
          };
        }
        if (item.domain) domains.add(String(item.domain));
        if (item.secure) secureCount += 1;
        if (item.httpOnly) httpOnlyCount += 1;
        const exp = Number(item.expirationDate || item.expires || 0);
        if (exp > 1_000_000_000 && (earliestExp === null || exp < earliestExp)) {
          earliestExp = exp;
        }
      }

      return {
        valid: true,
        count: parsed.length,
        domains: Array.from(domains).slice(0, 6),
        secureCount,
        httpOnlyCount,
        earliestExp,
      };
    } catch (e) {
      return {
        valid: false,
        error: `Ошибка синтаксиса JSON: ${e instanceof Error ? e.message : 'некорректный формат'}`,
      };
    }
  }, [cookieJsonText]);

  // Карта: имя секрета -> список проектов, у которых он в allowed_secrets
  const projectsBySecret = useMemo(() => {
    const map: Record<string, ProjectItem[]> = {};
    for (const p of projects) {
      for (const sName of p.secrets || []) {
        if (!map[sName]) map[sName] = [];
        map[sName].push(p);
      }
    }
    return map;
  }, [projects]);

  const filteredSecrets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return secrets.filter((s) => {
      if (typeFilter === 'expired' && s.is_expired !== 1) return false;
      if (typeFilter !== 'all' && typeFilter !== 'expired' && s.type !== typeFilter) return false;
      if (!q) return true;
      const doms = (s.cookie_meta?.domains || []).join(' ').toLowerCase();
      const usedProjs = (projectsBySecret[s.name] || []).map((p) => p.name).join(' ').toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.file_path.toLowerCase().includes(q) ||
        doms.includes(q) ||
        usedProjs.includes(q)
      );
    });
  }, [secrets, searchQuery, typeFilter, projectsBySecret]);

  const stats = useMemo(() => {
    let cookiesCount = 0;
    let expiredCount = 0;
    let keysCount = 0;
    for (const s of secrets) {
      if (s.type === 'cookie_json') cookiesCount += 1;
      else keysCount += 1;
      if (s.is_expired === 1) expiredCount += 1;
    }
    return { total: secrets.length, cookiesCount, keysCount, expiredCount };
  }, [secrets]);

  const handleCreateSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newName.trim();
    if (!SECRET_NAME_RE.test(cleanName) || !newValue.trim()) {
      setFeedback({
        type: 'err',
        text: 'Имя секрета должно состоять только из латинских букв, цифр, _ или - (1–64 символа), а значение не может быть пустым.',
      });
      return;
    }
    setSavingSecret(true);
    setFeedback(null);
    try {
      await onSaveSecret(cleanName, newType, newValue);
      // Если выбраны проекты для автоматической привязки ACL
      if (onUpdateProject && selectedProjectsForNew.length > 0) {
        for (const pid of selectedProjectsForNew) {
          const proj = projects.find((p) => p.id === pid);
          if (proj && !(proj.secrets || []).includes(cleanName)) {
            await onUpdateProject(proj.id, {
              secrets: [...(proj.secrets || []), cleanName],
            });
          }
        }
      }
      setNewName('');
      setNewValue('');
      setSelectedProjectsForNew([]);
      setFeedback({
        type: 'ok',
        text: `Секрет «${cleanName}» сохранён с правами 0600 и включён в фильтр маскировки логов.`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Ошибка сохранения секрета',
      });
    } finally {
      setSavingSecret(false);
    }
  };

  const handleCookieImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = cookieSecretName.trim();
    if (!SECRET_NAME_RE.test(cleanName) || !cookieJsonText.trim()) return;
    setImportingCookies(true);
    setFeedback(null);
    try {
      await onImportCookieJson(cleanName, cookieJsonText);
      if (onUpdateProject && autoBindCookieProject !== '') {
        const proj = projects.find((p) => p.id === Number(autoBindCookieProject));
        if (proj && !(proj.secrets || []).includes(cleanName)) {
          await onUpdateProject(proj.id, {
            secrets: [...(proj.secrets || []), cleanName],
          });
        }
      }
      setCookieJsonText('');
      setFeedback({
        type: 'ok',
        text: `Профиль куки «${cleanName}» успешно импортирован (права 0600, статус «протухшие» сброшен).`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Ошибка разбора JSON куки',
      });
    } finally {
      setImportingCookies(false);
    }
  };

  const handleToggleSecretForProject = async (secretName: string, proj: ProjectItem) => {
    if (!onUpdateProject) return;
    const current = proj.secrets || [];
    const exists = current.includes(secretName);
    const next = exists ? current.filter((s) => s !== secretName) : [...current, secretName];
    try {
      await onUpdateProject(proj.id, { secrets: next });
      setFeedback({
        type: 'ok',
        text: exists
          ? `Доступ к секрету «${secretName}» отозван у проекта «${proj.name}».`
          : `Секрет «${secretName}» разрешён для проекта «${proj.name}».`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Не удалось обновить ACL проекта',
      });
    }
  };

  const handleGenerateRandomSecret = () => {
    const arr = new Uint8Array(24);
    window.crypto.getRandomValues(arr);
    const hex = Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    setNewValue(`bcn_sec_${hex}`);
    if (!newName.trim()) {
      setNewName('internal_api_token');
    }
  };

  const handleUploadCookieFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setCookieJsonText(text);
      const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      if (baseName && !cookieSecretName.trim()) {
        setCookieSecretName(baseName.slice(0, 64));
      }
    } catch {
      setFeedback({ type: 'err', text: 'Не удалось прочитать выбранный файл куки' });
    } finally {
      e.target.value = '';
    }
  };

  const handleUploadSecretFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setNewValue(text);
      setNewType('file');
      const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      if (baseName && !newName.trim()) {
        setNewName(baseName.slice(0, 64));
      }
    } catch {
      setFeedback({ type: 'err', text: 'Не удалось прочитать файл секрета' });
    } finally {
      e.target.value = '';
    }
  };

  const handleCopySdkSnippet = async (secretName: string) => {
    const snippet = `beacon.secret("${secretName}")`;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopiedCodeName(secretName);
      setTimeout(() => setCopiedCodeName(null), 1600);
    } catch {
      // ignore
    }
  };

  const fillExampleCookies = () => {
    const sample = JSON.stringify(
      [
        {
          domain: '.example.com',
          name: 'session_id',
          value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_demo_cookie_token',
          path: '/',
          httpOnly: true,
          secure: true,
          expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
        {
          domain: '.example.com',
          name: 'csrf_token',
          value: 'a9f8e7d6c5b4a3f2e1d0',
          path: '/',
          httpOnly: false,
          secure: true,
        },
      ],
      null,
      2
    );
    setCookieJsonText(sample);
  };

  return (
    <div className="space-y-5">
      {/* Верхняя сводка хранилища секретов + кнопка открытия справки */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shrink-0">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white flex flex-wrap items-center gap-2">
              Хранилище секретов и профилей куки (0600)
              <span className="px-2 py-0.5 text-[10px] font-mono bg-emerald-950/80 text-emerald-300 border border-emerald-500/30 rounded">
                Автомаскировка логов активна
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Безопасное хранение API-ключей, JSON-кук из браузера и привязка доступа к проектам без проброса в открытый <code className="font-mono">os.environ</code>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="px-3 py-1.5 bg-[#0f172a] border border-slate-800 rounded-lg text-xs font-mono">
            Всего: <strong className="text-white">{stats.total}</strong>
          </div>
          <div className="px-3 py-1.5 bg-[#0f172a] border border-slate-800 rounded-lg text-xs font-mono text-amber-300">
            Куки JSON: <strong>{stats.cookiesCount}</strong>
          </div>
          <div className="px-3 py-1.5 bg-[#0f172a] border border-slate-800 rounded-lg text-xs font-mono text-indigo-300">
            Ключи/Файлы: <strong>{stats.keysCount}</strong>
          </div>
          {stats.expiredCount > 0 && (
            <div className="px-3 py-1.5 bg-red-950/60 border border-red-500/40 rounded-lg text-xs font-mono text-red-300">
              Истекли: <strong>{stats.expiredCount}</strong>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowHelpGuide(!showHelpGuide)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
          >
            <HelpCircle className="w-3.5 h-3.5 text-indigo-400" />
            {showHelpGuide ? 'Скрыть инструкцию' : 'Как читать секреты в коде'}
            {showHelpGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Сворачиваемая справка (отделена от форм и таблицы) */}
      {showHelpGuide && (
        <div className="p-4 bg-indigo-950/25 border border-indigo-500/30 rounded-xl grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="p-3 bg-[#0f172a]/90 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-indigo-300 flex items-center gap-1.5">
              <Code2 className="w-3.5 h-3.5" />
              1. Чтение в Python и Node.js
            </div>
            <p className="text-slate-300 leading-relaxed">
              В коде проекта вызовите <code className="font-mono text-emerald-300">beacon.secret("имя")</code>. Для JSON-кук метод сразу вернёт готовый список словарей, а с параметром <code className="font-mono text-indigo-200">as_path=True</code> — путь к файлу <code className="font-mono">0600</code>.
            </p>
          </div>
          <div className="p-3 bg-[#0f172a]/90 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-amber-300 flex items-center gap-1.5">
              <FolderCode className="w-3.5 h-3.5" />
              2. Привязка секрета к проекту (ACL)
            </div>
            <p className="text-slate-300 leading-relaxed">
              В целях безопасности проект видит только те секреты, которые ему разрешены. Привязать секрет к проекту можно прямо при создании ниже или в колонке «Доступ проектов (ACL)» в таблице.
            </p>
          </div>
          <div className="p-3 bg-[#0f172a]/90 border border-slate-800 rounded-lg space-y-1.5">
            <div className="font-semibold text-emerald-300 flex items-center gap-1.5">
              <Cookie className="w-3.5 h-3.5" />
              3. Сигнал о протухании кук
            </div>
            <p className="text-slate-300 leading-relaxed">
              Если сайт вернул 401/403, вызовите в скрипте <code className="font-mono text-amber-200">beacon.cookies_expired("имя")</code> — панель поднимет тревогу в Telegram и покажет кнопку быстрого обновления.
            </p>
          </div>
        </div>
      )}

      {/* Уведомление об операции */}
      {feedback && (
        <div
          className={`p-3.5 rounded-xl border flex items-center justify-between gap-2 text-xs ${
            feedback.type === 'ok'
              ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
              : 'bg-red-950/60 border-red-500/40 text-red-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.type === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-400 hover:text-white text-xs cursor-pointer"
          >
            Закрыть
          </button>
        </div>
      )}

      {/* Активные запросы 2FA / SMS от запущенных скриптов (beacon.ask) */}
      {pendingAsks.length > 0 && (
        <div className="bg-amber-950/40 border border-amber-500/40 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-amber-300 font-semibold text-sm">
            <Clock className="w-4 h-4 animate-spin" />
            Ожидают ввода 2FA / SMS-кода от оператора (<code className="font-mono">beacon.ask()</code>)
          </div>
          <div className="space-y-2">
            {pendingAsks.map((ask) => (
              <div
                key={ask.id}
                className="p-3 bg-slate-900/90 border border-amber-500/30 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div>
                  <div className="text-xs font-mono text-amber-300">
                    Проект: <strong>{ask.project_name}</strong> (Run #{ask.run_id}) • осталось{' '}
                    {formatDurationSeconds(ask.remaining_sec)}
                  </div>
                  <div className="text-sm text-white font-medium mt-0.5">{ask.prompt}</div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Введите код или ответ..."
                    value={askAnswers[ask.id] || ''}
                    onChange={(e) => setAskAnswers({ ...askAnswers, [ask.id]: e.target.value })}
                    className="bg-[#0f172a] border border-amber-500/50 rounded-lg px-3 py-1.5 text-xs font-mono text-white w-56"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const val = (askAnswers[ask.id] || '').trim();
                      if (!val) return;
                      await onAnswerAsk(ask.id, val);
                      setAskAnswers((prev) => ({ ...prev, [ask.id]: '' }));
                    }}
                    className="px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Отправить в скрипт
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Две рабочие карточки: 1) Импорт кук из Cookie-Editor и 2) Создание API-ключа / Файла */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* КАРТОЧКА 1: Импорт куки из Cookie-Editor */}
        <form
          onSubmit={handleCookieImport}
          className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <Cookie className="w-5 h-5 text-amber-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Импорт куки из браузера (Cookie-Editor JSON)
                  </h3>
                  <p className="text-xs text-slate-400">
                    Вставьте JSON-массив из расширения Cookie-Editor или загрузите файл <code className="font-mono">.json</code>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  ref={cookieFileInputRef}
                  type="file"
                  accept=".json,.txt"
                  onChange={handleUploadCookieFile}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => cookieFileInputRef.current?.click()}
                  className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-indigo-400" />
                  Из файла
                </button>
                <button
                  type="button"
                  onClick={fillExampleCookies}
                  className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 rounded-lg cursor-pointer"
                >
                  Образец
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Имя профиля куки (латиница, <code className="font-mono">_cookies</code>)
                </label>
                <input
                  type="text"
                  value={cookieSecretName}
                  onChange={(e) => setCookieSecretName(e.target.value)}
                  placeholder="например: youtube_cookies"
                  className="w-full bg-[#0f172a] border border-slate-700 focus:border-amber-500 rounded-lg px-3 py-2 text-xs font-mono text-white outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Привязать к проекту (разрешить чтение)
                </label>
                <select
                  value={autoBindCookieProject}
                  onChange={(e) => {
                    const val = e.target.value;
                    setAutoBindCookieProject(val === '' ? '' : Number(val));
                    if (val !== '') {
                      const p = projects.find((pr) => pr.id === Number(val));
                      if (p) setCookieSecretName(`${p.name}_cookies`);
                    }
                  }}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="">Не привязывать автоматически</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      Проект: {p.name} ({p.name}_cookies)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                JSON-массив из Cookie-Editor (поля <code className="font-mono text-amber-300">name, value, domain</code>)
              </label>
              <textarea
                rows={5}
                value={cookieJsonText}
                onChange={(e) => setCookieJsonText(e.target.value)}
                placeholder='[{"domain": ".example.com", "name": "sid", "value": "..."}]'
                className="w-full bg-[#0f172a] border border-slate-700 focus:border-amber-500 rounded-lg p-3 text-xs font-mono text-slate-200 outline-none"
              />
            </div>

            {/* Инспектор кук в реальном времени */}
            {cookiePreview && (
              <div
                className={`p-3 rounded-lg border text-xs ${
                  cookiePreview.valid
                    ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                    : 'bg-red-950/40 border-red-500/40 text-red-200'
                }`}
              >
                {cookiePreview.valid ? (
                  <div className="space-y-1">
                    <div className="font-semibold flex items-center justify-between">
                      <span>Распознано кук: {cookiePreview.count} шт.</span>
                      <span className="font-mono text-[11px] text-emerald-300">
                        Secure: {cookiePreview.secureCount} • HttpOnly: {cookiePreview.httpOnlyCount}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-300 font-mono">
                      Домены: {cookiePreview.domains?.join(', ') || '—'}
                      {cookiePreview.earliestExp && (
                        <span className="ml-2 text-amber-300">
                          • Истекает: {new Date(cookiePreview.earliestExp * 1000).toLocaleDateString('ru-RU')}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="font-mono">{cookiePreview.error}</div>
                )}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={importingCookies || !cookieSecretName.trim() || !cookiePreview?.valid}
            className="w-full py-2.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 rounded-lg transition-colors cursor-pointer"
          >
            {importingCookies ? 'Сохранение 0600...' : 'Импортировать куки и сбросить флаг «Истекли»'}
          </button>
        </form>

        {/* КАРТОЧКА 2: Сохранение текстового API-ключа, токена или файла */}
        <form
          onSubmit={handleCreateSecret}
          className="bg-[#1e293b] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4"
        >
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <FileKey className="w-5 h-5 text-indigo-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Добавить или обновить API-ключ / Файл секрета
                  </h3>
                  <p className="text-xs text-slate-400">
                    Токены ботов, ключи OpenAI/GitHub, приватные SSH/PEM-ключи и сервисные аккаунты
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <input
                  ref={secretFileInputRef}
                  type="file"
                  onChange={handleUploadSecretFile}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => secretFileInputRef.current?.click()}
                  title="Загрузить содержимое секрета из файла на компьютере"
                  className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-indigo-400" />
                  Из файла
                </button>
                <button
                  type="button"
                  onClick={handleGenerateRandomSecret}
                  title="Сгенерировать случайный криптостойкий токен"
                  className="px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 rounded-lg inline-flex items-center gap-1 cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  Сгенерировать
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Имя секрета (латиница, цифры, <code className="font-mono">_</code>)
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="например: openai_api_key"
                  className="w-full bg-[#0f172a] border border-slate-700 focus:border-indigo-500 rounded-lg px-3 py-2 text-xs font-mono text-white outline-none"
                />
                {/* Быстрые пресеты популярных имён */}
                <div className="flex flex-wrap items-center gap-1 mt-1.5">
                  {['tg_bot_token', 'openai_api_key', 'github_pat', 'proxy_credentials'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setNewName(preset)}
                      className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-indigo-300 border border-slate-800 rounded cursor-pointer"
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Формат хранения
                </label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as 'text' | 'file')}
                  className="w-full bg-[#0f172a] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                >
                  <option value="text">Текст / API-ключ</option>
                  <option value="file">Многострочный файл / .pem</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Значение секрета (будет скрыто после сохранения и замаскировано в логах)
              </label>
              <textarea
                rows={3}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="Вставьте токен, пароль или содержимое сертификата..."
                className="w-full bg-[#0f172a] border border-slate-700 focus:border-indigo-500 rounded-lg p-3 text-xs font-mono text-slate-200 outline-none"
              />
            </div>

            {/* Выбор проектов, которым сразу разрешён этот секрет */}
            {projects.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Разрешить чтение этого секрета проектам (ACL):
                </label>
                <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto p-2 bg-[#0f172a] border border-slate-800 rounded-lg">
                  {projects.map((p) => {
                    const checked = selectedProjectsForNew.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          setSelectedProjectsForNew((prev) =>
                            checked ? prev.filter((id) => id !== p.id) : [...prev, p.id]
                          )
                        }
                        className={`px-2 py-1 rounded text-[11px] font-mono border transition-colors cursor-pointer ${
                          checked
                            ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                            : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {checked ? '✓ ' : '+ '}
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={savingSecret || !newName.trim() || !newValue.trim()}
            className="w-full py-2.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {savingSecret ? 'Запись в data/secrets/...' : 'Сохранить секрет с правами 0600'}
          </button>
        </form>
      </div>

      {/* Таблица всех секретов с поиском, метаданными кук, управлением ACL и копированием кода */}
      <div className="bg-[#1e293b] border border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Реестр сохранённых секретов ({filteredSecrets.length} из {secrets.length})
            </h3>
            <p className="text-xs text-slate-400">
              Сырые значения никогда не передаются обратно в браузер (<code className="font-mono">********</code>)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Поиск */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск по имени, домену, проекту..."
                className="bg-[#0f172a] border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 w-56"
              />
            </div>

            {/* Фильтры по типу */}
            {(
              [
                { id: 'all', label: 'Все' },
                { id: 'cookie_json', label: 'Куки JSON' },
                { id: 'text', label: 'API-ключи' },
                { id: 'file', label: 'Файлы' },
                { id: 'expired', label: 'Истёкшие' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setTypeFilter(f.id)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
                  typeFilter === f.id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-[#0f172a] text-slate-400 hover:text-white border border-slate-800'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400 bg-slate-900/50">
                <th className="py-3 px-4">Имя секрета и вызов в коде</th>
                <th className="py-3 px-3">Тип и метаданные</th>
                <th className="py-3 px-3">Доступ проектов (ACL)</th>
                <th className="py-3 px-3">Размер / Обновлён</th>
                <th className="py-3 px-3">Статус</th>
                <th className="py-3 px-4 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs font-mono">
              {filteredSecrets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400 font-sans">
                    Секреты не найдены. Создайте API-ключ или импортируйте куки в формах выше.
                  </td>
                </tr>
              ) : (
                filteredSecrets.map((s) => {
                  const usedBy = projectsBySecret[s.name] || [];
                  const isEditingAcl = editingAclSecret === s.name;
                  const cMeta = s.cookie_meta;

                  return (
                    <tr key={s.name} className="hover:bg-slate-800/30 align-top">
                      {/* Имя секрета + кнопка копирования кода SDK */}
                      <td className="py-3 px-4">
                        <div className="font-bold text-white text-sm">{s.name}</div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <code className="text-[11px] text-indigo-300 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                            beacon.secret("{s.name}")
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopySdkSnippet(s.name)}
                            title="Скопировать код вызова для Python / Node.js"
                            className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                          >
                            {copiedCodeName === s.name ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Тип + метаданные кук (домены, число кук, дата истечения) */}
                      <td className="py-3 px-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] ${
                            s.type === 'cookie_json'
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                              : s.type === 'file'
                              ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                              : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                          }`}
                        >
                          {s.type}
                        </span>
                        {cMeta && (
                          <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-300 font-sans">
                            <div>
                              Кук в профиле: <strong className="font-mono text-white">{cMeta.count}</strong>
                            </div>
                            {cMeta.domains && cMeta.domains.length > 0 && (
                              <div className="font-mono text-[10px] text-slate-400 truncate max-w-[220px]">
                                {cMeta.domains.join(', ')}
                              </div>
                            )}
                            {cMeta.earliest_expiry && (
                              <div className="text-[10px] text-amber-300">
                                До: {new Date(cMeta.earliest_expiry * 1000).toLocaleDateString('ru-RU')}
                              </div>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Привязка к проектам (ACL) */}
                      <td className="py-3 px-3 font-sans">
                        <div className="flex flex-wrap items-center gap-1">
                          {usedBy.length === 0 ? (
                            <span className="text-[11px] text-slate-500">Не привязан к проектам</span>
                          ) : (
                            usedBy.map((p) => (
                              <span
                                key={p.id}
                                className="px-2 py-0.5 rounded bg-indigo-950/70 text-indigo-200 border border-indigo-500/30 text-[11px] font-mono"
                              >
                                {p.name}
                              </span>
                            ))
                          )}
                          {onUpdateProject && projects.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setEditingAclSecret(isEditingAcl ? null : s.name)}
                              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] cursor-pointer"
                            >
                              {isEditingAcl ? 'Готово' : 'Настроить доступ'}
                            </button>
                          )}
                        </div>

                        {isEditingAcl && onUpdateProject && (
                          <div className="mt-2 p-2 bg-[#0f172a] border border-slate-700 rounded-lg flex flex-wrap gap-1.5">
                            {projects.map((p) => {
                              const allowed = (p.secrets || []).includes(s.name);
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  onClick={() => handleToggleSecretForProject(s.name, p)}
                                  className={`px-2 py-1 rounded text-[11px] font-mono border cursor-pointer ${
                                    allowed
                                      ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-200'
                                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                                  }`}
                                >
                                  {allowed ? '✓ ' : '+ '}
                                  {p.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>

                      {/* Размер и время обновления */}
                      <td className="py-3 px-3 text-slate-300">
                        <div>{formatBytes(s.size_bytes)}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {new Date(s.updated_at * 1000).toLocaleString('ru-RU')}
                        </div>
                      </td>

                      {/* Статус актуальности */}
                      <td className="py-3 px-3">
                        {s.is_expired === 1 ? (
                          <div className="space-y-1">
                            <span className="px-2 py-0.5 rounded bg-red-950/80 text-red-300 border border-red-500/40 inline-block">
                              ИСТЕКЛИ (требуют обновления)
                            </span>
                            {s.expired_note && (
                              <div className="text-[11px] text-red-200 font-sans max-w-[200px]">
                                {s.expired_note}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-500/30">
                            Активен (0600)
                          </span>
                        )}
                      </td>

                      {/* Действия */}
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            if (s.type === 'cookie_json') {
                              setCookieSecretName(s.name);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            } else {
                              setNewName(s.name);
                              setNewType(s.type);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }
                          }}
                          title="Заменить значение этого секрета в форме выше"
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 inline-flex items-center gap-1 font-sans cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Заменить
                        </button>

                        {s.is_expired === 0 && (
                          <button
                            type="button"
                            onClick={() => onExpireCookie(s.name)}
                            title="Пометить куки устаревшими (тест алерта)"
                            className="px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 inline-flex items-center gap-1 font-sans cursor-pointer"
                          >
                            <ShieldAlert className="w-3 h-3" />
                            Истёк
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onDeleteSecret(s.name)}
                          title="Удалить секрет"
                          className="p-1.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 inline-flex items-center cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
