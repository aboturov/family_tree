import type { Db } from './db.ts';
import { bumpVersion, EditError, parseEventFields, parseVersion, type PersonFields } from './editing.ts';
import { audit, inTransaction } from './journal.ts';
import { mergeFamiliesOfSameCouple, mergeInto } from './merge.ts';

// Правка связей. Связи живут в семьях: родители — партнёры семьи, где человек ребёнок;
// супруги — партнёры одной семьи; братья и сёстры — дети одной семьи. Семья без известных
// родителей в дерево не попадает, поэтому брат или сестра привязываются только через родителей.

export type RelationKind = 'parent' | 'spouse' | 'child' | 'sibling';
const RELATIONS: RelationKind[] = ['parent', 'spouse', 'child', 'sibling'];

type FamilyRow = { id: number; partner1_id: number | null; partner2_id: number | null };

export type NewRelative = {
  relation: RelationKind;
  /** Кого привязать: уже существующего человека или нового. */
  existingId: number | null;
  person: PersonFields | null;
  birth: Record<string, unknown> | null;
  /** Ребёнок — в какую семью (null — новая, второй родитель неизвестен); супруг — в семью без второго партнёра. */
  familyId: number | null;
};

export function parseNewRelative(body: Record<string, unknown>, parsePerson: (b: Record<string, unknown>) => PersonFields) {
  if (!RELATIONS.includes(body.relation as RelationKind)) throw new EditError(400, 'Неизвестный вид связи');
  const existingId = body.existingId ?? null;
  if (existingId !== null && (typeof existingId !== 'number' || !Number.isInteger(existingId))) {
    throw new EditError(400, 'Неверный человек');
  }
  const familyId = body.familyId ?? null;
  if (familyId !== null && (typeof familyId !== 'number' || !Number.isInteger(familyId))) {
    throw new EditError(400, 'Неверная семья');
  }
  let person: PersonFields | null = null;
  if (existingId === null) {
    person = parsePerson((body.person ?? {}) as Record<string, unknown>);
    if (!person.givenName && !person.surname) throw new EditError(400, 'Укажите хотя бы имя или фамилию');
  }
  const birth = existingId === null && body.birth ? (body.birth as Record<string, unknown>) : null;
  return { relation: body.relation as RelationKind, existingId, person, birth, familyId } satisfies NewRelative;
}

// --- Чтение ---

const partnersOf = (f: FamilyRow) => [f.partner1_id, f.partner2_id].filter((p): p is number => p !== null);

function family(db: Db, id: number): FamilyRow {
  const row = db.prepare('SELECT id, partner1_id, partner2_id FROM families WHERE id = ?').get(id) as FamilyRow | undefined;
  if (!row) throw new EditError(404, 'Семья не найдена');
  return row;
}

/** Семьи, где человек — ребёнок; родная — первой. */
function parentFamilies(db: Db, personId: number): FamilyRow[] {
  return db
    .prepare(
      `SELECT f.id, f.partner1_id, f.partner2_id FROM families f JOIN family_children fc ON fc.family_id = f.id
       WHERE fc.child_id = ? ORDER BY fc.relation = 'birth' DESC, f.id`,
    )
    .all(personId) as FamilyRow[];
}

function personSex(db: Db, id: number): 'M' | 'F' | 'U' {
  const row = db.prepare('SELECT sex FROM persons WHERE id = ?').get(id) as { sex: 'M' | 'F' | 'U' } | undefined;
  if (!row) throw new EditError(404, 'Человек не найден');
  return row.sex;
}

function personName(db: Db, id: number): string {
  const row = db.prepare('SELECT given_name, surname FROM persons WHERE id = ?').get(id) as
    | { given_name: string; surname: string }
    | undefined;
  return row ? [row.given_name, row.surname].filter(Boolean).join(' ') || 'Этот человек' : 'Этот человек';
}

function walk(db: Db, start: number, direction: 'up' | 'down'): Set<number> {
  const sql =
    direction === 'up'
      ? `SELECT f.partner1_id AS a, f.partner2_id AS b FROM family_children fc JOIN families f ON f.id = fc.family_id
         WHERE fc.child_id = ?`
      : `SELECT fc.child_id AS a, NULL AS b FROM families f JOIN family_children fc ON fc.family_id = f.id
         WHERE f.partner1_id = ?1 OR f.partner2_id = ?1`;
  const seen = new Set<number>();
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const row of db.prepare(sql).all(id) as { a: number | null; b: number | null }[]) {
      for (const next of [row.a, row.b]) {
        if (next !== null && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return seen;
}

const snapshot = (db: Db, familyId: number) => {
  const f = db.prepare('SELECT partner1_id, partner2_id FROM families WHERE id = ?').get(familyId) as
    | { partner1_id: number | null; partner2_id: number | null }
    | undefined;
  if (!f) return null;
  const children = (db.prepare('SELECT child_id FROM family_children WHERE family_id = ?').all(familyId) as {
    child_id: number;
  }[]).map((r) => r.child_id);
  return { partners: [f.partner1_id, f.partner2_id], children };
};

// --- Изменение семей (всё внутри транзакции вызывающего) ---

/** Мужчина — первым партнёром, как в GEDCOM (HUSB, WIFE). */
function ordered(db: Db, a: number | null, b: number | null): [number | null, number | null] {
  if (a !== null && b !== null && personSex(db, a) !== 'M' && personSex(db, b) === 'M') return [b, a];
  if (a === null && b !== null) return personSex(db, b) === 'F' ? [null, b] : [b, null];
  if (b === null && a !== null) return personSex(db, a) === 'F' ? [null, a] : [a, null];
  return [a, b];
}

function createFamily(db: Db, userId: number, partners: [number | null, number | null], children: number[]) {
  const [p1, p2] = ordered(db, partners[0], partners[1]);
  const { id } = db
    .prepare('INSERT INTO families (partner1_id, partner2_id) VALUES (?, ?) RETURNING id')
    .get(p1, p2) as { id: number };
  children.forEach((c, i) =>
    db.prepare('INSERT INTO family_children (family_id, child_id, position) VALUES (?, ?, ?)').run(id, c, i),
  );
  audit(db, userId, 'family', id, 'create', null, snapshot(db, id));
  return id;
}

/** Меняет семью и пишет в журнал, что было и что стало. */
function changeFamily(db: Db, userId: number, familyId: number, change: () => void) {
  const before = snapshot(db, familyId);
  change();
  db.prepare('UPDATE families SET version = version + 1 WHERE id = ?').run(familyId);
  audit(db, userId, 'family', familyId, 'update', before, snapshot(db, familyId));
}

function addChild(db: Db, userId: number, familyId: number, childId: number) {
  changeFamily(db, userId, familyId, () => {
    const { next } = db
      .prepare('SELECT coalesce(max(position) + 1, 0) AS next FROM family_children WHERE family_id = ?')
      .get(familyId) as { next: number };
    db.prepare('INSERT INTO family_children (family_id, child_id, position) VALUES (?, ?, ?)').run(
      familyId,
      childId,
      next,
    );
  });
}

function setPartner(db: Db, userId: number, f: FamilyRow, personId: number) {
  const [p1, p2] = ordered(db, partnersOf(f)[0] ?? null, personId);
  changeFamily(db, userId, f.id, () =>
    db.prepare('UPDATE families SET partner1_id = ?, partner2_id = ? WHERE id = ?').run(p1, p2, f.id),
  );
  // Если у этой пары уже была своя семья — объединяем, чтобы пара не раздвоилась в дереве.
  mergeFamiliesOfSameCouple(db, personId);
}

/**
 * Семья, от которой ничего не осталось (ни пары, ни родителя с детьми, ни хотя бы двух детей),
 * удаляется вместе со своими событиями.
 */
function dropIfEmpty(db: Db, userId: number, familyId: number) {
  const snap = snapshot(db, familyId);
  if (!snap) return;
  const partners = snap.partners.filter((p) => p !== null).length;
  const children = snap.children.length;
  const meaningful = partners === 2 || (partners === 1 && children > 0) || children > 1;
  if (meaningful) return;
  const events = db.prepare('SELECT * FROM events WHERE family_id = ?').all(familyId);
  db.prepare('DELETE FROM families WHERE id = ?').run(familyId);
  audit(db, userId, 'family', familyId, 'delete', { ...snap, events }, null);
}

// --- Операции ---

export function addRelative(db: Db, userId: number, anchorId: number, expectedVersion: unknown, input: NewRelative) {
  const expected = parseVersion(expectedVersion);
  return inTransaction(db, () => {
    bumpVersion(db, { kind: 'person', id: anchorId }, expected);
    const { relation } = input;

    let relativeId: number;
    if (input.existingId !== null) {
      relativeId = input.existingId;
      personSex(db, relativeId);
      if (relativeId === anchorId) throw new EditError(400, 'Нельзя связать человека с самим собой');
      checkExisting(db, anchorId, relativeId, relation);
      db.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(relativeId);
    } else {
      relativeId = createPerson(db, userId, input.person!);
      if (input.birth) {
        const yearless = typeof input.birth.dateText === 'string';
        const birth = parseEventFields(
          { type: 'birth', date: yearless ? null : input.birth, dateText: yearless ? input.birth.dateText : '' },
          'person',
        );
        addBirth(db, userId, relativeId, birth);
      }
    }

    if (relation === 'parent') linkParent(db, userId, anchorId, relativeId);
    else if (relation === 'spouse') linkSpouse(db, userId, anchorId, relativeId, input.familyId);
    else if (relation === 'child') linkChild(db, userId, anchorId, relativeId, input.familyId);
    else linkSibling(db, userId, anchorId, relativeId);
    return relativeId;
  });
}

function checkExisting(db: Db, anchorId: number, relativeId: number, relation: RelationKind) {
  const ancestors = walk(db, anchorId, 'up');
  const descendants = walk(db, anchorId, 'down');
  const name = personName(db, relativeId);
  if (relation === 'parent' && descendants.has(relativeId)) {
    throw new EditError(400, `${name} — потомок этого человека и не может быть его родителем`);
  }
  if (relation === 'child' && ancestors.has(relativeId)) {
    throw new EditError(400, `${name} — предок этого человека и не может быть его ребёнком`);
  }
  if ((relation === 'spouse' || relation === 'sibling') && (ancestors.has(relativeId) || descendants.has(relativeId))) {
    throw new EditError(400, `${name} — прямой предок или потомок этого человека`);
  }
  if ((relation === 'child' || relation === 'sibling') && parentFamilies(db, relativeId).length > 0) {
    throw new EditError(
      400,
      `У человека «${name}» уже есть родители. Если это дубль — объедините карточки; иначе добавьте недостающего родителя в его карточке.`,
    );
  }
}

function createPerson(db: Db, userId: number, fields: PersonFields): number {
  const { id } = db
    .prepare(
      `INSERT INTO persons (given_name, patronymic, surname, birth_surname, sex, is_deceased, is_uncertain, bio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      fields.givenName,
      fields.patronymic,
      fields.surname,
      fields.birthSurname,
      fields.sex,
      fields.isDeceased ? 1 : 0,
      fields.isUncertain ? 1 : 0,
      fields.bio,
    ) as { id: number };
  audit(db, userId, 'person', id, 'create', null, fields);
  return id;
}

// addEvent открывает свою транзакцию и проверяет версию, а мы уже внутри транзакции
// и человека только что создали, поэтому рождение вставляем напрямую.
function addBirth(db: Db, userId: number, personId: number, fields: ReturnType<typeof parseEventFields>) {
  const { id } = db
    .prepare(
      `INSERT INTO events (person_id, type, date_modifier, date_value, date_value_to, date_text)
       VALUES (?, 'birth', ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      personId,
      fields.date?.modifier ?? null,
      fields.date?.value ?? null,
      fields.date?.valueTo ?? null,
      fields.dateText,
    ) as { id: number };
  audit(db, userId, 'event', id, 'create', null, { owner: { kind: 'person', id: personId }, ...fields });
}

function linkParent(db: Db, userId: number, childId: number, parentId: number) {
  const families = parentFamilies(db, childId);
  if (families.length === 0) {
    createFamily(db, userId, [parentId, null], [childId]);
    return;
  }
  const f = families[0];
  const known = partnersOf(f);
  if (known.includes(parentId)) throw new EditError(400, 'Этот человек уже указан родителем');
  if (known.length === 2) throw new EditError(400, 'У человека уже указаны оба родителя');
  if (known.length === 1) {
    const sex = personSex(db, parentId);
    if (sex !== 'U' && personSex(db, known[0]) === sex) {
      throw new EditError(400, sex === 'M' ? 'Отец уже указан' : 'Мать уже указана');
    }
  }
  // Родитель добавляется всей семье — и братьям, и сёстрам из неё.
  setPartner(db, userId, f, parentId);
}

function linkSpouse(db: Db, userId: number, personId: number, spouseId: number, familyId: number | null) {
  const together = db
    .prepare(
      `SELECT 1 FROM families WHERE (partner1_id = ?1 AND partner2_id = ?2) OR (partner1_id = ?2 AND partner2_id = ?1)`,
    )
    .get(personId, spouseId);
  if (together) throw new EditError(400, 'Они уже указаны супругами');
  if (familyId === null) {
    createFamily(db, userId, [personId, spouseId], []);
    return;
  }
  const f = family(db, familyId);
  const known = partnersOf(f);
  if (!known.includes(personId) || known.length !== 1) {
    throw new EditError(400, 'В этой семье уже есть второй родитель');
  }
  setPartner(db, userId, f, spouseId);
}

function linkChild(db: Db, userId: number, parentId: number, childId: number, familyId: number | null) {
  if (familyId === null) {
    createFamily(db, userId, [parentId, null], [childId]);
    return;
  }
  const f = family(db, familyId);
  if (!partnersOf(f).includes(parentId)) throw new EditError(400, 'Это семья другого человека');
  addChild(db, userId, f.id, childId);
}

function linkSibling(db: Db, userId: number, personId: number, siblingId: number) {
  const families = parentFamilies(db, personId);
  if (families.length === 0) {
    throw new EditError(
      400,
      'Сначала добавьте хотя бы одного родителя: брат или сестра связываются через общих родителей',
    );
  }
  addChild(db, userId, families[0].id, siblingId);
}

/** Убирает ребёнка из семьи. Сам человек остаётся в дереве. */
export function removeChild(db: Db, userId: number, familyId: number, childId: number, expectedVersion: unknown) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    bumpVersion(db, { kind: 'family', id: familyId }, expected);
    const found = db.prepare('SELECT 1 FROM family_children WHERE family_id = ? AND child_id = ?').get(familyId, childId);
    if (!found) throw new EditError(404, 'Такого ребёнка в этой семье нет');
    changeFamily(db, userId, familyId, () =>
      db.prepare('DELETE FROM family_children WHERE family_id = ? AND child_id = ?').run(familyId, childId),
    );
    db.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(childId);
    dropIfEmpty(db, userId, familyId);
  });
}

/** Убирает родителя или супруга из семьи. Дети остаются у второго партнёра. */
export function removePartner(db: Db, userId: number, familyId: number, personId: number, expectedVersion: unknown) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    bumpVersion(db, { kind: 'family', id: familyId }, expected);
    const f = family(db, familyId);
    const column = f.partner1_id === personId ? 'partner1_id' : f.partner2_id === personId ? 'partner2_id' : null;
    if (!column) throw new EditError(404, 'Этого человека в семье нет');
    changeFamily(db, userId, familyId, () =>
      db.prepare(`UPDATE families SET ${column} = NULL WHERE id = ?`).run(familyId),
    );
    db.prepare('UPDATE persons SET version = version + 1 WHERE id = ?').run(personId);
    dropIfEmpty(db, userId, familyId);
  });
}

/** Удаляет человека со всеми его событиями и фото. Возвращает id фото, чьи файлы нужно убрать в корзину. */
export function deletePerson(db: Db, userId: number, personId: number, expectedVersion: unknown): number[] {
  const expected = parseVersion(expectedVersion);
  return inTransaction(db, () => {
    bumpVersion(db, { kind: 'person', id: personId }, expected);
    const account = db.prepare('SELECT login FROM users WHERE person_id = ?').get(personId) as
      | { login: string }
      | undefined;
    if (account) {
      throw new EditError(400, `К этому человеку привязан аккаунт «${account.login}» — его нельзя удалить`);
    }
    const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(personId);
    const events = db.prepare('SELECT * FROM events WHERE person_id = ?').all(personId);
    const media = db.prepare('SELECT * FROM media WHERE person_id = ?').all(personId) as { id: number }[];
    const families = (
      db
        .prepare(
          `SELECT id FROM families WHERE partner1_id = ?1 OR partner2_id = ?1
           UNION SELECT family_id FROM family_children WHERE child_id = ?1`,
        )
        .all(personId) as { id: number }[]
    ).map((f) => f.id);
    const links = families.map((id) => ({ id, ...snapshot(db, id) }));

    db.prepare('DELETE FROM persons WHERE id = ?').run(personId);
    audit(db, userId, 'person', personId, 'delete', { person, events, families: links, media }, null);
    for (const id of families) {
      db.prepare('UPDATE families SET version = version + 1 WHERE id = ?').run(id);
      dropIfEmpty(db, userId, id);
    }
    return media.map((m) => m.id);
  });
}

/** Сливает дубль в этого человека: связи, события и фото дубля переходят к нему. */
export function mergeDuplicate(db: Db, userId: number, keepId: number, dropId: number, expectedVersion: unknown) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    bumpVersion(db, { kind: 'person', id: keepId }, expected);
    if (keepId === dropId) throw new EditError(400, 'Нельзя объединить человека с самим собой');
    const keepSex = personSex(db, keepId);
    const dropSex = personSex(db, dropId);
    if (keepSex !== 'U' && dropSex !== 'U' && keepSex !== dropSex) {
      throw new EditError(400, 'У людей указан разный пол — это точно один человек?');
    }
    if (walk(db, keepId, 'up').has(dropId) || walk(db, keepId, 'down').has(dropId)) {
      throw new EditError(400, 'Один из них — предок другого; это не может быть один человек');
    }
    const before = db.prepare('SELECT * FROM persons WHERE id = ?').get(keepId);
    const drop = db.prepare('SELECT * FROM persons WHERE id = ?').get(dropId);
    mergeInto(db, keepId, dropId);
    audit(db, userId, 'person', dropId, 'delete', { person: drop, mergedInto: keepId }, null);
    audit(db, userId, 'person', keepId, 'update', before, { mergedFrom: dropId });
  });
}
