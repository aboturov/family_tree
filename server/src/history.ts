import type { Db } from './db.ts';
import { EditError } from './editing.ts';
import { audit, recordChange, type AuditEntity } from './journal.ts';
import { restoreMediaFiles, trashMediaFiles } from './media.ts';

// История правок и их откат. Откат идёт по строкам audit_log правки в обратном порядке:
// созданное удаляется, удалённое возвращается из снимка, изменённое — к состоянию «до».
// Откатить можно, только пока те же записи никто не менял после этой правки.

// Слияние меняет слишком много неявно (семьи пары, события) — его не откатываем.
const UNDOABLE = new Set([
  'person.update',
  'person.delete',
  'relative.add',
  'link.remove',
  'event.add',
  'event.update',
  'event.delete',
  'media.add',
  'media.update',
  'media.delete',
  'avatar.set',
]);

export type HistoryItem = {
  id: number;
  at: string;
  user: string | null;
  userId: number | null;
  action: string;
  personId: number | null;
  details: Record<string, unknown>;
  undoneBy: { id: number; at: string; user: string | null } | null;
  /** Откат возможен по самой правке (права пользователя проверяются отдельно). */
  undoable: boolean;
};

type ChangeRow = {
  id: number;
  at: string;
  user_id: number | null;
  login: string | null;
  action: string;
  person_id: number | null;
  details: string;
  undone_by: number | null;
  undone_at: string | null;
  undone_login: string | null;
};

const SELECT_CHANGES = `
  SELECT c.id, c.at, c.user_id, u.login, c.action, c.person_id, c.details, c.undone_by,
         x.at AS undone_at, xu.login AS undone_login
  FROM changes c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN changes x ON x.id = c.undone_by
  LEFT JOIN users xu ON xu.id = x.user_id`;

/** Правки новее — первыми; before — id, с которого продолжить список. */
export function listChanges(db: Db, { before, limit = 50, personId }: { before?: number; limit?: number; personId?: number }) {
  const rows = db
    .prepare(
      `${SELECT_CHANGES}
       WHERE c.id < ?1 AND (?2 IS NULL OR c.person_id = ?2 OR c.details LIKE '%"id":' || ?2 || ',%')
       ORDER BY c.id DESC LIMIT ?3`,
    )
    .all(before ?? Number.MAX_SAFE_INTEGER, personId ?? null, limit + 1) as ChangeRow[];
  const items = rows.slice(0, limit).map((row) => toItem(db, row));
  return { items, hasMore: rows.length > limit };
}

function toItem(db: Db, row: ChangeRow): HistoryItem {
  return {
    id: row.id,
    at: row.at,
    user: row.login,
    userId: row.user_id,
    action: row.action,
    personId: row.person_id,
    details: JSON.parse(row.details),
    undoneBy: row.undone_by !== null ? { id: row.undone_by, at: row.undone_at!, user: row.undone_login } : null,
    undoable: row.undone_by === null && UNDOABLE.has(row.action) && canRevert(db, row),
  };
}

/** Трогал ли кто-то те же записи после этой правки (не считая отменённых правок и самих отмен). */
function laterConflict(db: Db, changeId: number): boolean {
  const hit = db
    .prepare(
      `SELECT 1 FROM audit_log a JOIN changes c ON c.id = a.change_id
       WHERE a.id > (SELECT max(id) FROM audit_log WHERE change_id = ?1)
         AND c.undone_by IS NULL AND c.action != 'undo' AND a.entity != 'place'
         AND EXISTS (SELECT 1 FROM audit_log b WHERE b.change_id = ?1 AND b.entity = a.entity AND b.entity_id = a.entity_id)
       LIMIT 1`,
    )
    .get(changeId);
  return hit !== undefined;
}

function canRevert(db: Db, row: ChangeRow): boolean {
  // Привязка существующего человека могла слить семьи пары — такое не откатываем.
  if (row.action === 'relative.add' && !JSON.parse(row.details).created) return false;
  return !laterConflict(db, row.id);
}

type AuditRow = {
  id: number;
  entity: AuditEntity;
  entity_id: number;
  action: 'create' | 'update' | 'delete';
  before: string | null;
  after: string | null;
};

const PERSON_COLUMNS = [
  'given_name',
  'patronymic',
  'surname',
  'birth_surname',
  'sex',
  'is_uncertain',
  'bio',
  'avatar_media_id',
  'avatar_crop',
];
const EVENT_COLUMNS = [
  'person_id',
  'family_id',
  'type',
  'custom_type',
  'date_modifier',
  'date_value',
  'date_value_to',
  'date_text',
  'place_id',
  'note',
];

const TABLES: Record<Exclude<AuditEntity, 'place'>, string> = {
  person: 'persons',
  family: 'families',
  event: 'events',
  media: 'media',
};

function insertRow(db: Db, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...(columns.map((c) => row[c]) as (string | number | null)[]),
  );
}

/** Вернуть колонки из снимка «до» (только разрешённые). */
function restoreColumns(db: Db, table: string, id: number, before: Record<string, unknown>, allowed: string[]) {
  const columns = allowed.filter((c) => c in before);
  if (!columns.length) return;
  db.prepare(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...(columns.map((c) => before[c]) as (string | number | null)[]),
    id,
  );
}

type FamilySnapshot = { partners: [number | null, number | null]; children: number[]; events?: Record<string, unknown>[] };

function restoreFamilyLinks(db: Db, id: number, snap: FamilySnapshot) {
  db.prepare('UPDATE families SET partner1_id = ?, partner2_id = ? WHERE id = ?').run(snap.partners[0], snap.partners[1], id);
  const current = (db.prepare('SELECT child_id FROM family_children WHERE family_id = ?').all(id) as { child_id: number }[]).map(
    (r) => r.child_id,
  );
  for (const child of current) {
    if (!snap.children.includes(child)) {
      db.prepare('DELETE FROM family_children WHERE family_id = ? AND child_id = ?').run(id, child);
    }
  }
  snap.children.forEach((child, position) =>
    db.prepare('INSERT OR IGNORE INTO family_children (family_id, child_id, position) VALUES (?, ?, ?)').run(id, child, position),
  );
}

type Files = { restore: number[]; trash: number[] };

// Событие поменялось — у его владельца новая версия, чтобы открытые формы не затёрли откат.
function bumpEventOwner(db: Db, event: Record<string, unknown> | undefined) {
  if (!event) return;
  if (event.person_id != null) db.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(event.person_id as number);
  if (event.family_id != null) db.prepare('UPDATE families SET version = version + 1 WHERE id = ?').run(event.family_id as number);
}

function revertRow(db: Db, userId: number, row: AuditRow, files: Files) {
  if (row.entity === 'place') return; // места общие — остаются
  const table = TABLES[row.entity];
  const before = row.before ? (JSON.parse(row.before) as Record<string, unknown>) : null;
  if (row.entity === 'event') {
    bumpEventOwner(db, (db.prepare('SELECT * FROM events WHERE id = ?').get(row.entity_id) as Record<string, unknown>) ?? before ?? undefined);
  }

  if (row.action === 'create') {
    const snapshot = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.entity_id);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.entity_id);
    if (row.entity === 'media') files.trash.push(row.entity_id);
    audit(db, userId, row.entity, row.entity_id, 'delete', snapshot ?? null, null);
    return;
  }

  if (row.action === 'update') {
    if (row.entity === 'person') restoreColumns(db, 'persons', row.entity_id, before!, PERSON_COLUMNS);
    if (row.entity === 'event') restoreColumns(db, 'events', row.entity_id, before!, EVENT_COLUMNS);
    if (row.entity === 'media') restoreColumns(db, 'media', row.entity_id, before!, ['caption']);
    if (row.entity === 'family') restoreFamilyLinks(db, row.entity_id, before as unknown as FamilySnapshot);
    if (row.entity === 'person' || row.entity === 'family') {
      db.prepare(`UPDATE ${table} SET version = version + 1 WHERE id = ?`).run(row.entity_id);
    }
    audit(db, userId, row.entity, row.entity_id, 'update', row.after ? JSON.parse(row.after) : null, before);
    return;
  }

  // delete — возвращаем из снимка
  if (row.entity === 'event' || row.entity === 'media') {
    insertRow(db, table, before!);
    if (row.entity === 'media') files.restore.push(row.entity_id);
  } else if (row.entity === 'family') {
    const snap = before as unknown as FamilySnapshot;
    db.prepare('INSERT INTO families (id, partner1_id, partner2_id) VALUES (?, ?, ?)').run(
      row.entity_id,
      snap.partners[0],
      snap.partners[1],
    );
    restoreFamilyLinks(db, row.entity_id, snap);
    for (const event of snap.events ?? []) insertRow(db, 'events', event);
  } else {
    const snap = before as {
      person: Record<string, unknown>;
      events: Record<string, unknown>[];
      media: (Record<string, unknown> | number)[];
      families: (FamilySnapshot & { id: number })[];
    };
    // Снимки до отказа от флага «умер» хранят is_deceased — теперь это событие смерти без даты.
    const { is_deceased: deceased, ...person } = snap.person;
    insertRow(db, 'persons', { ...person, version: Number(person.version ?? 1) + 1 });
    for (const event of snap.events) insertRow(db, 'events', event);
    if (deceased === 1 && !snap.events.some((e) => e.type === 'death')) {
      db.prepare("INSERT INTO events (person_id, type) VALUES (?, 'death')").run(row.entity_id);
    }
    for (const media of snap.media) {
      if (typeof media === 'number') continue; // старый формат снимка — без записи фото
      insertRow(db, 'media', media);
      files.restore.push(media.id as number);
    }
    // Связи — с семьями, которые остались; удалённые вернулись из своих строк журнала раньше.
    for (const family of snap.families) {
      const exists = db.prepare('SELECT partner1_id, partner2_id FROM families WHERE id = ?').get(family.id) as
        | { partner1_id: number | null; partner2_id: number | null }
        | undefined;
      if (!exists) continue;
      const slot = family.partners.indexOf(row.entity_id);
      if (slot === 0 && exists.partner1_id === null)
        db.prepare('UPDATE families SET partner1_id = ? WHERE id = ?').run(row.entity_id, family.id);
      if (slot === 1 && exists.partner2_id === null)
        db.prepare('UPDATE families SET partner2_id = ? WHERE id = ?').run(row.entity_id, family.id);
      if (family.children.includes(row.entity_id)) {
        db.prepare('INSERT OR IGNORE INTO family_children (family_id, child_id, position) VALUES (?, ?, ?)').run(
          family.id,
          row.entity_id,
          family.children.indexOf(row.entity_id),
        );
      }
    }
  }
  audit(db, userId, row.entity, row.entity_id, 'create', null, before);
}

/** Откатывает правку. Редактор может откатить свою правку, админ — любую. */
export function undoChange(db: Db, mediaDir: string, user: { id: number; role: string }, changeId: number) {
  const row = db.prepare(`${SELECT_CHANGES} WHERE c.id = ?`).get(changeId) as ChangeRow | undefined;
  if (!row) throw new EditError(404, 'Правка не найдена');
  if (user.role !== 'admin' && row.user_id !== user.id) {
    throw new EditError(400, 'Отменить чужую правку может только администратор');
  }
  if (row.undone_by !== null) throw new EditError(400, 'Эта правка уже отменена');
  if (!UNDOABLE.has(row.action)) throw new EditError(400, 'Такую правку отменить нельзя');
  if (!canRevert(db, row)) {
    throw new EditError(409, 'После этой правки те же записи уже меняли — сначала отмените более поздние правки');
  }

  const files: Files = { restore: [], trash: [] };
  recordChange(
    db,
    user.id,
    'undo',
    row.person_id,
    (undoId) => {
      // Порядок восстановления (человек после его семей и наоборот) не должен упираться во внешние ключи.
      db.exec('PRAGMA defer_foreign_keys = ON');
      const rows = db
        .prepare('SELECT id, entity, entity_id, action, before, after FROM audit_log WHERE change_id = ? ORDER BY id DESC')
        .all(changeId) as AuditRow[];
      try {
        for (const auditRow of rows) revertRow(db, user.id, auditRow, files);
      } catch (error) {
        if (error instanceof Error && /constraint/i.test(error.message)) {
          throw new EditError(409, 'Эту правку уже нельзя отменить: дерево с тех пор изменилось');
        }
        throw error;
      }
      db.prepare('UPDATE changes SET undone_by = ? WHERE id = ?').run(undoId, changeId);
    },
    () => ({ of: row.id, action: row.action, details: JSON.parse(row.details) }),
  );
  for (const id of files.trash) trashMediaFiles(mediaDir, id);
  for (const id of files.restore) restoreMediaFiles(mediaDir, id);
}
