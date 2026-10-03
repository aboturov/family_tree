// Типы документов и роли людей в них — подписи к кодам из server/src/documents.ts.

export const DOCUMENT_TYPES: Record<string, string> = {
  metric_birth: 'Метрическая запись о рождении',
  metric_marriage: 'Метрическая запись о браке',
  metric_death: 'Метрическая запись о смерти',
  civil_birth: 'Актовая запись о рождении',
  civil_marriage: 'Актовая запись о браке',
  civil_death: 'Актовая запись о смерти',
  civil_index: 'Алфавитный указатель ЗАГС',
  census: 'Перепись',
  confession: 'Исповедная ведомость',
  revision: 'Ревизская сказка',
  household: 'Похозяйственная книга',
  investigation: 'Следственное дело',
  rehabilitation: 'Справка о реабилитации',
  award: 'Наградной лист или приказ',
  service_record: 'Учётно-послужная карточка',
  loss_report: 'Донесение о потерях',
  death_notice: 'Извещение о гибели',
  military_id: 'Военный билет',
  database: 'Запись в базе данных',
  certificate: 'Свидетельство',
  personal: 'Личный документ',
  letter: 'Письмо',
  other: 'Другой документ',
};

export const DOCUMENT_ROLES: Record<string, string> = {
  subject: 'О ком',
  father: 'Отец',
  mother: 'Мать',
  groom: 'Жених',
  bride: 'Невеста',
  head: 'Глава двора',
  member: 'Член двора',
  mentioned: 'Упомянут(а)',
};

/** Как называть документ: своё название или тип. */
export const documentName = (d: { type: string; title: string }) => d.title || DOCUMENT_TYPES[d.type] || 'Документ';
