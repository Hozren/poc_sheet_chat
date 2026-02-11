# План имплементации: Бэкенд (Google Apps Script)

Один файл `apps_script/Code.gs`. Весь бэкенд — это одна функция `doPost(e)` + обработчики.

---

## 1. Точка входа: `doPost(e)`

```
doPost(e):
  1. Парсим JSON из e.postData.contents
  2. Достаём action из тела запроса
  3. Switch по action:
     "register"      → handleRegister(data)
     "login"         → handleLogin(data)
     "send"          → handleSend(data)
     "messages"      → handleMessages(data)
     "send_dm"       → handleSendDm(data)
     "dm_messages"   → handleDmMessages(data)
     "users_online"  → handleUsersOnline(data)
     default         → { ok: false, error: "unknown_action" }
  4. Возвращаем ContentService.createTextOutput(JSON.stringify(result))
       .setMimeType(ContentService.MimeType.JSON)
```

Обёртка try/catch на весь doPost — при любой ошибке возвращаем `{ ok: false, error: "internal_error" }`.

---

## 2. Константы и конфигурация

```
CONFIG:
  SPREADSHEET_ID: "" ← пустая строка, заполняется при деплое (или берём активную таблицу через SpreadsheetApp.getActiveSpreadsheet())
  MAX_MESSAGES_PER_REQUEST: 50
  SESSION_EXPIRY_HOURS: 24 * 7 (неделя)
  SYSTEM_SHEETS: ["_users", "_dm_index"] ← нельзя использовать как имена чатов
```

---

## 3. Утилиты

### 3.1 `getSpreadsheet()`
- Возвращает `SpreadsheetApp.getActiveSpreadsheet()`
- Используем active, т.к. скрипт привязан к таблице

### 3.2 `getOrCreateSheet(name)`
- `ss.getSheetByName(name)`
- Если null → `ss.insertSheet(name)`
- Для чатов: добавить заголовки `timestamp | nickname | text` в первую строку
- Для `_users`: заголовки `nickname | password_hash | session_token | token_created_at | created_at`
- Для `_dm_index`: заголовки `participant1 | participant2 | sheet_name`
- Возвращает sheet

### 3.3 `findUserByNickname(nickname)`
- Получить лист `_users`
- `sheet.getDataRange().getValues()`
- Найти строку где `row[0] === nickname`
- Вернуть `{ row: rowIndex, nickname, password_hash, session_token, token_created_at, created_at }` или `null`

### 3.4 `findUserByToken(token)`
- Аналогично, но ищем по `row[2] === token`
- Проверяем что токен не просрочен (token_created_at + SESSION_EXPIRY_HOURS)
- Вернуть `{ row: rowIndex, nickname, ... }` или `null`

### 3.5 `generateToken()`
- `Utilities.getUuid()` — встроенный в Apps Script

### 3.6 `jsonResponse(data)`
- `ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)`

### 3.7 `getDmSheetName(nick1, nick2)`
- Сортируем ники по алфавиту: `[nick1, nick2].sort()`
- Возвращаем `"dm_" + sorted[0] + "_" + sorted[1]`

---

## 4. Обработчики

### 4.1 `handleRegister(data)`

Вход: `{ nickname, password_hash }`

```
1. Валидация:
   - nickname: 1-20 символов, только [a-zA-Z0-9_], не пустой
   - password_hash: непустая строка (64 символа hex для SHA-256)
   - nickname не в SYSTEM_SHEETS
2. findUserByNickname(nickname)
   - Если найден → { ok: false, error: "nickname_taken" }
3. Генерим token = generateToken()
4. Получаем лист _users через getOrCreateSheet("_users")
5. Добавляем строку: [nickname, password_hash, token, new Date().toISOString(), new Date().toISOString()]
6. Возвращаем { ok: true, token: token, nickname: nickname }
```

### 4.2 `handleLogin(data)`

Вход: `{ nickname, password_hash }`

```
1. findUserByNickname(nickname)
   - Если не найден → { ok: false, error: "invalid_credentials" }
2. Сравниваем password_hash с сохранённым
   - Не совпадает → { ok: false, error: "invalid_credentials" }
3. Генерим новый token
4. Обновляем строку: sheet.getRange(row, 3).setValue(token), sheet.getRange(row, 4).setValue(new Date().toISOString())
5. Возвращаем { ok: true, token: token, nickname: nickname }
```

### 4.3 `handleSend(data)`

Вход: `{ token, chat, text }`

```
1. user = findUserByToken(token)
   - Если null → { ok: false, error: "unauthorized" }
2. Валидация:
   - chat: 1-30 символов, [a-zA-Z0-9_], не начинается с "_", не начинается с "dm_"
   - text: 1-1000 символов, непустой после trim
3. sheet = getOrCreateSheet(chat)
4. Добавляем строку: [new Date().toISOString(), user.nickname, text.trim()]
5. Возвращаем { ok: true }
```

### 4.4 `handleMessages(data)`

Вход: `{ token, chat, after (опционально) }`

```
1. user = findUserByToken(token)
   - Если null → { ok: false, error: "unauthorized" }
2. sheet = getSheetByName(chat)
   - Если null → { ok: true, messages: [] } (чат ещё не существует)
3. data = sheet.getDataRange().getValues()
4. Пропускаем первую строку (заголовки)
5. Если after задан — фильтруем: приводим row[0] к строке через `new Date(row[0]).toISOString()` (Google Sheets может вернуть Date объект), оставляем только timestamp > after
6. Берём последние MAX_MESSAGES_PER_REQUEST строк
7. Маппим в [{ timestamp, nickname, text }], timestamp приводим к ISO строке
8. Возвращаем { ok: true, messages: [...] }
```

### 4.5 `handleSendDm(data)`

Вход: `{ token, to, text }`

```
1. user = findUserByToken(token)
   - Если null → { ok: false, error: "unauthorized" }
2. Валидация:
   - to: непустой, не равен user.nickname
   - text: 1-1000 символов
3. recipient = findUserByNickname(to)
   - Если null → { ok: false, error: "user_not_found" }
4. sheetName = getDmSheetName(user.nickname, to)
5. sheet = getOrCreateSheet(sheetName)
6. Обновляем _dm_index если пара ещё не записана:
   - Получить лист _dm_index
   - Проверить есть ли уже запись с этими двумя участниками
   - Если нет — добавить строку [sorted[0], sorted[1], sheetName]
7. Добавляем сообщение: [new Date().toISOString(), user.nickname, text.trim()]
8. Возвращаем { ok: true }
```

### 4.6 `handleDmMessages(data)`

Вход: `{ token, with, after (опционально) }`

```
1. user = findUserByToken(token)
   - Если null → { ok: false, error: "unauthorized" }
2. sheetName = getDmSheetName(user.nickname, data.with)
3. sheet = getSheetByName(sheetName)
   - Если null → { ok: true, messages: [] }
4. Читаем и фильтруем аналогично handleMessages
5. Возвращаем { ok: true, messages: [...] }
```

### 4.7 `handleUsersOnline(data)`

Вход: `{ token, chat }`

```
1. user = findUserByToken(token)
   - Если null → { ok: false, error: "unauthorized" }
2. sheet = getSheetByName(chat)
   - Если null → { ok: true, users: [] }
3. data = sheet.getDataRange().getValues()
4. Собираем уникальные nickname из сообщений за последние 5 минут
5. Возвращаем { ok: true, users: [...] }
```

---

## 5. Порядок написания кода

```
Шаг 1: Константы + CONFIG
Шаг 2: Утилиты (getSpreadsheet, getOrCreateSheet, findUser*, generateToken, jsonResponse, getDmSheetName)
Шаг 3: doPost + роутер
Шаг 4: handleRegister
Шаг 5: handleLogin
Шаг 6: handleSend + handleMessages (групповой чат)
Шаг 7: handleSendDm + handleDmMessages (личные сообщения)
Шаг 8: handleUsersOnline
```

После каждого шага можно деплоить и тестировать через curl/Postman.

---

## 6. Тестирование

Тестируем через curl после деплоя:

```bash
# Регистрация
curl -L -X POST "SCRIPT_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"register","nickname":"test","password_hash":"abc123"}'

# Отправка сообщения
curl -L -X POST "SCRIPT_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"send","token":"TOKEN","chat":"test","text":"hello"}'

# Чтение сообщений
curl -L -X POST "SCRIPT_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"messages","token":"TOKEN","chat":"test"}'
```

Важно: `-L` обязателен — Apps Script делает редирект (302) при вызове Web App.
