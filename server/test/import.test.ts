import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createApp, SESSION_COOKIE } from '../src/app.ts';
import { openDb, type Db } from '../src/db.ts';
import { importGedcom } from '../src/import.ts';
import { findPersonId, mergePersons } from '../src/merge.ts';
import { getTree } from '../src/tree.ts';
import { createUser, setPassword } from '../src/users.ts';

const mediaDirForTests = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));

// Вымышленная семья в формате выгрузки familio: пустые BIRT, девичьи фамилии,
// дубль человека, двойной развод и семья с одним партнёром.
const GEDCOM = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 _UID uid-petr
1 NAME Пётр Ильич /Тестов/
1 SEX M
1 BIRT
2 DATE 1900
1 DEAT
2 _UID x
1 FAMS @F1@
0 @I2@ INDI
1 NAME Мария Ивановна /Тестова (Примерова)/
2 SURN Примерова
2 _MARNM Тестова
1 SEX F
1 BIRT
2 _UID empty-birth
1 NOTE Любила сад.
1 FAMS @F1@
0 @I3@ INDI
1 NAME Иван Петрович /Тестов/
1 SEX M
1 BIRT
2 DATE 12 MAR 1925
2 PLAC Деревня Примерово
3 MAP
4 LATI N57.5
4 LONG E40.1
1 FAMC @F1@
0 @I4@ INDI
1 NAME Пётр Ильич /Тестов/
1 SEX M
1 DEAT
2 DATE 1970
2 PLAC Деревня Примерово
1 FAMS @F2@
0 @I5@ INDI
1 NAME Ольга ??? /Тестова/
1 SEX F
1 FAMS @F3@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE AUG 1924
1 DIV
2 _UID same
1 DIV
2 _UID same
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I4@
1 WIFE @I2@
1 CHIL @I3@
0 @F3@ FAM
1 WIFE @I5@
1 MARR
0 TRLR
`;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

const person = (ref: string) => {
  const tree = getTree(db);
  return tree.persons.find((p) => p.id === findPersonId(db, ref))!;
};

describe('importGedcom', () => {
  it('переносит людей, семьи и места', () => {
    const report = importGedcom(db, GEDCOM);
    assert.deepEqual(
      { persons: report.persons, families: report.families, places: report.places },
      { persons: 5, families: 3, places: 1 },
    );

    const maria = person('I2');
    assert.equal(maria.surname, 'Тестова');
    assert.equal(maria.birthSurname, 'Примерова');
    assert.equal(maria.patronymic, 'Ивановна');
    assert.equal(maria.bio, 'Любила сад.');
    // Пустое BIRT из familio событием не становится.
    assert.deepEqual(maria.events, []);

    const ivan = person('I3');
    assert.deepEqual(ivan.events[0].date, { modifier: 'exact', value: '1925-03-12' });
    assert.deepEqual(ivan.events[0].place, { name: 'Деревня Примерово', lat: 57.5, lon: 40.1 });
  });

  it('пустая запись о смерти — событие без даты: «умер, дата неизвестна»', () => {
    importGedcom(db, GEDCOM);
    const petr = person('I1');
    assert.equal(petr.isDeceased, true);
    assert.deepEqual(
      petr.events.map((e) => [e.type, e.date]),
      [
        ['birth', { modifier: 'exact', value: '1900' }],
        ['death', null],
      ],
    );
  });

  it('убирает двойной развод, оставляет пустой развод как факт', () => {
    const report = importGedcom(db, GEDCOM);
    const family = getTree(db).families[0];
    assert.deepEqual(
      family.events.map((e) => e.type),
      ['marriage', 'divorce'],
    );
    assert.ok(report.warnings.some((w) => w.includes('F1: повторное событие DIV')));
  });

  it('сообщает о подозрительном: дубли, один партнёр, «???»', () => {
    const { warnings } = importGedcom(db, GEDCOM);
    assert.ok(warnings.some((w) => w.startsWith('Возможный дубль: I1, I4')));
    assert.ok(warnings.some((w) => w.includes('F3: известен только один партнёр')));
    assert.ok(warnings.some((w) => w.startsWith('I5 Ольга Тестова: в имени есть «?»')));
    assert.equal(person('I5').isUncertain, true);
  });

  it('не затирает существующее дерево без replace', () => {
    importGedcom(db, GEDCOM);
    assert.throws(() => importGedcom(db, GEDCOM), /--replace/);
    assert.equal(importGedcom(db, GEDCOM, { replace: true }).persons, 5);
    assert.equal(getTree(db).persons.length, 5);
  });
});

describe('mergePersons', () => {
  it('сливает дубль: события дополняются, семьи одной пары объединяются', () => {
    importGedcom(db, GEDCOM);
    mergePersons(db, findPersonId(db, 'I1')!, findPersonId(db, 'I4')!);

    const tree = getTree(db);
    assert.equal(tree.persons.length, 4);
    const petr = person('I1');
    assert.deepEqual(
      petr.events.map((e) => [e.type, e.date?.value, e.place?.name]),
      [
        ['birth', '1900', undefined],
        ['death', '1970', 'Деревня Примерово'],
      ],
    );

    const families = tree.families.filter((f) => f.partners.includes(petr.id));
    assert.equal(families.length, 1);
    assert.deepEqual(
      families[0].children.map((c) => c.id),
      [findPersonId(db, 'I3')],
    );
  });

  it('не сливает людей разного пола', () => {
    importGedcom(db, GEDCOM);
    assert.throws(() => mergePersons(db, findPersonId(db, 'I1')!, findPersonId(db, 'I2')!), /разный пол/);
    assert.equal(getTree(db).persons.length, 5);
  });
});

describe('GET /api/tree', () => {
  it('отдаёт дерево только после входа', async () => {
    importGedcom(db, GEDCOM);
    const app = createApp({ db, mediaDir: mediaDirForTests, secureCookies: false, sessionTtlDays: 30 });
    assert.equal((await app.request('/api/tree')).status, 401);

    const user = await createUser(db, 'olga', 'viewer', 'temp-password');
    await setPassword(db, user.id, 'long-password', { temporary: false });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'olga', password: 'long-password' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.ok(cookie.startsWith(SESSION_COOKIE));

    const res = await app.request('/api/tree', { headers: { cookie } });
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.equal(tree.persons.length, 5);
    assert.equal(tree.families.length, 3);
  });
});

describe('демо-дерево (examples/demo.ged)', () => {
  it('импортируется целиком: все даты разобраны, ссылки целы', () => {
    const report = importGedcom(db, fs.readFileSync(new URL('../../examples/demo.ged', import.meta.url), 'utf8'));
    assert.equal(report.persons, 71);
    assert.equal(report.families, 30);
    // Ожидаемые предупреждения — только те, что показывают разбор отчёта: «???» и семьи с одним родителем.
    assert.deepEqual(
      report.warnings.filter((w) => !/помечен «данные под вопросом»|известен только один партнёр/.test(w)),
      [],
    );
    assert.equal(person('I42').givenName, 'Дмитрий');
    assert.equal(person('I13').birthSurname, 'Волкова');
  });
});
