import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Окно поверх страницы: закрывается по Escape, × и клику мимо содержимого. Если в окне
 * уже что-то вводили, сначала спрашивает — случайный клик мимо не должен стирать форму.
 * Кнопки самих форм («Отмена», «Сохранить») вызывают onClose напрямую, без вопроса.
 */
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  heading,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Заголовок сложнее строки (например, «Событие» мелко и тип крупно); title остаётся для чтения с экрана. */
  heading?: ReactNode;
}) {
  const dirty = useRef(false);
  const pressedOnBackdrop = useRef(false);
  const requestClose = useRef(() => {});
  requestClose.current = () => {
    if (dirty.current && !confirm('Закрыть без сохранения? Введённое пропадёт.')) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && requestClose.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      // Закрываем, только если и нажали, и отпустили на фоне: выделение текста в поле,
      // отпущенное за краем окна, браузер тоже считает кликом по фону.
      onMouseDown={(e) => (pressedOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (pressedOnBackdrop.current && e.target === e.currentTarget) requestClose.current();
        pressedOnBackdrop.current = false;
      }}
    >
      <div
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Любой ввод в полях окна — форма «грязная».
        onInput={() => (dirty.current = true)}
        onChange={() => (dirty.current = true)}
      >
        <div className="modal-head">
          {heading ?? <strong>{title}</strong>}
          <button className="button ghost" onClick={() => requestClose.current()} aria-label="Закрыть">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
