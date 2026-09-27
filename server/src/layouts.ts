import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { Layout, LayoutAlgorithm, MarriageStyle, RowSpacing } from '../../web/src/tree/geometry.ts';
import type { Tree } from '../../web/src/tree/model.ts';
import { pickLayout, seedCount, type SeedResult } from '../../web/src/tree/seeds.ts';
import { layoutSignature } from '../../web/src/tree/signature.ts';
import { EditError } from './editing.ts';

/**
 * Раскладки дерева считает сервер, а не браузер: дерево у семьи одно, и раскладку вида достаточно
 * посчитать один раз — дальше её получают все, на любом устройстве, сразу. Код раскладки общий
 * с веб-клиентом (web/src/tree), ELK работает в нескольких потоках: каждое зерно (seeds.ts)
 * считается в своём, лучший итог выбирает pickLayout.
 *
 * Готовые раскладки лежат в отдельной базе (layouts.db): это кэш, его всегда можно посчитать
 * заново, и в бэкапы tree.db он не попадает.
 */

/** Что раскладывать: вид дерева (уже выбранный клиентом, views.ts) и настройки схемы. */
export type LayoutParams = {
  tree: Tree;
  algorithm: LayoutAlgorithm;
  spacing: RowSpacing;
  /** «Всё дерево»: распутывать пары крест-накрест, линии рода центра — прямее. */
  untangle: boolean;
  style: MarriageStyle;
  centerId: number | null;
  /** Прошлые позиции людей [id, x] — после правки дерево не перетасовывается. */
  previous?: [number, number][];
};

/** Задание потоку: одно зерно (номер в SEEDS) или «По родам», у которого зёрен нет. */
export type LayoutJob = LayoutParams & { id: number; seed: number };
export type LayoutJobResult = { id: number; layout?: Layout; result?: SeedResult; error?: string };

export type LayoutService = {
  /** background — фоновый пересчёт (precompute.ts): его задания ждут, пока посчитаются запросы людей. */
  layout: (params: LayoutParams, options?: { background?: boolean }) => Promise<Layout>;
  /** Сколько раскладок посчитано, а не взято из кэша. */
  computed: () => number;
  close: () => Promise<void>;
};

const TREE_DIR = new URL('../../web/src/tree/', import.meta.url);
// Сколько раскладок держим: в памяти — самые ходовые, в базе — с запасом на всех и все виды.
const MEMORY_KEPT = 32;
const STORED_KEPT = 1000;

/**
 * Версия кода раскладки — хэш её исходников и версии ELK. Раскладки, посчитанные другой версией,
 * в кэше не подходят: после выкладки нового кода всё считается заново.
 */
function codeVersion(): string {
  const hash = createHash('sha256');
  for (const name of fs.readdirSync(TREE_DIR).filter((n) => n.endsWith('.ts')).sort())
    hash.update(name).update(fs.readFileSync(new URL(name, TREE_DIR)));
  const elk = createRequire(import.meta.url).resolve('elkjs/package.json');
  hash.update(JSON.parse(fs.readFileSync(elk, 'utf8')).version);
  return hash.digest('hex').slice(0, 16);
}

export function createLayoutService({ cacheFile, threads }: { cacheFile: string; threads: number }): LayoutService {
  const version = codeVersion();
  const cache = new DatabaseSync(cacheFile);
  cache.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS layouts (
      key TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      layout TEXT NOT NULL,
      used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS layouts_used_at ON layouts(used_at);
  `);
  cache.prepare('DELETE FROM layouts WHERE version != ?').run(version);
  const read = cache.prepare('SELECT layout FROM layouts WHERE key = ?');
  const touch = cache.prepare('UPDATE layouts SET used_at = ? WHERE key = ?');
  const write = cache.prepare('INSERT OR REPLACE INTO layouts (key, version, layout, used_at) VALUES (?, ?, ?, ?)');
  const prune = cache.prepare(
    'DELETE FROM layouts WHERE key IN (SELECT key FROM layouts ORDER BY used_at DESC LIMIT -1 OFFSET ?)',
  );

  const memory = new Map<string, Layout>();
  const remember = (key: string, layout: Layout) => {
    memory.delete(key);
    memory.set(key, layout);
    if (memory.size > MEMORY_KEPT) memory.delete(memory.keys().next().value!);
  };
  // Один и тот же вид, запрошенный одновременно (двое открыли дерево), считается один раз. Если
  // человек ждёт вид, который считается в фоне, расчёт встаёт в очередь наравне с запросами людей.
  const running = new Map<string, { promise: Promise<Layout>; task: Task }>();
  const pool = createPool(threads);

  let computed = 0;
  async function compute(params: LayoutParams, task: Task): Promise<Layout> {
    computed++;
    const { tree, algorithm, centerId, previous } = params;
    const count = algorithm === 'clans' ? 1 : seedCount(tree, centerId, (previous?.length ?? 0) > 0);
    const results = await Promise.all(
      Array.from({ length: count }, (_, seed) => pool.run({ ...params, id: 0, seed }, task)),
    );
    return algorithm === 'clans' ? results[0].layout! : pickLayout(results.map((r) => r.result!));
  }

  const keyOf = ({ tree, algorithm, spacing, untangle, style, centerId }: LayoutParams) =>
    createHash('sha256')
      .update(JSON.stringify([version, algorithm, spacing, untangle, style, centerId]))
      .update(layoutSignature(tree))
      .digest('hex');
  const cached = (key: string): Layout | undefined => {
    const known = memory.get(key);
    if (known) {
      remember(key, known);
      return known;
    }
    const stored = read.get(key) as { layout: string } | undefined;
    if (!stored) return undefined;
    touch.run(Date.now(), key);
    const layout = JSON.parse(stored.layout) as Layout;
    remember(key, layout);
    return layout;
  };
  const save = (key: string, layout: Layout) => {
    remember(key, layout);
    write.run(key, version, JSON.stringify(layout), Date.now());
    prune.run(STORED_KEPT);
    return layout;
  };
  return {
    async layout(params, { background = false } = {}) {
      // После правки — раскладка для того, кто правил (KEPT_SEEDS в seeds.ts); в общий кэш её не
      // кладём: раскладку того же вида по всем зёрнам посчитает фоновый пересчёт.
      if (params.previous?.length) return compute(params, { background });
      const key = keyOf(params);
      const known = cached(key);
      if (known) return known;
      const pending = running.get(key);
      if (pending) {
        if (!background) pending.task.background = false;
        return pending.promise;
      }
      const task = { background };
      const work = compute(params, task)
        .then((layout) => save(key, layout))
        .finally(() => running.delete(key));
      running.set(key, { promise: work, task });
      return work;
    },
    computed: () => computed,
    async close() {
      await pool.close();
      cache.close();
    },
  };
}

/** Расчёт одного вида; его задания в очередях потоков — фоновые, пока его не ждёт человек. */
type Task = { background: boolean };

/**
 * Потоки раскладки. Зерно всегда считает один и тот же поток — у него в памяти прогоны ELK без
 * центра (layout.ts), и дерево от другого человека их не повторяет. Задание уходит в поток, когда
 * тот свободен; первыми — задания, которых ждут люди, фоновые — после них. Пока поток работает,
 * он держит процесс; свободный — нет (тесты и остановка сервера его не ждут). Упавший поток
 * заменяется новым.
 */
function createPool(size: number) {
  type Job = { message: LayoutJob; task: Task; done: (result: LayoutJobResult) => void };
  type Slot = { worker: Worker; queue: Job[]; running?: Job };
  let nextId = 1;
  let slots: Slot[] | undefined;
  let closing = false;

  const start = (slot: Slot) => {
    let failure: string | undefined;
    slot.worker = new Worker(new URL('./layoutThread.ts', import.meta.url));
    slot.worker.unref();
    slot.worker.on('message', (result: LayoutJobResult) => finish(slot, result));
    slot.worker.on('error', (error) => (failure = error.stack ?? error.message));
    slot.worker.on('exit', (code) => {
      if (closing) return;
      const job = slot.running;
      slot.running = undefined;
      job?.done({ id: 0, error: failure ?? `Поток раскладки завершился с кодом ${code}` });
      start(slot);
      next(slot);
    });
  };
  const finish = (slot: Slot, result: LayoutJobResult) => {
    const job = slot.running;
    slot.running = undefined;
    job?.done(result);
    next(slot);
  };
  const next = (slot: Slot) => {
    if (slot.running) return;
    if (!slot.queue.length) {
      slot.worker.unref();
      return;
    }
    const urgent = slot.queue.findIndex((j) => !j.task.background);
    const [job] = slot.queue.splice(Math.max(urgent, 0), 1);
    slot.running = job;
    slot.worker.ref();
    slot.worker.postMessage(job.message);
  };
  const getSlots = () =>
    (slots ??= Array.from({ length: Math.max(1, size) }, () => {
      const slot = { queue: [] } as unknown as Slot;
      start(slot);
      return slot;
    }));

  return {
    run(message: LayoutJob, task: Task): Promise<LayoutJobResult> {
      const all = getSlots();
      const slot = all[message.seed % all.length];
      return new Promise((resolve, reject) => {
        slot.queue.push({
          message: { ...message, id: nextId++ },
          task,
          done: (result) => (result.error === undefined ? resolve(result) : reject(new Error(result.error))),
        });
        next(slot);
      });
    },
    async close() {
      closing = true;
      await Promise.all((slots ?? []).map((slot) => slot.worker.terminate()));
      slots = undefined;
    },
  };
}

const ALGORITHMS: LayoutAlgorithm[] = ['layered', 'clans'];
const SPACINGS: RowSpacing[] = ['compact', 'wide'];
const STYLES: MarriageStyle[] = ['compact', 'bridges'];
const isId = (value: unknown) => Number.isInteger(value);

/** Запрос раскладки из тела POST /api/layout; форма проверяется, иначе поток упадёт на чепухе. */
export function parseLayoutParams(body: Record<string, unknown>): LayoutParams {
  const bad = () => new EditError(400, 'Неверный запрос раскладки');
  const { tree, algorithm, spacing, untangle, style, centerId, previous } = body as Record<string, unknown> & {
    tree: { persons?: unknown; families?: unknown } | undefined;
  };
  if (!ALGORITHMS.includes(algorithm as LayoutAlgorithm)) throw bad();
  if (!SPACINGS.includes(spacing as RowSpacing) || !STYLES.includes(style as MarriageStyle)) throw bad();
  if (typeof untangle !== 'boolean' || (centerId !== null && !isId(centerId))) throw bad();
  if (!tree || !Array.isArray(tree.persons) || !Array.isArray(tree.families)) throw bad();
  const persons = tree.persons as Record<string, unknown>[];
  const families = tree.families as Record<string, unknown>[];
  const personIds = new Set<unknown>();
  for (const p of persons) {
    if (!p || !isId(p.id) || typeof p.sex !== 'string' || !Array.isArray(p.events)) throw bad();
    personIds.add(p.id);
  }
  for (const f of families) {
    if (!f || !isId(f.id) || !Array.isArray(f.partners) || f.partners.length !== 2) throw bad();
    if (!f.partners.every((id) => id === null || personIds.has(id))) throw bad();
    if (!Array.isArray(f.children) || !f.children.every((c) => c && personIds.has(c.id))) throw bad();
    if (!Array.isArray(f.events)) throw bad();
  }
  if (previous !== undefined) {
    if (!Array.isArray(previous)) throw bad();
    if (!previous.every((p) => Array.isArray(p) && p.length === 2 && isId(p[0]) && Number.isFinite(p[1]))) throw bad();
  }
  return {
    tree: tree as Tree,
    algorithm: algorithm as LayoutAlgorithm,
    spacing: spacing as RowSpacing,
    untangle,
    style: style as MarriageStyle,
    centerId: centerId as number | null,
    ...(previous ? { previous: previous as [number, number][] } : {}),
  };
}
