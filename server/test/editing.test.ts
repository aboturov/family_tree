import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDb, type Db } from '../src/db.ts';
import { getTree } from '../src/tree.ts';
import { createUser, setPassword, type Role } from '../src/users.ts';

const mediaDirForTests = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));

let db: Db;
let app: ReturnType<typeof createApp>;
let editorCookie: string;
let viewerCookie: string;

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

const send = (method: string, path: string, body: unknown, cookie = editorCookie) =>
  app.request(path, { method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

const person = (id: number) => getTree(db).persons.find((p) => p.id === id)!;

const PERSON = {
  givenName: 'Анна',
  patronymic: 'Петровна',
  surname: 'Соколова',
  birthSurname: 'Белова',
  sex: 'F',
  isDeceased: true,
  isUncertain: false,
  bio: 'Жила в Твери.',
};

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, mediaDir: mediaDirForTests, secureCookies: false, sessionTtlDays: 30 });
  db.exec(`
    INSERT INTO persons (id, given_name, sex) VALUES (1, 'Анна', 'F'), (2, 'Иван', 'M');
    INSERT INTO families (id, partner1_id, partner2_id) VALUES (1, 2, 1);
    INSERT INTO places (name) VALUES ('Тверская область, город Тверь');
  `);
  editorCookie = await loginAs('olga', 'editor');
  viewerCookie = await loginAs('guest', 'viewer');
});

describe('правка человека', () => {
  it('редактор меняет поля, версия растёт, правка в журнале', async () => {
    const res = await send('PATCH', '/api/persons/1', { version: 1, ...PERSON });
    assert.equal(res.status, 200);
    const p = person(1);
    assert.equal(p.surname, 'Соколова');
    assert.equal(p.birthSurname, 'Белова');
    assert.equal(p.isDeceased, true);
    assert.equal(p.version, 2);
    const log = db.prepare("SELECT action, user_id FROM audit_log WHERE entity = 'person' AND entity_id = 1").all();
    assert.equal(log.length, 1);
  });

  it('устаревшая версия — конфликт, данные не меняются', async () => {
    await send('PATCH', '/api/persons/1', { version: 1, ...PERSON });
    const res = await send('PATCH', '/api/persons/1', { version: 1, ...PERSON, surname: 'Другая' });
    assert.equal(res.status, 409);
    assert.equal(person(1).surname, 'Соколова');
  });

  it('просмотр не может править', async () => {
    const res = await send('PATCH', '/api/persons/1', { version: 1, ...PERSON }, viewerCookie);
    assert.equal(res.status, 403);
  });

  it('проверяет поля', async () => {
    assert.equal((await send('PATCH', '/api/persons/1', { version: 1, ...PERSON, sex: 'X' })).status, 400);
    assert.equal((await send('PATCH', '/api/persons/1', { ...PERSON })).status, 400);
    assert.equal((await send('PATCH', '/api/persons/99', { version: 1, ...PERSON })).status, 404);
  });
});

describe('события', () => {
  it('добавление с новым и существующим местом, без учёта регистра', async () => {
    let res = await send('POST', '/api/persons/1/events', {
      version: 1,
      type: 'birth',
      date: { modifier: 'exact', value: '1899-04-21' },
      place: '  тверская   область, город тверь ',
    });
    assert.equal(res.status, 201);
    res = await send('POST', '/api/persons/1/events', {
      version: 2,
      type: 'custom',
      customType: 'Военная служба',
      date: { modifier: 'between', value: '1941', valueTo: '1945' },
      place: 'Ленинградский фронт',
    });
    assert.equal(res.status, 201);

    const events = person(1).events;
    assert.deepEqual(
      events.map((e) => [e.type, e.customType, e.date, e.place?.name]),
      [
        ['birth', '', { modifier: 'exact', value: '1899-04-21' }, 'Тверская область, город Тверь'],
        ['custom', 'Военная служба', { modifier: 'between', value: '1941', valueTo: '1945' }, 'Ленинградский фронт'],
      ],
    );
    const { n } = db.prepare('SELECT count(*) AS n FROM places').get() as { n: number };
    assert.equal(n, 2, 'существующее место переиспользовано, новое создано');
  });

  it('правка и удаление поднимают версию владельца', async () => {
    const created = await (
      await send('POST', '/api/persons/1/events', { version: 1, type: 'death', date: null })
    ).json();
    assert.equal(
      (
        await send('PATCH', `/api/events/${created.id}`, {
          version: 2,
          type: 'death',
          date: { modifier: 'about', value: '1980' },
        })
      ).status,
      200,
    );
    assert.deepEqual(person(1).events[0].date, { modifier: 'about', value: '1980' });
    assert.equal((await send('DELETE', `/api/events/${created.id}`, { version: 2 })).status, 409);
    assert.equal((await send('DELETE', `/api/events/${created.id}`, { version: 3 })).status, 200);
    assert.deepEqual(person(1).events, []);
  });

  it('дата без года хранится текстом и меняется при правке', async () => {
    const created = await (
      await send('POST', '/api/persons/1/events', { version: 1, type: 'birth', date: null, dateText: '29 февраля' })
    ).json();
    assert.deepEqual([person(1).events[0].date, person(1).events[0].dateText], [null, '29 февраля']);
    await send('PATCH', `/api/events/${created.id}`, { version: 2, type: 'birth', date: null, dateText: 'март' });
    assert.equal(person(1).events[0].dateText, 'март');
    await send('PATCH', `/api/events/${created.id}`, {
      version: 3,
      type: 'birth',
      date: { modifier: 'exact', value: '1899-04-21' },
      dateText: 'март',
    });
    assert.deepEqual([person(1).events[0].date?.value, person(1).events[0].dateText], ['1899-04-21', '']);
  });

  it('события брака — у семьи', async () => {
    const res = await send('POST', '/api/families/1/events', {
      version: 1,
      type: 'marriage',
      date: { modifier: 'exact', value: '1922' },
    });
    assert.equal(res.status, 201);
    assert.equal(getTree(db).families[0].events[0].type, 'marriage');
    assert.equal(getTree(db).families[0].version, 2);
  });

  it('проверяет события', async () => {
    const bad = [
      { version: 1, type: 'marriage' },
      { version: 1, type: 'custom' },
      { version: 1, type: 'birth', date: { modifier: 'exact', value: '21.04.1899' } },
      { version: 1, type: 'birth', date: { modifier: 'between', value: '1941' } },
      { version: 1, type: 'birth', date: { modifier: 'between', value: '1945', valueTo: '1941' } },
      { version: 1, type: 'birth', date: { modifier: 'someday', value: '1941' } },
      { version: 1, type: 'birth', date: null, dateText: 'когда-то весной' },
      { version: 1, type: 'birth', date: null, dateText: '30 февраля' },
    ];
    for (const body of bad)
      assert.equal((await send('POST', '/api/persons/1/events', body)).status, 400, JSON.stringify(body));
  });
});

describe('смерть', () => {
  it('галочка «Умер» — событие смерти без даты; без даты её можно снять', async () => {
    await send('PATCH', '/api/persons/2', { version: 1, ...PERSON });
    assert.equal(person(2).isDeceased, true);
    assert.deepEqual(person(2).events.map((e) => [e.type, e.date]), [['death', null]]);

    await send('PATCH', '/api/persons/2', { version: 2, ...PERSON });
    assert.equal(person(2).events.length, 1, 'второе событие смерти не появляется');

    await send('PATCH', '/api/persons/2', { version: 3, ...PERSON, isDeceased: false });
    assert.equal(person(2).isDeceased, false);
    assert.deepEqual(person(2).events, []);
  });

  it('дата смерти без галочки — тоже «умер»; с датой галочку не снять', async () => {
    const created = await (
      await send('POST', '/api/persons/2/events', { version: 1, type: 'death', date: { modifier: 'exact', value: '1980-03-10' } })
    ).json();
    assert.equal(person(2).isDeceased, true);

    assert.equal((await send('PATCH', '/api/persons/2', { version: 2, ...PERSON, isDeceased: false })).status, 400);
    assert.equal(person(2).isDeceased, true);
    assert.equal(person(2).surname, '', 'правка карточки откатилась целиком');

    await send('DELETE', `/api/events/${created.id}`, { version: 2 });
    assert.equal(person(2).isDeceased, false);
  });
});

describe('подсказки мест', () => {
  it('по подстроке, без учёта регистра', async () => {
    const res = await app.request('/api/places?q=ТВЕР', { headers: { cookie: viewerCookie } });
    const { places } = await res.json();
    assert.deepEqual(
      places.map((p: { name: string }) => p.name),
      ['Тверская область, город Тверь'],
    );
  });
});
