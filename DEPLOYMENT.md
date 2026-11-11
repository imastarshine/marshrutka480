# Развёртывание

Серверная часть перенесена в [server/](server/). Основная инструкция:
[server/README.md](server/README.md).

Корневые `index.html` и `js/` — оригинальная офлайн-игра для GitHub Pages.
Для неё можно оставить публикацию корня ветки `main`. Ручной workflow
`.github/workflows/pages.yml` также публикует только исходные `index.html`
и `js/`, без серверной версии и backend.

Сервер отдаёт `web/` и обслуживает `/api/*` и `/ws`.
В production нужен HTTPS, один worker и постоянный диск для SQLite.

Текущее размещение:

- проект: `/opt/marshrutka480`;
- сервер: `/opt/marshrutka480/server`;
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
