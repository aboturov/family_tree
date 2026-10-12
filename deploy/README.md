# Деплой на сервер

Схема: push в `main` → GitHub Actions: проверки → сборка образа → `ghcr.io` →
`docker save | ssh` на сервер → forced command `sudo -n /usr/local/sbin/family-tree-deploy`
делает `docker load` и перезапускает контейнер. Портов на хост у контейнера нет: наружу его
отдаёт обратный прокси (Caddy) через свою Docker-сеть.

- Образ приезжает на сервер внутри ssh-подключения, поэтому серверу **не нужен токен
  ghcr** и `docker login`.
- ssh-ключ из GitHub привязан к forced command: им можно только передать образ и
  выкатить SHA коммита. Ни shell, ни проброса портов, ни копирования файлов.
- Пользователь деплоя **не входит в группу docker** (она равна root): он может только
  `sudo` один root-owned скрипт без аргументов (`deploy/family-tree-deploy.sudoers`), а
  переписать этот скрипт не может.
- Скрипт сверяет метку `org.opencontainers.image.revision` образа с SHA и при
  неудачном healthcheck откатывает на предыдущую версию.
- Секреты деплоя лежат в environment `production`, доступном только из `main`: workflow
  из другой ветки их не получит, даже если его изменить.

Ниже разовая настройка сервера. После неё каждый деплой — просто merge в `main`.

Автодеплой по умолчанию выключен: пока в репозитории не задана переменная `DEPLOY_ENABLED`
(шаг 4), CI только проверяет код и собирает фронт. Так форк или копия репозитория без
сервера не падают на деплое.

## 1. Сеть прокси

Приложение подключается к внешней Docker-сети `ingress-tree`. Её объявляет compose
обратного прокси (с фиксированным именем `ingress-tree`), поэтому прокси поднимается первым.
Кроме прокси, в этой сети никого быть не должно: приложение верит его `X-Real-IP`.

```bash
sudo docker network inspect ingress-tree >/dev/null && echo ok
```

## 2. Пользователь, каталог, скрипт деплоя

```bash
sudo useradd --create-home --shell /bin/bash family-tree-deploy   # без группы docker
sudo install -d -o root -g root -m 755 /opt/family-tree
sudo install -d -o 1000 -g 1000 /opt/family-tree/data   # uid пользователя node внутри образа
```

Если SSH на сервере открыт только перечисленным пользователям (`AllowUsers`), добавить туда
`family-tree-deploy`.

Скопировать файлы из репозитория (с локальной машины) и задать образ:

```bash
scp deploy/docker-compose.yml deploy/deploy.sh deploy/family-tree-deploy.sudoers <сервер>:/tmp/
# на сервере:
sudo install -o root -g root -m 644 /tmp/docker-compose.yml /opt/family-tree/
sudo install -o root -g root -m 755 /tmp/deploy.sh /usr/local/sbin/family-tree-deploy
sudo visudo -cf /tmp/family-tree-deploy.sudoers
sudo install -o root -g root -m 440 /tmp/family-tree-deploy.sudoers /etc/sudoers.d/family-tree-deploy
echo 'TREE_IMAGE=ghcr.io/<владелец>/<репозиторий>' | sudo tee /opt/family-tree/.env
```

CI эти файлы не обновляет: при изменении `docker-compose.yml`, `deploy.sh` или sudoers
в репозитории их нужно установить так же вручную.

## 3. SSH-ключ деплоя

Локально:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/family_tree_deploy -N "" -C "github-actions family-tree"
```

Публичную часть положить на сервер в `/home/family-tree-deploy/.ssh/authorized_keys`
**одной строкой с ограничениями** (`restrict` запрещает pty, проброс портов и агента):

```
restrict,command="sudo -n /usr/local/sbin/family-tree-deploy" ssh-ed25519 AAAA... github-actions family-tree
```

```bash
sudo install -d -m 700 -o family-tree-deploy -g family-tree-deploy /home/family-tree-deploy/.ssh
sudo -u family-tree-deploy tee /home/family-tree-deploy/.ssh/authorized_keys   # вставить строку выше, Ctrl+D
sudo chmod 600 /home/family-tree-deploy/.ssh/authorized_keys
```

Проверка с локальной машины: `ssh -i ~/.ssh/family_tree_deploy family-tree-deploy@<сервер> whoami`
должен ответить ошибкой «Ожидался SHA коммита … получено: 'whoami'». Именно `'whoami'`, а не
пустая строка: значит, sudoers передал скрипту `SSH_ORIGINAL_COMMAND`.

## 4. Секреты и переменная в GitHub

Settings → Environments → **production** (создать, если нет):

- **Deployment branches and tags** → Selected branches and tags → правило `main`;
- **Environment secrets**:

| Secret | Значение |
|---|---|
| `DEPLOY_HOST` | адрес сервера |
| `DEPLOY_USER` | `family-tree-deploy` |
| `DEPLOY_PORT` | порт ssh, если не 22 |
| `DEPLOY_SSH_KEY` | содержимое `~/.ssh/family_tree_deploy` (приватный ключ) |
| `DEPLOY_KNOWN_HOSTS` | строка `known_hosts` сервера, сверенная с `/etc/ssh/ssh_host_ed25519_key.pub` |

Секреты уровня репозитория (Settings → Secrets and variables → Actions) для деплоя не
заводить, а если остались от старой схемы — удалить: их получает workflow из любой ветки.

Там же, вкладка **Variables** → New repository variable: `DEPLOY_ENABLED` = `true`. Она
включает job `deploy`; без неё следующий push в `main` деплоить не будет. Если включить
её, не заведя секреты, деплой упадёт с ошибкой, какого секрета не хватает.

Образ публикуется в `ghcr.io` от имени репозитория (`GITHUB_TOKEN`), отдельный токен не нужен.

## 5. Прокси и TLS

Блок в Caddyfile обратного прокси (`tree.example.com` — свой домен, его DNS-запись должна
уже смотреть на сервер; сертификат Caddy выпустит сам):

```caddyfile
tree.example.com {
	request_body {
		max_size 25MB
	}
	reverse_proxy family-tree:3000 {
		# Приложение берёт адрес клиента для лимитов входа из X-Real-IP. Без этой строки
		# все посетители выглядели бы одним адресом прокси и делили бы один лимит.
		header_up X-Real-IP {remote_host}
	}
}
```

Если перед прокси стоит CDN, `X-Real-IP` должен браться из её заголовка с адресом
посетителя и только для её сетей (`trusted_proxies`), иначе лимиты считались бы по
адресам CDN.

### Защита входа

- Приложение считает неудачные входы: 10 за 15 минут на пару «адрес + логин»,
  30 за 15 минут с одного адреса по любым логинам, 100 за час на один логин с любых
  адресов. Сверх лимита — 429. Счётчики в памяти и обнуляются при перезапуске.
- Новый пароль: от 10 символов, без логина внутри, не из списка самых частых.
- Фото и все данные отдаются только после входа, с `Cache-Control: private`.

## 6. Первый деплой и первый пользователь

Перезапустить упавший деплой (или сделать новый push в `main`):

```bash
gh run rerun <run-id> --failed
```

После успешного запуска:

```bash
cd /opt/family-tree
sudo docker compose exec app tree-admin user:add anna --role admin
```

Команда напечатает временный пароль. При первом входе его попросят сменить.

Дерево можно начать двумя способами: импортировать выгрузку GEDCOM (ниже) или прямо на
сайте — в пустом дереве редактор видит форму для первого человека, остальных добавляет
родственниками из его карточки.

Потом свяжите аккаунт с собой в дереве — от этого человека строится дерево по умолчанию,
и на его карточке стоит «Я»:

```bash
sudo docker compose exec app tree-admin user:link anna I1   # ссылка из выгрузки или номер из адреса /person/<номер>
```

## Импорт начального дерева

Если дерево уже есть в другом сервисе. Разово, после первого деплоя. GEDCOM с реальными данными в репозиторий не кладём:
копируем прямо на сервер в каталог данных и удаляем после импорта.

```bash
scp Familio_gedcom_*.ged <сервер>:/tmp/familio.ged
# на сервере:
sudo install -o 1000 -g 1000 -m 600 /tmp/familio.ged /opt/family-tree/data/familio.ged && rm /tmp/familio.ged
cd /opt/family-tree
sudo docker compose exec app tree-admin import /data/familio.ged
```

Импорт печатает отчёт: возможные дубли, семьи с одним известным партнёром,
«?» в именах, пропущенные повторы событий. Дубли, которые действительно один
человек, сливаются командой из отчёта:

```bash
sudo docker compose exec app tree-admin person:merge I10 I11
```

Повторный импорт возможен только с `--replace`: он **удаляет** текущее дерево
вместе со всеми правками, сделанными на сайте. После импорта файл удалить:

```bash
sudo rm /opt/family-tree/data/familio.ged
```

## Загрузка документов пакетом

Архивные документы собирают десятками — по одному через сайт это долго. Манифест (JSON, формат —
в `server/src/documentImport.ts`) и сканы копируем в каталог данных, сначала проверяем, потом
загружаем. Каждый документ становится отдельной правкой в истории, её можно откатить; повторный
запуск пропускает уже загруженное.

```bash
scp -r archive <сервер>:/tmp/archive
# на сервере:
sudo cp -r /tmp/archive /opt/family-tree/data/archive && sudo chown -R 1000:1000 /opt/family-tree/data/archive
cd /opt/family-tree
sudo docker compose exec app tree-admin documents:import /data/archive/manifest.json --dry-run
sudo docker compose exec app tree-admin documents:import /data/archive/manifest.json --user olga
```

После загрузки сканы лежат в `data/media/documents/`, а каталог `archive` можно удалить.

## Администрирование

```bash
cd /opt/family-tree
sudo docker compose exec app tree-admin user:list
sudo docker compose exec app tree-admin user:add olga --role editor
sudo docker compose exec app tree-admin user:reset-password olga
sudo docker compose exec app tree-admin user:set-role olga viewer
sudo docker compose exec app tree-admin user:link olga I2
sudo docker compose exec app tree-admin user:delete olga
sudo docker compose logs -f app
```

## Бэкапы

База лежит в `/opt/family-tree/data/tree.db`. Ночной бэкап — файлом `/etc/cron.d/family-tree-backup`
(от root: у пользователя деплоя нет доступа к Docker):

```cron
30 3 * * * root cd /opt/family-tree && docker compose exec -T app tree-admin db:backup --keep 14
```

Копии складываются в `/opt/family-tree/data/backups/`, хранятся последние 14.
Пока они лежат на том же диске; копию вовне стоит настроить отдельно.

Фото и сканы документов в эти копии не входят: они лежат файлами в `/opt/family-tree/data/media/`
(фото — `<id>.jpg` и `<id>-thumb.jpg`, сканы — в `documents/`) и только добавляются или удаляются,
поэтому их достаточно синхронизировать, например `rsync -a data/media/ <куда-то>/media/`. Сканы
из архивов бывают платными — копию лучше держать не на том же диске.

## Откат

Если новая версия не поднялась, скрипт деплоя откатывается сам. На сервере хранятся
только текущая и предыдущая версии образа, поэтому вручную можно откатиться на
предыдущую (образ со stdin при этом не читается):

```bash
sudo docker image ls ghcr.io/<владелец>/<репозиторий>   # какие версии есть
sudo /usr/local/sbin/family-tree-deploy <полный sha>
```

Чтобы вернуть версию постарше, перезапустите в GitHub Actions деплой нужного
коммита (Re-run jobs у его запуска): образ снова приедет по ssh.
