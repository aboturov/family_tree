// Русские фамилии меняются по роду: Орлов — Орлова, Вишневский — Вишневская.
// Остальные (Шульц, Черных, Ким) не меняются.

const FEMININE: [RegExp, string][] = [
  [/(ов|ев|ёв|ин|ын)$/i, '$1а'],
  [/(ск|цк)ий$/i, '$1ая'],
];
const MASCULINE: [RegExp, string][] = [
  [/(ов|ев|ёв|ин|ын)а$/i, '$1'],
  [/(ск|цк)ая$/i, '$1ий'],
];

// Семья целиком: Орловы, Ильины, Вишневские, Толстые. Черных, Кравченко, Шульц — как есть.
const PLURAL: [RegExp, string][] = [
  [/(ов|ев|ёв|ин|ын)$/i, '$1ы'],
  [/([гкхжшчщ])(ий|ой|ая)$/i, '$1ие'],
  [/ий$/i, 'ие'],
  [/(ый|ой|ая)$/i, 'ые'],
];

const apply = (surname: string, rules: [RegExp, string][]) => {
  for (const [pattern, replacement] of rules) if (pattern.test(surname)) return surname.replace(pattern, replacement);
  return surname;
};

/** Фамилия в форме для пола; при неизвестном поле — мужская, как в словарях. */
export function surnameFor(surname: string, sex: 'M' | 'F' | 'U'): string {
  const masculine = apply(surname.trim(), MASCULINE);
  return sex === 'F' ? apply(masculine, FEMININE) : masculine;
}

/** Фамилия всей семьи — для подписи рода: Орлов и Орлова — Орловы. */
export function familyName(surname: string): string {
  return apply(surnameFor(surname, 'M'), PLURAL);
}
