import { CARD, REF_CARD, UNKNOWN_CARD, type Layout, type MarriageStyle, type PlacedEdge } from './geometry.ts';
import { birthKeys, buildBlocks, slotKey, visibleFamilies, type Block, type BlockUnion, type Slot } from './layout.ts';
import type { Tree } from './model.ts';

/**
 * «По родам»: всё дерево как несколько деревьев потомков. Брак, где у обоих супругов есть
 * родители в дереве, соединяет два рода — нарисовать такое одной схемой без линий через
 * полдерева нельзя. Здесь пара остаётся в роду одного супруга, а в семье родителей другого на
 * его месте стоит ссылка. Каждый род — обычное дерево потомков без пересечений; поколения всех
 * родов стоят в общих рядах. ELK не нужен: раскладка — контурами, как у деревьев потомков.
 *
 * Роды срастаются, где это ничего не стоит: род родителей второго супруга встаёт вплотную к паре,
 * супруг — с его края пары, и вместо ссылки идёт обычная линия, если она не пересекает и не
 * накрывает чужие. Иначе остаётся ссылка.
 */

/** Шаг между поколениями: карточка и промежуток под линии к детям и пометки «↑ родители». */
const ROW = CARD.height + 90;
const SIBLING_GAP = 24;
/** Между поддеревьями двоюродных и дальше — шире, чтобы ветки не сливались. */
const BRANCH_GAP = 48;
const CLAN_GAP = 96;
const PADDING = 48;

/** Связь «брак → ребёнок» между блоками. */
type Link = { parent: Block; union: BlockUnion; childId: number };
type Node =
  | { kind: 'block'; block: Block; width: number; via?: Link; groups: Group[] }
  | { kind: 'ref'; link: Link; width: number; via: Link; groups: [] };
type Group = { union: BlockUnion; nodes: Node[] };
/** Левый и правый край занятого места в каждом ряду. */
type Contour = Map<number, [number, number]>;
type Point = { x: number; y: number };
/** Сращивание: вместо ссылки — линия к самому человеку; side — с какой стороны от него род родителей. */
type Join = { link: Link; side: -1 | 1 };
/** Сросшиеся роды: стоят вместе, как один. shift — где корень каждого рода, от корня первого. */
type Unit = { clans: Node[]; shift: Map<Node, number>; contour: Contour; joins: { link: Link; points: Point[] }[] };

export function layoutClans(tree: Tree, style: MarriageStyle = 'compact'): Layout {
  if (!tree.persons.length)
    return emptyLayout();
  const birthKey = birthKeys(tree);
  const blocks = buildBlocks(tree, visibleFamilies(tree), style, birthKey);
  const blockOf = new Map<number, Block>();
  for (const b of blocks) for (const s of b.slots) if (s.kind === 'person') blockOf.set(s.personId, b);

  const links: Link[] = blocks.flatMap((parent) =>
    parent.unions.flatMap((union) =>
      union.family.children.filter((c) => blockOf.has(c.id)).map((c) => ({ parent, union, childId: c.id })),
    ),
  );
  const linkOf = new Map(links.map((l) => [`${l.union.family.id}:${l.childId}`, l]));
  const main = mainLinks(tree, blockOf, links);
  const level = generations(blocks, blockOf, links);
  const sex = new Map(tree.persons.map((p) => [p.id, p.sex]));
  const mirrors = new Map<Block, Block>();
  const mirrored = (b: Block) => mirrors.get(b) ?? mirrors.set(b, mirror(b)).get(b)!;

  /** Раскладка родов при заданных сращиваниях; null — если они друг другу мешают. */
  const arrange = (joins: Join[]) => {
    // Супруг встаёт с края пары, где род его родителей: блок при нужде разворачивается.
    const flip = new Map<Block, boolean>();
    for (const { link, side } of joins) {
      const block = blockOf.get(link.childId)!;
      const i = block.slots.findIndex((s) => s.kind === 'person' && s.personId === link.childId);
      const last = block.slots.length - 1;
      if (i !== 0 && i !== last) return null;
      const turn = last > 0 && (i === 0 ? side > 0 : side < 0);
      if (flip.has(block) && flip.get(block) !== turn) return null;
      flip.set(block, turn);
    }
    const shown = (b: Block) => (flip.get(b) ? mirrored(b) : b);
    const joined = new Set(joins.map((j) => j.link));

    // Деревья потомков: от блоков, которые не висят на своих родителях, вниз по главным связям.
    const visited = new Set<Block>();
    const build = (block: Block, via?: Link): Node => {
      visited.add(block);
      const view = shown(block);
      const groups = [...view.unions]
        .sort((a, b) => a.stemX - b.stemX)
        .flatMap((union): Group[] => {
          const nodes = [...union.family.children]
            .filter((c) => blockOf.has(c.id))
            .sort((a, b) => birthKey(a.id).localeCompare(birthKey(b.id)))
            .flatMap((c): Node[] => {
              const link = linkOf.get(`${union.family.id}:${c.id}`)!;
              if (joined.has(link)) return [];
              const child = blockOf.get(c.id)!;
              // Если блок уже нарисован (цикл в данных), он тоже становится ссылкой.
              return [
                main.get(child) === link && !visited.has(child)
                  ? build(child, link)
                  : { kind: 'ref', link, width: REF_CARD.width, via: link, groups: [] },
              ];
            });
          return nodes.length ? [{ union, nodes }] : [];
        });
      return { kind: 'block', block: view, width: view.width, via, groups };
    };
    const clans: Node[] = [];
    for (const b of blocks) if (!main.has(b)) clans.push(build(b));
    // Блоки, не достижимые от корней, — только при цикле «сам себе предок»: рвём его.
    for (const b of blocks) if (!visited.has(b)) clans.push(build(b));

    // Каждый род — контурами: поддеревья детей вплотную друг к другу, родитель над ними.
    const offset = new Map<Node, number>();
    const anchor = (node: Node) =>
      node.kind === 'block' && node.via
        ? node.block.offsets.get(`p${node.via.childId}`)! + CARD.width / 2
        : node.width / 2;
    const shape = (node: Node, row: number): Contour => {
      const contour: Contour = new Map([[row, [0, node.width]]]);
      const kids = node.groups.flatMap((g) => g.nodes.map((n) => ({ n, g })));
      if (!kids.length) return contour;
      const packed: Contour = new Map();
      const at = kids.map(({ n }) => {
        const c = shape(n, row + 1);
        const x = packed.size ? separation(packed, c, (r) => (r === row + 1 ? SIBLING_GAP : BRANCH_GAP)) : 0;
        merge(packed, c, x);
        return x;
      });
      // Спуск каждого брака — над серединой своих детей; родитель встаёт так, чтобы в среднем так и было.
      const wants = node.groups.map((g) => {
        const xs = kids.flatMap((k, i) => (k.g === g ? [at[i] + anchor(k.n)] : []));
        return (Math.min(...xs) + Math.max(...xs)) / 2 - g.union.stemX;
      });
      const left = wants.reduce((a, b) => a + b, 0) / wants.length;
      kids.forEach(({ n }, i) => offset.set(n, at[i] - left));
      merge(contour, packed, -left);
      return contour;
    };
    const rowOf = new Map(blocks.map((b) => [b.id, level.get(b)!]));
    const contours = new Map(clans.map((clan) => [clan, shape(clan, rowOf.get((clan as { block: Block }).block.id)!)]));

    // Где что стоит внутри рода (от левого края корня) и в каком ряду.
    const local = new Map<Node, number>();
    const row = new Map<Node, number>();
    const clanOf = new Map<Node, Node>();
    const nodeOfBlock = new Map<string, Node>();
    const refs: Node[] = [];
    for (const clan of clans) {
      const walk = (node: Node, x: number, r: number) => {
        local.set(node, x);
        row.set(node, r);
        clanOf.set(node, clan);
        if (node.kind === 'block') nodeOfBlock.set(node.block.id, node);
        else refs.push(node);
        for (const g of node.groups) for (const n of g.nodes) walk(n, x + offset.get(n)!, r + 1);
      };
      walk(clan, 0, contours.get(clan)!.keys().next().value!);
    }
    const nodeOfPerson = (personId: number) => nodeOfBlock.get(blockOf.get(personId)!.id)!;

    // Сращивания: род родителей встаёт вплотную к роду пары — так, чтобы линия к супругу шла
    // вертикально, если позволяют соседи, иначе как можно ближе к нему.
    const unitOf = new Map<Node, Unit>(
      clans.map((clan) => [clan, { clans: [clan], shift: new Map([[clan, 0]]), contour: new Map(contours.get(clan)!), joins: [] }]),
    );
    const inUnit = (node: Node) => unitOf.get(clanOf.get(node)!)!.shift.get(clanOf.get(node)!)! + local.get(node)!;
    const personX = (personId: number) => {
      const node = nodeOfPerson(personId);
      return inUnit(node) + (node as { block: Block }).block.offsets.get(`p${personId}`)! + CARD.width / 2;
    };
    for (const { link, side } of joins) {
      const child = nodeOfPerson(link.childId);
      const parent = nodeOfBlock.get(link.parent.id)!;
      const near = unitOf.get(clanOf.get(child)!)!;
      const far = unitOf.get(clanOf.get(parent)!)!;
      const r = row.get(child)!;
      if (near === far || row.get(parent)! + 1 !== r) return null;
      const to = personX(link.childId);
      const stem = inUnit(parent) + shown(link.parent).unions.find((u) => u.family.id === link.union.family.id)!.stemX;
      let dx = to - stem;
      for (const [rr, [lo, hi]] of far.contour) {
        const have = near.contour.get(rr);
        if (have) dx = side < 0 ? Math.min(dx, have[0] - CLAN_GAP - hi) : Math.max(dx, have[1] + CLAN_GAP - lo);
      }
      for (const clan of far.clans) {
        near.clans.push(clan);
        near.shift.set(clan, far.shift.get(clan)! + dx);
        unitOf.set(clan, near);
      }
      merge(near.contour, far.contour, dx);
      for (const j of far.joins) near.joins.push({ link: j.link, points: j.points.map((p) => ({ x: p.x + dx, y: p.y })) });
      const from = stem + dx;
      const top = (r - 1) * ROW + CARD.height;
      const bus = top + (ROW - CARD.height) / 2;
      near.joins.push({
        link,
        points:
          Math.abs(from - to) < 0.5
            ? [
                { x: from, y: top },
                { x: from, y: r * ROW },
              ]
            : [
                { x: from, y: top },
                { x: from, y: bus },
                { x: to, y: bus },
                { x: to, y: r * ROW },
              ],
      });
      // Линия идёт под рядом родителей: соседние роды не должны вставать над ней.
      merge(near.contour, new Map([[r - 1, [Math.min(from, to), Math.max(from, to)]]]), 0);
    }
    const units = [...new Set(unitOf.values())];

    /** Род в раскладку: x — левый край корня, dy — сдвиг рядов (ряд r стоит на r·ROW + dy). */
    const draw = (node: Node, x: number, dy: number, layout: Layout) => {
      const y = row.get(node)! * ROW + dy;
      if (node.kind === 'ref') {
        const { childId, union } = node.link;
        const via = main.get(blockOf.get(childId)!)?.childId ?? childId;
        layout.refs.push({ personId: childId, familyId: union.family.id, via, x, y });
        return;
      }
      const { block } = node;
      for (const slot of block.slots) {
        const sx = x + block.offsets.get(slotKey(slot))!;
        if (slot.kind === 'person') layout.persons.push({ id: slot.personId, x: sx, y });
        else layout.unknowns.push({ familyId: slot.familyId, x: sx, y });
      }
      for (const union of block.unions) {
        layout.unions.push({
          familyId: union.family.id,
          kind: union.kind,
          path: union.path.map((p) => ({ x: x + p.x, y: y + p.y })),
          stem: union.family.children.length
            ? { x: x + union.stemX, from: y + union.stemFrom, to: y + CARD.height }
            : null,
        });
      }
      const busY = y + CARD.height + (ROW - CARD.height) / 2;
      for (const g of node.groups) {
        const from = x + g.union.stemX;
        for (const n of g.nodes) {
          const nx = x + offset.get(n)!;
          const to = nx + anchor(n);
          layout.edges.push({
            id: `f${g.union.family.id}-${n.kind === 'ref' ? 'r' : 'p'}${n.via!.childId}`,
            familyId: g.union.family.id,
            childId: n.via!.childId,
            points:
              Math.abs(from - to) < 0.5
                ? [
                    { x: from, y: y + CARD.height },
                    { x: from, y: y + ROW },
                  ]
                : [
                    { x: from, y: y + CARD.height },
                    { x: from, y: busY },
                    { x: to, y: busY },
                    { x: to, y: y + ROW },
                  ],
          });
          draw(n, nx, dy, layout);
        }
      }
    };
    const joinEdge = (j: Unit['joins'][number], dx: number, dy: number): PlacedEdge => ({
      id: `f${j.link.union.family.id}-p${j.link.childId}`,
      familyId: j.link.union.family.id,
      childId: j.link.childId,
      points: j.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    });

    /**
     * Линии сросшихся родов не задевают чужие: ни пересечения, ни касания, ни наложения. Внутри
     * рода линии и так не пересекаются, поэтому сверяем только линии разных родов и сращиваний.
     */
    const clean = () =>
      units.every((unit) => {
        if (!unit.joins.length) return true;
        const lines: { edge: PlacedEdge; owner: number }[] = [];
        unit.clans.forEach((clan, i) => {
          const layout = emptyLayout();
          draw(clan, unit.shift.get(clan)!, 0, layout);
          for (const edge of layout.edges) lines.push({ edge, owner: i });
        });
        for (const j of unit.joins) lines.push({ edge: joinEdge(j, 0, 0), owner: -1 });
        // Линии к детям лежат в промежутке под рядом родителей: сравниваем только в одном промежутке.
        const byGap = new Map<number, typeof lines>();
        for (const line of lines) {
          const gap = Math.floor(line.edge.points[0].y / ROW);
          (byGap.get(gap) ?? byGap.set(gap, []).get(gap)!).push(line);
        }
        for (const list of byGap.values())
          for (let i = 0; i < list.length; i++)
            for (let k = i + 1; k < list.length; k++) {
              const [a, b] = [list[i], list[k]];
              if (a.edge.familyId === b.edge.familyId) continue;
              if (a.owner === b.owner && a.owner !== -1) continue;
              if (touches(a.edge.points, b.edge.points)) return false;
            }
        return true;
      });

    const size = (node: Node): number => 1 + node.groups.reduce((s, g) => s + g.nodes.reduce((t, n) => t + size(n), 0), 0);
    const rowY = (node: Node) => row.get(node)! * ROW;
    return { clans, units, unitOf, clanOf, local, refs, nodeOfPerson, inUnit, personX, draw, joinEdge, clean, size, rowY };
  };

  // Сращиваем по одной ссылке, начиная с маленьких родов: каждое сращивание проверяем на готовой
  // раскладке и оставляем, только если линии чистые. Сначала — без разворота пары. Сращивание
  // сдвигает роды, и не сросшаяся раньше ссылка может срастись потом: проходим, пока что-то меняется.
  let plan = arrange([])!;
  const joins: Join[] = [];
  let pending = [...plan.refs]
    .sort((a, b) => plan.size(plan.clanOf.get(a)!) - plan.size(plan.clanOf.get(b)!))
    .map((ref) => (ref as { link: Link }).link);
  for (let changed = true; changed; ) {
    changed = false;
    pending = pending.filter((link) => {
      const block = blockOf.get(link.childId)!;
      const i = block.slots.findIndex((s) => s.kind === 'person' && s.personId === link.childId);
      const sides: (-1 | 1)[] = i === block.slots.length - 1 && i > 0 ? [1, -1] : [-1, 1];
      for (const side of sides) {
        const trial = arrange([...joins, { link, side }]);
        if (!trial?.clean()) continue;
        joins.push({ link, side });
        plan = trial;
        changed = true;
        return false;
      }
      return true;
    });
  }

  const { units } = plan;
  const size = (unit: Unit) => unit.clans.reduce((s, clan) => s + plan.size(clan), 0);
  const unitOfPerson = (personId: number) => plan.unitOf.get(plan.clanOf.get(plan.nodeOfPerson(personId))!)!;
  const ordered = orderClans(units, (unit) => unit.contour, size, (unit) =>
    unit.clans.flatMap((clan) =>
      plan.refs.flatMap((ref) => {
        if (plan.clanOf.get(ref) !== clan) return [];
        const { childId } = (ref as { link: Link }).link;
        const other = unitOfPerson(childId);
        return other === unit ? [] : [{ clan: other, at: plan.inUnit(ref) + ref.width / 2, back: plan.personX(childId) }];
      }),
    ),
  );

  // Роды — слева направо по общим рядам, каждый вплотную к уже поставленным.
  const placed: Contour = new Map();
  const shift = new Map<Unit, number>();
  for (const unit of ordered) {
    const c = unit.contour;
    const shared = [...c.keys()].some((r) => placed.has(r));
    const x = !placed.size
      ? 0
      : shared
        ? separation(placed, c, () => CLAN_GAP)
        : Math.max(...[...placed.values()].map(([, hi]) => hi)) + CLAN_GAP - Math.min(...[...c.values()].map(([lo]) => lo));
    shift.set(unit, x);
    merge(placed, c, x);
  }

  const minX = Math.min(...[...placed.values()].map(([lo]) => lo));
  const maxX = Math.max(...[...placed.values()].map(([, hi]) => hi));
  const minRow = Math.min(...placed.keys());
  const maxRow = Math.max(...placed.keys());
  const dx = PADDING - minX;
  const dy = PADDING - minRow * ROW;

  const layout: Layout = {
    ...emptyLayout(),
    width: maxX - minX + 2 * PADDING,
    height: (maxRow - minRow) * ROW + CARD.height + 2 * PADDING,
  };
  for (const unit of ordered) {
    const x = shift.get(unit)! + dx;
    for (const clan of unit.clans) {
      const left = x + unit.shift.get(clan)!;
      plan.draw(clan, left, dy, layout);
      // Род называется по мужу из верхней пары, без него — по первому в ней.
      const { block } = clan as { block: Block };
      const people = block.slots.flatMap((s) => (s.kind === 'person' ? [s.personId] : []));
      const bearer = people.find((id) => sex.get(id) === 'M') ?? people[0];
      if (bearer !== undefined) layout.clans.push({ personId: bearer, x: left + block.width / 2, y: plan.rowY(clan) + dy });
    }
    for (const j of unit.joins) layout.edges.push(plan.joinEdge(j, x, dy));
  }

  const position = new Map(layout.persons.map((p) => [p.id, p]));
  for (const id of new Set(layout.refs.map((r) => r.personId))) {
    const p = position.get(id)!;
    layout.portals.push({ personId: id, x: p.x + CARD.width / 2, y: p.y });
  }
  return layout;
}

const emptyLayout = (): Layout => ({
  persons: [],
  unknowns: [],
  unions: [],
  edges: [],
  refs: [],
  portals: [],
  clans: [],
  width: 0,
  height: 0,
});

/** Блок, отражённый слева направо: тот же ряд супругов в обратном порядке. */
function mirror(block: Block): Block {
  const width = (s: Slot) => (s.kind === 'person' ? CARD.width : UNKNOWN_CARD.width);
  return {
    ...block,
    slots: [...block.slots].reverse(),
    offsets: new Map(block.slots.map((s) => [slotKey(s), block.width - block.offsets.get(slotKey(s))! - width(s)])),
    unions: block.unions.map((u) => ({
      ...u,
      path: u.path.map((p) => ({ x: block.width - p.x, y: p.y })),
      stemX: block.width - u.stemX,
    })),
  };
}

/** Задевают ли друг друга две ломаные из горизонтальных и вертикальных участков. */
function touches(a: Point[], b: Point[]): boolean {
  const segments = (points: Point[]) => points.slice(1).map((p, i) => [points[i], p] as const);
  const span = (u: number, v: number) => [Math.min(u, v), Math.max(u, v)] as const;
  for (const [p1, p2] of segments(a))
    for (const [q1, q2] of segments(b)) {
      const [ax1, ax2] = span(p1.x, p2.x);
      const [ay1, ay2] = span(p1.y, p2.y);
      const [bx1, bx2] = span(q1.x, q2.x);
      const [by1, by2] = span(q1.y, q2.y);
      if (ax1 <= bx2 + 0.5 && bx1 <= ax2 + 0.5 && ay1 <= by2 + 0.5 && by1 <= ay2 + 0.5) return true;
    }
  return false;
}

/**
 * С какими родителями пара остаётся в одном дереве. В блоке могут быть дети разных семей
 * (муж и жена, у обоих родители в дереве); остаётся связь того, у кого больше браков (все его
 * супруги стоят в одной строке с ним), при равенстве — мужа. Остальные связи — ссылки.
 */
function mainLinks(tree: Tree, blockOf: Map<number, Block>, links: Link[]): Map<Block, Link> {
  const sex = new Map(tree.persons.map((p) => [p.id, p.sex]));
  const incoming = new Map<Block, Link[]>();
  for (const l of links) {
    const child = blockOf.get(l.childId)!;
    if (child !== l.parent) incoming.set(child, [...(incoming.get(child) ?? []), l]);
  }
  const main = new Map<Block, Link>();
  for (const [block, list] of incoming) {
    const marriages = (id: number) => block.unions.filter((u) => u.family.partners.includes(id)).length;
    const rank = (l: Link) => [-marriages(l.childId), sex.get(l.childId) === 'M' ? 0 : 1, l.childId, l.union.family.id];
    const [first] = [...list].sort((a, b) => compare(rank(a), rank(b)));
    main.set(block, first);
  }
  return main;
}

/** Поколение каждого блока: обход по связям родители ↔ дети; ребёнок на ряд ниже родителей. */
function generations(blocks: Block[], blockOf: Map<number, Block>, links: Link[]): Map<Block, number> {
  const next = new Map<Block, { to: Block; step: number }[]>(blocks.map((b) => [b, []]));
  for (const l of links) {
    const child = blockOf.get(l.childId)!;
    next.get(l.parent)!.push({ to: child, step: 1 });
    next.get(child)!.push({ to: l.parent, step: -1 });
  }
  const level = new Map<Block, number>();
  for (const start of blocks) {
    if (level.has(start)) continue;
    level.set(start, 0);
    const queue = [start];
    for (let i = 0; i < queue.length; i++)
      for (const { to, step } of next.get(queue[i])!)
        if (!level.has(to)) {
          level.set(to, level.get(queue[i])! + step);
          queue.push(to);
        }
  }
  return level;
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

type Neighbor<T> = { clan: T; at: number; back: number };

/**
 * Порядок родов слева направо. Роды связаны ссылками в дерево; обходим его от самого большого
 * рода: его соседи встают с того края, где в нём стоит ссылка на них, дальше — наружу. С каждого
 * края ближе встают маленькие ветки родов, дальше — большие, чтобы родня не уезжала за чужие роды.
 */
function orderClans<T>(
  clans: T[],
  contour: (clan: T) => Contour,
  size: (clan: T) => number,
  neighbors: (clan: T) => Neighbor<T>[],
): T[] {
  const graph = new Map<T, Neighbor<T>[]>(clans.map((c) => [c, []]));
  for (const clan of clans)
    for (const n of neighbors(clan)) {
      graph.get(clan)!.push(n);
      graph.get(n.clan)!.push({ clan, at: n.back, back: n.at });
    }
  const middle = (clan: T) => {
    const spans = [...contour(clan).values()];
    return (Math.min(...spans.map(([lo]) => lo)) + Math.max(...spans.map(([, hi]) => hi))) / 2;
  };

  const result: T[] = [];
  const seen = new Set<T>();
  // Сколько людей в ветке родов за соседом (если идти от clan).
  const branch = (clan: T, from: Set<T>): number => {
    from.add(clan);
    return graph.get(clan)!.reduce((s, n) => (from.has(n.clan) ? s : s + branch(n.clan, from)), size(clan));
  };
  // side — с какой стороны от рода, через который мы сюда пришли, стоит этот род: его
  // остальные соседи уходят туда же, наружу, и не вклиниваются между ними.
  const visit = (clan: T, side?: 'left' | 'right') => {
    seen.add(clan);
    const near = new Map<T, number>();
    for (const n of graph.get(clan)!) if (!seen.has(n.clan) && !near.has(n.clan)) near.set(n.clan, n.at);
    const weight = new Map([...near.keys()].map((n) => [n, branch(n, new Set(seen))]));
    const mid = middle(clan);
    const toLeft = ([, at]: [T, number]) => (side ? side === 'left' : at < mid);
    const left = [...near].filter(toLeft).sort((a, b) => weight.get(b[0])! - weight.get(a[0])!);
    const right = [...near].filter((n) => !toLeft(n)).sort((a, b) => weight.get(a[0])! - weight.get(b[0])!);
    for (const [n] of left) if (!seen.has(n)) visit(n, 'left');
    result.push(clan);
    for (const [n] of right) if (!seen.has(n)) visit(n, 'right');
  };
  for (const clan of [...clans].sort((a, b) => size(b) - size(a))) if (!seen.has(clan)) visit(clan);
  return result;
}

/** Насколько сдвинуть правый контур, чтобы в каждом общем ряду он стоял не ближе gap к левому. */
function separation(left: Contour, right: Contour, gap: (row: number) => number): number {
  let x = -Infinity;
  for (const [row, [lo]] of right) {
    const have = left.get(row);
    if (have) x = Math.max(x, have[1] + gap(row) - lo);
  }
  return x === -Infinity ? 0 : x;
}

function merge(into: Contour, add: Contour, dx: number) {
  for (const [row, [lo, hi]] of add) {
    const have = into.get(row);
    into.set(row, have ? [Math.min(have[0], lo + dx), Math.max(have[1], hi + dx)] : [lo + dx, hi + dx]);
  }
}
