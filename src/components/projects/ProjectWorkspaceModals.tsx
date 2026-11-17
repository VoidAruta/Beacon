import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode,
  Folder,
  Info,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { formatBytes } from '../../utils/hubLogic';
import {
  BEACON_SDK_COMPLETIONS,
  classifyStatusNotice,
  LABELS,
  NoticeTone,
  SdkCompletionItem,
} from './projectWorkspaceUtils';

export const StatusNoticeBanner: React.FC<{
  text?: string;
  message?: string;
  toneOverride?: NoticeTone;
  compact?: boolean;
  inline?: boolean;
  onDismiss?: () => void;
}> = React.memo(({ text, message, toneOverride, compact = false, inline = false, onDismiss }) => {
  const msg = text || message || '';
  if (!msg) return null;
  const tone = toneOverride || classifyStatusNotice(msg);

  const toneStyles: Record<
    NoticeTone,
    { box: string; text: string; Icon: React.ComponentType<{ className?: string }> }
  > = {
    success: {
      box: 'bg-emerald-950/40 border-emerald-700/60 text-emerald-200',
      text: 'text-emerald-300',
      Icon: CheckCircle2,
    },
    error: {
      box: 'bg-rose-950/50 border-rose-600/70 text-rose-200',
      text: 'text-rose-300',
      Icon: XCircle,
    },
    warning: {
      box: 'bg-amber-950/50 border-amber-600/70 text-amber-200',
      text: 'text-amber-300',
      Icon: AlertTriangle,
    },
    info: {
      box: 'bg-indigo-950/45 border-indigo-700/60 text-indigo-200',
      text: 'text-indigo-300',
      Icon: Info,
    },
  };

  const st = toneStyles[tone];
  const IconComp = st.Icon;

  if (inline || compact) {
    return (
      <span
        role={tone === 'error' ? 'alert' : 'status'}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono ${st.box}`}
      >
        <IconComp className="w-3.5 h-3.5 shrink-0" />
        <span>{msg}</span>
      </span>
    );
  }

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`px-3 py-2 rounded-lg border text-xs font-mono flex items-center justify-between gap-2 ${st.box}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <IconComp className="w-4 h-4 shrink-0" />
        <span className="break-words">{msg}</span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Закрыть уведомление"
          className="text-slate-400 hover:text-white cursor-pointer shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
});

export const DirtyDeployBanner: React.FC<{
  reason?: string;
  visible?: boolean;
  busy?: boolean;
  restarting?: boolean;
  onRestartNow: () => void;
  onDismiss: () => void;
}> = React.memo(({ reason, visible = true, busy = false, restarting = false, onRestartNow, onDismiss }) => {
  if (!visible && !reason) return null;
  const isBusy = busy || restarting;
  return (
    <div
      role="status"
      className="px-3.5 py-2.5 rounded-xl bg-amber-950/60 border border-amber-500/60 flex flex-wrap items-center justify-between gap-2.5 text-xs"
    >
      <div className="flex items-center gap-2 text-amber-100">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
        <span>
          <strong className="text-amber-300">
            {reason ? `${reason}:` : 'Код или настройки обновлены:'}
          </strong>{' '}
          {LABELS.dirtyDeployWarning}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          disabled={isBusy}
          onClick={onRestartNow}
          className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-semibold inline-flex items-center gap-1.5 cursor-pointer"
        >
          <RotateCcw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
          <span>{isBusy ? 'Перезапуск...' : LABELS.dirtyDeployAction}</span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Скрыть напоминание о перезапуске"
          className="p-1 text-amber-300 hover:text-white cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
});

export const DeleteEntryConfirmModal: React.FC<{
  entry?: { path: string; isDir: boolean } | null;
  projectName?: string;
  open?: boolean;
  path?: string;
  isDir?: boolean;
  isLastFile?: boolean;
  isEntrypoint?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({
  entry,
  projectName,
  open,
  path,
  isDir,
  isLastFile = false,
  isEntrypoint = false,
  busy,
  onCancel,
  onConfirm,
}) => {
  const resolvedOpen = entry ? Boolean(entry.path) : Boolean(open && path);
  const resolvedPath = entry?.path || path || '';
  const resolvedIsDir = entry ? entry.isDir : Boolean(isDir);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!resolvedOpen) return;
    cancelBtnRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [resolvedOpen, onCancel]);

  if (!resolvedOpen || !resolvedPath) return null;

  const looksLikeEntrypoint =
    isEntrypoint ||
    resolvedPath === 'main.py' ||
    resolvedPath === 'bot.py' ||
    resolvedPath === 'index.js' ||
    resolvedPath === 'project.yaml';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${LABELS.deleteFileModalTitle}: ${resolvedPath}`}
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111622] border border-rose-500/60 rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl"
      >
        <div className="flex items-center gap-2.5 text-rose-300">
          {resolvedIsDir ? (
            <Folder className="w-5 h-5 shrink-0 text-amber-400" />
          ) : (
            <Trash2 className="w-5 h-5 shrink-0" />
          )}
          <h3 className="text-sm font-bold text-white">
            Удалить {resolvedIsDir ? 'папку со всем содержимым' : 'файл'} «{resolvedPath}»
            {projectName ? ` из проекта «${projectName}»` : ''}?
          </h3>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          {resolvedIsDir
            ? `Папка «${resolvedPath}/» и все вложенные в неё файлы будут безвозвратно удалены с диска сервера.`
            : `Файл «${resolvedPath}» будет безвозвратно удалён из рабочей папки проекта на диске.`}
        </p>

        {(isLastFile || looksLikeEntrypoint || resolvedIsDir) && (
          <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-700/60 text-xs text-rose-200 space-y-1">
            {looksLikeEntrypoint && !resolvedIsDir && (
              <div>
                ⚠️ <strong>Внимание:</strong> это ключевой файл проекта! Его удаление может привести к сбою при следующем
                старте.
              </div>
            )}
            {isLastFile && !resolvedIsDir && (
              <div>
                ⚠️ <strong>Это единственный файл в проекте.</strong>
              </div>
            )}
            {resolvedIsDir && (
              <div>
                ⚠️ <strong>Рекурсивное удаление каталога:</strong> убедитесь, что внутри нет важных данных или баз SQLite.
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            ref={cancelBtnRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
          >
            Отмена (Esc)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="px-3.5 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{busy ? 'Удаление...' : resolvedIsDir ? 'Удалить папку' : 'Удалить файл'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export const FuzzyFileModal: React.FC<{
  open: boolean;
  projectName?: string;
  files: Array<{ path: string; name: string; size: number; is_dir: boolean }>;
  activeFilePath: string;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}> = ({ open, projectName, files, activeFilePath, onSelectFile, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onlyFiles = useMemo(() => files.filter((f) => !f.is_dir), [files]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return onlyFiles.slice(0, 30);
    return onlyFiles
      .filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      .slice(0, 30);
  }, [onlyFiles, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={LABELS.fuzzyModalTitle}
      className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-start justify-center pt-20 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#111622] border border-indigo-500/50 rounded-xl max-w-lg w-full overflow-hidden shadow-2xl"
      >
        <div className="px-3.5 py-2.5 bg-[#0b0f17] border-b border-[#1e2638] flex items-center gap-2">
          <Search className="w-4 h-4 text-indigo-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((prev) => Math.min(Math.max(0, matched.length - 1), prev + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((prev) => Math.max(0, prev - 1));
              } else if (e.key === 'Enter' && matched[selectedIdx]) {
                e.preventDefault();
                onSelectFile(matched[selectedIdx].path);
                onClose();
              }
            }}
            placeholder={`Быстрый поиск файла${projectName ? ` в «${projectName}»` : ''} (↑↓ выбор, Enter открыть, Esc закрыть)...`}
            className="w-full bg-transparent text-xs font-mono text-white outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть быстрый поиск файлов"
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto divide-y divide-[#1e2638]/60">
          {matched.length === 0 ? (
            <div className="p-6 text-center text-xs font-mono text-slate-400">Файлы не найдены</div>
          ) : (
            matched.map((item, idx) => {
              const isSelected = idx === selectedIdx;
              const isCurrent = item.path === activeFilePath;
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    onSelectFile(item.path);
                    onClose();
                  }}
                  className={`w-full px-3.5 py-2 text-left flex items-center justify-between gap-2 text-xs font-mono cursor-pointer transition-colors ${
                    isSelected ? 'bg-indigo-600/30 text-white' : 'text-slate-300 hover:bg-[#0b0f17]'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FileCode className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                    <span className="truncate">{item.path}</span>
                    {isCurrent && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-950 text-indigo-300 border border-indigo-700/60">
                        открыт
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-slate-400 shrink-0">{formatBytes(item.size)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

// Легковесная подсветка синтаксиса для редактора кода (0 КБ сторонних библиотек, мгновенно на RPi/Android)
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TOKEN_RE_BY_EXT: Record<string, RegExp> = {
  py: /(#.*$)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(beacon(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\b|\b(def|class|async|await|import|from|as|return|if|elif|else|for|while|try|except|finally|with|raise|yield|pass|break|continue|in|is|not|and|or|lambda|True|False|None)\b|(@[a-zA-Z_][a-zA-Z0-9_.]*)|\b(\d+(?:\.\d+)?)\b/gm,
  js: /(\/\/.*$|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(beacon(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\b|\b(const|let|var|function|async|await|return|if|else|for|while|try|catch|finally|import|export|from|require|new|class|true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b/gm,
  yaml: /(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|^(\s*[a-zA-Z0-9_-]+)(?=:)|\b(true|false|null|yes|no|on|off)\b|\b(\d+(?:\.\d+)?)\b/gm,
  json: /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?)\b/gm,
  sh: /(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\})|\b(if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|exit|set|export|local|echo|cd)\b|\b(\d+)\b/gm,
};

function resolveExtFromPathOrLang(filePath?: string, extProp?: string, langLabel?: string): string {
  if (extProp) return extProp.replace(/^\./, '').toLowerCase();
  const lower = (filePath || '').toLowerCase();
  if (lower.endsWith('.py')) return 'py';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'js';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'sh';
  const lbl = (langLabel || '').toLowerCase();
  if (lbl.includes('python')) return 'py';
  if (lbl.includes('js') || lbl.includes('ts') || lbl.includes('node') || lbl.includes('javascript') || lbl.includes('typescript')) return 'js';
  if (lbl.includes('yaml')) return 'yaml';
  if (lbl.includes('json')) return 'json';
  if (lbl.includes('shell') || lbl.includes('bash')) return 'sh';
  return 'txt';
}

function buildHighlightedHtml(code: string, ext: string): string {
  if (!code) return '';
  if (code.length > 80000) {
    return escapeHtml(code);
  }
  const normExt = ext === 'ts' ? 'js' : ext;
  const re = TOKEN_RE_BY_EXT[normExt];
  if (!re) {
    return escapeHtml(code);
  }

  let result = '';
  let lastIndex = 0;
  re.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(code)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(code.slice(lastIndex, match.index));
    }
    const full = match[0];
    if (normExt === 'json') {
      const [, strTok, colonPart, boolTok, numTok] = match;
      if (strTok && colonPart) {
        result += `<span class="text-indigo-300">${escapeHtml(strTok)}</span>${escapeHtml(colonPart)}`;
      } else if (strTok) {
        result += `<span class="text-emerald-300">${escapeHtml(strTok)}</span>`;
      } else if (boolTok) {
        result += `<span class="text-amber-300">${escapeHtml(boolTok)}</span>`;
      } else if (numTok) {
        result += `<span class="text-cyan-300">${escapeHtml(numTok)}</span>`;
      } else {
        result += escapeHtml(full);
      }
    } else if (normExt === 'yaml') {
      const [, commentTok, strTok, keyTok, boolTok, numTok] = match;
      if (commentTok) {
        result += `<span class="text-slate-500 italic">${escapeHtml(commentTok)}</span>`;
      } else if (strTok) {
        result += `<span class="text-emerald-300">${escapeHtml(strTok)}</span>`;
      } else if (keyTok) {
        result += `<span class="text-indigo-300">${escapeHtml(keyTok)}</span>`;
      } else if (boolTok) {
        result += `<span class="text-amber-300">${escapeHtml(boolTok)}</span>`;
      } else if (numTok) {
        result += `<span class="text-cyan-300">${escapeHtml(numTok)}</span>`;
      } else {
        result += escapeHtml(full);
      }
    } else {
      const [, commentTok, strTok, beaconTok, kwTok, decTok, numTok] = match;
      if (commentTok) {
        result += `<span class="text-slate-500 italic">${escapeHtml(commentTok)}</span>`;
      } else if (strTok) {
        result += `<span class="text-emerald-300">${escapeHtml(strTok)}</span>`;
      } else if (beaconTok) {
        result += `<span class="text-cyan-300 font-semibold">${escapeHtml(beaconTok)}</span>`;
      } else if (kwTok) {
        result += `<span class="text-purple-300 font-semibold">${escapeHtml(kwTok)}</span>`;
      } else if (decTok) {
        result += `<span class="text-amber-300">${escapeHtml(decTok)}</span>`;
      } else if (numTok) {
        result += `<span class="text-amber-200">${escapeHtml(numTok)}</span>`;
      } else {
        result += escapeHtml(full);
      }
    }
    lastIndex = re.lastIndex;
    if (match[0].length === 0) {
      re.lastIndex++;
    }
  }

  if (lastIndex < code.length) {
    result += escapeHtml(code.slice(lastIndex));
  }
  return result + (code.endsWith('\n') ? ' ' : '');
}

export interface SyntaxCodeEditorProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  gutterRef: React.RefObject<HTMLElement | null>;
  value: string;
  filePath?: string;
  langLabel?: string;
  ext?: string;
  tabSize: number;
  wordWrap: boolean;
  viewportHeightCls: string;
  cursorLine?: number;
  onChange: (nextVal: string) => void;
  onCursorChange: (ta: HTMLTextAreaElement) => void;
  onSave: () => void;
  onSaveAndRestart: () => void;
  onStartProject?: () => void;
  onOpenFind: () => void;
  onOpenFuzzy?: () => void;
  onCloseActiveTab: () => void;
  onEscape?: () => void;
}

export const SyntaxCodeEditor: React.FC<SyntaxCodeEditorProps> = React.memo(
  ({
    textareaRef,
    gutterRef,
    value,
    filePath,
    langLabel,
    ext,
    tabSize,
    wordWrap,
    viewportHeightCls,
    onChange,
    onCursorChange,
    onSave,
    onSaveAndRestart,
    onStartProject,
    onOpenFind,
    onOpenFuzzy,
    onCloseActiveTab,
    onEscape,
  }) => {
    const highlightPreRef = useRef<HTMLPreElement | null>(null);
    const [sdkSuggestPrefix, setSdkSuggestPrefix] = useState<string | null>(null);
    const [sdkSelectedIdx, setSdkSelectedIdx] = useState(0);

    const resolvedExt = useMemo(
      () => resolveExtFromPathOrLang(filePath, ext, langLabel),
      [filePath, ext, langLabel]
    );

    const lineCount = useMemo(() => Math.max(1, value.split('\n').length), [value]);

    // Единый текстовый узел номеров строк в <pre> вместо тысяч отдельных <div> (Audit #8)
    const lineNumbersText = useMemo(() => {
      const nums: number[] = new Array(lineCount);
      for (let i = 0; i < lineCount; i++) {
        nums[i] = i + 1;
      }
      return nums.join('\n');
    }, [lineCount]);

    const highlightedHtml = useMemo(
      () => buildHighlightedHtml(value, resolvedExt),
      [value, resolvedExt]
    );

    const matchingCompletions = useMemo(() => {
      if (sdkSuggestPrefix === null) return [];
      const q = sdkSuggestPrefix.toLowerCase();
      return BEACON_SDK_COMPLETIONS.filter((item) => item.insertSuffix.toLowerCase().startsWith(q));
    }, [sdkSuggestPrefix]);

    const updateMetricsAndAutocomplete = (ta: HTMLTextAreaElement) => {
      onCursorChange(ta);
      const pos = ta.selectionStart || 0;
      const before = ta.value.slice(0, pos);
      const lines = before.split('\n');
      const curLineText = lines[lines.length - 1] || '';

      const m = curLineText.match(/\bbeacon\.([a-zA-Z0-9_.]*)$/);
      if (m) {
        setSdkSuggestPrefix(m[1] || '');
        setSdkSelectedIdx(0);
      } else {
        setSdkSuggestPrefix(null);
      }
    };

    const applySdkCompletion = (comp: SdkCompletionItem) => {
      const ta = textareaRef.current;
      if (!ta || sdkSuggestPrefix === null) return;
      const pos = ta.selectionStart || 0;
      const startReplace = pos - sdkSuggestPrefix.length;
      const nextVal = value.slice(0, startReplace) + comp.insertSuffix + value.slice(pos);
      onChange(nextVal);
      setSdkSuggestPrefix(null);
      requestAnimationFrame(() => {
        ta.focus();
        const nextCursor = startReplace + comp.insertSuffix.length;
        ta.selectionStart = ta.selectionEnd = nextCursor;
        updateMetricsAndAutocomplete(ta);
      });
    };

    const handleScrollSync = (e: React.UIEvent<HTMLTextAreaElement>) => {
      const top = e.currentTarget.scrollTop;
      const left = e.currentTarget.scrollLeft;
      if (gutterRef.current) {
        gutterRef.current.scrollTop = top;
      }
      if (highlightPreRef.current) {
        highlightPreRef.current.scrollTop = top;
        highlightPreRef.current.scrollLeft = left;
      }
    };

    return (
      <div className={`relative flex bg-[#070b14] overflow-hidden ${viewportHeightCls}`}>
        {/* Оптимизированная колонка номеров строк (один <pre> вместо тысяч <div>) */}
        <pre
          ref={gutterRef as React.RefObject<HTMLPreElement | null>}
          aria-hidden="true"
          className="select-none h-full m-0 py-4 px-2.5 bg-[#090d18] border-r border-[#1e2638]/80 text-right font-mono text-xs leading-relaxed text-slate-500 overflow-hidden shrink-0 min-w-[48px] tabular-nums"
        >
          {lineNumbersText}
        </pre>

        {/* Основной контейнер редактора со слоем подсветки синтаксиса */}
        <div className="relative flex-1 h-full overflow-hidden">
          <pre
            ref={highlightPreRef}
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 m-0 p-4 text-xs font-mono leading-relaxed text-slate-100 overflow-hidden ${
              wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
            }`}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />

          <textarea
            ref={textareaRef}
            value={value}
            aria-label="Редактор кода файла проекта"
            onChange={(e) => {
              onChange(e.target.value);
              updateMetricsAndAutocomplete(e.target);
            }}
            onClick={(e) => updateMetricsAndAutocomplete(e.currentTarget)}
            onKeyUp={(e) => {
              if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
                updateMetricsAndAutocomplete(e.currentTarget);
              }
            }}
            onScroll={handleScrollSync}
            onKeyDown={(e) => {
              if (matchingCompletions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSdkSelectedIdx((prev) => (prev + 1) % matchingCompletions.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSdkSelectedIdx((prev) => (prev - 1 + matchingCompletions.length) % matchingCompletions.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  applySdkCompletion(matchingCompletions[sdkSelectedIdx] || matchingCompletions[0]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSdkSuggestPrefix(null);
                  return;
                }
              }

              // Ctrl+Shift+S -> Сохранить файл и перезапустить проект
              if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                onSaveAndRestart();
                return;
              }
              // Ctrl+S -> Сохранить файл
              if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                onSave();
                return;
              }
              // Ctrl+Enter -> Запустить/перезапустить проект
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onStartProject) {
                e.preventDefault();
                onStartProject();
                return;
              }
              // Alt+P или Ctrl+P -> Быстрый переход к файлу проекта
              if ((e.altKey || e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p' && onOpenFuzzy) {
                e.preventDefault();
                onOpenFuzzy();
                return;
              }
              // Alt+W -> Закрыть текущую вкладку файла (не закрывает вкладку браузера!)
              if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === 'w' || e.code === 'KeyW')) {
                e.preventDefault();
                onCloseActiveTab();
                return;
              }
              // Ctrl+F или Alt+F -> Поиск и замена в редакторе
              if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                onOpenFind();
                return;
              }
              if (e.key === 'Escape' && onEscape) {
                onEscape();
                return;
              }

              if (e.key === 'Tab') {
                e.preventDefault();
                const ta = e.currentTarget;
                const start = ta.selectionStart || 0;
                const end = ta.selectionEnd || 0;
                const spaces = ' '.repeat(tabSize);
                const nextVal = value.slice(0, start) + spaces + value.slice(end);
                onChange(nextVal);
                requestAnimationFrame(() => {
                  ta.selectionStart = ta.selectionEnd = start + spaces.length;
                  updateMetricsAndAutocomplete(ta);
                });
              }
            }}
            spellCheck={false}
            wrap={wordWrap ? 'soft' : 'off'}
            placeholder="Выберите файл в проводнике слева или создайте новый файл..."
            className={`relative z-10 w-full h-full bg-transparent p-4 text-xs font-mono text-transparent caret-white selection:bg-indigo-500/35 leading-relaxed focus:outline-none resize-none overflow-y-auto ${
              wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'
            }`}
          />

          {/* Всплывающее меню автодополнения при вводе `beacon.` */}
          {matchingCompletions.length > 0 && (
            <div className="absolute left-6 bottom-3 z-20 w-96 max-w-[calc(100%-24px)] bg-[#111622] border border-indigo-500/60 rounded-xl shadow-2xl overflow-hidden">
              <div className="px-3 py-1.5 bg-[#0b0f17] border-b border-[#1e2638] flex items-center justify-between text-[10px] font-mono text-indigo-300">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3" />
                  Автодополнение Beacon SDK (Tab / Enter)
                </span>
                <button
                  type="button"
                  onClick={() => setSdkSuggestPrefix(null)}
                  aria-label="Скрыть подсказки SDK"
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="max-h-44 overflow-y-auto divide-y divide-[#1e2638]/60">
                {matchingCompletions.map((comp, idx) => (
                  <button
                    key={comp.label}
                    type="button"
                    onClick={() => applySdkCompletion(comp)}
                    className={`w-full px-3 py-1.5 text-left flex flex-col gap-0.5 cursor-pointer ${
                      idx === sdkSelectedIdx ? 'bg-indigo-600/30 text-white' : 'text-slate-300 hover:bg-[#0b0f17]'
                    }`}
                  >
                    <code className="text-[11px] font-mono text-cyan-300 font-semibold">{comp.label}</code>
                    <span className="text-[10px] text-slate-400">{comp.detail}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);
