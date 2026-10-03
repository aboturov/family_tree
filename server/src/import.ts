import type { Db } from './db.ts';
import {
  child,
  childrenOf,
  childValue,
  parseCoordinate,
  parseGedcom,
  parseGedcomDate,
  parseRussianName,
  type GedNode,
} from './gedcom.ts';

export type ImportReport = {
  persons: number;
  families: number;
  events: number;
  places: number;
  warnings: string[];
};

const PERSON_EVENTS: Record<string, string> = {
  BIRT: 'birth',
  DEAT: 'death',
  BURI: 'burial',
  BAPM: 'baptism',
  CHR: 'baptism',
  OCCU: 'occupation',
  EDUC: 'education',
  GRAD: 'graduation',
  RESI: 'residence',
  EMIG: 'emigration',
  IMMI: 'immigration',
  RETI: 'retirement',
  EVEN: 'custom',
};

const FAMILY_EVENTS: Record<string, string> = {
  MARR: 'marriage',
  DIV: 'divorce',
  ENGA: 'engagement',
  EVEN: 'custom',
};

// Пустые записи familio выгружает у всех; смысл несут только эти даже без даты:
// «умер» и «развелись».
const MEANINGFUL_WITHOUT_DETAILS = new Set(['death', 'divorce']);

export function isTreeEmpty(db: Db): boolean {
  const { n } = db.prepare('SELECT count(*) AS n FROM persons').get() as { n: number };
  return n === 0;
}

export function clearTree(db: Db) {
  db.exec('DELETE FROM events; DELETE FROM family_children; DELETE FROM families; DELETE FROM persons; DELETE FROM places;');
}

export function importGedcom(db: Db, text: string, { replace = false } = {}): ImportReport {
  const records = parseGedcom(text);
  const report: ImportReport = { persons: 0, families: 0, events: 0, places: 0, warnings: [] };

  db.exec('BEGIN');
  try {
    if (!isTreeEmpty(db)) {
      if (!replace) throw new Error('В базе уже есть дерево. Повторный импорт — только с --replace (текущее дерево будет удалено).');
      clearTree(db);
    }
    new Importer(db, report).run(records);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return report;
}

class Importer {
  private readonly personIds = new Map<string, number>();
  private readonly personLabels = new Map<string, string>();
  private readonly placeIds = new Map<string, number>();
  private readonly unknownTags = new Map<string, number>();
  private readonly db: Db;
  private readonly report: ImportReport;

  constructor(db: Db, report: ImportReport) {
    this.db = db;
    this.report = report;
  }

  run(records: GedNode[]) {
    for (const record of records) if (record.tag === 'INDI') this.importPerson(record);
    for (const record of records) if (record.tag === 'FAM') this.importFamily(record);
    this.reportDuplicates();
    for (const [tag, count] of this.unknownTags) {
      this.report.warnings.push(`Пропущены записи ${tag} (${count} шт.): такой тип событий пока не поддерживается`);
    }
  }

  private importPerson(node: GedNode) {
    const ref = stripRef(node.xref);
    const nameNode = child(node, 'NAME');
    const name = parseRussianName(nameNode?.value ?? '');
    // Отдельные SURN/_MARNM надёжнее скобок, если они есть.
    const surn = nameNode ? childValue(nameNode, 'SURN') : '';
    const marnm = nameNode ? childValue(nameNode, '_MARNM') : '';
    if (surn && marnm && surn !== marnm) {
      name.surname = marnm;
      name.birthSurname = surn;
    }

    const sexValue = childValue(node, 'SEX').toUpperCase();
    const sex = sexValue === 'M' || sexValue === 'F' ? sexValue : 'U';
    const bio = childrenOf(node, 'NOTE')
      .map((n) => n.value.trim())
      .filter(Boolean)
      .join('\n\n');
    const { id } = this.db
      .prepare(
        `INSERT INTO persons (source_uid, source_ref, given_name, patronymic, surname, birth_surname, sex, is_uncertain, bio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        childValue(node, '_UID') || null,
        ref,
        name.givenName,
        name.patronymic,
        name.surname,
        name.birthSurname,
        sex,
        name.uncertain ? 1 : 0,
        bio,
      ) as { id: number };

    this.personIds.set(ref, id);
    const label = [name.givenName, name.patronymic, name.surname].filter(Boolean).join(' ') || '(без имени)';
    this.personLabels.set(ref, label);
    this.report.persons++;
    if (name.uncertain) this.report.warnings.push(`${ref} ${label}: в имени есть «?», человек помечен «данные под вопросом»`);

    for (const eventNode of node.children) {
      const type = PERSON_EVENTS[eventNode.tag];
      if (type) this.importEvent(eventNode, type, { personId: id });
      else if (isEventLike(eventNode)) this.countUnknown(eventNode.tag);
    }
  }

  private importFamily(node: GedNode) {
    const ref = stripRef(node.xref);
    const partner1 = this.resolvePerson(childValue(node, 'HUSB'), ref);
    const partner2 = this.resolvePerson(childValue(node, 'WIFE'), ref);
    const children = childrenOf(node, 'CHIL')
      .map((c) => this.resolvePerson(c.value, ref))
      .filter((id): id is number => id !== null);

    if (partner1 === null && partner2 === null && children.length === 0) {
      this.report.warnings.push(`Семья ${ref}: нет ни партнёров, ни детей — пропущена`);
      return;
    }

    const { id } = this.db
      .prepare('INSERT INTO families (source_ref, partner1_id, partner2_id) VALUES (?, ?, ?) RETURNING id')
      .get(ref, partner1, partner2) as { id: number };
    this.report.families++;

    children.forEach((childId, position) => {
      this.db
        .prepare('INSERT OR IGNORE INTO family_children (family_id, child_id, position) VALUES (?, ?, ?)')
        .run(id, childId, position);
    });

    if ((partner1 === null) !== (partner2 === null)) {
      const known = this.labelOf(childValue(node, partner1 !== null ? 'HUSB' : 'WIFE'));
      this.report.warnings.push(`Семья ${ref}: известен только один партнёр (${known}), второй — «неизвестен»`);
    }

    const seen = new Set<string>();
    for (const eventNode of node.children) {
      const type = FAMILY_EVENTS[eventNode.tag];
      if (!type) {
        if (isEventLike(eventNode)) this.countUnknown(eventNode.tag);
        continue;
      }
      // familio дублирует события (например, два DIV у одной семьи) — оставляем одно.
      const key = `${type}|${childValue(eventNode, 'DATE')}|${childValue(eventNode, 'PLAC')}`;
      if (seen.has(key)) {
        this.report.warnings.push(`Семья ${ref}: повторное событие ${eventNode.tag} — дубль пропущен`);
        continue;
      }
      seen.add(key);
      this.importEvent(eventNode, type, { familyId: id });
    }
  }

  private importEvent(node: GedNode, type: string, owner: { personId?: number; familyId?: number }) {
    const dateText = childValue(node, 'DATE');
    const placeNode = child(node, 'PLAC');
    const note = childrenOf(node, 'NOTE')
      .map((n) => n.value.trim())
      .filter(Boolean)
      .join('\n');
    const customType = type === 'custom' ? childValue(node, 'TYPE') || node.value.trim() : '';

    const hasDetails = dateText || placeNode?.value.trim() || note || customType || node.value.trim();
    if (!hasDetails && !MEANINGFUL_WITHOUT_DETAILS.has(type)) return;

    const date = dateText ? parseGedcomDate(dateText) : undefined;
    if (dateText && !date) this.report.warnings.push(`Не удалось разобрать дату «${dateText}» — сохранена как текст`);

    this.db
      .prepare(
        `INSERT INTO events (person_id, family_id, type, custom_type, date_modifier, date_value, date_value_to,
           date_calendar, date_text, place_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        owner.personId ?? null,
        owner.familyId ?? null,
        type,
        customType,
        date?.modifier ?? null,
        date?.value ?? null,
        date?.valueTo ?? null,
        date?.calendar ?? 'gregorian',
        date ? '' : dateText,
        placeNode ? this.placeId(placeNode) : null,
        note,
      );
    this.report.events++;
  }

  private placeId(node: GedNode): number | null {
    const name = node.value.trim();
    if (!name) return null;
    const existing = this.placeIds.get(name);
    if (existing) return existing;

    const map = child(node, 'MAP');
    const lat = map ? parseCoordinate(childValue(map, 'LATI')) : undefined;
    const lon = map ? parseCoordinate(childValue(map, 'LONG')) : undefined;
    const { id } = this.db
      .prepare('INSERT INTO places (name, lat, lon) VALUES (?, ?, ?) RETURNING id')
      .get(name, lat ?? null, lon ?? null) as { id: number };
    this.placeIds.set(name, id);
    this.report.places++;
    return id;
  }

  private resolvePerson(xref: string, familyRef: string): number | null {
    if (!xref) return null;
    const id = this.personIds.get(stripRef(xref));
    if (id === undefined) this.report.warnings.push(`Семья ${familyRef}: ссылка на несуществующего человека ${xref}`);
    return id ?? null;
  }

  private labelOf(xref: string) {
    const ref = stripRef(xref);
    return `${ref} ${this.personLabels.get(ref) ?? ''}`.trim();
  }

  private countUnknown(tag: string) {
    this.unknownTags.set(tag, (this.unknownTags.get(tag) ?? 0) + 1);
  }

  private reportDuplicates() {
    const groups = new Map<string, string[]>();
    for (const [ref, label] of this.personLabels) {
      const key = label.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), ref]);
    }
    for (const refs of groups.values()) {
      if (refs.length < 2) continue;
      this.report.warnings.push(
        `Возможный дубль: ${refs.join(', ')} — ${this.personLabels.get(refs[0])}. ` +
          `Если это один человек: tree-admin person:merge ${refs[0]} ${refs.slice(1).join(' ')}`,
      );
    }
  }
}

const stripRef = (xref = '') => xref.replace(/@/g, '');

// Служебные теги (_UID, NAME, FAMC и т.п.) событиями не считаем.
const NOT_EVENTS = new Set(['NAME', 'SEX', 'FAMC', 'FAMS', 'NOTE', 'HUSB', 'WIFE', 'CHIL', 'OBJE', 'SOUR', 'CHAN', 'RIN', 'REFN']);
const isEventLike = (node: GedNode) => !node.tag.startsWith('_') && !NOT_EVENTS.has(node.tag);
