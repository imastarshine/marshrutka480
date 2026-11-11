// Иркутск: фактические названия и связная игровая схема, не навигационная карта.
// Источники и ограничения масштаба: docs/IRKUTSK_SOURCES.md.
"use strict";

const IRKUTSK_CITY = (() => {
    const nodes = [], edges = [];
    const node = (id, x, y, name) => nodes.push({ id, x, y, name });
    const edge = (id, from, to, street, lanes = 4, district = "center") =>
        edges.push({ id, from, to, street, lanes, district });
    // XY — игровые пиксели. Короткие реальные кварталы растянуты для посадки
    // пассажиров, близкие примыкания одной развязки объединены в один узел.
    [
        ["airport", 30000, 0, "Аэропорт"],
        ["soviet_shiryamov", 26000, 0, "Советская / Ширямова"],
        ["soviet_liebknecht", 18000, 0, "Советская / Карла Либкнехта"],
        ["soviet_baikal", 12000, 0, "Советская / Байкальская"],
        ["baikal_perovskoy", 8000, 0, "Байкальская / Софьи Перовской"],
        ["perovskoy_bortsov", 8000, -3000, "Софьи Перовской / Борцов Революции"],
        ["bortsov_timiryazev", 5500, -3000, "Борцов Революции / Тимирязева"],
        ["timiryazev_lenin", 2500, -3000, "Тимирязева / Ленина"],
        ["lenin_dzerzhinsky", 2500, -6000, "Ленина / Дзержинского"],
        ["lenin_sukhbaatar", 2500, -10000, "Ленина / Сухэ-Батора"],
        ["sukhbaatar_chkalov", 0, -13000, "Площадь графа Сперанского"],
        ["chkalov_razin", -3500, -13000, "Чкалова / Степана Разина"],
        ["bridge_east", -3500, -16000, "Правый берег Ангары"],
        ["bridge_west", -8500, -16000, "Левый берег Ангары"],
        ["dzhambul_botkin", -8500, -12000, "Джамбула / Боткина"],
        ["botkin_railway", -11500, -12000, "Боткина / 2-я Железнодорожная"],
        ["railway_lermontov", -11500, -6000, "2-я Железнодорожная / Лермонтова"],
        ["lermontov_zhukovsky", -11500, -2500, "Лермонтова / Жуковского"],
        ["lermontov_academic", -11500, 6500, "Лермонтова / Академическая"],
        ["lermontov_ulan", -11500, 9500, "Лермонтова / Улан-Баторская"],
        ["ulan_university", -15000, 9500, "Университетский микрорайон"],
        ["university_bypass", -18500, 9500, "Школа №55"],
        ["bypass_sergeev", -22000, 9500, "Объездная / Сергеева"],
        ["sergeev_argunov", -22000, 13000, "Сергеева / Аргунова"],
        ["argunov_sergeev", -25500, 13000, "Мельниковский рынок"],
        ["sergeev_ryabikov", -25500, 16500, "Сергеева / бульвар Рябикова"],
        ["ryabikov_konev", -25500, 20000, "Бульвар Рябикова / Маршала Конева"],
        ["konev_kultuk", -29000, 20000, "Маршала Конева / Култукский тракт"],
        ["lugovoe_entry", -32500, 20000, "Поворот в Луговое"],
        ["lugovoe_hospital", -32500, 24000, "Луговое: больница"],
        ["lugovoe_end", -35500, 24000, "Луговое: конечная"],
        // Обратное движение через Гоголя и Маяковского.
        ["zhukovsky_gogol", -15500, -2500, "Жуковского / Гоголя"],
        ["gogol_schmidt", -15500, -6000, "Гоголя / Шмидта"],
        ["gogol_mayakovsky", -15500, -10000, "Гоголя / Маяковского"],
        ["railway_mayakovsky", -11500, -10000, "2-я Железнодорожная / Маяковского"],
        // Восточное направление из центра.
        ["dzerzhinsky_liebknecht", 8500, -6000, "Дзержинского / Карла Либкнехта"],
        // Ветка к ж/д вокзалу (80).
        ["schmidt_profsouznaya", -19500, -6000, "Шмидта / Профсоюзная"],
        ["profsouznaya_chelnokov", -19500, -11000, "Профсоюзная / Челнокова"],
        // Юбилейный, Сеченова, Академическая (80).
        ["regional_hospital", -1000, 26000, "Областная больница"],
        ["yubileyny_sechenov", -1000, 21000, "Юбилейный / Сеченова"],
        ["sechenov_academic", -1000, 17000, "Сеченова / Академическая"],
        ["academic_lermontov", -6500, 17000, "Академическая / Лермонтова"],
        // Восточное полукольцо 80.
        ["piskunov_shiryamov", 35000, 4500, "Пискунова / Ширямова"],
        ["shiryamov_baikal", 35000, 10500, "Ширямова / Байкальская"],
        ["baikal_east", 26000, 10500, "Байкальский микрорайон"],
        ["baikal_volzhskaya", 19000, 6500, "Байкальская / Волжская"],
        // Северное направление 33.
        ["irkut_south", -13500, -17500, "Иркутный мост: южный берег"],
        ["irkut_north", -13500, -22000, "Иркутный мост: северный берег"],
        ["traktovaya_rosalux", -13500, -31000, "Трактовая / Розы Люксембург"],
        ["rosalux_shkolnaya", -18500, -31000, "Розы Люксембург / Школьная"],
        ["rosalux_podstantsia", -25500, -31000, "Подстанция Ново-Ленино"],
        ["rosalux_moscow", -33500, -31000, "Розы Люксембург / Московский тракт"],
        ["moscow_batareynaya", -38500, -31000, "Поворот на Батарейную"],
        ["batareynaya", -38500, -38000, "Батарейная"],
        // Выезд 33 от рынка через Литвинова, Тимирязева, Богдана Хмельницкого.
        ["market_33", 8500, -11000, "Центральный рынок"],
        ["litvinov_timiryazev", 5500, -11000, "Литвинова / Тимирязева"],
        ["timiryazev_bogdan", 7500, -11000, "Тимирязева / Богдана Хмельницкого"],
        ["bogdan_marx", 7500, -15000, "Богдана Хмельницкого / Карла Маркса"],
        ["marx_sukhbaatar", 2500, -15000, "Карла Маркса / Сухэ-Батора"],
    ].forEach((n) => node(...n));

    [
        ["shiryamov_airport", "airport", "soviet_shiryamov", "ул. Ширямова", 4, "industrial"],
        ["soviet_east", "soviet_shiryamov", "soviet_liebknecht", "ул. Советская", 4, "khrush"],
        ["soviet_west", "soviet_liebknecht", "soviet_baikal", "ул. Советская", 4],
        ["baikal_center", "soviet_baikal", "baikal_perovskoy", "ул. Байкальская", 4],
        ["perovskoy", "baikal_perovskoy", "perovskoy_bortsov", "ул. Софьи Перовской", 2, "market"],
        ["bortsov", "perovskoy_bortsov", "bortsov_timiryazev", "ул. Борцов Революции", 2, "market"],
        ["timiryazev_center", "bortsov_timiryazev", "timiryazev_lenin", "ул. Тимирязева", 4, "old"],
        ["lenin_south", "timiryazev_lenin", "lenin_dzerzhinsky", "ул. Ленина", 4],
        ["lenin_center", "lenin_dzerzhinsky", "lenin_sukhbaatar", "ул. Ленина", 4],
        ["sukhbaatar_square", "lenin_sukhbaatar", "sukhbaatar_chkalov", "ул. Сухэ-Батора", 4],
        ["chkalov", "sukhbaatar_chkalov", "chkalov_razin", "ул. Чкалова", 4],
        ["razin", "chkalov_razin", "bridge_east", "ул. Степана Разина", 4],
        ["glazkov_bridge", "bridge_east", "bridge_west", "Глазковский мост", 4, "river"],
        ["dzhambul", "bridge_west", "dzhambul_botkin", "ул. Джамбула", 4, "old"],
        ["botkin", "dzhambul_botkin", "botkin_railway", "ул. Боткина", 4, "park"],
        ["railway_north", "botkin_railway", "railway_mayakovsky", "ул. 2-я Железнодорожная", 4, "old"],
        ["railway_south", "railway_mayakovsky", "railway_lermontov", "ул. 2-я Железнодорожная", 4, "old"],
        ["lermontov_north", "railway_lermontov", "lermontov_zhukovsky", "ул. Лермонтова", 4, "khrush"],
        ["lermontov_campus", "lermontov_zhukovsky", "lermontov_academic", "ул. Лермонтова", 4, "khrush"],
        ["lermontov_ulan", "lermontov_academic", "lermontov_ulan", "ул. Лермонтова", 4, "park"],
        ["ulan_batorskaya", "lermontov_ulan", "ulan_university", "ул. Улан-Баторская", 4, "khrush"],
        ["university", "ulan_university", "university_bypass", "Университетский микрорайон", 2, "khrush"],
        ["bypass", "university_bypass", "bypass_sergeev", "Объездная Первомайский — Университетский", 4, "park"],
        ["sergeev_north", "bypass_sergeev", "sergeev_argunov", "ул. Сергеева", 4, "industrial"],
        ["argunov", "sergeev_argunov", "argunov_sergeev", "ул. Аргунова", 2, "industrial"],
        ["sergeev_south", "argunov_sergeev", "sergeev_ryabikov", "ул. Сергеева", 4, "industrial"],
        ["ryabikov", "sergeev_ryabikov", "ryabikov_konev", "б-р Рябикова", 4, "khrush"],
        ["konev", "ryabikov_konev", "konev_kultuk", "ул. Маршала Конева", 4, "khrush"],
        ["kultuk", "konev_kultuk", "lugovoe_entry", "Култукский тракт", 4, "outskirts"],
        ["lugovoe", "lugovoe_entry", "lugovoe_hospital", "дорога в Луговое", 2, "private"],
        ["lugovoe_terminal", "lugovoe_hospital", "lugovoe_end", "Луговое", 2, "private"],
        ["zhukovsky", "lermontov_zhukovsky", "zhukovsky_gogol", "ул. Жуковского", 2, "old"],
        ["gogol_south", "zhukovsky_gogol", "gogol_schmidt", "ул. Гоголя", 4, "old"],
        ["gogol_north", "gogol_schmidt", "gogol_mayakovsky", "ул. Гоголя", 4, "old"],
        ["mayakovsky_west", "gogol_mayakovsky", "railway_mayakovsky", "ул. Маяковского", 4, "old"],
        ["mayakovsky_east", "railway_mayakovsky", "bridge_west", "ул. Маяковского", 4, "old"],
        ["university_return", "university_bypass", "lermontov_academic", "Объездная Первомайский — Университетский", 4, "khrush"],
        ["dzerzhinsky", "lenin_dzerzhinsky", "dzerzhinsky_liebknecht", "ул. Дзержинского", 4, "market"],
        ["liebknecht", "dzerzhinsky_liebknecht", "soviet_liebknecht", "ул. Карла Либкнехта", 4, "old"],
        ["lenin_square_return", "sukhbaatar_chkalov", "lenin_sukhbaatar", "ул. Ленина", 4],
        ["schmidt", "gogol_schmidt", "schmidt_profsouznaya", "ул. Шмидта", 2, "old"],
        ["profsouznaya", "schmidt_profsouznaya", "profsouznaya_chelnokov", "ул. Профсоюзная", 2, "old"],
        ["chelnokov", "profsouznaya_chelnokov", "bridge_west", "ул. Челнокова", 4, "old"],
        ["yubileyny", "regional_hospital", "yubileyny_sechenov", "Юбилейный микрорайон", 2, "khrush"],
        ["sechenov", "yubileyny_sechenov", "sechenov_academic", "ул. Сеченова", 4, "khrush"],
        ["academic", "sechenov_academic", "academic_lermontov", "ул. Академическая", 4, "khrush"],
        ["lermontov_academgorodok", "academic_lermontov", "lermontov_academic", "ул. Лермонтова", 4, "park"],
        ["piskunov", "airport", "piskunov_shiryamov", "ул. Пискунова", 4, "khrush"],
        ["shiryamov_south", "piskunov_shiryamov", "shiryamov_baikal", "ул. Ширямова", 4, "industrial"],
        ["baikal_relay", "shiryamov_baikal", "baikal_east", "ул. Байкальская", 4, "industrial"],
        ["baikal_lisikha", "baikal_east", "baikal_volzhskaya", "ул. Байкальская", 4, "khrush"],
        ["baikal_west", "baikal_volzhskaya", "soviet_baikal", "ул. Байкальская", 4, "center"],
        ["dzhambul_irkut", "dzhambul_botkin", "irkut_south", "ул. Джамбула", 4, "old"],
        ["irkut_bridge", "irkut_south", "irkut_north", "Иркутный мост", 4, "river"],
        ["traktovaya", "irkut_north", "traktovaya_rosalux", "ул. Трактовая", 4, "industrial"],
        ["rosalux_east", "traktovaya_rosalux", "rosalux_shkolnaya", "ул. Розы Люксембург", 4, "khrush"],
        ["rosalux_center", "rosalux_shkolnaya", "rosalux_podstantsia", "ул. Розы Люксембург", 4, "khrush"],
        ["rosalux_west", "rosalux_podstantsia", "rosalux_moscow", "ул. Розы Люксембург", 4, "khrush"],
        ["moscow", "rosalux_moscow", "moscow_batareynaya", "Московский тракт", 4, "outskirts"],
        ["batareynaya_road", "moscow_batareynaya", "batareynaya", "Центральная ул. (Батарейная)", 2, "private"],
        ["market_litvinov", "market_33", "litvinov_timiryazev", "ул. Литвинова", 2, "market"],
        ["timiryazev_33", "litvinov_timiryazev", "timiryazev_bogdan", "ул. Тимирязева", 4, "market"],
        ["bogdan", "timiryazev_bogdan", "bogdan_marx", "ул. Богдана Хмельницкого", 2, "old"],
        ["marx", "bogdan_marx", "marx_sukhbaatar", "ул. Карла Маркса", 4, "old"],
        ["sukhbaatar_33", "marx_sukhbaatar", "lenin_sukhbaatar", "ул. Сухэ-Батора", 4],
        ["market_dzerzhinsky", "lenin_dzerzhinsky", "market_33", "ул. Дзержинского", 4, "market"],
    ].forEach((e) => edge(...e));

    const forward = (...ids) => ids.map((id) => ({ edge: id, reverse: false }));
    const backward = (...ids) => ids.map((id) => ({ edge: id, reverse: true }));
    // Отступы остановок заданы по игровой длине улицы, не GPS-координатами.
    const stops = (edgeId, names, reverse = false) => names.map((name, i) => ({
        name, edge: edgeId, at: reverse ? 0.85 - i * 0.7 / Math.max(1, names.length - 1)
            : 0.15 + i * 0.7 / Math.max(1, names.length - 1), reverse,
    }));
    const centerWest = forward("baikal_center", "perovskoy", "bortsov", "timiryazev_center",
        "lenin_south", "lenin_center", "sukhbaatar_square", "chkalov", "razin", "glazkov_bridge",
        "dzhambul", "botkin", "railway_north", "railway_south", "lermontov_north", "lermontov_campus");
    const campusStops = [
        ...stops("railway_north", ["2-я Железнодорожная"]),
        ...stops("railway_south", ["Свердловский рынок"]),
        ...stops("lermontov_north", ["Шмидта"]),
        ...stops("lermontov_campus", ["Жуковского", "Технический университет", "Институт МВД"]),
    ];
    const westStops = [
        ...stops("baikal_center", ["Театр кукол"]),
        ...stops("perovskoy", ["Центральный рынок"]),
        ...stops("lenin_south", ["Ленина"]),
        ...stops("lenin_center", ["Художественный музей"]),
        ...stops("sukhbaatar_square", ["Площадь графа Сперанского"]),
        ...stops("chkalov", ["Чкалова"]),
        ...stops("dzhambul", ["Джамбула"]),
        ...stops("botkin", ["Курорт Ангара"]), ...campusStops,
    ];
    const suburban = forward("lermontov_ulan", "ulan_batorskaya", "university", "bypass", "sergeev_north",
        "argunov", "sergeev_south", "ryabikov", "konev", "kultuk", "lugovoe", "lugovoe_terminal");
    const suburbanStops = [
        ...stops("lermontov_ulan", ["Госуниверситет"]),
        ...stops("ulan_batorskaya", ["Юридический институт", "Гуманитарный центр"]),
        ...stops("university", ["Университетский микрорайон", "Школа №55"]),
        ...stops("bypass", ["Ботанический Сад", "Ново-Мельниково"]),
        ...stops("sergeev_north", ["Торговый центр", "Южная проходная"]),
        ...stops("argunov", ["Мельниковский рынок"]),
        ...stops("sergeev_south", ["Радиозавод"]),
        ...stops("ryabikov", ["Бульвар Рябикова", "Школа №28"]),
        ...stops("konev", ["Маршала Конева"]),
        ...stops("lugovoe", ["Луговое", "Больница"]), ...stops("lugovoe_terminal", ["Луговое"]),
    ];
    const airportStops = [
        ...stops("shiryamov_airport", ["Аэропорт", "Жигулёвская"]),
        ...stops("soviet_east", ["Университет ГА", "Ипподром", "Городок ИВАТУ", "Школа №23", "Омулевского", "Усадьба Сукачёва"]),
        ...stops("soviet_west", ["Эталон"]),
    ];
    const eastCenter = [
        ...backward("glazkov_bridge", "razin", "chkalov"), ...forward("lenin_square_return"),
        ...backward("lenin_center"), ...forward("dzerzhinsky", "liebknecht"),
        ...backward("soviet_east", "shiryamov_airport"),
    ];
    const eastStops = [
        ...stops("chkalov", ["Чкалова"], true), ...stops("lenin_square_return", ["Сквер им. Кирова"]),
        ...stops("lenin_center", ["Художественный музей", "Филармония"], true),
        ...stops("dzerzhinsky", ["Центральный рынок", "Центральный рынок", "Тимирязева"]),
        ...stops("liebknecht", ["Карла Либкнехта", "пл. Декабристов"]),
        ...stops("soviet_east", ["1-я Советская", "Омулевского", "Школа №23", "Городок ИВАТУ", "Ипподром", "Университет ГА"], true),
        ...stops("shiryamov_airport", ["Жигулёвская", "Аэропорт"], true),
    ];
    const hospitalOut = [
        ...forward("yubileyny", "sechenov", "academic", "lermontov_academgorodok"),
        ...backward("lermontov_campus"),
        ...forward("zhukovsky", "gogol_south", "schmidt", "profsouznaya", "chelnokov"),
    ];
    const hospitalOutStops = [
        ...stops("yubileyny", ["Областная больница", "Юбилейный микрорайон", "Школа №4"]),
        ...stops("sechenov", ["Подстанция", "Библиотека им. Е.А. Евтушенко"]),
        ...stops("academic", ["Дом кино", "Южная", "пос. Энергетиков"]),
        ...stops("lermontov_academgorodok", ["Институт микрохирургии глаза", "Академгородок", "Больница Академгородка"]),
        ...stops("lermontov_campus", ["Госуниверситет", "Институт МВД", "Технический университет", "Жуковского"], true),
        ...stops("gogol_south", ["Педучилище"]), ...stops("profsouznaya", ["Ж/д Вокзал"]),
        ...stops("chelnokov", ["Челнокова"]),
    ];
    const north33 = forward("dzhambul_irkut", "irkut_bridge", "traktovaya", "rosalux_east",
        "rosalux_center", "rosalux_west", "moscow", "batareynaya_road");
    const north33Stops = [
        ...stops("irkut_bridge", ["Иркутный мост"]),
        ...stops("traktovaya", ["Кировская 3-я", "ДОК", "Военный Городок", "Бакалея", "Трактовая"]),
        ...stops("rosalux_east", ["Узловая", "Норильская", "Роща"]),
        ...stops("rosalux_center", ["Школьная", "Кинотеатр Восток", "Пионерская", "Кинотехникум"]),
        ...stops("rosalux_west", ["Подстанция", "Магазин Спутник", "Автостанция", "6-й микрорайон"]),
        ...stops("moscow", ["Контейнерная"]), ...stops("batareynaya_road", ["Виадук", "Батарейная"]),
    ];
    const reverseSpecs = (path) => [...path].reverse().map((s) => ({ edge: s.edge, reverse: !s.reverse }));
    const reverseStops = (items) => [...items].reverse().map((s) => ({ ...s, reverse: !s.reverse }));
    return { city: "Иркутск", checked: "2026-11-11", schematic: true, nodes, edges, routes: {
        "480": {
            title: "Аэропорт — Луговое", termini: ["Аэропорт", "Луговое"],
            source: "https://2gis.ru/irkutsk/route/1548717962297568",
            path: [...forward("shiryamov_airport", "soviet_east", "soviet_west"), ...centerWest, ...suburban],
            stops: [...airportStops, ...westStops, ...suburbanStops],
            returnPath: [
                ...reverseSpecs(suburban.slice(3)), ...forward("university_return"),
                ...backward("lermontov_campus"), ...forward("zhukovsky", "gogol_south", "gogol_north", "mayakovsky_west", "mayakovsky_east"),
                ...eastCenter,
            ],
            returnStops: [
                ...stops("lugovoe_terminal", ["Луговое"], true),
                ...stops("lugovoe", ["Больница", "Луговое"], true),
                ...stops("konev", ["Инфекционная больница"], true),
                ...stops("ryabikov", ["Школа №28", "Бульвар Рябикова"], true),
                ...stops("argunov", ["Мельниковский рынок"], true),
                ...stops("sergeev_north", ["Берёзовая роща"], true),
                ...stops("bypass", ["Ново-Мельниково", "Ботанический Сад"], true),
                ...stops("university_return", ["Школа №55", "Университетский микрорайон", "Юрия Тена (по требованию)"]),
                ...stops("lermontov_campus", ["Институт МВД", "Технический университет", "Жуковского"], true),
                ...stops("gogol_south", ["Педучилище", "Свердловский рынок"]),
                ...stops("gogol_north", ["Гоголя"]), ...stops("mayakovsky_east", ["ул. Маяковского"]), ...eastStops,
            ],
        },
        "80": {
            title: "Областная больница — Областная больница", loop: true,
            termini: ["Областная больница", "Областная больница"],
            source: "https://2gis.ru/irkutsk/route/1548717962297499",
            path: [...hospitalOut, ...eastCenter, ...forward("piskunov", "shiryamov_south", "baikal_relay", "baikal_lisikha", "baikal_west"),
                ...centerWest, ...backward("lermontov_academgorodok", "academic", "sechenov", "yubileyny")],
            stops: [...hospitalOutStops, ...eastStops.filter((s) => !(s.edge === "dzerzhinsky" && s.name === "Центральный рынок" && s.at > 0.15)),
                ...stops("piskunov", ["Пискунова", "Парк Патриот"]),
                ...stops("baikal_relay", ["Релейный завод", "Байкальский микрорайон", "Релейный завод", "Байкальский микрорайон"]),
                ...stops("baikal_lisikha", ["Лисиха", "Цимлянская", "Волжская"]),
                ...stops("baikal_west", ["Диагностический центр", "Трилиссера"]), ...westStops,
                ...stops("lermontov_academgorodok", ["Госуниверситет", "Больница Академгородка", "Академгородок", "Институт микрохирургии глаза", "Троллейбусное депо"], true),
                ...stops("academic", ["пос. Энергетиков", "Южная", "Дом кино"], true),
                ...stops("sechenov", ["Библиотека им. Е.А. Евтушенко", "Подстанция"], true),
                ...stops("yubileyny", ["Школа №4", "Юбилейный микрорайон", "Областная больница"], true),
            ],
        },
        "33": {
            title: "Центральный рынок — Батарейная", termini: ["Центральный рынок", "Батарейная"],
            source: "https://2gis.ru/irkutsk/route/1548717962297455",
            path: [...forward("market_litvinov", "timiryazev_33", "bogdan", "marx", "sukhbaatar_33", "sukhbaatar_square", "chkalov", "razin", "glazkov_bridge", "dzhambul"), ...north33],
            stops: [...stops("market_litvinov", ["Центральный рынок"]),
                ...stops("sukhbaatar_33", ["Сухэ-Батора"]), ...stops("chkalov", ["Чкалова"]),
                ...stops("dzhambul", ["Джамбула"]), ...north33Stops],
            returnPath: [...reverseSpecs(north33), ...forward("botkin", "railway_north", "mayakovsky_east"),
                ...backward("glazkov_bridge", "razin", "chkalov"), ...forward("lenin_square_return"),
                ...backward("lenin_center"), ...forward("market_dzerzhinsky")],
            returnStops: [...reverseStops(north33Stops.filter((s) => !["Военный Городок", "Кировская 3-я", "Виадук"].includes(s.name))),
                ...stops("botkin", ["Курорт Ангара"]), ...stops("railway_north", ["Дом связи"]),
                ...stops("mayakovsky_east", ["ул. Маяковского"]), ...stops("chkalov", ["Чкалова"], true),
                ...stops("lenin_square_return", ["Сквер им. Кирова"]),
                ...stops("lenin_center", ["Художественный музей", "Филармония"], true),
                ...stops("market_dzerzhinsky", ["Центральный рынок"])],
        },
    } };
})();


