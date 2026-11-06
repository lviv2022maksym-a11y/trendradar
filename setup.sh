#!/usr/bin/env bash
# TrendRadar Trader — встановлення або оновлення на сервері (Ubuntu 22.04 / 24.04).
#
#   sudo apt-get update && sudo apt-get install -y git
#   git clone https://github.com/ВАШ-ЛОГІН/trendradar.git
#   sudo bash trendradar/deploy/setup.sh
#
# Повторний запуск безпечний: ключі зберігаються, оновлюється код і перезапускається служба.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Запустіть через sudo: sudo bash $0"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/trendradar
DATA=/var/lib/trendradar
ENV_FILE=/etc/trendradar.env

echo "▶ Встановлюю системні пакети…"
apt-get update -y -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 python3-venv python3-pip ufw >/dev/null

echo "▶ Створюю службового користувача і папки…"
id trendradar >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin trendradar
mkdir -p "$DATA"
if [ "$SRC" != "$APP" ]; then
  rm -rf "$APP.new" && cp -a "$SRC" "$APP.new" && rm -rf "$APP" && mv "$APP.new" "$APP"
fi
chown -R root:root "$APP" && chown -R trendradar:trendradar "$DATA"

echo "▶ Встановлюю Python-бібліотеки…"
python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q requests pandas numpy

if [ ! -f "$ENV_FILE" ]; then
  echo
  echo "▶ Ключі (вводяться один раз і зберігаються лише на цьому сервері, у $ENV_FILE)"
  echo "  Alpaca → Paper Trading → API Keys. Секретні значення під час введення не видно — це нормально."
  read -rp  "  Alpaca API Key ID: " K
  read -rsp "  Alpaca Secret Key: " S; echo
  read -rsp "  Telegram токен бота (від @BotFather): " TT; echo
  read -rp  "  Telegram CHAT_ID: " CID
  umask 077
  cat > "$ENV_FILE" <<CONF
ALPACA_KEY_ID=$K
ALPACA_SECRET_KEY=$S
TELEGRAM_TOKEN=$TT
TELEGRAM_CHAT_ID=$CID
# Справжні гроші: 1 — лише разом із "paper": false у config.json. Інакше завжди тестовий рахунок.
TRADER_LIVE=0
TRADER_STATE=$DATA/trader_state.json
CONF
  chmod 600 "$ENV_FILE"
fi

echo "▶ Запускаю службу…"
cp "$APP/deploy/trendradar-trader.service" /etc/systemd/system/trendradar-trader.service
systemctl daemon-reload
systemctl enable trendradar-trader >/dev/null 2>&1
systemctl restart trendradar-trader

echo "▶ Захищаю сервер (дозволено лише SSH)…"
ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null

sleep 3
systemctl --no-pager --lines=8 status trendradar-trader || true
echo
echo "✅ Готово. У Telegram має прийти «TrendRadar Trader запущено». Команди: /help"
echo "   Журнал роботи:  sudo journalctl -u trendradar-trader -f"
echo "   Оновити:        cd ~/trendradar && git pull && sudo bash deploy/setup.sh"
echo "   Зупинити:       sudo systemctl stop trendradar-trader"
