import { useEffect, useState } from 'react';
import { api } from '../api.ts';

// Частичная дата (год, месяц, день — сколько известно) и подсказки мест: общие для окна
// события и формы нового родственника.

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];
export { dateProblem, emptyDate, joinDate, parseYearless, splitDate, yearlessText, type PartialDate } from './partialDate.ts';
import type { PartialDate } from './partialDate.ts';

/** Точность даты в формах: события и документа. */
export const WHEN = [
  ['exact', 'Дата'],
  ['about', 'Около'],
  ['before', 'До'],
  ['after', 'После'],
  ['between', 'Между'],
] as const;

/** Старый стиль в России — до февраля 1918-го: отметку предлагаем только для таких дат. */
export const isOldStyleEra = (year: string) => year.length === 4 && Number(year) <= 1918;

export function DateFields({ value, onChange }: { value: PartialDate; onChange: (d: PartialDate) => void }) {
  return (
    <>
      <input
        className="date-day"
        inputMode="numeric"
        placeholder="день"
        aria-label="День"
        value={value.day}
        onChange={(e) => onChange({ ...value, day: e.target.value.replace(/\D/g, '').slice(0, 2) })}
      />
      <select
        aria-label="Месяц"
        value={value.month}
        onChange={(e) => onChange({ ...value, month: e.target.value })}
      >
        <option value="">месяц</option>
        {MONTHS.map((m, i) => (
          <option key={m} value={String(i + 1)}>
            {m}
          </option>
        ))}
      </select>
      <input
        className="date-year"
        inputMode="numeric"
        placeholder="год"
        aria-label="Год"
        value={value.year}
        onChange={(e) => onChange({ ...value, year: e.target.value.replace(/\D/g, '').slice(0, 4) })}
      />
    </>
  );
}

/** Подсказки мест с сервера, с небольшой задержкой после ввода. */
export function usePlaceSuggestions(query: string): string[] {
  const [places, setPlaces] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .places(query)
        .then(({ places }) => !cancelled && setPlaces(places.map((p) => p.name)))
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  return places;
}
