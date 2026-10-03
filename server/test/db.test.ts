import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrate, openDb } from '../src/db.ts';
import { getTree } from '../src/tree.ts';

describe('миграции', () => {
  it('отметка «умер» становится событием смерти без даты', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'tree.db');
    // База как до восьмой миграции: «умер» — флаг в карточке человека.
    const old = new DatabaseSync(file);
    migrate(old, 7);
    old.exec(`
      INSERT INTO persons (id, given_name, is_deceased) VALUES (1, 'Анна', 1), (2, 'Иван', 1), (3, 'Пётр', 0);
      INSERT INTO events (person_id, type, date_modifier, date_value) VALUES (2, 'death', 'exact', '1980');
    `);
    old.close();

    const db = openDb(file);
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

  it('журнал переживает пересборку под документы', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'tree.db');
    const old = new DatabaseSync(file);
    migrate(old, 9);
    old.exec(`
      INSERT INTO changes (id, action, person_id) VALUES (1, 'person.update', 1);
      INSERT INTO audit_log (entity, entity_id, action, before, after, change_id)
        VALUES ('person', 1, 'update', '{"bio":""}', '{"bio":"био"}', 1);
    `);
    old.close();

    const db = openDb(file);
    assert.deepEqual(
      { ...(db.prepare('SELECT entity, entity_id, after, change_id FROM audit_log').get() as object) },
      { entity: 'person', entity_id: 1, after: '{"bio":"био"}', change_id: 1 },
    );
    db.exec("INSERT INTO audit_log (entity, entity_id, action) VALUES ('document_file', 1, 'create')");
    db.close();
  });
});
