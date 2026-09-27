import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sortTimeline } from '../src/timelineOrder.ts';
import type { TreeEvent } from '../src/tree/model.ts';

const ev = (type: string, value?: string): TreeEvent => ({
  id: 0,
  type,
  customType: '',
  date: value ? { modifier: 'exact', value } : null,
  dateText: '',
  place: null,
  note: '',
});

describe('порядок ленты', () => {
  it('развод без даты — после событий своего брака, а не в конце', () => {
    // Первый брак 1970, дочь 1972, развод без даты; потом дочь 1980 и второй брак 1980.
    const items = [
      { name: 'рождение', event: ev('birth', '1950-04-10') },
      { name: 'брак 1', event: ev('marriage', '1970-06-13'), familyId: 2 },
      { name: 'развод 1', event: ev('divorce'), familyId: 2 },
      { name: 'дочь 1', event: ev('birth', '1972-05-02'), familyId: 2 },
      { name: 'брак 2', event: ev('marriage', '1980-09-06'), familyId: 3 },
      { name: 'дочь 2', event: ev('birth', '1980-02-15'), familyId: 3 },
    ];
    assert.deepEqual(
      sortTimeline(items).map((i) => i.name),
      ['рождение', 'брак 1', 'дочь 1', 'развод 1', 'дочь 2', 'брак 2'],
    );
  });

  it('свадьба без даты — перед первым событием брака; без опоры рождение первым, прочее в конце', () => {
    const items = [
      { name: 'занятие', event: ev('occupation') },
      { name: 'сын', event: ev('birth', '2000-01-01'), familyId: 1 },
      { name: 'брак', event: ev('marriage'), familyId: 1 },
      { name: 'рождение', event: ev('birth') },
    ];
    assert.deepEqual(sortTimeline(items).map((i) => i.name), ['рождение', 'брак', 'сын', 'занятие']);
  });
});
