import { Component, type ReactNode } from 'react';

const RELOADED_KEY = 'chunk-reload-at';

/**
 * Ловит ошибку загрузки ленивого чанка (обычно — старая вкладка после деплоя ссылается
 * на удалённый файл). Один раз перезагружает страницу сама, дальше — показывает кнопку.
 */
export class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOADED_KEY)) || 0;
      sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
    } catch {
      return;
    }
    // Не чаще раза в минуту, чтобы не уйти в бесконечную перезагрузку.
    if (Date.now() - last > 60_000) window.location.reload();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="placeholder">
        <div style={{ textAlign: 'center' }}>
          <p>Не удалось загрузить дерево — возможно, сайт обновился.</p>
          <button className="button" onClick={() => window.location.reload()}>
            Обновить страницу
          </button>
        </div>
      </div>
    );
  }
}
