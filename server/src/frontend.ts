import { serveStatic } from '@hono/node-server/serve-static';
import type { Env, Hono } from 'hono';

// Раздача собранного фронта. Два правила против «зависшего» сайта после деплоя:
// index.html всегда перепроверяется (no-cache), чтобы браузер не держал старую версию
// со ссылками на удалённые скрипты, а несуществующий файл в assets/ — это 404, а не
// index.html: иначе браузер получает HTML вместо скрипта и приложение молча ломается.
export function serveFrontend<E extends Env>(app: Hono<E>, staticDir: string) {
  // Заголовки кеша ставим после ответа: onFound у serveStatic вызывается слишком поздно.
  app.use('/*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/api/') || c.res.status !== 200) return;
    if (c.req.path.startsWith('/assets/')) {
      // Файлы в assets/ собраны Vite с хешем в имени — их можно кешировать навсегда.
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      c.header('Cache-Control', 'no-cache');
    }
  });
  app.use('/*', serveStatic({ root: staticDir }));
  app.get('/assets/*', (c) => c.text('Not found', 404));
  // SPA: любой другой неизвестный путь отдаёт index.html, дальше маршрутизирует фронт.
  app.get('*', serveStatic({ root: staticDir, path: 'index.html' }));
}
