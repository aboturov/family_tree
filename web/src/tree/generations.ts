import { CARD, type Layout } from './geometry.ts';

/**
 * Полосы поколений на схеме — «зебра» на фоне: ряд карточек и половина промежутков до соседних
 * рядов. Во всех режимах ряд схемы — поколение: ребёнок всегда на ряд ниже родителей.
 */
export type GenerationBand = { y: number; top: number; bottom: number };

/** Поля над первым и под последним рядом. */
const MARGIN = 40;

export function generationBands(layout: Layout): GenerationBand[] {
  const rows = [
    ...new Set([...layout.persons, ...layout.unknowns, ...layout.refs].map((node) => Math.round(node.y))),
  ].sort((a, b) => a - b);
  return rows.map((y, i) => ({
    y,
    top: i === 0 ? y - MARGIN : (rows[i - 1] + CARD.height + y) / 2,
    bottom: i === rows.length - 1 ? y + CARD.height + MARGIN : (y + CARD.height + rows[i + 1]) / 2,
  }));
}

const ANCESTORS = ['Родители', 'Бабушки и дедушки', 'Прабабушки и прадедушки', 'Прапрабабушки и прапрадедушки'];
const DESCENDANTS = ['Дети', 'Внуки', 'Правнуки', 'Праправнуки'];

/** Название поколения относительно центра дерева: −1 — родители, +2 — внуки; 0 — own. */
export function generationLabel(delta: number, own: string): string {
  if (delta === 0) return own;
  const n = Math.abs(delta);
  if (delta < 0) return ANCESTORS[n - 1] ?? `Предки, ${n}-е поколение`;
  return DESCENDANTS[n - 1] ?? `Потомки, ${n}-е поколение`;
}
