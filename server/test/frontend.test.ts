import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { serveFrontend } from '../src/frontend.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-'));
fs.mkdirSync(path.join(dir, 'assets'));
fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), 'console.log(1)');

const app = new Hono();
serveFrontend(app, dir);

describe('serveFrontend', () => {
  it('главная страница всегда перепроверяется', async () => {
    for (const url of ['/', '/index.html', '/person/5', '/?view=all']) {
      const res = await app.request(url);
      assert.equal(res.status, 200, url);
      assert.equal(res.headers.get('cache-control'), 'no-cache', url);
      assert.match(await res.text(), /<title>app/, url);
    }
  });

  it('скрипты с хешем кешируются навсегда', async () => {
    const res = await app.request('/assets/index-abc.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  });

  it('удалённый после деплоя скрипт — 404, а не HTML', async () => {
    const res = await app.request('/assets/TreePage-old.js');
    assert.equal(res.status, 404);
  });
});
