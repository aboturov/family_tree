import type { Db } from './db.ts';
import type { DateModifier } from './gedcom.ts';

export type TreeEvent = {
  id: number;
  type: string;
  customType: string;
  /** Что именно: название награды, звание, профессия. */
  details: string;
  /** `calendar` — только у дат по старому стилю. */
  date: { modifier: DateModifier; value: string; valueTo?: string; calendar?: 'julian' } | null;
  dateText: string;
  place: { name: string; lat: number | null; lon: number | null } | null;
  note: string;
  /** Документы, которые подтверждают событие (только если есть). */
  documents?: number[];
};

export type TreePhoto = { id: number; caption: string; width: number; height: number };

export type TreePerson = {
  id: number;
  version: number;
  /** Аватарка: одно из фото и кадрирование круга (см. media.ts). */
  avatar: { mediaId: number; crop: { x: number; y: number; zoom: number } } | null;
  photos: TreePhoto[];
  /** Документы, где человек упомянут; сами документы — GET /api/documents. */
  documents: number[];
  givenName: string;
  patronymic: string;
  surname: string;
  birthSurname: string;
  sex: 'M' | 'F' | 'U';
  /** Есть событие смерти, хотя бы без даты. */
  isDeceased: boolean;
  isUncertain: boolean;
  bio: string;
  events: TreeEvent[];
};

export type TreeFamily = {
  id: number;
  version: number;
  partners: [number | null, number | null];
  children: { id: number; relation: string }[];
  events: TreeEvent[];
};

export type Tree = { persons: TreePerson[]; families: TreeFamily[] };

type EventRow = {
  id: number;
  person_id: number | null;
  family_id: number | null;
  type: string;
  custom_type: string;
  details: string;
  date_modifier: DateModifier | null;
  date_value: string | null;
  date_value_to: string | null;
  date_calendar: 'gregorian' | 'julian';
  date_text: string;
  note: string;
  place_name: string | null;
  lat: number | null;
  lon: number | null;
};

// Данных немного (сотни людей), поэтому дерево отдаётся целиком одним запросом.
export function getTree(db: Db): Tree {
  const documentsOf = (sql: string) => {
    const map = new Map<number, number[]>();
    for (const row of db.prepare(sql).all() as { owner: number; document_id: number }[]) {
      map.set(row.owner, [...(map.get(row.owner) ?? []), row.document_id]);
    }
    return map;
  };
  const eventDocuments = documentsOf('SELECT event_id AS owner, document_id FROM document_events ORDER BY document_id');
  const personDocuments = documentsOf('SELECT person_id AS owner, document_id FROM document_persons ORDER BY document_id');

  const eventRows = db
    .prepare(
      `SELECT e.*, p.name AS place_name, p.lat, p.lon
       FROM events e LEFT JOIN places p ON p.id = e.place_id
       ORDER BY coalesce(e.date_value, '9999'), e.id`,
    )
    .all() as EventRow[];

  const personEvents = new Map<number, TreeEvent[]>();
  const familyEvents = new Map<number, TreeEvent[]>();
  for (const row of eventRows) {
    const event: TreeEvent = {
      id: row.id,
      type: row.type,
      customType: row.custom_type,
      details: row.details,
      date:
        row.date_modifier && row.date_value
          ? {
              modifier: row.date_modifier,
              value: row.date_value,
              ...(row.date_value_to ? { valueTo: row.date_value_to } : {}),
              ...(row.date_calendar === 'julian' ? { calendar: 'julian' as const } : {}),
            }
          : null,
      dateText: row.date_text,
      place: row.place_name ? { name: row.place_name, lat: row.lat, lon: row.lon } : null,
      note: row.note,
      ...(eventDocuments.has(row.id) ? { documents: eventDocuments.get(row.id) } : {}),
    };
    const [map, key] = row.person_id !== null ? [personEvents, row.person_id] : [familyEvents, row.family_id!];
    map.set(key, [...(map.get(key) ?? []), event]);
  }

  const photos = new Map<number, TreePhoto[]>();
  for (const row of db
    .prepare('SELECT id, person_id, caption, width, height FROM media ORDER BY id')
    .all() as (TreePhoto & {
    person_id: number;
  })[]) {
    const { person_id, ...photo } = row;
    photos.set(person_id, [...(photos.get(person_id) ?? []), photo]);
  }

  const persons = (
    db.prepare('SELECT * FROM persons ORDER BY id').all() as {
      id: number;
      given_name: string;
      patronymic: string;
      surname: string;
      birth_surname: string;
      sex: 'M' | 'F' | 'U';
      is_uncertain: number;
      bio: string;
      version: number;
      avatar_media_id: number | null;
      avatar_crop: string | null;
    }[]
  ).map((row): TreePerson => ({
    id: row.id,
    version: row.version,
    avatar:
      row.avatar_media_id !== null && row.avatar_crop
        ? { mediaId: row.avatar_media_id, crop: JSON.parse(row.avatar_crop) }
        : null,
    photos: photos.get(row.id) ?? [],
    documents: personDocuments.get(row.id) ?? [],
    givenName: row.given_name,
    patronymic: row.patronymic,
    surname: row.surname,
    birthSurname: row.birth_surname,
    sex: row.sex,
    isDeceased: (personEvents.get(row.id) ?? []).some((e) => e.type === 'death'),
    isUncertain: row.is_uncertain === 1,
    bio: row.bio,
    events: personEvents.get(row.id) ?? [],
  }));

  const childRows = db
    .prepare('SELECT family_id, child_id, relation FROM family_children ORDER BY family_id, position, child_id')
    .all() as { family_id: number; child_id: number; relation: string }[];
  const children = new Map<number, TreeFamily['children']>();
  for (const row of childRows) {
    children.set(row.family_id, [...(children.get(row.family_id) ?? []), { id: row.child_id, relation: row.relation }]);
  }

  const families = (
    db.prepare('SELECT id, version, partner1_id, partner2_id FROM families ORDER BY id').all() as {
      id: number;
      version: number;
      partner1_id: number | null;
      partner2_id: number | null;
    }[]
  ).map((row): TreeFamily => ({
    id: row.id,
    version: row.version,
    partners: [row.partner1_id, row.partner2_id],
    children: children.get(row.id) ?? [],
    events: familyEvents.get(row.id) ?? [],
  }));

  return { persons, families };
}
