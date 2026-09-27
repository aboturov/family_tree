// Отчество по имени отца и перевод отчества в другой род: Василий → Васильевич / Васильевна.
// Правила русских отчеств плюс исключения, которые по правилам не выводятся.

type Pair = [string, string];

const EXCEPTIONS: Record<string, Pair> = {
  павел: ['Павлович', 'Павловна'],
  лев: ['Львович', 'Львовна'],
  пётр: ['Петрович', 'Петровна'],
  петр: ['Петрович', 'Петровна'],
  яков: ['Яковлевич', 'Яковлевна'],
  илья: ['Ильич', 'Ильинична'],
  кузьма: ['Кузьмич', 'Кузьминична'],
  фома: ['Фомич', 'Фоминична'],
  лука: ['Лукич', 'Лукинична'],
  никита: ['Никитич', 'Никитична'],
  савва: ['Саввич', 'Саввична'],
  гаврила: ['Гаврилович', 'Гавриловна'],
  данила: ['Данилович', 'Даниловна'],
  михаил: ['Михайлович', 'Михайловна'],
};

const VOWELS = 'аеёиоуыэюя';

function fromFather(name: string): Pair | null {
  const n = name.trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  if (EXCEPTIONS[lower]) return EXCEPTIONS[lower];
  const stem = (cut: number) => n.slice(0, n.length - cut);
  if (lower.endsWith('ий')) {
    // Две согласные перед -ий (Дмитрий, Георгий) — «-иевич», иначе «-ьевич» (Василий, Юрий).
    const before = lower.slice(-4, -2);
    const cluster = before.length === 2 && !VOWELS.includes(before[0]) && !VOWELS.includes(before[1]);
    return cluster ? [`${stem(2)}иевич`, `${stem(2)}иевна`] : [`${stem(2)}ьевич`, `${stem(2)}ьевна`];
  }
  if (lower.endsWith('ей') || lower.endsWith('ай') || lower.endsWith('ой')) {
    return [`${stem(1)}евич`, `${stem(1)}евна`];
  }
  if (lower.endsWith('ь')) return [`${stem(1)}евич`, `${stem(1)}евна`];
  if (lower.endsWith('а') || lower.endsWith('я')) return [`${stem(1)}ич`, `${stem(1)}ична`];
  if (/[жшчщц]$/.test(lower)) return [`${n}евич`, `${n}евна`];
  if (VOWELS.includes(lower.at(-1)!)) return null;
  return [`${n}ович`, `${n}овна`];
}

/** Отчество ребёнка по имени отца; при неизвестном поле — мужская форма. */
export function patronymicFrom(fatherName: string, sex: 'M' | 'F' | 'U'): string {
  const pair = fromFather(fatherName);
  return pair ? pair[sex === 'F' ? 1 : 0] : '';
}

/** То же отчество в нужном роде — для брата или сестры: Васильевич → Васильевна. */
export function patronymicFor(patronymic: string, sex: 'M' | 'F' | 'U'): string {
  const p = patronymic.trim();
  const female = sex === 'F';
  for (const [m, f] of Object.values(EXCEPTIONS)) {
    if (p === m || p === f) return female ? f : m;
  }
  if (p.endsWith('вич') && female) return `${p.slice(0, -3)}вна`;
  if (p.endsWith('вна') && !female) return `${p.slice(0, -3)}вич`;
  if (p.endsWith('ична') && !female) return `${p.slice(0, -4)}ич`;
  if (p.endsWith('ич') && female) return `${p.slice(0, -2)}ична`;
  return p;
}
