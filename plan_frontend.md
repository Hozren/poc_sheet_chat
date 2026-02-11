# План имплементации: Фронтенд

Три файла: `frontend/index.html`, `frontend/style.css`, `frontend/app.js`

---

## 1. Конфигурация (`app.js` — начало файла)

```
const CONFIG = {
  API_URL: "", ← URL задеплоенного Apps Script Web App (заполняется при деплое)
  POLL_INTERVAL: 3000, ← миллисекунды между запросами новых сообщений
  MAX_MESSAGE_LENGTH: 1000
};
```

---

## 2. Экраны приложения

Два экрана, переключаемых через display:none/block:

### 2.1 Экран авторизации (`#auth-screen`)
```
┌──────────────────────────┐
│    GSheets Chat          │
│                          │
│  Ник:    [___________]   │
│  Пароль: [___________]   │
│                          │
│  [Войти]  [Регистрация]  │
│                          │
│  (ошибка если есть)      │
└──────────────────────────┘
```

### 2.2 Экран чата (`#chat-screen`)
```
┌──────────────────────────────────────┐
│ ☰ Меню    #gopota           username │
├────────────┬─────────────────────────┤
│ Чаты:      │ 10:05 bob: здарова     │
│  #gopota   │ 10:06 alice: ку        │
│  #random   │ 10:07 bob: чё как      │
│            │                         │
│ Личные:    │                         │
│  @bob      │                         │
│  @charlie  │                         │
│            ├─────────────────────────┤
│ [+ чат]    │ [сообщение...] [>]     │
│ [+ ЛС]    │                         │
└────────────┴─────────────────────────┘
```

---

## 3. HTML-структура (`index.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GSheets Chat</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <!-- Экран авторизации -->
  <div id="auth-screen">
    <div class="auth-container">
      <h1>GSheets Chat</h1>
      <input id="auth-nickname" placeholder="Ник" maxlength="20">
      <input id="auth-password" type="password" placeholder="Пароль">
      <div class="auth-buttons">
        <button id="btn-login">Войти</button>
        <button id="btn-register">Регистрация</button>
      </div>
      <div id="auth-error"></div>
    </div>
  </div>

  <!-- Экран чата -->
  <div id="chat-screen" hidden>
    <div class="chat-layout">
      <!-- Сайдбар -->
      <aside id="sidebar">
        <div class="sidebar-header">
          <span id="current-user"></span>
          <button id="btn-logout">Выйти</button>
        </div>
        <div class="sidebar-section">
          <h3>Чаты</h3>
          <div id="chat-list"></div>
          <button id="btn-new-chat">+ чат</button>
        </div>
        <div class="sidebar-section">
          <h3>Личные</h3>
          <div id="dm-list"></div>
          <button id="btn-new-dm">+ ЛС</button>
        </div>
      </aside>

      <!-- Основная область -->
      <main id="main-area">
        <div id="chat-header"></div>
        <div id="messages"></div>
        <div id="message-input-area">
          <input id="message-input" placeholder="Сообщение..." maxlength="1000">
          <button id="btn-send">→</button>
        </div>
      </main>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

---

## 4. Модули в `app.js`

Один файл, организованный в секции:

### 4.1 Состояние приложения (State)

```js
const state = {
  token: localStorage.getItem("token") || null,
  nickname: localStorage.getItem("nickname") || null,
  currentChat: null,       // { type: "chat"|"dm", name: string }
  messages: [],            // массив сообщений текущего чата
  lastTimestamp: null,      // timestamp последнего полученного сообщения
  pollTimer: null,         // id интервала polling
  chatList: [],            // ["gopota", "random", ...] — хранится в localStorage
  dmList: []               // ["bob", "charlie", ...] — хранится в localStorage
};
```

### 4.2 API-модуль

```js
async function apiCall(action, data = {}) {
  try {
    const response = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      // text/plain чтобы избежать CORS preflight (Apps Script не поддерживает OPTIONS)
      redirect: "follow",
      body: JSON.stringify({ action, ...data })
    });
    const result = await response.json();
    // Если токен истёк — автоматически разлогиниваем
    if (!result.ok && result.error === "unauthorized") {
      handleLogout();
      return result;
    }
    return result;
  } catch (err) {
    // Сетевая ошибка — не крашим приложение
    console.error("API error:", err);
    return { ok: false, error: "network_error" };
  }
}
```

Важно: `Content-Type: text/plain` — не `application/json`! Apps Script Web App не поддерживает CORS preflight (OPTIONS запрос). С `text/plain` браузер шлёт simple request без preflight.

Обёртки:
```
api.register(nickname, passwordHash) → apiCall("register", { nickname, password_hash: passwordHash })
api.login(nickname, passwordHash)    → apiCall("login", { nickname, password_hash: passwordHash })
api.send(token, chat, text)          → apiCall("send", { token, chat, text })
api.messages(token, chat, after)     → apiCall("messages", { token, chat, after })
api.sendDm(token, to, text)          → apiCall("send_dm", { token, to, text })
api.dmMessages(token, with_, after)  → apiCall("dm_messages", { token, with: with_, after })
api.usersOnline(token, chat)         → apiCall("users_online", { token, chat })
```

### 4.3 Хэширование пароля

```js
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
```

### 4.4 Управление экранами

```
showAuthScreen()   → прячет chat-screen, показывает auth-screen
showChatScreen()   → прячет auth-screen, показывает chat-screen, отображает ник в sidebar
```

### 4.5 Авторизация

```
handleLogin():
  1. Берём nickname и password из инпутов
  2. hash = await hashPassword(password)
  3. result = await api.login(nickname, hash)
  4. Если ok → сохранить token, nickname в state и localStorage → showChatScreen()
  5. Если ошибка → показать человекочитаемое сообщение в #auth-error:
     - "invalid_credentials" → "Неверный ник или пароль"
     - "nickname_taken" → "Ник уже занят"
     - "network_error" → "Нет соединения с сервером"
     - прочее → "Ошибка: " + error

handleRegister():
  1. Аналогично, но вызываем api.register
  2. При успехе — сразу логинимся (токен приходит в ответе)

handleLogout():
  1. Очистить state.token, state.nickname, localStorage
  2. Остановить polling
  3. showAuthScreen()
```

### 4.6 Управление чатами

```
openChat(name):
  1. state.currentChat = { type: "chat", name }
  2. state.messages = []
  3. state.lastTimestamp = null
  4. Обновить #chat-header (показать "#name")
  5. Очистить #messages
  6. Загрузить сообщения: await loadMessages()
  7. Запустить polling: startPolling()
  8. Обновить URL хэш: location.hash = name

openDm(nickname):
  1. state.currentChat = { type: "dm", name: nickname }
  2. Аналогично openChat, но header показывает "@nickname"
  3. location.hash = "dm:" + nickname

loadMessages():
  1. Если currentChat.type === "chat":
     result = await api.messages(token, chat, lastTimestamp)
  2. Если currentChat.type === "dm":
     result = await api.dmMessages(token, with, lastTimestamp)
  3. Если result.ok и messages.length > 0:
     - Добавить в state.messages
     - state.lastTimestamp = последний timestamp
     - renderMessages()

startPolling():
  1. Остановить предыдущий: clearInterval(state.pollTimer)
  2. state.pollTimer = setInterval(loadMessages, CONFIG.POLL_INTERVAL)

stopPolling():
  1. clearInterval(state.pollTimer)
```

### 4.7 Отправка сообщений

```
handleSend():
  1. text = message-input.value.trim()
  2. Если пустой → return
  3. Если currentChat.type === "chat":
     await api.send(token, currentChat.name, text)
  4. Если currentChat.type === "dm":
     await api.sendDm(token, currentChat.name, text)
  5. Очистить инпут
  6. Сразу вызвать loadMessages() (не ждать polling)
```

### 4.8 Рендеринг сообщений

```
renderMessages():
  1. container = #messages
  2. Для каждого сообщения в state.messages:
     - Создать div.message
     - Внутри: span.time (HH:MM), span.nickname, span.text
     - Если nickname === state.nickname → добавить класс .own
  3. Прокрутить вниз: container.scrollTop = container.scrollHeight
```

Важно: **не перерисовывать всё каждый раз**. Добавлять только новые сообщения в конец.

### 4.9 Онлайн-юзеры

```
loadOnlineUsers():
  1. Если currentChat.type !== "chat" → return (для ЛС не показываем)
  2. result = await api.usersOnline(token, currentChat.name)
  3. Если result.ok → отобразить список в #chat-header или отдельном блоке
  4. Показать как: "Онлайн: alice, bob" рядом с названием чата
```

Вызывается:
- При `openChat()` — сразу после загрузки сообщений
- Каждые 10 секунд (отдельный интервал от polling сообщений)
- Интервал останавливается при смене чата или logout

### 4.10 Сайдбар

```
renderChatList():
  - Отрисовать state.chatList в #chat-list
  - Каждый элемент — кликабельный, вызывает openChat(name)
  - Подсветить текущий чат

renderDmList():
  - Аналогично для state.dmList в #dm-list
  - Клик → openDm(nickname)

handleNewChat():
  1. name = prompt("Название чата:")
  2. Валидация: 1-30 символов, [a-zA-Z0-9_], не начинается с "_", не начинается с "dm_"
  3. Добавить в state.chatList, сохранить в localStorage
  4. renderChatList()
  5. openChat(name)

handleNewDm():
  1. nickname = prompt("Ник пользователя:")
  2. Добавить в state.dmList, сохранить в localStorage
  3. renderDmList()
  4. openDm(nickname)
```

### 4.11 Инициализация

```
init():
  1. Загрузить chatList, dmList из localStorage
  2. Если state.token существует:
     - showChatScreen()
     - Парсить location.hash:
       - "#gopota"     → openChat("gopota")
       - "#dm:bob"     → openDm("bob")
       - пустой        → показать "выберите чат"
  3. Если нет token → showAuthScreen()
  4. Навесить обработчики:
     - btn-login → handleLogin
     - btn-register → handleRegister
     - btn-logout → handleLogout
     - btn-send → handleSend
     - message-input keydown Enter → handleSend
     - btn-new-chat → handleNewChat
     - btn-new-dm → handleNewDm
     - window hashchange → парсить хэш и открыть чат
  5. Запустить интервал онлайн-юзеров (если в групповом чате)

document.addEventListener("DOMContentLoaded", init);
```

---

## 5. Стили (`style.css`)

Основные моменты:

```
Общее:
  - Тёмная тема (фон #1a1a2e, текст #eee)
  - Шрифт: monospace (чат гопоты же)
  - Без внешних зависимостей

Авторизация (#auth-screen):
  - Центрирование по экрану (flexbox)
  - Инпуты и кнопки в столбик
  - Макс. ширина 300px

Чат layout:
  - display: grid; grid-template-columns: 220px 1fr;
  - Высота 100vh

Сайдбар:
  - Фиксированная ширина 220px
  - Фон чуть светлее основного
  - Список чатов — кликабельные элементы с подсветкой активного

Сообщения (#messages):
  - flex-direction: column
  - overflow-y: auto (скролл)
  - Каждое сообщение: время серым, ник цветным, текст белым
  - Свои сообщения (.own) — выровнены вправо или другой цвет ника

Инпут сообщения:
  - Прибит к низу (flex)
  - Инпут растягивается, кнопка отправки фиксированная

Адаптивность (мобилка):
  - @media (max-width: 600px): сайдбар скрыт, кнопка ☰ для показа
  - Сайдбар открывается как overlay
```

---

## 6. Порядок реализации

```
Шаг 1: index.html — полная HTML-разметка обоих экранов
Шаг 2: style.css — базовые стили, лейаут, тёмная тема
Шаг 3: app.js — CONFIG, state, apiCall, hashPassword
Шаг 4: app.js — авторизация (login, register, logout) + переключение экранов
Шаг 5: app.js — открытие чата, загрузка и рендеринг сообщений
Шаг 6: app.js — отправка сообщений
Шаг 7: app.js — polling (автообновление)
Шаг 8: app.js — онлайн-юзеры (загрузка, отображение, интервал 10 сек)
Шаг 9: app.js — сайдбар (список чатов, ЛС, создание новых)
Шаг 10: app.js — парсинг хэша в URL, навигация
Шаг 11: style.css — адаптивность под мобилку
Шаг 12: app.js — init(), связка всего вместе
```

---

## 7. Нюансы реализации

### CORS
- Apps Script Web App не поддерживает CORS preflight (OPTIONS)
- Используем `Content-Type: text/plain` → браузер шлёт simple request
- В Apps Script парсим тело запроса из `e.postData.contents` как JSON вручную

### Redirect
- Apps Script Web App отвечает 302 редиректом
- В `apiCall` уже указан `redirect: "follow"` — fetch следует редиректам
- Не указываем `mode` явно — по умолчанию `cors`, работает с Apps Script

### Скролл
- При загрузке новых сообщений скроллим вниз только если юзер уже был внизу
- Проверка: `container.scrollTop + container.clientHeight >= container.scrollHeight - 50`

### Экранирование HTML
- Все тексты сообщений вставлять через `textContent`, НЕ через `innerHTML`
- Это предотвращает XSS
