// ============================================================================
// КОНФИГУРАЦИЯ
// ============================================================================

const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbzII4ILbwjqtac4CLaV_4ZAOFph5SeDfmFnFl3soReUlG6bojP7kCJXhJbOQZo_qXyRyA/exec", // URL задеплоенного Apps Script Web App (заполняется при деплое)
  POLL_INTERVAL: 3000, // миллисекунды между запросами новых сообщений
  MAX_MESSAGE_LENGTH: 1000
};

// ============================================================================
// СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// ============================================================================

const state = {
  token: localStorage.getItem("token") || null,
  nickname: localStorage.getItem("nickname") || null,
  currentChat: null, // { type: "chat"|"dm", name: string }
  messages: [], // массив сообщений текущего чата
  lastTimestamp: null, // timestamp последнего полученного сообщения
  pollTimer: null, // id интервала polling
  onlineTimer: null, // id интервала онлайн-юзеров
  chatList: JSON.parse(localStorage.getItem("chatList") || "[]"), // ["gopota", "random", ...]
  dmList: JSON.parse(localStorage.getItem("dmList") || "[]") // ["bob", "charlie", ...]
};

// ============================================================================
// API-МОДУЛЬ
// ============================================================================

async function apiCall(action, data = {}) {
  try {
    const response = await fetch(CONFIG.API_URL, {
      method: "POST",
      body: JSON.stringify({ action, ...data })
    });
    const text = await response.text();
    console.log("API raw response:", text);
    const result = JSON.parse(text);

    // Если токен истёк — автоматически разлогиниваем
    if (!result.ok && result.error === "unauthorized") {
      handleLogout();
      return result;
    }

    return result;
  } catch (err) {
    console.error("API error:", err);
    return { ok: false, error: "network_error" };
  }
}

const api = {
  register: (nickname, passwordHash) =>
    apiCall("register", { nickname, password_hash: passwordHash }),

  login: (nickname, passwordHash) =>
    apiCall("login", { nickname, password_hash: passwordHash }),

  send: (token, chat, text) =>
    apiCall("send", { token, chat, text }),

  messages: (token, chat, after) =>
    apiCall("messages", { token, chat, after }),

  sendDm: (token, to, text) =>
    apiCall("send_dm", { token, to, text }),

  dmMessages: (token, with_, after) =>
    apiCall("dm_messages", { token, with: with_, after }),

  usersOnline: (token, chat) =>
    apiCall("users_online", { token, chat })
};

// ============================================================================
// ХЭШИРОВАНИЕ ПАРОЛЯ
// ============================================================================

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// УПРАВЛЕНИЕ ЭКРАНАМИ
// ============================================================================

function showAuthScreen() {
  document.getElementById("auth-screen").hidden = false;
  document.getElementById("chat-screen").hidden = true;
}

function showChatScreen() {
  document.getElementById("auth-screen").hidden = true;
  document.getElementById("chat-screen").hidden = false;
  document.getElementById("current-user").textContent = state.nickname;
}

// ============================================================================
// АВТОРИЗАЦИЯ
// ============================================================================

async function handleLogin() {
  const nickname = document.getElementById("auth-nickname").value.trim();
  const password = document.getElementById("auth-password").value;
  const errorEl = document.getElementById("auth-error");

  if (!nickname || !password) {
    errorEl.textContent = "Заполните все поля";
    return;
  }

  errorEl.textContent = "";

  const hash = await hashPassword(password);
  const result = await api.login(nickname, hash);

  if (result.ok) {
    state.token = result.token;
    state.nickname = nickname;
    localStorage.setItem("token", result.token);
    localStorage.setItem("nickname", nickname);
    showChatScreen();
    renderChatList();
    renderDmList();
    parseHashAndOpenChat();
  } else {
    const errorMessages = {
      "invalid_credentials": "Неверный ник или пароль",
      "nickname_taken": "Ник уже занят",
      "network_error": "Нет соединения с сервером"
    };
    errorEl.textContent = errorMessages[result.error] || `Ошибка: ${result.error}`;
  }
}

async function handleRegister() {
  const nickname = document.getElementById("auth-nickname").value.trim();
  const password = document.getElementById("auth-password").value;
  const errorEl = document.getElementById("auth-error");

  if (!nickname || !password) {
    errorEl.textContent = "Заполните все поля";
    return;
  }

  errorEl.textContent = "";

  const hash = await hashPassword(password);
  const result = await api.register(nickname, hash);

  if (result.ok) {
    state.token = result.token;
    state.nickname = nickname;
    localStorage.setItem("token", result.token);
    localStorage.setItem("nickname", nickname);
    showChatScreen();
    renderChatList();
    renderDmList();
    parseHashAndOpenChat();
  } else {
    const errorMessages = {
      "invalid_credentials": "Неверный ник или пароль",
      "nickname_taken": "Ник уже занят",
      "network_error": "Нет соединения с сервером"
    };
    errorEl.textContent = errorMessages[result.error] || `Ошибка: ${result.error}`;
  }
}

function handleLogout() {
  state.token = null;
  state.nickname = null;
  state.currentChat = null;
  state.messages = [];
  state.lastTimestamp = null;

  localStorage.removeItem("token");
  localStorage.removeItem("nickname");

  stopPolling();
  stopOnlinePolling();
  showAuthScreen();
}

// ============================================================================
// УПРАВЛЕНИЕ ЧАТАМИ
// ============================================================================

async function openChat(name) {
  state.currentChat = { type: "chat", name };
  state.messages = [];
  state.lastTimestamp = null;

  document.getElementById("chat-header").textContent = `#${name}`;
  document.getElementById("messages").innerHTML = "";

  location.hash = name;
  renderChatList();
  renderDmList();

  await loadMessages();
  startPolling();
  startOnlinePolling();
}

async function openDm(nickname) {
  state.currentChat = { type: "dm", name: nickname };
  state.messages = [];
  state.lastTimestamp = null;

  document.getElementById("chat-header").textContent = `@${nickname}`;
  document.getElementById("messages").innerHTML = "";

  location.hash = `dm:${nickname}`;
  renderChatList();
  renderDmList();

  await loadMessages();
  startPolling();
  stopOnlinePolling(); // Онлайн-юзеры не показываем для ЛС
}

async function loadMessages() {
  if (!state.currentChat) return;

  // BUG 2: Сохранение snapshot для проверки гонки состояний
  const chatSnapshot = state.currentChat;

  let result;

  if (state.currentChat.type === "chat") {
    result = await api.messages(state.token, state.currentChat.name, state.lastTimestamp);
  } else if (state.currentChat.type === "dm") {
    result = await api.dmMessages(state.token, state.currentChat.name, state.lastTimestamp);
  }

  // BUG 2: Проверка что чат не сменился во время запроса
  if (state.currentChat !== chatSnapshot) return;

  if (result.ok && result.messages && result.messages.length > 0) {
    const oldMessagesCount = state.messages.length;
    state.messages.push(...result.messages);
    state.lastTimestamp = result.messages[result.messages.length - 1].timestamp;
    renderNewMessages(oldMessagesCount);
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(loadMessages, CONFIG.POLL_INTERVAL);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ============================================================================
// ОТПРАВКА СООБЩЕНИЙ
// ============================================================================

async function handleSend() {
  if (!state.currentChat) return;

  const input = document.getElementById("message-input");
  const text = input.value.trim();

  if (!text) return;

  // BUG 6: Блокировка кнопки во время отправки
  const sendBtn = document.getElementById("btn-send");
  sendBtn.disabled = true;

  let result;

  if (state.currentChat.type === "chat") {
    result = await api.send(state.token, state.currentChat.name, text);
  } else if (state.currentChat.type === "dm") {
    result = await api.sendDm(state.token, state.currentChat.name, text);
  }

  // BUG 6: Разблокировка кнопки
  sendBtn.disabled = false;

  // BUG 3: Очистка и обновление только если запрос успешен
  if (result && result.ok) {
    input.value = "";
    await loadMessages();
  }
}

// ============================================================================
// РЕНДЕРИНГ СООБЩЕНИЙ
// ============================================================================

function renderNewMessages(startIndex) {
  const container = document.getElementById("messages");
  const wasAtBottom = isScrolledToBottom(container);

  for (let i = startIndex; i < state.messages.length; i++) {
    const msg = state.messages[i];
    const messageEl = document.createElement("div");
    messageEl.className = "message";

    if (msg.nickname === state.nickname) {
      messageEl.classList.add("own");
    }

    const timeEl = document.createElement("span");
    timeEl.className = "time";
    timeEl.textContent = formatTime(msg.timestamp);

    const nicknameEl = document.createElement("span");
    nicknameEl.className = "nickname";
    nicknameEl.textContent = msg.nickname + ":";

    const textEl = document.createElement("span");
    textEl.className = "text";
    textEl.textContent = msg.text;

    messageEl.appendChild(timeEl);
    messageEl.appendChild(nicknameEl);
    messageEl.appendChild(document.createTextNode(" "));
    messageEl.appendChild(textEl);

    container.appendChild(messageEl);
  }

  // Умный скролл: скроллим вниз только если юзер был внизу
  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function isScrolledToBottom(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// ============================================================================
// ОНЛАЙН-ЮЗЕРЫ
// ============================================================================

async function loadOnlineUsers() {
  if (!state.currentChat || state.currentChat.type !== "chat") return;

  const result = await api.usersOnline(state.token, state.currentChat.name);

  if (result.ok && result.users) {
    const headerEl = document.getElementById("chat-header");
    const onlineText = result.users.length > 0
      ? ` (Онлайн: ${result.users.join(", ")})`
      : "";
    headerEl.textContent = `#${state.currentChat.name}${onlineText}`;
  }
}

function startOnlinePolling() {
  stopOnlinePolling();
  loadOnlineUsers(); // Сразу загружаем
  state.onlineTimer = setInterval(loadOnlineUsers, 10000); // Каждые 10 секунд
}

function stopOnlinePolling() {
  if (state.onlineTimer) {
    clearInterval(state.onlineTimer);
    state.onlineTimer = null;
  }
}

// ============================================================================
// САЙДБАР
// ============================================================================

function renderChatList() {
  const container = document.getElementById("chat-list");
  container.innerHTML = "";

  state.chatList.forEach(chatName => {
    const item = document.createElement("div");
    item.className = "chat-item";
    item.textContent = `#${chatName}`;

    if (state.currentChat && state.currentChat.type === "chat" && state.currentChat.name === chatName) {
      item.classList.add("active");
    }

    item.addEventListener("click", () => openChat(chatName));
    container.appendChild(item);
  });
}

function renderDmList() {
  const container = document.getElementById("dm-list");
  container.innerHTML = "";

  state.dmList.forEach(nickname => {
    const item = document.createElement("div");
    item.className = "dm-item";
    item.textContent = `@${nickname}`;

    if (state.currentChat && state.currentChat.type === "dm" && state.currentChat.name === nickname) {
      item.classList.add("active");
    }

    item.addEventListener("click", () => openDm(nickname));
    container.appendChild(item);
  });
}

function handleNewChat() {
  const name = prompt("Название чата:");

  if (!name) return;

  // Валидация: 1-30 символов, [a-zA-Z0-9_], не начинается с "_", не начинается с "dm_"
  if (name.length < 1 || name.length > 30) {
    alert("Название чата должно быть от 1 до 30 символов");
    return;
  }

  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    alert("Название чата может содержать только буквы, цифры и _");
    return;
  }

  if (name.startsWith("_")) {
    alert("Название чата не может начинаться с _");
    return;
  }

  if (name.startsWith("dm_")) {
    alert("Название чата не может начинаться с dm_");
    return;
  }

  if (state.chatList.includes(name)) {
    alert("Этот чат уже есть в списке");
    return;
  }

  state.chatList.push(name);
  localStorage.setItem("chatList", JSON.stringify(state.chatList));
  renderChatList();
  openChat(name);
}

function handleNewDm() {
  const nicknameRaw = prompt("Ник пользователя:");

  if (!nicknameRaw) return;

  const nickname = nicknameRaw.trim();

  // BUG 8: Валидация ника ЛС
  if (!nickname) {
    alert("Ник не может быть пустым");
    return;
  }

  if (nickname.length < 1 || nickname.length > 20) {
    alert("Ник должен быть от 1 до 20 символов");
    return;
  }

  if (!/^[a-zA-Z0-9_]+$/.test(nickname)) {
    alert("Ник может содержать только буквы, цифры и _");
    return;
  }

  if (state.dmList.includes(nickname)) {
    alert("Этот пользователь уже есть в списке");
    return;
  }

  state.dmList.push(nickname);
  localStorage.setItem("dmList", JSON.stringify(state.dmList));
  renderDmList();
  openDm(nickname);
}

// ============================================================================
// НАВИГАЦИЯ ПО ХЭШУ
// ============================================================================

function parseHashAndOpenChat() {
  // BUG 4: Проверка наличия токена
  if (!state.token) return;

  const hash = location.hash.slice(1); // Убираем #

  if (!hash) {
    document.getElementById("chat-header").textContent = "Выберите чат";
    return;
  }

  if (hash.startsWith("dm:")) {
    const nickname = hash.slice(3);
    // BUG 1: Проверка на дублирование openDm
    if (state.currentChat && state.currentChat.type === "dm" && state.currentChat.name === nickname) return;
    if (!state.dmList.includes(nickname)) {
      state.dmList.push(nickname);
      localStorage.setItem("dmList", JSON.stringify(state.dmList));
    }
    openDm(nickname);
  } else {
    // BUG 1: Проверка на дублирование openChat
    if (state.currentChat && state.currentChat.type === "chat" && state.currentChat.name === hash) return;
    if (!state.chatList.includes(hash)) {
      state.chatList.push(hash);
      localStorage.setItem("chatList", JSON.stringify(state.chatList));
    }
    openChat(hash);
  }
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================================

function init() {
  // Обработчики авторизации
  document.getElementById("btn-login").addEventListener("click", handleLogin);
  document.getElementById("btn-register").addEventListener("click", handleRegister);
  document.getElementById("btn-logout").addEventListener("click", handleLogout);

  // Обработчики сообщений
  document.getElementById("btn-send").addEventListener("click", handleSend);
  document.getElementById("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      handleSend();
    }
  });

  // Обработчики сайдбара
  document.getElementById("btn-new-chat").addEventListener("click", handleNewChat);
  document.getElementById("btn-new-dm").addEventListener("click", handleNewDm);

  // BUG 5: Обработчик мобильного меню
  document.getElementById("menu-toggle").addEventListener("click", function() {
    document.getElementById("sidebar").classList.toggle("visible");
  });

  // Обработчик хэша
  window.addEventListener("hashchange", parseHashAndOpenChat);

  // Проверяем токен
  if (state.token) {
    showChatScreen();
    renderChatList();
    renderDmList();
    parseHashAndOpenChat();
  } else {
    showAuthScreen();
  }
}

document.addEventListener("DOMContentLoaded", init);
