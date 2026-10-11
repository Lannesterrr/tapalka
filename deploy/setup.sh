#!/usr/bin/env bash
# Первичная настройка чистого сервера (Ubuntu/Debian). Запуск:
#   bash setup.sh https://github.com/<аккаунт>/<репозиторий>.git
set -euo pipefail
REPO="${1:?Укажи ссылку на репозиторий}"

if ! command -v docker >/dev/null; then
  echo "Устанавливаю Docker…"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -d ~/tapalka ]; then
  git clone "$REPO" ~/tapalka
fi
cd ~/tapalka

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Создан файл ~/tapalka/.env — заполни его (nano .env) и запусти скрипт ещё раз."
  exit 0
fi

docker compose up -d --build
echo
echo "Готово! Игра запущена. Админка: https://$(grep ^DOMAIN= .env | cut -d= -f2)/admin"
