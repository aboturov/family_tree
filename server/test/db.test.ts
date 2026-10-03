import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDb } from '../src/db.ts';
import { getTree } from '../src/tree.ts';

describe('миграции', () => {
  it('отметка «умер» становится событием смерти без даты', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'tree.db');
    let db = openDb(file);
    // База как до восьмой миграции: «умер» — флаг в карточке человека, старого стиля ещё нет.
    db.exec(`
      ALTER TABLE events DROP COLUMN date_calendar;
      ALTER TABLE persons ADD COLUMN is_deceased INTEGER NOT NULL DEFAULT 0;
      INSERT INTO persons (id, given_name, is_deceased) VALUES (1, 'Анна', 1), (2, 'Иван', 1), (3, 'Пётр', 0);
      INSERT INTO events (person_id, type, date_modifier, date_value) VALUES (2, 'death', 'exact', '1980');
      PRAGMA user_version = 7;
    `);
    db.close();

    db = openDb(file);
    assert.deepEqual(
      getTree(db).persons.map((p) => [p.givenName, p.isDeceased, p.events.map((e) => [e.type, e.date?.value ?? null])]),
      [
        ['Анна', true, [['death', null]]],
        ['Иван', true, [['death', '1980']]],
        ['Пётр', false, []],
      ],
    );
    const columns = db.prepare('PRAGMA table_info(persons)').all() as { name: string }[];
    assert.equal(columns.some((c) => c.name === 'is_deceased'), false);
    db.close();
  });
});
