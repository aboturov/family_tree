import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import {
  addDocument,
  addDocumentFile,
  documentChangeSubject,
  linksOf,
  mainPerson,
  parseDocumentFields,
  prepareScan,
  type DocumentFields,
  type PreparedScan,
} from './documents.ts';
import { EditError } from './editing.ts';
import { makeThumbnail } from './jpeg.ts';
import { recordChange } from './journal.ts';
import { findPersonId } from './merge.ts';

// Пакетная загрузка документов: tree-admin documents:import <manifest.json>. Документы из архива
// собирают десятками — через сайт по одному это долго. Манифест — JSON:
//
//   { "documents": [{
//       "uid": "doc-001",                    — ключ: повторный импорт пропускает загруженное
//       "type": "civil_birth", "title": "",  — типы и роли — DOCUMENT_TYPES и DOCUMENT_ROLES (documents.ts)
//       "date": { "modifier": "exact", "value": "1925-03-14", "calendar": "julian" } | null,
//       "archive": "", "fond": "", "opis": "", "delo": "", "sheets": "", "url": "",
//       "transcription": "", "note": "",
//       "files":   [{ "path": "scans/doc-001-1.jpg", "frame": 27 }],
//       "persons": [{ "id": 101, "role": "subject" }],
//       "events":  [{ "person": 101, "type": "birth" }, { "person": 101, "type": "marriage", "spouse": 102 }, { "id": 555 }]
//   }] }
//
// Пути файлов — от каталога манифеста; люди — id в дереве или ссылка из импорта GEDCOM (I7).
// Событие — по id или по человеку и типу; если таких событий несколько (два брака), — со spouse.
// Недостающее событие импорт не создаёт: сначала его добавляют в дерево.

export type PlannedDocument = {
  uid: string;
  fields: DocumentFields;
  /** Сканы проверены при разборе; байты читаются заново при загрузке — в памяти их не держим. */
  files: { path: string; file: string; frame: number | null; sha256: string }[];
};

export type ImportPlan = {
  documents: PlannedDocument[];
  /** Уже загруженные — по uid. */
  skipped: string[];
  warnings: string[];
  errors: string[];
};

const FAMILY_EVENTS = new Set(['marriage', 'divorce', 'engagement']);
// Остальные поля — скорее опечатка («transcripton»): предупреждаем, иначе расшифровка молча пропала бы.
const FIELDS = new Set(['uid', 'type', 'title', 'date', 'archive', 'fond', 'opis', 'delo', 'sheets', 'url', 'transcription', 'note', 'files', 'persons', 'events']);

type Entry = Record<string, unknown>;

export function planDocumentImport(db: Db, manifestPath: string): ImportPlan {
  let manifest: { documents?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать манифест: ${(error as Error).message}`);
  }
  if (!Array.isArray(manifest.documents)) throw new Error('В манифесте нет списка documents');
  const base = path.dirname(manifestPath);
  const plan: ImportPlan = { documents: [], skipped: [], warnings: [], errors: [] };
  const uids = new Set<string>();
  const scans = new Map<string, string>(); // sha256 → где уже встречался в манифесте

  manifest.documents.forEach((entry: Entry, index: number) => {
    const uid = typeof entry?.uid === 'string' ? entry.uid.trim() : '';
    if (!entry || typeof entry !== 'object') return plan.errors.push(`№${index + 1}: ожидался объект`);
    const label = uid || `№${index + 1}`;
    const fail = (message: string) => plan.errors.push(`${label}: ${message}`);
    if (!uid || uid.length > 200) return fail('нужен uid — строка до 200 символов');
    if (uids.has(uid)) return fail('uid повторяется в манифесте');
    uids.add(uid);
    if (db.prepare('SELECT 1 FROM documents WHERE source_uid = ?').get(uid)) {
      plan.skipped.push(uid);
      return;
    }

    const unknown = Object.keys(entry).filter((key) => !FIELDS.has(key));
    if (unknown.length) plan.warnings.push(`${label}: неизвестные поля ${unknown.join(', ')} — пропущены`);
    try {
      const persons = list(entry.persons, 'persons').map((p) => ({ ...p, id: person(db, p.id) }));
      const events = list(entry.events, 'events').map((e) => eventId(db, e));
      const fields = parseDocumentFields({ ...entry, persons, events });
      linksOf(db, fields);
      const files = list(entry.files, 'files').map((f) => {
        if (typeof f.path !== 'string') throw new EditError(400, 'у файла нет path');
        const file = path.resolve(base, f.path);
        if (!fs.existsSync(file)) throw new EditError(400, `нет файла ${f.path}`);
        const frame = f.frame ?? null;
        if (frame !== null && !(Number.isInteger(frame) && (frame as number) > 0)) {
          throw new EditError(400, `${f.path}: номер кадра — целое число`);
        }
        let scan: PreparedScan;
        try {
          scan = prepareScan(new Uint8Array(fs.readFileSync(file)));
        } catch (error) {
          throw new EditError(400, `${f.path}: ${(error as Error).message}`);
        }
        const seen = scans.get(scan.sha256);
        if (seen) plan.warnings.push(`${label}: ${f.path} — тот же скан, что ${seen}`);
        scans.set(scan.sha256, `${label}/${f.path}`);
        const inTree = db
          .prepare('SELECT DISTINCT d.source_uid, d.id FROM document_files f JOIN documents d ON d.id = f.document_id WHERE f.sha256 = ?')
          .all(scan.sha256) as { source_uid: string | null; id: number }[];
        for (const d of inTree) plan.warnings.push(`${label}: ${f.path} уже есть в документе ${d.source_uid ?? d.id}`);
        return { path: f.path, file, frame: frame as number | null, sha256: scan.sha256 };
      });
      plan.documents.push({ uid, fields, files });
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      fail(error.message);
    }
  });
  return plan;
}

const list = (value: unknown, name: string): Entry[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => v !== null && typeof v === 'object')) {
    throw new EditError(400, `${name} — список объектов`);
  }
  return value;
};

/** Человек по id в дереве или по ссылке из импорта (I7). */
function person(db: Db, ref: unknown): number {
  if (typeof ref !== 'number' && typeof ref !== 'string') throw new EditError(400, 'у человека нет id');
  const id = findPersonId(db, String(ref));
  if (id === undefined) throw new EditError(400, `человек ${ref} не найден`);
  return id;
}

function eventId(db: Db, ref: Entry): number {
  if (ref.id !== undefined) {
    if (!Number.isInteger(ref.id) || !db.prepare('SELECT 1 FROM events WHERE id = ?').get(ref.id as number)) {
      throw new EditError(400, `событие ${ref.id} не найдено`);
    }
    return ref.id as number;
  }
  if (typeof ref.type !== 'string') throw new EditError(400, 'у события нужен id или person и type');
  const who = person(db, ref.person);
  let rows: { id: number }[];
  if (FAMILY_EVENTS.has(ref.type)) {
    const spouse = ref.spouse === undefined ? null : person(db, ref.spouse);
    rows = db
      .prepare(
        `SELECT e.id FROM events e JOIN families f ON f.id = e.family_id
         WHERE e.type = ?1 AND (f.partner1_id = ?2 OR f.partner2_id = ?2)
           AND (?3 IS NULL OR f.partner1_id = ?3 OR f.partner2_id = ?3)`,
      )
      .all(ref.type, who, spouse) as { id: number }[];
  } else {
    rows = db.prepare('SELECT id FROM events WHERE person_id = ? AND type = ?').all(who, ref.type) as { id: number }[];
  }
  if (rows.length === 0) throw new EditError(400, `у человека ${ref.person} нет события ${ref.type} — сначала добавьте его в дерево`);
  if (rows.length > 1) throw new EditError(400, `у человека ${ref.person} несколько событий ${ref.type} — укажите spouse или id`);
  return rows[0].id;
}

/**
 * Загружает документы плана: каждый — отдельной правкой в истории, её можно откатить.
 * Миниатюры считаются до транзакции — пока они считаются, база открыта для сайта.
 */
export function runDocumentImport(
  db: Db,
  mediaDir: string,
  plan: ImportPlan,
  userId: number | null,
  progress: (uid: string) => void = () => {},
): number[] {
  if (plan.errors.length) throw new Error('В манифесте ошибки — сначала исправьте их');
  const ids: number[] = [];
  for (const doc of plan.documents) {
    const scans = doc.files.map((f) => {
      const scan = prepareScan(new Uint8Array(fs.readFileSync(f.file)));
      if (scan.sha256 !== f.sha256) throw new Error(`${doc.uid}: ${f.path} изменился после проверки`);
      return { scan, thumb: makeThumbnail(scan.bytes) };
    });
    const id = recordChange(
      db,
      userId,
      'document.add',
      mainPerson(doc.fields),
      () => {
        const created = addDocument(db, userId, doc.fields, doc.uid);
        doc.files.forEach((f, i) => addDocumentFile(db, mediaDir, userId, created, { ...scans[i], frame: f.frame }));
        return created;
      },
      (created) => ({ ...documentChangeSubject(db, created).details, files: doc.files.length }),
    );
    ids.push(id);
    progress(doc.uid);
  }
  return ids;
}
