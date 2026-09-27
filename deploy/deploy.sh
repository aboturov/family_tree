#!/bin/sh
# Принимает образ через stdin (docker save из GitHub Actions), выкатывает его и
# при неудаче откатывает на предыдущий. В ghcr сервер не ходит, токен ему не нужен.
#
# Из GitHub Actions вызывается только через forced command в authorized_keys:
# SHA приходит в SSH_ORIGINAL_COMMAND, и ничего другого этим ключом сделать нельзя.
# Вручную переключает на уже загруженную версию (откат), stdin не читает:
#   /opt/family-tree/deploy.sh <sha>
set -eu

cd "$(dirname "$0")"

tag="${SSH_ORIGINAL_COMMAND:-${1:-}}"
case "$tag" in
  "" | *[!0-9a-f]*)
    echo "Ожидался SHA коммита (40 символов 0-9a-f), получено: '$tag'" >&2
    exit 2
    ;;
esac
if [ "${#tag}" -ne 40 ]; then
  echo "Ожидался полный SHA коммита (40 символов), получено: '$tag'" >&2
  exit 2
fi

repo="$(sed -n 's/^TREE_IMAGE=//p' .env)"
if [ -z "$repo" ]; then
  echo "В .env не задан TREE_IMAGE" >&2
  exit 1
fi
image="$repo:$tag"

# Образ на stdin приходит только от GitHub Actions, то есть через forced command.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  echo "Приём образа $image"
  docker image load
fi

# Проверяем, что пришёл (или лежит локально) именно образ этого коммита.
revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null || true)"
if [ "$revision" != "$tag" ]; then
  echo "Образ $image не найден или собран не из этого коммита (revision: '${revision:-нет}')" >&2
  exit 1
fi

set_tag() {
  grep -v '^TREE_TAG=' .env > .env.tmp || true
  echo "TREE_TAG=$1" >> .env.tmp
  mv .env.tmp .env
}

previous="$(sed -n 's/^TREE_TAG=//p' .env)"

echo "Деплой $tag (было: ${previous:-ничего})"
set_tag "$tag"

if docker compose up -d --wait; then
  # Держим только текущую и предыдущую версии: предыдущая нужна для отката.
  docker image ls "$repo" --format '{{.Tag}}' |
    grep -vx -e "$tag" -e "${previous:-$tag}" |
    while read -r old; do docker image rm "$repo:$old" > /dev/null; done
  docker image prune -f > /dev/null
  echo "Готово: $tag"
  exit 0
fi

echo "Новая версия не поднялась" >&2
if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then
  echo "Откат на $previous" >&2
  set_tag "$previous"
  docker compose up -d --wait
fi
exit 1
