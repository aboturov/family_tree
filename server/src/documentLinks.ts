import type { Db } from './db.ts';
import { audit } from './journal.ts';

// Связи документов с людьми и событиями. Отдельно от documents.ts: их снимают и переносят
// правка людей и событий, слияние и откат — без зависимости от остального кода документов.

export type DocumentLinks = {
  persons: { person_id: number; role: string; position: number }[];
  events: number[];
};

export function documentLinks(db: Db, documentId: number): DocumentLinks {
  const persons = db
    .prepare('SELECT person_id, role, position FROM document_persons WHERE document_id = ? ORDER BY position, person_id')
    .all(documentId) as DocumentLinks['persons'];
  const events = (
    db.prepare('SELECT event_id FROM document_events WHERE document_id = ? ORDER BY event_id').all(documentId) as {
      event_id: number;
    }[]
  ).map((r) => r.event_id);
  return { persons: persons.map((p) => ({ ...p })), events };
}

export function setDocumentLinks(db: Db, documentId: number, links: DocumentLinks) {
  db.prepare('DELETE FROM document_persons WHERE document_id = ?').run(documentId);
  db.prepare('DELETE FROM document_events WHERE document_id = ?').run(documentId);
  for (const p of links.persons) {
    db.prepare('INSERT INTO document_persons (document_id, person_id, role, position) VALUES (?, ?, ?, ?)').run(
      documentId,
      p.person_id,
      p.role,
      p.position,
    );
  }
  for (const eventId of links.events) {
    db.prepare('INSERT INTO document_events (document_id, event_id) VALUES (?, ?)').run(documentId, eventId);
  }
}

/**
 * Откат: связи из журнала — кроме людей и событий, которых в дереве уже нет (их удалили
 * позже, и откат удаления вернёт связь своей записью).
 */
export function restoreDocumentLinks(db: Db, documentId: number, links: DocumentLinks) {
  const exists = (table: string, id: number) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  setDocumentLinks(db, documentId, {
    persons: links.persons.filter((p) => exists('persons', p.person_id)),
    events: links.events.filter((e) => exists('events', e)),
  });
}

/**
 * Людей и события удаляют каскадом вместе с их связями с документами — молча, и откат удаления
 * связи бы не вернул. Поэтому перед удалением снимаем связи сами и пишем это в журнал правкой
 * документа: откат той же правки вернёт и их.
 */
export function detachDocuments(db: Db, userId: number | null, target: { persons?: number[]; events?: number[] }) {
  const persons = target.persons ?? [];
  const events = target.events ?? [];
  if (!persons.length && !events.length) return;
  const list = (ids: number[]) => ids.map(Number).join(',') || 'NULL';
  const documents = (
    db
      .prepare(
        `SELECT document_id FROM document_persons WHERE person_id IN (${list(persons)})
         UNION SELECT document_id FROM document_events WHERE event_id IN (${list(events)})`,
      )
      .all() as { document_id: number }[]
  ).map((r) => r.document_id);
  for (const documentId of documents) {
    const before = documentLinks(db, documentId);
    const after: DocumentLinks = {
      persons: before.persons.filter((p) => !persons.includes(p.person_id)),
      events: before.events.filter((e) => !events.includes(e)),
    };
    setDocumentLinks(db, documentId, after);
    db.prepare('UPDATE documents SET version = version + 1 WHERE id = ?').run(documentId);
    audit(db, userId, 'document', documentId, 'update', before, after);
  }
}

/** События человека и семьи — что ещё уйдёт каскадом вместе с ними. */
export const personEventIds = (db: Db, personId: number) =>
  (db.prepare('SELECT id FROM events WHERE person_id = ?').all(personId) as { id: number }[]).map((r) => r.id);
export const familyEventIds = (db: Db, familyId: number) =>
  (db.prepare('SELECT id FROM events WHERE family_id = ?').all(familyId) as { id: number }[]).map((r) => r.id);

/** Слияние дублей: документы дубля переходят к оставшемуся (его роль, если были оба, важнее). */
export function moveDocumentPersons(db: Db, fromId: number, toId: number) {
  db.prepare('UPDATE OR IGNORE document_persons SET person_id = ? WHERE person_id = ?').run(toId, fromId);
  db.prepare('DELETE FROM document_persons WHERE person_id = ?').run(fromId);
}

/** Из двух одинаковых событий остаётся одно — документы удалённого переходят к нему. */
export function moveDocumentEvents(db: Db, fromId: number, toId: number) {
  db.prepare('UPDATE OR IGNORE document_events SET event_id = ? WHERE event_id = ?').run(toId, fromId);
  db.prepare('DELETE FROM document_events WHERE event_id = ?').run(fromId);
}
