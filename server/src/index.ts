import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { serveFrontend } from './frontend.ts';
import { createLayoutService } from './layouts.ts';
import { createPrecompute } from './precompute.ts';
import { deleteExpiredSessions } from './sessions.ts';
import { createViewStats } from './viewStats.ts';

const db = openDb(path.join(config.dataDir, 'tree.db'));
const layouts = createLayoutService({ cacheFile: config.layoutCache, threads: config.layoutThreads });
const stats = createViewStats({ file: config.layoutCache });
// Серия правок пересчитывается один раз — через несколько секунд после последней; правки через
// tree-admin сервер замечает при проверке раз в 30 секунд.
const precompute = createPrecompute({ db, layouts, delayMs: 5000, watchMs: 30_000, stats });
const app = createApp({
  db,
  mediaDir: config.mediaDir,
  secureCookies: config.secureCookies,
  sessionTtlDays: config.sessionTtlDays,
  layouts,
  onChange: precompute.schedule,
  stats,
});

if (fs.existsSync(config.staticDir)) serveFrontend(app, config.staticDir);

deleteExpiredSessions(db);
setInterval(() => deleteExpiredSessions(db), 24 * 60 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`family-tree слушает :${port}, данные в ${config.dataDir}`);
});
// После выкладки кэш раскладок новой версии пуст — считаем ходовые виды сразу.
precompute.schedule();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    precompute.stop();
    void layouts.close();
    stats.close();
    db.close();
    process.exit(0);
  });
}
