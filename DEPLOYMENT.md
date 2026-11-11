# Развёртывание

Серверная часть перенесена в [server/](server/). Основная инструкция:
[server/README.md](server/README.md).

Корневые `index.html` и `js/` — офлайн-игра для GitHub Pages с той же географией.
Для неё можно оставить публикацию корня ветки `main`. Ручной workflow
`.github/workflows/pages.yml` также публикует только исходные `index.html`
и `js/`, без серверной версии и backend.

Сервер отдаёт `web/` и обслуживает `/api/*` и `/ws`.
В production нужен HTTPS, один worker и постоянный диск для SQLite.

Текущее размещение:

- проект: `/opt/marshrutka480`;
- активная сборка: `/opt/marshrutka-current` (символическая ссылка);
- сборки: `/opt/marshrutka-releases/`;
- сервер: `/opt/marshrutka-current/server`;
- настройки: `server/.env`;
- база: `server/data/marshrutka.sqlite3`;
- служба: `marshrutka.service`;
- nginx: `/etc/nginx/sites-available/marshrutka480`;
- Certbot: `/opt/certbot/bin/certbot`, таймер `certbot-renew.timer`;
- адреса: https://185.17.0.90 и https://marshrutka480.185-17-0-90.sslip.io.

При обновлении резервная копия и перенос базы выполняются до переключения
службы. Новая версия не читает старые каталоги `backend/` и `data/` в
корне проекта. Перезапуск закрывает комнаты, но сохраняет аккаунты.

```bash
systemctl status marshrutka nginx
journalctl -u marshrutka -n 100 --no-pager
systemctl restart marshrutka
certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
```

## Автообновление на VPS

Установлены только на сервере, вне репозитория:

- `/usr/local/sbin/marshrutka-update`;
- `marshrutka-update.service` и `marshrutka-update.timer`;
- override службы игры `/etc/systemd/system/marshrutka.service.d/release.conf`.

Таймер каждые 15 секунд проверяет `main` репозитория
`imastarshine/marshrutka480`. Новая версия распаковывается в отдельную папку,
получает своё окружение Python и проходит серверные тесты. Перед переключением
делается согласованная резервная копия SQLite в
`/var/lib/marshrutka-updater/backups/`. Настройки и рабочая база остаются
в `/opt/marshrutka480/server/`, исходный checkout не перезаписывается.

После атомарного переключения ссылки игра перезапускается и проверяются
HTTP health и статические файлы. При ошибке восстанавливается предыдущая
сборка; повторная попытка для той же неудачной версии — через пять минут.
Обновление закрывает текущие сетевые комнаты. Хранятся последние сборки
и предыдущая рабочая версия; резервные копии базы сохраняются отдельно.

```bash
systemctl status marshrutka-update.timer
journalctl -u marshrutka-update.service -n 100 --no-pager
cat /var/lib/marshrutka-updater/last-success.json
# Повторить проверку вручную, включая версию после ошибки:
/usr/local/sbin/marshrutka-update --retry
```

Скрипт автообновления и доступы SSH в Git не входят.
