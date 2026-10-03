import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CARD, countCrossings, familySides, layoutTree, type Layout } from '../src/tree/layout.ts';
import type { Family, Person, Tree } from '../src/tree/model.ts';

const person = (id: number, sex: Person['sex']): Person => ({
  id,
  version: 1,
  avatar: null,
  photos: [],
  documents: [],
  givenName: `P${id}`,
  patronymic: '',
  surname: '',
  birthSurname: '',
  sex,
  isDeceased: false,
  isUncertain: false,
  bio: '',
  events: [],
});

const family = (id: number, partners: [number | null, number | null], children: number[] = []): Family => ({
  id,
  version: 1,
  partners,
  children: children.map((c) => ({ id: c, relation: 'birth' })),
  events: [],
});

// Дед с двумя жёнами; у сына ребёнок от неизвестной матери; дочь замужем;
// отдельно — брак с неизвестной без детей.
const tree: Tree = {
  persons: [
    person(1, 'M'),
    person(2, 'F'),
    person(3, 'F'),
    person(4, 'M'),
    person(5, 'F'),
    person(6, 'M'),
    person(7, 'M'),
    person(8, 'M'),
  ],
  families: [
    family(1, [1, 2], [4]),
    family(2, [1, 3], [5]),
    family(3, [4, null], [7]),
    family(4, [8, null]),
    family(5, [6, 5], []),
  ],
};

describe('layoutTree', async () => {
  const layout = await layoutTree(tree);
  const pos = new Map(layout.persons.map((p) => [p.id, p]));

  it('размещает всех людей', () => {
    assert.equal(layout.persons.length, tree.persons.length);
  });

  it('супруги на одной высоте и рядом', () => {
    for (const [a, b] of [
      [1, 2],
      [1, 3],
      [6, 5],
    ]) {
      assert.equal(pos.get(a)!.y, pos.get(b)!.y);
    }
    // У 1 две жены: он между ними, каждая жена — вплотную к нему.
    const row = [1, 2, 3].map((id) => pos.get(id)!.x).sort((a, b) => a - b);
    assert.equal(row[1], pos.get(1)!.x);
    assert.ok(row[2] - row[0] < 3 * CARD.width + 100);
  });

  it('дети ниже родителей', () => {
    for (const f of tree.families) {
      for (const c of f.children) {
        for (const p of f.partners) if (p !== null) assert.ok(pos.get(c.id)!.y > pos.get(p)!.y, `${c.id} ниже ${p}`);
      }
    }
  });

  it('«?» только у семьи с детьми и неизвестным партнёром', () => {
    assert.deepEqual(
      layout.unknowns.map((u) => u.familyId),
      [3],
    );
    assert.ok(!layout.unions.some((u) => u.familyId === 4), 'брак с неизвестным без детей не рисуется');
  });

  it('линия к каждому ребёнку', () => {
    const expected = tree.families.filter((f) => f.partners.some((p) => p !== null)).flatMap((f) => f.children).length;
    assert.equal(layout.edges.length, expected);
  });
});

// Родословная на 4 поколения вверх от центра: у каждого предка — оба родителя.
// Такое дерево можно нарисовать без пересечений, а стороны отца и матери не должны смешиваться.
describe('layoutTree: родословная', async () => {
  let nextId = 1;
  const persons: Person[] = [];
  const families: Family[] = [];
  const ancestry = (childId: number, generations: number): number[] => {
    if (generations === 0) return [];
    const father = nextId++;
    const mother = nextId++;
    persons.push(person(father, 'M'), person(mother, 'F'));
    families.push(family(families.length + 1, [father, mother], [childId]));
    return [father, mother, ...ancestry(father, generations - 1), ...ancestry(mother, generations - 1)];
  };
  const center = nextId++;
  persons.push(person(center, 'M'));
  ancestry(center, 4);
  const pedigree: Tree = { persons, families };
  const layout = await layoutTree(pedigree);
  const x = new Map(layout.persons.map((p) => [p.id, p.x]));

  it('без пересечений линий', () => {
    const segments = layout.edges.flatMap((e) => e.points.slice(1).map((p, i) => [e.points[i], p] as const));
    let crossings = 0;
    for (const [a1, a2] of segments) {
      for (const [b1, b2] of segments) {
        const aHorizontal = a1.y === a2.y;
        if (aHorizontal === (b1.y === b2.y) || !aHorizontal) continue;
        const [x1, x2] = [Math.min(a1.x, a2.x), Math.max(a1.x, a2.x)];
        const [y1, y2] = [Math.min(b1.y, b2.y), Math.max(b1.y, b2.y)];
        if (b1.x > x1 + 0.5 && b1.x < x2 - 0.5 && a1.y > y1 + 0.5 && a1.y < y2 - 0.5) crossings++;
      }
    }
    assert.equal(crossings, 0);
  });

  it('с центром — то же, и стороны закреплены', async () => {
    const withCenter = await layoutTree(pedigree, 'compact', center);
    const byId = new Map(withCenter.persons.map((p) => [p.id, p]));
    const parentsFamily = pedigree.families.find((f) => f.children.some((c) => c.id === center))!;
    const [father, mother] = parentsFamily.partners as [number, number];
    // Родители отца — левее родителей матери.
    const grand = (parent: number) =>
      pedigree.families.find((f) => f.children.some((c) => c.id === parent))!.partners[0]!;
    assert.ok(byId.get(grand(father))!.x < byId.get(grand(mother))!.x);
  });

  it('в каждом поколении предки отца и предки матери не перемешиваются', () => {
    const parentsFamily = pedigree.families.find((f) => f.children.some((c) => c.id === center))!;
    const [father, mother] = parentsFamily.partners as [number, number];
    // Семьи добавлялись сверху вниз по рекурсии, поэтому одного прохода хватает.
    const sideOf = (root: number) => {
      const ids = new Set([root]);
      for (const f of pedigree.families) {
        if (f.children.some((c) => ids.has(c.id))) for (const p of f.partners) if (p !== null) ids.add(p);
      }
      return ids;
    };
    const [fatherSide, motherSide] = [sideOf(father), sideOf(mother)];
    const rows = new Map<number, { father: number[]; mother: number[] }>();
    for (const p of layout.persons) {
      const row = rows.get(p.y) ?? { father: [], mother: [] };
      if (fatherSide.has(p.id)) row.father.push(p.x);
      if (motherSide.has(p.id)) row.mother.push(p.x);
      rows.set(p.y, row);
    }
    for (const [y, row] of rows) {
      if (!row.father.length || !row.mother.length) continue;
      const separated =
        Math.max(...row.father) < Math.min(...row.mother) || Math.max(...row.mother) < Math.min(...row.father);
      assert.ok(separated, `в ряду y=${y} стороны перемешаны`);
    }
  });
});

const married = (id: number, partners: [number | null, number | null], children: number[], date?: string): Family => ({
  ...family(id, partners, children),
  events: date
    ? [
        {
          id,
          type: 'marriage',
          customType: '',
          details: '',
          date: { modifier: 'exact', value: date },
          dateText: '',
          place: null,
          note: '',
        },
      ]
    : [],
});

// М (1) и три жены с детьми; у второй жены (3) есть бывший муж Х (5) с ребёнком.
const threeWives: Tree = {
  persons: [
    person(1, 'M'),
    person(2, 'F'),
    person(3, 'F'),
    person(4, 'F'),
    person(5, 'M'),
    ...[10, 11, 12, 13].map((id) => person(id, 'M')),
  ],
  families: [
    married(1, [1, 2], [10], '1960'),
    married(2, [1, 3], [11], '1970'),
    married(3, [1, 4], [12], '1980'),
    married(4, [5, 3], [13], '1965'),
  ],
};

describe('layoutTree: три брака с детьми', async () => {
  for (const style of ['compact', 'bridges'] as const) {
    it(`${style}: М ═ Ж1   Х ═ Ж2   Ж3, линии М–Ж2 и М–Ж3 на разных уровнях`, async () => {
      const layout = await layoutTree(threeWives, style);
      const x = new Map(layout.persons.map((p) => [p.id, p.x]));
      const order = [1, 2, 5, 3, 4].map((id) => x.get(id)!);
      assert.deepEqual(
        [...order].sort((a, b) => a - b),
        order,
        'порядок М, Ж1, Х, Ж2, Ж3',
      );

      const union = (familyId: number) => layout.unions.find((u) => u.familyId === familyId)!;
      assert.equal(union(1).kind, 'adjacent');
      assert.equal(union(4).kind, 'adjacent');
      assert.equal(union(2).kind, 'bridge');
      assert.equal(union(3).kind, 'bridge');
      const top = (familyId: number) => Math.min(...union(familyId).path.map((p) => p.y));
      assert.ok(top(3) < top(2), 'длинная линия выше короткой');
      assert.equal(layout.edges.length, 4, 'линия к каждому ребёнку');

      // Линии к детям идут из промежутков между карточками, а не из-под карточек.
      for (const u of layout.unions) {
        assert.ok(u.stem, `у брака ${u.familyId} есть дети`);
        const rowY = u.stem!.to - CARD.height;
        const cards = layout.persons.filter((p) => p.y === rowY).map((p) => [p.x, p.x + CARD.width] as const);
        const underCard = cards.some(([from, to]) => u.stem!.x > from && u.stem!.x < to);
        assert.ok(!underCard, `линия к детям брака ${u.familyId} выходит из-под карточки`);
      }

      // Спуск к детям не пересекает линии браков, лежащие ниже.
      const bridges = layout.unions.filter((u) => u.kind === 'bridge');
      for (const u of bridges) {
        for (const lower of bridges) {
          const lowerY = Math.min(...lower.path.map((p) => p.y));
          if (lower === u || lowerY <= u.stem!.from) continue;
          const xs = lower.path.map((p) => p.x);
          const spans = u.stem!.x > Math.min(...xs) && u.stem!.x < Math.max(...xs);
          assert.ok(!spans, `линия к детям брака ${u.familyId} пересекает линию брака ${lower.familyId}`);
        }
      }

      // Спуски соседних браков не пересекают линии дальних: те лежат выше.
      for (const u of layout.unions.filter((uu) => uu.kind === 'adjacent')) {
        for (const far of bridges) {
          const xs = far.path.map((p) => p.x);
          const crosses = far.path[0].y > u.stem!.from && u.stem!.x > Math.min(...xs) && u.stem!.x < Math.max(...xs);
          assert.ok(!crosses, `спуск брака ${u.familyId} пересекает линию брака ${far.familyId}`);
        }
      }

      // Спуск не попадает на линии соседних браков.
      const adjacentLines = layout.unions.filter((u) => u.kind === 'adjacent').map((u) => u.path);
      for (const u of layout.unions.filter((uu) => uu.kind === 'bridge')) {
        const landX = u.stem!.x;
        for (const line of adjacentLines) {
          const [a, b] = [line[0].x, line[1].x].sort((p, q) => p - q);
          assert.ok(!(landX > a && landX < b), `спуск брака ${u.familyId} попадает на линию другого брака`);
        }
      }
    });
  }
});

describe('layoutTree: стиль браков', () => {
  const twoWives: Tree = {
    persons: [person(1, 'M'), person(2, 'F'), person(3, 'F'), person(10, 'M'), person(11, 'F')],
    families: [married(2, [1, 3], [11], '1980'), married(1, [1, 2], [10], '1970')],
  };

  it('рядом: муж между жёнами, более ранний брак слева', async () => {
    const x = new Map((await layoutTree(twoWives, 'compact')).persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(2)! < x.get(1)! && x.get(1)! < x.get(3)!);
  });

  it('в ряд: муж слева, жёны справа по порядку браков, дальний брак — прямой линией', async () => {
    const layout = await layoutTree(twoWives, 'bridges');
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(1)! < x.get(2)! && x.get(2)! < x.get(3)!);
    const far = layout.unions.find((u) => u.familyId === 2)!;
    assert.equal(far.kind, 'bridge');
    assert.equal(new Set(far.path.map((p) => p.y)).size, 1, 'линия прямая, без дуги вверх');
  });
});

describe('layoutTree: родня — с края того, через кого она связана', () => {
  // У отца (5) два брака: с матерью центра (6) раньше, с мачехой (8) позже. В режиме «рядом»
  // мать стоит левее отца — её родители (3, 4), брат (7) и его сын (12) должны быть слева.
  const parentsTree: Tree = {
    persons: [
      person(1, 'M'),
      person(2, 'F'),
      person(3, 'M'),
      person(4, 'F'),
      person(5, 'M'),
      person(6, 'F'),
      person(7, 'M'),
      person(8, 'F'),
      person(9, 'F'),
      person(10, 'F'),
      person(11, 'F'),
      person(12, 'M'),
    ],
    families: [
      family(1, [1, 2], [5]),
      family(2, [3, 4], [6, 7]),
      married(3, [5, 6], [9], '1970'),
      married(4, [5, 8], [10], '1980'),
      family(5, [7, 11], [12]),
    ],
  };

  it('рядом: мать левее отца — и её родня слева', async () => {
    const layout = await layoutTree(parentsTree, 'compact', 9);
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(6)! < x.get(5)! && x.get(5)! < x.get(8)!, 'мать, отец, мачеха');
    assert.ok(x.get(3)! < x.get(1)!, 'родители матери левее родителей отца');
    assert.ok(x.get(7)! < x.get(6)!, 'брат матери левее неё');
    assert.ok(x.get(12)! < x.get(9)!, 'двоюродный брат левее центра');
    assert.equal(countCrossings(layout), 0);
  });

  it('в ряд: отец левее матери — его родня слева, как обычно', async () => {
    const layout = await layoutTree(parentsTree, 'bridges', 9);
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(5)! < x.get(6)!);
    assert.ok(x.get(1)! < x.get(3)!, 'родители отца левее родителей матери');
  });

  it('рядом: у центра две жены — родня каждой со своего края', async () => {
    // Центр (20) с родителями (27, 28); первая жена (21) слева от него, вторая (22) справа.
    const spousesTree: Tree = {
      persons: [20, 23, 25, 27].map((id) => person(id, 'M')).concat([21, 22, 24, 26, 28].map((id) => person(id, 'F'))),
      families: [
        family(1, [27, 28], [20]),
        married(2, [20, 21], [], '1990'),
        married(3, [20, 22], [], '2000'),
        family(4, [23, 24], [21]),
        family(5, [25, 26], [22]),
      ],
    };
    const layout = await layoutTree(spousesTree, 'compact', 20);
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(21)! < x.get(20)! && x.get(20)! < x.get(22)!);
    // Здесь ELK и сам поставил бы родителей первой жены слева, поэтому проверяем и стороны.
    const sides = familySides(spousesTree, 20, x);
    assert.deepEqual([sides.get(23), sides.get(25)], [-2, 2]);
    assert.ok(x.get(23)! < x.get(27)! && x.get(27)! < x.get(25)!, 'родители первой жены слева, второй — справа');
  });
});

describe('layoutTree: жена в центре без своей родни', () => {
  // Трудный случай: у мужа (3) родители 1+2 и братья 4, 5; у сестры матери (6, муж 7)
  // сын 8 — двоюродный брат мужа. Жена (9) в центре, её родителей в дереве нет.
  const tree: Tree = {
    persons: [
      person(1, 'M'),
      person(2, 'F'),
      person(3, 'M'),
      person(4, 'M'),
      person(5, 'M'),
      person(6, 'F'),
      person(7, 'M'),
      person(8, 'M'),
      person(9, 'F'),
      person(10, 'M'),
      person(11, 'F'),
    ],
    families: [
      family(1, [10, 11], [2, 6]),
      family(2, [1, 2], [4, 5, 3]),
      family(3, [7, 6], [8]),
      family(4, [3, 9]),
    ],
  };

  it('родня мужа не уходит на край: он стоит вплотную к своим братьям', async () => {
    assert.deepEqual([...familySides(tree, 9).values()].filter((side) => side !== 0), []);
    const layout = await layoutTree(tree, 'compact', 9);
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    const [from, to] = [Math.min(x.get(3)!, x.get(4)!, x.get(5)!), Math.max(x.get(3)!, x.get(4)!, x.get(5)!)];
    assert.ok(!(x.get(8)! > from && x.get(8)! < to), 'двоюродный брат не вклинивается между братьями');
    assert.equal(countCrossings(layout), 0);
  });
});

describe('layoutTree: раскладка с памятью', () => {
  it('после добавления человека прежние остаются в своём порядке и пересечений не больше', async () => {
    const before: Tree = {
      persons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id) => person(id, id % 2 ? 'M' : 'F')),
      families: [family(1, [1, 2], [3, 4, 5]), family(2, [3, 6], [7, 8]), family(3, [5, 10], [9, 11])],
    };
    const first = await layoutTree(before, 'compact', 7);
    const after: Tree = {
      persons: [...before.persons, person(12, 'M')],
      families: [...before.families, family(4, [9, null], [12])],
    };
    const previous = new Map(first.persons.map((p) => [p.id, p.x]));
    const second = await layoutTree(after, 'compact', 7, undefined, previous);
    const order = (layout: typeof first, y: number) =>
      layout.persons.filter((p) => p.y === y && p.id !== 12).sort((a, b) => a.x - b.x).map((p) => p.id);
    for (const y of new Set(first.persons.map((p) => p.y))) assert.deepEqual(order(second, y), order(first, y));
    assert.ok(countCrossings(second) <= countCrossings(await layoutTree(after, 'compact', 7)));
  });
});

/**
 * Где в итоговой раскладке нарушен порядок сторон: в каждом ряду стороны блоков (людей,
 * связанных браками) слева направо не убывают. Сторона блока — как в layoutTree: папина и
 * мамина родня вместе — середина, иначе самая дальняя от центра сторона.
 */
function sideInversions(tree: Tree, layout: Layout, centerId: number): string[] {
  const sides = familySides(tree, centerId, new Map(layout.persons.map((p) => [p.id, p.x])));
  const root = new Map(tree.persons.map((p) => [p.id, p.id]));
  const find = (id: number): number => (root.get(id) === id ? id : find(root.get(id)!));
  for (const [a, b] of tree.families.map((f) => f.partners)) if (a !== null && b !== null) root.set(find(a), find(b));

  const blocks = new Map<number, { ids: number[]; x: number; y: number }>();
  for (const p of layout.persons) {
    const block = blocks.get(find(p.id)) ?? { ids: [], x: p.x, y: p.y };
    block.ids.push(p.id);
    block.x = Math.min(block.x, p.x);
    blocks.set(find(p.id), block);
  }
  const sideOf = (ids: number[]) => {
    const values = ids.flatMap((id) => (sides.has(id) ? [sides.get(id)!] : []));
    if (values.includes(-1) && values.includes(1)) return 0;
    return values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
  };
  const rows = new Map<number, { ids: number[]; x: number }[]>();
  for (const b of blocks.values()) rows.set(b.y, [...(rows.get(b.y) ?? []), b]);

  const problems: string[] = [];
  for (const [y, row] of rows) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < row.length; i++) {
      const [left, right] = [row[i].ids, row[i + 1].ids];
      if (sideOf(left) > sideOf(right))
        problems.push(`y=${y}: [${left}] (сторона ${sideOf(left)}) левее [${right}] (сторона ${sideOf(right)})`);
    }
  }
  return problems;
}

describe('layoutTree: порядок сторон в итоговой раскладке', () => {
  // Центр (1) женат на 11; её родители (12, 13) — на правом краю, правее тёти (8, сестры
  // матери) с мужем (9). Если поставить родителей жены между родителями центра и тётей, линии
  // не пересекаются, — так ELK и делал после greedy switch, хотя порядок сторон ему был задан.
  const tree: Tree = {
    persons: [
      person(1, 'M'),
      person(2, 'M'),
      person(3, 'F'),
      person(4, 'M'),
      person(5, 'F'),
      person(6, 'M'),
      person(7, 'F'),
      person(8, 'F'),
      person(9, 'M'),
      person(10, 'F'),
      person(11, 'F'),
      person(12, 'M'),
      person(13, 'F'),
    ],
    families: [
      family(1, [4, 5], [2]),
      family(2, [6, 7], [3, 8]),
      family(3, [9, 8], [10]),
      family(4, [2, 3], [1]),
      family(5, [12, 13], [11]),
      family(6, [1, 11]),
    ],
  };

  for (const style of ['compact', 'bridges'] as const) {
    it(`${style}: ELK не переставляет блоки через границу сторон`, async () => {
      const layout = await layoutTree(tree, style, 1);
      assert.deepEqual(sideInversions(tree, layout, 1), []);
      const x = new Map(layout.persons.map((p) => [p.id, p.x]));
      assert.ok(x.get(8)! < x.get(12)!, 'тётя левее родителей жены');
    });
  }
});

describe('layoutTree: родня невестки не растаскивает родню отца и матери', () => {
  // Центр 1 — жена (муж 2 слева), её родители 3+4, их родители 5+6
  // и 7+8. Сын 9 женат на 10; у 10 родители 11+12, их родители 14+15 и 16+17, прадеды 18+19 и 25
  // — в ряду бабушек и дедушек центра; в каждом поколении у них ещё братья и сёстры. Раньше этот
  // род считался серединой и вставал между родителями отца и матери, а 7+8 уезжали на край.
  const men = [2, 3, 5, 7, 9, 11, 13, 14, 16, 18, 20, 22, 24];
  const tree: Tree = {
    persons: Array.from({ length: 25 }, (_, i) => person(i + 1, men.includes(i + 1) ? 'M' : 'F')),
    families: [
      family(1, [2, 1], [9]),
      family(2, [3, 4], [1]),
      family(3, [5, 6], [3]),
      family(4, [7, 8], [4]),
      family(5, [9, 10]),
      family(6, [11, 12], [10, 13]),
      family(7, [14, 15], [11, 20]),
      family(8, [16, 17], [12, 21, 22]),
      family(9, [18, 19], [14, 23, 24]),
      family(10, [null, 25], [16]),
    ],
  };

  it('родители матери — над ней, род невестки — за краем', async () => {
    const sides = familySides(tree, 1);
    for (const id of [14, 15, 16, 17, 18, 19, 23, 24, 25]) assert.equal(sides.get(id), 3, `${id} — родня невестки`);
    const layout = await layoutTree(tree, 'compact', 1, undefined, undefined, { spacing: 'wide', untangle: true });
    assert.deepEqual(sideInversions(tree, layout, 1), []);
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    for (const id of [18, 25]) assert.ok(x.get(id)! > x.get(8)!, `${id} правее родителей матери`);
    for (const id of [14, 16, 23]) assert.ok(x.get(id)! > x.get(4)!, `${id} правее матери`);
    assert.ok(Math.abs(x.get(7)! - x.get(4)!) < 2 * CARD.width, 'линия от родителей матери к ней короткая');
  });
});

describe('layoutTree: линии рода во «Всём дереве» — прямее', () => {
  // Центр 7 — дочь 5 и 6. У родителей отца (1+2) ещё дочь 8 с мужем 11; у родителей матери
  // (3+4) ещё дочь 9 (муж 12, сын 13) и сын 10 с женой 14 — их линии тянут 3+4 вправо, от матери.
  const men = [1, 3, 5, 10, 11, 12, 13];
  const tree: Tree = {
    persons: Array.from({ length: 14 }, (_, i) => person(i + 1, men.includes(i + 1) ? 'M' : 'F')),
    families: [
      family(1, [1, 2], [8, 5]),
      family(2, [3, 4], [6, 9, 10]),
      family(3, [5, 6], [7]),
      family(4, [11, 8]),
      family(5, [12, 9], [13]),
      family(6, [10, 14]),
    ],
  };

  it('родители матери сдвигаются к ней, длиннее — линии к её брату и сестре', async () => {
    const horizontal = (layout: Layout, id: string) => {
      const { points } = layout.edges.find((e) => e.id === id)!;
      return points.slice(1).reduce((sum, p, i) => sum + (p.y === points[i].y ? Math.abs(p.x - points[i].x) : 0), 0);
    };
    const plain = await layoutTree(tree, 'compact', 7, undefined, undefined, { spacing: 'wide' });
    const all = await layoutTree(tree, 'compact', 7, undefined, undefined, { spacing: 'wide', untangle: true });
    assert.ok(horizontal(all, 'f2-p6') < horizontal(plain, 'f2-p6'), 'к матери — короче');
    assert.equal(horizontal(all, 'f3-p7'), 0, 'к центру — прямо');
    assert.equal(countCrossings(all), 0);
  });
});

describe('layoutTree: перебор зёрен из памяти', () => {
  // Прогоны ELK по зёрнам от центра не зависят: при смене центра берутся из памяти.
  const men = [1, 3, 5, 7, 9, 11];
  const tree: Tree = {
    persons: Array.from({ length: 12 }, (_, i) => person(i + 1, men.includes(i + 1) ? 'M' : 'F')),
    families: [
      family(1, [1, 2], [3, 6]),
      family(2, [3, 4], [7, 8]),
      family(3, [5, 6], [9, 10]),
      family(4, [11, 12], [4]),
    ],
  };
  const options = { spacing: 'wide', untangle: true } as const;

  it('раскладка от центра не зависит от того, что строили до неё', async () => {
    const first = await layoutTree(tree, 'compact', 7, undefined, undefined, options);
    await layoutTree(tree, 'compact', 10, undefined, undefined, options);
    await layoutTree(tree, 'compact', null);
    assert.deepEqual(await layoutTree(tree, 'compact', 7, undefined, undefined, options), first);
  });

  it('без центра отдаётся копия: правка результата не портит следующий', async () => {
    const first = await layoutTree(tree, 'bridges', null);
    const copy = structuredClone(first);
    first.persons[0].x += 1000;
    first.edges.pop();
    assert.deepEqual(await layoutTree(tree, 'bridges', null), copy);
  });
});

describe('layoutTree: пустая сторона', () => {
  // У отца (2) двоюродные по деду (10) и по бабушке (15); у матери (3) родни в дереве нет.
  // Отделять отцовскую родню не от чего — она занимает весь ряд, и родители встают между
  // двоюродными, а не на краю за ними обоими.
  const tree: Tree = {
    persons: [
      person(1, 'M'),
      person(2, 'M'),
      person(3, 'F'),
      person(4, 'M'),
      person(5, 'F'),
      person(6, 'M'),
      person(7, 'F'),
      person(8, 'F'),
      person(9, 'M'),
      person(10, 'M'),
      person(11, 'M'),
      person(12, 'F'),
      person(13, 'F'),
      person(14, 'M'),
      person(15, 'F'),
    ],
    families: [
      family(1, [6, 7], [4, 8]),
      family(2, [9, 8], [10]),
      family(3, [11, 12], [5, 13]),
      family(4, [14, 13], [15]),
      family(5, [4, 5], [2]),
      family(6, [2, 3], [1]),
    ],
  };

  it('сторона родителя без родни не держит место: родня другого — где меньше пересечений', async () => {
    assert.deepEqual([...familySides(tree, 1).values()].filter((side) => side !== 0), []);
    for (const style of ['compact', 'bridges'] as const) {
      const layout = await layoutTree(tree, style, 1);
      const x = new Map(layout.persons.map((p) => [p.id, p.x]));
      assert.ok(x.get(10)! < x.get(2)! && x.get(3)! < x.get(15)!, `${style}: родители между двоюродными отца`);
      assert.equal(countCrossings(layout), 0, style);
    }
  });

  it('когда у матери есть хоть кто-то, стороны снова разделены', async () => {
    const withGrandparents: Tree = {
      persons: [...tree.persons, person(16, 'M'), person(17, 'F')],
      families: [...tree.families, family(7, [16, 17], [3])],
    };
    const sides = familySides(withGrandparents, 1);
    assert.deepEqual([sides.get(15), sides.get(16)], [-1, 1]);
    const layout = await layoutTree(withGrandparents, 'compact', 1);
    assert.deepEqual(sideInversions(withGrandparents, layout, 1), []);
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(15)! < x.get(2)!, 'двоюродная отца — левее родителей');
  });
});

describe('layoutTree: пара крест-накрест («Всё дерево»)', () => {
  // Дед 4 и бабушка 5 — родители отца (2) центра (1). У родителей деда (6+7) он один, у родителей
  // бабушки (8+9) ещё двое детей со своими семьями. Без распутывания ELK ставит родителей бабушки
  // левее, над дедом, а родителей деда — над бабушкой: линии к паре идут крест-накрест.
  const men = [1, 2, 4, 6, 8, 11, 13, 15, 19];
  const tree: Tree = {
    persons: [1, 2, 4, 6, 8, 3, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((id) =>
      person(id, men.includes(id) ? 'M' : 'F'),
    ),
    families: [
      family(1, [2, 3], [1]),
      family(2, [4, 5], [2]),
      family(3, [6, 7], [4]),
      family(4, [8, 9], [5, 10, 11]),
      family(5, [13, 14], [3, 12]),
      family(10, [15, 10], [16]),
      family(11, [11, 17], [18]),
      family(12, [19, 12], [20]),
    ],
  };
  const parentsX = (layout: Awaited<ReturnType<typeof layoutTree>>, id: number) =>
    layout.edges.find((e) => e.childId === id)!.points[0].x;

  it('родители мужа и жены меняются местами, муж остаётся слева', async () => {
    const plain = await layoutTree(tree, 'compact', 1);
    assert.ok(parentsX(plain, 4) > parentsX(plain, 5), 'в фикстуре без распутывания — крест');

    const layout = await layoutTree(tree, 'compact', 1, undefined, undefined, { untangle: true });
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(4)! < x.get(5)!, 'муж слева');
    assert.ok(parentsX(layout, 4) < parentsX(layout, 5), 'родители деда левее родителей бабушки');
    // Крест у пары считается за два обычных пересечения: одно лишнее где-то ещё — допустимая цена.
    assert.ok(countCrossings(layout) <= countCrossings(plain) + 1);
    // Сторона матери на месте — правее пары.
    assert.ok(x.get(13)! > x.get(5)!);
  });

  it('братья и сёстры жены по другую сторону пары — перестановка ставит пару между ветками', async () => {
    // Трудный случай: дед 4 — сын отца-одиночки 1 (ещё сын 6), бабушка 5 — дочь 2+3,
    // у которых ещё трое (7, 8 старше её, 9 младше). ELK ставит родителей бабушки левее, а её
    // старших сестёр — слева от пары. Если просто поменять ветки местами, сёстры разъедутся по обе
    // стороны от пары и их линии пересекут линию к ней — такую перестановку прежде отбрасывали.
    const men = [1, 2, 4, 6, 10, 12, 15, 17, 20, 22, 23, 24, 25];
    const tree: Tree = {
      persons: Array.from({ length: 25 }, (_, i) => person(i + 1, men.includes(i + 1) ? 'M' : 'F')),
      families: [
        family(1, [1, null], [4, 6]),
        family(2, [2, 3], [7, 8, 5, 9]),
        family(3, [4, 5], [10]),
        family(4, [12, 13], [11, 14]),
        family(5, [15, 16], [12]),
        family(6, [17, 18], [13]),
        family(7, [10, 11], [19]),
        family(8, [6, 20], [21]),
        family(9, [22, 7], [23]),
        family(10, [24, 9], [25]),
      ],
    };
    const layout = await layoutTree(tree, 'compact', 19, undefined, undefined, { spacing: 'wide', untangle: true });
    const x = new Map(layout.persons.map((p) => [p.id, p.x]));
    assert.ok(x.get(4)! < x.get(5)!, 'муж слева');
    assert.ok(parentsX(layout, 4) < parentsX(layout, 5), 'отец деда левее родителей бабушки');
    assert.ok(x.get(6)! < x.get(4)!, 'брат деда — слева от пары');
    for (const id of [7, 8, 9]) assert.ok(x.get(id)! > x.get(5)!, `сестра бабушки ${id} — справа от пары`);
    assert.ok(countCrossings(layout) <= 2);
  });
});
