import { otherPartner, type Person, type TreeIndex } from './model.ts';

// Термины и правила — docs/kinship.md (с источниками). Меняя что-то здесь, обновите таблицу.

export type Kinship = {
  label: string;
  /** center — центр дерева; male/female — близкая кровная родня; far — дальняя и свойственники. */
  tone: 'center' | 'male' | 'female' | 'far';
  /** Кто именно этот человек («муж двоюродной бабушки»); для «Отец», «Сестра» и т.п. её нет. */
  hint?: string;
  /** Общее значение термина для легенды, если оно отличается от личной расшифровки. */
  termHint?: string;
  /** Термин старшей родни, перенесённый на её супруга (муж тёти — дядя). */
  viaSpouse?: boolean;
};

/**
 * Кем каждый человек приходится центру дерева. Считается от центра, а не от вошедшего
 * пользователя: при перестройке дерева от другого человека бейджи меняются, как в familio.
 */
export function computeKinship(index: TreeIndex, centerId: number): Map<number, Kinship> {
  const result = new Map<number, Kinship>();
  const center = index.persons.get(centerId);
  if (!center) return result;
  const person = (id: number) => index.persons.get(id)!;
  const setOnce = (id: number, kinship: Kinship) => {
    if (!result.has(id)) result.set(id, kinship);
  };
  const far = (label: string, hint?: string): Kinship => ({ label, tone: 'far', ...(hint ? { hint } : {}) });

  // 1. Кровная родня — через ближайшего общего предка.
  const centerAncestors = ancestorsWithDepth(index, centerId);
  const centerParents = parentsOf(index, centerId);
  const bloodPaths = new Map<number, { up: number; down: number }>();
  for (const p of index.persons.values()) {
    const path = closestCommonAncestor(centerAncestors, ancestorsWithDepth(index, p.id));
    if (!path) continue;
    bloodPaths.set(p.id, path);
    const half = path.up === 1 && path.down === 1 ? halfSiblingSide(index, centerParents, parentsOf(index, p.id)) : null;
    result.set(p.id, bloodKinship(p, path.up, path.down, half));
  }

  // 2. Супруг центра и его родня.
  const centerChildren = new Set(childrenOf(index, centerId));
  for (const spouseId of spousesOf(index, centerId)) {
    const spouse = person(spouseId);
    setOnce(spouseId, { label: pick(spouse, 'Муж', 'Жена', 'Супруг(а)'), tone: toneOf(spouse) });
    for (const parentId of parentsOf(index, spouseId)) {
      const p = person(parentId);
      const byHusband = center.sex === 'F';
      setOnce(
        parentId,
        far(
          byHusband ? pick(p, 'Свёкор', 'Свекровь', 'Родитель мужа') : pick(p, 'Тесть', 'Тёща', 'Родитель жены'),
          `${pick(p, 'отец', 'мать', 'родитель')} ${byHusband ? 'мужа' : 'жены'}`,
        ),
      );
    }
    for (const siblingId of siblingsOf(index, spouseId)) {
      const p = person(siblingId);
      const byHusband = center.sex === 'F';
      setOnce(
        siblingId,
        far(
          byHusband ? pick(p, 'Деверь', 'Золовка', 'Брат или сестра мужа') : pick(p, 'Шурин', 'Свояченица', 'Брат или сестра жены'),
          `${pick(p, 'брат', 'сестра', 'брат или сестра')} ${byHusband ? 'мужа' : 'жены'}`,
        ),
      );
      // Свояк — муж сестры жены.
      if (center.sex === 'M' && p.sex === 'F') {
        for (const husband of spousesOf(index, siblingId)) {
          if (person(husband).sex === 'M') setOnce(husband, far('Свояк', 'муж сестры жены'));
        }
      }
    }
    for (const childId of childrenOf(index, spouseId)) {
      if (centerChildren.has(childId)) continue;
      const child = person(childId);
      setOnce(
        childId,
        far(
          pick(child, 'Пасынок', 'Падчерица', 'Пасынок или падчерица'),
          `${pick(child, 'сын', 'дочь', 'ребёнок')} ${center.sex === 'F' ? 'мужа' : 'жены'} от другого брака`,
        ),
      );
    }
  }

  // 3. Супруги кровной родни.
  for (const [id, path] of bloodPaths) {
    if (id === centerId) continue;
    const relativeLabel = result.get(id)!.label;
    for (const spouseId of spousesOf(index, id)) {
      if (result.has(spouseId)) continue;
      setOnce(spouseId, { tone: 'far', ...spouseOfRelative(center, person(id), relativeLabel, person(spouseId), path) });
    }
  }

  // 4. Сводные братья и сёстры — дети отчима или мачехи от других браков.
  for (const parentId of centerParents) {
    for (const stepParentId of spousesOf(index, parentId)) {
      if (centerParents.includes(stepParentId)) continue;
      for (const childId of childrenOf(index, stepParentId)) {
        if (childId === centerId) continue;
        setOnce(
          childId,
          far(
            pick(person(childId), 'Сводный брат', 'Сводная сестра', 'Сводный брат или сестра'),
            'ребёнок отчима или мачехи от другого брака, общих родителей нет',
          ),
        );
      }
    }
  }

  // 5. Сваты — родители супругов детей центра.
  for (const childId of centerChildren) {
    for (const childSpouse of spousesOf(index, childId)) {
      for (const parentId of parentsOf(index, childSpouse)) {
        const p = person(parentId);
        setOnce(parentId, far(pick(p, 'Сват', 'Сватья', 'Сват или сватья'), `${pick(p, 'отец', 'мать', 'родитель')} супруга ребёнка`));
      }
    }
  }

  return result;
}

function spouseOfRelative(
  center: Person,
  relative: Person,
  relativeLabel: string,
  spouse: Person,
  path: { up: number; down: number },
): Omit<Kinship, 'tone'> {
  const role = pick(spouse, 'Муж', 'Жена', 'Супруг(а)');
  const ofRelative = `${lower(role)} ${genitive(relativeLabel)}`;
  if (path.up === 1 && path.down === 0) {
    return { label: pick(spouse, 'Отчим', 'Мачеха', 'Отчим или мачеха'), hint: `${ofRelative}, не родной родитель` };
  }
  // Второй супруг деда — «жена дедушки».
  if (path.down === 0) return { label: `${role} ${genitive(relativeLabel)}` };
  // Супруг родни старшего поколения зовётся так же, только своего пола: муж тёти — дядя.
  if (path.up > path.down) {
    const term = bloodKinship(spouse, path.up, path.down);
    return { label: term.label, hint: ofRelative, termHint: term.hint, viaSpouse: true };
  }
  // Зять — муж дочери или сестры; невестка — жена брата; жена сына — сноха для отца.
  const isChild = path.up === 0 && path.down === 1;
  const isSibling = path.up === 1 && path.down === 1;
  if ((isChild || isSibling) && relative.sex === 'F' && spouse.sex !== 'F') return { label: 'Зять', hint: ofRelative };
  if (isSibling && relative.sex === 'M' && spouse.sex !== 'M') return { label: 'Невестка', hint: ofRelative };
  if (isChild && relative.sex === 'M' && spouse.sex !== 'M') {
    return { label: center.sex === 'M' ? 'Сноха' : 'Невестка', hint: ofRelative };
  }
  // Остальные — описательно: «Жена двоюродного брата», «Муж внучки».
  return { label: `${role} ${genitive(relativeLabel)}` };
}

/** Ближайший общий предок: up — поколений вверх от центра, down — вниз к человеку. */
function closestCommonAncestor(centerAncestors: Map<number, number>, personAncestors: Map<number, number>) {
  let best: { up: number; down: number } | undefined;
  for (const [ancestor, up] of centerAncestors) {
    const down = personAncestors.get(ancestor);
    if (down !== undefined && (!best || up + down < best.up + best.down)) best = { up, down };
  }
  return best;
}

/** Неполнородные: общий только отец — единокровные, только мать — единоутробные. */
function halfSiblingSide(index: TreeIndex, centerParents: number[], otherParents: number[]): 'father' | 'mother' | null {
  const shared = centerParents.filter((id) => otherParents.includes(id));
  if (shared.length !== 1 || centerParents.length < 2 || otherParents.length < 2) return null;
  const sex = index.persons.get(shared[0])!.sex;
  return sex === 'M' ? 'father' : sex === 'F' ? 'mother' : null;
}

export function bloodKinship(p: Person, up: number, down: number, half: 'father' | 'mother' | null = null): Kinship {
  if (up === 0 && down === 0) return { label: 'Центр', tone: 'center' };
  const label = bloodLabel(p, up, down, half);
  const close = label !== undefined && up <= 4 && down <= 4;
  const hint = bloodHint(up, down, half);
  return {
    label: label ?? pick(p, 'Родственник', 'Родственница', 'Родственник'),
    tone: close ? toneOf(p) : 'far',
    ...(hint ? { hint } : {}),
  };
}

// --- Расшифровки: считаются из того же пути родства, что и сам термин ---

const NEUTRAL_SIBLING = (degree: number) => (degree === 0 ? 'брат или сестра' : `${COUSIN_NEUTRAL[degree - 1]} брат или сестра`);
const NEUTRAL_SIBLING_GENITIVE = (degree: number) =>
  degree === 0 ? 'брата или сестры' : `${genitive(`${COUSIN_NEUTRAL[degree - 1]} брат`)} или сестры`;
const COUSIN_NEUTRAL = ['двоюродный', 'троюродный', 'четвероюродный', 'пятиюродный'];
const ancestorGenitive = (n: number) =>
  n === 1 ? 'родителя' : n <= 4 ? `${lower(praPrefix(n - 2))}дедушки или ${lower(praPrefix(n - 2))}бабушки` : `предка в ${n}-м поколении`;
const descendantNeutral = (n: number) =>
  n === 1 ? 'ребёнок' : n <= 4 ? `${lower(praPrefix(n - 2))}внук или ${lower(praPrefix(n - 2))}внучка` : `потомок в ${n}-м поколении`;
const ancestorsPair = (n: number) =>
  n <= 4 ? `${lower(praPrefix(n - 2))}дедушка и ${lower(praPrefix(n - 2))}бабушка` : `предки в ${n}-м поколении`;

/** Для очевидных терминов (отец, внук, брат, дядя, племянник) расшифровки нет. */
function bloodHint(up: number, down: number, half: 'father' | 'mother' | null): string | undefined {
  if (down === 0) return up >= 5 ? `предок в ${up}-м поколении` : undefined;
  if (up === 0) return down >= 5 ? `потомок в ${down}-м поколении` : undefined;
  if (up === 1 && down === 1) return half === 'father' ? 'общий только отец' : half === 'mother' ? 'общая только мать' : undefined;
  if ((up === 2 && down === 1) || (up === 1 && down === 2)) return undefined;
  if (up === down) return `общие ${ancestorsPair(up)}`;
  if (up > down) return `${NEUTRAL_SIBLING(down - 1)} ${ancestorGenitive(up - down)}`;
  return `${descendantNeutral(down - up)} ${NEUTRAL_SIBLING_GENITIVE(up - 1)}`;
}

function bloodLabel(p: Person, up: number, down: number, half: 'father' | 'mother' | null): string | undefined {
  if (down === 0) return ancestorName(p, up);
  if (up === 0) return descendantName(p, down);

  if (up === down) {
    const sibling = pick(p, 'Брат', 'Сестра', 'Брат или сестра');
    if (up === 1) {
      if (half === 'father') return `${pick(p, 'Единокровный', 'Единокровная', 'Единокровный')} ${lower(sibling)}`;
      if (half === 'mother') return `${pick(p, 'Единоутробный', 'Единоутробная', 'Единоутробный')} ${lower(sibling)}`;
      return sibling;
    }
    return withCousin(p, up - 1, sibling);
  }

  if (up > down) {
    // Старшее поколение: дядя (на одно выше), дедушка с «пра» (на два и больше).
    if (up - down === 1) return withCousin(p, down - 1, pick(p, 'Дядя', 'Тётя', 'Дядя или тётя'));
    return withCousin(p, down, ancestorName(p, up - down));
  }

  // Младшее поколение: племянник (на одно ниже), внучатый/правнучатый племянник (на два и больше).
  const nephew = withCousin(p, up - 1, pick(p, 'Племянник', 'Племянница', 'Племянник'));
  if (!nephew || down - up === 1) return nephew;
  const grand = withPra(down - up - 2, pick(p, 'Внучатый', 'Внучатая', 'Внучатый'));
  return `${grand} ${lower(nephew)}`;
}

// Пра(3)дедушка — как у familio: дальше «прапра» считаем числом.
const praPrefix = (n: number) => (n === 0 ? '' : n === 1 ? 'Пра' : n === 2 ? 'Прапра' : `Пра(${n})`);
const withPra = (n: number, word: string) => (n === 0 ? word : praPrefix(n) + lower(word));

function ancestorName(p: Person, up: number): string {
  if (up === 1) return pick(p, 'Отец', 'Мать', 'Родитель');
  return withPra(up - 2, pick(p, 'Дедушка', 'Бабушка', 'Дедушка или бабушка'));
}

function descendantName(p: Person, down: number): string {
  if (down === 1) return pick(p, 'Сын', 'Дочь', 'Ребёнок');
  return withPra(down - 2, pick(p, 'Внук', 'Внучка', 'Внук'));
}

const COUSIN_ROOTS = ['Двоюродн', 'Троюродн', 'Четвероюродн', 'Пятиюродн'];

/** «Двоюродный дядя», «Троюродная бабушка»; колено 0 — без прилагательного. */
function withCousin(p: Person, degree: number, word: string): string | undefined {
  if (degree === 0) return word;
  const root = COUSIN_ROOTS[degree - 1];
  if (!root) return undefined;
  return `${root}${p.sex === 'F' ? 'ая' : 'ый'} ${lower(word)}`;
}

const GENITIVE_EXCEPTIONS: Record<string, string> = { дочь: 'дочери', мать: 'матери', отец: 'отца' };
const VELAR_OR_HUSHING = /[гкхжшчщ]$/;

/** Родительный падеж термина: «Двоюродный брат» → «двоюродного брата», «Внучка» → «внучки». */
export function genitive(label: string): string {
  return lower(label)
    .split(' ')
    .map((word) => {
      if (GENITIVE_EXCEPTIONS[word]) return GENITIVE_EXCEPTIONS[word];
      if (word.endsWith('ый') || word.endsWith('ой')) return `${word.slice(0, -2)}ого`;
      if (word.endsWith('ий')) return `${word.slice(0, -2)}его`;
      if (word.endsWith('ая')) return `${word.slice(0, -2)}ой`;
      if (word.endsWith('я')) return `${word.slice(0, -1)}и`;
      if (word.endsWith('а')) return `${word.slice(0, -1)}${VELAR_OR_HUSHING.test(word.slice(0, -1)) ? 'и' : 'ы'}`;
      if (/[бвгджзклмнпрстфхцчшщ]$/.test(word)) return `${word}а`;
      return word;
    })
    .join(' ');
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const pick = (p: Person, male: string, female: string, unknown: string) =>
  p.sex === 'M' ? male : p.sex === 'F' ? female : unknown;
const toneOf = (p: Person): Kinship['tone'] => (p.sex === 'F' ? 'female' : 'male');

/** Все предки с расстоянием в поколениях (сам человек — 0). */
export function ancestorsWithDepth(index: TreeIndex, personId: number): Map<number, number> {
  const depth = new Map([[personId, 0]]);
  const queue = [personId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const parent of parentsOf(index, id)) {
      if (depth.has(parent)) continue;
      depth.set(parent, depth.get(id)! + 1);
      queue.push(parent);
    }
  }
  return depth;
}

export function parentsOf(index: TreeIndex, personId: number): number[] {
  return (index.familyAsChild.get(personId) ?? []).flatMap((f) => f.partners.filter((p): p is number => p !== null));
}

export function childrenOf(index: TreeIndex, personId: number): number[] {
  return (index.familiesAsPartner.get(personId) ?? []).flatMap((f) => f.children.map((c) => c.id));
}

export function spousesOf(index: TreeIndex, personId: number): Set<number> {
  const result = new Set<number>();
  for (const family of index.familiesAsPartner.get(personId) ?? []) {
    const other = otherPartner(family, personId);
    if (other !== null) result.add(other);
  }
  return result;
}

export function siblingsOf(index: TreeIndex, personId: number): Set<number> {
  const result = new Set<number>();
  for (const family of index.familyAsChild.get(personId) ?? []) {
    for (const child of family.children) if (child.id !== personId) result.add(child.id);
  }
  return result;
}
