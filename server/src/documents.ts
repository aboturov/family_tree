import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import { documentLinks, setDocumentLinks, type DocumentLinks } from './documentLinks.ts';
import { CONFLICT, EditError, parseDate, parseVersion, text, type DateFields } from './editing.ts';
import type { DateModifier } from './gedcom.ts';
import { isJpeg, readJpegInfo, stripMetadata } from './jpeg.ts';
import { audit, inTransaction, personRef } from './journal.ts';

// Документы: карточка (тип, дата, архив и шифр, расшифровка), сканы по порядку и связи с людьми
// и событиями. Скан и люди необязательны: документ заводят по шифру, а копию из архива и
// подтверждённое родство добавляют потом.

export const DOCUMENT_TYPES = [
  'metric_birth',
  'metric_marriage',
  'metric_death',
  'civil_birth',
  'civil_marriage',
  'civil_death',
  'civil_index',
  'census',
  'confession',
  'revision',
  'household',
  'investigation',
  'rehabilitation',
  'database',
  'certificate',
  'personal',
  'letter',
  'other',
] as const;

/** Кто человек в документе: о ком он, родители, жених и невеста, двор в переписи и ведомости. */
export const DOCUMENT_ROLES = ['subject', 'father', 'mother', 'groom', 'bride', 'head', 'member', 'mentioned'] as const;

export type DocumentFields = {
  type: string;
  title: string;
  date: DateFields | null;
  archive: string;
  fond: string;
  opis: string;
  delo: string;
  sheets: string;
  url: string;
  transcription: string;
  note: string;
  persons: { id: number; role: string }[];
  events: number[];
};

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

export function parseDocumentFields(body: Record<string, unknown>): DocumentFields {
  if (typeof body.type !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(body.type)) {
    throw new EditError(400, 'Неизвестный тип документа');
  }
  const url = text(body.url, 'Ссылка', 1000);
  // В ссылку могли бы вписать javascript: — пускаем только веб-адреса.
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new EditError(400, 'Ссылка должна начинаться с http:// или https://');

  const persons = body.persons ?? [];
  if (!Array.isArray(persons) || persons.length > 200) throw new EditError(400, 'Список людей документа');
  const seen = new Set<number>();
  for (const p of persons as Record<string, unknown>[]) {
    if (!p || !isId(p.id)) throw new EditError(400, 'Человек документа: нужен id');
    if (typeof p.role !== 'string' || !(DOCUMENT_ROLES as readonly string[]).includes(p.role)) {
      throw new EditError(400, 'Неизвестная роль человека в документе');
    }
    if (seen.has(p.id)) throw new EditError(400, 'Человек указан в документе дважды');
    seen.add(p.id);
  }
  const events = body.events ?? [];
  if (!Array.isArray(events) || !events.every(isId) || new Set(events).size !== events.length) {
    throw new EditError(400, 'Список событий документа');
  }

  return {
    type: body.type,
    title: text(body.title, 'Название', 300),
    date: parseDate(body.date),
    archive: text(body.archive, 'Архив', 300),
    fond: text(body.fond, 'Фонд', 50),
    opis: text(body.opis, 'Опись', 50),
    delo: text(body.delo, 'Дело', 50),
    sheets: text(body.sheets, 'Лист', 100),
    url,
    transcription: text(body.transcription, 'Расшифровка', 50_000),
    note: text(body.note, 'Заметки', 10_000),
    persons: (persons as { id: number; role: string }[]).map((p) => ({ id: p.id, role: p.role })),
    events: events as number[],
  };
}

// --- Карточка ---

/** Колонки карточки: их пишет журнал и возвращает откат. */
export const DOCUMENT_COLUMNS = [
  'type',
  'title',
  'date_modifier',
  'date_value',
  'date_value_to',
  'date_calendar',
  'archive',
  'fond',
  'opis',
  'delo',
  'sheets',
  'url',
  'transcription',
  'note',
] as const;

type DocumentRow = Record<(typeof DOCUMENT_COLUMNS)[number], string | null> & {
  id: number;
  source_uid: string | null;
  version: number;
  created_at: string;
};

function columnsOf(fields: DocumentFields): Record<(typeof DOCUMENT_COLUMNS)[number], string | null> {
  return {
    type: fields.type,
    title: fields.title,
    date_modifier: fields.date?.modifier ?? null,
    date_value: fields.date?.value ?? null,
    date_value_to: fields.date?.valueTo ?? null,
    date_calendar: fields.date?.calendar ?? 'gregorian',
    archive: fields.archive,
    fond: fields.fond,
    opis: fields.opis,
    delo: fields.delo,
    sheets: fields.sheets,
    url: fields.url,
    transcription: fields.transcription,
    note: fields.note,
  };
}

const pick = (row: DocumentRow) => Object.fromEntries(DOCUMENT_COLUMNS.map((c) => [c, row[c]]));

/** О ком документ: «о ком» или первый из людей — по нему правку находят в истории человека. */
export const mainPerson = (fields: DocumentFields) =>
  (fields.persons.find((p) => p.role === 'subject') ?? fields.persons[0])?.id ?? null;

/** Для истории: документ и его люди на момент правки; правка — о главном человеке документа. */
export function documentChangeSubject(db: Db, documentId: number) {
  const doc = db.prepare('SELECT type, title FROM documents WHERE id = ?').get(documentId) as
    | { type: string; title: string }
    | undefined;
  if (!doc) throw new EditError(404, 'Документ не найден');
  const persons = db
    .prepare('SELECT person_id, role FROM document_persons WHERE document_id = ? ORDER BY position')
    .all(documentId) as { person_id: number; role: string }[];
  const main = persons.find((p) => p.role === 'subject') ?? persons[0];
  return {
    personId: main?.person_id ?? null,
    // documentId, а не id: по «"id":N» история находит правки человека N.
    details: { document: { documentId, type: doc.type, title: doc.title }, people: persons.map((p) => personRef(db, p.person_id)) },
  };
}

/**
 * Люди и события документа есть в дереве, а события — у его людей (или у их браков): документ
 * подтверждает то, что в нём записано.
 */
export function linksOf(db: Db, fields: DocumentFields): DocumentLinks {
  for (const p of fields.persons) {
    if (!db.prepare('SELECT 1 FROM persons WHERE id = ?').get(p.id)) throw new EditError(400, `Человек ${p.id} не найден`);
  }
  const ids = fields.persons.map((p) => p.id);
  for (const eventId of fields.events) {
    const event = db.prepare('SELECT person_id, family_id FROM events WHERE id = ?').get(eventId) as
      | { person_id: number | null; family_id: number | null }
      | undefined;
    if (!event) throw new EditError(400, `Событие ${eventId} не найдено`);
    const family =
      event.family_id === null
        ? undefined
        : (db.prepare('SELECT partner1_id, partner2_id FROM families WHERE id = ?').get(event.family_id) as {
            partner1_id: number | null;
            partner2_id: number | null;
          });
    const owners = event.person_id !== null ? [event.person_id] : [family?.partner1_id, family?.partner2_id];
    if (!owners.some((id) => id != null && ids.includes(id))) {
      throw new EditError(400, 'Событие документа должно быть у одного из его людей');
    }
  }
  return {
    persons: fields.persons.map((p, position) => ({ person_id: p.id, role: p.role, position })),
    events: [...fields.events].sort((a, b) => a - b),
  };
}

function getDocument(db: Db, id: number): DocumentRow {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
  if (!row) throw new EditError(404, 'Документ не найден');
  return row;
}

export function addDocument(
  db: Db,
  userId: number | null,
  fields: DocumentFields,
  sourceUid: string | null = null,
): number {
  return inTransaction(db, () => {
    const links = linksOf(db, fields);
    const columns = columnsOf(fields);
    const names = Object.keys(columns);
    const { id } = db
      .prepare(
        `INSERT INTO documents (${names.join(', ')}, source_uid, created_by)
         VALUES (${names.map(() => '?').join(', ')}, ?, ?) RETURNING id`,
      )
      .get(...Object.values(columns), sourceUid, userId) as { id: number };
    setDocumentLinks(db, id, links);
    audit(db, userId, 'document', id, 'create', null, { ...columns, ...links });
    return id;
  });
}

export function updateDocument(db: Db, userId: number, id: number, expectedVersion: unknown, fields: DocumentFields) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    const row = getDocument(db, id);
    if (row.version !== expected) throw new EditError(409, CONFLICT);
    const links = linksOf(db, fields);
    const before = { ...pick(row), ...documentLinks(db, id) };
    const columns = columnsOf(fields);
    db.prepare(
      `UPDATE documents SET ${Object.keys(columns)
        .map((c) => `${c} = ?`)
        .join(', ')}, version = version + 1 WHERE id = ?`,
    ).run(...Object.values(columns), id);
    setDocumentLinks(db, id, links);
    audit(db, userId, 'document', id, 'update', before, { ...columns, ...links });
  });
}

/** Удаляет документ; файлы уходят в корзину — возвращает их id. */
export function deleteDocument(db: Db, userId: number, id: number, expectedVersion: unknown): number[] {
  const expected = parseVersion(expectedVersion);
  return inTransaction(db, () => {
    const row = getDocument(db, id);
    if (row.version !== expected) throw new EditError(409, CONFLICT);
    const files = db.prepare('SELECT * FROM document_files WHERE document_id = ? ORDER BY position').all(id) as FileRow[];
    // Каждый файл — своей строкой журнала, как при загрузке: откат вернёт и их.
    for (const file of files) audit(db, userId, 'document_file', file.id, 'delete', { ...file }, null);
    const snapshot = { ...row, ...documentLinks(db, id) };
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    audit(db, userId, 'document', id, 'delete', snapshot, null);
    return files.map((f) => f.id);
  });
}

// --- Файлы ---

const MAX_FILE_BYTES = 24 * 1024 * 1024; // в nginx — 25 МБ на запрос вместе с миниатюрой
const MAX_THUMB_BYTES = 1024 * 1024;

export type DocumentFileSize = 'original' | 'thumb';

export const documentFilePath = (mediaDir: string, id: number, size: DocumentFileSize) =>
  path.join(mediaDir, 'documents', size === 'original' ? `${id}.jpg` : `${id}-thumb.jpg`);

// Удалённые файлы — в корзину, как фото: правку можно откатить.
const trashPath = (mediaDir: string, id: number, size: DocumentFileSize) =>
  path.join(mediaDir, 'documents', 'trash', path.basename(documentFilePath(mediaDir, id, size)));

export function trashDocumentFiles(mediaDir: string, id: number) {
  fs.mkdirSync(path.join(mediaDir, 'documents', 'trash'), { recursive: true });
  for (const size of ['original', 'thumb'] as const) {
    const file = documentFilePath(mediaDir, id, size);
    if (fs.existsSync(file)) fs.renameSync(file, trashPath(mediaDir, id, size));
  }
}

export function restoreDocumentFiles(mediaDir: string, id: number) {
  for (const size of ['original', 'thumb'] as const) {
    const file = trashPath(mediaDir, id, size);
    if (fs.existsSync(file)) fs.renameSync(file, documentFilePath(mediaDir, id, size));
  }
}

type FileRow = {
  id: number;
  document_id: number;
  position: number;
  frame: number | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

export type PreparedScan = { bytes: Uint8Array; width: number; height: number; sha256: string };

/** Скан как его храним: JPEG без метаданных, не повёрнутый через EXIF. */
export function prepareScan(original: Uint8Array): PreparedScan {
  if (!isJpeg(original)) throw new EditError(400, 'Скан должен быть в JPEG');
  if (original.length > MAX_FILE_BYTES) throw new EditError(400, 'Скан больше 24 МБ');
  let info;
  let bytes;
  try {
    info = readJpegInfo(original);
    bytes = stripMetadata(original);
  } catch (error) {
    throw new EditError(400, `Не удалось прочитать JPEG: ${(error as Error).message}`);
  }
  if (info.orientation !== 1) {
    throw new EditError(400, 'Скан повёрнут через EXIF — сохраните его уже повёрнутым и загрузите снова');
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { bytes, width: info.width, height: info.height, sha256 };
}

export const parseFrame = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const frame = Number(value);
  if (!Number.isInteger(frame) || frame < 1 || frame > 1_000_000) throw new EditError(400, 'Номер кадра — целое число');
  return frame;
};

/** Где ещё лежит тот же скан: по хешу. Предупреждаем, но не запрещаем — кадр бывает нужен двум документам. */
export function sameScans(db: Db, sha256: string, exceptFileId?: number) {
  return db
    .prepare(
      `SELECT d.id AS documentId, d.title, d.type FROM document_files f JOIN documents d ON d.id = f.document_id
       WHERE f.sha256 = ? AND f.id != ? ORDER BY d.id`,
    )
    .all(sha256, exceptFileId ?? 0) as { documentId: number; title: string; type: string }[];
}

export function addDocumentFile(
  db: Db,
  mediaDir: string,
  userId: number | null,
  documentId: number,
  input: { scan: PreparedScan; thumb: Uint8Array; frame: number | null },
): number {
  if (!isJpeg(input.thumb)) throw new EditError(400, 'Миниатюра должна быть в JPEG');
  if (input.thumb.length > MAX_THUMB_BYTES) throw new EditError(400, 'Миниатюра больше 1 МБ');
  return inTransaction(db, () => {
    getDocument(db, documentId);
    const { position } = db
      .prepare('SELECT coalesce(max(position) + 1, 0) AS position FROM document_files WHERE document_id = ?')
      .get(documentId) as { position: number };
    const { scan } = input;
    const row = { document_id: documentId, position, frame: input.frame, width: scan.width, height: scan.height, bytes: scan.bytes.length, sha256: scan.sha256 };
    const { id } = db
      .prepare(
        `INSERT INTO document_files (document_id, position, frame, width, height, bytes, sha256, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(row.document_id, row.position, row.frame, row.width, row.height, row.bytes, row.sha256, userId) as { id: number };
    // Файлы пишем внутри транзакции: не записались — откатится и строка.
    fs.mkdirSync(path.join(mediaDir, 'documents'), { recursive: true });
    try {
      fs.writeFileSync(documentFilePath(mediaDir, id, 'original'), scan.bytes);
      fs.writeFileSync(documentFilePath(mediaDir, id, 'thumb'), input.thumb);
    } catch (error) {
      for (const size of ['original', 'thumb'] as const) fs.rmSync(documentFilePath(mediaDir, id, size), { force: true });
      throw error;
    }
    audit(db, userId, 'document_file', id, 'create', null, row);
    return id;
  });
}

export function documentOfFile(db: Db, fileId: number): number {
  const row = db.prepare('SELECT document_id FROM document_files WHERE id = ?').get(fileId) as
    | { document_id: number }
    | undefined;
  if (!row) throw new EditError(404, 'Скан не найден');
  return row.document_id;
}

export function updateDocumentFile(db: Db, userId: number, fileId: number, frame: number | null) {
  inTransaction(db, () => {
    const before = db.prepare('SELECT document_id, frame FROM document_files WHERE id = ?').get(fileId) as
      | { document_id: number; frame: number | null }
      | undefined;
    if (!before) throw new EditError(404, 'Скан не найден');
    db.prepare('UPDATE document_files SET frame = ? WHERE id = ?').run(frame, fileId);
    // document_id — чтобы история видела, что тронут документ (history.ts, laterConflict).
    audit(db, userId, 'document_file', fileId, 'update', { ...before }, { document_id: before.document_id, frame });
  });
}

export function deleteDocumentFile(db: Db, mediaDir: string, userId: number, fileId: number) {
  inTransaction(db, () => {
    const row = db.prepare('SELECT * FROM document_files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!row) throw new EditError(404, 'Скан не найден');
    db.prepare('DELETE FROM document_files WHERE id = ?').run(fileId);
    audit(db, userId, 'document_file', fileId, 'delete', { ...row }, null);
  });
  trashDocumentFiles(mediaDir, fileId);
}

// --- Чтение ---

export type DocumentView = {
  id: number;
  version: number;
  type: string;
  title: string;
  /** Дата составления документа; `calendar` — только у дат по старому стилю. */
  date: { modifier: DateModifier; value: string; valueTo?: string; calendar?: 'julian' } | null;
  archive: string;
  fond: string;
  opis: string;
  delo: string;
  sheets: string;
  url: string;
  transcription: string;
  note: string;
  files: { id: number; frame: number | null; width: number; height: number; bytes: number }[];
  persons: { id: number; role: string }[];
  events: number[];
  createdAt: string;
};

/** Все документы — их сотни, не тысячи, поэтому целиком, как и дерево. */
export function listDocuments(db: Db): DocumentView[] {
  const rows = db.prepare('SELECT * FROM documents ORDER BY id').all() as DocumentRow[];
  const files = db.prepare('SELECT * FROM document_files ORDER BY position, id').all() as FileRow[];
  const persons = db.prepare('SELECT * FROM document_persons ORDER BY position, person_id').all() as {
    document_id: number;
    person_id: number;
    role: string;
  }[];
  const events = db.prepare('SELECT * FROM document_events ORDER BY event_id').all() as {
    document_id: number;
    event_id: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    type: row.type!,
    title: row.title!,
    date:
      row.date_modifier && row.date_value
        ? {
            modifier: row.date_modifier as DateModifier,
            value: row.date_value,
            ...(row.date_value_to ? { valueTo: row.date_value_to } : {}),
            ...(row.date_calendar === 'julian' ? { calendar: 'julian' as const } : {}),
          }
        : null,
    archive: row.archive!,
    fond: row.fond!,
    opis: row.opis!,
    delo: row.delo!,
    sheets: row.sheets!,
    url: row.url!,
    transcription: row.transcription!,
    note: row.note!,
    files: files
      .filter((f) => f.document_id === row.id)
      .map((f) => ({ id: f.id, frame: f.frame, width: f.width, height: f.height, bytes: f.bytes })),
    persons: persons.filter((p) => p.document_id === row.id).map((p) => ({ id: p.person_id, role: p.role })),
    events: events.filter((e) => e.document_id === row.id).map((e) => e.event_id),
    createdAt: row.created_at,
  }));
}
