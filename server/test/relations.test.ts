import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb, type Db } from '../src/db.ts';
import { getTree } from '../src/tree.ts';
import { createUser, setPassword, setUserPerson } from '../src/users.ts';

let db: Db;
let mediaDir: string;
let app: ReturnType<typeof createApp>;
let cookie: string;

const call = (method: string, url: string, body: unknown = {}) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const tree = () => getTree(db);
const version = (id: number) => tree().persons.find((p) => p.id === id)!.version;
const familyOf = (childId: number) => tree().families.find((f) => f.children.some((c) => c.id === childId));
const familyVersion = (id: number) => tree().families.find((f) => f.id === id)!.version;

function person(name: string, sex: 'M' | 'F' | 'U') {
  const { id } = db.prepare('INSERT INTO persons (given_name, sex) VALUES (?, ?) RETURNING id').get(name, sex) as {
    id: number;
  };
  return id;
}

const newPerson = (givenName: string, sex: 'M' | 'F' | 'U') => ({ givenName, sex });

async function add(anchor: number, body: Record<string, unknown>, status = 201) {
  const res = await call('POST', `/api/persons/${anchor}/relatives`, { version: version(anchor), ...body });
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return data as { id: number; error: string };
}

beforeEach(async () => {
  db = openDb(':memory:');
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  app = createApp({ db, mediaDir, secureCookies: false, sessionTtlDays: 30 });
  const user = await createUser(db, 'olga', 'editor', 'temp-password');
  await setPassword(db, user.id, 'long-password', { temporary: false });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'olga', password: 'long-password' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

describe('добавление родственников', () => {
  it('родители: отец и мать попадают в одну семью, третий родитель — ошибка', async () => {
    const max = person('Максим', 'M');
    const { id: dad } = await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    const { id: mom } = await add(max, {
      relation: 'parent',
      person: newPerson('Елена', 'F'),
      birth: { modifier: 'exact', value: '1975-03-02' },
    });
    assert.deepEqual(familyOf(max)!.partners, [dad, mom]);
    const momEvents = tree().persons.find((p) => p.id === mom)!.events;
    assert.equal(momEvents[0].date?.value, '1975-03-02');

    const { error } = await add(max, { relation: 'parent', person: newPerson('Ещё', 'M') }, 400);
    assert.match(error, /оба родителя/);
  });

  it('второй отец не встаёт на место матери', async () => {
    const max = person('Максим', 'M');
    await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    const { error } = await add(max, { relation: 'parent', person: newPerson('Пётр', 'M') }, 400);
    assert.match(error, /Отец уже указан/);
  });

  it('супруг и дети: в общую семью или в новую с неизвестным вторым родителем', async () => {
    const max = person('Максим', 'M');
    const { id: wife } = await add(max, { relation: 'spouse', person: newPerson('Анна', 'F') });
    const couple = tree().families.find((f) => f.partners.includes(wife))!;
    assert.deepEqual(couple.partners, [max, wife]);

    const { id: son } = await add(max, { relation: 'child', familyId: couple.id, person: newPerson('Иван', 'M') });
    const { id: daughter } = await add(max, { relation: 'child', familyId: null, person: newPerson('Мария', 'F') });
    assert.equal(familyOf(son)!.id, couple.id);
    assert.deepEqual(familyOf(daughter)!.partners, [max, null]);

    const { error } = await add(max, { relation: 'spouse', existingId: wife }, 400);
    assert.match(error, /уже указаны супругами/);
  });

  it('супруг может стать вторым родителем детей из семьи без него', async () => {
    const anna = person('Анна', 'F');
    const { id: kid } = await add(anna, { relation: 'child', familyId: null, person: newPerson('Иван', 'M') });
    const family = familyOf(kid)!;
    const { id: husband } = await add(anna, { relation: 'spouse', familyId: family.id, person: newPerson('Пётр', 'M') });
    assert.deepEqual(familyOf(kid)!.partners, [husband, anna]);
  });

  it('брат или сестра — только через родителей', async () => {
    const max = person('Максим', 'M');
    const { error } = await add(max, { relation: 'sibling', person: newPerson('Лиза', 'F') }, 400);
    assert.match(error, /родителя/);
    await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    const { id: sister } = await add(max, { relation: 'sibling', person: newPerson('Лиза', 'F') });
    assert.equal(familyOf(sister)!.id, familyOf(max)!.id);
  });

  it('существующий человек: без циклов и без вторых родителей', async () => {
    const max = person('Максим', 'M');
    const { id: son } = await add(max, { relation: 'child', familyId: null, person: newPerson('Иван', 'M') });
    assert.match((await add(max, { relation: 'parent', existingId: son }, 400)).error, /потомок/);
    assert.match((await add(son, { relation: 'child', existingId: max }, 400)).error, /предок/);
    assert.match((await add(max, { relation: 'parent', existingId: max }, 400)).error, /самим собой/);

    const other = person('Пётр', 'M');
    assert.match((await add(other, { relation: 'child', existingId: son }, 400)).error, /уже есть родители/);
  });

  it('родитель, уже состоящий в браке со вторым родителем, объединяет семьи пары', async () => {
    const dad = person('Сергей', 'M');
    const mom = person('Елена', 'F');
    const { id: first } = await add(dad, { relation: 'child', familyId: null, person: newPerson('Максим', 'M') });
    await add(dad, { relation: 'spouse', existingId: mom });
    const couple = tree().families.find((f) => f.partners.includes(mom))!;
    const { id: second } = await add(dad, { relation: 'child', familyId: couple.id, person: newPerson('Лиза', 'F') });

    await add(first, { relation: 'parent', existingId: mom });
    const families = tree().families.filter((f) => f.partners.includes(dad));
    assert.equal(families.length, 1);
    assert.deepEqual(families[0].children.map((c) => c.id).sort(), [first, second].sort());
  });

  it('рождение без года сохраняется текстом', async () => {
    const max = person('Максим', 'M');
    const { id } = await add(max, { relation: 'parent', person: newPerson('Сергей', 'M'), birth: { dateText: '12 марта' } });
    const birth = tree().persons.find((p) => p.id === id)!.events[0];
    assert.deepEqual([birth.type, birth.date, birth.dateText], ['birth', null, '12 марта']);
  });

  it('устаревшая версия карточки — конфликт', async () => {
    const max = person('Максим', 'M');
    const res = await call('POST', `/api/persons/${max}/relatives`, {
      version: 99,
      relation: 'parent',
      person: newPerson('Сергей', 'M'),
    });
    assert.equal(res.status, 409);
  });
});

describe('отвязка, удаление и слияние', () => {
  it('ребёнка можно убрать из семьи; опустевшая семья удаляется', async () => {
    const max = person('Максим', 'M');
    await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    const family = familyOf(max)!;
    assert.equal((await call('DELETE', `/api/families/${family.id}/children/${max}`, { version: 99 })).status, 409);
    const res = await call('DELETE', `/api/families/${family.id}/children/${max}`, {
      version: familyVersion(family.id),
    });
    assert.equal(res.status, 200);
    assert.equal(tree().families.length, 0);
    assert.equal(tree().persons.length, 2);
  });

  it('супруга можно убрать; дети остаются у второго родителя', async () => {
    const max = person('Максим', 'M');
    const { id: wife } = await add(max, { relation: 'spouse', person: newPerson('Анна', 'F') });
    const couple = tree().families.find((f) => f.partners.includes(wife))!;
    const { id: son } = await add(max, { relation: 'child', familyId: couple.id, person: newPerson('Иван', 'M') });
    const res = await call('DELETE', `/api/families/${couple.id}/partners/${wife}`, {
      version: familyVersion(couple.id),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(familyOf(son)!.partners, [max, null]);
  });

  it('удаление человека убирает его связи и фото, но не привязанного к аккаунту', async () => {
    const max = person('Максим', 'M');
    const { id: dad } = await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    db.prepare("INSERT INTO media (id, person_id, width, height) VALUES (7, ?, 10, 10)").run(dad);
    fs.writeFileSync(path.join(mediaDir, '7.jpg'), 'x');
    fs.writeFileSync(path.join(mediaDir, '7-thumb.jpg'), 'x');

    assert.equal((await call('DELETE', `/api/persons/${dad}`, { version: version(dad) })).status, 200);
    assert.deepEqual(tree().persons.map((p) => p.id), [max]);
    assert.equal(tree().families.length, 0);
    // Файлы не стираются, а уходят в корзину — правку можно откатить.
    assert.deepEqual(fs.readdirSync(mediaDir), ['trash']);
    assert.deepEqual(fs.readdirSync(path.join(mediaDir, 'trash')).sort(), [`7-thumb.jpg`, `7.jpg`]);

    setUserPerson(db, 1, max);
    const res = await call('DELETE', `/api/persons/${max}`, { version: version(max) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /аккаунт/);
  });

  it('слияние дубля переносит связи, фото и привязку аккаунта', async () => {
    const max = person('Максим', 'M');
    const { id: dad } = await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    const twin = person('Сергей', 'M');
    const { id: sister } = await add(twin, { relation: 'child', familyId: null, person: newPerson('Лиза', 'F') });
    db.prepare("INSERT INTO media (id, person_id, width, height) VALUES (7, ?, 10, 10)").run(twin);
    db.prepare(`UPDATE persons SET avatar_media_id = 7, avatar_crop = '{"x":0.5,"y":0.5,"zoom":1}' WHERE id = ?`).run(twin);
    setUserPerson(db, 1, twin);

    const res = await call('POST', `/api/persons/${dad}/merge`, { version: version(dad), duplicateId: twin });
    assert.equal(res.status, 200);
    const merged = tree().persons.find((p) => p.id === dad)!;
    assert.deepEqual(merged.photos.map((p) => p.id), [7]);
    assert.equal(merged.avatar?.mediaId, 7);
    assert.equal(tree().persons.some((p) => p.id === twin), false);
    assert.deepEqual(familyOf(sister)!.partners, [dad, null]);
    assert.equal((db.prepare('SELECT person_id FROM users WHERE id = 1').get() as { person_id: number }).person_id, dad);
  });

  it('слияние дубля ребёнка оставляет семью с обоими родителями', async () => {
    const max = person('Максим', 'M');
    const { id: wife } = await add(max, { relation: 'spouse', person: newPerson('Анна', 'F') });
    const couple = tree().families.find((f) => f.partners.includes(wife))!;
    const { id: son } = await add(max, { relation: 'child', familyId: couple.id, person: newPerson('Фёдор', 'M') });
    const { id: twin } = await add(max, { relation: 'child', familyId: null, person: newPerson('Фёдор', 'M') });

    assert.equal((await call('POST', `/api/persons/${son}/merge`, { version: version(son), duplicateId: twin })).status, 200);
    const families = tree().families.filter((f) => f.children.some((c) => c.id === son));
    assert.deepEqual(families.map((f) => f.partners), [[max, wife]]);
    assert.equal(tree().families.length, 1);
  });

  it('нельзя слить с предком или человеком другого пола', async () => {
    const max = person('Максим', 'M');
    const { id: dad } = await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') });
    const anna = person('Анна', 'F');
    const merge = (keep: number, drop: number) =>
      call('POST', `/api/persons/${keep}/merge`, { version: version(keep), duplicateId: drop });
    assert.equal((await merge(max, dad)).status, 400);
    assert.equal((await merge(max, anna)).status, 400);
  });

  it('просмотр не может менять связи', async () => {
    const guest = await createUser(db, 'guest', 'viewer', 'temp-password');
    await setPassword(db, guest.id, 'long-password', { temporary: false });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'guest', password: 'long-password' }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
    const max = person('Максим', 'M');
    await add(max, { relation: 'parent', person: newPerson('Сергей', 'M') }, 403);
  });
});
