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
let editor: string;
let viewer: string;

// Минимальные «JPEG»: сервер проверяет только сигнатуру, перекодирует фото браузер.
const jpeg = (fill: number, size = 64) => new Uint8Array([0xff, 0xd8, 0xff, ...new Array(size).fill(fill)]);

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

function upload(personId: number, cookie = editor, full = jpeg(1), thumb = jpeg(2)) {
  const form = new FormData();
  form.set('full', new File([full], 'photo.jpg', { type: 'image/jpeg' }));
  form.set('thumb', new File([thumb], 'thumb.jpg', { type: 'image/jpeg' }));
  form.set('width', '1600');
  form.set('height', '1200');
  form.set('caption', 'Свадьба, 1996');
  // Браузер при отправке формы со своего сайта ставит Origin; без него сработает защита от CSRF.
  return app.request(`/api/persons/${personId}/media`, {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost' },
    body: form,
  });
}

const json = (method: string, url: string, body: unknown, cookie = editor) =>
  app.request(url, { method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

const person = (id: number) => getTree(db).persons.find((p) => p.id === id)!;

beforeEach(async () => {
  db = openDb(':memory:');
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  app = createApp({ db, mediaDir, secureCookies: false, sessionTtlDays: 30 });
  db.exec("INSERT INTO persons (id, given_name, sex) VALUES (1, 'Сергей', 'M'), (2, 'Елена', 'F')");
  editor = await loginAs('olga', 'editor');
  viewer = await loginAs('guest', 'viewer');
});

describe('фото', () => {
  it('загрузка, выдача и подпись', async () => {
    const res = await upload(1);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    assert.deepEqual(person(1).photos, [{ id, caption: 'Свадьба, 1996', width: 1600, height: 1200 }]);

    const thumb = await app.request(`/api/media/${id}/thumb`, { headers: { cookie: viewer } });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await thumb.arrayBuffer()), jpeg(2));

    assert.equal((await json('PATCH', `/api/media/${id}`, { caption: 'Свадьба' })).status, 200);
    assert.equal(person(1).photos[0].caption, 'Свадьба');
  });

  it('без входа фото не отдаются, просмотр не может загружать', async () => {
    const { id } = await (await upload(1)).json();
    assert.equal((await app.request(`/api/media/${id}/full`)).status, 401);
    assert.equal((await upload(1, viewer)).status, 403);
  });

  it('форма загрузки с чужого сайта отклоняется', async () => {
    const form = new FormData();
    form.set('full', new File([jpeg(1)], 'photo.jpg'));
    const res = await app.request('/api/persons/1/media', {
      method: 'POST',
      headers: { cookie: editor, origin: 'https://evil.example' },
      body: form,
    });
    assert.equal(res.status, 403);
  });

  it('принимаются только JPEG', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    assert.equal((await upload(1, editor, png)).status, 400);
    assert.deepEqual(person(1).photos, []);
  });

  it('аватарка: своё фото, кадрирование, проверка версии', async () => {
    const { id } = await (await upload(1)).json();
    const crop = { x: 0.5, y: 0.4, zoom: 0.6 };
    assert.equal((await json('PUT', '/api/persons/1/avatar', { version: 1, mediaId: id, crop })).status, 200);
    assert.deepEqual(person(1).avatar, { mediaId: id, crop });
    assert.equal((await json('PUT', '/api/persons/1/avatar', { version: 1, mediaId: id, crop })).status, 409);
    assert.equal((await json('PUT', '/api/persons/2/avatar', { version: 1, mediaId: id, crop })).status, 400);
    assert.equal(
      (await json('PUT', '/api/persons/1/avatar', { version: 2, mediaId: id, crop: { x: 2, y: 0, zoom: 1 } })).status,
      400,
    );
    assert.equal((await json('PUT', '/api/persons/1/avatar', { version: 2, mediaId: null })).status, 200);
    assert.equal(person(1).avatar, null);
  });

  it('удаление фото убирает файлы и аватарку', async () => {
    const { id } = await (await upload(1)).json();
    await json('PUT', '/api/persons/1/avatar', { version: 1, mediaId: id, crop: { x: 0.5, y: 0.5, zoom: 1 } });
    assert.equal(
      (
        await app.request(`/api/media/${id}`, {
          method: 'DELETE',
          headers: { cookie: editor, origin: 'http://localhost' },
        })
      ).status,
      200,
    );
    assert.equal(person(1).avatar, null);
    assert.deepEqual(person(1).photos, []);
    // Файлы не стираются, а уходят в корзину — правку можно откатить.
    assert.deepEqual(fs.readdirSync(mediaDir), ['trash']);
    assert.deepEqual(fs.readdirSync(path.join(mediaDir, 'trash')).sort(), [`${id}-thumb.jpg`, `${id}.jpg`]);
  });

  it('новое фото не получает id удалённого', async () => {
    const { id: removed } = await (await upload(1)).json();
    await app.request(`/api/media/${removed}`, { method: 'DELETE', headers: { cookie: editor, origin: 'http://localhost' } });
    const { id } = await (await upload(1, editor, jpeg(3), jpeg(4))).json();
    // По старому адресу браузер держит в кеше удалённое фото, а в корзине лежат его файлы.
    assert.ok(id > removed);
    assert.deepEqual(new Uint8Array(await (await app.request(`/api/media/${id}/thumb`, { headers: { cookie: viewer } })).arrayBuffer()), jpeg(4));
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(mediaDir, 'trash', `${removed}-thumb.jpg`))), jpeg(2));
  });
});
