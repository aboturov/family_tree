import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { scanUrl } from '../api.ts';

// Скан с приближением: почерк в метрике мелкий, без лупы его не прочесть. Колесо и щипок —
// приближение к точке под курсором или пальцами, перетаскивание — сдвиг, двойной клик —
// «вплотную» и обратно «целиком». Пока грузится оригинал, видна растянутая миниатюра.

type Scan = { id: number; width: number; height: number };
/** Картинка в рамке: масштаб (точек экрана на точку скана) и левый верхний угол. */
type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };

const MAX_SCALE = 3;
const STEP = 1.4;

export function ScanViewer({ scan, alt }: { scan: Scan; alt: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // null — «целиком»: следует за размером рамки.
  const [view, setView] = useState<View | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ view: View; points: Point[] } | null>(null);

  useLayoutEffect(() => {
    const el = stage.current!;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setView(null);
    setLoaded(false);
  }, [scan.id]);

  const fitScale = size.width ? Math.min(size.width / scan.width, size.height / scan.height, 1) : 0;
  const clamp = (v: View): View => {
    const scale = Math.min(MAX_SCALE, Math.max(fitScale, v.scale));
    const w = scan.width * scale;
    const h = scan.height * scale;
    // Меньше рамки — по центру, больше — края не отходят внутрь.
    const x = w <= size.width ? (size.width - w) / 2 : Math.min(0, Math.max(size.width - w, v.x));
    const y = h <= size.height ? (size.height - h) / 2 : Math.min(0, Math.max(size.height - h, v.y));
    return { scale, x, y };
  };
  const current = view ?? clamp({ scale: fitScale, x: 0, y: 0 });

  /** Масштаб в `scale`, точка рамки `at` остаётся на месте. */
  const zoomTo = (scale: number, at: Point, from: View = current) => {
    const next = clamp({
      scale,
      x: at.x - ((at.x - from.x) * scale) / from.scale,
      y: at.y - ((at.y - from.y) * scale) / from.scale,
    });
    setView(next.scale <= fitScale ? null : next);
  };
  const center = () => ({ x: size.width / 2, y: size.height / 2 });

  // Колесо — через addEventListener: у React обработчик пассивный, прокрутку окна не отменить.
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;
  const viewRef = useRef(current);
  viewRef.current = current;
  useEffect(() => {
    const el = stage.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
      zoomRef.current(viewRef.current.scale * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const startGesture = () => {
    gesture.current = pointers.current.size ? { view: current, points: [...pointers.current.values()] } : null;
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    startGesture();
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    const start = gesture.current;
    if (!start) return;
    const points = [...pointers.current.values()];
    if (points.length === 1 || start.points.length === 1) {
      // Сдвиг.
      setView(clamp({ ...start.view, x: start.view.x + points[0].x - start.points[0].x, y: start.view.y + points[0].y - start.points[0].y }));
      return;
    }
    // Щипок: точка скана под серединой пальцев идёт за ней, масштаб — за расстоянием.
    const mid = (p: Point[]) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
    const dist = (p: Point[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
    const scale = Math.min(MAX_SCALE, Math.max(fitScale, (start.view.scale * dist(points)) / dist(start.points)));
    const from = mid(start.points);
    const to = mid(points);
    setView(
      clamp({
        scale,
        x: to.x - ((from.x - start.view.x) * scale) / start.view.scale,
        y: to.y - ((from.y - start.view.y) * scale) / start.view.scale,
      }),
    );
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    startGesture();
  };

  const zoomed = current.scale > fitScale * 1.01;
  const box = { left: current.x, top: current.y, width: scan.width * current.scale, height: scan.height * current.scale };

  return (
    <div className="scan-viewer">
      <div
        ref={stage}
        className={zoomed ? 'scan-stage zoomed' : 'scan-stage'}
        // Рамка — по пропорциям скана: разворот на телефоне не висит в пустой высокой рамке.
        style={{ aspectRatio: `${scan.width} / ${scan.height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => (zoomed ? setView(null) : zoomTo(1, local(e)))}
      >
        {fitScale > 0 && (
          <>
            <img className="scan-image" src={scanUrl(scan.id, 'thumb')} alt="" draggable={false} style={box} />
            <img
              key={scan.id}
              className="scan-image"
              src={scanUrl(scan.id, 'original')}
              alt={alt}
              draggable={false}
              style={{ ...box, opacity: loaded ? 1 : 0 }}
              onLoad={() => setLoaded(true)}
            />
          </>
        )}
        {!loaded && <span className="scan-loading small">Загружаем скан…</span>}
      </div>
      <div className="scan-tools">
        <button type="button" className="square-button" onClick={() => zoomTo(current.scale / STEP, center())} disabled={!zoomed} aria-label="Отдалить">
          −
        </button>
        <span className="small muted scan-percent">{Math.round(current.scale * 100)}%</span>
        <button
          type="button"
          className="square-button"
          onClick={() => zoomTo(current.scale * STEP, center())}
          disabled={current.scale >= MAX_SCALE}
          aria-label="Приблизить"
        >
          +
        </button>
        <button type="button" className="link small" onClick={() => setView(null)} disabled={!zoomed}>
          Целиком
        </button>
        <a className="link small" href={scanUrl(scan.id, 'original')} target="_blank" rel="noopener">
          Оригинал ↗
        </a>
      </div>
    </div>
  );
}
