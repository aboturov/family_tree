import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Layout } from '../src/tree/geometry.ts';
import { layoutSeed, layoutTree } from '../src/tree/layout.ts';
import type { Family, Person, Tree } from '../src/tree/model.ts';
import { pickLayout, SEEDS, type SeedResult } from '../src/tree/seeds.ts';

const person = (id: number, sex: Person['sex']): Person => ({
  id,
  version: 1,
  avatar: null,
  photos: [],
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

// Раскладка-метка: по ширине видно, какую выбрали.
const mark = (width: number): Layout => ({ persons: [], unknowns: [], unions: [], edges: [], refs: [], portals: [], clans: [], width, height: 0 });
const result = (seed: number, free: number, fresh: [number, number], kept?: [number, number]): SeedResult => ({
  seed,
  free,
  fresh: { layout: mark(seed), score: fresh[0], crossings: fresh[1] },
  ...(kept ? { kept: { layout: mark(100 + seed), score: kept[0], crossings: kept[1] } } : {}),
});

describe('pickLayout: лучший итог из зёрен', () => {
  it('меньше оценка — лучше; при равной — зерно, лучшее без центра, потом первое', () => {
    assert.equal(pickLayout([result(0, 30, [12, 10]), result(1, 40, [8, 8]), result(2, 20, [9, 9])]).width, 1);
    assert.equal(pickLayout([result(0, 30, [8, 8]), result(1, 20, [8, 8]), result(2, 20, [8, 8])]).width, 1);
  });

  it('добавленные зёрна при равной оценке не вытесняют прежние — только когда лучше', () => {
    assert.equal(pickLayout([result(3, 30, [8, 8]), result(12, 10, [8, 8])]).width, 3);
    assert.equal(pickLayout([result(3, 30, [8, 8]), result(12, 40, [7, 7])]).width, 12);
  });

  it('не зависит от порядка, в котором пришли итоги', () => {
    const results = [result(0, 30, [8, 8]), result(1, 20, [8, 6]), result(2, 20, [9, 9]), result(3, 20, [8, 8])];
    assert.equal(pickLayout(results).width, 1);
    for (const order of [[3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]])
      assert.equal(pickLayout(order.map((i) => results[i])).width, 1, order.join(','));
  });

  it('после правки прежний порядок остаётся, если в нём не больше чем на одно пересечение больше', () => {
    assert.equal(pickLayout([result(0, 30, [8, 8], [10, 9]), result(1, 20, [9, 9], [12, 12])]).width, 100);
    assert.equal(pickLayout([result(0, 30, [8, 8], [12, 10]), result(1, 20, [9, 9], [14, 12])]).width, 0);
  });
});

describe('layoutTree и зёрна по отдельности', () => {
  // Две семьи родителей и их дети: зёрна дают разные схемы, выбор между ними не тривиален.
  const men = [1, 3, 5, 7, 9, 11, 13, 15];
  const tree: Tree = {
    persons: Array.from({ length: 16 }, (_, i) => person(i + 1, men.includes(i + 1) ? 'M' : 'F')),
    families: [
      family(1, [1, 2], [3, 6, 8]),
      family(2, [5, 4], [9]),
      family(3, [3, 4], [11, 12]),
      family(4, [7, 6], [13, 14]),
      family(5, [15, 16], [7, 10]),
      family(6, [11, 10], []),
    ],
  };
  const options = { spacing: 'wide', untangle: true } as const;

  it('воркеры считают зёрна в любом порядке — итог тот же, что и по очереди', async () => {
    for (const center of [11, 13, null]) {
      const whole = await layoutTree(tree, 'bridges', center, undefined, undefined, options);
      const results: SeedResult[] = [];
      for (let seed = SEEDS.length - 1; seed >= 0; seed--)
        results.push(await layoutSeed(tree, 'bridges', center, seed, undefined, options));
      assert.deepEqual(pickLayout(results), whole, `центр ${center}`);
    }
  });
});
