// Тема оформления: «авто» — как в системе, либо принудительно светлая или тёмная.
// Выбор хранится в браузере; index.html ставит его ещё до отрисовки, чтобы не мигало.

export type Theme = 'auto' | 'light' | 'dark';

const KEY = 'theme';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(theme: Theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Без хранилища тема продержится до перезагрузки.
  }
}
