# Сетевой протокол v1

Все HTTP URL относительно `API_BASE` (пустая строка = этот же сервер). JSON UTF-8.
Авторизация: `Authorization: Bearer <token>`. Токен хранится клиентом только в памяти.
Ошибка HTTP: `{"detail":"понятный текст"}`. Pydantic 422 также может вернуть массив ошибок.

## HTTP

- `GET /api/health` → `{ok:true,version:"1.0.0",protocol:1}`.
- `POST /api/auth/register`, `POST /api/auth/login`, тело `{username,password}` →
  `{token,expires_at,user:{id,username}}`. Имя 3–24, латиница/кириллица/цифры/`_-`; пароль 10–128 символов.
- `GET /api/auth/me` → `{user:{id,username}}`.
- `POST /api/auth/logout` → `{ok:true}`.
- `GET /api/leaderboard?limit=20` → `{entries:[{rank,username,score,stops,distance,completed_at}],mode:"online"}`.
  Лучший законченный сетевой рейс каждого игрока, рубли; distance в игровых пикселях.
- `GET /api/rooms` → `{rooms:[ROOM]}` (только публичные).
- `POST /api/rooms`, тело `{name:"Вечерний рейс",public:true,max_players:4}` → `{room:ROOM}`.
  Комната создаётся с владельцем-участником. max_players 1–8. Непубличная доступна по коду.
- `POST /api/rooms/CODE/join`, тело `{}` → `{room:ROOM}`.
- `POST /api/rooms/CODE/leave`, тело `{}` → `{ok:true}`.

`ROOM = {code,name,public,max_players,host_id,status,players:[{id,username,connected}],count}`;
status: `waiting|countdown|running|finished`. Новые участники допускаются только waiting/finished.

## WebSocket

`ws(s)://<API host>/ws`, обязательный разрешённый `Origin`.
В течение 5 секунд отправить `{type:"auth",token:"...",room:"ABC234"}`.
Сервер отвечает `{type:"welcome",player_id:1,protocol:1}`. Токен не передаётся в URL.
Один активный сокет на аккаунт. После обрыва можно повторить auth в течение 20 секунд,
чтобы продолжить тот же рейс с теми же данными. Вход через HTTP join повторять не требуется.

Клиент → сервер:

- `{type:"input",seq:1,up:true,down:false,left:false,right:false}` до 30 раз/сек. seq строго возрастает в рамках соединения.
- `{type:"start"}`: владелец запускает смену (можно один), 3 секунды отсчёта; также начинает новый рейс после finished.
- `{type:"ping",t:12345}` → `{type:"pong",t:12345}`. Посылать каждые 10 секунд.
- `{type:"horn"}` → `{type:"horn",player_id:1}` всем, не чаще раза в 2 секунды.
- `{type:"leave"}`: покинуть комнату.

Сервер → клиент:

- `{type:"error",detail:"..."}` — отказ операции; критические нарушения закрывают соединение.
- `{type:"state",room:ROOM,tick:123,time_left:179.3,countdown:0,street:"ул. Ленина",
  players:[PLAYER],npcs:[NPC],stops:[STOP],results:[RESULT],server_time:1234567890}`.

`PLAYER = {id,username,color,x,z,speed,score,stops,distance,connected,invulnerable,boarding,next_stop,street}`.
`next_stop` — целое ID ближайшей ещё не пройденной остановки, `boarding` — прогресс 0..1.
`NPC = {id,x,z,speed,color}`.
`STOP = {id,name,z,waiting,street}`.
`RESULT = {id,username,score,stops,distance,qualified}`; results заполнен при finished.

## Координаты и правила

Холст 640×760. Дорога x=78..522, карман справа до590. x игрока — **центр** автобуса,
z — абсолютное расстояние вперёд в пикселях. Экранная позиция центра y=600-(z-self.z).
Автобус 56×116. NPC 50×92. Справа по ходу, встречка x<300.
Вперёд +z; скорости в px/сек. Верхняя скорость 600px/сек (70км/ч при масштабе оригинала).
Старт x=411, игроки слегка разнесены по z. Руль меняет x; повороты в этом режиме не нужны.
Общие машины, остановки и пассажиры определяются сервером. Столкновение = штраф и замедление,
не конец смены. Контакт автобусов не повреждает игроков (совместный рейс без тарана).
Остановка каждые 1800px, первая z=1000. Для посадки центр x>=535, |z-stop.z|<=90,
скорость<=18px/сек; 1.5 секунды обслуживания. За пассажира 60₽, за остановку +40₽.
Один игрок обслуживает каждую остановку один раз; общий запас пассажиров ограничен.
Пройденные остановки вернуть нельзя. Все игроки равны, улучшения одиночной игры не влияют.
Смена 180 секунд. В рейтинг попадает завершённый рейс с >=1 обслуженной остановкой.
Клиент не отправляет координаты, результаты, время, пассажиров или деньги.
Исчезнувший клиент тормозит после 0.5 секунды без input. Пауза не останавливает общий мир.
Мир и физика20Hz, снимки10Hz. Клиент интерполирует снимки, не рассчитывает зачётные результаты.

Предел входящего WS сообщения 2048 байт, потока60 сообщений/сек; допускается heartbeat.
Закрытия:4001 auth,4003 forbidden,4004 room missing,4008 timeout/rate limit,
4009 duplicate connection,1009 too large,1008 protocol violation.
Комнаты находятся в памяти одного процесса; результаты и аккаунты — в SQLite.
