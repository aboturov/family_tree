// Поток раскладки (layouts.ts): считает одно зерно или «По родам» и отдаёт итог основному потоку.
import { parentPort } from 'node:worker_threads';
import { layoutClans } from '../../web/src/tree/clans.ts';
import { layoutSeed } from '../../web/src/tree/layout.ts';
import type { LayoutJob, LayoutJobResult } from './layouts.ts';

const port = parentPort!;

port.on('message', async (job: LayoutJob) => {
  const { id, tree, algorithm, spacing, untangle, style, centerId, seed, previous } = job;
  let reply: LayoutJobResult;
  try {
    reply =
      algorithm === 'clans'
        ? { id, layout: layoutClans(tree, style) }
        : {
            id,
            result: await layoutSeed(tree, style, centerId, seed, previous ? new Map(previous) : undefined, {
              spacing,
              untangle,
            }),
          };
  } catch (error) {
    reply = { id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  port.postMessage(reply);
});
