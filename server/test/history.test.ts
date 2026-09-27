import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb, type Db } from '../src/db.ts';
import { getTree } from '../src/tree.ts';
import { createUser, setPassword, type Role } from '../src/users.ts';

let db: Db;
let mediaDir: string;
let app: ReturnType<typeof createApp>;
let olga: string;
let admin: string;

async function loginAs(login: string, role: Role) {
  const user = await createUser(db, login, role, 'temp-password');
  await setPassword(db, user.id, 'long-password', { temporary: false });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: 'long-password' }),
  });
  return res.headers.get('set-cookie')!.split(';')[0];
}

const call = (method: string, url: string, body: unknown = {}, cookie = olga) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

const tree = () => getTree(db);
const personOf = (id: number) => tree().persons.find((p) => p.id === id);
const version = (id: number) => personOf(id)!.version;

type Item = { id: number; action: string; details: Record<string, unknown>; undoable: boolean; undoneBy: unknown };
const history = async (cookie = olga) => ((await (await call('GET', '/api/history', undefined, cookie)).json()) as { items: Item[] }).items;
const undo = (id: number, cookie = olga) => call('POST', `/api/history/${id}/undo`, {}, cookie);

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
function upload(personId: number) {
  const form = new FormData();
  form.set('full', new File([jpeg], 'photo.jpg'));
  form.set('thumb', new File([jpeg], 'thumb.jpg'));
  form.set('width', '100');
  form.set('height', '100');
  return app.request(`/api/persons/${personId}/media`, {
    method: 'POST',
    headers: { cookie: olga, origin: 'http://localhost' },
    body: form,
  });
}

const fields = (givenName: string) => ({ givenName, surname: 'Орлов', sex: 'M' });

beforeEach(async () => {
  db = openDb(':memory:');
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  app = createApp({ db, mediaDir, secureCookies: false, sessionTtlDays: 30 });
  db.exec("INSERT INTO persons (id, given_name, surname, sex) VALUES (1, 'Максим', 'Орлов', 'M')");
  olga = await loginAs('olga', 'editor');
  admin = await loginAs('max', 'admin');
});

describe('история правок', () => {
  it('правка полей видна в истории и откатывается', async () => {
    await call('PATCH', '/api/persons/1', { version: 1, ...fields('Григорий'), bio: 'био' });
    const [item] = await history();
    assert.equal(item.action, 'person.update');
    assert.equal((item.details.person as { name: string }).name, 'Орлов Григорий');
    assert.equal(item.undoable, true);

    assert.equal((await undo(item.id)).status, 200);
    assert.equal(personOf(1)!.givenName, 'Максим');
    assert.equal(personOf(1)!.bio, '');
    const [undoItem, original] = await history();
    assert.equal(undoItem.action, 'undo');
    assert.ok(original.undoneBy);
    assert.equal((await undo(item.id)).status, 400);
  });

  it('добавление нового родственника откатывается вместе с семьёй', async () => {
    await call('POST', '/api/persons/1/relatives', {
      version: 1,
      relation: 'child',
      familyId: null,
      person: { givenName: 'Фёдор', sex: 'M' },
      birth: { modifier: 'exact', value: '2024' },
    });
    const [item] = await history();
    assert.equal(item.details.relation, 'child');
    assert.equal((await undo(item.id)).status, 200);
    assert.deepEqual(tree().persons.map((p) => p.id), [1]);
    assert.equal(tree().families.length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM events').get()!.n, 0);
  });

  it('удалённый человек возвращается с событиями, связями и фото', async () => {
    await call('POST', '/api/persons/1/relatives', { version: 1, relation: 'parent', person: { givenName: 'Сергей', sex: 'M' } });
    const dad = tree().persons.find((p) => p.givenName === 'Сергей')!.id;
    await call('POST', `/api/persons/${dad}/events`, { version: version(dad), type: 'occupation', note: 'инженер' });
    const { id: photo } = await (await upload(dad)).json();
    await call('PUT', `/api/persons/${dad}/avatar`, { version: version(dad), mediaId: photo, crop: { x: 0.5, y: 0.5, zoom: 1 } });

    assert.equal((await call('DELETE', `/api/persons/${dad}`, { version: version(dad) })).status, 200);
    assert.equal(tree().families.length, 0);
    assert.equal(fs.existsSync(path.join(mediaDir, `${photo}.jpg`)), false);

    const [item] = await history();
    assert.equal(item.action, 'person.delete');
    assert.equal((await undo(item.id)).status, 200);

    const restored = personOf(dad)!;
    assert.equal(restored.givenName, 'Сергей');
    assert.equal(restored.events[0].note, 'инженер');
    assert.deepEqual(restored.photos.map((p) => p.id), [photo]);
    assert.equal(restored.avatar?.mediaId, photo);
    assert.deepEqual(tree().families[0].partners, [dad, null]);
    assert.deepEqual(tree().families[0].children.map((c) => c.id), [1]);
    assert.equal(fs.existsSync(path.join(mediaDir, `${photo}.jpg`)), true);
  });

  it('отвязка ребёнка откатывается, даже если семья была удалена', async () => {
    await call('POST', '/api/persons/1/relatives', { version: 1, relation: 'parent', person: { givenName: 'Сергей', sex: 'M' } });
    const family = tree().families[0];
    await call('DELETE', `/api/families/${family.id}/children/1`, { version: family.version });
    assert.equal(tree().families.length, 0);
    const [item] = await history();
    assert.equal((await undo(item.id)).status, 200);
    assert.deepEqual(tree().families[0].children.map((c) => c.id), [1]);
  });

  it('удалённое фото возвращается вместе с файлом', async () => {
    const { id: photo } = await (await upload(1)).json();
    await call('DELETE', `/api/media/${photo}`);
    const [item] = await history();
    assert.equal(item.action, 'media.delete');
    assert.equal((await undo(item.id)).status, 200);
    assert.deepEqual(personOf(1)!.photos.map((p) => p.id), [photo]);
    assert.equal(fs.existsSync(path.join(mediaDir, `${photo}-thumb.jpg`)), true);
  });

  it('правку нельзя откатить, пока не откачена более поздняя правка тех же записей', async () => {
    await call('PATCH', '/api/persons/1', { version: 1, ...fields('Григорий') });
    await call('PATCH', '/api/persons/1', { version: 2, ...fields('Гриша') });
    const [second, first] = await history();
    assert.equal(first.undoable, false);
    assert.equal((await undo(first.id)).status, 409);

    assert.equal((await undo(second.id)).status, 200);
    assert.equal(personOf(1)!.givenName, 'Григорий');
    assert.equal((await undo(first.id)).status, 200);
    assert.equal(personOf(1)!.givenName, 'Максим');
  });

  it('брак из «половинки» переносится к полной паре, пустая половинка исчезает', async () => {
    // Как после импорта: пара с дочерью и отдельно «жена + неизвестный» с датой брака и разводом.
    db.exec(`
      INSERT INTO persons (id, given_name, sex) VALUES (2, 'Ирина', 'F'), (3, 'Елена', 'F');
      INSERT INTO families (id, partner1_id, partner2_id) VALUES (10, 1, 2), (11, NULL, 2);
      INSERT INTO family_children (family_id, child_id) VALUES (10, 3);
      INSERT INTO events (id, family_id, type, date_modifier, date_value) VALUES (20, 11, 'marriage', 'exact', '1970-06-13');
      INSERT INTO events (id, family_id, type) VALUES (21, 11, 'divorce'), (22, 10, 'divorce');
    `);
    const move = await call('PATCH', '/api/events/20', {
      version: 1,
      type: 'marriage',
      date: { modifier: 'exact', value: '1970-06-13' },
      moveToFamily: 10,
    });
    assert.equal(move.status, 200);
    assert.deepEqual(tree().families.find((f) => f.id === 10)!.events.map((e) => e.type).sort(), ['divorce', 'marriage']);

    await call('DELETE', '/api/events/21', { version: 2 });
    assert.equal(tree().families.some((f) => f.id === 11), false);

    // Откат удаления возвращает и половинку, откат переноса — событие на место.
    const [removal, moving] = await history();
    assert.equal((await undo(removal.id)).status, 200);
    assert.equal((await undo(moving.id)).status, 200);
    assert.deepEqual(tree().families.find((f) => f.id === 11)!.events.map((e) => e.id).sort(), [20, 21]);
  });

  it('событие нельзя перенести в брак другого человека', async () => {
    db.exec(`
      INSERT INTO persons (id, given_name, sex) VALUES (2, 'Анна', 'F'), (3, 'Пётр', 'M'), (4, 'Мария', 'F');
      INSERT INTO families (id, partner1_id, partner2_id) VALUES (10, 1, 2), (11, 3, 4);
      INSERT INTO events (id, family_id, type) VALUES (20, 10, 'marriage');
    `);
    const res = await call('PATCH', '/api/events/20', { version: 1, type: 'marriage', moveToFamily: 11 });
    assert.equal(res.status, 400);
  });

  it('чужую правку откатывает только админ; слияние не откатывается', async () => {
    await call('PATCH', '/api/persons/1', { version: 1, ...fields('Григорий') }, admin);
    const [item] = await history();
    const res = await undo(item.id, olga);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /администратор/);
    assert.equal((await undo(item.id, admin)).status, 200);

    db.exec("INSERT INTO persons (id, given_name, sex) VALUES (2, 'Максим', 'M')");
    await call('POST', '/api/persons/1/merge', { version: version(1), duplicateId: 2 });
    const [merge] = await history();
    assert.equal(merge.action, 'person.merge');
    assert.equal(merge.undoable, false);
  });
});
