# Публикация в магазинах и автообновления

После этих шагов каждая новая версия, пришедшая в `main`, сама уходит во все три магазина, а браузеры пользователей сами её ставят. Делается один раз.

Ключи вписываются в репозиторий: **Settings → Secrets and variables → Actions → New repository secret**. Имя секрета — ровно как в таблицах ниже. Секреты видит только GitHub Actions, в коде и журналах они не появляются.

Проверить, что всё работает: **Actions → «Публикация» → Run workflow**. Шаг магазина с ключами должен стать зелёным, без ключей — «skipped».

---

## 1. Firefox Add-ons — бесплатно, первую версию отправит автопубликация

1. Зайди на https://addons.mozilla.org/developers/ и войди (аккаунт Mozilla, можно создать там же).
2. Открой https://addons.mozilla.org/developers/addon/api/key/ → «Generate new credentials».
3. Впиши два секрета:

| Секрет | Откуда |
|---|---|
| `AMO_JWT_ISSUER` | JWT issuer (вида `user:12345:67`) |
| `AMO_JWT_SECRET` | JWT secret (длинная строка) |

4. **Actions → «Публикация» → Run workflow.** Автопубликация сама создаст карточку (название, описание, категория, лицензия — из `store/amo-metadata.json`) и отправит версию на проверку.
5. После проверки Mozilla (обычно от нескольких часов до пары дней) расширение появится в каталоге. По желанию добавь в карточку скриншоты из `store/screenshots/`.

## 2. Chrome Web Store — разовый взнос разработчика, первую версию загрузить вручную

**Первая публикация:**
1. https://chrome.google.com/webstore/devconsole → войди Google-аккаунтом → зарегистрируйся разработчиком (разовый взнос).
2. «Новый элемент» (New item) → загрузи `legion-chat-chrome.zip` из [последнего выпуска](https://github.com/frebertor-sudo/legion-chat-window/releases/latest).
3. Заполни карточку по [`LISTING.md`](LISTING.md): описание, категория, скриншоты, промо-плитка, вкладка «Конфиденциальность» (там же готовые ответы). Отправь на проверку.

**Ключи для автообновлений** — пошаговое руководство: https://github.com/fregante/chrome-webstore-upload-keys (создаёшь OAuth-клиент в Google Cloud и получаешь refresh token).

| Секрет | Откуда |
|---|---|
| `CWS_EXTENSION_ID` | ID расширения — в devconsole, в адресе страницы элемента |
| `CWS_PUBLISHER_ID` | ID издателя — devconsole → Account (Аккаунт) |
| `CWS_CLIENT_ID` | OAuth Client ID из Google Cloud |
| `CWS_CLIENT_SECRET` | OAuth Client Secret |
| `CWS_REFRESH_TOKEN` | refresh token из руководства |

## 3. Microsoft Edge Add-ons — бесплатно, первую версию загрузить вручную

**Первая публикация:**
1. https://partner.microsoft.com/dashboard/microsoftedge/ → зарегистрируйся в программе Microsoft Edge (бесплатно).
2. «Create new extension» → загрузи тот же `legion-chat-chrome.zip`.
3. Заполни карточку по [`LISTING.md`](LISTING.md) (тексты как для Chrome) → отправь на проверку.

**Ключи:** Partner Center → Microsoft Edge → **Publish API** → включи новый вариант (Enable) → **Create API credentials**.

| Секрет | Откуда |
|---|---|
| `EDGE_PRODUCT_ID` | Product ID — в адресе страницы расширения между `microsoftedge/` и `/packages` |
| `EDGE_CLIENT_ID` | Client ID со страницы Publish API |
| `EDGE_API_KEY` | API key со страницы Publish API (у ключа есть срок действия — продлевается там же) |

---

## Как выходит новая версия

1. В `legion-chat.user.js` поднимается `@version` (например, 3.0.1).
2. Изменения приходят в `main`.
3. GitHub сам: собирает пакеты, отправляет их во все магазины с ключами, создаёт выпуск `v3.0.1` с zip-файлами.
4. Магазины проверяют версию (от часов до нескольких дней) и раздают её пользователям; браузеры ставят обновление сами. Userscript обновляется по своей ссылке.

Если магазин отклонит версию, причина придёт письмом на почту аккаунта разработчика.
