import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitLinks } from '../src/links.ts';

describe('splitLinks', () => {
  it('текст без ссылок — один кусок', () => {
    assert.deepEqual(splitLinks('Кузнец в деревне Примерово'), [{ text: 'Кузнец в деревне Примерово' }]);
  });

  it('ссылка подписана сайтом, точка в конце фразы — не её часть', () => {
    assert.deepEqual(splitLinks('Источник — https://www.archive.example.com/unit/160-1-1904/. Сверено.'), [
      { text: 'Источник — ' },
      { url: 'https://www.archive.example.com/unit/160-1-1904/', label: 'archive.example.com' },
      { text: '. Сверено.' },
    ]);
  });

  it('скобка вокруг ссылки остаётся снаружи, своя скобка в адресе — внутри', () => {
    assert.deepEqual(splitLinks('(см. https://example.com/a)'), [
      { text: '(см. ' },
      { url: 'https://example.com/a', label: 'example.com' },
      { text: ')' },
    ]);
    assert.deepEqual(splitLinks('https://example.com/wiki/Орлов_(фамилия)'), [
      { url: 'https://example.com/wiki/Орлов_(фамилия)', label: 'example.com' },
    ]);
  });

  it('несколько ссылок и кавычки-ёлочки вокруг', () => {
    assert.deepEqual(splitLinks('«https://a.example.com/1» и http://b.example.com'), [
      { text: '«' },
      { url: 'https://a.example.com/1', label: 'a.example.com' },
      { text: '» и ' },
      { url: 'http://b.example.com', label: 'b.example.com' },
    ]);
  });
});
