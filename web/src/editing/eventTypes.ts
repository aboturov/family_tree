// Типы событий для формы. Список — как в familio; те, у которых
// есть тег GEDCOM, хранятся своим типом, остальные — как произвольное событие с названием.

export type EventTypeOption = { value: string; label: string; type: string; customType: string };

const known = (type: string, label: string): EventTypeOption => ({ value: type, label, type, customType: '' });
const custom = (label: string): EventTypeOption => ({
  value: `custom:${label}`,
  label,
  type: 'custom',
  customType: label,
});

export const PERSON_EVENT_OPTIONS: EventTypeOption[] = [
  known('birth', 'Рождение'),
  known('death', 'Смерть'),
  known('burial', 'Похороны'),
  known('baptism', 'Крещение'),
  known('education', 'Образование'),
  known('occupation', 'Работа или профессия'),
  known('residence', 'Место жительства'),
  known('emigration', 'Эмиграция'),
  known('immigration', 'Иммиграция'),
  known('retirement', 'Выход на пенсию'),
  ...[
    'Арест',
    'Бар-мицва',
    'Бат-мицва',
    'Благословение',
    'Военная награда',
    'Военная служба',
    'Восприемник',
    'Вступление в колхоз',
    'Вступление в партию',
    'Гражданство',
    'Дворянский титул',
    'Демобилизация',
    'Захоронение (военное)',
    'Имянаречение',
    'Конфирмация (миропомазание)',
    'Концлагерь',
    'Лечение в госпитале',
    'Награда',
    'Обрезание',
    'Осуждение',
    'Отбывание наказания',
    'Паломничество',
    'Перезахоронение',
    'Подвиг',
    'Получение воинского звания/чина',
    'Получение учёной степени',
    'Попал в плен (военное)',
    'Поручитель',
    'Посвящение в духовный сан',
    'Призыв на военную службу',
    'Пропал без вести (военное)',
    'Путешествие',
    'Ранение',
    'Раскулачивание',
    'Реабилитация осужденного',
    'Смена имени',
    'Смена фамилии',
    'Совершение преступления',
    'Упоминание',
    'Участие в бою',
    'Хадж',
    'Эвакуация',
    'Эксгумация',
  ].map(custom),
];

export const FAMILY_EVENT_OPTIONS: EventTypeOption[] = [
  known('marriage', 'Бракосочетание'),
  known('divorce', 'Развод'),
  known('engagement', 'Помолвка'),
  custom('Сообщение о свадьбе (оглашение)'),
  custom('Никах'),
];

/** Своё название — если нужного типа нет в списке. */
export const OTHER = 'custom:';

export function optionFor(options: EventTypeOption[], type: string, customType: string): string {
  if (type !== 'custom') return type;
  return options.some((o) => o.value === `custom:${customType}`) ? `custom:${customType}` : OTHER;
}

// Рождение, смерть и похороны бывают один раз — если уже есть, в списке их не предлагаем.
const ONCE = new Set(['birth', 'death', 'burial']);
// Самые частые — в порядке жизни; дальше семейные и остальные по алфавиту.
const MAIN = ['birth', 'baptism', 'education', 'occupation', 'residence', 'marriage', 'divorce', 'retirement', 'death', 'burial'];

export type EventTypeGroup = { label: string; options: EventTypeOption[] };

/** Типы для нового события, по группам; `has` — какие типы у человека уже есть. */
export function eventTypeGroups(has: Set<string>): EventTypeGroup[] {
  const all = [...FAMILY_EVENT_OPTIONS, ...PERSON_EVENT_OPTIONS].filter((o) => !(ONCE.has(o.type) && has.has(o.type)));
  const main = MAIN.flatMap((value) => all.filter((o) => o.value === value));
  const rest = all.filter((o) => !MAIN.includes(o.value));
  const family = rest.filter((o) => FAMILY_EVENT_OPTIONS.includes(o));
  const other = rest.filter((o) => !FAMILY_EVENT_OPTIONS.includes(o)).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  return [
    { label: 'Основные', options: main },
    { label: 'Семья', options: family },
    { label: 'Другие', options: other },
  ].filter((g) => g.options.length);
}
