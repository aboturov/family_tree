// Форма ответа GET /api/tree (см. server/src/tree.ts) и хелперы для отображения.

export type DateModifier = 'exact' | 'about' | 'estimated' | 'calculated' | 'before' | 'after' | 'between';

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

export type Photo = { id: number; caption: string; width: number; height: number };
/** Кадрирование аватарки: центр круга в долях кадра и диаметр в долях меньшей стороны. */
export type AvatarCrop = { x: number; y: number; zoom: number };

export type Person = {
  id: number;
  version: number;
  avatar: { mediaId: number; crop: AvatarCrop } | null;
  photos: Photo[];
  /** Документы, где человек упомянут; сами документы грузятся отдельно (documents/DocumentsContext.ts). */
  documents: number[];
  givenName: string;
  patronymic: string;
  surname: string;
  birthSurname: string;
  sex: 'M' | 'F' | 'U';
  isDeceased: boolean;
  isUncertain: boolean;
  bio: string;
  events: TreeEvent[];
};

export type Family = {
  id: number;
  version: number;
  partners: [number | null, number | null];
  children: { id: number; relation: string }[];
  events: TreeEvent[];
};

export type Tree = { persons: Person[]; families: Family[] };

/** Связи, посчитанные один раз: кто чей родитель, супруг, ребёнок. */
export type TreeIndex = {
  persons: Map<number, Person>;
  families: Map<number, Family>;
  familiesAsPartner: Map<number, Family[]>;
  familyAsChild: Map<number, Family[]>;
};

export function indexTree(tree: Tree): TreeIndex {
  const index: TreeIndex = {
    persons: new Map(tree.persons.map((p) => [p.id, p])),
    families: new Map(tree.families.map((f) => [f.id, f])),
    familiesAsPartner: new Map(),
    familyAsChild: new Map(),
  };
  const push = (map: Map<number, Family[]>, key: number, family: Family) => map.set(key, [...(map.get(key) ?? []), family]);
  for (const family of tree.families) {
    for (const partner of family.partners) if (partner !== null) push(index.familiesAsPartner, partner, family);
    for (const child of family.children) push(index.familyAsChild, child.id, family);
  }
  return index;
}

export const otherPartner = (family: Family, personId: number) =>
  family.partners[0] === personId ? family.partners[1] : family.partners[0];

// --- Форматирование ---

export const fullName = (p: Person) => [p.surname, p.givenName, p.patronymic].filter(Boolean).join(' ') || 'Без имени';

export const shortName = (p: Person) => [p.givenName, p.patronymic].filter(Boolean).join(' ') || 'Без имени';

/** «Орлов М. С.» — когда полное имя не помещается: в шапке на телефоне, в подписях поколений. */
export const initialsName = (p: Person) =>
  [
    p.surname,
    [p.givenName, p.patronymic]
      .filter(Boolean)
      .map((w) => `${w[0]}.`)
      .join(' '),
  ]
    .filter(Boolean)
    .join(' ') || displayName(p);

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOMINATIVE = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function formatPartialDate(value: string): string {
  const [y, m, d] = value.split('-');
  const year = String(Number(y));
  if (d) return `${Number(d)} ${MONTHS_GENITIVE[Number(m) - 1]} ${year}`;
  if (m) return `${MONTHS_NOMINATIVE[Number(m) - 1]} ${year}`;
  return year;
}

/**
 * Отметка старого стиля после даты: «12 марта 1885 ст. ст.»; «ст. ст.» не разрываем переносом.
 * У даты без дня отметка ничего не меняет — её не пишем.
 */
export const oldStyle = (event: Pick<TreeEvent, 'date'>) =>
  event.date?.calendar === 'julian' && event.date.value.length === 10 ? ' ст.\u00a0ст.' : '';

export function formatDate(event: TreeEvent): string {
  const { date } = event;
  if (!date) return event.dateText;
  return formatDateValue(date) + oldStyle(event);
}

function formatDateValue(date: NonNullable<TreeEvent['date']>): string {
  const value = formatPartialDate(date.value);
  switch (date.modifier) {
    case 'about':
    case 'estimated':
      return `около ${value}`;
    case 'calculated':
      return `${value} (расчётно)`;
    case 'before':
      return `до ${value}`;
    case 'after':
      return `после ${value}`;
    case 'between':
      return `между ${value} и ${formatPartialDate(date.valueTo!)}`;
    default:
      return value;
  }
}

const yearOf = (event: TreeEvent | undefined) => {
  if (!event?.date) return undefined;
  const year = String(Number(event.date.value.slice(0, 4)));
  return event.date.modifier === 'exact' ? year : `~${year}`;
};

export const findEvent = (events: TreeEvent[], type: string) => events.find((e) => e.type === type);

/** «1900 – 1965», «1999», «? – 1958», «† » — то, что помещается на карточку. */
export function lifeYears(p: Person): string {
  const birth = yearOf(findEvent(p.events, 'birth'));
  const death = yearOf(findEvent(p.events, 'death'));
  if (!p.isDeceased) return birth ?? '';
  if (!birth && !death) return '†';
  return `${birth ?? '?'} – ${death ?? '?'}`;
}

const EVENT_LABELS: Record<string, string> = {
  birth: 'Рождение',
  death: 'Смерть',
  burial: 'Похороны',
  baptism: 'Крещение',
  occupation: 'Профессия',
  education: 'Образование',
  graduation: 'Выпуск',
  residence: 'Место жительства',
  emigration: 'Эмиграция',
  immigration: 'Иммиграция',
  retirement: 'Выход на пенсию',
  marriage: 'Брак',
  divorce: 'Развод',
  engagement: 'Помолвка',
};

export const eventLabel = (e: TreeEvent) => (e.type === 'custom' ? e.customType || 'Событие' : (EVENT_LABELS[e.type] ?? e.type));

/** «Военная награда — медаль «За отвагу»»: тип и что именно, если указано. */
export const eventTitle = (e: TreeEvent) => (e.details ? `${eventLabel(e)} — ${e.details}` : eventLabel(e));

const AWARDS = new Set(['Военная награда', 'Награда']);

/** Награды человека — события «Военная награда» и «Награда», по порядку дат. */
export const awardsOf = (p: Person) => p.events.filter((e) => e.type === 'custom' && AWARDS.has(e.customType));

/** «Орден Красной Звезды (1945)»; пока название не указано — тип события. */
export function awardTitle(e: TreeEvent): string {
  const name = e.details || eventLabel(e);
  if (!e.date) return name;
  const year = e.date.value.slice(0, 4);
  return `${name} (${e.date.modifier === 'exact' ? year : `~${year}`})`;
}

// --- В стиле familio ---

/** «Орлова (Иванова) Елена Владимировна». */
export const displayName = (p: Person) =>
  // Фамилия при рождении — в скобках, только если отличается от нынешней.
  [p.birthSurname && p.birthSurname !== p.surname ? `${p.surname} (${p.birthSurname})` : p.surname, p.givenName, p.patronymic]
    .filter(Boolean)
    .join(' ') ||
  'Без имени';

const PLACE_TYPE =
  /^(город федерального значения|рабочий посёлок|рабочий поселок|посёлок городского типа|поселок городского типа|город|деревня|село|посёлок|поселок|пгт|станица|хутор|слобода)\s+/i;

const placeParts = (name: string) =>
  name
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();

const shortPart = (part: string) => part.replace(PLACE_TYPE, '');

/** «Тверская область, город Тверь, город Тверь» → «Тверь». */
export const placeShort = (name: string) => shortPart(placeParts(name)[0] ?? '');

/** «Тверь, Тверская область»: от мелкого к крупному, без повторов. */
export function placeFull(name: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  placeParts(name).forEach((part, i) => {
    const short = shortPart(part);
    if (seen.has(short.toLowerCase())) return;
    seen.add(short.toLowerCase());
    parts.push(i === 0 ? short : part);
  });
  return parts.join(', ');
}

/** 14.05.1976, 05.1976, 1976, ~1976. */
export function shortDate(event: TreeEvent | undefined): string | undefined {
  const date = event?.date;
  if (!date) return undefined;
  const [y, m, d] = date.value.split('-');
  const text = [d, m, String(Number(y))].filter(Boolean).join('.');
  return date.modifier === 'exact' ? text : `~${text}`;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

export const yearsText = (n: number) => `${n} ${plural(n, 'год', 'года', 'лет')}`;

/** Полных лет между датами; только когда обе даты точные (до дня). */
function fullYears(from: TreeEvent | undefined, to: string | undefined): number | undefined {
  const start = from?.date?.modifier === 'exact' ? from.date.value : undefined;
  if (!start || !to || start.length !== 10 || to.length !== 10) return undefined;
  const [fy, fm, fd] = start.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
}

const exactDate = (e: TreeEvent | undefined) => (e?.date?.modifier === 'exact' ? e.date.value : undefined);
const withAge = (text: string, age: number | undefined) => (age === undefined ? text : `${text}, ${yearsText(age)}`);

/** Строка дат на карточке: «род. 14.05.1976, 50 лет», «05.10.1930—11.02.1971, 40 лет», «19.11.1926—ум. ?». */
export function cardDates(p: Person, today = new Date().toISOString().slice(0, 10)): string {
  const birth = findEvent(p.events, 'birth');
  const death = findEvent(p.events, 'death');
  const born = shortDate(birth);
  const died = shortDate(death);

  if (!p.isDeceased) return born ? withAge(`род. ${born}`, fullYears(birth, today)) : '';
  if (!born && !died) return '';
  if (!born) return `ум. ${died}`;
  if (!died) return `${born}—ум. ?`;
  return withAge(`${born}—${died}`, fullYears(birth, exactDate(death)));
}
