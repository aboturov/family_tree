import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layoutClans } from '../src/tree/clans.ts';
import { CARD } from '../src/tree/geometry.ts';
import { layoutTree } from '../src/tree/layout.ts';
import { FAMILY_HUES, familyHues, isLineageEdge, lineage } from '../src/tree/lines.ts';
import { indexTree, type Family, type Person, type Tree } from '../src/tree/model.ts';

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

// Дед и бабка (1+2) с тремя детьми, у каждого ребёнка своя семья с детьми: три брака в одном ряду.
const tree: Tree = {
  persons: [1, 3, 5, 7, 9, 11].map((id) => person(id, 'M')).concat([2, 4, 6, 8, 10, 12, 13].map((id) => person(id, 'F'))),
  families: [
    family(1, [1, 2], [3, 5, 7]),
    family(2, [3, 4], [9]),
    family(3, [5, 6], [10, 11]),
    family(4, [7, 8], [12, 13]),
  ],
};

describe('оттенки линий', async () => {
  const layout = await layoutTree(tree);

  it('у каждого брака с детьми — оттенок, соседние в ряду различаются', () => {
    const hues = familyHues(layout);
    assert.deepEqual([...hues.keys()].sort(), [1, 2, 3, 4]);
    const row = layout.unions
      .filter((u) => u.stem && u.familyId !== 1)
      .sort((a, b) => a.stem!.x - b.stem!.x)
      .map((u) => hues.get(u.familyId)!);
    assert.equal(row.length, 3);
    for (let i = 1; i < row.length; i++) assert.notEqual(row[i], row[i - 1]);
    for (const h of hues.values()) assert.ok(h >= 0 && h < FAMILY_HUES);
  });

  it('у каждой линии записано, от какого брака и к какому ребёнку она идёт', () => {
    for (const edge of layout.edges) assert.equal(edge.id, `f${edge.familyId}-p${edge.childId}`);
    for (const edge of layoutClans(tree).edges) assert.match(edge.id, new RegExp(`^f${edge.familyId}-[pr]${edge.childId}$`));
  });
});

describe('род выбранного человека', () => {
  const index = indexTree(tree);
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

  it('вверх — предки, вниз — потомки, без братьев, дядь и двоюродных', () => {
    // 10 — внук 1+2 через сына 5 и его жену 6.
    const l = lineage(index, 10);
    assert.deepEqual(sorted(l.blood), [1, 2, 5, 6, 10]);
    assert.deepEqual(sorted(l.families), [1, 3]);
    assert.ok(isLineageEdge(l, { familyId: 1, childId: 5 }), 'от деда к отцу');
    assert.ok(isLineageEdge(l, { familyId: 3, childId: 10 }), 'от родителей к нему');
    assert.ok(!isLineageEdge(l, { familyId: 1, childId: 3 }), 'к дяде — нет');
    assert.ok(!isLineageEdge(l, { familyId: 3, childId: 11 }), 'к брату — нет');
    assert.ok(!isLineageEdge(l, { familyId: 2, childId: 9 }), 'к двоюродному — нет');
  });

  it('от старшего — все потомки и их браки; супруги в этих браках не приглушаются, но не род', () => {
    const l = lineage(index, 1);
    assert.deepEqual(sorted(l.blood), [1, 3, 5, 7, 9, 10, 11, 12, 13]);
    assert.deepEqual(sorted(l.families), [1, 2, 3, 4]);
    assert.deepEqual(sorted(l.people), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.ok(!l.blood.has(2) && !l.blood.has(6), 'жена и невестка — не кровь');
  });

  it('человек в середине: родители и дети, жена не приглушается, её родня — да', () => {
    const l = lineage(index, 5);
    assert.deepEqual(sorted(l.blood), [1, 2, 5, 10, 11]);
    assert.deepEqual(sorted(l.people), [1, 2, 5, 6, 10, 11]);
  });
});

describe('промежутки между рядами', () => {
  it('во «Всём дереве» ряды дальше друг от друга', async () => {
    const gap = (layout: Awaited<ReturnType<typeof layoutTree>>) => {
      const rows = [...new Set(layout.persons.map((p) => p.y))].sort((a, b) => a - b);
      return rows[1] - rows[0] - CARD.height;
    };
    const compact = await layoutTree(tree);
    const wide = await layoutTree(tree, 'compact', null, undefined, undefined, { spacing: 'wide' });
    assert.ok(gap(wide) > gap(compact) + 20, `${gap(wide)} против ${gap(compact)}`);
  });
});
