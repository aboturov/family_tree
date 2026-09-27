import { ApiError } from '../api.ts';
import type { Layout, LayoutAlgorithm, MarriageStyle, RowSpacing } from './geometry.ts';
import type { Tree } from './model.ts';
import { layoutSignature } from './signature.ts';
import type { ViewMode } from './views.ts';

/**
 * Раскладки считает сервер (server/src/layouts.ts): дерево у семьи одно, и готовая раскладка вида
 * достаётся всем сразу, на любом устройстве. Здесь — запрос и память вкладки: в уже открытый вид
 * возвращаемся без запроса. Раскладки из памяти не меняем — их читают все, кто их получил.
 */
const known = new Map<string, Layout>();
const KNOWN_KEPT = 16;

function remember(key: string, layout: Layout) {
  known.delete(key);
  known.set(key, layout);
  if (known.size > KNOWN_KEPT) known.delete(known.keys().next().value!);
}

export type LayoutQuery = {
  /** Вид дерева (views.ts) — его и раскладываем. */
  tree: Tree;
  algorithm: LayoutAlgorithm;
  spacing: RowSpacing;
  /** «Всё дерево»: распутывать пары крест-накрест, линии рода центра — прямее. */
  untangle: boolean;
  style: MarriageStyle;
  centerId: number | null;
  /** Прошлые позиции людей [id, x]: после правки дерево не перетасовывается. */
  previous?: [number, number][];
  /** Какой вид открыт: сервер ведёт счёт открытий и популярные считает заранее (precompute.ts). */
  view?: { mode: ViewMode; depth: number };
};

/** Раскладка вида дерева. signal — раскладка больше не нужна (перешли к другому виду или человеку). */
export async function layoutInBackground(query: LayoutQuery, signal?: AbortSignal): Promise<Layout> {
  const { tree, algorithm, spacing, untangle, style, centerId, view } = query;
  const key = JSON.stringify([algorithm, spacing, untangle, style, centerId]) + layoutSignature(tree);
  const ready = known.get(key);
  if (ready) {
    remember(key, ready);
    return ready;
  }
  const res = await fetch('/api/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // «Родня от всех предков» — глубина Infinity; в JSON её нет, передаём null.
    body: JSON.stringify({ ...query, view: view && { ...view, depth: Number.isFinite(view.depth) ? view.depth : null } }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`);
  remember(key, data.layout);
  return data.layout as Layout;
}
