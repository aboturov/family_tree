import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bloodKinship, computeKinship, genitive } from '../src/tree/kinship.ts';
import { indexTree, type Family, type Person, type Tree } from '../src/tree/model.ts';
import { RELATIVES_DEPTHS, selectView } from '../src/tree/views.ts';
import { familySides } from '../src/tree/layout.ts';

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
const family = (id: number, partners: [number | null, number | null], children: number[]): Family => ({
  id,
  version: 1,
  partners,
  children: children.map((c) => ({ id: c, relation: 'birth' })),
  events: [],
});

//            1 дед ═ 2 бабушка
//          ┌──────┴───────┐
//   3 отец ═ 4 мать    5 тётя ═ 6 её муж
//     ┌────┴────┐          │
//  7 центр ═ 8 жена  9 сестра   10 двоюродный брат
//     │                   │
//  11 сын ═ 12 невестка 13 племянница
//  14 тесть ═ 15 тёща → 8
const tree: Tree = {
  persons: [
    person(1, 'M'),
    person(2, 'F'),
    person(3, 'M'),
    person(4, 'F'),
    person(5, 'F'),
    person(6, 'M'),
    person(7, 'M'),
    person(8, 'F'),
    person(9, 'F'),
    person(10, 'M'),
    person(11, 'M'),
    person(12, 'F'),
    person(13, 'F'),
    person(14, 'M'),
    person(15, 'F'),
    person(16, 'F'),
  ],
  families: [
    family(1, [1, 2], [3, 5]),
    family(2, [3, 4], [7, 9]),
    family(3, [6, 5], [10]),
    family(4, [7, 8], [11]),
    family(5, [11, 12], []),
    family(6, [null, 9], [13]),
    family(7, [14, 15], [8]),
    family(8, [1, 16], []),
  ],
};
const index = indexTree(tree);

describe('computeKinship', () => {
  const labels = (center: number) => {
    const kin = computeKinship(index, center);
    return Object.fromEntries([...kin].map(([id, k]) => [id, k.label]));
  };

  it('от центра 7', () => {
    assert.deepEqual(labels(7), {
      1: 'Дедушка',
      2: 'Бабушка',
      3: 'Отец',
      4: 'Мать',
      5: 'Тётя',
      6: 'Дядя',
      7: 'Центр',
      8: 'Жена',
      9: 'Сестра',
      10: 'Двоюродный брат',
      11: 'Сын',
      12: 'Сноха',
      13: 'Племянница',
      14: 'Тесть',
      15: 'Тёща',
      16: 'Жена дедушки',
    });
  });

  it('при перестройке от другого человека бейджи меняются', () => {
    const fromGrandma = labels(2);
    assert.equal(fromGrandma[1], 'Муж');
    assert.equal(fromGrandma[7], 'Внук');
    assert.equal(fromGrandma[11], 'Правнук');
    assert.equal(fromGrandma[10], 'Внук');

    const fromWife = labels(8);
    assert.equal(fromWife[7], 'Муж');
    assert.equal(fromWife[3], 'Свёкор');
    assert.equal(fromWife[9], 'Золовка');
    assert.equal(fromWife[14], 'Отец');
  });

  it('супруги родни старших поколений зовутся так же, своего пола', () => {
    // 1 ═ 2 — прадеды центра 9; их дочь 3 — двоюродная бабушка, её муж 4;
    // их сын 10 — двоюродный дядя, его жена 11.
    const tree: Tree = {
      persons: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id) => person(id, [2, 3, 6, 8, 11].includes(id) ? 'F' : 'M')),
      families: [
        family(1, [1, 2], [3, 5]),
        family(2, [4, 3], [10]),
        family(3, [5, 6], [7]),
        family(4, [7, 8], [9]),
        family(5, [10, 11], []),
      ],
    };
    const kin = computeKinship(indexTree(tree), 9);
    assert.equal(kin.get(3)!.label, 'Двоюродная бабушка');
    assert.equal(kin.get(4)!.label, 'Двоюродный дедушка');
    assert.equal(kin.get(10)!.label, 'Двоюродный дядя');
    assert.equal(kin.get(11)!.label, 'Двоюродная тётя');
  });

  it('дальние предки и кузены', () => {
    const m = person(99, 'M');
    const f = person(98, 'F');
    assert.equal(bloodKinship(m, 4, 0).label, 'Прапрадедушка');
    assert.equal(bloodKinship(f, 5, 0).label, 'Пра(3)бабушка');
    assert.equal(bloodKinship(f, 5, 0).tone, 'far');
    assert.equal(bloodKinship(m, 3, 3).label, 'Троюродный брат');
    assert.equal(bloodKinship(f, 3, 2).label, 'Двоюродная тётя');
    assert.equal(bloodKinship(m, 2, 3).label, 'Двоюродный племянник');
    assert.equal(bloodKinship(m, 3, 1).label, 'Двоюродный дедушка');
    assert.equal(bloodKinship(f, 1, 3).label, 'Внучатая племянница');
    assert.equal(bloodKinship(m, 0, 3).label, 'Правнук');
  });
});

describe('таблица из docs/kinship.md', () => {
  const m = person(100, 'M');
  const f = person(101, 'F');
  const rows: [Person, number, number, string][] = [
    [m, 1, 0, 'Отец'],
    [f, 2, 0, 'Бабушка'],
    [m, 3, 0, 'Прадедушка'],
    [f, 4, 0, 'Прапрабабушка'],
    [m, 5, 0, 'Пра(3)дедушка'],
    [m, 0, 1, 'Сын'],
    [f, 0, 2, 'Внучка'],
    [m, 0, 3, 'Правнук'],
    [f, 0, 4, 'Праправнучка'],
    [m, 1, 1, 'Брат'],
    [f, 2, 1, 'Тётя'],
    [m, 3, 1, 'Двоюродный дедушка'],
    [f, 4, 1, 'Двоюродная прабабушка'],
    [m, 1, 2, 'Племянник'],
    [f, 1, 3, 'Внучатая племянница'],
    [m, 1, 4, 'Правнучатый племянник'],
    [f, 2, 2, 'Двоюродная сестра'],
    [m, 3, 3, 'Троюродный брат'],
    [m, 3, 2, 'Двоюродный дядя'],
    [f, 4, 2, 'Троюродная бабушка'],
    [m, 2, 3, 'Двоюродный племянник'],
    [f, 2, 4, 'Внучатая двоюродная племянница'],
    [m, 4, 3, 'Троюродный дядя'],
  ];
  for (const [p, up, down, label] of rows) {
    it(`↑${up} ↓${down}: ${label}`, () => assert.equal(bloodKinship(p, up, down).label, label));
  }

  it('родительный падеж для описательных подписей', () => {
    assert.equal(genitive('Двоюродный брат'), 'двоюродного брата');
    assert.equal(genitive('Внучка'), 'внучки');
    assert.equal(genitive('Двоюродная сестра'), 'двоюродной сестры');
    assert.equal(genitive('Племянница'), 'племянницы');
    assert.equal(genitive('Дедушка'), 'дедушки');
    assert.equal(genitive('Внучатый племянник'), 'внучатого племянника');
  });
});

describe('свойство и неполнородные', () => {
  //  1 ═ 2        3 (второй муж 2)       20 ═ 21
  //    │        ┌───┴───┐                    │
  //    4      5 (единоутробный)            22 (сестра жены) ═ 23
  //  4 ═ 6 (жена);  6 — дочь 20 и 21; у 6 от прошлого брака с 24 — сын 25
  //  4 и 6 — сын 7 ═ 8; 8 — дочь 9 ═ 10
  const tree: Tree = {
    persons: [
      person(1, 'M'),
      person(2, 'F'),
      person(3, 'M'),
      person(4, 'M'),
      person(5, 'M'),
      person(6, 'F'),
      person(7, 'M'),
      person(8, 'F'),
      person(9, 'M'),
      person(10, 'F'),
      person(11, 'M'),
      person(12, 'F'),
      person(20, 'M'),
      person(21, 'F'),
      person(22, 'F'),
      person(23, 'M'),
      person(24, 'M'),
      person(25, 'M'),
    ],
    families: [
      family(1, [1, 2], [4]),
      family(2, [3, 2], [5]),
      family(3, [4, 6], [7]),
      family(4, [20, 21], [6, 22]),
      family(5, [23, 22], []),
      family(6, [24, 6], [25]),
      family(7, [7, 8], []),
      family(8, [9, 10], [8]),
      family(9, [11, 12], [13]),
      family(10, [1, 12], []),
    ],
  };
  tree.persons.push(person(13, 'F'));
  const kin = computeKinship(indexTree(tree), 4);

  it('единоутробный брат, отчим', () => {
    assert.equal(kin.get(5)!.label, 'Единоутробный брат');
    assert.equal(kin.get(3)!.label, 'Отчим');
  });
  it('свояк, пасынок, сноха, сваты', () => {
    assert.equal(kin.get(23)!.label, 'Свояк');
    assert.equal(kin.get(25)!.label, 'Пасынок');
    assert.equal(kin.get(8)!.label, 'Сноха');
    assert.equal(kin.get(9)!.label, 'Сват');
    assert.equal(kin.get(10)!.label, 'Сватья');
  });
  it('сводная сестра — дочь мачехи от другого брака', () => {
    assert.equal(kin.get(12)!.label, 'Мачеха');
    assert.equal(kin.get(13)!.label, 'Сводная сестра');
  });
});

describe('selectView', () => {
  const ids = (t: Tree) => t.persons.map((p) => p.id).sort((a, b) => a - b);

  it('«семья»: прямые предки, братья-сёстры, супруги и потомки — без двоюродных', () => {
    assert.deepEqual(ids(selectView(tree, index, 'family', 7, 0)), [1, 2, 3, 4, 7, 8, 9, 11, 12]);
  });

  it('«родня» от дедушек добавляет тётю, её мужа и двоюродного брата', () => {
    const view = ids(selectView(tree, index, 'relatives', 7, 2));
    for (const id of [5, 6, 10, 13]) assert.ok(view.includes(id), `${id} в родне`);
    assert.ok(!view.includes(14), 'родители жены — не кровная родня');
  });

  it('«родня» не меньше «семьи»', () => {
    const family = ids(selectView(tree, index, 'family', 7, 0));
    for (const { depth } of RELATIVES_DEPTHS) {
      const relatives = ids(selectView(tree, index, 'relatives', 7, depth));
      for (const id of family) assert.ok(relatives.includes(id), `${id} есть в «родне» до ${depth}`);
    }
  });

  it('«семья» — с единокровными и единоутробными, их вторым родителем, но без их детей', () => {
    // Отец 1 и мать 2 — родители центра 3. У отца от второй жены 4 дочь 5 (замужем за 6,
    // сын 7), у матери от второго мужа 8 сын 9.
    const halves: Tree = {
      persons: [1, 3, 6, 7, 8, 9].map((id) => person(id, 'M')).concat([2, 4, 5].map((id) => person(id, 'F'))),
      families: [family(1, [1, 2], [3]), family(2, [1, 4], [5]), family(3, [6, 5], [7]), family(4, [8, 2], [9])],
    };
    const halvesIndex = indexTree(halves);
    assert.deepEqual(ids(selectView(halves, halvesIndex, 'family', 3, 0)), [1, 2, 3, 4, 5, 6, 8, 9]);
    assert.ok(ids(selectView(halves, halvesIndex, 'relatives', 3, 2)).includes(7), 'племянник — в «родне»');
  });

  it('семьи в виде ссылаются только на показанных людей', () => {
    const view = selectView(tree, index, 'family', 7, 0);
    const shown = new Set(view.persons.map((p) => p.id));
    for (const f of view.families) {
      for (const p of f.partners) if (p !== null) assert.ok(shown.has(p));
      for (const c of f.children) assert.ok(shown.has(c.id));
    }
  });
});

describe('расшифровки неочевидных терминов', () => {
  const m = person(100, 'M');
  it('кровная родня — из того же пути, что и термин', () => {
    const hint = (up: number, down: number) => bloodKinship(m, up, down).hint;
    assert.equal(hint(3, 1), 'брат или сестра дедушки или бабушки');
    assert.equal(hint(4, 2), 'двоюродный брат или сестра дедушки или бабушки');
    assert.equal(hint(2, 3), 'ребёнок двоюродного брата или сестры');
    assert.equal(hint(1, 3), 'внук или внучка брата или сестры');
    assert.equal(hint(2, 2), 'общие дедушка и бабушка');
    assert.equal(hint(3, 3), 'общие прадедушка и прабабушка');
    assert.equal(hint(5, 0), 'предок в 5-м поколении');
  });

  it('у очевидных терминов расшифровки нет', () => {
    for (const [up, down] of [
      [1, 0],
      [2, 0],
      [0, 2],
      [1, 1],
      [2, 1],
      [1, 2],
    ]) {
      assert.equal(bloodKinship(m, up, down).hint, undefined, `↑${up} ↓${down}`);
    }
  });

  it('муж двоюродной бабушки: термин старшего поколения, но расшифровка — кто он на самом деле', () => {
    const tree: Tree = {
      persons: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => person(id, [2, 3, 6, 8].includes(id) ? 'F' : 'M')),
      families: [family(1, [1, 2], [3, 5]), family(2, [4, 3], []), family(3, [5, 6], [7]), family(4, [7, 8], [9])],
    };
    const husband = computeKinship(indexTree(tree), 9).get(4)!;
    assert.equal(husband.label, 'Двоюродный дедушка');
    assert.equal(husband.hint, 'муж двоюродной бабушки');
    assert.equal(husband.termHint, 'брат или сестра дедушки или бабушки');
    assert.equal(husband.viaSpouse, true);
  });
});

describe('familySides', () => {
  it('папина сторона −1, мамина +1, центр и его семья 0, родня жены +2', () => {
    // В общем дереве выше у центра 7 известны только родители отца; добавим маме родителей.
    const withMother: Tree = {
      persons: [...tree.persons, person(30, 'M'), person(31, 'F')],
      families: [...tree.families, family(30, [30, 31], [4])],
    };
    const sides = familySides(withMother, 7);
    for (const id of [1, 2, 5, 6, 10]) assert.equal(sides.get(id), -1, `${id} — папина сторона`);
    for (const id of [30, 31]) assert.equal(sides.get(id), 1, `${id} — мамина сторона`);
    for (const id of [3, 4, 7, 8, 9, 11, 12, 13]) assert.equal(sides.get(id), 0, `${id} — середина`);
    for (const id of [14, 15]) assert.equal(sides.get(id), 2, `${id} — родня жены`);
  });

  it('родня тех, кто вошёл в семью браком, — за краем: жены сына справа, мужа племянницы слева', () => {
    // Сын центра 7 (11) женат на 12 — у неё родители 17+18 и сестра 19. Племянница 13 замужем
    // за 20 — у него родители 21+22. Сами 12 и 20 — в середине, рядом с супругами.
    const withInLaws: Tree = {
      persons: [...tree.persons, ...[30, 17, 20, 21].map((id) => person(id, 'M'))].concat(
        [31, 18, 19, 22].map((id) => person(id, 'F')),
      ),
      families: [
        ...tree.families,
        family(30, [30, 31], [4]),
        family(31, [17, 18], [12, 19]),
        family(32, [20, 13], []),
        family(33, [21, 22], [20]),
      ],
    };
    const sides = familySides(withInLaws, 7);
    for (const id of [11, 12, 13, 20]) assert.equal(sides.get(id), 0, `${id} — середина`);
    for (const id of [14, 15]) assert.equal(sides.get(id), 2, `${id} — родня жены`);
    for (const id of [17, 18, 19]) assert.equal(sides.get(id), 3, `${id} — родня жены сына, дальше родни жены`);
    for (const id of [21, 22]) assert.equal(sides.get(id), -3, `${id} — родня мужа племянницы`);
  });
});
