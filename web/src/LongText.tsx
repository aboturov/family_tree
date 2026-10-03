import { useLayoutEffect, useRef, useState } from 'react';
import { splitLinks } from './links.ts';

/** Текст с живыми ссылками: вместо длинного адреса — сайт, полный адрес — в подсказке. */
export function LinkedText({ text }: { text: string }) {
  return splitLinks(text).map((part, i) =>
    'url' in part ? (
      <a key={i} href={part.url} target="_blank" rel="noopener noreferrer" title={part.url}>
        {part.label}&nbsp;↗
      </a>
    ) : (
      part.text
    ),
  );
}

/** Длинный текст в таблице: первые строки и «Показать полностью», чтобы строка не росла на экран. */
export function ClampedText({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);

  useLayoutEffect(() => {
    if (open) return;
    const el = box.current!;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <>
      <div ref={box} className={open ? 'long-text' : 'long-text clamped'}>
        <LinkedText text={text} />
      </div>
      {(long || open) && (
        <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
    </>
  );
}
