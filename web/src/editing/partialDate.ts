// Частичная дата из полей формы: год, месяц и день — сколько известно. Без года дата
// («12 марта», «март») не ложится в ГГГГ-ММ-ДД и уходит на сервер текстом.

export type PartialDate = { day: string; month: string; year: string };
export const emptyDate: PartialDate = { day: '', month: '', year: '' };

export const splitDate = (value: string | undefined): PartialDate => {
  if (!value) return emptyDate;
  const [year, month = '', day = ''] = value.split('-');
  return { year: String(Number(year)), month: month ? String(Number(month)) : '', day: day ? String(Number(day)) : '' };
};

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOMINATIVE = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Дата без года текстом («12 марта», «март») или null, если год указан или месяца нет. */
export function yearlessText(d: PartialDate): string | null {
  if (d.year || !d.month) return null;
  const month = Number(d.month) - 1;
  return d.day ? `${Number(d.day)} ${MONTHS_GENITIVE[month]}` : MONTHS_NOMINATIVE[month];
}

/** Обратно в поля формы — чтобы при правке дата без года не затёрлась. */
export function parseYearless(text: string): PartialDate | null {
  const nominative = MONTHS_NOMINATIVE.indexOf(text);
  if (nominative >= 0) return { day: '', month: String(nominative + 1), year: '' };
  const match = /^(\d{1,2}) (\S+)$/.exec(text);
  const month = match ? MONTHS_GENITIVE.indexOf(match[2]) : -1;
  return match && month >= 0 ? { day: String(Number(match[1])), month: String(month + 1), year: '' } : null;
}

/**
 * Чего не хватает в дате, или null. Поля можно заполнять в любом порядке, поэтому
 * проверяем при сохранении: день без месяца иначе молча потерялся бы.
 */
export function dateProblem(d: PartialDate, what = 'Дата'): string | null {
  if (!d.day && !d.month && !d.year) return null;
  if (d.day && !d.month) return `${what}: укажите месяц — без него день не сохранить`;
  if (!d.year && !d.month) return `${what}: укажите год или месяц`;
  if (d.day) {
    const day = Number(d.day);
    // Без года считаем по високосному: 29 февраля допустимо.
    const daysInMonth = new Date(Number(d.year || 2000), Number(d.month), 0).getDate();
    if (day < 1 || day > daysInMonth) return `${what}: в этом месяце нет ${day}-го числа`;
  }
  return null;
}

export function joinDate(d: PartialDate): string | null {
  if (!d.year) return null;
  const year = d.year.padStart(4, '0');
  if (!d.month) return year;
  const month = d.month.padStart(2, '0');
  if (!d.day) return `${year}-${month}`;
  return `${year}-${month}-${d.day.padStart(2, '0')}`;
}
