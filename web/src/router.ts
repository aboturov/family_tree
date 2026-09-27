import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// Три страницы (дерево, люди, человек) — отдельная библиотека маршрутизации тут не нужна.

const subscribe = (callback: () => void) => {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
};

export function useLocation(): URL {
  const href = useSyncExternalStore(subscribe, () => window.location.href);
  return new URL(href);
}

export function navigate(to: string, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (!replace) window.scrollTo(0, 0);
}

export function Link({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Ctrl/⌘-клик и средняя кнопка — как у обычной ссылки, в новой вкладке.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return createElement('a', { ...props, href: to, onClick });
}

export const personPath = (id: number) => `/person/${id}`;
export const treePath = (params: { view?: string; center?: number; depth?: number; person?: number } = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const query = search.toString();
  return query ? `/?${query}` : '/';
};
