import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dateProblem, joinDate, parseYearless, yearlessText } from '../src/editing/partialDate.ts';

const d = (day: string, month: string, year: string) => ({ day, month, year });

describe('частичная дата', () => {
  it('поля можно заполнять в любом порядке, но без месяца день не сохранить', () => {
    assert.equal(dateProblem(d('', '', '')), null);
    assert.equal(dateProblem(d('', '', '1955')), null);
    assert.equal(dateProblem(d('', '8', '1955')), null);
    assert.equal(dateProblem(d('28', '8', '1955')), null);
    assert.match(dateProblem(d('28', '', '1955'))!, /месяц/);
    assert.match(dateProblem(d('28', '', ''))!, /месяц/);
    assert.match(dateProblem(d('30', '2', '1955'))!, /нет 30-го/);
    assert.equal(dateProblem(d('29', '2', '1956')), null);
  });

  it('без года — день и месяц, текстом туда и обратно', () => {
    assert.equal(dateProblem(d('28', '8', '')), null);
    assert.equal(dateProblem(d('', '8', '')), null);
    assert.equal(dateProblem(d('29', '2', '')), null);
    assert.match(dateProblem(d('30', '2', ''))!, /нет 30-го/);
    assert.equal(joinDate(d('28', '8', '')), null);
    assert.equal(yearlessText(d('28', '8', '')), '28 августа');
    assert.equal(yearlessText(d('', '8', '')), 'август');
    assert.equal(yearlessText(d('28', '8', '1955')), null);
    assert.deepEqual(parseYearless('28 августа'), d('28', '8', ''));
    assert.deepEqual(parseYearless('август'), d('', '8', ''));
    assert.equal(parseYearless('ABT 1900'), null);
  });

  it('собирается в частичный ISO', () => {
    assert.equal(joinDate(d('', '', '1955')), '1955');
    assert.equal(joinDate(d('', '8', '1955')), '1955-08');
    assert.equal(joinDate(d('7', '8', '1955')), '1955-08-07');
  });
});
