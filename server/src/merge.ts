import type { Db } from './db.ts';

type PersonRow = {
  id: number;
  given_name: string;
  patronymic: string;
  surname: string;
  birth_surname: string;
  sex: string;
  is_uncertain: number;
  bio: string;
  avatar_media_id: number | null;
  avatar_crop: string | null;
};

type EventRow = {
  id: number;
  type: string;
  custom_type: string;
  date_modifier: string | null;
  date_value: string | null;
  date_value_to: string | null;
  date_text: string;
  place_id: number | null;
  note: string;
};

type FamilyRow = { id: number; partner1_id: number | null; partner2_id: number | null };

// События, которые у человека или семьи бывают один раз: при слиянии их объединяем, а не копим.
const SINGLE_EVENTS = new Set(['birth', 'death', 'burial', 'marriage', 'divorce']);

/** Находит человека по id или по ссылке из импорта (I7, @I7@). */
export function findPersonId(db: Db, ref: string): number | undefined {
  const clean = ref.replace(/@/g, '');
  const row = /^\d+$/.test(clean)
    ? db.prepare('SELECT id FROM persons WHERE id = ?').get(Number(clean))
    : db.prepare('SELECT id FROM persons WHERE source_ref = ?').get(clean);
  return (row as { id: number } | undefined)?.id;
}

/**
 * Сливает дубль `dropId` в `keepId`: недостающие поля, события, родительские и
 * супружеские связи переходят к `keepId`; семьи с той же парой партнёров объединяются.
 */
export function mergePersons(db: Db, keepId: number, dropId: number) {
  db.exec('BEGIN');
  try {
    mergeInto(db, keepId, dropId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** То же, что mergePersons, но внутри уже открытой транзакции. */
export function mergeInto(db: Db, keepId: number, dropId: number) {
  if (keepId === dropId) throw new Error('Нельзя слить человека с самим собой');
  const keep = getPerson(db, keepId);
  const drop = getPerson(db, dropId);

  const pick = (a: string, b: string) => a || b;
  const sex = keep.sex !== 'U' ? keep.sex : drop.sex;
  if (keep.sex !== 'U' && drop.sex !== 'U' && keep.sex !== drop.sex) {
    throw new Error('У людей указан разный пол — это точно один человек?');
  }
  const bio = [keep.bio, drop.bio].filter(Boolean).join('\n\n');
  db.prepare(
    `UPDATE persons SET given_name = ?, patronymic = ?, surname = ?, birth_surname = ?, sex = ?,
       is_uncertain = ?, bio = ? WHERE id = ?`,
  ).run(
    pick(keep.given_name, drop.given_name),
    pick(keep.patronymic, drop.patronymic),
    pick(keep.surname, drop.surname),
    pick(keep.birth_surname, drop.birth_surname),
    sex,
    keep.is_uncertain && drop.is_uncertain,
    bio,
    keepId,
  );

  db.prepare('UPDATE events SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
  mergeSingleEvents(db, 'person_id', keepId);

  // Как ребёнок: если оба были детьми одной семьи, остаётся одна запись.
  db.prepare('UPDATE OR IGNORE family_children SET child_id = ? WHERE child_id = ?').run(keepId, dropId);
  db.prepare('DELETE FROM family_children WHERE child_id = ?').run(dropId);
  keepFullestParentFamily(db, keepId);

  // Как партнёр.
  db.prepare('UPDATE families SET partner1_id = ? WHERE partner1_id = ?').run(keepId, dropId);
  db.prepare('UPDATE families SET partner2_id = ? WHERE partner2_id = ?').run(keepId, dropId);
  mergeFamiliesOfSameCouple(db, keepId);

  // Фото переходят вместе с аватаркой, если своей у оставшегося нет; иначе каскад удалил бы их записи.
  db.prepare('UPDATE media SET person_id = ? WHERE person_id = ?').run(keepId, dropId);
  if (keep.avatar_media_id === null && drop.avatar_media_id !== null) {
    db.prepare('UPDATE persons SET avatar_media_id = ?, avatar_crop = ? WHERE id = ?').run(
      drop.avatar_media_id,
      drop.avatar_crop,
      keepId,
    );
  }
  // Аккаунт, привязанный к дублю, теперь указывает на оставшегося.
  db.prepare('UPDATE users SET person_id = ? WHERE person_id = ?').run(keepId, dropId);

  db.prepare('DELETE FROM persons WHERE id = ?').run(dropId);
}

function getPerson(db: Db, id: number): PersonRow {
  const row = db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as PersonRow | undefined;
  if (!row) throw new Error(`Человек ${id} не найден`);
  return row;
}

/**
 * Дубль ребёнка мог висеть у «отца и неизвестной», а оригинал — у отца с матерью. После слияния
 * человек оказался бы ребёнком обеих семей; оставляем ту, где родителей больше, а опустевшую удаляем.
 */
function keepFullestParentFamily(db: Db, childId: number) {
  const families = db
    .prepare(
      `SELECT f.id, f.partner1_id, f.partner2_id FROM families f JOIN family_children fc ON fc.family_id = f.id
       WHERE fc.child_id = ? ORDER BY f.id`,
    )
    .all(childId) as FamilyRow[];
  const known = (f: FamilyRow) => [f.partner1_id, f.partner2_id].filter((p): p is number => p !== null);
  for (const a of families) {
    const covered = families.some(
      (b) =>
        b.id !== a.id &&
        known(a).every((p) => known(b).includes(p)) &&
        (known(a).length < known(b).length || b.id < a.id),
    );
    if (!covered) continue;
    db.prepare('DELETE FROM family_children WHERE family_id = ? AND child_id = ?').run(a.id, childId);
    const left = db.prepare('SELECT count(*) AS n FROM family_children WHERE family_id = ?').get(a.id) as { n: number };
    const events = db.prepare('SELECT count(*) AS n FROM events WHERE family_id = ?').get(a.id) as { n: number };
    if (left.n === 0 && known(a).length < 2 && events.n === 0) db.prepare('DELETE FROM families WHERE id = ?').run(a.id);
  }
}

// Две семьи одной и той же пары (в любом порядке партнёров) — это одна семья.
export function mergeFamiliesOfSameCouple(db: Db, personId: number) {
  const families = db
    .prepare('SELECT id, partner1_id, partner2_id FROM families WHERE partner1_id = ? OR partner2_id = ? ORDER BY id')
    .all(personId, personId) as FamilyRow[];

  const byPartner = new Map<number, number>();
  for (const family of families) {
    const other = family.partner1_id === personId ? family.partner2_id : family.partner1_id;
    // Семьи с неизвестным вторым партнёром не объединяем: это могут быть разные браки.
    if (other === null || other === personId) continue;
    const target = byPartner.get(other);
    if (target === undefined) {
      byPartner.set(other, family.id);
      continue;
    }
    db.prepare('UPDATE OR IGNORE family_children SET family_id = ? WHERE family_id = ?').run(target, family.id);
    db.prepare('UPDATE events SET family_id = ? WHERE family_id = ?').run(target, family.id);
    db.prepare('DELETE FROM families WHERE id = ?').run(family.id);
    mergeSingleEvents(db, 'family_id', target);
  }
}

// Из нескольких «рождений» и т.п. оставляет одно, дополняя его недостающими деталями.
function mergeSingleEvents(db: Db, ownerColumn: 'person_id' | 'family_id', ownerId: number) {
  const events = db.prepare(`SELECT * FROM events WHERE ${ownerColumn} = ? ORDER BY id`).all(ownerId) as EventRow[];
  const byType = new Map<string, EventRow>();

  for (const event of events) {
    if (!SINGLE_EVENTS.has(event.type)) continue;
    const kept = byType.get(event.type);
    if (!kept) {
      byType.set(event.type, event);
      continue;
    }
    const keptHasDate = kept.date_value !== null || kept.date_text !== '';
    const merged = {
      date_modifier: keptHasDate ? kept.date_modifier : event.date_modifier,
      date_value: keptHasDate ? kept.date_value : event.date_value,
      date_value_to: keptHasDate ? kept.date_value_to : event.date_value_to,
      date_text: keptHasDate ? kept.date_text : event.date_text,
      place_id: kept.place_id ?? event.place_id,
      note: [kept.note, event.note].filter(Boolean).join('\n'),
    };
    db.prepare(
      `UPDATE events SET date_modifier = ?, date_value = ?, date_value_to = ?, date_text = ?, place_id = ?, note = ?
       WHERE id = ?`,
    ).run(
      merged.date_modifier,
      merged.date_value,
      merged.date_value_to,
      merged.date_text,
      merged.place_id,
      merged.note,
      kept.id,
    );
    Object.assign(kept, merged);
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  }
}
