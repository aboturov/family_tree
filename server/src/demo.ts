// npm run demo — сервер на вымышленной семье из examples/demo.ged, чтобы попробовать дерево без
// своих данных. База отдельная (data/demo), настоящую не трогает; --reset начинает демо заново.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.ts';
import { importGedcom, isTreeEmpty } from './import.ts';
import { findPersonId } from './merge.ts';
import { createUser, findUserByLogin, setPassword, setUserPerson } from './users.ts';

const LOGIN = 'demo';
const PASSWORD = 'demo';
// Дмитрий Сергеевич Орлов: от него дерево открывается по умолчанию.
const DEMO_PERSON = 'I42';

const dataDir = path.resolve('data/demo');
if (process.argv.includes('--reset')) fs.rmSync(dataDir, { recursive: true, force: true });

const db = openDb(path.join(dataDir, 'tree.db'));
if (isTreeEmpty(db)) {
  const report = importGedcom(db, fs.readFileSync(new URL('../../examples/demo.ged', import.meta.url), 'utf8'));
  console.log(`Демо-дерево: людей ${report.persons}, семей ${report.families}, событий ${report.events}`);
}
if (!findUserByLogin(db, LOGIN)) {
  const user = await createUser(db, LOGIN, 'editor', PASSWORD);
  await setPassword(db, user.id, PASSWORD, { temporary: false });
  setUserPerson(db, user.id, findPersonId(db, DEMO_PERSON) ?? null);
}
db.close();

// Сервер читает каталог данных из окружения при загрузке — поэтому импортируем его только сейчас.
process.env.DATA_DIR = dataDir;
await import('./index.ts');
console.log(`Демо: http://localhost:${process.env.PORT ?? 3000}, вход ${LOGIN} / ${PASSWORD}`);
