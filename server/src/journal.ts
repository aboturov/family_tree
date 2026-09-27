import type { Db } from './db.ts';

// Журнал правок. Правка (таблица changes) — одно действие пользователя; audit_log — что именно
// изменилось внутри неё, с состоянием до и после. По этим строкам история откатывает правку.

export type AuditEntity = 'person' | 'family' | 'event' | 'place' | 'media';

export type ChangeAction =
  | 'person.add'
  | 'person.update'
  | 'person.delete'
  | 'person.merge'
  | 'relative.add'
  | 'link.remove'
  | 'event.add'
  | 'event.update'
  | 'event.delete'
  | 'media.add'
  | 'media.update'
  | 'media.delete'
  | 'avatar.set'
  | 'undo';

const depth = new WeakMap<Db, number>();
const currentChange = new WeakMap<Db, number>();

/** Транзакция; вложенный вызов выполняется внутри внешней. */
export function inTransaction<T>(db: Db, work: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try {
      return work();
    } finally {
      depth.set(db, level);
    }
  }
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    depth.set(db, 0);
  }
}

export function audit(
  db: Db,
  userId: number,
  entity: AuditEntity,
  entityId: number,
  action: 'create' | 'update' | 'delete',
  before: unknown,
  after: unknown,
) {
  db.prepare(
    'INSERT INTO audit_log (user_id, entity, entity_id, action, before, after, change_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    userId,
    entity,
    entityId,
    action,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    currentChange.get(db) ?? null,
  );
}

/**
 * Выполняет действие как одну правку. `details` вызывается после действия — в нём имена
 * и прочее, что нужно, чтобы история читалась по-человечески (и после удаления людей).
 */
export function recordChange<T>(
  db: Db,
  userId: number,
  action: ChangeAction,
  personId: number | null,
  work: (changeId: number) => T,
  details: (result: T) => Record<string, unknown> = () => ({}),
): T {
  return inTransaction(db, () => {
    const { id } = db
      .prepare('INSERT INTO changes (user_id, action, person_id) VALUES (?, ?, ?) RETURNING id')
      .get(userId, action, personId) as { id: number };
    currentChange.set(db, id);
    try {
      const result = work(id);
      db.prepare('UPDATE changes SET details = ? WHERE id = ?').run(JSON.stringify(details(result)), id);
      return result;
    } finally {
      currentChange.delete(db);
    }
  });
}

type PersonRef = { id: number; name: string; sex: 'M' | 'F' | 'U' };

/** Человек для истории: имя на момент правки. */
export function personRef(db: Db, id: number): PersonRef {
  const row = db.prepare('SELECT given_name, patronymic, surname, sex FROM persons WHERE id = ?').get(id) as
    | { given_name: string; patronymic: string; surname: string; sex: 'M' | 'F' | 'U' }
    | undefined;
  if (!row) return { id, name: 'без имени', sex: 'U' };
  const name = [row.surname, row.given_name, row.patronymic].filter(Boolean).join(' ') || 'без имени';
  return { id, name, sex: row.sex };
}
