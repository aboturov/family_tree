# Деплой на сервер

Схема: push в `main` → GitHub Actions: проверки → сборка образа → `ghcr.io` →
`docker save | ssh` на сервер → `deploy.sh <sha>` в `/opt/family-tree` делает `docker load`
и перезапускает контейнер. Контейнер слушает `127.0.0.1:8091`, наружу его отдаёт nginx на хосте.

- Образ приезжает на сервер внутри ssh-подключения, поэтому серверу **не нужен токен
  ghcr** и `docker login`.
- ssh-ключ из GitHub привязан к forced command: им можно только передать образ и
  запустить `deploy.sh` с SHA коммита. Ни shell, ни проброса портов, ни копирования файлов.
- `deploy.sh` сверяет метку `org.opencontainers.image.revision` образа с SHA и при
  неудачном healthcheck откатывает на предыдущую версию.

Ниже разовая настройка сервера. После неё каждый деплой — просто merge в `main`.

Автодеплой по умолчанию выключен: пока в репозитории не задана переменная `DEPLOY_ENABLED`
(шаг 4), CI только проверяет код и собирает фронт. Так форк или копия репозитория без
сервера не падают на деплое.

## 1. Порт

Проверить, что `8091` свободен:

```bash
ss -ltn | grep 8091
```

Если занят, поменять порт в `deploy/docker-compose.yml` и в nginx-конфиге.

## 2. Пользователь для деплоя и каталог

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/family-tree/data
sudo chown deploy:deploy /opt/family-tree
sudo chown 1000:1000 /opt/family-tree/data   # uid пользователя node внутри образа
```

Скопировать файлы из репозитория (с локальной машины) и задать образ:

```bash
scp deploy/docker-compose.yml deploy/deploy.sh <сервер>:/tmp/
# на сервере:
sudo install -o deploy -g deploy -m 644 /tmp/docker-compose.yml /opt/family-tree/
sudo install -o deploy -g deploy -m 755 /tmp/deploy.sh /opt/family-tree/
echo 'TREE_IMAGE=ghcr.io/<владелец>/<репозиторий>' | sudo -u deploy tee /opt/family-tree/.env
```

CI эти файлы не обновляет: при изменении `docker-compose.yml` или `deploy.sh`
в репозитории их нужно скопировать так же вручную.

## 3. SSH-ключ деплоя

Локально:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/family_tree_deploy -N "" -C "github-actions family-tree"
```

Публичную часть положить на сервер в `/home/deploy/.ssh/authorized_keys` **одной строкой
с ограничениями** (`restrict` запрещает pty, проброс портов и агента):

```
command="/opt/family-tree/deploy.sh",restrict ssh-ed25519 AAAA... github-actions family-tree
```

```bash
sudo -u deploy install -d -m 700 /home/deploy/.ssh
sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys   # вставить строку выше, Ctrl+D
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Проверка с локальной машины: `ssh -i ~/.ssh/family_tree_deploy deploy@<сервер> whoami`
должен ответить ошибкой «Ожидался SHA коммита».

## 4. Секреты и переменная в GitHub

Settings → Secrets and variables → Actions → вкладка **Secrets** → New repository secret:

| Secret | Значение |
|---|---|
| `DEPLOY_HOST` | адрес сервера |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PORT` | порт ssh, если не 22 |
| `DEPLOY_SSH_KEY` | содержимое `~/.ssh/family_tree_deploy` (приватный ключ) |
| `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan -p <порт> <адрес>` |

Там же, вкладка **Variables** → New repository variable: `DEPLOY_ENABLED` = `true`. Она
включает job `deploy`; без неё следующий push в `main` деплоить не будет. Если включить
её, не заведя секреты, деплой упадёт с ошибкой, какого секрета не хватает.

Образ публикуется в `ghcr.io` от имени репозитория (`GITHUB_TOKEN`), отдельный токен не нужен.

## 5. nginx и TLS

```bash
sudo cp deploy/nginx/cloudflare-realip.conf /etc/nginx/snippets/
sudo cp deploy/nginx/family-tree.conf /etc/nginx/sites-available/family-tree
sudo ln -s /etc/nginx/sites-available/family-tree /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tree.example.com
```

В `family-tree.conf` и в команде certbot `tree.example.com` заменить на свой домен; его
DNS-запись должна уже смотреть на сервер. Если домен проксируется через Cloudflare,
`cloudflare-realip.conf` берёт адрес посетителя из
`CF-Connecting-IP` — иначе лимиты входа считались бы по адресам Cloudflare. Заголовку
nginx верит только от сетей Cloudflare; их список изредка меняется
(https://www.cloudflare.com/ips/), тогда файл нужно обновить. Без Cloudflare строку
`include snippets/cloudflare-realip.conf` из конфига сайта нужно убрать.

### Защита входа

- nginx: не больше 10 запросов на `/api/auth/login` в минуту с одного адреса.
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
docker compose exec app tree-admin user:add anna --role admin
```

Команда напечатает временный пароль. При первом входе его попросят сменить.

Дерево можно начать двумя способами: импортировать выгрузку GEDCOM (ниже) или прямо на
сайте — в пустом дереве редактор видит форму для первого человека, остальных добавляет
родственниками из его карточки.

Потом свяжите аккаунт с собой в дереве — от этого человека строится дерево по умолчанию,
и на его карточке стоит «Я»:

```bash
docker compose exec app tree-admin user:link anna I1   # ссылка из выгрузки или номер из адреса /person/<номер>
```

## Импорт начального дерева

Если дерево уже есть в другом сервисе. Разово, после первого деплоя. GEDCOM с реальными данными в репозиторий не кладём:
копируем прямо на сервер в каталог данных и удаляем после импорта.

```bash
scp Familio_gedcom_*.ged <сервер>:/tmp/familio.ged
# на сервере:
sudo install -o 1000 -g 1000 -m 600 /tmp/familio.ged /opt/family-tree/data/familio.ged && rm /tmp/familio.ged
cd /opt/family-tree
sudo -u deploy docker compose exec app tree-admin import /data/familio.ged
```

Импорт печатает отчёт: возможные дубли, семьи с одним известным партнёром,
«?» в именах, пропущенные повторы событий. Дубли, которые действительно один
человек, сливаются командой из отчёта:

```bash
sudo -u deploy docker compose exec app tree-admin person:merge I10 I11
```

Повторный импорт возможен только с `--replace`: он **удаляет** текущее дерево
вместе со всеми правками, сделанными на сайте. После импорта файл удалить:

```bash
sudo rm /opt/family-tree/data/familio.ged
```

## Администрирование

```bash
cd /opt/family-tree
docker compose exec app tree-admin user:list
docker compose exec app tree-admin user:add olga --role editor
docker compose exec app tree-admin user:reset-password olga
docker compose exec app tree-admin user:set-role olga viewer
docker compose exec app tree-admin user:link olga I2
docker compose exec app tree-admin user:delete olga
docker compose logs -f app
```

## Бэкапы

База лежит в `/opt/family-tree/data/tree.db`. Ночной бэкап через cron пользователя `deploy`:

```cron
30 3 * * * cd /opt/family-tree && docker compose exec -T app tree-admin db:backup --keep 14
```

Копии складываются в `/opt/family-tree/data/backups/`, хранятся последние 14.
Пока они лежат на том же диске; копию вовне стоит настроить отдельно.

Фото в эти копии не входят: они лежат файлами в `/opt/family-tree/data/media/`
(`<id>.jpg` и `<id>-thumb.jpg`) и только добавляются или удаляются, поэтому
их достаточно синхронизировать, например `rsync -a data/media/ <куда-то>/media/`.

## Откат

Если новая версия не поднялась, `deploy.sh` откатывается сам. На сервере хранятся
только текущая и предыдущая версии образа, поэтому вручную можно откатиться на
предыдущую (под пользователем `deploy`, образ со stdin при этом не читается):

```bash
docker image ls ghcr.io/<владелец>/<репозиторий>   # какие версии есть
/opt/family-tree/deploy.sh <полный sha>
```

Чтобы вернуть версию постарше, перезапустите в GitHub Actions деплой нужного
коммита (Re-run jobs у его запуска): образ снова приедет по ssh.
