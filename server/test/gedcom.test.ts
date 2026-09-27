import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCoordinate, parseGedcom, parseGedcomDate, parseRussianName } from '../src/gedcom.ts';

describe('parseGedcom', () => {
  it('строит дерево записей и склеивает CONC/CONT', () => {
    const [head, person] = parseGedcom(
      '﻿0 HEAD\r\n1 CHAR UTF-8\r\n0 @I1@ INDI\r\n1 NOTE Первая строка\r\n2 CONT вторая\r\n2 CONC  строка\r\n1 SEX F\r\n',
    );
    assert.equal(head.tag, 'HEAD');
    assert.equal(person.xref, '@I1@');
    assert.equal(person.children[0].value, 'Первая строка\nвторая строка');
    assert.equal(person.children[1].tag, 'SEX');
  });

  it('падает на битой строке с номером', () => {
    assert.throws(() => parseGedcom('0 HEAD\nмусор'), /строку 2/);
  });
});

describe('parseGedcomDate', () => {
  const cases: [string, ReturnType<typeof parseGedcomDate>][] = [
    ['9 MAY 1999', { modifier: 'exact', value: '1999-05-09' }],
    ['APR 1991', { modifier: 'exact', value: '1991-04' }],
    ['1925', { modifier: 'exact', value: '1925' }],
    ['ABT 1900', { modifier: 'about', value: '1900' }],
    ['BEF 12 MAR 1941', { modifier: 'before', value: '1941-03-12' }],
    ['BET 1920 AND 1925', { modifier: 'between', value: '1920', valueTo: '1925' }],
    ['FROM 1941 TO 1945', { modifier: 'between', value: '1941', valueTo: '1945' }],
    ['весной 1941', undefined],
    ['32 JAN 1990', undefined],
    ['', undefined],
  ];
  for (const [input, expected] of cases) {
    it(`«${input}»`, () => assert.deepEqual(parseGedcomDate(input), expected));
  }
});

describe('parseRussianName', () => {
  it('отделяет отчество и девичью фамилию', () => {
    assert.deepEqual(parseRussianName('Анна Петровна /Соколова (Белова)/'), {
      givenName: 'Анна',
      patronymic: 'Петровна',
      surname: 'Соколова',
      birthSurname: 'Белова',
      uncertain: false,
    });
  });

  it('понимает мужские отчества на -ич и -вич', () => {
    assert.equal(parseRussianName('Иван Гаврилович /Соколов/').patronymic, 'Гаврилович');
    assert.equal(parseRussianName('Павел Кузьмич /Лебедев/').patronymic, 'Кузьмич');
  });

  it('«?» в имени — флаг сомнения, а не часть имени', () => {
    const name = parseRussianName('Зоя Кузьминична ? /Зайцева (Лебедева-Морозова)/');
    assert.equal(name.givenName, 'Зоя');
    assert.equal(name.patronymic, 'Кузьминична');
    assert.equal(name.uncertain, true);
  });

  it('одинаковая девичья и текущая фамилия не дублируется', () => {
    assert.equal(parseRussianName('Анна Владимировна /Иванова (Иванова)/').birthSurname, '');
  });

  it('человек без фамилии и отчества', () => {
    assert.deepEqual(parseRussianName('Елена //'), {
      givenName: 'Елена',
      patronymic: '',
      surname: '',
      birthSurname: '',
      uncertain: false,
    });
  });

  it('одно слово не считается отчеством', () => {
    assert.equal(parseRussianName('Кузьмич /Иванов/').givenName, 'Кузьмич');
  });
});

describe('parseCoordinate', () => {
  it('разбирает стороны света', () => {
    assert.equal(parseCoordinate('N57.6263877'), 57.6263877);
    assert.equal(parseCoordinate('W12.5'), -12.5);
    assert.equal(parseCoordinate('мусор'), undefined);
  });
});
