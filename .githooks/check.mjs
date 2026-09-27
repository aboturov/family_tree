// Проверка перед коммитом: в добавленных строках, именах файлов, авторе и сообщении коммита
// не должно быть слов из личного списка (реальные имена, даты, домены — см. CLAUDE.md). Сам
// список лежит вне репозитория, иначе он раскрыл бы то, что прячет: ~/.config/family-tree/denylist
// или путь из FAMILY_TREE_DENYLIST. Строка списка — регулярное выражение без учёта регистра;
// # — комментарий. Нет списка — проверки нет. Перед push — проверка истории (ниже).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const [mode, messageFile] = process.argv.slice(2);

// pre-push: в клоне могут жить ветки с историей до публикации. Если в git config задан
// familytree.root — первый коммит публичной истории, — пушить можно только его потомков.
if (mode === 'pre-push') {
  let root = '';
  try {
    root = git('config', 'familytree.root');
  } catch {
    process.exit(0);
  }
  const zero = /^0+$/;
  for (const line of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const [localRef, localSha] = line.split(' ');
    if (zero.test(localSha)) continue;
    const roots = git('rev-list', '--max-parents=0', localSha).split('\n');
    if (roots.some((r) => r !== root)) {
      console.error(`${localRef}: история не начинается с публичного коммита ${root.slice(0, 7)} — push отменён.`);
      process.exit(1);
    }
  }
  process.exit(0);
}

const listFile = process.env.FAMILY_TREE_DENYLIST ?? path.join(os.homedir(), '.config', 'family-tree', 'denylist');
if (!fs.existsSync(listFile)) process.exit(0);

const patterns = fs
  .readFileSync(listFile, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => new RegExp(line, 'iu'));

const hits = [];
const check = (where, text) => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) hits.push(`${where}: «${match[0]}»`);
  }
};

if (mode === 'commit-msg') {
  const message = fs
    .readFileSync(messageFile, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'));
  message.forEach((line, i) => check(`сообщение коммита, строка ${i + 1}`, line));
} else if (mode === 'pre-commit') {
  // Имя и почта автора тоже публикуются — вместе с коммитом.
  check('автор коммита', git('var', 'GIT_AUTHOR_IDENT'));
  check('коммитер', git('var', 'GIT_COMMITTER_IDENT'));
  for (const file of git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean))
    check(`имя файла ${file}`, file);
  let file = '';
  let line = 0;
  for (const row of git('diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR').split('\n')) {
    if (row.startsWith('+++ ')) file = row.slice(row.startsWith('+++ b/') ? 6 : 4);
    else if (row.startsWith('@@')) line = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    else if (row.startsWith('+')) check(`${file}:${line++}`, row.slice(1));
  }
} else {
  console.error(`check.mjs: неизвестный режим «${mode}»`);
  process.exit(2);
}

if (hits.length) {
  console.error(`Найдены слова из личного списка (${listFile}):`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error('Замените их вымышленными (см. CLAUDE.md). Если это ложное срабатывание — поправьте список.');
  process.exit(1);
}
