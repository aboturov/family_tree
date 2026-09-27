import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { familyName, surnameFor } from '../src/surname.ts';

describe('фамилия по полу', () => {
  it('склоняется по роду и в обе стороны', () => {
    assert.equal(surnameFor('Орлов', 'F'), 'Орлова');
    assert.equal(surnameFor('Орлова', 'M'), 'Орлов');
    assert.equal(surnameFor('Орлова', 'F'), 'Орлова');
    assert.equal(surnameFor('Соколов', 'F'), 'Соколова');
    assert.equal(surnameFor('Лебедева-Морозова', 'M'), 'Лебедева-Морозов');
    assert.equal(surnameFor('Троицкий', 'F'), 'Троицкая');
    assert.equal(surnameFor('Черных', 'F'), 'Черных');
    assert.equal(surnameFor('Иванова', 'U'), 'Иванов');
  });
});

describe('фамилия семьи', () => {
  it('во множественном числе, из мужской и женской формы', () => {
    assert.equal(familyName('Орлов'), 'Орловы');
    assert.equal(familyName('Орлова'), 'Орловы');
    assert.equal(familyName('Ильина'), 'Ильины');
    assert.equal(familyName('Троицкая'), 'Троицкие');
    assert.equal(familyName('Донской'), 'Донские');
    assert.equal(familyName('Толстой'), 'Толстые');
    assert.equal(familyName('Белая'), 'Белые');
    assert.equal(familyName('Горький'), 'Горькие');
  });

  it('несклоняемые — как есть', () => {
    assert.equal(familyName('Кравченко'), 'Кравченко');
    assert.equal(familyName('Черных'), 'Черных');
    assert.equal(familyName('Шульц'), 'Шульц');
  });
});
