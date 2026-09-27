import { DatabaseSync } from 'node:sqlite';
import type { MarriageStyle } from '../../web/src/tree/geometry.ts';
import { RELATIVES_DEPTHS, type ViewMode } from '../../web/src/tree/views.ts';
import { EditError } from './editing.ts';

/**
 * Какие виды дерева открывают и как часто — чтобы фоновый пересчёт (precompute.ts) считал заранее
 * не только виды каждого от него самого, но и популярные: «Всё дерево от бабушки», если его часто
 * смотрят. Счёт затухающий — половина за две недели: давно не открытый вид уступает свежим.
 * Считаются виды, а не раскладки: счёт переживает правки дерева и выкладки. Лежит рядом с кэшем
 * раскладок (layouts.db): потерять его не страшно, в бэкапы он не нужен.
 */
export type OpenedView = { mode: ViewMode; centerId: number; depth: number; style: MarriageStyle };

export type ViewStats = {
  opened: (view: OpenedView) => void;
  /** Виды по убыванию счёта; только те, что открывали недавно. */
  popular: () => OpenedView[];
  close: () => void;
};

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
// Ниже — вид давно не открывали (одно открытие месяц назад — ¼), в популярные не берём.
const MIN_SCORE = 0.3;
// Ещё ниже — и помнить незачем.
const FORGET_SCORE = 0.02;
const MODES: ViewMode[] = ['family', 'relatives', 'clans', 'all'];
const STYLES: MarriageStyle[] = ['compact', 'bridges'];
// Глубина «Родни» по умолчанию (TreePage): у остальных видов её нет, храним её — ключ один.
const DEFAULT_DEPTH = 2;

// «От всех предков» — Infinity: в JSON и базе её нет, там -1 (в запросе — null).
const toStored = (depth: number) => (Number.isFinite(depth) ? depth : -1);
const fromStored = (depth: number) => (depth === -1 ? Infinity : depth);

export function createViewStats({ file, now = Date.now }: { file: string; now?: () => number }): ViewStats {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS view_opens (
      key TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      center_id INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      style TEXT NOT NULL,
      score REAL NOT NULL,
      seen_at INTEGER NOT NULL
    );
  `);
  const read = db.prepare('SELECT score, seen_at FROM view_opens WHERE key = ?');
  const write = db.prepare(
    'INSERT OR REPLACE INTO view_opens (key, mode, center_id, depth, style, score, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const all = db.prepare('SELECT key, mode, center_id, depth, style, score, seen_at FROM view_opens');
  const forget = db.prepare('DELETE FROM view_opens WHERE key = ?');
  const decayed = (score: number, seenAt: number, at: number) => score * 0.5 ** ((at - seenAt) / HALF_LIFE_MS);

  return {
    opened({ mode, centerId, depth, style }) {
      const stored = toStored(mode === 'relatives' ? depth : DEFAULT_DEPTH);
      const key = `${mode}|${centerId}|${stored}|${style}`;
      const at = now();
      const row = read.get(key) as { score: number; seen_at: number } | undefined;
      const score = (row ? decayed(row.score, row.seen_at, at) : 0) + 1;
      write.run(key, mode, centerId, stored, style, score, at);
    },
    popular() {
      const at = now();
      type Row = { key: string; mode: ViewMode; center_id: number; depth: number; style: MarriageStyle; score: number; seen_at: number };
      const rows = (all.all() as Row[]).map((row) => ({ ...row, current: decayed(row.score, row.seen_at, at) }));
      for (const row of rows) if (row.current < FORGET_SCORE) forget.run(row.key);
      return rows
        .filter((row) => row.current >= MIN_SCORE)
        .sort((a, b) => b.current - a.current || a.key.localeCompare(b.key))
        .map((row) => ({ mode: row.mode, centerId: row.center_id, depth: fromStored(row.depth), style: row.style }));
    },
    close: () => db.close(),
  };
}

/**
 * Какой вид открыт — из запроса раскладки (поле view): режим и глубина «Родни»; центр и стиль —
 * те же, что у раскладки. Нет поля — не считаем (старый клиент), чепуха — 400.
 */
export function parseOpenedView(
  value: unknown,
  { centerId, style }: { centerId: number | null; style: MarriageStyle },
): OpenedView | undefined {
  if (value === undefined || centerId === null) return undefined;
  const bad = () => new EditError(400, 'Неверный запрос раскладки');
  if (!value || typeof value !== 'object') throw bad();
  const { mode, depth } = value as { mode?: unknown; depth?: unknown };
  if (!MODES.includes(mode as ViewMode) || !STYLES.includes(style)) throw bad();
  const parsed = depth === null ? Infinity : depth;
  if (!RELATIVES_DEPTHS.some((d) => d.depth === parsed)) throw bad();
  return { mode: mode as ViewMode, centerId, depth: parsed as number, style };
}
