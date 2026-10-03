// tree-admin — управление пользователями с сервера (docker compose exec app tree-admin ...).
// Почты нет, поэтому пароли выдаёт и сбрасывает администратор.
import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { config } from './config.ts';
import { openDb, type Db } from './db.ts';
import { planDocumentImport, runDocumentImport } from './documentImport.ts';
import { importGedcom } from './import.ts';
import { findPersonId, mergePersons } from './merge.ts';
import { generatePassword } from './passwords.ts';
import { deleteUserSessions } from './sessions.ts';
import {
  createUser,
  deleteUser,
  findUserByLogin,
  isRole,
  listUsers,
  ROLES,
  setPassword,
  setRole,
  setUserPerson,
} from './users.ts';

const USAGE = `tree-admin <команда>

  user:list                          список пользователей
  user:add <login> [--role viewer]   создать пользователя, напечатать временный пароль
  user:reset-password <login>        выдать новый временный пароль и завершить все сессии
  user:set-role <login> <role>       сменить роль (${ROLES.join(', ')})
  user:link <login> <person>         связать пользователя с человеком в дереве (id или ссылка из импорта, например I1)
  user:unlink <login>                убрать связь с человеком
  user:delete <login>                удалить пользователя
  db:backup [--keep 14]              снять копию базы в <DATA_DIR>/backups, оставить последние N

  import <file.ged> [--replace]      импортировать GEDCOM; --replace заменяет текущее дерево
  person:merge <keep> <drop>...      слить дубли в одного человека (id или ссылка из импорта, например I7)

  documents:import <manifest.json> [--dry-run] [--user <login>]
                                     загрузить документы со сканами по манифесту (формат — в
                                     server/src/documentImport.ts); --dry-run только проверяет,
                                     --user — от чьего имени правки в истории
`;

class CliError extends Error {}

async function main(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: 'string', default: 'viewer' },
      keep: { type: 'string', default: '14' },
      replace: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      user: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const db = openDb(path.join(config.dataDir, 'tree.db'));
  try {
    await run(db, command, args, {
      role: values.role!,
      keep: Number(values.keep),
      replace: values.replace!,
      dryRun: values['dry-run']!,
      user: values.user,
    });
  } finally {
    db.close();
  }
}

type Options = { role: string; keep: number; replace: boolean; dryRun: boolean; user: string | undefined };

async function run(db: Db, command: string, args: string[], options: Options) {
  switch (command) {
    case 'user:list': {
      const users = listUsers(db);
      if (users.length === 0) console.log('Пользователей нет. Создайте первого: tree-admin user:add <login> --role admin');
      for (const u of users) {
        const person = u.personId ? `\tчеловек #${u.personId}` : '';
        console.log(`${u.login}\t${u.role}${person}${u.mustChangePassword ? '\t(временный пароль)' : ''}`);
      }
      return;
    }
    case 'user:add': {
      const login = requireArg(args[0], 'login');
      if (!isRole(options.role)) throw new CliError(`Неизвестная роль "${options.role}". Доступны: ${ROLES.join(', ')}`);
      if (findUserByLogin(db, login)) throw new CliError(`Пользователь "${login}" уже существует`);
      const password = generatePassword();
      await createUser(db, login, options.role, password);
      console.log(`Создан ${login} (${options.role}). Временный пароль: ${password}`);
      console.log('При первом входе пароль попросят сменить.');
      return;
    }
    case 'user:reset-password': {
      const user = requireUser(db, args[0]);
      const password = generatePassword();
      await setPassword(db, user.id, password, { temporary: true });
      deleteUserSessions(db, user.id);
      console.log(`Новый временный пароль для ${user.login}: ${password}`);
      console.log('Все сессии пользователя завершены.');
      return;
    }
    case 'user:set-role': {
      const user = requireUser(db, args[0]);
      const role = requireArg(args[1], 'role');
      if (!isRole(role)) throw new CliError(`Неизвестная роль "${role}". Доступны: ${ROLES.join(', ')}`);
      setRole(db, user.id, role);
      console.log(`${user.login}: ${user.role} → ${role}`);
      return;
    }
    case 'user:link': {
      const user = requireUser(db, args[0]);
      const personRef = requireArg(args[1], 'person');
      const personId = requirePersonId(db, personRef);
      setUserPerson(db, user.id, personId);
      const { name } = db
        .prepare("SELECT trim(surname || ' ' || given_name || ' ' || patronymic) AS name FROM persons WHERE id = ?")
        .get(personId) as { name: string };
      console.log(`${user.login} — это ${name}`);
      return;
    }
    case 'user:unlink': {
      const user = requireUser(db, args[0]);
      setUserPerson(db, user.id, null);
      console.log(`${user.login} больше не связан с человеком в дереве`);
      return;
    }
    case 'user:delete': {
      const user = requireUser(db, args[0]);
      deleteUser(db, user.id);
      console.log(`Удалён ${user.login}`);
      return;
    }
    case 'db:backup': {
      if (!Number.isInteger(options.keep) || options.keep < 1) throw new CliError('--keep должен быть целым числом ≥ 1');
      const dir = path.join(config.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 23).replace(/[:.T]/g, '-');
      const file = path.join(dir, `tree-${stamp}.db`);
      // Онлайн-бэкап SQLite: безопасен, пока приложение пишет в базу.
      await backup(db, file);
      const old = fs
        .readdirSync(dir)
        .filter((name) => /^tree-.*\.db$/.test(name))
        .sort()
        .slice(0, -options.keep);
      for (const name of old) fs.rmSync(path.join(dir, name));
      console.log(`Бэкап: ${file}${old.length ? `, удалено старых: ${old.length}` : ''}`);
      return;
    }
    case 'import': {
      const file = requireArg(args[0], 'file.ged');
      if (!fs.existsSync(file)) throw new CliError(`Файл ${file} не найден`);
      const report = importGedcom(db, fs.readFileSync(file, 'utf8'), { replace: options.replace });
      console.log(
        `Импортировано: людей ${report.persons}, семей ${report.families}, событий ${report.events}, мест ${report.places}`,
      );
      if (report.warnings.length) {
        console.log(`\nПроверьте вручную (${report.warnings.length}):`);
        for (const warning of report.warnings) console.log(`  - ${warning}`);
      }
      return;
    }
    case 'person:merge': {
      const [keepRef, ...dropRefs] = args;
      requireArg(keepRef, 'keep');
      if (dropRefs.length === 0) requireArg(undefined, 'drop');
      const keepId = requirePersonId(db, keepRef);
      for (const dropRef of dropRefs) {
        mergePersons(db, keepId, requirePersonId(db, dropRef));
        console.log(`${dropRef} слит в ${keepRef}`);
      }
      return;
    }
    case 'documents:import': {
      const file = requireArg(args[0], 'manifest.json');
      if (!fs.existsSync(file)) throw new CliError(`Файл ${file} не найден`);
      const userId = options.user === undefined ? null : requireUser(db, options.user).id;
      const plan = planDocumentImport(db, file);
      for (const doc of plan.documents) {
        const { fields } = doc;
        console.log(
          `+ ${doc.uid}: ${fields.type}${fields.title ? ` «${fields.title}»` : ''}, сканов ${doc.files.length}, ` +
            `людей ${fields.persons.length}, событий ${fields.events.length}`,
        );
      }
      for (const uid of plan.skipped) console.log(`= ${uid}: уже загружен`);
      for (const warning of plan.warnings) console.log(`! ${warning}`);
      for (const error of plan.errors) console.log(`✗ ${error}`);
      if (plan.errors.length) throw new CliError(`Ошибок: ${plan.errors.length}. Ничего не загружено.`);
      if (options.dryRun) {
        console.log(`\nПроверка: к загрузке ${plan.documents.length}, уже загружено ${plan.skipped.length}.`);
        return;
      }
      const ids = runDocumentImport(db, config.mediaDir, plan, userId, (uid) => console.log(`  загружен ${uid}`));
      console.log(`\nЗагружено документов: ${ids.length}, пропущено: ${plan.skipped.length}.`);
      return;
    }
    default:
      throw new CliError(`Неизвестная команда "${command}"\n\n${USAGE}`);
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new CliError(`Не указан аргумент <${name}>\n\n${USAGE}`);
  return value;
}

function requirePersonId(db: Db, ref: string): number {
  const id = findPersonId(db, ref);
  if (id === undefined) throw new CliError(`Человек "${ref}" не найден`);
  return id;
}

function requireUser(db: Db, login: string | undefined) {
  const user = findUserByLogin(db, requireArg(login, 'login'));
  if (!user) throw new CliError(`Пользователь "${login}" не найден`);
  return user;
}

main(process.argv.slice(2)).catch((error) => {
  // Ошибки из логики (импорт, слияние) понятны по тексту; стектрейс — только для отладки.
  const verbose = process.env.TREE_DEBUG && !(error instanceof CliError);
  console.error(error instanceof Error && !verbose ? error.message : error);
  process.exit(1);
});
