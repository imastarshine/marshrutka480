# Развёртывание и обслуживание

## 1. Устройство сервера

FastAPI отдаёт `web/` и обслуживает `/api/*` и `/ws`. SQLite хранится вне
`web/`. Аккаунты и лучшие завершённые рейсы переживают перезапуск;
комнаты и текущие смены находятся в памяти.

Используйте `python run.py` или Dockerfile проекта. **Один процесс/worker,
одна реплика.** Несколько workers создадут независимые комнаты. Auto-reload
при каждом изменении файла будет обрывать игру.

Публичному серверу нужны HTTPS, долгоживущие WebSocket и постоянный локальный
диск. Хостинг, который засыпает или стирает файловую систему, прерывает
комнаты либо теряет SQLite. SQLite WAL размещайте на локальном диске,
а не сетевой папке.

## 2. Всё на одном HTTPS-домене

Ниже `game.example.com` — пример: замените его своим доменом.

1. Направьте DNS домена на сервер, разрешите входящие TCP 80 и 443.
2. Скопируйте проект и создайте `.env` из `.env.example`.
3. Укажите:

```dotenv
M480_ENV=production
M480_DATABASE=data/marshrutka.sqlite3
M480_ORIGINS=https://game.example.com
M480_HOSTS=game.example.com,localhost,127.0.0.1
M480_BIND=127.0.0.1
M480_PORT=8000
```

4. Оставьте `API_BASE: ""` в `web/config/runtime.js`.
5. Запустите `docker compose up -d --build`.
6. Установите Caddy на **хостовую ОС** официальным способом и используйте
   `deploy/Caddyfile`, заменив домен. Он принимает HTTPS и проксирует
   HTTP/WebSocket на `127.0.0.1:8000`.
7. Проверьте `https://game.example.com/api/health`, затем откройте игру
   с двух устройств, зарегистрируйтесь и запустите общий рейс.

Caddyfile рассчитан на Caddy 2 с поддержкой `request_body max_size`.
Для nginx есть `deploy/nginx.conf.example`: он требует уже выпущенных
сертификатов и содержит ограничения частоты для входа и API.
Перед перезагрузкой проверяйте конфигурацию proxy его штатной командой.

### Реальный IP и ограничения запросов

Приложение ограничивает запросы по адресу от ASGI-сервера. Нельзя безусловно
доверять клиентскому `X-Forwarded-For`: это позволит обойти лимиты.
`run.py` принимает proxy-заголовки только от явно указанных IP:

- Python и Caddy/nginx на одной ОС: `python run.py --proxy-ips 127.0.0.1`.
- Compose использует bridge-сеть `172.29.48.0/24` и доверяет только шлюзу
  `172.29.48.1`, через который приходит хостовый proxy. Порт приложения
  опубликован только на `127.0.0.1`.
- При изменении сети Docker поменяйте **subnet, gateway и M480_PROXY_IPS**
  в `compose.yaml`. Подсеть не должна пересекаться с сетью сервера.

`run.py` отклоняет `*`, CIDR и неверные IP. Без настройки доверенного proxy
все его посетители попадут под один общий лимит. При добавлении CDN отдельно
настройте доверие к нему и получение реального IP на proxy; не принимайте
произвольные заголовки от клиента.

### Контейнер и данные

Контейнер работает с UID/GID 10001 без root, файловая система read-only,
база — в именованном томе `game-data`, временные файлы — в `/tmp`.
При первом создании Docker переносит права `/app/data` в volume.
Подключая ранее созданный том, заранее дайте UID 10001 право записи
именно в этот каталог.

Compose принудительно задаёт `M480_DATABASE=/app/data/marshrutka.sqlite3`.
Локальный `data/` и Docker volume — разные места. `docker compose down`
сохраняет базу; `docker compose down -v` удаляет том с данными.
Не открывайте порт 8000 наружу при указанной конфигурации.

## 3. GitHub Pages + отдельный сервер

Адрес `https://imastarshine.github.io/marshrutka480/` можно сохранить.
Pages публикует **только `web/`**; backend, SQLite и `.env` туда не копируются.

1. Разверните FastAPI, например на `https://game.example.com`.
2. В `web/config/runtime.js` укажите:

```javascript
window.MARSHRUTKA_CONFIG = Object.freeze({
    API_BASE: "https://game.example.com"
});
```

3. Разрешите оба точных Origin на сервере:

```dotenv
M480_ENV=production
M480_ORIGINS=https://game.example.com,https://imastarshine.github.io
M480_HOSTS=game.example.com,localhost,127.0.0.1
```

Origin — схема, хост и при необходимости порт. **В нём нет**
`/marshrutka480/`, завершающего `/`, `*` или отдельного `wss://`:
Origin WebSocket — адрес страницы `https://imastarshine.github.io`.
`API_BASE` — адрес backend без `/api`.

4. Перезапустите backend: `docker compose up -d --force-recreate`.
5. Закоммитьте проект в свой репозиторий. В **Settings → Pages** выберите
   **GitHub Actions**. В **Actions → Publish frontend to GitHub Pages**
   вручную запустите workflow: он публикует только `web/`.

Альтернатива — ветка публикации с содержимым `web/` в корне.
Не выбирайте корень всего проекта для публикации из ветки.

Запросы идут на HTTPS API, соединение игры — на WSS. Авторизация работает
без cookie, включая сторонние. Токен остаётся в памяти вкладки; после
перезагрузки нужно войти. При недоступном backend одиночная игра работает,
а сетевые функции показывают ошибку связи.

Если frontend отдаёт сам FastAPI, его CSP рассчитан на same-origin API.
Для разделения доменов используйте описанный статический frontend на Pages;
не расширяйте CSP универсальными wildcard-источниками.

## 4. Без Docker под systemd

1. Разместите проект в `/opt/marshrutka480`; создайте системного пользователя
   `marshrutka` без интерактивного входа.
2. Создайте `.venv`, установите `requirements.txt`.
3. Создайте `/opt/marshrutka480/data` **до** запуска службы. Владелец —
   `marshrutka`, режим каталога — `0700`.
4. Создайте production `.env`, читаемый пользователем `marshrutka`, например
   `root:marshrutka` и `0640`. `run.py` тоже читает этот файл.
5. Установите `deploy/marshrutka.service` в каталог unit-файлов systemd,
   выполните `systemctl daemon-reload`, включите и запустите службу.
6. На той же ОС поставьте Caddy/nginx с proxy на `127.0.0.1:8000`.

Unit ограничивает запись каталогом `data/` и доверяет proxy `127.0.0.1`.
Меняя пути, обновите `WorkingDirectory`, `EnvironmentFile`, `ExecStart`,
`ReadWritePaths` и `M480_DATABASE` согласованно.

## 5. Резервная копия

SQLite Backup API согласованно читает и активную базу с WAL:

```bash
python scripts/backup.py data/marshrutka.sqlite3
```

Скрипт создаёт новый файл в `backups/`, проверяет `PRAGMA integrity_check`
и не перезаписывает существующий файл. Бэкап содержит хеши паролей и
аккаунты: держите его приватным, вне `web/`, отдельно от сервера.

В минимальный Docker image скрипт не включён. Для Compose:

```bash
docker compose exec game python -c 'import sqlite3; s=sqlite3.connect("/app/data/marshrutka.sqlite3"); d=sqlite3.connect("/app/data/backup.sqlite3"); s.backup(d); d.close(); s.close()'
docker compose cp game:/app/data/backup.sqlite3 ./backup.sqlite3
```

Короткая команда обновляет `backup.sqlite3`; для истории меняйте имя файла.
Для восстановления остановите приложение, поместите резервную копию в
нужный каталог базы и выставьте права владельца процесса. Восстанавливайте
в чистый каталог без старых `-wal`/`-shm`, затем запускайте сервер.

## 6. Обновление и диагностика

Перед обновлением сделайте backup и предупредите игроков: комнаты закроются.
Обновление: `docker compose up -d --build`. Сохранённый volume останется.

| Симптом | Что проверить |
|---|---|
| «Источник запроса запрещён», WS 403 | Точный Origin страницы в `M480_ORIGINS`, без пути и завершающего `/` |
| HTTP 400 Invalid host header | Домен backend в `M480_HOSTS`; 127.0.0.1 нужен для healthcheck |
| Страница есть, WebSocket нет | WSS, сертификат, Upgrade/Connection в nginx, поддержка WS хостингом |
| Все получают 429 | Доверенный IP proxy и реальные IP клиентов; не ставьте wildcard |
| Исчезли аккаунты после обновления | Путь к SQLite и постоянный том; ephemeral disk не подходит |
| Комнаты видны через раз | Один worker и одна реплика |
| После обновления вкладки нужен вход | Ожидаемо: токен не сохраняется |
| «Аккаунт уже подключён» | В другом игровом окне открыт тот же аккаунт |
| Не создаётся новая комната после reload | Войдите в прежнюю по коду или подождите 20 секунд очистки членства |
| Контейнер не пишет SQLite | Права UID 10001 на /app/data и свободное место |

Библиотеки закреплены в `requirements.txt`. Обновляйте их с повторным
запуском тестов. Реальная нагрузка, мобильная сеть, TLS и конкретный proxy
проверяются на месте развёртывания. Конфиги входят в проект; публичная
инфраструктура автоматически не создаётся.

## Источники

- [GitHub: ограничения Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [FastAPI: WebSocket и менеджер в памяти](https://fastapi.tiangolo.com/advanced/websockets/)
- [nginx: WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)
- [Caddy: reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [Caddy: ограничение тела](https://caddyserver.com/docs/caddyfile/directives/request_body)
- [SQLite: Backup API](https://www.sqlite.org/backup.html)
