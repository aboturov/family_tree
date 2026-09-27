# Family Tree

Закрытое self-hosted семейное дерево. Видение и этапы — в [docs/VISION.md](docs/VISION.md),
настройка сервера и деплой — в [deploy/README.md](deploy/README.md).

CI на каждый push проверяет код. Автодеплой на свой сервер включается переменной
репозитория `DEPLOY_ENABLED=true` после настройки сервера и секретов — всё по шагам в
[deploy/README.md](deploy/README.md).

## Попробовать

Нужен Node 24+.

```bash
npm install
npm run demo
```

Откроется http://localhost:3000, вход `demo` / `demo`. Это вымышленная семья из
[examples/demo.ged](examples/demo.ged): 71 человек в шести поколениях — повторные браки,
единокровная родня, двоюродные и дальше, неполные даты. Правки сохраняются в отдельной базе
`server/data/demo`; начать заново — `npm run demo -- --reset`.

## Стек

- `server/` — Hono на Node 24, SQLite через встроенный `node:sqlite`, CLI `tree-admin`.
  Запускается прямо из `.ts` (type stripping в Node), без сборки.
- `web/` — React + Vite.
- Один Docker-образ: сервер отдаёт API (`/api/*`) и собранный фронт.

## Локальная разработка

Нужен Node 24+.

```bash
npm install
npm run dev:server   # API на :3000, база в server/data/
npm run dev:web      # Vite на :5173, проксирует /api на :3000
```

Первый пользователь:

```bash
npm run admin -w server -- user:add anna --role admin
```

Проверки (их же гоняет CI):

```bash
npm run typecheck && npm test && npm run build
```

## Лицензия

[AGPL-3.0-or-later](LICENSE). Разворачивать у себя и менять можно свободно; если изменённая
версия работает как сервис для других людей, её исходники нужно открыть этим людям.
