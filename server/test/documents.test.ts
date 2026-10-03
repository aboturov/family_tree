import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { decode } from 'jpeg-js';
import { createApp } from '../src/app.ts';
import { openDb, type Db } from '../src/db.ts';
import { readJpegInfo, stripMetadata } from '../src/jpeg.ts';
import { getTree } from '../src/tree.ts';
import { createUser, setPassword, type Role } from '../src/users.ts';
import { contains, exif, jpeg } from './fixtures.ts';

let db: Db;
let mediaDir: string;
let app: ReturnType<typeof createApp>;
let editor: string;
let viewer: string;

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

const call = (method: string, url: string, body: unknown = {}, cookie = editor) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

type Doc = {
  id: number;
  version: number;
  title: string;
  date: unknown;
  files: { id: number; frame: number | null; width: number; height: number }[];
  persons: { id: number; role: string }[];
  events: number[];
};
const documents = async () => ((await (await call('GET', '/api/documents')).json()) as { documents: Doc[] }).documents;
const doc = async (id: number) => (await documents()).find((d) => d.id === id);
const person = (id: number) => getTree(db).persons.find((p) => p.id === id)!;

async function addDocument(body: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/documents', { type: 'metric_birth', ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: number }).id;
}

function upload(documentId: number, file: Uint8Array, frame?: number) {
  const form = new FormData();
  form.set('file', new File([file.slice()], 'scan.jpg'));
  form.set('thumb', new File([jpeg(8, 6)], 'thumb.jpg'));
  if (frame !== undefined) form.set('frame', String(frame));
  return app.request(`/api/documents/${documentId}/files`, {
    method: 'POST',
    headers: { cookie: editor, origin: 'http://localhost' },
    body: form,
  });
}

type Item = { id: number; action: string; details: Record<string, unknown> };
const history = async () => ((await (await call('GET', '/api/history')).json()) as { items: Item[] }).items;
const undo = (id: number) => call('POST', `/api/history/${id}/undo`);

beforeEach(async () => {
  db = openDb(':memory:');
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  app = createApp({ db, mediaDir, secureCookies: false, sessionTtlDays: 30 });
  db.exec(`
    INSERT INTO persons (id, given_name, surname, sex) VALUES (1, 'Анна', 'Орлова', 'F'), (2, 'Пётр', 'Орлов', 'M'),
      (3, 'Мария', 'Орлова', 'F');
    INSERT INTO families (id, partner1_id, partner2_id) VALUES (1, 2, 3);
    INSERT INTO family_children (family_id, child_id) VALUES (1, 1);
    INSERT INTO events (id, person_id, type, date_modifier, date_value) VALUES (10, 1, 'birth', 'exact', '1885-03-12');
    INSERT INTO events (id, family_id, type) VALUES (20, 1, 'marriage');
  `);
  editor = await loginAs('olga', 'editor');
  viewer = await loginAs('max', 'viewer');
});

describe('документы', () => {
  it('заводится по одному шифру — без скана и без людей', async () => {
    const id = await addDocument({ archive: 'ГА Тверской области', fond: 'Р-100', opis: '2а', delo: '15А', sheets: '12об.–13' });
    const [d] = await documents();
    assert.equal(d.id, id);
    assert.deepEqual([d.files, d.persons, d.events, d.version], [[], [], [], 1]);
  });

  it('люди с ролями и подтверждённые события видны в дереве', async () => {
    const id = await addDocument({
      date: { modifier: 'exact', value: '1885-03-14', calendar: 'julian' },
      persons: [
        { id: 1, role: 'subject' },
        { id: 2, role: 'father' },
        { id: 3, role: 'mother' },
      ],
      events: [10],
    });
    const d = (await doc(id))!;
    assert.deepEqual(d.persons.map((p) => [p.id, p.role]), [[1, 'subject'], [2, 'father'], [3, 'mother']]);
    assert.deepEqual(d.date, { modifier: 'exact', value: '1885-03-14', calendar: 'julian' });
    assert.deepEqual(person(1).documents, [id]);
    assert.deepEqual(person(1).events[0].documents, [id]);
    assert.equal(person(2).events.length, 0);
    const [item] = await history();
    assert.equal(item.action, 'document.add');
    assert.deepEqual(item.details.document, { documentId: id, type: 'metric_birth', title: '' });
  });

  it('событие брака — у пары из документа', async () => {
    const id = await addDocument({
      type: 'metric_marriage',
      persons: [
        { id: 2, role: 'groom' },
        { id: 3, role: 'bride' },
      ],
      events: [20],
    });
    assert.deepEqual(getTree(db).families[0].events[0].documents, [id]);
  });

  it('проверяет поля и права', async () => {
    const bad = [
      { type: 'saga' },
      { type: 'metric_birth', persons: [{ id: 1, role: 'hero' }] },
      { type: 'metric_birth', persons: [{ id: 1, role: 'subject' }, { id: 1, role: 'mother' }] },
      { type: 'metric_birth', persons: [{ id: 99, role: 'subject' }] },
      { type: 'metric_birth', url: 'javascript:alert(1)' },
      // Событие должно быть у людей документа.
      { type: 'metric_birth', persons: [{ id: 2, role: 'father' }], events: [10] },
      { type: 'metric_birth', events: [999] },
      { type: 'metric_birth', date: { modifier: 'exact', value: '1885', calendar: 'hebrew' } },
    ];
    for (const body of bad) assert.equal((await call('POST', '/api/documents', body)).status, 400, JSON.stringify(body));
    assert.equal((await call('POST', '/api/documents', { type: 'other' }, viewer)).status, 403);
  });

  it('правка — по версии: вторая правка той же версии получает конфликт', async () => {
    const id = await addDocument({ title: 'Метрика' });
    const edit = { version: 1, type: 'metric_birth', title: 'Метрическая запись', transcription: 'Родился младенец…' };
    assert.equal((await call('PATCH', `/api/documents/${id}`, edit)).status, 200);
    assert.equal((await call('PATCH', `/api/documents/${id}`, edit)).status, 409);
    const d = (await doc(id))!;
    assert.deepEqual([d.title, d.version], ['Метрическая запись', 2]);
  });

  it('скан хранится без метаданных и без пересжатия; повтор кадра — предупреждение', async () => {
    const id = await addDocument();
    const original = jpeg(64, 48, { exif: exif(1) });
    const res = await upload(id, original, 27);
    assert.equal(res.status, 201);
    const { id: fileId, sameScans } = (await res.json()) as { id: number; sameScans: unknown[] };
    assert.deepEqual(sameScans, []);

    const stored = new Uint8Array(await (await call('GET', `/api/document-files/${fileId}/original`)).arrayBuffer());
    assert.equal(contains(original, 'GPS'), true);
    assert.equal(contains(stored, 'GPS'), false);
    assert.deepEqual(stored, stripMetadata(original));
    assert.equal(decode(stored).width, 64);
    assert.equal((await call('GET', `/api/document-files/${fileId}/thumb`)).status, 200);
    assert.deepEqual((await doc(id))!.files, [{ id: fileId, frame: 27, width: 64, height: 48, bytes: stored.length }]);

    const other = await addDocument({ type: 'confession' });
    const again = (await (await upload(other, original)).json()) as { sameScans: { documentId: number }[] };
    assert.deepEqual(
      again.sameScans.map((s) => s.documentId),
      [id],
    );
  });

  it('не принимает не-JPEG и скан, повёрнутый через EXIF', async () => {
    const id = await addDocument();
    assert.equal((await upload(id, new Uint8Array([1, 2, 3]))).status, 400);
    const rotated = await upload(id, jpeg(40, 30, { exif: exif(6) }));
    assert.equal(rotated.status, 400);
    assert.match(((await rotated.json()) as { error: string }).error, /повёрнут/);
  });

  it('номер кадра правится, скан удаляется в корзину', async () => {
    const id = await addDocument();
    const { id: fileId } = (await (await upload(id, jpeg())).json()) as { id: number };
    assert.equal((await call('PATCH', `/api/document-files/${fileId}`, { frame: 31 })).status, 200);
    assert.equal((await doc(id))!.files[0].frame, 31);
    assert.equal((await call('DELETE', `/api/document-files/${fileId}`)).status, 200);
    assert.deepEqual((await doc(id))!.files, []);
    assert.equal(fs.existsSync(path.join(mediaDir, 'documents', 'trash', `${fileId}.jpg`)), true);
  });

  it('удалённый документ возвращается откатом — со сканами и связями', async () => {
    const id = await addDocument({ persons: [{ id: 1, role: 'subject' }], events: [10] });
    const { id: fileId } = (await (await upload(id, jpeg())).json()) as { id: number };
    assert.equal((await call('DELETE', `/api/documents/${id}`, { version: 1 })).status, 200);
    assert.deepEqual(await documents(), []);
    assert.equal((await call('GET', `/api/document-files/${fileId}/original`)).status, 404);

    const [item] = await history();
    assert.equal(item.action, 'document.delete');
    assert.equal((await undo(item.id)).status, 200);
    const d = (await doc(id))!;
    assert.deepEqual([d.persons, d.events, d.files.map((f) => f.id)], [[{ id: 1, role: 'subject' }], [10], [fileId]]);
    assert.equal((await call('GET', `/api/document-files/${fileId}/original`)).status, 200);
  });

  it('откат загрузки убирает скан, откат добавления — документ', async () => {
    const id = await addDocument();
    const { id: fileId } = (await (await upload(id, jpeg())).json()) as { id: number };
    const [fileItem, docItem] = await history();
    assert.equal((await undo(docItem.id)).status, 409, 'сначала — более поздняя загрузка скана');
    assert.equal((await undo(fileItem.id)).status, 200);
    assert.equal((await call('GET', `/api/document-files/${fileId}/original`)).status, 404);
    assert.equal((await undo(docItem.id)).status, 200);
    assert.deepEqual(await documents(), []);
  });
});

describe('связи документов при правке дерева', () => {
  it('удаление человека снимает его из документа, откат возвращает', async () => {
    const id = await addDocument({ persons: [{ id: 1, role: 'subject' }, { id: 2, role: 'father' }], events: [10] });
    assert.equal((await call('DELETE', '/api/persons/2', { version: person(2).version })).status, 200);
    assert.deepEqual((await doc(id))!.persons, [{ id: 1, role: 'subject' }]);

    const [item] = await history();
    assert.equal(item.action, 'person.delete');
    assert.equal((await undo(item.id)).status, 200);
    assert.deepEqual((await doc(id))!.persons, [{ id: 1, role: 'subject' }, { id: 2, role: 'father' }]);
  });

  it('удаление события снимает его из документа, откат возвращает', async () => {
    const id = await addDocument({ persons: [{ id: 1, role: 'subject' }], events: [10] });
    assert.equal((await call('DELETE', '/api/events/10', { version: person(1).version })).status, 200);
    assert.deepEqual((await doc(id))!.events, []);
    const [item] = await history();
    assert.equal((await undo(item.id)).status, 200);
    assert.deepEqual((await doc(id))!.events, [10]);
    assert.deepEqual(person(1).events[0].documents, [id]);
  });

  it('при слиянии дублей документы переходят к оставшемуся', async () => {
    db.exec(`
      INSERT INTO persons (id, given_name, surname, sex) VALUES (4, 'Анна', 'Орлова', 'F');
      INSERT INTO events (id, person_id, type, date_modifier, date_value) VALUES (11, 4, 'birth', 'exact', '1885');
    `);
    const id = await addDocument({ persons: [{ id: 4, role: 'subject' }], events: [11] });
    const res = await call('POST', '/api/persons/1/merge', { duplicateId: 4, version: person(1).version });
    assert.equal(res.status, 200);
    const d = (await doc(id))!;
    // Два рождения слились в одно — документ теперь у него.
    assert.deepEqual([d.persons, d.events], [[{ id: 1, role: 'subject' }], [10]]);
  });
});

describe('JPEG', () => {
  it('размеры и поворот из EXIF', () => {
    assert.deepEqual(readJpegInfo(jpeg(64, 48)), { width: 64, height: 48, orientation: 1 });
    assert.deepEqual(readJpegInfo(jpeg(64, 48, { exif: exif(6) })), { width: 64, height: 48, orientation: 6 });
  });
});
