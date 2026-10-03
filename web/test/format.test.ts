import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { avatarImageBox, clampCrop } from '../src/avatarGeometry.ts';
import {
  awardsOf,
  awardTitle,
  cardDates,
  displayName,
  eventTitle,
  formatDate,
  placeFull,
  placeShort,
  type Person,
  type TreeEvent,
} from '../src/tree/model.ts';

const event = (type: string, value?: string, modifier: 'exact' | 'about' = 'exact'): TreeEvent => ({
  id: 0,
  type,
  customType: '',
  details: '',
  date: value ? { modifier, value } : null,
  dateText: '',
  place: null,
  note: '',
});
const person = (events: TreeEvent[], isDeceased = false): Person => ({
  id: 1,
  version: 1,
  avatar: null,
  photos: [],
  documents: [],
  givenName: '',
  patronymic: '',
  surname: '',
  birthSurname: '',
  sex: 'M',
  isDeceased,
  isUncertain: false,
  bio: '',
  events,
});

describe('cardDates', () => {
  const today = '2026-09-24';
  it('живой: дата рождения и возраст', () => {
    assert.equal(cardDates(person([event('birth', '1976-05-14')]), today), 'род. 14.05.1976, 50 лет');
    assert.equal(cardDates(person([event('birth', '1975-03-02')]), today), 'род. 02.03.1975, 51 год');
    assert.equal(cardDates(person([event('birth', '1925')]), today), 'род. 1925');
    assert.equal(cardDates(person([]), today), '');
  });
  it('умерший', () => {
    assert.equal(
      cardDates(person([event('birth', '1930-10-05'), event('death', '1971-02-11')], true), today),
      '05.10.1930—11.02.1971, 40 лет',
    );
    assert.equal(cardDates(person([event('birth', '1926-11-19')], true), today), '19.11.1926—ум. ?');
    assert.equal(cardDates(person([event('death', '1958')], true), today), 'ум. 1958');
    assert.equal(
      cardDates(person([event('birth', '1900', 'about'), event('death', '1965')], true), today),
      '~1900—1965',
    );
    assert.equal(cardDates(person([], true), today), '');
  });
});

describe('formatDate', () => {
  it('старый стиль — отметкой после даты', () => {
    const birth = event('birth', '1885-03-12');
    assert.equal(formatDate(birth), '12 марта 1885');
    assert.equal(formatDate({ ...birth, date: { ...birth.date!, calendar: 'julian' } }), '12 марта 1885 ст.\u00a0ст.');
    const about = event('birth', '1885-03', 'about');
    assert.equal(formatDate({ ...about, date: { ...about.date!, calendar: 'julian' } }), 'около март 1885', 'без дня — без отметки');
  });
});

describe('места', () => {
  it('короткое название — самый мелкий пункт без типа', () => {
    assert.equal(placeShort('Тверская область, город Тверь, город Тверь'), 'Тверь');
    assert.equal(placeShort('Тверская область, Старицкий район, деревня Примерово'), 'Примерово');
  });
  it('полное — от мелкого к крупному без повторов', () => {
    assert.equal(placeFull('Тверская область, город Тверь, город Тверь'), 'Тверь, Тверская область');
    assert.equal(placeFull('город федерального значения Санкт-Петербург, город Санкт-Петербург'), 'Санкт-Петербург');
  });
});

describe('кадрирование аватарки', () => {
  const photo = { width: 1600, height: 1200 };
  const round = (box: Record<string, number>) =>
    Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v * 100) / 100]));

  it('круг на всю меньшую сторону, по центру', () => {
    // Масштаб 100 / 1200: кадр 133.33 × 100, по горизонтали сдвинут на половину лишней ширины.
    assert.deepEqual(round(avatarImageBox({ x: 0.5, y: 0.5, zoom: 1 }, photo, 100)), {
      x: -16.67,
      y: 0,
      width: 133.33,
      height: 100,
    });
  });

  it('приближение вдвое на левый верхний угол', () => {
    // Диаметр круга — 600 px кадра, масштаб 100 / 600; центр круга — в точке (300, 300).
    assert.deepEqual(round(avatarImageBox({ x: 300 / 1600, y: 300 / 1200, zoom: 0.5 }, photo, 100)), {
      x: 0,
      y: 0,
      width: 266.67,
      height: 200,
    });
  });

  it('круг не выходит за края кадра', () => {
    // Радиус круга — 300 px: центр не ближе 300 px к краю.
    assert.deepEqual(clampCrop({ x: 0, y: 1, zoom: 0.5 }, photo), { x: 0.1875, y: 0.75, zoom: 0.5 });
  });
});

describe('displayName', () => {
  const named = (surname: string, birthSurname: string) => ({ ...person([]), surname, birthSurname, givenName: 'Анна' });
  it('фамилия при рождении — в скобках, только если отличается', () => {
    assert.equal(displayName(named('Павлова', 'Иванова')), 'Павлова (Иванова) Анна');
    assert.equal(displayName(named('Орлова', 'Орлова')), 'Орлова Анна');
    assert.equal(displayName(named('Орлова', '')), 'Орлова Анна');
  });
});

describe('награды', () => {
  const award = (customType: string, details: string, value?: string, modifier: 'exact' | 'about' = 'exact'): TreeEvent => ({
    ...event('custom', value, modifier),
    customType,
    details,
  });

  it('военные и прочие награды — по порядку ленты; служба и звание — не награды', () => {
    const star = award('Военная награда', 'Орден Красной Звезды', '1944-03');
    const labour = award('Награда', 'Орден Трудового Красного Знамени', '1949');
    const service = award('Военная служба', 'Восстановительный батальон', '1941');
    assert.deepEqual(awardsOf(person([event('birth', '1905'), service, star, labour])), [star, labour]);
  });

  it('название с годом; без названия — тип; дата «около» — с тильдой', () => {
    assert.equal(awardTitle(award('Военная награда', 'Медаль «За отвагу»', '1943-07-12')), 'Медаль «За отвагу» (1943)');
    assert.equal(awardTitle(award('Военная награда', '', '1943', 'about')), 'Военная награда (~1943)');
    assert.equal(awardTitle(award('Награда', 'Почётная грамота')), 'Почётная грамота');
  });

  it('заголовок события: тип и что именно', () => {
    assert.equal(eventTitle(award('Военная награда', 'Медаль «За отвагу»')), 'Военная награда — Медаль «За отвагу»');
    assert.equal(eventTitle(event('birth', '1905')), 'Рождение');
  });
});
