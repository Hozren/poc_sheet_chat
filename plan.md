# План: Анонимный чат на Google Sheets

## Архитектура

```
[HTML + JS на GitHub Pages]  →  [Google Apps Script Web App]  →  [Google Sheet]
        фронт (UI чата)             бэкенд (API прокси)           хранилище
```

- **Фронт:** статический HTML + vanilla JS, хостится на GitHub Pages (или открывается локально)
- **Бэкенд:** Google Apps Script, задеплоенный как Web App (doPost/doGet)
- **БД:** Google Sheet — каждый чат это отдельный лист (вкладка)
- **Аутентификация:** ник + пароль, пароль хэшируется SHA-256 на клиенте

## Структура Google Sheet

```
Лист "_users":
  A: nickname
  B: password_hash (SHA-256 hex, 64 символа, хэшируется на клиенте)
  C: session_token (случайный UUID, генерится при логине)
  D: token_created_at (для проверки истечения сессии)
  E: created_at

Лист "_dm_index":
  A: participant1 (по алфавиту)
  B: participant2
  C: sheet_name (например "dm_alice_bob")

Лист "{chat_name}" (например "gopota"):
  A: timestamp (ISO 8601)
  B: nickname
  C: text

Лист "dm_{nick1}_{nick2}" (ники по алфавиту):
  A: timestamp
  B: nickname
  C: text
```

## API (Google Apps Script Web App)

Все запросы через POST (GET не поддерживает body в Apps Script нормально).
Формат: JSON в теле запроса. Ответ: JSON.
Фронт шлёт `Content-Type: text/plain` (не `application/json`) чтобы избежать CORS preflight — Apps Script не поддерживает OPTIONS.

### Общие коды ошибок
- `"unauthorized"` — невалидный или просроченный токен (сессия живёт 7 дней)
- `"unknown_action"` — неизвестный action
- `"internal_error"` — необработанная ошибка на сервере
- `"user_not_found"` — пользователь не найден (для ЛС)

### Лимиты API
- Максимум 50 сообщений за один запрос `/messages` или `/dm_messages`
- Если `after` не передан — возвращаются последние 50 сообщений

### 1. POST /register
```json
// Запрос:
{ "action": "register", "nickname": "alice", "password_hash": "sha256..." }
// Ответ (ок):
{ "ok": true, "token": "uuid-сессии", "nickname": "alice" }
// Ответ (ник занят):
{ "ok": false, "error": "nickname_taken" }
```

### 2. POST /login
```json
// Запрос:
{ "action": "login", "nickname": "alice", "password_hash": "sha256..." }
// Ответ (ок):
{ "ok": true, "token": "uuid-новой-сессии", "nickname": "alice" }
// Ответ (неверный пароль):
{ "ok": false, "error": "invalid_credentials" }
```

### 3. POST /send
```json
// Запрос:
{ "action": "send", "token": "uuid", "chat": "gopota", "text": "привет гопота" }
// Ответ:
{ "ok": true }
```

### 4. POST /messages
```json
// Запрос:
{ "action": "messages", "token": "uuid", "chat": "gopota", "after": "2026-02-11T10:00:00Z" }
// Ответ:
{ "ok": true, "messages": [
    { "timestamp": "2026-02-11T10:05:00Z", "nickname": "bob", "text": "здарова" }
  ]
}
```

### 5. POST /send_dm
```json
// Запрос:
{ "action": "send_dm", "token": "uuid", "to": "bob", "text": "ку" }
// Ответ:
{ "ok": true }
```

### 6. POST /dm_messages
```json
// Запрос:
{ "action": "dm_messages", "token": "uuid", "with": "bob", "after": "..." }
// Ответ:
{ "ok": true, "messages": [...] }
```

### 7. POST /users_online
```json
// Запрос:
{ "action": "users_online", "token": "uuid", "chat": "gopota" }
// Ответ:
{ "ok": true, "users": ["alice", "bob"] }
```

## Файловая структура проекта

```
gsheets_chat/
├── plan.md                  ← этот файл
├── apps_script/
│   └── Code.gs              ← Google Apps Script бэкенд (весь код в одном файле)
├── frontend/
│   ├── index.html           ← основная страница чата
│   ├── style.css            ← стили
│   └── app.js               ← логика: авторизация, отправка/получение сообщений, polling
└── README.md                ← инструкция по деплою (создание таблицы, деплой скрипта, настройка)
```

## Этапы реализации

### Этап 1: Google Apps Script бэкенд (`apps_script/Code.gs`)
1. Функция `doPost(e)` — роутер, парсит JSON, вызывает нужный обработчик по `action`
2. Хелперы: `getOrCreateSheet(name)`, `findUser(nickname)`, `validateToken(token)`
3. Обработчики: `register`, `login`, `send`, `messages`, `send_dm`, `dm_messages`, `users_online`
4. Сессионные токены: UUID генерится при логине/регистрации, хранится в `_users`, истекает через 7 дней
5. Проверка доступа к ЛС: только участники диалога могут читать/писать
6. `_dm_index` заполняется автоматически при первой отправке ЛС между двумя юзерами

### Этап 2: Фронтенд (`frontend/`)
1. **Экран логина/регистрации** — форма с ником и паролем, два кнопки
2. **Экран чата** — список сообщений, поле ввода, кнопка отправки
3. **Навигация** — хэш в URL определяет чат (`#gopota`), без хэша — показать список
4. **Polling** — каждые 3 секунды запрос новых сообщений (передаём `after` = timestamp последнего)
5. **ЛС** — список юзеров, клик → открывает личку
6. **Хранение сессии** — `token` и `nickname` в `localStorage`
7. **SHA-256** — через `crypto.subtle.digest()` перед отправкой пароля

### Этап 3: Деплой и документация
1. Инструкция: создать Google Sheet, открыть Apps Script, вставить код, задеплоить как Web App
2. В `app.js` указать URL задеплоенного Web App
3. Залить `frontend/` на GitHub Pages (или открыть `index.html` локально)

## Лимиты и ограничения

- Google Apps Script: ~20,000 запросов/день (бесплатный аккаунт)
- Один POST в Apps Script выполняется ~0.5-2 сек (холодный старт до 5 сек)
- Polling каждые 3 сек = ~28,800 запросов/день на одного юзера → для 1-5 юзеров норм
- Максимум ячеек в Google Sheet: 10 млн → хватит надолго

## Безопасность

- Пароль никогда не передаётся в открытом виде — только SHA-256 хэш
- Сессионный токен — UUID v4, обновляется при каждом логине
- Apps Script URL секретный — без него к таблице не попасть
- Таблица закрыта, доступ только у владельца
- Нет защиты от brute-force (для чата гопоты — приемлемо)
