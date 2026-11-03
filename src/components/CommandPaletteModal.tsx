import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Play,
  Square,
  RotateCcw,
  Plus,
  FolderOpen,
  LayoutDashboard,
  FolderCode,
  KeyRound,
  Settings,
  FlaskConical,
  Download,
  CornerDownLeft,
  X,
} from 'lucide-react';
import { ProjectItem } from '../types/hub';
import { WorkspaceSubTab } from './ProjectsWorkspace';

interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectItem[];
  onNavigateTab: (tab: 'dashboard' | 'projects' | 'secrets' | 'settings' | 'acceptance') => void;
  onOpenProject: (project: ProjectItem, subTab?: WorkspaceSubTab) => void;
  onStartProject: (id: number) => Promise<any>;
  onStopProject: (id: number) => Promise<any>;
  onRestartProject: (id: number) => Promise<any>;
  onOpenCreateModal: () => void;
  onImportExamples: () => Promise<void>;
  onTestHubRestartSurvival: () => Promise<void>;
}

interface PaletteCommandItem {
  id: string;
  group: 'Проекты' | 'Быстрые действия' | 'Навигация';
  title: string;
  subtitle: string;
  keywords: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
}

export const CommandPaletteModal: React.FC<CommandPaletteModalProps> = ({
  isOpen,
  onClose,
  projects,
  onNavigateTab,
  onOpenProject,
  onStartProject,
  onStopProject,
  onRestartProject,
  onOpenCreateModal,
  onImportExamples,
  onTestHubRestartSurvival,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  const commands = useMemo<PaletteCommandItem[]>(() => {
    const items: PaletteCommandItem[] = [
      {
        id: 'act-create-project',
        group: 'Быстрые действия',
        title: 'Создать новый проект (Service / Web API / Job / GitHub)',
        subtitle: 'Мастер создания сервиса, веб-бэкенда или задачи из шаблона или Git',
        keywords: 'new create project github service web job создать проект',
        icon: <Plus className="w-4 h-4 text-indigo-400" />,
        action: () => {
          onClose();
          onOpenCreateModal();
        },
      },
      {
        id: 'act-import-examples',
        group: 'Быстрые действия',
        title: 'Импортировать готовые примеры из projects/examples/',
        subtitle: 'Добавляет heartbeat-daemon, web-status-api (:18081), sms-auth-bot и cookie-checker-job',
        keywords: 'import examples demo шаблоны примеры импорт',
        icon: <Download className="w-4 h-4 text-emerald-400" />,
        action: async () => {
          onClose();
          await onImportExamples();
        },
      },
      {
        id: 'act-test-sigpipe',
        group: 'Быстрые действия',
        title: 'Проверить выживание процессов при рестарте Hub (Direct FD)',
        subtitle: 'Перезагружает состояние супервизора без падения дочерних сервисов от SIGPIPE',
        keywords: 'restart survival sigpipe direct fd рестарт проверка',
        icon: <RotateCcw className="w-4 h-4 text-amber-400" />,
        action: async () => {
          onClose();
          await onTestHubRestartSurvival();
        },
      },
      {
        id: 'nav-dashboard',
        group: 'Навигация',
        title: 'Перейти: Дашборд и Реестр проектов',
        subtitle: 'Метрики CPU/RAM/Диска, профиль среды и управление процессами',
        keywords: 'dashboard overview дашборд обзор главная',
        icon: <LayoutDashboard className="w-4 h-4 text-slate-300" />,
        action: () => {
          onNavigateTab('dashboard');
          onClose();
        },
      },
      {
        id: 'nav-projects',
        group: 'Навигация',
        title: 'Перейти: Рабочее пространство и Консоль (Projects Workspace)',
        subtitle: 'Редактор кода, .venv/uv терминал, куки, расписание и живые логи',
        keywords: 'projects workspace code logs terminal код логи терминал',
        icon: <FolderCode className="w-4 h-4 text-slate-300" />,
        action: () => {
          onNavigateTab('projects');
          onClose();
        },
      },
      {
        id: 'nav-secrets',
        group: 'Навигация',
        title: 'Перейти: Центр событий, Куки и Секреты (0600)',
        subtitle: 'Импорт Cookie-Editor JSON, API-ключи и привязка секретов к проектам',
        keywords: 'secrets cookies ask events куки секреты токены',
        icon: <KeyRound className="w-4 h-4 text-slate-300" />,
        action: () => {
          onNavigateTab('secrets');
          onClose();
        },
      },
      {
        id: 'nav-settings',
        group: 'Навигация',
        title: 'Перейти: Настройки Панели, Пароль и Архив бэкапов',
        subtitle: 'Смена пароля администратора, системный Telegram-бот, прокси 10808 и Hub Doctor',
        keywords: 'settings password backup doctor настройки пароль прокси бэкап',
        icon: <Settings className="w-4 h-4 text-slate-300" />,
        action: () => {
          onNavigateTab('settings');
          onClose();
        },
      },
      {
        id: 'nav-acceptance',
        group: 'Навигация',
        title: 'Перейти: Полигон приёмки и Hub Doctor',
        subtitle: 'Автоматический прогон приёмочных проверок и диагностика окружения',
        keywords: 'acceptance tests doctor тесты приёмка диагностика',
        icon: <FlaskConical className="w-4 h-4 text-slate-300" />,
        action: () => {
          onNavigateTab('acceptance');
          onClose();
        },
      },
    ];

    for (const p of projects) {
      const isRunning = p.current_status === 'running' || p.current_status === 'waiting_input';
      const typeLabel = p.type === 'web' ? `Web :${p.port || 8080}` : p.type === 'service' ? 'Service 24/7' : 'Job';
      items.push({
        id: `proj-open-${p.id}`,
        group: 'Проекты',
        title: `${p.name} — Открыть код и логи`,
        subtitle: `${typeLabel} · ${p.runtime} · статус: ${p.current_status}${p.pid ? ` (PID ${p.pid})` : ''}`,
        keywords: `${p.name} ${p.group_tag || ''} ${p.description || ''} ${p.runtime} ${p.type} open code`,
        icon: <FolderOpen className="w-4 h-4 text-indigo-400" />,
        action: () => {
          onOpenProject(p, 'editor');
          onClose();
        },
      });

      if (!isRunning) {
        items.push({
          id: `proj-start-${p.id}`,
          group: 'Проекты',
          title: `${p.name} — Запустить (Start)`,
          subtitle: `Запуск ${typeLabel} (${p.cmd})`,
          keywords: `start run ${p.name} старт запуск`,
          icon: <Play className="w-4 h-4 text-emerald-400" />,
          action: async () => {
            onClose();
            await onStartProject(p.id);
          },
        });
      } else {
        items.push({
          id: `proj-stop-${p.id}`,
          group: 'Проекты',
          title: `${p.name} — Остановить группу PGID (Stop)`,
          subtitle: `Остановка дерева процессов PID ${p.pid}`,
          keywords: `stop kill ${p.name} стоп остановить`,
          icon: <Square className="w-4 h-4 text-rose-400" />,
          action: async () => {
            onClose();
            await onStopProject(p.id);
          },
        });
        items.push({
          id: `proj-restart-${p.id}`,
          group: 'Проекты',
          title: `${p.name} — Перезапустить (Restart)`,
          subtitle: `Чистый перезапуск процесса PID ${p.pid}`,
          keywords: `restart reload ${p.name} рестарт перезапуск`,
          icon: <RotateCcw className="w-4 h-4 text-amber-400" />,
          action: async () => {
            onClose();
            await onRestartProject(p.id);
          },
        });
      }
    }

    return items;
  }, [
    projects,
    onClose,
    onOpenCreateModal,
    onImportExamples,
    onTestHubRestartSurvival,
    onNavigateTab,
    onOpenProject,
    onStartProject,
    onStopProject,
    onRestartProject,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter' && filtered[activeIndex]) {
        e.preventDefault();
        filtered[activeIndex].action();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filtered, activeIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Командная палитра Hub"
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-start justify-center pt-16 sm:pt-24 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#111622] border border-slate-700/80 rounded-xl max-w-2xl w-full shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
          <Search className="w-4 h-4 text-indigo-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Введите имя проекта, команду (start, stop, import) или раздел..."
            className="flex-1 bg-transparent text-sm text-white placeholder-slate-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded cursor-pointer"
            title="Закрыть (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[380px] overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">
              Ничего не найдено по запросу «{query}»
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => item.action()}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                    isSelected ? 'bg-indigo-600/20 border border-indigo-500/40 text-white' : 'hover:bg-slate-800/60 text-slate-200 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="shrink-0">{item.icon}</div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{item.title}</div>
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">{item.subtitle}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-[11px] text-slate-400 font-mono">
                    <span>{item.group}</span>
                    {isSelected && <CornerDownLeft className="w-3.5 h-3.5 text-indigo-400" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="px-4 py-2 bg-[#0b0f17] border-t border-slate-800/90 flex items-center justify-between text-[11px] text-slate-400 font-mono">
          <span>↑↓ выбор · Enter выполнить · Esc закрыть</span>
          <span>Hub Operations Palette</span>
        </div>
      </div>
    </div>
  );
};
