import React, { createContext, useCallback, useContext, useState } from 'react';

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

  return (
    <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
