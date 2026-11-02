import React, { useState } from 'react';
import { AlertTriangle, KeyRound, Send, Cookie, X, CheckCircle2 } from 'lucide-react';
import { ExpiredCookie, PendingAsk } from '../types/hub';
import { validateCookieEditorJson } from '../utils/hubLogic';

interface GlobalAlertBannersProps {
  pendingAsks: PendingAsk[];
  expiredCookies: ExpiredCookie[];
  onAnswerAsk: (askId: string, answer: string) => Promise<void>;
  onImportCookieJson: (secretName: string, rawJson: string) => Promise<void>;
}

const SAMPLE_COOKIE_EDITOR_JSON = JSON.stringify(
  [
    {
      domain: '.telegram.org',
      name: 'stel_ssid',
      value: 'hub_refreshed_cookie_99281a',
      path: '/',
      httpOnly: true,
      secure: true,
    },
    {
      domain: '.telegram.org',
      name: 'stel_token',
      value: 'token_active_2026_v2',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  ],
  null,
  2
);

export const GlobalAlertBanners: React.FC<GlobalAlertBannersProps> = ({
  pendingAsks,
  expiredCookies,
  onAnswerAsk,
  onImportCookieJson,
}) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submittingAskId, setSubmittingAskId] = useState<string | null>(null);

  const [cookieModalTarget, setCookieModalTarget] = useState<string | null>(null);
  const [cookieRawJson, setCookieRawJson] = useState<string>(SAMPLE_COOKIE_EDITOR_JSON);
  const [cookieError, setCookieError] = useState<string | null>(null);
  const [cookieSubmitting, setCookieSubmitting] = useState<boolean>(false);

  const handleSendAnswer = async (askId: string, e: React.FormEvent) => {
    e.preventDefault();
    const val = (answers[askId] || '').trim();
    if (!val) return;
    setSubmittingAskId(askId);
    try {
      await onAnswerAsk(askId, val);
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[askId];
        return next;
      });
    } finally {
      setSubmittingAskId(null);
    }
  };

  const openCookieModal = (secretName: string) => {
    setCookieModalTarget(secretName);
    setCookieRawJson(SAMPLE_COOKIE_EDITOR_JSON);
    setCookieError(null);
  };

  const handleSaveCookieJson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cookieModalTarget) return;
    const check = validateCookieEditorJson(cookieRawJson);
    if (!check.valid) {
      setCookieError(check.error || 'Некорректный JSON из Cookie-Editor');
      return;
    }
    setCookieSubmitting(true);
    setCookieError(null);
    try {
      await onImportCookieJson(cookieModalTarget, cookieRawJson);
      setCookieModalTarget(null);
    } catch (err: any) {
      setCookieError(err?.message || 'Ошибка сохранения куки');
    } finally {
      setCookieSubmitting(false);
    }
  };

  return (
    <>
      {/* 1. Жёлтый интерактивный баннер WAITING_INPUT (hub.ask) */}
      {pendingAsks.map((ask) => (
        <div
          key={ask.id}
          role="region"
          aria-label={`Интерактивный запрос от проекта ${ask.project_name}`}
          className="bg-amber-950/90 border-b border-amber-500/40 px-4 py-3 text-amber-100"
        >
          <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-start sm:items-center gap-3">
              <KeyRound className="w-5 h-5 text-amber-400 shrink-0 mt-0.5 sm:mt-0" />
              <div className="text-sm">
                <span className="font-semibold text-amber-300">WAITING_INPUT</span>
                <span className="mx-2 text-amber-500/70">·</span>
                <span className="font-medium text-white">Проект «{ask.project_name}»</span>
                <span className="mx-2 text-amber-500/70">·</span>
                <span className="text-amber-100">{ask.prompt}</span>
                <span className="ml-3 font-mono text-xs text-amber-300 tabular-nums">
                  (таймаут: {ask.remaining_sec}с)
                </span>
              </div>
            </div>

            <form onSubmit={(e) => handleSendAnswer(ask.id, e)} className="flex items-center gap-2 shrink-0">
              <input
                type="text"
                aria-label={`Ответ для ${ask.project_name}`}
                placeholder="Введите ответ (напр. 482910)..."
                value={answers[ask.id] || ''}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [ask.id]: e.target.value }))}
                className="px-3 py-1.5 text-sm bg-slate-950/90 border border-amber-500/50 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-amber-400 min-w-[210px]"
              />
              <button
                type="submit"
                disabled={submittingAskId === ask.id || !(answers[ask.id] || '').trim()}
                className="px-4 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Отправить
              </button>
            </form>
          </div>
        </div>
      ))}

      {/* 2. Красный баннер COOKIES_EXPIRED (hub.cookies_expired) */}
      {expiredCookies.map((ck) => (
        <div
          key={ck.name}
          role="region"
          aria-label={`Протухшие куки ${ck.name}`}
          className="bg-red-950/90 border-b border-red-500/40 px-4 py-2.5 text-red-100"
        >
          <div className="max-w-[1400px] mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
              <div>
                <span className="font-semibold text-red-300">COOKIES_EXPIRED</span>
                <span className="mx-2 text-red-500/70">·</span>
                <span className="font-mono text-white">{ck.name}</span>
                {ck.expired_note && (
                  <>
                    <span className="mx-2 text-red-500/70">·</span>
                    <span className="text-red-200">{ck.expired_note}</span>
                  </>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => openCookieModal(ck.name)}
              className="px-4 py-1.5 text-xs font-semibold bg-red-500 hover:bg-red-400 text-white rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer self-start sm:self-auto"
            >
              <Cookie className="w-3.5 h-3.5" />
              Обновить куки для {ck.name}
            </button>
          </div>
        </div>
      ))}

      {/* Модальное окно вставки JSON из Cookie-Editor в 1 клик */}
      {cookieModalTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Обновление куки для ${cookieModalTarget}`}
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-[#1e293b] border border-slate-700 rounded-xl max-w-xl w-full p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <Cookie className="w-5 h-5 text-indigo-400" />
                <h2 className="text-base font-semibold text-white">
                  Импорт Cookie-Editor для «{cookieModalTarget}»
                </h2>
              </div>
              <button
                type="button"
                aria-label="Закрыть окно импорта куки"
                onClick={() => setCookieModalTarget(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCookieJson} className="mt-4 space-y-4">
              <p className="text-xs text-slate-300">
                Скопируйте JSON-массив из браузерного расширения <strong>Cookie-Editor</strong> (Export → JSON) и
                вставьте ниже. Файл будет сохранён в{' '}
                <code className="font-mono text-indigo-300">/opt/hub/data/secrets/{cookieModalTarget}</code> с правами{' '}
                <code className="font-mono text-emerald-400">0600</code>, а флаг <code className="font-mono">is_expired</code> сбросится в 0.
              </p>

              <textarea
                rows={10}
                aria-label="JSON массив из Cookie-Editor"
                value={cookieRawJson}
                onChange={(e) => setCookieRawJson(e.target.value)}
                className="w-full p-3 bg-[#0f172a] border border-slate-700 rounded-lg font-mono text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              />

              {cookieError && (
                <div className="p-3 bg-red-950/60 border border-red-500/40 rounded-lg text-xs text-red-200">
                  {cookieError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setCookieModalTarget(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={cookieSubmitting}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {cookieSubmitting ? 'Сохранение...' : 'Сохранить и сбросить алерт'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
