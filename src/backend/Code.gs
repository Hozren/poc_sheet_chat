// ============================================================================
// Google Sheets Chat Backend
// ============================================================================

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

var CONFIG = {
  SPREADSHEET_ID: "", // Empty - will use active spreadsheet
  MAX_MESSAGES_PER_REQUEST: 50,
  SESSION_EXPIRY_HOURS: 168, // 7 days (24 * 7)
  SYSTEM_SHEETS: ["_users", "_dm_index"]
};

// ============================================================================
// 2. UTILITIES
// ============================================================================

/**
 * Get the active spreadsheet
 */
function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Get or create a sheet by name with appropriate headers
 */
function getOrCreateSheet(name) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(name);

  if (sheet === null) {
    sheet = ss.insertSheet(name);

    // Add headers based on sheet type
    if (name === "_users") {
      sheet.appendRow(["nickname", "password_hash", "session_token", "token_created_at", "created_at"]);
    } else if (name === "_dm_index") {
      sheet.appendRow(["participant1", "participant2", "sheet_name"]);
    } else {
      // Chat sheets (both group and DM)
      sheet.appendRow(["timestamp", "nickname", "text"]);
    }
  }

  return sheet;
}

/**
 * Find user by nickname
 * Returns: { row, nickname, password_hash, session_token, token_created_at, created_at } or null
 */
function findUserByNickname(nickname) {
  var sheet = getOrCreateSheet("_users");
  var data = sheet.getDataRange().getValues();

  // Skip header row
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === nickname) {
      return {
        row: i + 1, // 1-based index for Sheets
        nickname: data[i][0],
        password_hash: data[i][1],
        session_token: data[i][2],
        token_created_at: data[i][3],
        created_at: data[i][4]
      };
    }
  }

  return null;
}

/**
 * Find user by session token
 * Returns: { row, nickname, password_hash, session_token, token_created_at, created_at } or null
 * Checks token expiration
 */
function findUserByToken(token) {
  var sheet = getOrCreateSheet("_users");
  var data = sheet.getDataRange().getValues();

  // Skip header row
  for (var i = 1; i < data.length; i++) {
    if (data[i][2] === token) {
      var user = {
        row: i + 1,
        nickname: data[i][0],
        password_hash: data[i][1],
        session_token: data[i][2],
        token_created_at: data[i][3],
        created_at: data[i][4]
      };

      // Check token expiration
      var tokenCreated = new Date(user.token_created_at);
      var now = new Date();
      var hoursDiff = (now - tokenCreated) / (1000 * 60 * 60);

      if (hoursDiff > CONFIG.SESSION_EXPIRY_HOURS) {
        return null; // Token expired
      }

      return user;
    }
  }

  return null;
}

/**
 * Generate a unique token
 */
function generateToken() {
  return Utilities.getUuid();
}

/**
 * Create JSON response
 */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Get DM sheet name for two users (sorted alphabetically)
 */
function getDmSheetName(nick1, nick2) {
  var sorted = [nick1, nick2].sort();
  return "dm_" + sorted[0] + "_" + sorted[1];
}

// ============================================================================
// 3. VALIDATION HELPERS
// ============================================================================

/**
 * Validate nickname format
 */
function validateNickname(nickname) {
  if (!nickname || typeof nickname !== "string") {
    return false;
  }
  if (nickname.length < 1 || nickname.length > 20) {
    return false;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(nickname)) {
    return false;
  }
  if (CONFIG.SYSTEM_SHEETS.indexOf(nickname) !== -1) {
    return false;
  }
  return true;
}

/**
 * Validate password hash (64 hex characters for SHA-256)
 */
function validatePasswordHash(hash) {
  if (!hash || typeof hash !== "string") {
    return false;
  }
  if (hash.length !== 64) {
    return false;
  }
  if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
    return false;
  }
  return true;
}

/**
 * Validate chat name
 */
function validateChatName(chat) {
  if (!chat || typeof chat !== "string") {
    return false;
  }
  if (chat.length < 1 || chat.length > 30) {
    return false;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(chat)) {
    return false;
  }
  if (chat.charAt(0) === "_") {
    return false;
  }
  if (chat.indexOf("dm_") === 0) {
    return false;
  }
  return true;
}

/**
 * Validate message text
 */
function validateText(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  var trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 1000) {
    return false;
  }
  return true;
}

// ============================================================================
// 4. REQUEST HANDLERS
// ============================================================================

/**
 * Handle user registration
 */
function handleRegister(data) {
  // BUG FIX 2: Lock to prevent race conditions
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Validation
    if (!validateNickname(data.nickname)) {
      return { ok: false, error: "invalid_nickname" };
    }

    if (!validatePasswordHash(data.password_hash)) {
      return { ok: false, error: "invalid_password_hash" };
    }

    // Check if nickname already exists
    if (findUserByNickname(data.nickname) !== null) {
      return { ok: false, error: "nickname_taken" };
    }

    // Generate session token
    var token = generateToken();
    var now = new Date().toISOString();

    // Add user to _users sheet
    var sheet = getOrCreateSheet("_users");
    sheet.appendRow([
      data.nickname,
      data.password_hash,
      token,
      now,
      now
    ]);

    return {
      ok: true,
      token: token,
      nickname: data.nickname
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Handle user login
 */
function handleLogin(data) {
  // BUG FIX 4: Validate input data
  if (!validateNickname(data.nickname)) {
    return { ok: false, error: "invalid_credentials" };
  }

  if (!validatePasswordHash(data.password_hash)) {
    return { ok: false, error: "invalid_credentials" };
  }

  // Find user by nickname
  var user = findUserByNickname(data.nickname);

  if (user === null) {
    return { ok: false, error: "invalid_credentials" };
  }

  // Verify password
  if (user.password_hash !== data.password_hash) {
    return { ok: false, error: "invalid_credentials" };
  }

  // Generate new session token
  var token = generateToken();
  var now = new Date().toISOString();

  // Update user's session token
  var sheet = getOrCreateSheet("_users");
  sheet.getRange(user.row, 3).setValue(token); // session_token column
  sheet.getRange(user.row, 4).setValue(now);   // token_created_at column

  return {
    ok: true,
    token: token,
    nickname: user.nickname
  };
}

/**
 * Handle sending a message to a group chat
 */
function handleSend(data) {
  // Authenticate user
  var user = findUserByToken(data.token);
  if (user === null) {
    return { ok: false, error: "unauthorized" };
  }

  // Validate chat name
  if (!validateChatName(data.chat)) {
    return { ok: false, error: "invalid_chat_name" };
  }

  // Validate message text
  if (!validateText(data.text)) {
    return { ok: false, error: "invalid_text" };
  }

  // Get or create chat sheet
  var sheet = getOrCreateSheet(data.chat);

  // Add message
  var now = new Date().toISOString();
  sheet.appendRow([
    now,
    user.nickname,
    data.text.trim()
  ]);

  return { ok: true };
}

/**
 * Handle fetching messages from a group chat
 */
function handleMessages(data) {
  // Authenticate user
  var user = findUserByToken(data.token);
  if (user === null) {
    return { ok: false, error: "unauthorized" };
  }

  // BUG FIX 1: Validate chat name to prevent access to system sheets
  if (!data.chat || typeof data.chat !== "string") {
    return { ok: false, error: "invalid_chat_name" };
  }
  if (CONFIG.SYSTEM_SHEETS.indexOf(data.chat) !== -1) {
    return { ok: false, error: "invalid_chat_name" };
  }
  if (data.chat.charAt(0) === "_") {
    return { ok: false, error: "invalid_chat_name" };
  }
  if (data.chat.indexOf("dm_") === 0) {
    return { ok: false, error: "invalid_chat_name" };
  }

  // Get chat sheet
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(data.chat);

  // If chat doesn't exist, return empty messages
  if (sheet === null) {
    return { ok: true, messages: [] };
  }

  // Get all data
  var allData = sheet.getDataRange().getValues();

  // Skip header row
  var rows = allData.slice(1);

  // Filter by 'after' timestamp if provided
  if (data.after) {
    rows = rows.filter(function(row) {
      // Convert to ISO string (Google Sheets may return Date object)
      var timestamp = row[0] instanceof Date ? row[0].toISOString() : String(row[0]);
      return timestamp > data.after;
    });
  }

  // Take last MAX_MESSAGES_PER_REQUEST messages
  var limit = CONFIG.MAX_MESSAGES_PER_REQUEST;
  if (rows.length > limit) {
    rows = rows.slice(rows.length - limit);
  }

  // Map to message objects
  var messages = rows.map(function(row) {
    var timestamp = row[0] instanceof Date ? row[0].toISOString() : String(row[0]);
    return {
      timestamp: timestamp,
      nickname: row[1],
      text: row[2]
    };
  });

  return { ok: true, messages: messages };
}

/**
 * Handle sending a direct message
 */
function handleSendDm(data) {
  // BUG FIX 2: Lock to prevent race conditions in _dm_index
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Authenticate user
    var user = findUserByToken(data.token);
    if (user === null) {
      return { ok: false, error: "unauthorized" };
    }

    // Validate recipient
    if (!data.to || data.to === user.nickname) {
      return { ok: false, error: "invalid_recipient" };
    }

    // Validate message text
    if (!validateText(data.text)) {
      return { ok: false, error: "invalid_text" };
    }

    // Check if recipient exists
    var recipient = findUserByNickname(data.to);
    if (recipient === null) {
      return { ok: false, error: "user_not_found" };
    }

    // Get DM sheet name
    var sheetName = getDmSheetName(user.nickname, data.to);

    // Get or create DM sheet
    var sheet = getOrCreateSheet(sheetName);

    // Update _dm_index if not already present
    var indexSheet = getOrCreateSheet("_dm_index");
    var indexData = indexSheet.getDataRange().getValues();
    var sorted = [user.nickname, data.to].sort();
    var found = false;

    // Skip header row and check for existing entry
    for (var i = 1; i < indexData.length; i++) {
      if ((indexData[i][0] === sorted[0] && indexData[i][1] === sorted[1]) ||
          (indexData[i][0] === sorted[1] && indexData[i][1] === sorted[0])) {
        found = true;
        break;
      }
    }

    // Add to index if new conversation
    if (!found) {
      indexSheet.appendRow([sorted[0], sorted[1], sheetName]);
    }

    // Add message
    var now = new Date().toISOString();
    sheet.appendRow([
      now,
      user.nickname,
      data.text.trim()
    ]);

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Handle fetching direct messages
 */
function handleDmMessages(data) {
  // Authenticate user
  var user = findUserByToken(data.token);
  if (user === null) {
    return { ok: false, error: "unauthorized" };
  }

  // BUG FIX 3: Validate recipient
  if (!data.with || typeof data.with !== "string") {
    return { ok: false, error: "invalid_recipient" };
  }

  // Get DM sheet name
  var sheetName = getDmSheetName(user.nickname, data.with);

  // Get DM sheet
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);

  // If conversation doesn't exist, return empty messages
  if (sheet === null) {
    return { ok: true, messages: [] };
  }

  // Get all data
  var allData = sheet.getDataRange().getValues();

  // Skip header row
  var rows = allData.slice(1);

  // Filter by 'after' timestamp if provided
  if (data.after) {
    rows = rows.filter(function(row) {
      // Convert to ISO string (Google Sheets may return Date object)
      var timestamp = row[0] instanceof Date ? row[0].toISOString() : String(row[0]);
      return timestamp > data.after;
    });
  }

  // Take last MAX_MESSAGES_PER_REQUEST messages
  var limit = CONFIG.MAX_MESSAGES_PER_REQUEST;
  if (rows.length > limit) {
    rows = rows.slice(rows.length - limit);
  }

  // Map to message objects
  var messages = rows.map(function(row) {
    var timestamp = row[0] instanceof Date ? row[0].toISOString() : String(row[0]);
    return {
      timestamp: timestamp,
      nickname: row[1],
      text: row[2]
    };
  });

  return { ok: true, messages: messages };
}

/**
 * Handle fetching online users for a chat
 */
function handleUsersOnline(data) {
  // Authenticate user
  var user = findUserByToken(data.token);
  if (user === null) {
    return { ok: false, error: "unauthorized" };
  }

  // BUG FIX 1: Validate chat name to prevent access to system sheets
  if (!data.chat || typeof data.chat !== "string") {
    return { ok: false, error: "invalid_chat_name" };
  }
  if (CONFIG.SYSTEM_SHEETS.indexOf(data.chat) !== -1) {
    return { ok: false, error: "invalid_chat_name" };
  }
  if (data.chat.charAt(0) === "_") {
    return { ok: false, error: "invalid_chat_name" };
  }
  if (data.chat.indexOf("dm_") === 0) {
    return { ok: false, error: "invalid_chat_name" };
  }

  // Get chat sheet
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(data.chat);

  // If chat doesn't exist, return empty users
  if (sheet === null) {
    return { ok: true, users: [] };
  }

  // Get all data
  var allData = sheet.getDataRange().getValues();

  // Skip header row
  var rows = allData.slice(1);

  // Get current time and 5 minutes ago
  var now = new Date();
  var fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  // Collect unique nicknames from messages in last 5 minutes
  var uniqueUsers = {};

  for (var i = 0; i < rows.length; i++) {
    var timestamp = rows[i][0] instanceof Date ? rows[i][0] : new Date(rows[i][0]);

    if (timestamp >= fiveMinutesAgo) {
      var nickname = rows[i][1];
      uniqueUsers[nickname] = true;
    }
  }

  // Convert to array
  var users = Object.keys(uniqueUsers);

  return { ok: true, users: users };
}

// ============================================================================
// 5. MAIN ENTRY POINT
// ============================================================================

/**
 * Main entry point for all POST requests
 */
function doPost(e) {
  try {
    // Parse JSON from request body
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    // Route to appropriate handler
    var result;

    switch (action) {
      case "register":
        result = handleRegister(data);
        break;

      case "login":
        result = handleLogin(data);
        break;

      case "send":
        result = handleSend(data);
        break;

      case "messages":
        result = handleMessages(data);
        break;

      case "send_dm":
        result = handleSendDm(data);
        break;

      case "dm_messages":
        result = handleDmMessages(data);
        break;

      case "users_online":
        result = handleUsersOnline(data);
        break;

      default:
        result = { ok: false, error: "unknown_action" };
        break;
    }

    return jsonResponse(result);

  } catch (error) {
    // Return internal error for any uncaught exceptions
    return jsonResponse({ ok: false, error: "internal_error" });
  }
}
