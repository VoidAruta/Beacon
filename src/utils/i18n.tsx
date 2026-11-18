import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { EXACT_RU_TO_EN, PHRASE_REPLACEMENTS } from './i18nDict';

export type AppLanguage = 'ru' | 'en';

interface I18nContextValue {
  lang: AppLanguage;
  setLang: (next: AppLanguage) => void;
  toggleLang: () => void;
  t: (ruText: string, enText: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'ru',
  setLang: () => {},
  toggleLang: () => {},
  t: (ruText) => ruText,
});

const CYRILLIC_RE = /[А-Яа-яЁё]/;

export function translateStringToEn(input: string): string {
  if (!input || !CYRILLIC_RE.test(input)) return input;

  const leading = input.match(/^\s*/)?.[0] ?? '';
  const trailing = input.match(/\s*$/)?.[0] ?? '';
  const normalized = input.replace(/\s+/g, ' ').trim();

  if (EXACT_RU_TO_EN[normalized]) {
    return leading + EXACT_RU_TO_EN[normalized] + trailing;
  }

  let result = normalized;
  for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
    if (typeof pattern === 'string') {
      if (result.includes(pattern)) {
        result = result.split(pattern).join(replacement);
      }
    } else {
      result = result.replace(pattern, replacement);
    }
    if (!CYRILLIC_RE.test(result)) break;
  }

  if (EXACT_RU_TO_EN[result]) {
    result = EXACT_RU_TO_EN[result];
  }

  return leading + result + trailing;
}

// Skip text node translation only inside SCRIPT, STYLE, and TEXTAREA (user code buffer)
const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
const SKIP_ATTR_TAGS = new Set(['SCRIPT', 'STYLE']);
const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label'] as const;

interface TrackedTextNode extends Text {
  __beaconOrigText?: string;
  __beaconLastEnText?: string;
}

function processDomTree(root: Node, lang: AppLanguage) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.currentNode;

  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      const textNode = current as TrackedTextNode;
      const parent = textNode.parentElement;
      if (
        parent &&
        !SKIP_TEXT_TAGS.has(parent.tagName) &&
        !parent.closest('[data-no-i18n="true"]')
      ) {
        const currentVal = textNode.nodeValue || '';
        if (lang === 'en') {
          if (CYRILLIC_RE.test(currentVal) && currentVal !== textNode.__beaconLastEnText) {
            textNode.__beaconOrigText = currentVal;
          }
          const source = textNode.__beaconOrigText ?? currentVal;
          if (CYRILLIC_RE.test(source)) {
            const translated = translateStringToEn(source);
            if (translated !== currentVal) {
              textNode.__beaconLastEnText = translated;
              textNode.nodeValue = translated;
            }
          }
        } else if (lang === 'ru' && textNode.__beaconOrigText !== undefined) {
          if (currentVal === textNode.__beaconLastEnText) {
            textNode.nodeValue = textNode.__beaconOrigText;
          }
          delete textNode.__beaconOrigText;
          delete textNode.__beaconLastEnText;
        }
      }
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement;
      if (!SKIP_ATTR_TAGS.has(el.tagName)) {
        for (const attr of TRANSLATABLE_ATTRS) {
          const val = el.getAttribute(attr);
          const origKey = `data-beacon-orig-${attr}`;
          if (lang === 'en' && val) {
            if (CYRILLIC_RE.test(val)) {
              el.setAttribute(origKey, val);
              const translated = translateStringToEn(val);
              if (translated !== val) {
                el.setAttribute(attr, translated);
              }
            }
          } else if (lang === 'ru') {
            const orig = el.getAttribute(origKey);
            if (orig !== null) {
              el.setAttribute(attr, orig);
              el.removeAttribute(origKey);
            }
          }
        }
      }
    }
    current = walker.nextNode();
  }
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<AppLanguage>(() => {
    try {
      const saved = localStorage.getItem('beacon_lang') || sessionStorage.getItem('beacon_lang');
      if (saved === 'en' || saved === 'ru') return saved;
    } catch {
      // ignore storage errors
    }
    return 'ru';
  });

  const setLang = useCallback((next: AppLanguage) => {
    setLangState(next);
    try {
      localStorage.setItem('beacon_lang', next);
      sessionStorage.setItem('beacon_lang', next);
      document.documentElement.lang = next;
    } catch {
      // ignore
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === 'ru' ? 'en' : 'ru');
  }, [lang, setLang]);

  const t = useCallback(
    (ruText: string, enText: string) => {
      return lang === 'en' ? enText : ruText;
    },
    [lang]
  );

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title =
      lang === 'en'
        ? 'Beacon — Autonomous Service & AI Agent Operations Console'
        : 'Beacon — Автономная консоль управления сервисами и ИИ-агентами';
    const root = document.getElementById('root') || document.body;
    let isApplying = false;

    const runPass = () => {
      if (isApplying) return;
      isApplying = true;
      try {
        processDomTree(root, lang);
      } finally {
        isApplying = false;
      }
    };

    runPass();

    if (lang !== 'en') {
      return;
    }

    let rafId: number | null = null;
    const observer = new MutationObserver(() => {
      if (isApplying) return;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        runPass();
      });
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label'],
    });

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
