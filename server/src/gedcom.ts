// Разбор GEDCOM 5.5.1: строки → дерево записей, плюс даты и русские имена.

export type GedNode = {
  tag: string;
  xref?: string;
  value: string;
  children: GedNode[];
};

const LINE = /^(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?: (.*))?$/;

export function parseGedcom(text: string): GedNode[] {
  const roots: GedNode[] = [];
  const stack: GedNode[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const match = LINE.exec(line);
    if (!match) throw new Error(`GEDCOM: не удалось разобрать строку ${index + 1}: ${line}`);
    const level = Number(match[1]);
    const [, , xref, tag, value = ''] = match;

    if (level > stack.length) throw new Error(`GEDCOM: неверный уровень в строке ${index + 1}`);
    stack.length = level;
    const parent = stack[level - 1];

    // CONC/CONT — продолжение значения родителя, отдельными узлами не нужны.
    if (parent && (tag === 'CONC' || tag === 'CONT')) {
      parent.value += (tag === 'CONT' ? '\n' : '') + value;
      stack[level] = parent;
      return;
    }

    const node: GedNode = { tag, xref, value, children: [] };
    (parent ? parent.children : roots).push(node);
    stack[level] = node;
  });

  return roots;
}

export const child = (node: GedNode, tag: string) => node.children.find((c) => c.tag === tag);
export const childrenOf = (node: GedNode, tag: string) => node.children.filter((c) => c.tag === tag);
export const childValue = (node: GedNode, tag: string) => child(node, tag)?.value.trim() ?? '';

// --- Даты ---

export type DateModifier = 'exact' | 'about' | 'estimated' | 'calculated' | 'before' | 'after' | 'between';
/** Старый стиль — `calendar: 'julian'`; новый (григорианский) не пишем. */
export type ParsedDate = { modifier: DateModifier; value: string; valueTo?: string; calendar?: 'julian' };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const PREFIXES: Record<string, DateModifier> = { ABT: 'about', EST: 'estimated', CAL: 'calculated', BEF: 'before', AFT: 'after' };

// «9 MAY 1999» → 1999-05-09, «APR 1991» → 1991-04, «1925» → 1925.
function parseSimpleDate(text: string): string | undefined {
  const parts = text.trim().toUpperCase().split(/\s+/);
  const year = parts.at(-1);
  if (!year || !/^\d{3,4}$/.test(year)) return undefined;
  const y = year.padStart(4, '0');
  if (parts.length === 1) return y;

  const month = MONTHS.indexOf(parts.at(-2)!);
  if (month < 0) return undefined;
  const m = String(month + 1).padStart(2, '0');
  if (parts.length === 2) return `${y}-${m}`;

  if (parts.length !== 3 || !/^\d{1,2}$/.test(parts[0])) return undefined;
  const d = Number(parts[0]);
  if (d < 1 || d > 31) return undefined;
  return `${y}-${m}-${String(d).padStart(2, '0')}`;
}

const CALENDAR = /@#D([^@]+)@/g;

export function parseGedcomDate(text: string): ParsedDate | undefined {
  // Календарь — перед каждой датой: «@#DJULIAN@ 12 MAR 1885», «BET @#DJULIAN@ 1885 AND @#DJULIAN@ 1886».
  // Понимаем старый и новый стиль; разные календари в одном периоде не разбираем.
  const calendars = new Set([...text.toUpperCase().matchAll(CALENDAR)].map((m) => m[1].trim()));
  if ([...calendars].some((c) => c !== 'JULIAN' && c !== 'GREGORIAN') || calendars.size > 1) return undefined;
  const calendar = calendars.has('JULIAN') ? { calendar: 'julian' as const } : {};
  const upper = text.toUpperCase().replace(CALENDAR, ' ').replace(/\s+/g, ' ').trim();
  if (!upper) return undefined;

  const range = /^(?:BET|FROM)\s+(.+?)\s+(?:AND|TO)\s+(.+)$/.exec(upper);
  if (range) {
    const value = parseSimpleDate(range[1]);
    const valueTo = parseSimpleDate(range[2]);
    return value && valueTo ? { modifier: 'between', value, valueTo, ...calendar } : undefined;
  }

  const [first, ...rest] = upper.split(/\s+/);
  const modifier = PREFIXES[first];
  const value = parseSimpleDate(modifier ? rest.join(' ') : upper);
  return value ? { modifier: modifier ?? 'exact', value, ...calendar } : undefined;
}

// --- Имена ---

export type ParsedName = {
  givenName: string;
  patronymic: string;
  surname: string;
  birthSurname: string;
  uncertain: boolean;
};

const PATRONYMIC = /(вич|вна|ична|инична|ич)$/i;
const UNCERTAIN = /^\?+$/;

/**
 * Имя в выгрузке familio: `Анна Петровна /Соколова (Белова)/`, где в скобках —
 * девичья фамилия; отчество склеено с именем в GIVN; «?» и «???» означают сомнение.
 */
export function parseRussianName(nameValue: string): ParsedName {
  const slash = /^(.*?)\/(.*?)\/(.*)$/.exec(nameValue);
  const givenPart = slash ? `${slash[1]} ${slash[3]}` : nameValue;
  const surnamePart = slash ? slash[2].trim() : '';

  const tokens = givenPart.trim().split(/\s+/).filter(Boolean);
  const uncertain = tokens.some((t) => UNCERTAIN.test(t)) || /\?/.test(surnamePart);
  const words = tokens.filter((t) => !UNCERTAIN.test(t));

  let patronymic = '';
  if (words.length >= 2 && PATRONYMIC.test(words.at(-1)!)) patronymic = words.pop()!;

  const surnameMatch = /^(.*?)\s*\((.*)\)\s*$/.exec(surnamePart);
  let surname = (surnameMatch ? surnameMatch[1] : surnamePart).replace(/\?/g, '').trim();
  let birthSurname = surnameMatch ? surnameMatch[2].replace(/\?/g, '').trim() : '';
  if (!surname && birthSurname) [surname, birthSurname] = [birthSurname, ''];
  if (birthSurname === surname) birthSurname = '';

  return { givenName: words.join(' '), patronymic, surname, birthSurname, uncertain };
}

// «N57.6263877» → 57.6263877, «S12.5» → -12.5.
export function parseCoordinate(value: string): number | undefined {
  const match = /^([NSEW])?\s*(-?\d+(?:\.\d+)?)$/i.exec(value.trim());
  if (!match) return undefined;
  const n = Number(match[2]);
  return match[1] && /[SW]/i.test(match[1]) ? -n : n;
}
