import type { Layout } from './geometry.ts';
import type { TreeIndex } from './model.ts';

/** Сколько оттенков у линий к детям — --family-1…6 в styles.css. */
export const FAMILY_HUES = 6;

/**
 * Оттенок линий к детям каждой семьи. В ряду браки слева направо берут оттенки по кругу:
 * линии соседних браков идут в одном промежутке между рядами, и цвета у них всегда разные.
 * Порядок оттенков подобран так, что различимы и соседние, и последний с первым.
 */
export function familyHues(layout: Layout): Map<number, number> {
  const rows = new Map<number, { familyId: number; x: number }[]>();
  for (const union of layout.unions) {
    if (!union.stem) continue;
    const row = Math.round(union.stem.to);
    rows.set(row, [...(rows.get(row) ?? []), { familyId: union.familyId, x: union.stem.x }]);
  }
  const hues = new Map<number, number>();
  for (const unions of rows.values())
    unions.sort((a, b) => a.x - b.x).forEach((u, i) => hues.set(u.familyId, i % FAMILY_HUES));
  return hues;
}

/**
 * Род выбранного человека — что подсвечивать во «Всём дереве» и «По родам»: все предки вверх
 * по обеим линиям и все потомки вниз (blood), без боковых ветвей — братьев, дядь, двоюродных.
 * families — браки на этом пути: родителей каждого из рода (вверх) и его собственные (вниз);
 * people — кого не приглушать: род и супруги в этих браках (линия брака ведёт к ним).
 */
export type Lineage = { personId: number; blood: Set<number>; families: Set<number>; people: Set<number> };

export function lineage(index: TreeIndex, personId: number): Lineage {
  const blood = new Set([personId]);
  const families = new Set<number>();
  const walk = (next: (id: number) => number[]) => {
    const queue = [personId];
    for (let i = 0; i < queue.length; i++)
      for (const id of next(queue[i]))
        if (!blood.has(id)) {
          blood.add(id);
          queue.push(id);
        }
  };
  // Вверх: родители, их родители… Другие дети этих браков (братья, дяди) в род не входят.
  walk((id) =>
    (index.familyAsChild.get(id) ?? []).flatMap((f) => {
      families.add(f.id);
      return f.partners.filter((p): p is number => p !== null);
    }),
  );
  // Вниз: дети, внуки… — через каждый брак, включая браки потомков с их супругами.
  walk((id) =>
    (index.familiesAsPartner.get(id) ?? []).flatMap((f) => {
      families.add(f.id);
      return f.children.map((c) => c.id);
    }),
  );
  const people = new Set(blood);
  for (const id of families)
    for (const p of index.families.get(id)?.partners ?? []) if (p !== null) people.add(p);
  return { personId, blood, families, people };
}

/** Линия к ребёнку на пути рода: от брака на пути к кому-то из рода (не к брату или дяде). */
export const isLineageEdge = (l: Lineage, edge: { familyId: number; childId: number }) =>
  l.families.has(edge.familyId) && l.blood.has(edge.childId);
