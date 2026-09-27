import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layoutClans } from '../src/tree/clans.ts';
import { layoutTree } from '../src/tree/layout.ts';
import { layoutSignature } from '../src/tree/signature.ts';
import type { Family, Person, Tree, TreeEvent } from '../src/tree/model.ts';

const event = (id: number, type: string, value?: string): TreeEvent => ({
  id,
  type,
  customType: '',
  date: value ? { modifier: 'exact', value } : null,
  dateText: '',
  place: null,
  note: '',
});

const person = (id: number, sex: Person['sex'], birth?: string): Person => ({
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
  events: birth ? [event(id, 'birth', birth)] : [],
});

const family = (id: number, partners: [number | null, number | null], children: number[], married?: string): Family => ({
  id,
  version: 1,
  partners,
  children: children.map((c) => ({ id: c, relation: 'birth' })),
  events: married ? [event(100 + id, 'marriage', married)] : [],
});

// Два рода, соединённые браком, у отца мужа — второй брак: есть что упорядочивать по датам.
const tree: Tree = {
  persons: [
    person(1, 'M', '1930'),
    person(2, 'F', '1932'),
    person(3, 'F', '1935'),
    person(4, 'M', '1955'),
    person(5, 'M', '1960'),
    person(6, 'M', '1930'),
    person(7, 'F', '1931'),
    person(8, 'F', '1957'),
    person(9, 'F', '1959'),
    person(10, 'M', '1985'),
  ],
  families: [
    family(1, [1, 2], [4], '1953'),
    family(2, [1, 3], [5], '1958'),
    family(3, [6, 7], [8, 9], '1954'),
    family(4, [4, 8], [10], '1980'),
  ],
};

// Всё, что раскладка не читает: имена, биография, места, фото, флаги, прочие события, развод.
const edited: Tree = {
  persons: tree.persons.map((p) => ({
    ...p,
    version: p.version + 1,
    givenName: `Имя ${p.id}`,
    patronymic: 'Отчество',
    surname: 'Фамилия',
    birthSurname: 'Девичья',
    bio: 'Биография',
    isDeceased: true,
    isUncertain: true,
    photos: [{ id: p.id, caption: '', width: 10, height: 10 }],
    avatar: { mediaId: p.id, crop: { x: 0.5, y: 0.5, zoom: 1 } },
    events: [
      ...p.events.map((e) => ({ ...e, place: { name: 'Тверь', lat: null, lon: null }, note: 'заметка' })),
      event(1000 + p.id, 'death', '2020'),
      event(2000 + p.id, 'occupation', '1990'),
    ],
  })),
  families: tree.families.map((f) => ({
    ...f,
    version: f.version + 1,
    children: f.children.map((c) => ({ ...c, relation: 'adopted' })),
    events: [...f.events, event(3000 + f.id, 'divorce', '2000')],
  })),
};

describe('отпечаток раскладки', () => {
  it('правка полей, которые раскладка не читает, не меняет ни отпечаток, ни саму раскладку', async () => {
    assert.equal(layoutSignature(edited), layoutSignature(tree));
    for (const center of [null, 10]) {
      assert.deepEqual(await layoutTree(edited, 'compact', center), await layoutTree(tree, 'compact', center));
    }
    assert.deepEqual(layoutClans(edited), layoutClans(tree));
  });

  it('меняется от того, что раскладка читает', () => {
    const base = layoutSignature(tree);
    const withPerson = (id: number, change: Partial<Person>) => ({
      ...tree,
      persons: tree.persons.map((p) => (p.id === id ? { ...p, ...change } : p)),
    });
    const withFamily = (id: number, change: Partial<Family>) => ({
      ...tree,
      families: tree.families.map((f) => (f.id === id ? { ...f, ...change } : f)),
    });
    const changed: [string, Tree][] = [
      ['дата рождения', withPerson(8, { events: [event(8, 'birth', '1961')] })],
      ['пол', withPerson(10, { sex: 'F' })],
      ['дата брака', withFamily(2, { events: [event(102, 'marriage', '1950')] })],
      ['новый ребёнок', withFamily(4, { children: [...tree.families[3].children, { id: 5, relation: 'birth' }] })],
      ['другой супруг', withFamily(4, { partners: [5, 8] })],
      ['новый человек', { ...tree, persons: [...tree.persons, person(11, 'M')] }],
    ];
    for (const [what, next] of changed) assert.notEqual(layoutSignature(next), base, what);
  });
});
