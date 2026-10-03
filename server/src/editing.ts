import type { Db } from './db.ts';
import type { DateModifier } from './gedcom.ts';
import { audit, inTransaction } from './journal.ts';

// Правка дерева с сайта. Каждая правка — транзакция: проверка версии владельца (человека или
// семьи), изменение, запись в журнал, новая версия. Ошибки — EditError с HTTP-статусом.

export class EditError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const CONFLICT = 'Эту карточку только что изменил кто-то ещё. Обновите страницу и повторите правку.';

// --- Проверка входных данных ---

const text = (value: unknown, field: string, max: number): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new EditError(400, `Поле «${field}» должно быть строкой`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new EditError(400, `Поле «${field}» длиннее ${max} символов`);
  return trimmed;
};

export const parseVersion = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new EditError(400, 'Не указана версия карточки');
  return value;
};

export type PersonFields = {
  givenName: string;
  patronymic: string;
  surname: string;
  birthSurname: string;
  sex: 'M' | 'F' | 'U';
  isDeceased: boolean;
  isUncertain: boolean;
  bio: string;
};

export function parsePersonFields(body: Record<string, unknown>): PersonFields {
  const sex = body.sex;
  if (sex !== 'M' && sex !== 'F' && sex !== 'U') throw new EditError(400, 'Пол: M, F или U');
  return {
    givenName: text(body.givenName, 'Имя', 100),
    patronymic: text(body.patronymic, 'Отчество', 100),
    surname: text(body.surname, 'Фамилия', 100),
    birthSurname: text(body.birthSurname, 'Фамилия при рождении', 100),
    sex,
    isDeceased: body.isDeceased === true,
    isUncertain: body.isUncertain === true,
    bio: text(body.bio, 'Биография', 20_000),
  };
}

export const PERSON_EVENT_TYPES = [
  'birth',
  'death',
  'burial',
  'baptism',
  'occupation',
  'education',
  'graduation',
  'residence',
  'emigration',
  'immigration',
  'retirement',
  'custom',
] as const;
export const FAMILY_EVENT_TYPES = ['marriage', 'divorce', 'engagement', 'custom'] as const;

const MODIFIERS: DateModifier[] = ['exact', 'about', 'estimated', 'calculated', 'before', 'after', 'between'];
const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

// Дата без года («12 марта», «март») в формат ГГГГ-ММ-ДД не ложится — её храним текстом
// в date_text, как и неразобранные даты импорта. Форма разбирает такой текст обратно в поля.
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOMINATIVE = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isYearlessDate(value: string): boolean {
  if (MONTHS_NOMINATIVE.includes(value)) return true;
  const match = /^(\d{1,2}) (\S+)$/.exec(value);
  if (!match) return false;
  const month = MONTHS_GENITIVE.indexOf(match[2]);
  const day = Number(match[1]);
  return month >= 0 && day >= 1 && day <= DAYS_IN_MONTH[month];
}

export type Calendar = 'gregorian' | 'julian';

/** Календарь даты: по умолчанию — новый стиль. */
export function parseCalendar(value: unknown): Calendar {
  if (value === undefined || value === null || value === 'gregorian') return 'gregorian';
  if (value === 'julian') return 'julian';
  throw new EditError(400, 'Календарь: gregorian или julian');
}

export type EventFields = {
  type: string;
  customType: string;
  /** `calendar: 'julian'` — по старому стилю. */
  date: { modifier: DateModifier; value: string; valueTo: string | null; calendar: Calendar } | null;
  /** Дата без года — только когда `date` пуста. */
  dateText: string;
  place: string;
  note: string;
};

export function parseEventFields(body: Record<string, unknown>, owner: 'person' | 'family'): EventFields {
  const allowed: readonly string[] = owner === 'person' ? PERSON_EVENT_TYPES : FAMILY_EVENT_TYPES;
  if (typeof body.type !== 'string' || !allowed.includes(body.type))
    throw new EditError(400, 'Неизвестный тип события');
  const customType = text(body.customType, 'Название события', 100);
  if (body.type === 'custom' && !customType) throw new EditError(400, 'Укажите название события');

  let date: EventFields['date'] = null;
  if (body.date !== null && body.date !== undefined) {
    const d = body.date as Record<string, unknown>;
    const modifier = d.modifier as DateModifier;
    if (!MODIFIERS.includes(modifier)) throw new EditError(400, 'Неизвестная точность даты');
    if (typeof d.value !== 'string' || !PARTIAL_DATE.test(d.value))
      throw new EditError(400, 'Дата: ГГГГ, ГГГГ-ММ или ГГГГ-ММ-ДД');
    let valueTo: string | null = null;
    if (modifier === 'between') {
      if (typeof d.valueTo !== 'string' || !PARTIAL_DATE.test(d.valueTo))
        throw new EditError(400, 'Укажите вторую дату периода');
      if (d.valueTo < d.value) throw new EditError(400, 'Вторая дата периода раньше первой');
      valueTo = d.valueTo;
    }
    date = { modifier, value: d.value, valueTo, calendar: parseCalendar(d.calendar) };
  }
  const dateText = date ? '' : text(body.dateText, 'Дата', 20);
  if (dateText && !isYearlessDate(dateText)) throw new EditError(400, 'Дата без года: «12 марта» или «март»');

  return {
    type: body.type,
    customType: body.type === 'custom' ? customType : '',
    date,
    dateText,
    place: text(body.place, 'Место', 300),
    note: text(body.note, 'Примечание', 5_000),
  };
}

// --- Версии ---

/** Проверяет версию владельца и поднимает её — все правки карточки идут через это. */
export function bumpVersion(db: Db, owner: { kind: 'person' | 'family'; id: number }, expected: number) {
  const table = owner.kind === 'person' ? 'persons' : 'families';
  const row = db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(owner.id) as { version: number } | undefined;
  if (!row) throw new EditError(404, owner.kind === 'person' ? 'Человек не найден' : 'Семья не найдена');
  if (row.version !== expected) throw new EditError(409, CONFLICT);
  db.prepare(`UPDATE ${table} SET version = version + 1 WHERE id = ?`).run(owner.id);
}

// --- Человек ---

type PersonRow = {
  given_name: string;
  patronymic: string;
  surname: string;
  birth_surname: string;
  sex: 'M' | 'F' | 'U';
  is_uncertain: number;
  bio: string;
};

export function updatePerson(db: Db, userId: number, personId: number, expectedVersion: unknown, fields: PersonFields) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    const before = db.prepare('SELECT * FROM persons WHERE id = ?').get(personId) as PersonRow | undefined;
    bumpVersion(db, { kind: 'person', id: personId }, expected);
    db.prepare(
      `UPDATE persons SET given_name = ?, patronymic = ?, surname = ?, birth_surname = ?, sex = ?,
         is_uncertain = ?, bio = ? WHERE id = ?`,
    ).run(
      fields.givenName,
      fields.patronymic,
      fields.surname,
      fields.birthSurname,
      fields.sex,
      fields.isUncertain ? 1 : 0,
      fields.bio,
      personId,
    );
    audit(db, userId, 'person', personId, 'update', before, fields);
    setDeceased(db, userId, personId, fields.isDeceased);
  });
}

/**
 * «Умер» — это событие смерти, пусть и без даты (как `1 DEAT Y` в GEDCOM). Галочка в карточке
 * добавляет пустое событие или убирает его; смерть с датой или местом убирают только из ленты.
 */
export function setDeceased(db: Db, userId: number, personId: number, deceased: boolean) {
  const deaths = db.prepare("SELECT * FROM events WHERE person_id = ? AND type = 'death'").all(personId) as EventRow[];
  if (deceased && deaths.length === 0) {
    const { id } = db
      .prepare("INSERT INTO events (person_id, type) VALUES (?, 'death') RETURNING id")
      .get(personId) as { id: number };
    audit(db, userId, 'event', id, 'create', null, { owner: { kind: 'person', id: personId }, type: 'death' });
  }
  if (deceased || deaths.length === 0) return;
  if (deaths.some((e) => e.date_value !== null || e.date_text || e.place_id !== null || e.note)) {
    throw new EditError(400, 'У смерти указаны дата или место — чтобы снять отметку «Умер», удалите событие «Смерть»');
  }
  for (const death of deaths) {
    db.prepare('DELETE FROM events WHERE id = ?').run(death.id);
    audit(db, userId, 'event', death.id, 'delete', death, null);
  }
}

// --- Места ---

/** Место по названию: существующее (без учёта регистра и лишних пробелов) или новое. */
function placeId(db: Db, userId: number, name: string): number | null {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  // lower() в SQLite не знает кириллицы — сравниваем в JS, мест немного.
  const places = db.prepare('SELECT id, name FROM places').all() as { id: number; name: string }[];
  const existing = places.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.id;
  const { id } = db.prepare('INSERT INTO places (name) VALUES (?) RETURNING id').get(clean) as { id: number };
  audit(db, userId, 'place', id, 'create', null, { name: clean });
  return id;
}

/** Подсказки мест: подходящие по подстроке, сначала самые используемые. */
export function suggestPlaces(db: Db, query: string, limit = 10): { name: string; uses: number }[] {
  const q = query.trim().toLowerCase();
  // lower() в SQLite не знает кириллицы — фильтруем в JS, мест немного.
  const rows = db
    .prepare(
      `SELECT p.name, count(e.id) AS uses FROM places p LEFT JOIN events e ON e.place_id = p.id
       GROUP BY p.id ORDER BY uses DESC, p.name`,
    )
    .all() as { name: string; uses: number }[];
  return rows.filter((r) => !q || r.name.toLowerCase().includes(q)).slice(0, limit);
}

// --- События ---

type Owner = { kind: 'person' | 'family'; id: number };

type EventRow = {
  id: number;
  person_id: number | null;
  family_id: number | null;
  type: string;
  custom_type: string;
  date_modifier: string | null;
  date_value: string | null;
  date_value_to: string | null;
  date_calendar: Calendar;
  date_text: string;
  place_id: number | null;
  note: string;
};

const ownerOf = (row: EventRow): Owner =>
  row.person_id !== null ? { kind: 'person', id: row.person_id } : { kind: 'family', id: row.family_id! };

function getEvent(db: Db, eventId: number): EventRow {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
  if (!row) throw new EditError(404, 'Событие не найдено');
  return row;
}

export function addEvent(db: Db, userId: number, owner: Owner, expectedVersion: unknown, fields: EventFields): number {
  const expected = parseVersion(expectedVersion);
  return inTransaction(db, () => {
    bumpVersion(db, owner, expected);
    const { id } = db
      .prepare(
        `INSERT INTO events (person_id, family_id, type, custom_type, date_modifier, date_value, date_value_to,
           date_calendar, date_text, place_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        owner.kind === 'person' ? owner.id : null,
        owner.kind === 'family' ? owner.id : null,
        fields.type,
        fields.customType,
        fields.date?.modifier ?? null,
        fields.date?.value ?? null,
        fields.date?.valueTo ?? null,
        fields.date?.calendar ?? 'gregorian',
        fields.dateText,
        placeId(db, userId, fields.place),
        fields.note,
      ) as { id: number };
    audit(db, userId, 'event', id, 'create', null, { owner, ...fields });
    return id;
  });
}

/**
 * Правка события. `moveToFamily` — перенести семейное событие в другой брак того же человека:
 * так чинятся браки, которые импорт разорвал на «половинки» с неизвестным супругом.
 */
export function updateEvent(
  db: Db,
  userId: number,
  eventId: number,
  expectedVersion: unknown,
  fields: EventFields,
  moveToFamily: number | null = null,
) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    const before = getEvent(db, eventId);
    const owner = ownerOf(before);
    if (!(owner.kind === 'person' ? PERSON_EVENT_TYPES : FAMILY_EVENT_TYPES).includes(fields.type as never)) {
      throw new EditError(400, 'Этот тип события не подходит');
    }
    bumpVersion(db, owner, expected);
    let familyId = before.family_id;
    if (moveToFamily !== null && moveToFamily !== before.family_id) {
      if (owner.kind !== 'family') throw new EditError(400, 'Переносить между браками можно только семейные события');
      if (!sharePartner(db, owner.id, moveToFamily)) throw new EditError(400, 'Этот брак другого человека');
      db.prepare('UPDATE families SET version = version + 1 WHERE id = ?').run(moveToFamily);
      familyId = moveToFamily;
    }
    db.prepare(
      `UPDATE events SET family_id = ?, type = ?, custom_type = ?, date_modifier = ?, date_value = ?, date_value_to = ?,
         date_calendar = ?, date_text = ?, place_id = ?, note = ? WHERE id = ?`,
    ).run(
      familyId,
      fields.type,
      fields.customType,
      fields.date?.modifier ?? null,
      fields.date?.value ?? null,
      fields.date?.valueTo ?? null,
      fields.date?.calendar ?? 'gregorian',
      fields.dateText,
      placeId(db, userId, fields.place),
      fields.note,
      eventId,
    );
    audit(db, userId, 'event', eventId, 'update', before, { ...fields, familyId });
    if (familyId !== before.family_id) dropHollowFamily(db, userId, before.family_id!);
  });
}

function sharePartner(db: Db, a: number, b: number): boolean {
  const partners = (id: number) => {
    const row = db.prepare('SELECT partner1_id, partner2_id FROM families WHERE id = ?').get(id) as
      | { partner1_id: number | null; partner2_id: number | null }
      | undefined;
    if (!row) throw new EditError(404, 'Семья не найдена');
    return [row.partner1_id, row.partner2_id].filter((p) => p !== null);
  };
  const other = partners(b);
  return partners(a).some((p) => other.includes(p));
}

/** Семья-«половинка» без второго супруга, детей и событий ничего не значит — удаляем. */
function dropHollowFamily(db: Db, userId: number, familyId: number) {
  const row = db
    .prepare(
      `SELECT partner1_id, partner2_id FROM families f WHERE id = ?
         AND (partner1_id IS NULL OR partner2_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM family_children WHERE family_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM events WHERE family_id = f.id)`,
    )
    .get(familyId) as { partner1_id: number | null; partner2_id: number | null } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM families WHERE id = ?').run(familyId);
  audit(db, userId, 'family', familyId, 'delete', { partners: [row.partner1_id, row.partner2_id], children: [], events: [] }, null);
}

export function deleteEvent(db: Db, userId: number, eventId: number, expectedVersion: unknown) {
  const expected = parseVersion(expectedVersion);
  inTransaction(db, () => {
    const before = getEvent(db, eventId);
    bumpVersion(db, ownerOf(before), expected);
    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    audit(db, userId, 'event', eventId, 'delete', before, null);
    if (before.family_id !== null) dropHollowFamily(db, userId, before.family_id);
  });
}

export function eventOwnerKind(db: Db, eventId: number): 'person' | 'family' {
  return ownerOf(getEvent(db, eventId)).kind;
}
