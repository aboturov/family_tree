import type { MarriageStyle } from '../../web/src/tree/geometry.ts';
import { indexTree, type Tree, type TreeIndex } from '../../web/src/tree/model.ts';
import { selectView, type ViewMode } from '../../web/src/tree/views.ts';
import type { Db } from './db.ts';
import type { LayoutParams, LayoutService } from './layouts.ts';
import { getTree } from './tree.ts';
import type { OpenedView, ViewStats } from './viewStats.ts';

/**
 * Фоновый пересчёт ходовых видов: чтобы дерево почти всегда открывалось из кэша, а не считалось
 * при человеке. Запускается при старте сервера (после выкладки кэш пуст) и после правок — с
 * задержкой, чтобы серия правок пересчиталась один раз; новая правка во время пересчёта его
 * перезапускает. Правки не через сервер — tree-admin (привязал пользователя к человеку,
 * импортировал дерево) — замечаются по PRAGMA data_version: она меняется, когда в базу записало
 * другое подключение, а собственные записи сервера её не трогают.
 *
 * Что считается: для каждого, кто заходит в дерево, — «Семья», «Родня», «По родам» и «Всё дерево»
 * от него самого в обоих стилях браков (стиль выбирают в браузере, и какой у кого, сервер не
 * знает); дальше — популярные виды по счёту открытий (viewStats.ts): до POPULAR_WHOLE «Всего
 * дерева» и до POPULAR_LIGHT остальных. Лёгкие виды — миллисекунды, «Всё дерево» — секунды.
 *
 * Виды строятся так же, как на странице дерева (TreePage): тот же вид — та же подпись и тот же
 * ключ в кэше, и запрос из браузера берёт готовую раскладку.
 */
export type Precompute = {
  /** Пересчитать через delayMs; если пересчёт уже идёт — остановить его и начать заново. */
  schedule: () => void;
  /** Когда закончится текущий пересчёт (для тестов). */
  settled: () => Promise<void>;
  stop: () => void;
};

const MODES: ViewMode[] = ['family', 'relatives', 'clans', 'all'];
const STYLES: MarriageStyle[] = ['compact', 'bridges'];
// Глубина «Родни» по умолчанию (RELATIVES_DEPTHS в views.ts, TreePage).
const RELATIVES_DEPTH = 2;
// Сколько популярных видов считать заранее сверх видов каждого пользователя.
const POPULAR_WHOLE = 20;
const POPULAR_LIGHT = 60;

/** Раскладка вида — как её запрашивает TreePage. */
export function viewOf(tree: Tree, index: TreeIndex, { mode, centerId, depth, style }: OpenedView): LayoutParams {
  return {
    tree: mode === 'all' || mode === 'clans' ? tree : selectView(tree, index, mode, centerId, depth),
    algorithm: mode === 'clans' ? 'clans' : 'layered',
    spacing: mode === 'all' ? 'wide' : 'compact',
    untangle: mode === 'all',
    style,
    centerId,
  };
}

/** От кого смотрят дерево: люди, привязанные к пользователям; у кого привязки нет — первый в дереве. */
function centers(db: Db, tree: Tree): number[] {
  const known = new Set(tree.persons.map((p) => p.id));
  const linked = (db.prepare('SELECT person_id FROM users').all() as { person_id: number | null }[]).map(
    (u) => (u.person_id !== null && known.has(u.person_id) ? u.person_id : (tree.persons[0]?.id ?? null)),
  );
  return [...new Set(linked.filter((id): id is number => id !== null))];
}

/**
 * Что считать и в каком порядке: виды пользователей, потом популярные; сначала все лёгкие, потом
 * «Всё дерево» — оно дольше всего. Виды людей, которых в дереве уже нет, пропускаем.
 */
export function viewsToPrecompute(tree: Tree, users: number[], popular: OpenedView[]): OpenedView[] {
  const known = new Set(tree.persons.map((p) => p.id));
  const own = users.flatMap((centerId) =>
    MODES.flatMap((mode) => STYLES.map((style) => ({ mode, centerId, depth: RELATIVES_DEPTH, style }))),
  );
  // У видов, кроме «Родни», глубины нет — у одинаковых видов и ключ один.
  const keyOf = (v: OpenedView) => `${v.mode}|${v.centerId}|${v.mode === 'relatives' ? v.depth : ''}|${v.style}`;
  const seen = new Set(own.map(keyOf));
  const whole = popular.filter((v) => v.mode === 'all' && known.has(v.centerId) && !seen.has(keyOf(v)));
  const light = popular.filter((v) => v.mode !== 'all' && known.has(v.centerId) && !seen.has(keyOf(v)));
  return [
    ...own.filter((v) => v.mode !== 'all'),
    ...light.slice(0, POPULAR_LIGHT),
    ...own.filter((v) => v.mode === 'all'),
    ...whole.slice(0, POPULAR_WHOLE),
  ];
}

export function createPrecompute({
  db,
  layouts,
  delayMs,
  watchMs,
  stats,
}: {
  db: Db;
  layouts: LayoutService;
  delayMs: number;
  /** Счёт открытий видов: популярные тоже считаем заранее. */
  stats?: ViewStats;
  /** Как часто проверять, не записал ли в базу кто-то кроме сервера; без него — не проверять. */
  watchMs?: number;
}): Precompute {
  let timer: NodeJS.Timeout | undefined;
  let generation = 0;
  // Пересчёты идут друг за другом; waiting — назначенный, но ещё не начатый.
  let current: Promise<void> = Promise.resolve();
  let waiting: { promise: Promise<void>; resolve: () => void } | undefined;

  async function run(runGeneration: number) {
    try {
      const started = performance.now();
      const computedBefore = layouts.computed();
      const tree = getTree(db);
      const index = indexTree(tree);
      const views = viewsToPrecompute(tree, centers(db, tree), stats?.popular() ?? []);
      for (const view of views) {
        // Пришла новая правка — этот пересчёт уже не нужен, следующий начнётся по таймеру.
        if (runGeneration !== generation) return;
        await layouts.layout(viewOf(tree, index, view), { background: true });
      }
      const computed = layouts.computed() - computedBefore;
      if (computed)
        console.log(`Раскладки: посчитано ${computed} из ${views.length} видов за ${Math.round((performance.now() - started) / 1000)} с`);
    } catch (error) {
      console.error('Фоновый пересчёт раскладок:', error);
    }
  }

  function schedule() {
    const runGeneration = ++generation;
    clearTimeout(timer);
    if (!waiting) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      waiting = { promise, resolve };
    }
    const started = waiting;
    timer = setTimeout(() => {
      waiting = undefined;
      current = current.then(() => run(runGeneration));
      void current.then(started.resolve);
    }, delayMs);
  }

  const dataVersion = db.prepare('PRAGMA data_version');
  const readVersion = () => (dataVersion.get() as { data_version: number }).data_version;
  let seenVersion = readVersion();
  const watcher =
    watchMs === undefined
      ? undefined
      : setInterval(() => {
          const version = readVersion();
          if (version === seenVersion) return;
          seenVersion = version;
          schedule();
        }, watchMs);
  // Проверка сама процесс не держит: сервер и так живёт, а тесты и остановка её не ждут.
  watcher?.unref();

  return {
    schedule,
    settled: () => waiting?.promise ?? current,
    stop() {
      generation++;
      clearTimeout(timer);
      clearInterval(watcher);
      waiting?.resolve();
      waiting = undefined;
    },
  };
}
