import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Миграции применяются по порядку; номер последней хранится в PRAGMA user_version.
// Уже выпущенные миграции не редактируем — только добавляем новые в конец.
const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- id — sha256 от токена из cookie: утечка базы не даёт готовых сессий.
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user_id ON sessions(user_id);
  `,
  `
  -- Модель совместима с GEDCOM: человек, семья (союз до двух партнёров с детьми), события, места.
  CREATE TABLE persons (
    id INTEGER PRIMARY KEY,
    -- Идентификаторы из источника импорта: для отчётов и сверки с familio.
    source_uid TEXT UNIQUE,
    source_ref TEXT,
    given_name TEXT NOT NULL DEFAULT '',
    patronymic TEXT NOT NULL DEFAULT '',
    surname TEXT NOT NULL DEFAULT '',
    -- Девичья (при рождении), если отличается от текущей.
    birth_surname TEXT NOT NULL DEFAULT '',
    sex TEXT NOT NULL DEFAULT 'U' CHECK (sex IN ('M', 'F', 'U')),
    -- «Умер» бывает известно без даты смерти.
    is_deceased INTEGER NOT NULL DEFAULT 0,
    -- Данные под вопросом («???» в выгрузке).
    is_uncertain INTEGER NOT NULL DEFAULT 0,
    bio TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE places (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    lat REAL,
    lon REAL
  );

  CREATE TABLE families (
    id INTEGER PRIMARY KEY,
    source_ref TEXT,
    partner1_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    partner2_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX families_partner1 ON families(partner1_id);
  CREATE INDEX families_partner2 ON families(partner2_id);

  CREATE TABLE family_children (
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'birth' CHECK (relation IN ('birth', 'adopted', 'foster', 'unknown')),
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (family_id, child_id)
  );
  CREATE INDEX family_children_child ON family_children(child_id);

  -- Дата хранится частичным ISO (YYYY, YYYY-MM, YYYY-MM-DD) с модификатором;
  -- date_text — исходная строка, если её не удалось разобрать.
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
    family_id INTEGER REFERENCES families(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    custom_type TEXT NOT NULL DEFAULT '',
    date_modifier TEXT CHECK (date_modifier IN ('exact', 'about', 'estimated', 'calculated', 'before', 'after', 'between')),
    date_value TEXT,
    date_value_to TEXT,
    date_text TEXT NOT NULL DEFAULT '',
    place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    CHECK ((person_id IS NULL) != (family_id IS NULL))
  );
  CREATE INDEX events_person ON events(person_id);
  CREATE INDEX events_family ON events(family_id);
  `,
  `
  -- Кто из дерева этот пользователь: от него считаются «Отец», «Бабушка» и стартовый вид.
  ALTER TABLE users ADD COLUMN person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL;
  `,
  `
  -- Версия меняется при каждой правке человека или семьи (включая их события): если двое
  -- правят одну карточку, второй получит конфликт, а не затрёт чужие изменения молча.
  ALTER TABLE persons ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE families ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

  -- Журнал правок: кто, когда, что было и что стало (JSON). Экран истории и откат — позже.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    entity TEXT NOT NULL CHECK (entity IN ('person', 'family', 'event', 'place')),
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    before TEXT,
    after TEXT
  );
  CREATE INDEX audit_log_entity ON audit_log(entity, entity_id);
  `,
  `
  -- Фото человека. Файлы — в <DATA_DIR>/media: <id>.jpg (до 2000 px) и <id>-thumb.jpg (до 480 px);
  -- уменьшает и перекодирует их браузер перед загрузкой. width/height — у большого файла.
  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    caption TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX media_person ON media(person_id);

  -- Аватарка — одно из фото человека; avatar_crop — JSON {x, y, zoom}: центр круга в долях
  -- ширины и высоты кадра и диаметр круга в долях меньшей стороны.
  ALTER TABLE persons ADD COLUMN avatar_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;
  ALTER TABLE persons ADD COLUMN avatar_crop TEXT;

  ALTER TABLE audit_log RENAME TO audit_log_old;
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    entity TEXT NOT NULL CHECK (entity IN ('person', 'family', 'event', 'place', 'media')),
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    before TEXT,
    after TEXT
  );
  INSERT INTO audit_log SELECT * FROM audit_log_old;
  DROP TABLE audit_log_old;
  CREATE INDEX audit_log_entity_v2 ON audit_log(entity, entity_id);
  `,
  `
  -- Правка — одно действие пользователя («добавил сына», «удалил фото»). Строки audit_log внутри
  -- неё ссылаются на неё: история показывает действие целиком и может откатить его.
  -- person_id — о ком правка, без внешнего ключа: человек мог быть удалён; details — JSON
  -- с именами на момент правки, чтобы история читалась и после удаления.
  CREATE TABLE changes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    action TEXT NOT NULL,
    person_id INTEGER,
    details TEXT NOT NULL DEFAULT '{}',
    undone_by INTEGER REFERENCES changes(id)
  );
  CREATE INDEX changes_person ON changes(person_id);
  ALTER TABLE audit_log ADD COLUMN change_id INTEGER REFERENCES changes(id);
  -- Записи, сделанные до истории, — по одной «старой правке» на строку журнала.
  INSERT INTO changes (id, user_id, at, action, person_id, details)
    SELECT id, user_id, at, 'legacy', CASE WHEN entity = 'person' THEN entity_id END,
      json_object('entity', entity, 'action', action, 'entityId', entity_id)
    FROM audit_log;
  UPDATE audit_log SET change_id = id;
  CREATE INDEX audit_log_change ON audit_log(change_id);
  -- Пустые «половинки» браков из импорта: без второго супруга, детей и событий.
  DELETE FROM families
    WHERE (partner1_id IS NULL OR partner2_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM family_children WHERE family_id = families.id)
      AND NOT EXISTS (SELECT 1 FROM events WHERE family_id = families.id);
  `,
  `
  -- Id фото больше не переиспользуются (AUTOINCREMENT). Браузер кеширует файл по id на год,
  -- а в корзине лежат файлы удалённых фото. Раньше новое фото получало id только что
  -- удалённого, и устройство, где старое осталось в кеше, показывало его вместо нового.
  CREATE TABLE media_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    caption TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  INSERT INTO media_v2 (id, person_id, caption, width, height, created_at, created_by)
    SELECT id, person_id, caption, width, height, created_at, created_by FROM media;
  DROP TABLE media;
  ALTER TABLE media_v2 RENAME TO media;
  CREATE INDEX media_person ON media(person_id);
  -- Счёт — от самого большого id, какой был: id удалённых фото тоже заняты.
  DELETE FROM sqlite_sequence WHERE name = 'media';
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'media', coalesce(max(id), 0)
    FROM (SELECT id FROM media UNION ALL SELECT entity_id AS id FROM audit_log WHERE entity = 'media');
  `,
  `
  -- «Умер» — это событие смерти, пусть и без даты (как \`1 DEAT Y\` в GEDCOM), а не отдельный флаг:
  -- флаг и событие расходились, когда дату вводили без галочки.
  INSERT INTO events (person_id, type)
    SELECT id, 'death' FROM persons p
    WHERE is_deceased = 1 AND NOT EXISTS (SELECT 1 FROM events WHERE person_id = p.id AND type = 'death');
  ALTER TABLE persons DROP COLUMN is_deceased;
  `,
  `
  -- Дата по старому стилю (юлианский календарь, как @#DJULIAN@ в GEDCOM): метрики до 1918 года.
  -- Храним как записано, без пересчёта, — отметка только говорит, как читать дату.
  ALTER TABLE events ADD COLUMN date_calendar TEXT NOT NULL DEFAULT 'gregorian'
    CHECK (date_calendar IN ('gregorian', 'julian'));
  `,
  `
  -- Документы: архивные записи и семейные бумаги. Карточка — шифр, дата, расшифровка; сканы —
  -- файлы в <DATA_DIR>/media/documents. С людьми и событиями — связи «многие ко многим»: в одной
  -- метрике и ребёнок, и родители. Скана может ещё не быть (копию заказали), людей — тоже
  -- (родство не подтверждено).
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Ключ из манифеста пакетного импорта: повторный импорт не создаёт дублей.
    source_uid TEXT UNIQUE,
    -- Тип и роли проверяет код (documents.ts): новый тип не требует пересборки таблицы.
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    -- Дата составления — не дата события: книги ЗАГС восстанавливали годы спустя.
    date_modifier TEXT CHECK (date_modifier IN ('exact', 'about', 'estimated', 'calculated', 'before', 'after', 'between')),
    date_value TEXT,
    date_value_to TEXT,
    date_calendar TEXT NOT NULL DEFAULT 'gregorian' CHECK (date_calendar IN ('gregorian', 'julian')),
    -- Где оригинал: архив и шифр. Всё текстом: фонд «Р-100», опись «2а», лист «12об.–13».
    archive TEXT NOT NULL DEFAULT '',
    fond TEXT NOT NULL DEFAULT '',
    opis TEXT NOT NULL DEFAULT '',
    delo TEXT NOT NULL DEFAULT '',
    sheets TEXT NOT NULL DEFAULT '',
    -- Ссылка на дело в онлайн-архиве; номер кадра — у каждого файла.
    url TEXT NOT NULL DEFAULT '',
    transcription TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  -- Сканы по порядку: <id>.jpg — оригинал без пересжатия (только без EXIF), <id>-thumb.jpg.
  CREATE TABLE document_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    -- Номер кадра в онлайн-архиве: он не совпадает с номером листа.
    frame INTEGER,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    -- Один кадр бывает нужен двум документам: по хешу предупреждаем, но не запрещаем.
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX document_files_document ON document_files(document_id);
  CREATE INDEX document_files_sha256 ON document_files(sha256);

  CREATE TABLE document_persons (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (document_id, person_id)
  );
  CREATE INDEX document_persons_person ON document_persons(person_id);

  -- Какие события документ подтверждает.
  CREATE TABLE document_events (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, event_id)
  );
  CREATE INDEX document_events_event ON document_events(event_id);

  -- В журнале у документа и его файлов свои записи: откат правки, корзина файлов.
  ALTER TABLE audit_log RENAME TO audit_log_old;
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    entity TEXT NOT NULL
      CHECK (entity IN ('person', 'family', 'event', 'place', 'media', 'document', 'document_file')),
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    before TEXT,
    after TEXT,
    change_id INTEGER REFERENCES changes(id)
  );
  INSERT INTO audit_log SELECT * FROM audit_log_old;
  DROP TABLE audit_log_old;
  CREATE INDEX audit_log_entity ON audit_log(entity, entity_id);
  CREATE INDEX audit_log_change ON audit_log(change_id);
  `,
  `
  -- Что именно: название награды, звание, профессия, учебное заведение. В GEDCOM это значение
  -- строки события: \`1 OCCU Учитель\`, \`1 EVEN Орден Красной Звезды\` с \`2 TYPE Военная награда\`.
  ALTER TABLE events ADD COLUMN details TEXT NOT NULL DEFAULT '';
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Доводит базу до версии `target` (по умолчанию — последней); тесты миграций берут старую. */
export function migrate(db: Db, target = migrations.length) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (current >= target) return;
  // Пересборка таблицы (новая, копия, DROP старой) при включённых внешних ключах обнулила бы
  // ссылки на неё — например, аватарки на media. Внутри транзакции ключи не выключить, поэтому
  // выключаем на время миграций, а целостность проверяем перед каждым COMMIT.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (let version = current; version < target; version++) {
      db.exec('BEGIN');
      try {
        db.exec(migrations[version]);
        if (db.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error(`Миграция ${version + 1} нарушила внешние ключи`);
        }
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
