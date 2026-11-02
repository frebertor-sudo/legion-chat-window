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

Весь чат игры «Легион» в одном окне, как в Telegram: шахта, город, личные, пинги и закрытые гильдии — прямо в игре.

## Полное описание

Весь чат игры «Легион» (play.multidonate.ru) в одном удобном окне — прямо в игре или отдельно.

★ Как в Telegram
• Сбоку колонка: Шахта, Город, Всё, Личные, Пинги, Гильдия — со счётчиками непрочитанного. Под ними последние собеседники: щелчок — и вы в переписке.
• Колонка встаёт к краю экрана: панель справа — колонка справа, слева — слева. Панель можно сделать плавающим окном, поставить в любой угол и свернуть до одной колонки, чтобы не мешала игре.
• Плоская строка ввода со значками; ссылки кликабельны.

★ Гильдии — закрытый чат для своих
• Сообщения зашифрованы и подписаны прямо в браузере: читают только участники, подделать чужое сообщение нельзя.
• Глава зовёт по нику или ссылкой-приглашением, назначает роли (заместитель, казначей…), закрепляет объявление.
• Сборы и опросы в два клика, реакции 👍 ❤️ 😂 🔥, ответы с цитатой, правка и удаление своих сообщений, отметки «прочитано» ✓✓, мини-превью ссылок (картинки, YouTube, Twitch).

★ Общение в игре
• Шахта, город (общий, торговля, достижения) и общая лента «Всё». Писать в город можно, не заходя в него.
• Личные приходят мгновенно — всплывашка, звук, уведомление. Друзья в сети, монета дня, обмен.
• 📣 Пинги — все, кто звал вас по @нику. ⭐ Закладки. Поиск Ctrl+F. «Стример начал эфир».
• Ответ с цитатой, @ник по Tab, «только его сообщения», игнор, свой цвет и прозвище для любого ника.
• Стикеры 7TV, BTTV и FFZ канала. Модерация для модераторов чата.

★ Под себя
Тёмная и светлая тема, цветовые схемы, свой фон, шрифт и размер, прозрачность панели, звук, свой CSS.

Расширение пользуется вашим входом на сайте игры и ничего не отправляет разработчику. Настройки и переписка хранятся только в браузере. Сообщения гильдий идут зашифрованными через сервис ntfy.sh — только если вы пользуетесь гильдиями.

Неофициальное расширение, к разработчикам игры и стримерам отношения не имеет. Исходный код открыт (MIT).

## English (optional)

**Summary:** Mine and town chat of the "Legion" game (play.multidonate.ru): in-game panel, separate window, DMs, 7TV emotes, moderation.

**Description:** Mine and town chat of the "Legion" browser game (play.multidonate.ru), built into the game's own chat or in a separate window. Movable, resizable and semi-transparent in-game panel; town tabs and a merged feed; instant private messages; friends (online status, daily coin, highlighted messages); fuzzy player search; channel switching; 7TV/BTTV/FFZ emotes; saved pastes; moderation tools for chat moderators; themes and customization; always-on-top window. Uses your existing game login and sends nothing to the developer. Unofficial, open source (MIT).

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
  > The add-on adds a chat panel to play.multidonate.ru (a browser game) and opens the same chat in a separate window. It talks only to play.multidonate.ru (same-origin, using the user's existing session) and to public emote APIs (api.ivr.fi, 7tv.io, api.betterttv.net, api.frankerfacez.com) to render chat emotes, plus Google Fonts (Nunito, Comfortaa — the same fonts the game page itself loads). No data is collected. The chat window is built on the game's own /site/ver page, which has no CSP. Content scripts use content.fetch so requests carry the user's game session. Source: https://github.com/frebertor-sudo/legion-chat-window About innerHTML warnings: every value from the network or the user goes through the esc() HTML-escaping helper before being placed into innerHTML templates.
- **Сбор данных:** в манифесте заявлено «не собирает» (`data_collection_permissions: none`).

### Microsoft Edge Add-ons

- Те же тексты, что для Chrome. Ссылка на политику конфиденциальности — выше.
- **Notes for certification:** тот же текст, что для Firefox.
