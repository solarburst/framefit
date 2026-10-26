---
name: framefit
description: >-
  Drives a web page or component to a Figma frame with the framefit CLI:
  perceptual screenshot diff, per-string text geometry against the design, and
  layout gates that reject absolute-position or offset fitting. Use when
  implementing or fixing a React/CSS screen from a Figma design, matching a
  mock pixel by pixel, or when the user mentions framefit, вёрстка по макету,
  пиксель в пиксель, or a Figma frame URL.
---

# Framefit

Сверяет уже запущенную страницу или компонент на ней с фреймом Figma. Playwright и подмена `fetch` живут в CLI, не в проекте экрана. Принять экран можно только когда `check` и `stress` вышли с кодом 0.

CLI: `framefit` (ставится `npm link` в репозитории framefit). Если команды нет: в репозитории framefit выполнить `npm install && npm run build && npm link`. Браузер — Chromium из Playwright, иначе установленный Google Chrome.

## Эталон

1. Из URL фрейма взять `fileKey` и `nodeId` (`node-id=1-2` → `1:2`). Нет `node-id` — спросить ссылку на фрейм, id не угадывать.
2. Если в окружении есть `FIGMA_TOKEN`: `framefit pull --figma "<url>"`. Он пишет в `.framefit` файлы `reference.png`, `reference@2x.png`, `design.json` и `fixture.draft.json`. Перейти к шагу 5.
3. Иначе Figma MCP: `create_session`, затем `get_screenshot` с `maxDimension: 4096`. PNG из ответа скачать по curl в `.framefit/reference.png`. Если картинка меньше `original_width` / `original_height`, запросить снова с `maxDimension`, равным длинной стороне.
4. Через `get_metadata` и `get_design_context` собрать `.framefit/design.json`. Координаты — от левого верхнего угла фрейма, бокс накрывает текст:
   ```json
   { "frame": { "width": 350, "height": 506 }, "fonts": ["Golos Text"],
     "texts": [{ "text": "Льняной пиджак", "x": 20, "y": 250, "width": 214, "height": 32,
       "fontFamily": "Golos Text", "fontWeight": 700, "fontSize": 28, "lineHeight": 32, "color": "#29211d" }] }
   ```
5. Если PNG фрейма получить не удалось (нет токена и нет права на редактирование для MCP): остановиться и попросить доступ. Эталон из скриншотов браузера, кропов или даунсемплов не собирать.

Шрифты брать из `design.json` → `fonts` и подключать именно их. Не подбирать шрифт на глаз.

## Цикл

Не больше 8 прогонов `check` + `stress`. После восьмого показать пользователю отчёт и `diff.png` и остановиться.

1. `get_design_context` и `download_assets` — только инвентарь: строки, длины списков, файлы картинок. Координаты и сгенерированный код в компоненты не переносить.
2. Записать `.framefit/fixture.json` (за основу взять `fixture.draft.json`, если есть). Тела ответов содержат те же строки и ту же длину списков, что на макете. Картинки из `download_assets` лежат рядом, пути в `assets` — относительно фикстуры.
3. Запустить check, прочитать вывод, `.framefit/check.json` и `.framefit/diff.png`. Править поток документа: flex, grid, gap, padding. Повторяющаяся карточка — один компонент по массиву из фикстуры.
4. Запустить stress. Он удлиняет текст, проверяет вьюпорт шире и уже на 15% и укорачивает строки. Смотреть `stress-*.png`.

Код 1 — ошибка запуска (сервер или элемент недоступен, размер PNG не совпал со скриншотом). Это не повод двигать вёрстку.

## Команды

```bash
framefit check --url http://localhost:3000/screen \
  --reference .framefit/reference.png --fixture .framefit/fixture.json

framefit stress --url http://localhost:3000/screen \
  --reference .framefit/reference.png --fixture .framefit/fixture.json
```

Компонент внутри страницы: добавить к обеим командам `--selector "<css корня компонента>" --viewport 1280x900`. Снимается только этот элемент, и проверки вёрстки идут только внутри него.

Чёткое сравнение текста: `--reference .framefit/reference@2x.png --scale 2`.

`design.json` рядом с эталоном подхватывается сам. Без него геометрия не проверяется, и в выводе будет предупреждение. Так нельзя: собрать `design.json` по шагу 4.

## Что нельзя делать, чтобы закрыть diff

- `position: absolute` / `fixed` с `top` и `left`, скопированными из слоёв
- `position: relative` с `top/left`, `transform: translate`, отрицательные margin, чтобы дотянуть строку
- ширина и высота каждого узла «как у слоя»
- текст, выгруженный картинкой
- подкрутка `letter-spacing`, пока шрифт в отчёте не `loaded` или `local`
- менять пороги `--threshold`, `--ink-threshold`, `--tolerance` или отключать `--narrow 1` без согласия пользователя

`data-framefit-overlay` — только на настоящем оверлее: бейдж на фото, плавающая кнопка. `data-framefit-truncate` — только на тексте, который обрезан по макету (ellipsis, line-clamp).

## Как читать отчёт

- `визуал`: доля по кадру и по контурам. Строки `!область … — селектор «текст»` — плотные расхождения, начинать с них. `~область` — разница отрисовки глифов на строке с верной геометрией, её не править и `letter-spacing` под неё не подкручивать.
- `геометрия`: строка, селектор и что не так: `сдвиг по y +2px`, `ширина -4px`, `шрифт X, в макете Y`, `line-height`, `цвет`. Сдвиг по y обычно правится отступом или line-height соседа сверху, по x — padding или gap контейнера.
- `нет на странице` — строки макета нет или она с опечаткой. `нет в макете` — лишний текст.
- `текст в absolute/fixed`, `подгонка …` — убрать подгонку и выразить отступ потоком.
- `overflow`, `обрезан текст` — текст не влезает в коробку. `[wide]`, `[narrow]`, `[short]` — фаза stress.
- `схлопнулся при коротком тексте` — коробке нужен min-width/min-height или padding вместо ширины от текста.
- `шрифты: … (missing)` — шрифт не загрузился. Сначала подключить шрифт, потом смотреть пиксели.
- `без мока` — страница сходила не в тот URL. Поправить паттерн фикстуры, не подгонять пустой экран под макет. `маршрут не вызван` — фикстура описывает запрос, которого страница не делает.

Статичный текст можно оставить в компоненте, если он совпадает с инвентарём. Данные списков и карточек отдавать через запрос, который закрывает `routes`, массивом той же длины, что на макете.

Коды check: `0` всё сошлось, `2` визуал или геометрия, `3` только вёрстка, `4` оба, `1` запуск. Stress: `0` или `3`.
