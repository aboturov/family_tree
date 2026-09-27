import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.ts';
import { EditError } from './editing.ts';
import { audit as journalAudit, inTransaction } from './journal.ts';

// Фото людей. Браузер присылает два JPEG — большой (до 2000 px) и миниатюру (до 480 px),
// уже без метаданных; сервер проверяет, что это JPEG, и кладёт их в mediaDir.

const MAX_FULL_BYTES = 12 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;

export type MediaSize = 'full' | 'thumb';
export type AvatarCrop = { x: number; y: number; zoom: number };

export const mediaPath = (mediaDir: string, id: number, size: MediaSize) =>
  path.join(mediaDir, size === 'full' ? `${id}.jpg` : `${id}-thumb.jpg`);

const isJpeg = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const audit = (
  db: Db,
  userId: number,
  id: number,
  action: 'create' | 'update' | 'delete',
  before: unknown,
  after: unknown,
) => journalAudit(db, userId, 'media', id, action, before, after);

// Удалённые фото не стираются, а уходят в корзину: историю правок можно откатить.
const trashPath = (mediaDir: string, id: number, size: MediaSize) =>
  path.join(mediaDir, 'trash', path.basename(mediaPath(mediaDir, id, size)));

export function trashMediaFiles(mediaDir: string, id: number) {
  fs.mkdirSync(path.join(mediaDir, 'trash'), { recursive: true });
  for (const size of ['full', 'thumb'] as const) {
    const file = mediaPath(mediaDir, id, size);
    if (fs.existsSync(file)) fs.renameSync(file, trashPath(mediaDir, id, size));
  }
}

export function restoreMediaFiles(mediaDir: string, id: number) {
  for (const size of ['full', 'thumb'] as const) {
    const file = trashPath(mediaDir, id, size);
    if (fs.existsSync(file)) fs.renameSync(file, mediaPath(mediaDir, id, size));
  }
}

export function addMedia(
  db: Db,
  mediaDir: string,
  userId: number,
  personId: number,
  input: { full: Uint8Array; thumb: Uint8Array; width: number; height: number; caption: string },
): number {
  if (!isJpeg(input.full) || !isJpeg(input.thumb)) throw new EditError(400, 'Ожидались JPEG-файлы');
  if (input.full.length > MAX_FULL_BYTES) throw new EditError(400, 'Фото больше 12 МБ');
  if (input.thumb.length > MAX_THUMB_BYTES) throw new EditError(400, 'Миниатюра больше 1 МБ');
  for (const side of [input.width, input.height]) {
    if (!Number.isInteger(side) || side < 1 || side > 10_000) throw new EditError(400, 'Неверный размер фото');
  }
  const caption = input.caption.trim().slice(0, 500);
  if (!db.prepare('SELECT 1 FROM persons WHERE id = ?').get(personId)) throw new EditError(404, 'Человек не найден');

  fs.mkdirSync(mediaDir, { recursive: true });
  const { id } = db
    .prepare('INSERT INTO media (person_id, caption, width, height, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .get(personId, caption, input.width, input.height, userId) as { id: number };
  try {
    fs.writeFileSync(mediaPath(mediaDir, id, 'full'), input.full);
    fs.writeFileSync(mediaPath(mediaDir, id, 'thumb'), input.thumb);
  } catch (error) {
    db.prepare('DELETE FROM media WHERE id = ?').run(id);
    throw error;
  }
  audit(db, userId, id, 'create', null, { personId, caption, width: input.width, height: input.height });
  return id;
}

export function updateCaption(db: Db, userId: number, id: number, caption: unknown) {
  if (typeof caption !== 'string') throw new EditError(400, 'Подпись должна быть строкой');
  const before = db.prepare('SELECT caption FROM media WHERE id = ?').get(id) as { caption: string } | undefined;
  if (!before) throw new EditError(404, 'Фото не найдено');
  const clean = caption.trim().slice(0, 500);
  db.prepare('UPDATE media SET caption = ? WHERE id = ?').run(clean, id);
  audit(db, userId, id, 'update', before, { caption: clean });
}

export function deleteMedia(db: Db, mediaDir: string, userId: number, id: number) {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as { person_id: number } | undefined;
  if (!row) throw new EditError(404, 'Фото не найдено');
  inTransaction(db, () => {
    // Удалили аватарку — у человека снова силуэт.
    const owner = db.prepare('SELECT id, avatar_media_id, avatar_crop FROM persons WHERE avatar_media_id = ?').get(id) as
      | { id: number; avatar_media_id: number; avatar_crop: string | null }
      | undefined;
    if (owner) {
      db.prepare('UPDATE persons SET avatar_media_id = NULL, avatar_crop = NULL WHERE id = ?').run(owner.id);
      journalAudit(
        db,
        userId,
        'person',
        owner.id,
        'update',
        { avatar_media_id: owner.avatar_media_id, avatar_crop: owner.avatar_crop },
        { avatar_media_id: null, avatar_crop: null },
      );
    }
    db.prepare('DELETE FROM media WHERE id = ?').run(id);
    audit(db, userId, id, 'delete', row, null);
  });
  trashMediaFiles(mediaDir, id);
}

export function parseCrop(value: unknown): AvatarCrop {
  const c = value as Record<string, unknown> | null;
  const inRange = (v: unknown, min: number, max: number) => typeof v === 'number' && v >= min && v <= max;
  if (!c || !inRange(c.x, 0, 1) || !inRange(c.y, 0, 1) || !inRange(c.zoom, 0.05, 1)) {
    throw new EditError(400, 'Неверное кадрирование аватарки');
  }
  return { x: c.x as number, y: c.y as number, zoom: c.zoom as number };
}

/** Аватарка — одно из фото этого же человека (или null — вернуть силуэт). */
export function setAvatar(
  db: Db,
  userId: number,
  personId: number,
  expectedVersion: unknown,
  mediaId: unknown,
  crop: AvatarCrop | null,
) {
  if (typeof expectedVersion !== 'number') throw new EditError(400, 'Не указана версия карточки');
  if (mediaId !== null) {
    const media = db.prepare('SELECT person_id FROM media WHERE id = ?').get(mediaId as number) as
      { person_id: number } | undefined;
    if (!media || media.person_id !== personId) throw new EditError(400, 'Это фото другого человека');
  }
  inTransaction(db, () => {
    const row = db.prepare('SELECT version, avatar_media_id, avatar_crop FROM persons WHERE id = ?').get(personId) as
      { version: number; avatar_media_id: number | null; avatar_crop: string | null } | undefined;
    if (!row) throw new EditError(404, 'Человек не найден');
    if (row.version !== expectedVersion) {
      throw new EditError(409, 'Эту карточку только что изменил кто-то ещё. Обновите страницу и повторите правку.');
    }
    db.prepare('UPDATE persons SET avatar_media_id = ?, avatar_crop = ?, version = version + 1 WHERE id = ?').run(
      mediaId as number | null,
      mediaId === null ? null : JSON.stringify(crop),
      personId,
    );
    // В журнале — колонки таблицы, чтобы откат мог просто вернуть их.
    journalAudit(
      db,
      userId,
      'person',
      personId,
      'update',
      { avatar_media_id: row.avatar_media_id, avatar_crop: row.avatar_crop },
      { avatar_media_id: mediaId, avatar_crop: mediaId === null ? null : JSON.stringify(crop) },
    );
  });
}
