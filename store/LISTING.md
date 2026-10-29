# Тексты для карточек магазинов

Копируй в поля карточки как есть. Картинки — в этой же папке.

## Общее

- **Название:** Чат Легиона
- **Категория:** Chrome — «Общение» (Communication); Edge — «Общение» (Communication); Firefox — «Социальные сети и общение» (Social & Communication)
- **Язык карточки:** русский (по желанию добавить английский — ниже)
- **Сайт / поддержка:** https://github.com/frebertor-sudo/legion-chat-window
- **Политика конфиденциальности:** https://github.com/frebertor-sudo/legion-chat-window/blob/main/PRIVACY.md
- **Лицензия (Firefox):** MIT
- **Картинки:** `screenshots/1-panel-v-igre.png` … `5-svetlaya-tema.png` (1280×800), `promo-440x280.png` (малая промо-плитка Chrome), иконка 128×128 — `../extension/icons/icon-128.png`

## Краткое описание (до 132 символов)

Чат шахты и города игры «Легион» (play.multidonate.ru): панель в игре, отдельное окно, личные, стикеры 7TV, модерация.

## Полное описание

Чат шахты и города игры «Легион» (play.multidonate.ru) — прямо в игре или в отдельном окне.

• Панель в игре — кнопка «💬 Чат» открывает чат сбоку, ширину можно менять, «⧉» выносит его в отдельное окно.
• Шахта, город и «Всё» — чат шахты, вкладки города (общий, торговля, достижения, личные) и общая лента всего сразу по времени, с фильтрами.
• Личные диалоги — список собеседников с непрочитанными, переписка с одним игроком, кнопка ✉ у ника. История хранится в браузере.
• Стримеры — переключение между каналами игры, отметка тех, кто в эфире.
• Стикеры 7TV, BTTV и FFZ канала — картинками в чате и панель выбора с поиском.
• Пасты — сохранённые сообщения с названиями.
• Модерация — для админа и модераторов чата: мут, бан, удаление сообщений, список ограничений. Права проверяет сервер игры.
• Окно поверх всех программ (Chrome и Edge), светлая и тёмная тема.

Расширение пользуется твоим входом на сайте игры и ничего не отправляет разработчику. Настройки и переписка хранятся только в браузере.

Неофициальное расширение, к разработчикам игры и стримерам отношения не имеет. Исходный код открыт (MIT).

## English (optional)

**Summary:** Mine and town chat of the "Legion" game (play.multidonate.ru): in-game panel, separate window, DMs, 7TV emotes, moderation.

**Description:** Mine and town chat of the "Legion" browser game (play.multidonate.ru), docked inside the game or in a separate window: town tabs, a merged feed, private conversations, channel switching, 7TV/BTTV/FFZ emotes, saved pastes, moderation tools for chat moderators, always-on-top window, light and dark themes. Uses your existing game login and sends nothing to the developer. Unofficial, open source (MIT).

---

## Ответы на вопросы магазинов

### Chrome Web Store — вкладка «Конфиденциальность» (Privacy practices)

- **Единственное назначение (Single purpose):** Показывать чат игры «Легион» (play.multidonate.ru) в панели внутри игры или в отдельном окне и отправлять в него сообщения.
- **Обоснование разрешений:**
  - *Доступ к сайтам (host permission) `https://play.multidonate.ru/*`* — расширение работает только на страницах игры: встраивает панель чата и получает сообщения чата игры от имени вошедшего игрока.
  - Других разрешений у расширения нет.
- **Удалённый код (Remote code):** Нет, расширение не использует удалённый код. Весь код находится в пакете.
- **Использование данных (Data usage):** отметь **«Личная переписка» (Personal communications)** — расширение показывает и отправляет сообщения чата игры, в том числе личные. Данные не передаются разработчику, не продаются, не используются для рекламы и кредитных решений. Поставь все три подтверждения внизу.
- **Политика конфиденциальности:** ссылка выше.

### Firefox Add-ons (AMO)

- **Исходный код:** не нужен — код в пакете не минифицирован и не собран сборщиком (на вопрос «Do you need to submit source code?» — **No**).
- **Заметки для проверяющих (Notes to reviewer):**
  > The add-on adds a chat panel to play.multidonate.ru (a browser game) and opens the same chat in a separate window. It talks only to play.multidonate.ru (same-origin, using the user's existing session) and to public emote APIs (api.ivr.fi, 7tv.io, api.betterttv.net, api.frankerfacez.com) to render chat emotes. No data is collected. The chat window is built on the game's own /site/ver page, which has no CSP. Content scripts use content.fetch so requests carry the user's game session. Source: https://github.com/frebertor-sudo/legion-chat-window
- **Сбор данных:** в манифесте заявлено «не собирает» (`data_collection_permissions: none`).

### Microsoft Edge Add-ons

- Те же тексты, что для Chrome. Ссылка на политику конфиденциальности — выше.
- **Notes for certification:** тот же текст, что для Firefox.
