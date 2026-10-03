import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detailsLabel, eventTypeGroups, OTHER } from '../src/editing/eventTypes.ts';

describe('типы нового события', () => {
  it('основные — в порядке жизни, остальные по алфавиту', () => {
    const groups = eventTypeGroups(new Set());
    assert.deepEqual(
      groups[0].options.map((o) => o.label),
      ['Рождение', 'Крещение', 'Образование', 'Работа или профессия', 'Место жительства', 'Бракосочетание', 'Развод', 'Выход на пенсию', 'Смерть', 'Похороны'],
    );
    const other = groups.find((g) => g.label === 'Другие')!.options.map((o) => o.label);
    assert.deepEqual(other, [...other].sort((a, b) => a.localeCompare(b, 'ru')));
  });

  it('уже указанные рождение и смерть не предлагаются, повторяемые — остаются', () => {
    const labels = eventTypeGroups(new Set(['birth', 'death', 'occupation'])).flatMap((g) => g.options.map((o) => o.label));
    assert.ok(!labels.includes('Рождение'));
    assert.ok(!labels.includes('Смерть'));
    assert.ok(labels.includes('Похороны'));
    assert.ok(labels.includes('Работа или профессия'));
  });
});

describe('поле «что именно»', () => {
  it('есть у наград, званий, профессии и своего события; у рождения и брака — нет', () => {
    assert.equal(detailsLabel('custom:Военная награда'), 'Название награды');
    assert.equal(detailsLabel('custom:Получение воинского звания/чина'), 'Звание или чин');
    assert.equal(detailsLabel('occupation'), 'Профессия, должность');
    assert.equal(detailsLabel(OTHER), 'Подробности');
    assert.equal(detailsLabel('birth'), null);
    assert.equal(detailsLabel('marriage'), null);
  });
});
