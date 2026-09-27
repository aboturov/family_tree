import { ancestorsWithDepth, childrenOf, parentsOf, spousesOf } from './kinship.ts';
import type { Family, Tree, TreeIndex } from './model.ts';

/**
 * family — как в familio: прямые предки, братья и сёстры (и единокровные, единоутробные),
 *   супруги, дети и потомки;
 * relatives — то же плюс боковые ветки: все потомки предков до выбранного колена
 *   с супругами (дяди, тёти, двоюродные…);
 * clans — всё дерево по родам: каждый род отдельным деревом потомков, связи между родами —
 *   ссылками (см. clans.ts);
 * all — всё дерево одной схемой.
 */
export type ViewMode = 'family' | 'relatives' | 'clans' | 'all';

/**
 * Колено — сколько поколений вверх от центра до общего предка. Степень родства в подсказке —
 * для поколения центра (братья); дядя на поколение старше и на степень ближе: двоюродный дядя
 * и троюродный брат — от одного прадеда. Колена «от родителей» нет: оно почти не отличалось
 * от «семьи» — добавляло только племянников и отчимов с мачехами.
 */
export const RELATIVES_DEPTHS = [
  {
    depth: 2,
    label: 'от дедушек',
    hint: 'двоюродные братья',
    detail: 'Дяди и тёти, двоюродные братья и сёстры. Двоюродные дяди — от прадедушек.',
  },
  {
    depth: 3,
    label: 'от прадедушек',
    hint: 'троюродные братья',
    detail: 'Двоюродные дедушки и дяди, троюродные братья и сёстры. Троюродные дяди — от прапрадедушек.',
  },
  {
    depth: 4,
    label: 'от прапрадедушек',
    hint: 'четвероюродные братья',
    detail:
      'Троюродные дедушки и дяди, четвероюродные братья и сёстры. Четвероюродные дяди — от прапрапрадедушек.',
  },
  {
    depth: 5,
    label: 'от прапрапрадедушек',
    hint: 'пятиюродные братья',
    detail: 'Четвероюродные дедушки и дяди, пятиюродные братья и сёстры.',
  },
  {
    depth: Infinity,
    label: 'от всех предков',
    hint: 'вся кровная родня',
    detail: 'Потомки всех предков, до которых известна родословная.',
  },
] as const;

export function selectView(tree: Tree, index: TreeIndex, mode: ViewMode, centerId: number, depth: number): Tree {
  if (mode === 'all' || mode === 'clans' || !index.persons.has(centerId)) return tree;

  const include = new Set<number>();
  const ancestors = ancestorsWithDepth(index, centerId);

  for (const id of ancestors.keys()) include.add(id);
  // Братья и сёстры — и от другого брака отца или матери; их второго родителя добавит restrict.
  for (const parent of parentsOf(index, centerId)) for (const id of childrenOf(index, parent)) include.add(id);
  for (const id of descendants(index, centerId)) include.add(id);
  if (mode === 'relatives') {
    for (const [id, d] of ancestors) {
      if (d > depth) continue;
      for (const descendant of descendants(index, id)) include.add(descendant);
    }
  }

  // Супруги тех, кто показан ниже центра или рядом с ним: жёны сыновей, мужья кузин.
  for (const id of [...include]) {
    if (mode === 'family' && ancestors.has(id) && id !== centerId) continue;
    for (const spouse of spousesOf(index, id)) include.add(spouse);
  }

  return restrict(tree, include);
}

function descendants(index: TreeIndex, personId: number): Set<number> {
  const result = new Set([personId]);
  const queue = [personId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const family of index.familiesAsPartner.get(id) ?? []) {
      for (const child of family.children) {
        if (result.has(child.id)) continue;
        result.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return result;
}

/**
 * Оставляет в дереве только выбранных людей. Семья попадает в вид, если в нём оба партнёра
 * или партнёр и хотя бы один ребёнок; второй партнёр такой семьи добавляется, чтобы у ребёнка
 * не появлялся ложный «неизвестный» родитель.
 */
function restrict(tree: Tree, include: Set<number>): Tree {
  const families: Family[] = [];
  for (const family of tree.families) {
    const partnersIn = family.partners.filter((p) => p !== null && include.has(p));
    const children = family.children.filter((c) => include.has(c.id));
    const known = family.partners.filter((p) => p !== null).length;
    if (partnersIn.length === 0) continue;
    if (partnersIn.length < known && children.length === 0) continue;
    for (const p of family.partners) if (p !== null) include.add(p);
    families.push({ ...family, children });
  }
  return { persons: tree.persons.filter((p) => include.has(p.id)), families };
}
