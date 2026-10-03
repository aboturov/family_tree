import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layoutClans } from '../src/tree/clans.ts';
import { CARD } from '../src/tree/geometry.ts';
import { generationBands, generationLabel } from '../src/tree/generations.ts';
import { countCrossings } from '../src/tree/layout.ts';
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

const ids = (tree: Tree) => tree.persons.map((p) => p.id).sort((a, b) => a - b);

// Два рода, соединённые браком: у мужа (5) родители 1+2 и брат 8, у жены (6) — родители 3+4
// и сестра 7, у сестры с мужем (11) сын 9. У пары 5+6 сын 10.
const joined: Tree = {
  persons: [
    person(1, 'M'),
    person(2, 'F'),
    person(3, 'M'),
    person(4, 'F'),
    person(5, 'M'),
    person(6, 'F'),
    person(7, 'F'),
    person(8, 'M'),
    person(9, 'M'),
    person(10, 'M'),
    person(11, 'M'),
  ],
  families: [
    family(1, [1, 2], [5, 8]),
    family(2, [3, 4], [6, 7]),
    family(3, [5, 6], [10]),
    family(4, [11, 7], [9]),
  ],
};

const born = (p: Person, year: number): Person => ({
  ...p,
  events: [
    { id: p.id, type: 'birth', customType: '', date: { modifier: 'exact', value: String(year) }, dateText: '', place: null, note: '' },
  ],
});

describe('layoutClans', () => {
  const layout = layoutClans(joined);
  const pos = new Map(layout.persons.map((p) => [p.id, p]));

  it('каждый человек — ровно одной карточкой', () => {
    assert.deepEqual(
      layout.persons.map((p) => p.id).sort((a, b) => a - b),
      ids(joined),
    );
  });

  it('роды срастаются: жена встаёт с края пары к своей родне, к ней — обычная линия, без ссылки', () => {
    assert.deepEqual(layout.refs, []);
    assert.deepEqual(layout.portals, []);
    const edges = new Set(layout.edges.map((e) => e.id));
    assert.ok(edges.has('f1-p5'), 'линия от родителей мужа к нему');
    assert.ok(edges.has('f2-p6'), 'линия от родителей жены к ней самой');
    // Её родители слева — и она слева от мужа, хотя обычно муж левее.
    assert.ok(pos.get(3)!.x < pos.get(1)!.x);
    assert.ok(pos.get(6)!.x < pos.get(5)!.x);
  });

  it('линии не пересекаются', () => {
    assert.equal(countCrossings(layout), 0);
  });

  it('у каждого рода своя подпись над верхней парой — и у сросшихся тоже', () => {
    // Роды мужа (1+2) и жены (3+4); муж её сестры (11) — в роду жены, со своей женой.
    assert.deepEqual(
      layout.clans.map((c) => c.personId).sort((a, b) => a - b),
      [1, 3],
    );
    const label = layout.clans.find((c) => c.personId === 1)!;
    assert.equal(label.y, pos.get(1)!.y);
    const [husband, wife] = [pos.get(1)!, pos.get(2)!];
    assert.equal(label.x, (Math.min(husband.x, wife.x) + Math.max(husband.x, wife.x) + CARD.width) / 2);
  });

  it('поколения обоих родов — в общих рядах', () => {
    const y = (id: number) => pos.get(id)!.y;
    assert.equal(y(1), y(3));
    for (const id of [6, 7, 8, 11]) assert.equal(y(id), y(5), `${id} в ряду 5`);
    assert.equal(y(9), y(10));
    assert.ok(y(1) < y(5) && y(5) < y(10));
  });

  it('роды не налезают друг на друга', () => {
    const boxes = [
      ...layout.persons.map((p) => ({ x: p.x, y: p.y, w: CARD.width })),
      ...layout.refs.map((r) => ({ x: r.x, y: r.y, w: CARD.width })),
    ];
    for (const a of boxes)
      for (const b of boxes)
        if (a !== b && a.y === b.y) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x, 'карточки в ряду не перекрываются');
  });
});

describe('layoutClans: где роды не срастаются — ссылка', () => {
  // У мужа (5) старший брат 8 и младший 12: пара посередине, линию к жене (6) от её родителей
  // (3+4) не провести мимо линий к братьям.
  const tree: Tree = {
    persons: [
      person(1, 'M'),
      person(2, 'F'),
      person(3, 'M'),
      person(4, 'F'),
      born(person(8, 'M'), 1950),
      born(person(5, 'M'), 1952),
      born(person(12, 'M'), 1954),
      person(6, 'F'),
      person(10, 'M'),
    ],
    families: [family(1, [1, 2], [8, 5, 12]), family(2, [3, 4], [6]), family(3, [5, 6], [10])],
  };
  const layout = layoutClans(tree);

  it('пара в роду мужа, в семье родителей жены — ссылка, над женой — «↑ родители»', () => {
    assert.deepEqual(
      layout.refs.map(({ personId, familyId, via }) => ({ personId, familyId, via })),
      [{ personId: 6, familyId: 2, via: 5 }],
    );
    assert.deepEqual(
      layout.portals.map((p) => p.personId),
      [6],
    );
    const edges = new Set(layout.edges.map((e) => e.id));
    assert.ok(edges.has('f2-r6'), 'линия от родителей жены к ссылке');
    assert.ok(!edges.has('f2-p6'), 'к самой жене линии от её родителей нет');
    assert.equal(countCrossings(layout), 0);
  });

  it('ссылка — в ряду детей своих родителей, «↑ родители» — над карточкой жены', () => {
    const wife = layout.persons.find((p) => p.id === 6)!;
    assert.equal(layout.refs[0].y, wife.y);
    assert.equal(layout.portals[0].x, wife.x + CARD.width / 2);
    assert.equal(layout.portals[0].y, wife.y);
  });
});

describe('layoutClans: чья связь с родителями остаётся линией', () => {
  it('у кого больше браков: жена с двумя мужьями остаётся в своём роду', () => {
    // Жена (6, родители 3+4, с ней сёстры 14 и 15) замужем за 5 (родители 1+2) и за 12.
    const tree: Tree = {
      persons: [1, 3, 5, 12, 13]
        .map((id) => person(id, 'M'))
        .concat([2, 4].map((id) => person(id, 'F')))
        .concat([born(person(14, 'F'), 1950), born(person(6, 'F'), 1952), born(person(15, 'F'), 1954)]),
      families: [
        family(1, [1, 2], [5]),
        family(2, [3, 4], [14, 6, 15]),
        family(3, [5, 6]),
        family(4, [12, 6], [13]),
      ],
    };
    const layout = layoutClans(tree);
    assert.deepEqual(
      layout.refs.map(({ personId, familyId, via }) => ({ personId, familyId, via })),
      [{ personId: 5, familyId: 1, via: 6 }],
    );
    assert.equal(countCrossings(layout), 0);
  });
  it('у мужа нет родителей в дереве — пара в роду жены, ссылок нет', () => {
    const tree: Tree = {
      persons: [person(3, 'M'), person(4, 'F'), person(5, 'M'), person(6, 'F'), person(10, 'M')],
      families: [family(1, [3, 4], [6]), family(2, [5, 6], [10])],
    };
    const layout = layoutClans(tree);
    assert.deepEqual(layout.refs, []);
    assert.deepEqual(layout.portals, []);
    assert.ok(layout.edges.some((e) => e.id === 'f1-p6'));
  });

  it('две родительские семьи (родная и приёмная): во второй — ссылка «у других родителей»', () => {
    const tree: Tree = {
      persons: [person(1, 'M'), person(2, 'F'), person(3, 'M'), person(4, 'F'), person(5, 'F')],
      families: [family(1, [1, 2], [5]), family(2, [3, 4], [5])],
    };
    const layout = layoutClans(tree);
    assert.deepEqual(
      layout.refs.map(({ personId, familyId, via }) => ({ personId, familyId, via })),
      [{ personId: 5, familyId: 2, via: 5 }],
    );
    assert.equal(layout.persons.filter((p) => p.id === 5).length, 1);
  });

  it('пустое дерево — пустая раскладка', () => {
    const layout = layoutClans({ persons: [], families: [] });
    assert.deepEqual([layout.persons.length, layout.width, layout.height], [0, 0, 0]);
  });

  it('ошибка в данных «сам себе предок» не ломает раскладку', () => {
    const tree: Tree = {
      persons: [person(1, 'M'), person(2, 'F'), person(3, 'M'), person(4, 'F')],
      families: [family(1, [1, 2], [3]), family(2, [3, 4], [1])],
    };
    const layout = layoutClans(tree);
    assert.deepEqual(
      layout.persons.map((p) => p.id).sort((a, b) => a - b),
      ids(tree),
    );
    assert.equal(layout.refs.length, 1);
  });
});

// Родословная на 4 поколения вверх: у каждого предка — оба родителя. Каждый брак сшивает два рода.
describe('layoutClans: родословная', () => {
  let nextId = 1;
  const persons: Person[] = [];
  const families: Family[] = [];
  const ancestry = (childId: number, generations: number) => {
    if (generations === 0) return;
    const father = nextId++;
    const mother = nextId++;
    persons.push(person(father, 'M'), person(mother, 'F'));
    families.push(family(families.length + 1, [father, mother], [childId]));
    ancestry(father, generations - 1);
    ancestry(mother, generations - 1);
  };
  const center = nextId++;
  persons.push(person(center, 'M'));
  ancestry(center, 4);
  const tree: Tree = { persons, families };
  const layout = layoutClans(tree);

  it('все на месте, без пересечений; все роды срослись — ссылок нет', () => {
    assert.deepEqual(
      layout.persons.map((p) => p.id).sort((a, b) => a - b),
      ids(tree),
    );
    assert.equal(countCrossings(layout), 0);
    // Без сращивания жёны с родителями (1 + 2 + 4) висели бы на ссылках: у каждой пары обе
    // родословные уходят вверх, и родня жены встаёт с её края.
    assert.deepEqual(layout.refs, []);
    assert.equal(layout.edges.length, families.length);
  });

  it('пять поколений — пять рядов', () => {
    assert.equal(new Set(layout.persons.map((p) => p.y)).size, 5);
  });
});

describe('поколения', () => {
  it('названия относительно центра', () => {
    assert.equal(generationLabel(0, 'Моё поколение'), 'Моё поколение');
    assert.equal(generationLabel(-1, ''), 'Родители');
    assert.equal(generationLabel(-2, ''), 'Бабушки и дедушки');
    assert.equal(generationLabel(-3, ''), 'Прабабушки и прадедушки');
    assert.equal(generationLabel(-6, ''), 'Предки, 6-е поколение');
    assert.equal(generationLabel(1, ''), 'Дети');
    assert.equal(generationLabel(2, ''), 'Внуки');
    assert.equal(generationLabel(5, ''), 'Потомки, 5-е поколение');
  });

  it('полоса на каждый ряд, полосы идут подряд и накрывают свои карточки', () => {
    const layout = layoutClans(joined);
    const bands = generationBands(layout);
    assert.equal(bands.length, 3);
    bands.forEach((band, i) => {
      assert.ok(band.top < band.y && band.y + CARD.height < band.bottom);
      if (i > 0) assert.equal(band.top, bands[i - 1].bottom);
    });
  });
});
