import type { TreeEvent } from './tree/model.ts';

type Sortable = { event: TreeEvent; /** Брак, к которому относится событие (свадьба, развод, рождение ребёнка). */ familyId?: number };

/**
 * Порядок ленты. Датированные события — по дате. Событию без даты место ищем по его браку:
 * свадьба без даты — перед первым известным событием этого брака, развод и прочее — после
 * последнего (иначе развод с первой женой без даты уезжал ниже свадьбы со второй).
 * Без опоры: рождение — в начало, остальное — в конец.
 */
export function sortTimeline<T extends Sortable>(items: T[]): T[] {
  const first = new Map<number, string>();
  const last = new Map<number, string>();
  for (const { event, familyId } of items) {
    const date = event.date?.value;
    if (!date || familyId === undefined) continue;
    if (!first.has(familyId) || date < first.get(familyId)!) first.set(familyId, date);
    if (!last.has(familyId) || date > last.get(familyId)!) last.set(familyId, date);
  }
  // [дата, порядок при равной дате]: свадьба без даты — перед событиями того же дня, прочее — после.
  const key = ({ event, familyId }: Sortable): [string, number] => {
    if (event.date) return [event.date.value, 1];
    const anchor = familyId !== undefined ? (event.type === 'marriage' ? first : last).get(familyId) : undefined;
    if (anchor) return [anchor, event.type === 'marriage' ? 0 : 2];
    return [event.type === 'birth' ? '0000' : '9999', 1];
  };
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => a.k[0].localeCompare(b.k[0]) || a.k[1] - b.k[1] || a.i - b.i)
    .map((x) => x.item);
}
