import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createApp, SESSION_COOKIE } from '../src/app.ts';
import { openDb, type Db } from '../src/db.ts';
import { createUser, setUserPerson } from '../src/users.ts';

const mediaDirForTests = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, mediaDir: mediaDirForTests, secureCookies: false, sessionTtlDays: 30 });
});

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  assert.ok(match, 'ожидалась cookie сессии');
  return `${SESSION_COOKIE}=${match[1]}`;
}

async function login(loginName: string, password: string) {
  const res = await post('/api/auth/login', { login: loginName, password });
  assert.equal(res.status, 200);
  return sessionCookie(res);
}

describe('auth', () => {
  it('health доступен без входа', async () => {
    const res = await app.request('/api/health');
    assert.equal(res.status, 200);
  });

  it('без сессии API закрыт', async () => {
    const res = await app.request('/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('неверный пароль и неизвестный логин дают одинаковый ответ', async () => {
    await createUser(db, 'max', 'admin', 'temp-password');
    const wrong = await post('/api/auth/login', { login: 'max', password: 'nope' });
    const unknown = await post('/api/auth/login', { login: 'ghost', password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
  });

  it('после входа с временным паролем требуется его сменить', async () => {
    await createUser(db, 'olga', 'editor', 'temp-password');
    const cookie = await login('Olga', 'temp-password');

    const me = await app.request('/api/auth/me', { headers: { cookie } });
    assert.deepEqual((await me.json()).user, {
      id: 1,
      login: 'olga',
      role: 'editor',
      mustChangePassword: true,
      personId: null,
    });

    const blocked = await app.request('/api/anything', { headers: { cookie } });
    assert.equal(blocked.status, 403);

    const short = await post(
      '/api/auth/change-password',
      { currentPassword: 'temp-password', newPassword: 'short' },
      cookie,
    );
    assert.equal(short.status, 400);

    const changed = await post(
      '/api/auth/change-password',
      { currentPassword: 'temp-password', newPassword: 'new-long-password' },
      cookie,
    );
    assert.equal(changed.status, 200);

    const unblocked = await app.request('/api/anything', { headers: { cookie } });
    assert.equal(unblocked.status, 404);

    await login('olga', 'new-long-password');
  });

  it('смена пароля завершает остальные сессии', async () => {
    await createUser(db, 'max', 'admin', 'temp-password');
    const phone = await login('max', 'temp-password');
    const laptop = await login('max', 'temp-password');
    await post(
      '/api/auth/change-password',
      { currentPassword: 'temp-password', newPassword: 'new-long-password' },
      laptop,
    );

    assert.equal((await app.request('/api/auth/me', { headers: { cookie: laptop } })).status, 200);
    assert.equal((await app.request('/api/auth/me', { headers: { cookie: phone } })).status, 401);
  });

  it('me отдаёт человека, с которым связан пользователь', async () => {
    const user = await createUser(db, 'max', 'admin', 'temp-password');
    const { id: personId } = db.prepare("INSERT INTO persons (given_name) VALUES ('Максим') RETURNING id").get() as {
      id: number;
    };
    setUserPerson(db, user.id, personId);
    const cookie = await login('max', 'temp-password');
    const me = await app.request('/api/auth/me', { headers: { cookie } });
    assert.equal((await me.json()).user.personId, personId);
  });

  it('logout завершает сессию', async () => {
    await createUser(db, 'max', 'admin', 'temp-password');
    const cookie = await login('max', 'temp-password');
    await post('/api/auth/logout', {}, cookie);
    assert.equal((await app.request('/api/auth/me', { headers: { cookie } })).status, 401);
  });

  it('после серии неудачных входов логин блокируется', async () => {
    await createUser(db, 'max', 'admin', 'temp-password');
    for (let i = 0; i < 10; i++) await post('/api/auth/login', { login: 'max', password: 'nope' });
    const res = await post('/api/auth/login', { login: 'max', password: 'temp-password' });
    assert.equal(res.status, 429);
  });

  it('блокировка по «IP + логин» не мешает входу с другого адреса', async () => {
    await createUser(db, 'olga', 'editor', 'temp-password');
    const from = (ip: string, password: string) =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify({ login: 'olga', password }),
      });
    for (let i = 0; i < 10; i++) await from('203.0.113.9', 'nope');
    assert.equal((await from('203.0.113.9', 'temp-password')).status, 429);
    assert.equal((await from('198.51.100.7', 'temp-password')).status, 200);
  });

  it('слабый новый пароль отклоняется с понятной причиной', async () => {
    await createUser(db, 'olga', 'editor', 'temp-password');
    const cookie = await login('olga', 'temp-password');
    for (const newPassword of ['short', 'olga-2026-pass', '1234567890', 'aaaaabbbbb']) {
      const res = await post('/api/auth/change-password', { currentPassword: 'temp-password', newPassword }, cookie);
      assert.equal(res.status, 400, newPassword);
      assert.ok((await res.json()).error, newPassword);
    }
  });

  it('ответы несут заголовки безопасности', async () => {
    const secure = createApp({ db, mediaDir: mediaDirForTests, secureCookies: true, sessionTtlDays: 30 });
    const res = await secure.request('/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=/);
  });

  it('форма с чужого сайта отклоняется', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: 'login=max&password=x',
    });
    assert.equal(res.status, 403);
  });
});
