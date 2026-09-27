import ElkBundled from 'elkjs/lib/elk.bundled.js';
import type { ELK as ElkApi, ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api.js';
import {
  AVATAR,
  CARD,
  UNKNOWN_CARD,
  type Layout,
  type MarriageStyle,
  type PlacedEdge,
  type PlacedPerson,
  type PlacedUnion,
  type PlacedUnknown,
  type RowSpacing,
} from './geometry.ts';
import { isLineageEdge, lineage, type Lineage } from './lines.ts';
import { findEvent, indexTree, type Family, type Tree } from './model.ts';
import { pickLayout, SEEDS, seedCount, type Scored, type SeedResult } from './seeds.ts';
import { layoutSignature } from './signature.ts';

// elk.bundled.js — модуль CommonJS, а типы у него написаны под сборщик: на сервере (nodenext)
// импорт по умолчанию типизирован как весь модуль, хотя и там, и в браузере приходит сам класс.
const ELK = ElkBundled as unknown as new () => ElkApi;

export { AVATAR, CARD, UNKNOWN_CARD };
export type { Layout, MarriageStyle, PlacedEdge, PlacedPerson, PlacedUnion, PlacedUnknown };

export type LayeredOptions = {
  spacing?: RowSpacing;
  /**
   * «Всё дерево»: распутывать пары, к которым линии от родителей идут крест-накрест, и тянуть
   * линии рода центра прямее остальных.
   */
  untangle?: boolean;
};

const SPOUSE_GAP = 40;
const SIBLING_GAP = 20;
/** Насколько выше соседней линии брака идёт линия к дальнему супругу (и следующая — ещё выше). */
const LINE_STEP = 8;
// Спуск к детям несоседнего брака идёт в промежуток рядом со вторым супругом — промежуток шире.
const LANDING_GAP = 56;
const LANDING_MARGIN = 36;

export type Slot = { kind: 'person'; personId: number } | { kind: 'unknown'; familyId: number };
export const slotKey = (s: Slot) => (s.kind === 'person' ? `p${s.personId}` : `u${s.familyId}`);
const slotWidth = (s: Slot) => (s.kind === 'person' ? CARD.width : UNKNOWN_CARD.width);

type Marriage = { family: Family; a: string; b: string; order: string };

export type BlockUnion = {
  family: Family;
  kind: 'adjacent' | 'bridge';
  /** Точки линии брака в координатах блока. */
  path: { x: number; y: number }[];
  stemX: number;
  /** Откуда начинается линия к детям: высота линии брака. */
  stemFrom: number;
};

export type Block = {
  id: string;
  slots: Slot[];
  offsets: Map<string, number>;
  width: number;
  unions: BlockUnion[];
};

/**
 * Семейное дерево как граф «блоков»: блок — это люди, связанные браками (муж, жена,
 * второй супруг…), выстроенные в одну строку. ELK раскладывает уже блоки по уровням
 * и ведёт линии от конкретного брака к конкретному ребёнку. Зёрна ELK перебираются (см. SEEDS
 * в seeds.ts): каждое доводится до конца, выбирается лучший итог.
 */
// Во «Всём дереве» линии рода центра (к предкам и потомкам) ELK тянет прямее остальных: блоки
// сдвигаются так, чтобы родители стояли над детьми на этом пути, а длиннее становятся линии к
// боковой родне. На реальном дереве при 4 линии рода вдвое короче, пересечений столько же, все
// линии вместе — на 2% длиннее; при 10 на отдельных центрах остальные длиннее на 40%.
const LINEAGE_STRAIGHTNESS = '4';

/** Раскладка по всем зёрнам по очереди — то же, что сервер считает в потоках параллельно (layouts.ts). */
export async function layoutTree(
  tree: Tree,
  style: MarriageStyle = 'compact',
  centerId: number | null = null,
  /** Сколько зёрен готово из скольких — для индикатора: на большом дереве это секунды. */
  onProgress?: (done: number, total: number) => void,
  /** Позиции людей в прошлой раскладке: кто уже был, сохраняет порядок в своём ряду. */
  previous?: Map<number, number>,
  options: LayeredOptions = {},
): Promise<Layout> {
  const withSides = centerId !== null && tree.persons.some((p) => p.id === centerId);
  const count = seedCount(tree, centerId, (previous?.size ?? 0) > 0);
  const results: SeedResult[] = [];
  for (let seed = 0; seed < count; seed++) {
    const result = await layoutSeed(tree, style, centerId, seed, previous, options);
    results.push(result);
    onProgress?.(seed + 1, count);
    // Без центра лучше схемы без пересечений не будет, а при равной оценке выбирается первое зерно.
    if (!withSides && result.free === 0) break;
  }
  return pickLayout(results);
}

/**
 * Раскладка по одному зерну (номер в SEEDS): прогон ELK, стороны родни от центра, доводка
 * порядка, распутывание пар, после правки — ещё и вариант с прежним порядком. Лучший итог из
 * всех зёрен выбирает pickLayout.
 */
export async function layoutSeed(
  tree: Tree,
  style: MarriageStyle,
  centerId: number | null,
  seed: number,
  previous?: Map<number, number>,
  options: LayeredOptions = {},
): Promise<SeedResult> {
  const { spacing = 'compact', untangle = false } = options;
  const withSides = centerId !== null && tree.persons.some((p) => p.id === centerId);
  const stable = withSides && previous !== undefined && previous.size > 0;
  const seedRun = await freeRun(tree, style, spacing, seed);
  const free = score(seedRun);
  // Прогон из памяти общий для всех, кто строит это дерево, — наружу отдаём копию.
  if (!withSides) {
    const layout = structuredClone(seedRun.layout);
    return { seed, free, fresh: { layout, score: free, crossings: countCrossings(layout) } };
  }

  // Понятнее, кто с чьей стороны, чем пара лишних пересечений: в каждом поколении родня
  // отца — с его края, родня матери — с её, родня супруга — с края супруга. Порядок внутри
  // стороны берём из прогона ELK и фиксируем.
  const x = new Map(seedRun.layout.persons.map((p) => [p.id, p.x]));
  const sides = familySides(tree, centerId, x);
  const blockSide = (block: Block) => {
    const values = block.slots.flatMap((s) =>
      s.kind === 'person' && sides.has(s.personId) ? [sides.get(s.personId)!] : [],
    );
    if (values.includes(-1) && values.includes(1)) return 0;
    return values.length ? values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : 0;
  };
  const blockX = (block: Block) => {
    const first = block.slots.find((s) => s.kind === 'person') as { personId: number } | undefined;
    return first ? x.get(first.personId)! : 0;
  };
  const sorted = new Map(
    [...seedRun.blocks]
      .sort((a, b) => blockSide(a) - blockSide(b) || blockX(a) - blockX(b))
      .map((block, i) => [block.id, i]),
  );
  const order = refineOrder(tree, seedRun, sorted, blockSide);
  const kin = untangle ? lineage(indexTree(tree), centerId) : undefined;
  let freshRun = await layoutOnce(tree, style, SEEDS[0], order, spacing, kin);
  if (untangle) freshRun = await untangleCouples(tree, style, spacing, order, freshRun, kin);
  const fresh = scored(freshRun);
  if (!stable) return { seed, free, fresh };

  // Раскладка «с памятью»: после правки (новый человек, новая связь) лучший прогон ELK может
  // оказаться совсем другим, и дерево перетасовывается целиком. Прежний порядок оставляем,
  // если он почти не хуже (см. pickLayout) — новые люди встают туда, куда их поставил ELK.
  // Прежний порядок доводим той же процедурой: лишнее пересечение, которое мог принести новый
  // человек, убирается местной перестановкой, а не перестройкой всего дерева.
  const keptOrder = refineOrder(tree, seedRun, keepPrevious(seedRun, order, previous!, blockSide), blockSide, true);
  let keptRun = await layoutOnce(tree, style, SEEDS[0], keptOrder, spacing, kin);
  if (untangle) keptRun = await untangleCouples(tree, style, spacing, keptOrder, keptRun, kin);
  return { seed, free, fresh, kept: scored(keptRun) };
}

// Пара, к которой линии от родителей идут крест-накрест, бросается в глаза сильнее
// обычного пересечения — штрафуем её вдвое.
const score = (run: LayoutRun) => countCrossings(run.layout) + 2 * crossedCouples(run).length;
const scored = (run: LayoutRun): Scored => ({
  layout: run.layout,
  score: score(run),
  crossings: countCrossings(run.layout),
});

/**
 * Прогон ELK по зерну без центра. Он зависит только от дерева, стиля браков и промежутков,
 * но не от центра: центр вступает позже — стороны, доводка, итоговые прогоны. Во «Всём дереве»
 * дерево одно для любого центра, и «Построить от него» не повторяет эти прогоны. Помним
 * несколько последних деревьев — после правки подпись другая, и старые записи вытесняются.
 * Прогон из памяти не меняем: его читают следующие построения.
 */
const freeRuns = new Map<string, Map<number, LayoutRun>>();
const FREE_RUNS_TREES = 4;

async function freeRun(tree: Tree, style: MarriageStyle, spacing: RowSpacing, seed: number): Promise<LayoutRun> {
  const key = `${style}|${spacing}|${layoutSignature(tree)}`;
  const runs = freeRuns.get(key) ?? new Map<number, LayoutRun>();
  freeRuns.delete(key);
  freeRuns.set(key, runs);
  if (freeRuns.size > FREE_RUNS_TREES) freeRuns.delete(freeRuns.keys().next().value!);
  const known = runs.get(seed);
  if (known) return known;
  const run = await layoutOnce(tree, style, SEEDS[seed], undefined, spacing);
  runs.set(seed, run);
  return run;
}

/** Внутри каждого ряда и стороны блоки, которые были и раньше, встают в прежнем порядке. */
function keepPrevious(
  run: LayoutRun,
  order: Map<string, number>,
  previous: Map<number, number>,
  sideOf: (block: Block) => number,
): Map<string, number> {
  const y = new Map(run.layout.persons.map((p) => [p.id, p.y]));
  const personIds = (b: Block) => b.slots.flatMap((s) => (s.kind === 'person' ? [s.personId] : []));
  const groups = new Map<string, Block[]>();
  for (const b of run.blocks) {
    const ids = personIds(b);
    const key = `${ids.length ? y.get(ids[0]) : 'u'}|${sideOf(b)}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const result = new Map(order);
  for (const blocks of groups.values()) {
    const known = blocks.filter((b) => personIds(b).some((id) => previous.has(id)));
    const oldX = (b: Block) => {
      const xs = personIds(b).flatMap((id) => (previous.has(id) ? [previous.get(id)!] : []));
      return xs.reduce((a, c) => a + c, 0) / xs.length;
    };
    // Места, которые ELK отвёл знакомым блокам, заполняем ими же, но в прежнем порядке.
    const slots = known.map((b) => order.get(b.id)!).sort((a, b) => a - b);
    [...known].sort((a, b) => oldX(a) - oldX(b)).forEach((b, i) => result.set(b.id, slots[i]));
  }
  return result;
}

type BlockEnd = { block: string; dx: number };
type BlockLine = { from: BlockEnd; to: BlockEnd; childId: number };

/** Ряд каждого блока и линии «брак → ребёнок» между блоками (блок + смещение внутри него). */
function blockLines(tree: Tree, run: LayoutRun) {
  const y = new Map<string, number>();
  for (const p of run.layout.persons) y.set(`p${p.id}`, p.y);
  for (const u of run.layout.unknowns) y.set(`u${u.familyId}`, u.y);
  const layerOf = new Map(run.blocks.map((b) => [b.id, y.get(slotKey(b.slots[0])) ?? 0]));
  const byId = new Map(run.blocks.map((b) => [b.id, b]));
  const unionAt = new Map<number, BlockEnd>();
  const personAt = new Map<number, BlockEnd>();
  for (const b of run.blocks) {
    for (const u of b.unions) unionAt.set(u.family.id, { block: b.id, dx: u.stemX });
    for (const slot of b.slots) {
      if (slot.kind === 'person') personAt.set(slot.personId, { block: b.id, dx: b.offsets.get(slotKey(slot))! + CARD.width / 2 });
    }
  }
  const edges: BlockLine[] = tree.families.flatMap((f) => {
    const from = unionAt.get(f.id);
    if (!from) return [];
    return f.children.flatMap((c) => {
      const to = personAt.get(c.id);
      return to ? [{ from, to, childId: c.id }] : [];
    });
  });
  return { layerOf, byId, edges };
}

/**
 * «Всё дерево»: пары, к которым линии от родителей мужа и жены идут крест-накрест. Муж всегда
 * слева, поэтому распутываем не пару, а родителей: ветки родителей мужа и жены (родители со всей
 * их роднёй, кроме самой пары) меняются местами в каждом ряду, остальные блоки стоят где стояли.
 * Перестановку оставляем, если схема стала лучше; крест у пары — как два обычных пересечения.
 * Попытки сначала прикидываем по прямым и в ELK считаем только удачные, начиная с лучшей.
 */
async function untangleCouples(
  tree: Tree,
  style: MarriageStyle,
  spacing: RowSpacing,
  order: Map<string, number>,
  run: LayoutRun,
  kin?: Lineage,
): Promise<LayoutRun> {
  let current = { order, run };
  // Каждая принятая перестановка убирает хотя бы один крест — пар в дереве конечно.
  for (let round = 0; round < 20; round++) {
    const lines = blockLines(tree, current.run);
    const estimate = estimateOrder(lines, current.order);
    let next: typeof current | undefined;
    // У каждой пары два варианта (см. swapParents) — какой лучше, зависит от того, где стоят её
    // братья и сёстры.
    const tries = crossedCouples(current.run)
      .flatMap((couple) => [false, true].map((between) => swapParents(lines, current.order, couple, current.run, between)))
      .flatMap((swapped) => (swapped ? [{ swapped, estimate: estimateOrder(lines, swapped) }] : []))
      .filter((t) => t.estimate < estimate)
      .sort((a, b) => a.estimate - b.estimate);
    for (const { swapped } of tries) {
      const candidate = await layoutOnce(tree, style, SEEDS[0], swapped, spacing, kin);
      if (score(candidate) < score(current.run)) {
        next = { order: swapped, run: candidate };
        break;
      }
    }
    if (!next) break;
    current = next;
  }
  return current.run;
}

/**
 * Ветки родителей двух соседей-супругов меняются местами: в каждом ряду — на места друг друга.
 * between — в ряду самой пары она тоже участвует и встаёт между ветками: братья и сёстры мужа
 * слева от неё, жены — справа. Без этого братья, стоявшие по одну сторону от пары, после
 * перестановки могут разъехаться по обе, и их линии пересекут линию к самой паре.
 */
function swapParents(
  { layerOf, byId, edges }: ReturnType<typeof blockLines>,
  order: Map<string, number>,
  couple: Block,
  run: LayoutRun,
  between: boolean,
): Map<string, number> | null {
  const parentX = new Map<number, number>();
  for (const edge of run.layout.edges) parentX.set(edge.childId, edge.points[0].x);
  const people = couple.slots.flatMap((s) => (s.kind === 'person' ? [s.personId] : []));
  const i = people.findIndex(
    (p, k) => parentX.has(p) && parentX.has(people[k + 1]) && parentX.get(p)! > parentX.get(people[k + 1])!,
  );
  if (i < 0) return null;
  const parentsOf = (id: number) => edges.find((e) => e.childId === id)?.from.block;
  const [left, right] = [parentsOf(people[i]), parentsOf(people[i + 1])];
  if (!left || !right) return null;
  const next = new Map<string, string[]>([...byId.keys()].map((id) => [id, []]));
  for (const e of edges) {
    if (e.from.block === e.to.block) continue;
    next.get(e.from.block)!.push(e.to.block);
    next.get(e.to.block)!.push(e.from.block);
  }
  // Ветка — всё, до чего можно дойти от родителей, не проходя через саму пару.
  const branch = (start: string) => {
    const seen = new Set([start]);
    const queue = [start];
    for (let q = 0; q < queue.length; q++)
      for (const n of next.get(queue[q])!)
        if (n !== couple.id && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
    return seen;
  };
  const [husband, wife] = [branch(left), branch(right)];
  for (const id of husband) if (wife.has(id)) return null;
  const result = new Map(order);
  const layers = new Map<number, string[]>();
  for (const id of [...(between ? [couple.id] : []), ...husband, ...wife])
    layers.set(layerOf.get(id)!, [...(layers.get(layerOf.get(id)!) ?? []), id]);
  for (const ids of layers.values()) {
    const slots = ids.map((id) => order.get(id)!).sort((a, b) => a - b);
    const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!;
    // Ветка родителей левого супруга (сейчас правее) встаёт на левые места, порядок внутри веток прежний.
    [
      ...ids.filter((id) => husband.has(id)).sort(byOrder),
      ...ids.filter((id) => id === couple.id),
      ...ids.filter((id) => wife.has(id)).sort(byOrder),
    ].forEach((id, k) => result.set(id, slots[k]));
  }
  return result;
}

/** Прикидка порядка по прямым: пересечения линий «брак → ребёнок» и пары крест-накрест (за два). */
function estimateOrder({ layerOf, byId, edges }: ReturnType<typeof blockLines>, order: Map<string, number>): number {
  const layers = new Map<number, string[]>();
  for (const [id, layer] of layerOf) layers.set(layer, [...(layers.get(layer) ?? []), id]);
  const x = new Map<string, number>();
  for (const ids of layers.values()) {
    let at = 0;
    for (const id of ids.sort((a, b) => order.get(a)! - order.get(b)!)) {
      x.set(id, at);
      at += byId.get(id)!.width + 32;
    }
  }
  const lines = edges.map(({ from, to }) => ({
    x1: x.get(from.block)! + from.dx,
    y1: layerOf.get(from.block)!,
    x2: x.get(to.block)! + to.dx,
    y2: layerOf.get(to.block)!,
  }));
  let count = 0;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const [a, b] = [lines[i], lines[j]];
      const top = Math.max(a.y1, b.y1);
      const bottom = Math.min(a.y2, b.y2);
      if (bottom <= top) continue;
      const at = (l: typeof a, yy: number) => l.x1 + ((l.x2 - l.x1) * (yy - l.y1)) / (l.y2 - l.y1);
      const [d1, d2] = [at(a, top) - at(b, top), at(a, bottom) - at(b, bottom)];
      if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) count++;
    }
  const parentX = new Map(lines.map((l, i) => [edges[i].childId, l.x1]));
  let crossed = 0;
  for (const b of byId.values()) {
    const people = b.slots.flatMap((s) => (s.kind === 'person' ? [s.personId] : []));
    if (people.some((p, k) => parentX.has(p) && parentX.has(people[k + 1]) && parentX.get(p)! > parentX.get(people[k + 1])!))
      crossed++;
  }
  return count + 2 * crossed;
}

/**
 * Доводка порядка после ELK. ELK подбирает порядок эвристикой и, бывает, оставляет
 * пересечения, которых нет при соседней перестановке (родители жены правее её свёкров — и
 * линии к детям идут крест-накрест). Меняем местами соседние блоки одного поколения и одной
 * стороны, пока пересечений линий «родители → дети» становится меньше. Считаем их по прямым
 * между поколениями — быстро и близко к тому, как потом проведёт линии ELK.
 */
function refineOrder(
  tree: Tree,
  run: LayoutRun,
  order: Map<string, number>,
  sideOf: (block: Block) => number,
  /** Доводка прежнего порядка: переставляем, только если пересечений становится меньше. */
  keep = false,
): Map<string, number> {
  const SPACING = 32;
  const { layerOf, byId, edges } = blockLines(tree, run);

  const layers = new Map<number, string[]>();
  for (const b of run.blocks) layers.set(layerOf.get(b.id)!, [...(layers.get(layerOf.get(b.id)!) ?? []), b.id]);
  for (const ids of layers.values()) ids.sort((a, b) => order.get(a)! - order.get(b)!);

  const positions = () => {
    const x = new Map<string, number>();
    for (const ids of layers.values()) {
      let at = 0;
      for (const id of ids) {
        x.set(id, at);
        at += byId.get(id)!.width + SPACING;
      }
    }
    return x;
  };
  // Пересечься могут только линии с общим отрезком по высоте — обычно из одного промежутка между
  // рядами. Линии группируем по рядам концов и перебираем пары только из пересекающихся групп:
  // оценка та же, а работы в разы меньше — доводка считает её тысячи раз.
  const byRows = new Map<string, number[]>();
  edges.forEach(({ from, to }, i) => {
    const key = `${layerOf.get(from.block)}|${layerOf.get(to.block)}`;
    byRows.set(key, [...(byRows.get(key) ?? []), i]);
  });
  const groups = [...byRows.values()];
  const rowsOf = (group: number[]) => {
    const { from, to } = edges[group[0]];
    return [layerOf.get(from.block)!, layerOf.get(to.block)!];
  };
  const groupPairs: [number[], number[]][] = [];
  for (let g = 0; g < groups.length; g++)
    for (let h = g; h < groups.length; h++) {
      const [[a1, a2], [b1, b2]] = [rowsOf(groups[g]), rowsOf(groups[h])];
      if (Math.min(a2, b2) > Math.max(a1, b1)) groupPairs.push([groups[g], groups[h]]);
    }

  // Оценка порядка: сначала число пересечений, при равенстве — общая длина линий. Прежний
  // порядок ради длины линий не трогаем — иначе дерево перетасуется после правки.
  const crossings = () => {
    const x = positions();
    const lines = edges.map(({ from, to }) => ({
      x1: x.get(from.block)! + from.dx,
      y1: layerOf.get(from.block)!,
      x2: x.get(to.block)! + to.dx,
      y2: layerOf.get(to.block)!,
    }));
    let count = 0;
    // При равном числе пересечений лучше, чтобы они были выше — среди дальних предков, над
    // парой родителей, а не длинной линией через полдерева к внуку; дальше — короче линии.
    let depth = 0;
    const length = lines.reduce((sum, l) => sum + Math.abs(l.x2 - l.x1), 0);
    for (const [first, second] of groupPairs) {
      for (let i = 0; i < first.length; i++) {
        for (let j = first === second ? i + 1 : 0; j < second.length; j++) {
          const a = lines[first[i]];
          const b = lines[second[j]];
          const top = Math.max(a.y1, b.y1);
          const bottom = Math.min(a.y2, b.y2);
          if (bottom <= top) continue;
          const at = (l: typeof a, yy: number) => l.x1 + ((l.x2 - l.x1) * (yy - l.y1)) / (l.y2 - l.y1);
          const d1 = at(a, top) - at(b, top);
          const d2 = at(a, bottom) - at(b, bottom);
          if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) {
            count++;
            depth += top;
          }
        }
      }
    }
    return keep ? count : count * 1e7 + depth * 50 + length;
  };

  // Проходы «по среднему соседей»: сверху вниз блок встаёт под своих родителей, снизу вверх —
  // над своими детьми. Сортируем только внутри стороны, стороны не перемешиваются.
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);
  const sweep = (down: boolean) => {
    const x = positions();
    for (const key of down ? layerKeys : [...layerKeys].reverse()) {
      const ids = layers.get(key)!;
      const center = (id: string) => {
        const near = edges.flatMap(({ from, to }) =>
          down
            ? to.block === id && layerOf.get(from.block)! < key
              ? [x.get(from.block)! + from.dx - to.dx]
              : []
            : from.block === id && layerOf.get(to.block)! > key
              ? [x.get(to.block)! + to.dx - from.dx]
              : [],
        );
        return near.length ? near.reduce((a, b) => a + b, 0) / near.length : x.get(id)!;
      };
      const wanted = new Map(ids.map((id) => [id, center(id)]));
      const bySide = new Map<number, string[]>();
      for (const id of ids) bySide.set(sideOf(byId.get(id)!), [...(bySide.get(sideOf(byId.get(id)!)) ?? []), id]);
      const sides = [...bySide.keys()].sort((a, b) => a - b);
      const next = sides.flatMap((side) => [...bySide.get(side)!].sort((a, b) => wanted.get(a)! - wanted.get(b)!));
      ids.splice(0, ids.length, ...next);
      // Позиции этого слоя обновились — следующий слой считает от них.
      let at = 0;
      for (const id of ids) {
        x.set(id, at);
        at += byId.get(id)!.width + SPACING;
      }
    }
  };

  let best = crossings();
  const snapshot = () => new Map([...layers].map(([k, ids]) => [k, [...ids]]));
  let bestLayers = snapshot();
  for (let i = 0; i < 4; i++) {
    sweep(i % 2 === 0);
    const now = crossings();
    if (now < best) {
      best = now;
      bestLayers = snapshot();
    }
  }
  for (const [k, ids] of bestLayers) layers.set(k, ids);

  const sameSide = (ids: string[], i: number) => sideOf(byId.get(ids[i])!) === sideOf(byId.get(ids[i + 1])!);
  const swap = (ids: string[], i: number) => ([ids[i], ids[i + 1]] = [ids[i + 1], ids[i]]);
  // Один жадный проход соседних перестановок по поколениям ниже: перестановка ветки наверху
  // часто окупается, только если под ней следом переставить её детей.
  const settleBelow = (from: number) => {
    for (const key of layerKeys.filter((k) => k > from)) {
      const ids = layers.get(key)!;
      for (let i = 0; i + 1 < ids.length; i++) {
        if (!sameSide(ids, i)) continue;
        swap(ids, i);
        const now = crossings();
        if (now < best) best = now;
        else swap(ids, i);
      }
    }
  };

  for (let pass = 0; pass < 10; pass++) {
    let improved = false;
    for (const key of layerKeys) {
      const ids = layers.get(key)!;
      for (let i = 0; i + 1 < ids.length; i++) {
        if (!sameSide(ids, i)) continue;
        const before = snapshot();
        const was = best;
        swap(ids, i);
        best = Infinity;
        best = crossings();
        if (best >= was) settleBelow(key);
        if (best < was) {
          improved = true;
        } else {
          for (const [k, saved] of before) layers.set(k, saved);
          best = was;
        }
      }
    }
    if (!improved) break;
  }

  const result = new Map(order);
  for (const ids of layers.values()) {
    const slots = ids.map((id) => order.get(id)!).sort((a, b) => a - b);
    ids.forEach((id, i) => result.set(id, slots[i]));
  }
  return result;
}

/**
 * Сторона каждого человека относительно центра: ±1 — через отца или мать, 0 — центр, его
 * братья и сёстры, дети; ±2 — родня супруга; ±3 — родня тех, кто вошёл в семью браком (жены
 * сына, мужа сестры). Минус — левее, плюс — правее. Сторона наследуется от того, через кого
 * человек связан с центром.
 *
 * Обычно отец стоит левее матери, и его родня слева. Но в режиме «рядом» у отца с двумя
 * браками первая жена стоит слева от него — если это мать центра, её родня тоже слева,
 * иначе линии к ней тянутся через полдерева. Так же и родня супруга — с того края, где он
 * стоит. x — где люди стоят в ряду: порядок внутри блока не зависит от прогона ELK.
 */
export function familySides(tree: Tree, centerId: number, x?: Map<number, number>): Map<number, number> {
  const parents = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  const spouses = new Map<number, number[]>();
  const push = (map: Map<number, number[]>, key: number, value: number) =>
    map.set(key, [...(map.get(key) ?? []), value]);
  for (const f of tree.families) {
    const known = f.partners.filter((p): p is number => p !== null);
    for (const c of f.children)
      for (const p of known) {
        push(parents, c.id, p);
        push(children, p, c.id);
      }
    if (known.length === 2) {
      push(spouses, known[0], known[1]);
      push(spouses, known[1], known[0]);
    }
  }
  const sex = new Map(tree.persons.map((p) => [p.id, p.sex]));
  const centerSex = sex.get(centerId);

  const side = new Map<number, number>([[centerId, 0]]);
  const queue = [centerId];
  const visit = (id: number, value: number) => {
    if (side.has(id)) return;
    side.set(id, value);
    queue.push(id);
  };
  const leftOf = (a: number, b: number) => (x?.has(a) && x.has(b) ? x.get(a)! < x.get(b)! : undefined);
  // Сначала — сами родители центра и его супруги, чтобы их стороны не перебила другая связь.
  const centerParents = parents.get(centerId) ?? [];
  const isFather = (p: number, i: number) => sex.get(p) === 'M' || (sex.get(p) !== 'F' && i === 0);
  // Отца и мать сравниваем, только если они пара: тогда они стоят в одном блоке.
  const couple = tree.families.find(
    (f) => f.children.some((c) => c.id === centerId) && f.partners.every((p) => p !== null),
  )?.partners as [number, number] | undefined;
  const motherLeft = couple !== undefined && (isFather(couple[0], 0) ? leftOf(couple[1], couple[0]) : leftOf(...couple));
  const fatherSide = motherLeft ? 1 : -1;
  centerParents.forEach((p, i) => visit(p, isFather(p, i) ? fatherSide : -fatherSide));
  // Родню супруга отодвигаем к его краю, только чтобы не смешать её с родней самого центра.
  // Если своих родителей у центра в дереве нет, отделять не от чего — родня супруга идёт
  // серединой, и муж не отрывается от своих братьев и сестёр.
  const spouseSide = (s: number) =>
    !parents.has(centerId) ? 0 : (leftOf(s, centerId) ?? centerSex === 'F') ? -2 : 2;
  for (const s of spouses.get(centerId) ?? []) {
    side.set(s, 0);
    queue.push(s);
  }
  // Середина — центр и его прямая родня: родители, братья и сёстры, дети, внуки. Кто вошёл в
  // неё браком (жена сына, муж сестры, отчим), стоит рядом с супругом, но его родители и вся их
  // родня — за краем, со стороны, где он стоит: иначе чужой род встаёт между родней отца и матери
  // и растаскивает их, и линии к бабушкам тянутся через полдерева. Дальше родни супруга центра —
  // она ближе: это бабушки и дедушки его детей.
  const marriedIn = new Map<number, number>();
  const inLawSide = (s: number, partner: number) => ((leftOf(s, partner) ?? sex.get(s) === 'M') ? -3 : 3);
  while (queue.length) {
    const id = queue.shift()!;
    const value = side.get(id)!;
    const isSpouseOfCenter = (spouses.get(centerId) ?? []).includes(id);
    // Дети и другие супруги родителей центра — его братья, сёстры, отчим — в середине.
    const nearCenter = centerParents.includes(id) ? 0 : value;
    const parentSide = isSpouseOfCenter ? spouseSide(id) : (marriedIn.get(id) ?? value);
    for (const p of parents.get(id) ?? []) visit(p, parentSide);
    for (const c of children.get(id) ?? []) visit(c, nearCenter);
    for (const s of spouses.get(id) ?? []) {
      if (nearCenter === 0 && !side.has(s) && parents.has(centerId)) marriedIn.set(s, inLawSide(s, id));
      visit(s, nearCenter);
    }
  }
  // Родители центра стоят в середине, над ним; их братья, сёстры и предки — уже по сторонам.
  for (const p of centerParents) side.set(p, 0);
  // Если у одного из родителей родни в дереве нет, отделять вторую сторону не от чего: она
  // занимает весь ряд, и родители встают среди неё, а не на краю за всей её роднёй.
  const values = new Set(side.values());
  if (!values.has(-1) || !values.has(1)) for (const [id, value] of side) if (Math.abs(value) === 1) side.set(id, 0);
  return side;
}

type LayoutRun = { layout: Layout; blocks: Block[] };

/**
 * Семьи на схеме: пары и одиночные родители с детьми. Брак с неизвестным без детей
 * на схеме ничего не добавляет — он виден на странице человека.
 */
export function visibleFamilies(tree: Tree): Family[] {
  return tree.families.filter((f) => {
    const known = f.partners.filter((p) => p !== null).length;
    return known === 2 || (known === 1 && f.children.length > 0);
  });
}

/** Ключ для сортировки по дате рождения; без даты — в конец. */
export function birthKeys(tree: Tree): (id: number) => string {
  const birth = new Map(tree.persons.map((p) => [p.id, findEvent(p.events, 'birth')?.date?.value]));
  return (id) => birth.get(id) ?? '9999';
}

/**
 * Промежутки между рядами. ELK сам раздвигает ряды под число линий, но в «Всём дереве» их
 * десятки в одном промежутке: шире ряды и шаг между параллельными линиями, чтобы они не сливались.
 */
const ROW_SPACING: Record<RowSpacing, Record<string, string>> = {
  compact: {
    'elk.layered.spacing.nodeNodeBetweenLayers': '56',
    'elk.layered.spacing.edgeNodeBetweenLayers': '16',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
  },
  wide: {
    'elk.layered.spacing.nodeNodeBetweenLayers': '96',
    'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '28',
  },
};

async function layoutOnce(
  tree: Tree,
  style: MarriageStyle,
  seed: number,
  order?: Map<string, number>,
  spacing: RowSpacing = 'compact',
  kin?: Lineage,
): Promise<LayoutRun> {
  const visible = visibleFamilies(tree);
  const birthKey = birthKeys(tree);
  const blocks = buildBlocks(tree, visible, style, birthKey);

  const hasParents = new Set(visible.flatMap((f) => f.children.map((c) => c.id)));
  const orderedBlocks = order ? [...blocks].sort((a, b) => order.get(a.id)! - order.get(b.id)!) : blocks;
  const children: ElkNode[] = orderedBlocks.map((block) => {
    const ports: ElkPort[] = [];
    for (const union of block.unions) {
      if (!union.family.children.length) continue;
      ports.push({
        id: `f${union.family.id}`,
        x: union.stemX,
        y: CARD.height,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': 'SOUTH' },
      });
    }
    for (const slot of block.slots) {
      if (slot.kind === 'person' && hasParents.has(slot.personId)) {
        const x = block.offsets.get(slotKey(slot))! + CARD.width / 2;
        ports.push({
          id: `in-p${slot.personId}`,
          x,
          y: 0,
          width: 0,
          height: 0,
          layoutOptions: { 'elk.port.side': 'NORTH' },
        });
      }
    }
    return {
      id: block.id,
      width: block.width,
      height: CARD.height,
      ports,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    };
  });

  // Порядок в модели влияет на раскладку: детей подаём по дате рождения.
  const edges: ElkExtendedEdge[] = visible.flatMap((f) =>
    [...f.children]
      .sort((a, b) => birthKey(a.id).localeCompare(birthKey(b.id)))
      .map((c) => ({
        id: `f${f.id}-p${c.id}`,
        sources: [`f${f.id}`],
        targets: [`in-p${c.id}`],
        ...(kin && isLineageEdge(kin, { familyId: f.id, childId: c.id })
          ? { layoutOptions: { 'elk.layered.priority.straightness': LINEAGE_STRAIGHTNESS } }
          : {}),
      })),
  );
  const edgeEnds = new Map<string, { familyId: number; childId: number }>(
    visible.flatMap((f) => f.children.map((c) => [`f${f.id}-p${c.id}`, { familyId: f.id, childId: c.id }] as const)),
  );

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
      // Замерено на реальном дереве: тщательный перебор порядка и
      // network simplex дают в 3 раза меньше пересечений во «всём дереве» и на треть
      // короче горизонтальные линии — родители встают над своими детьми.
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.thoroughness': '100',
      'elk.randomSeed': String(seed),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Заданный порядок (стороны семьи) ELK не меняет, но линии и отступы подбирает сам.
      // Greedy switch идёт после перебора и заданный порядок не учитывает: меняет соседние блоки,
      // если так на пересечение меньше, — и родня уходит на чужую сторону от родителей центра.
      // Сам перебор порядка тут тоже ни к чему: с forceNodeModelOrder он всё равно приходит к
      // заданному порядку, только тратит на это 400 мс вместо 60 на «Всём дереве».
      ...(order
        ? {
            'elk.layered.crossingMinimization.strategy': 'NONE',
            'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
            'elk.layered.crossingMinimization.greedySwitch.type': 'OFF',
          }
        : {}),
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.spacing.nodeNode': '32',
      ...ROW_SPACING[spacing],
      'elk.padding': '[top=48,left=48,bottom=48,right=48]',
    },
    children,
    edges,
  };
  const result = await new ELK().layout(graph);

  const placedBlocks = new Map(result.children!.map((n) => [n.id, n]));
  const layout: Layout = {
    persons: [],
    unknowns: [],
    unions: [],
    edges: [],
    refs: [],
    portals: [],
    clans: [],
    width: result.width ?? 0,
    height: result.height ?? 0,
  };

  for (const block of blocks) {
    const node = placedBlocks.get(block.id)!;
    const [nx, ny] = [node.x!, node.y!];
    for (const slot of block.slots) {
      const x = nx + block.offsets.get(slotKey(slot))!;
      if (slot.kind === 'person') layout.persons.push({ id: slot.personId, x, y: ny });
      else layout.unknowns.push({ familyId: slot.familyId, x, y: ny });
    }
    for (const union of block.unions) {
      layout.unions.push({
        familyId: union.family.id,
        kind: union.kind,
        path: union.path.map((p) => ({ x: nx + p.x, y: ny + p.y })),
        stem: union.family.children.length
          ? {
              x: nx + union.stemX,
              from: ny + union.stemFrom,
              to: ny + CARD.height,
            }
          : null,
      });
    }
  }

  for (const edge of result.edges ?? []) {
    const section = edge.sections?.[0];
    if (!section) continue;
    layout.edges.push({
      id: edge.id,
      ...edgeEnds.get(edge.id)!,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    });
  }
  return { layout, blocks };
}

/** Блоки, где у соседей-супругов линии от родителей идут крест-накрест. */
function crossedCouples({ layout, blocks }: LayoutRun): Block[] {
  const parentX = new Map<number, number>();
  for (const edge of layout.edges) parentX.set(Number(edge.id.split('-p')[1]), edge.points[0].x);
  const result: Block[] = [];
  for (const block of blocks) {
    const people = block.slots.filter((s) => s.kind === 'person').map((s) => (s as { personId: number }).personId);
    const crossed = people.some((left, i) => {
      const right = people[i + 1];
      return right !== undefined && parentX.has(left) && parentX.has(right) && parentX.get(left)! > parentX.get(right)!;
    });
    if (crossed) result.push(block);
  }
  return result;
}

/** Число пересечений горизонтальных и вертикальных участков всех линий. */
export function countCrossings(layout: Layout): number {
  type Segment = [number, number, number, number];
  const segments: Segment[] = [];
  const add = (points: { x: number; y: number }[]) => {
    for (let i = 1; i < points.length; i++) segments.push([points[i - 1].x, points[i - 1].y, points[i].x, points[i].y]);
  };
  for (const edge of layout.edges) add(edge.points);
  for (const union of layout.unions) {
    add(union.path);
    if (union.stem)
      add([
        { x: union.stem.x, y: union.stem.from },
        { x: union.stem.x, y: union.stem.to },
      ]);
  }
  const horizontal = (s: Segment) => Math.abs(s[1] - s[3]) < 0.5;
  let count = 0;
  for (const h of segments.filter(horizontal)) {
    const [x1, x2] = [Math.min(h[0], h[2]), Math.max(h[0], h[2])];
    for (const v of segments) {
      if (horizontal(v)) continue;
      const [y1, y2] = [Math.min(v[1], v[3]), Math.max(v[1], v[3])];
      if (v[0] > x1 + 0.5 && v[0] < x2 - 0.5 && h[1] > y1 + 0.5 && h[1] < y2 - 0.5) count++;
    }
  }
  return count;
}

function partnerSlots(family: Family): [Slot, Slot] {
  const [a, b] = family.partners;
  const toSlot = (p: number | null): Slot =>
    p === null ? { kind: 'unknown', familyId: family.id } : { kind: 'person', personId: p };
  return [toSlot(a), toSlot(b)];
}

export function buildBlocks(
  tree: Tree,
  visible: Family[],
  style: MarriageStyle,
  birthKey: (id: number) => string,
): Block[] {
  const slots = new Map<string, Slot>();
  const marriagesOf = new Map<string, Marriage[]>();
  const addSlot = (s: Slot) => {
    slots.set(slotKey(s), s);
    if (!marriagesOf.has(slotKey(s))) marriagesOf.set(slotKey(s), []);
  };
  for (const p of tree.persons) addSlot({ kind: 'person', personId: p.id });

  for (const family of visible) {
    const [a, b] = partnerSlots(family);
    addSlot(a);
    addSlot(b);
    // Порядок браков: дата брака, иначе год рождения старшего ребёнка.
    const married = findEvent(family.events, 'marriage')?.date?.value;
    const eldest = family.children.map((c) => birthKey(c.id)).sort()[0];
    const marriage: Marriage = {
      family,
      a: slotKey(a),
      b: slotKey(b),
      order: `${married ?? eldest ?? '9999'}|${family.id}`,
    };
    marriagesOf.get(marriage.a)!.push(marriage);
    marriagesOf.get(marriage.b)!.push(marriage);
  }
  for (const list of marriagesOf.values()) list.sort((x, y) => x.order.localeCompare(y.order));

  const sexes = new Map(tree.persons.map((p) => [`p${p.id}`, p.sex]));
  const other = (m: Marriage, key: string) => (m.a === key ? m.b : m.a);
  // «Неизвестный» партнёр считается противоположного пола к своему супругу.
  const sexOf = (key: string): string => {
    if (sexes.has(key)) return sexes.get(key)!;
    const partner = other(marriagesOf.get(key)![0], key);
    const s = sexes.get(partner);
    return s === 'M' ? 'F' : s === 'F' ? 'M' : 'U';
  };

  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const start of slots.keys()) {
    if (seen.has(start)) continue;
    const component = connected(start, marriagesOf, other);
    component.forEach((k) => seen.add(k));

    const marriages = [...new Set(component.flatMap((k) => marriagesOf.get(k)!))];
    const isChain =
      marriages.length === component.length - 1 && component.every((k) => marriagesOf.get(k)!.length <= 2);
    const row =
      style === 'compact' && isChain
        ? orientChain(chainRow(component, marriagesOf, other), marriagesOf, other, sexOf)
        : bridgeRow(component, marriagesOf, other, sexOf);

    const index = new Map(row.map((k, i) => [k, i]));
    const adjacent = (m: Marriage) => Math.abs(index.get(m.a)! - index.get(m.b)!) === 1;
    const degree = (k: string) => marriagesOf.get(k)!.length;

    // Промежуток k — между row[k-1] и row[k]; 0 и row.length — поля по краям строки.
    const marriedGap = new Set(marriages.filter(adjacent).map((m) => Math.max(index.get(m.a)!, index.get(m.b)!)));

    // Несоседний брак — прямая линия за карточками. Линия к детям опускается с неё в
    // свободный промежуток между супругами, ближайший ко второму супругу (у кого меньше
    // браков; при равенстве — жена). Промежуток занят, если в нём линия соседнего брака или
    // спуск другого такого брака; короткие браки выбирают первыми. Если свободного
    // промежутка между супругами нет, спуск идёт сбоку от второго супруга.
    type Landing =
      { mode: 'drop'; second: string; gap: number } | { mode: 'side'; second: string; gap: number; side: -1 | 1 };
    const landings = new Map<Marriage, Landing>();
    const taken = new Set(marriedGap);
    const secondOf = (m: Marriage) =>
      degree(m.a) !== degree(m.b) ? (degree(m.a) < degree(m.b) ? m.a : m.b) : sexOf(m.a) === 'F' ? m.a : m.b;
    const distance = (m: Marriage) => Math.abs(index.get(m.a)! - index.get(m.b)!);
    for (const m of marriages.filter((mm) => !adjacent(mm)).sort((p, q) => distance(p) - distance(q))) {
      const second = secondOf(m);
      const i = index.get(second)!;
      const j = index.get(other(m, second))!;
      // Промежутки строго между супругами, от второго супруга к первому.
      const between = j < i ? range(i, j + 1) : range(i + 1, j);
      const free = between.find((k) => !taken.has(k));
      if (free !== undefined) {
        taken.add(free);
        landings.set(m, { mode: 'drop', second, gap: free });
        continue;
      }
      const toward: -1 | 1 = j < i ? -1 : 1;
      const near = toward < 0 ? i : i + 1;
      const far = toward < 0 ? i + 1 : i;
      const gap = taken.has(near) && !taken.has(far) ? far : near;
      taken.add(gap);
      landings.set(m, { mode: 'side', second, gap, side: gap === i ? -1 : 1 });
    }
    const landingGaps = new Set([...landings.values()].map((l) => l.gap));

    const offsets = new Map<string, number>();
    let x = landingGaps.has(0) ? LANDING_MARGIN : 0;
    row.forEach((key, i) => {
      if (i > 0) {
        const base = marriedGap.has(i) ? SPOUSE_GAP : SIBLING_GAP;
        x += landingGaps.has(i) ? Math.max(base, LANDING_GAP) : base;
      }
      offsets.set(key, x);
      x += slotWidth(slots.get(key)!);
    });
    if (landingGaps.has(row.length)) x += LANDING_MARGIN;
    const center = (key: string) => offsets.get(key)! + slotWidth(slots.get(key)!) / 2;
    const edge = (key: string, side: -1 | 1) => center(key) + (side * slotWidth(slots.get(key)!)) / 2;
    // Середина промежутка k (для полей по краям — отступ от крайней карточки).
    const gapX = (k: number) =>
      k === 0
        ? edge(row[0], -1) - LANDING_GAP / 2
        : k === row.length
          ? edge(row.at(-1)!, 1) + LANDING_GAP / 2
          : (edge(row[k - 1], 1) + edge(row[k], -1)) / 2;

    const unions: BlockUnion[] = [];
    // Где линия несоседнего брака: какие карточки она накрывает (для уровней).
    const reach = (m: Marriage) => {
      const l = landings.get(m)!;
      const firstIndex = index.get(other(m, l.second))!;
      const secondIndex = l.mode === 'drop' ? index.get(l.second)! : l.gap - (l.side < 0 ? 0.5 : -0.5);
      return [Math.min(secondIndex, firstIndex), Math.max(secondIndex, firstIndex)] as const;
    };
    // Линии дальних браков — над линиями соседних, короткие ниже, длинные выше: дети спускаются
    // вниз, и ни один спуск не задевает линию, которая лежит ниже и накрывает его промежуток.
    const bridges = [...landings.keys()].sort((p, q) => reach(p)[1] - reach(p)[0] - (reach(q)[1] - reach(q)[0]));
    const levels = new Map<Marriage, number>();
    for (const m of bridges) {
      const [lo, hi] = reach(m);
      const below = bridges.filter((o) => levels.has(o) && reach(o)[0] <= hi && reach(o)[1] >= lo);
      levels.set(m, 1 + Math.max(0, ...below.map((o) => levels.get(o)!)));
    }
    for (const m of marriages) {
      if (adjacent(m)) {
        const [left, right] = [m.a, m.b].sort((p, q) => index.get(p)! - index.get(q)!);
        const from = center(left) + AVATAR.radius;
        const to = center(right) - AVATAR.radius;
        unions.push({
          family: m.family,
          kind: 'adjacent',
          path: [
            { x: from, y: AVATAR.cy },
            { x: to, y: AVATAR.cy },
          ],
          stemX: (from + to) / 2,
          stemFrom: AVATAR.cy,
        });
        continue;
      }
      const landing = landings.get(m)!;
      const { second } = landing;
      const first = other(m, second);
      // Прямая за карточками, как в familio: от центра аватара до центра аватара (сами аватары
      // и карточки между супругами её закрывают); дети — вертикалью с неё в свободном промежутке.
      const y = AVATAR.cy - levels.get(m)! * LINE_STEP;
      const landX = gapX(landing.gap);
      unions.push({
        family: m.family,
        kind: 'bridge',
        path: [
          { x: center(first), y },
          { x: landing.mode === 'drop' ? center(second) : landX, y },
        ],
        stemX: landX,
        stemFrom: y,
      });
    }

    blocks.push({ id: `b${blocks.length}`, slots: row.map((k) => slots.get(k)!), offsets, width: x, unions });
  }
  return blocks;
}

type Other = (m: Marriage, key: string) => string;

/** Числа от from до to включительно, в любую сторону. */
const range = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + i * Math.sign(to - from || 1));

function connected(start: string, marriagesOf: Map<string, Marriage[]>, other: Other): string[] {
  const order = [start];
  const seen = new Set(order);
  for (let i = 0; i < order.length; i++) {
    for (const m of marriagesOf.get(order[i])!) {
      const n = other(m, order[i]);
      if (!seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
  }
  return order;
}

/** Цепочка браков (у каждого не больше двух): идём от одного конца к другому. */
function chainRow(component: string[], marriagesOf: Map<string, Marriage[]>, other: Other): string[] {
  const start = component.find((k) => marriagesOf.get(k)!.length <= 1) ?? component[0];
  const row = [start];
  const seen = new Set(row);
  for (;;) {
    const next = marriagesOf
      .get(row.at(-1)!)!
      .map((m) => other(m, row.at(-1)!))
      .find((n) => !seen.has(n));
    if (next === undefined) return row;
    seen.add(next);
    row.push(next);
  }
}

/**
 * Направление цепочки: у человека с двумя браками более ранний брак — слева,
 * у пар — муж слева. Выбираем разворот, при котором пожеланий выполняется больше.
 */
function orientChain(row: string[], marriagesOf: Map<string, Marriage[]>, other: Other, sexOf: (k: string) => string) {
  const score = (r: string[]) => {
    let total = 0;
    r.forEach((key, i) => {
      const list = marriagesOf.get(key)!;
      if (list.length === 2) {
        const earlier = other(list[0], key);
        total += r.indexOf(earlier) < i ? 2 : -2;
      }
      if (i > 0) {
        const [l, rr] = [r[i - 1], key];
        if (sexOf(l) === 'M' || sexOf(rr) === 'F') total += 1;
        else if (sexOf(l) === 'F' || sexOf(rr) === 'M') total -= 1;
      }
    });
    return total;
  };
  const reversed = [...row].reverse();
  return score(reversed) > score(row) ? reversed : row;
}

/**
 * Строка «в ряд»: от человека с наибольшим числом браков; у мужчины жёны справа по порядку
 * браков, у женщины мужья слева; другие браки каждого супруга — с его внешней стороны.
 * Муж всегда левее жены.
 */
function bridgeRow(
  component: string[],
  marriagesOf: Map<string, Marriage[]>,
  other: Other,
  sexOf: (k: string) => string,
) {
  const root = [...component].sort((p, q) => {
    const byDegree = marriagesOf.get(q)!.length - marriagesOf.get(p)!.length;
    if (byDegree) return byDegree;
    return (sexOf(p) === 'M' ? 0 : 1) - (sexOf(q) === 'M' ? 0 : 1);
  })[0];

  const visited = new Set<string>();
  const place = (key: string): string[] => {
    visited.add(key);
    const partners = marriagesOf
      .get(key)!
      .map((m) => other(m, key))
      .filter((n) => !visited.has(n));
    partners.forEach((n) => visited.add(n));
    const segments = partners.flatMap((n) => place(n));
    return sexOf(key) === 'F' ? [...segments, key] : [key, ...segments];
  };
  const row = place(root);
  // Циклы браков (редкость) — остаток просто дописываем в конец.
  for (const key of component) if (!row.includes(key)) row.push(key);
  return row;
}
