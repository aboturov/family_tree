import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { openDb, type Db } from '../src/db.ts';
import { planDocumentImport, runDocumentImport } from '../src/documentImport.ts';
import { listDocuments } from '../src/documents.ts';
import { readJpegInfo } from '../src/jpeg.ts';
import { listChanges } from '../src/history.ts';
import { exif, jpeg } from './fixtures.ts';

let db: Db;
let dir: string;
let mediaDir: string;

const TREE = `
  INSERT INTO persons (id, given_name, surname, sex, source_ref) VALUES
    (1, 'Анна', 'Орлова', 'F', 'I1'), (2, 'Пётр', 'Орлов', 'M', 'I2'), (3, 'Мария', 'Орлова', 'F', 'I3'),
    (4, 'Ольга', 'Белова', 'F', 'I4');
  INSERT INTO families (id, partner1_id, partner2_id) VALUES (1, 2, 3), (2, 2, 4);
  INSERT INTO family_children (family_id, child_id) VALUES (1, 1);
  INSERT INTO events (id, person_id, type) VALUES (10, 1, 'birth');
  INSERT INTO events (id, family_id, type) VALUES (20, 1, 'marriage'), (21, 2, 'marriage');
`;

function manifest(documents: unknown[], files: Record<string, Uint8Array> = {}) {
  fs.mkdirSync(path.join(dir, 'scans'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ documents }));
  return file;
}

const birth = {
  uid: 'doc-001',
  type: 'civil_birth',
  date: { modifier: 'exact', value: '1925-03-14' },
  archive: 'ГА Тверской области',
  fond: 'Р-100',
  opis: '2а',
  delo: '15А',
  sheets: '12об.–13',
  url: 'https://archive.example.com/unit/123',
  files: [
    { path: 'scans/doc-001-1.jpg', frame: 27 },
    { path: 'scans/doc-001-2.jpg', frame: 28 },
  ],
  persons: [
    { id: 1, role: 'subject' },
    { id: 'I2', role: 'father' },
    { id: 3, role: 'mother' },
  ],
  events: [{ person: 1, type: 'birth' }],
};
const birthScans = { 'scans/doc-001-1.jpg': jpeg(900, 600, { seed: 1 }), 'scans/doc-001-2.jpg': jpeg(600, 900, { seed: 2 }) };

beforeEach(() => {
  db = openDb(':memory:');
  db.exec(TREE);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
});

describe('импорт документов по манифесту', () => {
  it('загружает документ со сканами, миниатюрами, людьми и событием — одной правкой', () => {
    const plan = planDocumentImport(db, manifest([birth], birthScans));
    assert.deepEqual([plan.errors, plan.warnings, plan.skipped], [[], [], []]);
    const [id] = runDocumentImport(db, mediaDir, plan, null);

    const [doc] = listDocuments(db);
    assert.equal(doc.id, id);
    assert.deepEqual(
      [doc.fond, doc.opis, doc.delo, doc.sheets, doc.persons.map((p) => p.id), doc.events],
      ['Р-100', '2а', '15А', '12об.–13', [1, 2, 3], [10]],
    );
    assert.deepEqual(
      doc.files.map((f) => [f.frame, f.width, f.height]),
      [
        [27, 900, 600],
        [28, 600, 900],
      ],
    );
    const thumb = fs.readFileSync(path.join(mediaDir, 'documents', `${doc.files[0].id}-thumb.jpg`));
    assert.deepEqual(readJpegInfo(thumb), { width: 480, height: 320, orientation: 1 });

    const { items } = listChanges(db, {});
    assert.deepEqual(
      items.map((i) => [i.action, i.personId]),
      [['document.add', 1]],
    );
  });

  it('повторный запуск пропускает загруженное', () => {
    const file = manifest([birth], birthScans);
    runDocumentImport(db, mediaDir, planDocumentImport(db, file), null);
    const again = planDocumentImport(db, file);
    assert.deepEqual([again.documents, again.skipped], [[], ['doc-001']]);
  });

  it('брак — по супругу, если браков несколько', () => {
    const marriage = (extra: object) => ({ uid: 'doc-002', type: 'metric_marriage', persons: [{ id: 2, role: 'groom' }, { id: 4, role: 'bride' }], ...extra });
    const ambiguous = planDocumentImport(db, manifest([marriage({ events: [{ person: 2, type: 'marriage' }] })]));
    assert.match(ambiguous.errors[0], /несколько событий marriage — укажите spouse/);
    const plan = planDocumentImport(db, manifest([marriage({ events: [{ person: 2, type: 'marriage', spouse: 4 }] })]));
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.documents[0].fields.events, [21]);
  });

  it('собирает все ошибки сразу и ничего не загружает', () => {
    const plan = planDocumentImport(
      db,
      manifest(
        [
          { ...birth, persons: [{ id: 99, role: 'subject' }] },
          { uid: 'doc-002', type: 'civil_death', persons: [{ id: 1, role: 'subject' }], events: [{ person: 1, type: 'death' }] },
          { uid: 'doc-003', type: 'census', files: [{ path: 'scans/missing.jpg' }] },
          { uid: 'doc-004', type: 'census', files: [{ path: 'scans/rotated.jpg' }] },
          { uid: 'doc-004', type: 'census' },
          { type: 'census' },
        ],
        { 'scans/rotated.jpg': jpeg(40, 30, { exif: exif(6) }) },
      ),
    );
    assert.deepEqual(plan.errors, [
      'doc-001: человек 99 не найден',
      'doc-002: у человека 1 нет события death — сначала добавьте его в дерево',
      'doc-003: нет файла scans/missing.jpg',
      'doc-004: scans/rotated.jpg: Скан повёрнут через EXIF — сохраните его уже повёрнутым и загрузите снова',
      'doc-004: uid повторяется в манифесте',
      '№6: нужен uid — строка до 200 символов',
    ]);
    assert.throws(() => runDocumentImport(db, mediaDir, plan, null), /ошибки/);
    assert.deepEqual(listDocuments(db), []);
  });

  it('один кадр в двух документах — предупреждение, не ошибка', () => {
    const scan = jpeg(40, 30, { seed: 5 });
    const plan = planDocumentImport(
      db,
      manifest(
        [
          { uid: 'doc-010', type: 'confession', files: [{ path: 'scans/page.jpg' }], transcripton: 'опечатка' },
          { uid: 'doc-011', type: 'confession', files: [{ path: 'scans/page.jpg' }] },
        ],
        { 'scans/page.jpg': scan },
      ),
    );
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.warnings, [
      'doc-010: неизвестные поля transcripton — пропущены',
      'doc-011: scans/page.jpg — тот же скан, что doc-010/scans/page.jpg',
    ]);
  });
});

describe('tree-admin documents:import', () => {
  it('--dry-run проверяет и ничего не пишет; без него — загружает', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'));
    const tree = openDb(path.join(dataDir, 'tree.db'));
    tree.exec(TREE);
    tree.close();
    const file = manifest([birth], birthScans);
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'documents:import', file, ...args], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, DATA_DIR: dataDir },
        encoding: 'utf8',
      });

    const dry = cli('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\+ doc-001: civil_birth, сканов 2, людей 3, событий 1/);
    assert.equal(fs.existsSync(path.join(dataDir, 'media', 'documents')), false);

    const real = cli();
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /Загружено документов: 1/);
    assert.equal(fs.readdirSync(path.join(dataDir, 'media', 'documents')).length, 4);
    assert.match(cli('--dry-run').stdout, /= doc-001: уже загружен/);
  });
});
