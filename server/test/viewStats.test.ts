import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Person, Tree } from '../../web/src/tree/model.ts';
import { viewsToPrecompute } from '../src/precompute.ts';
import { createViewStats, parseOpenedView, type OpenedView } from '../src/viewStats.ts';

const DAY = 24 * 60 * 60 * 1000;

function withStats(run: (stats: ReturnType<typeof createViewStats>, clock: { at: number }) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  const clock = { at: Date.UTC(2026, 0, 1) };
  const stats = createViewStats({ file: path.join(dir, 'layouts.db'), now: () => clock.at });
  try {
    run(stats, clock);
  } finally {
    stats.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const view = (mode: OpenedView['mode'], centerId: number, style: OpenedView['style'] = 'compact', depth = 2) => ({
  mode,
  centerId,
  depth,
  style,
});

describe('счёт открытий видов', () => {
  it('чаще открывают — выше; давнее весит меньше свежего', () => {
    withStats((stats, clock) => {
      // Бабушку открывали трижды месяц назад, маму — дважды вчера.
      for (let i = 0; i < 3; i++) stats.opened(view('all', 49));
      clock.at += 29 * DAY;
      for (let i = 0; i < 2; i++) stats.opened(view('all', 60));
      clock.at += DAY;
      stats.opened(view('family', 1));
      assert.deepEqual(stats.popular(), [view('all', 60), view('family', 1), view('all', 49)]);
    });
  });

  it('давно не открытое забывается', () => {
    withStats((stats, clock) => {
      stats.opened(view('all', 49));
      clock.at += 60 * DAY;
      assert.deepEqual(stats.popular(), []);
    });
  });

  it('глубина важна только «Родне»; «от всех предков» переживает базу', () => {
    withStats((stats) => {
      stats.opened(view('family', 1, 'compact', 3));
      stats.opened(view('family', 1, 'compact', 5));
      stats.opened(view('relatives', 1, 'bridges', Infinity));
      assert.deepEqual(stats.popular(), [view('family', 1), view('relatives', 1, 'bridges', Infinity)]);
    });
  });

  it('вид из запроса раскладки: без поля не считаем, чепуха — ошибка', () => {
    const params = { centerId: 7, style: 'bridges' as const };
    assert.equal(parseOpenedView(undefined, params), undefined);
    assert.deepEqual(parseOpenedView({ mode: 'relatives', depth: null }, params), view('relatives', 7, 'bridges', Infinity));
    for (const bad of [null, 'all', { mode: 'spiral', depth: 2 }, { mode: 'all', depth: 7 }])
      assert.throws(() => parseOpenedView(bad, params));
  });
});

describe('что считать заранее', () => {
  const person = (id: number): Person => ({
    id,
    version: 1,
    avatar: null,
    photos: [],
    givenName: `P${id}`,
    patronymic: '',
    surname: '',
    birthSurname: '',
    sex: 'U',
    isDeceased: false,
    isUncertain: false,
    bio: '',
    events: [],
  });
  const tree: Tree = { persons: [1, 2, 3, 4].map(person), families: [] };

  it('сначала лёгкие виды пользователей и популярные, потом «Всё дерево»; без повторов и ушедших', () => {
    const popular = [view('all', 3), view('all', 1), view('relatives', 2, 'compact', 4), view('family', 1), view('all', 99)];
    const order = viewsToPrecompute(tree, [1], popular).map((v) => `${v.mode}:${v.centerId}:${v.style}`);
    assert.deepEqual(order, [
      'family:1:compact',
      'family:1:bridges',
      'relatives:1:compact',
      'relatives:1:bridges',
      'clans:1:compact',
      'clans:1:bridges',
      'relatives:2:compact',
      'all:1:compact',
      'all:1:bridges',
      'all:3:compact',
    ]);
  });

  it('популярных «Всего дерева» — не больше двадцати', () => {
    const everyone = { ...tree, persons: Array.from({ length: 30 }, (_, i) => person(i + 1)) };
    const popular = Array.from({ length: 30 }, (_, i) => view('all', i + 1));
    assert.deepEqual(
      viewsToPrecompute(everyone, [], popular).map((v) => v.centerId),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });
});
