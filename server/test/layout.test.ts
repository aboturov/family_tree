import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { layoutTree } from '../../web/src/tree/layout.ts';
import { indexTree, type Family, type Person, type Tree } from '../../web/src/tree/model.ts';
import { selectView } from '../../web/src/tree/views.ts';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { createLayoutService, type LayoutService } from '../src/layouts.ts';
import { createPrecompute } from '../src/precompute.ts';
import { getTree } from '../src/tree.ts';
import { createViewStats } from '../src/viewStats.ts';
import { createUser, setPassword, setUserPerson } from '../src/users.ts';

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

// Дед и бабка с тремя детьми, у двоих свои семьи; у жены сына — свои родители.
const men = [1, 3, 5, 8, 9, 11];
const tree: Tree = {
  persons: Array.from({ length: 13 }, (_, i) => person(i + 1, men.includes(i + 1) ? 'M' : 'F')),
  families: [
    family(1, [1, 2], [3, 5, 7]),
    family(2, [3, 4], [9, 10]),
    family(3, [5, 6], [12]),
    family(4, [11, 13], [4]),
    family(5, [8, 7]),
  ],
};
const view = { tree, algorithm: 'layered', spacing: 'wide', untangle: true, style: 'compact', centerId: 9 } as const;

describe('POST /api/layout', () => {
  let dir: string;
  let layouts: LayoutService;
  let app: ReturnType<typeof createApp>;
  let cookie: string;

  const post = (body: unknown, headers: Record<string, string> = { cookie }) =>
    app.request('/api/layout', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layouts-'));
    const db = openDb(':memory:');
    layouts = createLayoutService({ cacheFile: path.join(dir, 'layouts.db'), threads: 2 });
    app = createApp({ db, mediaDir: dir, secureCookies: false, sessionTtlDays: 30, layouts });
    // Раскладку смотрят все, не только редакторы.
    const user = await createUser(db, 'babushka', 'viewer', 'temp-password');
    await setPassword(db, user.id, 'long-password', { temporary: false });
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'babushka', password: 'long-password' }),
    });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  });

  after(async () => {
    await layouts.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('та же раскладка, что и в браузере, — зёрна считаются в потоках', async () => {
    const res = await post(view);
    assert.equal(res.status, 200);
    const expected = await layoutTree(tree, 'compact', 9, undefined, undefined, { spacing: 'wide', untangle: true });
    assert.deepEqual((await res.json()).layout, expected);
  });

  it('повторный запрос — из кэша; одновременные одинаковые считаются один раз', async () => {
    const before = layouts.computed();
    assert.equal((await post(view)).status, 200);
    assert.equal(layouts.computed(), before, 'тот же вид — без расчёта');

    const other = { ...view, style: 'bridges' };
    const [a, b] = await Promise.all([post(other), post(other)]);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(layouts.computed(), before + 1);
  });

  it('кэш переживает перезапуск сервера: лежит в своей базе', async () => {
    const again = createLayoutService({ cacheFile: path.join(dir, 'layouts.db'), threads: 1 });
    try {
      const layout = await again.layout(view);
      assert.equal(again.computed(), 0);
      assert.deepEqual(layout, await layoutTree(tree, 'compact', 9, undefined, undefined, { spacing: 'wide', untangle: true }));
    } finally {
      await again.close();
    }
  });

  it('раскладку «с памятью» после правки считают заново и в общий кэш не кладут', async () => {
    const previous = (await layoutTree(tree, 'compact', 9)).persons.map((p) => [p.id, p.x]);
    const before = layouts.computed();
    for (let i = 0; i < 2; i++) assert.equal((await post({ ...view, untangle: false, spacing: 'compact', previous })).status, 200);
    assert.equal(layouts.computed(), before + 2);
  });

  it('«По родам» — тоже на сервере', async () => {
    const res = await post({ ...view, algorithm: 'clans' });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).layout.persons.length === tree.persons.length);
  });

  it('без входа — 401, чепуха в запросе — 400', async () => {
    assert.equal((await post(view, {})).status, 401);
    for (const bad of [
      { ...view, algorithm: 'spiral' },
      { ...view, centerId: 'я' },
      { ...view, tree: { persons: [] } },
      { ...view, tree: { ...tree, families: [family(9, [1, 99], [])] } },
      { ...view, previous: [[1, 'x']] },
    ])
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  });
});

describe('фоновый пересчёт после правок', () => {
  // Сервер с пользователем max, привязанным к «Максиму», и дерево из API — как у браузера.
  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompute-'));
    const db = openDb(':memory:');
    const layouts = createLayoutService({ cacheFile: path.join(dir, 'layouts.db'), threads: 2 });
    const stats = createViewStats({ file: path.join(dir, 'layouts.db') });
    const precompute = createPrecompute({ db, layouts, delayMs: 0, stats });
    const app = createApp({ db, mediaDir: dir, secureCookies: false, sessionTtlDays: 30, layouts, onChange: precompute.schedule, stats });
    const { id: me } = db.prepare("INSERT INTO persons (given_name, sex) VALUES ('Максим', 'M') RETURNING id").get() as { id: number };
    const user = await createUser(db, 'max', 'editor', 'temp-password');
    await setPassword(db, user.id, 'long-password', { temporary: false });
    setUserPerson(db, user.id, me);
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'max', password: 'long-password' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const call = (method: string, url: string, body?: unknown) =>
      app.request(url, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const tree = async () => (await (await call('GET', '/api/tree')).json()) as Tree;
    const add = async (anchor: number, relation: string, givenName: string, sex: string) => {
      const version = (await tree()).persons.find((p) => p.id === anchor)!.version;
      const res = await call('POST', `/api/persons/${anchor}/relatives`, { relation, version, person: { givenName, sex } });
      const text = await res.text();
      assert.equal(res.status, 201, text);
      return (JSON.parse(text) as { id: number }).id;
    };
    const close = async () => {
      precompute.stop();
      stats.close();
      await layouts.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { layouts, precompute, call, tree, add, me, close };
  }

  it('виды пользователя считаются заранее — запрос браузера берёт их из кэша', async () => {
    const { layouts, precompute, call, tree, add, me, close } = await setup();
    try {
      // Правки через API: родители, брат, жена — каждая назначает пересчёт.
      for (const [relation, givenName, sex] of [
        ['parent', 'Сергей', 'M'],
        ['parent', 'Елена', 'F'],
        ['sibling', 'Антон', 'M'],
        ['spouse', 'Алина', 'F'],
      ] as const)
        await add(me, relation, givenName, sex);
      await precompute.settled();
      const computed = layouts.computed();
      assert.ok(computed > 0, 'пересчёт был');

      // Как TreePage: «Всё дерево» — дерево целиком, «Семья» — вид вокруг центра.
      const full = await tree();
      const views = [
        { tree: full, algorithm: 'layered', spacing: 'wide', untangle: true, style: 'bridges', centerId: me },
        { tree: selectView(full, indexTree(full), 'family', me, 2), algorithm: 'layered', spacing: 'compact', untangle: false, style: 'compact', centerId: me },
        { tree: full, algorithm: 'clans', spacing: 'compact', untangle: false, style: 'compact', centerId: me },
      ];
      for (const view of views) assert.equal((await call('POST', '/api/layout', view)).status, 200);
      assert.equal(layouts.computed(), computed, 'всё взято из кэша');
    } finally {
      await close();
    }
  });

  it('часто открываемый вид — «Всё дерево от бабушки» — тоже считается заранее', async () => {
    const { layouts, precompute, call, tree, add, me, close } = await setup();
    try {
      const father = await add(me, 'parent', 'Сергей', 'M');
      const granny = await add(father, 'parent', 'Вера', 'F');
      await precompute.settled();
      const fromGranny = async () => ({
        tree: await tree(),
        algorithm: 'layered',
        spacing: 'wide',
        untangle: true,
        style: 'compact',
        centerId: granny,
        view: { mode: 'all', depth: 2 },
      });
      // Вид бабушки — не вид пользователя: его открывают, и сервер это считает.
      for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/layout', await fromGranny())).status, 200);

      await add(me, 'sibling', 'Антон', 'M');
      await precompute.settled();
      const computed = layouts.computed();
      assert.equal((await call('POST', '/api/layout', await fromGranny())).status, 200);
      assert.equal(layouts.computed(), computed, 'после правки вид бабушки уже посчитан');
    } finally {
      await close();
    }
  });
});

describe('правки не через сервер (tree-admin)', () => {
  it('привязали пользователя к человеку из консоли — его виды считаются без правок и перезапуска', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
    const file = path.join(dir, 'tree.db');
    const db = openDb(file);
    const layouts = createLayoutService({ cacheFile: path.join(dir, 'layouts.db'), threads: 2 });
    const precompute = createPrecompute({ db, layouts, delayMs: 0, watchMs: 10 });
    try {
      const add = (name: string, sex: string) =>
        (db.prepare('INSERT INTO persons (given_name, sex) VALUES (?, ?) RETURNING id').get(name, sex) as { id: number }).id;
      const [father, mother, son] = [add('Отец', 'M'), add('Мать', 'F'), add('Сын', 'M')];
      const { id: familyId } = db.prepare('INSERT INTO families (partner1_id, partner2_id) VALUES (?, ?) RETURNING id').get(father, mother) as {
        id: number;
      };
      db.prepare('INSERT INTO family_children (family_id, child_id) VALUES (?, ?)').run(familyId, son);
      const user = await createUser(db, 'syn', 'viewer', 'temp-password');

      // tree-admin user:link — другое подключение к той же базе.
      const admin = new DatabaseSync(file);
      admin.prepare('UPDATE users SET person_id = ? WHERE id = ?').run(son, user.id);
      admin.close();

      const view = { tree: getTree(db), algorithm: 'layered', spacing: 'wide', untangle: true, style: 'compact', centerId: son } as const;
      for (let i = 0; i < 100 && layouts.computed() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      await precompute.settled();
      const computed = layouts.computed();
      assert.ok(computed > 0, 'сервер заметил привязку и посчитал виды');
      await layouts.layout(view);
      assert.equal(layouts.computed(), computed, '«Всё дерево» от нового пользователя уже в кэше');
    } finally {
      precompute.stop();
      await layouts.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
