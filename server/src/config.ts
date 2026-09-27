import os from 'node:os';
import path from 'node:path';

const isProduction = process.env.NODE_ENV === 'production';
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir,
  // Фото людей; попадают в бэкап вместе с data/.
  mediaDir: path.join(dataDir, 'media'),
  // Собранный фронт; в dev его отдаёт Vite, поэтому каталога может не быть.
  staticDir: path.resolve(process.env.STATIC_DIR ?? '../web/dist'),
  // За nginx с TLS cookie должна быть Secure; локально ходим по http.
  secureCookies: isProduction,
  sessionTtlDays: 30,
  // Потоки раскладки дерева (layouts.ts): на сервере живут и другие службы — два ядра оставляем им.
  layoutThreads: Number(process.env.LAYOUT_THREADS ?? Math.max(1, os.availableParallelism() - 2)),
  // Кэш раскладок — отдельная база: его всегда можно посчитать заново, в бэкапы он не идёт.
  layoutCache: path.join(dataDir, 'layouts.db'),
};
