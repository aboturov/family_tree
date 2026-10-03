import type { DocumentView } from '../api.ts';
import { formatDate, type TreeEvent } from '../tree/model.ts';
import { DOCUMENT_TYPES } from './labels.ts';

/** Шифр как пишут в ссылках на архив: «ф. Р-100, оп. 2а, д. 15А, л. 12об.–13». */
export function shelfmark(d: Pick<DocumentView, 'fond' | 'opis' | 'delo' | 'sheets'>): string {
  return [
    d.fond && `ф. ${d.fond}`,
    d.opis && `оп. ${d.opis}`,
    d.delo && `д. ${d.delo}`,
    d.sheets && `л. ${d.sheets}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Где оригинал: архив и шифр одной строкой. */
export const whereKept = (d: DocumentView) => [d.archive, shelfmark(d)].filter(Boolean).join(', ');

/** Дата составления — так же, как даты событий («12 марта 1885 ст. ст.»). */
export const documentDate = (d: DocumentView) => (d.date ? formatDate({ date: d.date, dateText: '' } as TreeEvent) : '');

/** Порядок в списках: по дате документа, без даты — в конце. */
export const byDate = (a: DocumentView, b: DocumentView) =>
  (a.date?.value ?? '9999').localeCompare(b.date?.value ?? '9999') || a.id - b.id;

/** Текст для поиска: название, тип, архив и шифр, расшифровка и заметки — без учёта «ё». */
export const searchText = (d: DocumentView, names: string[]) =>
  [d.title, DOCUMENT_TYPES[d.type], d.archive, shelfmark(d), d.transcription, d.note, ...names]
    .join(' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
