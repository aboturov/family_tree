import fs from 'node:fs';
import { encode } from 'jpeg-js';
import type { Db } from './db.ts';
import { addDocument, addDocumentFile, documentChangeSubject, mainPerson, parseDocumentFields, prepareScan } from './documents.ts';
import { makeThumbnail } from './jpeg.ts';
import { recordChange } from './journal.ts';
import { findPersonId } from './merge.ts';

// Вымышленные документы демо-дерева: метрика о браке с двумя сканами, метрика о рождении,
// ведомость, которая пока ни к кому не привязана, и письмо с фронта — длинная расшифровка для
// проверки вёрстки. «Сканы» рисуются здесь же — линованный лист с каракулями вместо почерка, —
// чтобы не держать картинки в репозитории.

const ARCHIVE = 'ГА Тверской области';

const DOCUMENTS = [
  {
    type: 'metric_marriage',
    date: { modifier: 'exact', value: '1904-01-25', calendar: 'julian' },
    fond: '160',
    opis: '1',
    delo: '1904',
    sheets: '45об.–46',
    url: 'https://archive.example.com/unit/160-1-1904',
    transcription:
      'Месяц и день: 25 января. Жених: крестьянин деревни Примерово Прохор Соколов, православный, первым браком, 24 лет. ' +
      'Невеста: крестьянская дочь села Заречье Марфа Иванова Белова, православная, первым браком, 20 лет.',
    note: 'Пример демо-дерева: возраст невесты на год расходится с датой рождения.',
    persons: [
      { ref: 'I4', role: 'groom' },
      { ref: 'I5', role: 'bride' },
    ],
    marriageOf: 'I4',
    frames: [93, 94],
  },
  {
    type: 'metric_birth',
    date: { modifier: 'exact', value: '1908-11-22', calendar: 'julian' },
    fond: '160',
    opis: '1',
    delo: '1908',
    sheets: '112',
    url: 'https://archive.example.com/unit/160-1-1908',
    transcription: 'Родилась 20, крещена 22 ноября Мария. Родители: мещанин Архип Петров Волков и законная жена его Евдокия Матвеева.',
    note: '',
    persons: [
      { ref: 'I13', role: 'subject' },
      { ref: 'I6', role: 'father' },
      { ref: 'I7', role: 'mother' },
    ],
    birthOf: 'I13',
    frames: [61],
  },
  {
    type: 'confession',
    title: 'Исповедная ведомость села Заречье за 1899 год',
    date: { modifier: 'exact', value: '1899', calendar: 'julian' },
    fond: '160',
    opis: '3',
    delo: '57',
    sheets: '12–14',
    url: '',
    transcription: '',
    note: 'Два двора Соколовых — проверить, наши ли. Скан не заказан.',
    persons: [],
    frames: [],
  },
  {
    type: 'letter',
    title: 'Последнее письмо с фронта',
    date: { modifier: 'exact', value: '1943-01-09' },
    archive: 'Семейный архив',
    fond: '',
    opis: '',
    delo: '',
    sheets: '',
    url: '',
    transcription: [
      'Здравствуй, дорогая моя Маша, и детки мои Миша и Клава!',
      'Пишу вам с передовой, жив и здоров, чего и вам желаю. Письмо ваше от 2 декабря получил, за него большое ' +
        'спасибо. Читал его три раза, и товарищам читал, как Миша учится в школе на одни пятёрки. Ты, Миша, теперь ' +
        'в доме старший мужчина: помогай матери и дрова колоть, и воду носить, и за Клавой смотри.',
      'Маша, ты пишешь, что с дровами плохо и что в колхозе за трудодни дали мало. Сходи к председателю, скажи, ' +
        'что муж на фронте, — должны помочь. Валенки Мише подшей из моих старых, они на печке за трубой.',
      'У нас стоят морозы, но одеты мы тепло и кормят хорошо. Скоро, видно, пойдём вперёд, так что если долго ' +
        'не будет писем — не волнуйтесь, значит, некогда писать. Немца гоним и прогоним, и тогда я вернусь, ' +
        'и заживём лучше прежнего.',
      'Передавай поклон всей родне в Примерове и соседям. Пишите чаще, адрес мой прежний: полевая почта 12345, ' +
        'часть 678.',
      'Остаюсь ваш муж и отец Иван. 9 января 1943 года.',
    ].join('\n\n'),
    note:
      'Письмо-треугольник без конверта, на обороте штамп «Просмотрено военной цензурой». Номер полевой почты ' +
      'сверен по справочнику: https://fieldpost.example.com/pp/12345/ — в январе 1943 г. часть стояла на правом ' +
      'берегу Невы. Больше писем не было.',
    persons: [
      { ref: 'I10', role: 'subject' },
      { ref: 'I13', role: 'mentioned' },
      { ref: 'I20', role: 'mentioned' },
      { ref: 'I21', role: 'mentioned' },
    ],
    eventOf: { ref: 'I10', customType: 'Военная служба' },
    // Две стороны листа; кадров онлайн-архива у семейного письма нет.
    frames: [null, null],
  },
];

export function seedDemoDocuments(db: Db, mediaDir: string, userId: number) {
  if ((db.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }).n > 0) return;
  DOCUMENTS.forEach((d, n) => {
    const person = (ref: string) => findPersonId(db, ref)!;
    const events: number[] = [];
    if (d.birthOf) {
      events.push((db.prepare("SELECT id FROM events WHERE person_id = ? AND type = 'birth'").get(person(d.birthOf)) as { id: number }).id);
    }
    if (d.marriageOf) {
      const row = db
        .prepare(
          `SELECT e.id FROM events e JOIN families f ON f.id = e.family_id
           WHERE e.type = 'marriage' AND (f.partner1_id = ?1 OR f.partner2_id = ?1)`,
        )
        .get(person(d.marriageOf)) as { id: number };
      events.push(row.id);
    }
    if (d.eventOf) {
      const row = db
        .prepare('SELECT id FROM events WHERE person_id = ? AND custom_type = ?')
        .get(person(d.eventOf.ref), d.eventOf.customType) as { id: number };
      events.push(row.id);
    }
    const fields = parseDocumentFields({
      ...d,
      archive: d.archive ?? ARCHIVE,
      persons: d.persons.map((p) => ({ id: person(p.ref), role: p.role })),
      events,
    });
    const scans = d.frames.map((frame, page) => {
      const scan = prepareScan(fakeScan(n * 10 + page));
      return { scan, thumb: makeThumbnail(scan.bytes), frame };
    });
    fs.mkdirSync(mediaDir, { recursive: true });
    recordChange(
      db,
      userId,
      'document.add',
      mainPerson(fields),
      () => {
        const id = addDocument(db, userId, fields);
        for (const scan of scans) addDocumentFile(db, mediaDir, userId, id, scan);
        return id;
      },
      (id) => documentChangeSubject(db, id).details,
    );
  });
}

/** «Разворот книги»: желтоватый лист, сгиб посередине, графы и строки каракуль. */
function fakeScan(seed: number, width = 1800, height = 1200): Uint8Array {
  let state = seed * 7919 + 17;
  const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const grain = (random() - 0.5) * 10;
    data[i] = 232 + grain;
    data[i + 1] = 221 + grain;
    data[i + 2] = 192 + grain;
    data[i + 3] = 255;
  }
  const dot = (x: number, y: number, r: number, color: [number, number, number], alpha: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= width || py >= height || dx * dx + dy * dy > r * r) continue;
        const i = (py * width + px) * 4;
        for (let c = 0; c < 3; c++) data[i + c] = data[i + c] * (1 - alpha) + color[c] * alpha;
      }
    }
  };
  const rule: [number, number, number] = [150, 120, 90];
  const ink: [number, number, number] = [55, 45, 70];
  // Сгиб и графы.
  for (let y = 0; y < height; y++) for (let w = -3; w <= 3; w++) dot(width / 2 + w, y, 0, [120, 100, 80], 0.25 - Math.abs(w) * 0.06);
  for (let row = 140; row < height - 60; row += 70) for (let x = 60; x < width - 60; x += 1) dot(x, row, 0, rule, 0.5);
  for (const col of [60, 230, 520, width / 2 + 60, width / 2 + 330, width - 60]) {
    for (let y = 80; y < height - 60; y++) dot(col, y, 0, rule, 0.5);
  }
  // Строки «почерка»: слова — волны с наклоном.
  for (let row = 140; row < height - 130; row += 70) {
    let x = 80 + random() * 40;
    while (x < width - 140) {
      const length = 40 + random() * 120;
      const tall = 8 + random() * 6;
      for (let t = 0; t < length; t += 0.7) {
        const y = row + 40 + Math.sin(t / 3.2 + random() * 0.4) * tall - t * 0.05;
        dot(x + t, y, 1, ink, 0.8);
      }
      x += length + 18 + random() * 30;
      if (Math.abs(x - width / 2) < 40) x += 80;
    }
  }
  return new Uint8Array(encode({ width, height, data }, 85).data);
}
