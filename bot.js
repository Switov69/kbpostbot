/**
 * KBPOST Telegram Bot
 * Speed. Technology. Security.
 */

const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');
const express = require('express');

// === KEEP-ALIVE СЕРВЕР ===
const app = express();
const PORT = process.env.PORT || 3000; 

app.get('/', (req, res) => {
  res.send('KBPOST Bot is running 24/7');
});

app.listen(PORT, () => {
  console.log(`Keep-alive server is running on port ${PORT}`);
});

// === НАСТРОЙКИ ===
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = 'https://kbpost.vercel.app';
const API_BASE   = 'https://kbpost.vercel.app/api';
const BOT_SECRET = process.env.BOT_SECRET || '';

// ID аккаунтов админов
const ADMIN_IDS = [1746547600, 1946939976];

// === БАЗА ДАННЫХ (локальная для сессий бота) ===
const db = new Database(path.join(__dirname, 'bot_data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    tg_username TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
`);

function saveSession(tgUsername, chatId) {
  if (!tgUsername) return;
  db.prepare('INSERT OR REPLACE INTO user_sessions (tg_username, chat_id, updated_at) VALUES (?, ?, strftime(\'%s\', \'now\'))').run(
    tgUsername.toLowerCase().replace('@', ''), chatId
  );
}

function getSession(tgUsername) {
  const row = db.prepare('SELECT chat_id FROM user_sessions WHERE tg_username = ?').get(
    tgUsername.toLowerCase().replace('@', '')
  );
  return row ? { chatId: row.chat_id } : null;
}

function getAllSessions() {
  return db.prepare('SELECT chat_id FROM user_sessions').all();
}

// === HTTP helper — создаёт токен в Neon через API ===
function createPendingToken(actionType, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ actionType, data });
    const url = new URL(`${API_BASE}/auth/create-token`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-bot-secret':   BOT_SECRET,
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode === 201 && parsed.token) resolve(parsed.token);
          else reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        } catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Состояния в памяти
const supportTickets = {};
const adminStates = {};
const userStates = {};

console.log('🚀 KBPOST bot запущен!');

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===
function generateTicketId() {
  let id;
  do { id = Math.floor(100 + Math.random() * 900).toString(); }
  while (supportTickets[id]);
  return id;
}

// Открываем mini-app в ПОЛНОЭКРАННОМ режиме (expand: true)
function makeWebAppButton(text, url) {
  return { text, web_app: { url } };
}

// === КОМАНДА START ===
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramUsername = msg.from.username ? `@${msg.from.username}` : null;
  const param = match && match[1] ? match[1].trim() : '';

  if (telegramUsername) saveSession(telegramUsername, chatId);

  // === DEEP LINK: сброс пароля ===
  if (param.startsWith('reset_')) {
    const siteUsername = decodeURIComponent(param.slice(6)).trim();
    if (!siteUsername) {
      return bot.sendMessage(chatId, '❌ <b>Неверная команда сброса пароля.</b>', { parse_mode: 'HTML' });
    }

    userStates[chatId] = { state: 'awaiting_new_password', siteUsername };
    return bot.sendMessage(chatId,
      `🔑 <b>Сброс пароля kbpost</b>\n\nАккаунт: <code>${siteUsername}</code>\n\nОтправьте новый пароль (минимум 4 символа).\n\nДля отмены введите /cancel`,
      { parse_mode: 'HTML' }
    );
  }

  // === DEEP LINK: привязка Telegram ===
  if (param.startsWith('link_')) {
    const parts = param.slice(5).split('_');
    if (parts.length < 2) {
      return bot.sendMessage(chatId, '❌ <b>Неверная команда привязки.</b>', { parse_mode: 'HTML' });
    }
    const legacyToken = parts[parts.length - 1];
    const siteUsername = decodeURIComponent(parts.slice(0, -1).join('_')).trim();

    if (!telegramUsername) {
      return bot.sendMessage(chatId,
        '❌ <b>Не удалось определить ваш Telegram username.</b>\n\nУстановите username в настройках Telegram и попробуйте снова.',
        { parse_mode: 'HTML' }
      );
    }

    saveSession(telegramUsername, chatId);

    // Пробуем создать токен через новый API
    let callbackUrl;
    try {
      const token = await createPendingToken('link_tg', {
        siteUsername,
        tgUsername: telegramUsername,
        chatId: String(chatId),
      });
      // Новый формат — только UUID токен, без данных в URL
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=link`;
    } catch (err) {
      console.error('createPendingToken error:', err.message);
      // Фолбэк на старый формат (если API недоступен)
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=link&user=${encodeURIComponent(siteUsername)}&tg=${encodeURIComponent(telegramUsername)}&token=${encodeURIComponent(legacyToken)}&cid=${chatId}`;
    }

    return bot.sendMessage(chatId,
      `🔗 <b>Привязка Telegram к kbpost</b>\n\nАккаунт kbpost: <code>${siteUsername}</code>\nTelegram: ${telegramUsername}\n\nНажмите кнопку ниже чтобы подтвердить привязку:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[makeWebAppButton('✅ Подтвердить привязку', callbackUrl)]]
        }
      }
    );
  }

  // === Обычный /start ===
  return bot.sendMessage(chatId,
    `📦 <b>kbpost</b> — Speed. Technology. Security.\n\n🚀 <b>Mini App:</b> Нажмите кнопку ниже для управления посылками.\n\n🎧 <b>Поддержка:</b> Если возникла проблема, введите /support`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[makeWebAppButton('📦 Открыть kbpost', WEBAPP_URL)]]
      }
    }
  );
});

// === РАССЫЛКА ===
bot.onText(/\/broadcast/, (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  adminStates[chatId] = { action: 'awaiting_broadcast_content' };
  bot.sendMessage(chatId, '📢 <b>Рассылка</b>\n\nОтправьте сообщение для рассылки.\n\nДля отмены введите /cancel', { parse_mode: 'HTML' });
});

// === ОТМЕНА ===
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  let reset = false;
  if (userStates[chatId])  { delete userStates[chatId];  reset = true; }
  if (adminStates[chatId]) { delete adminStates[chatId]; reset = true; }
  bot.sendMessage(chatId, reset ? '❌ <b>Действие отменено.</b>' : 'У вас нет активных действий.', { parse_mode: 'HTML' });
});

// === ПОДДЕРЖКА ===
bot.onText(/\/support/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { state: 'awaiting_support_reason' };
  bot.sendMessage(chatId, '🛠 <b>Поддержка</b>\n\nОпишите проблему одним сообщением.\n\nДля отмены введите /cancel', { parse_mode: 'HTML' });
});

// === ОТВЕТ АДМИНА ===
bot.onText(/\/answer (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  const ticketId = match[1];
  if (!supportTickets[ticketId]) return bot.sendMessage(chatId, '❌ Тикет не найден или закрыт.');
  adminStates[chatId] = { action: 'awaiting_answer', ticketId };
  bot.sendMessage(chatId, `Напишите ответ для тикета <b>#${ticketId}</b>:\n\nДля отмены введите /cancel`, { parse_mode: 'HTML' });
});

// === ОБРАБОТКА СООБЩЕНИЙ ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (text && text.startsWith('/')) return;

  // Рассылка
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_broadcast_content') {
    delete adminStates[chatId];
    const sessions = getAllSessions();
    let success = 0, failed = 0;
    bot.sendMessage(chatId, `⏳ Рассылка на ${sessions.length} пользователей...`);
    for (const s of sessions) {
      try { await bot.copyMessage(s.chat_id, chatId, msg.message_id); success++; }
      catch { failed++; }
    }
    bot.sendMessage(chatId, `🏁 <b>Рассылка завершена!</b>\n\n✅ Успешно: ${success}\n❌ Ошибок: ${failed}`, { parse_mode: 'HTML' });
    return;
  }

  // Ответ на тикет
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_answer') {
    const { ticketId } = adminStates[chatId];
    const ticket = supportTickets[ticketId];
    if (ticket) {
      bot.sendMessage(ticket.userChatId, `✉️ <b>Ответ от поддержки:</b>\n\n${text}`, {
        parse_mode: 'HTML',
        reply_to_message_id: ticket.messageId
      });
      bot.sendMessage(chatId, `✅ Ответ отправлен пользователю ${ticket.username}`);
      delete supportTickets[ticketId];
    }
    delete adminStates[chatId];
    return;
  }

  // Сброс пароля
  if (userStates[chatId]?.state === 'awaiting_new_password') {
    const { siteUsername } = userStates[chatId];
    const newPassword = text ? text.trim() : '';

    if (!newPassword || newPassword.length < 4) {
      return bot.sendMessage(chatId,
        '❌ <b>Пароль слишком короткий.</b>\n\nМинимум 4 символа. Попробуйте снова или /cancel',
        { parse_mode: 'HTML' }
      );
    }

    // Создаём pending_action токен для сброса пароля
    let callbackUrl;
    try {
      const token = await createPendingToken('reset_password', { siteUsername });
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=reset`;
    } catch (err) {
      console.error('createPendingToken reset error:', err.message);
      // Фолбэк — старый формат
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=reset&user=${encodeURIComponent(siteUsername)}&pwd=${encodeURIComponent(newPassword)}`;
    }

    bot.sendMessage(chatId,
      `✅ <b>Новый пароль готов!</b>\n\nАккаунт: <code>${siteUsername}</code>\n\nНажмите кнопку чтобы применить пароль:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[makeWebAppButton('🔑 Применить и войти', callbackUrl)]]
        }
      }
    );

    delete userStates[chatId];
    return;
  }

  // Поддержка
  if (userStates[chatId]?.state === 'awaiting_support_reason') {
    const ticketId = generateTicketId();
    const username = msg.from.username ? `@${msg.from.username}` : 'скрыт';
    supportTickets[ticketId] = { userChatId: chatId, messageId: msg.message_id, username };
    bot.sendMessage(chatId, `✅ <b>Запрос отправлен!</b>\n\nТикет: <code>#${ticketId}</code>\nОжидайте ответа.`, { parse_mode: 'HTML' });
    ADMIN_IDS.forEach(adminId => {
      bot.sendMessage(adminId,
        `🆘 <b>Новый запрос в поддержку!</b>\n\nОт: ${username}\nСообщение: <b>${text || '[Медиафайл]'}</b>\n\nОтветить: <code>/answer ${ticketId}</code>`,
        { parse_mode: 'HTML' }
      );
    });
    delete userStates[chatId];
    return;
  }
});

// === ФУНКЦИИ УВЕДОМЛЕНИЙ ===
function sendNotification(telegramUsername, message) {
  const session = getSession(telegramUsername);
  if (session) {
    bot.sendMessage(session.chatId, `📦 <b>kbpost</b>\n\n${message}`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[makeWebAppButton('📦 Открыть kbpost', WEBAPP_URL)]]
      }
    });
  } else {
    console.log(`⚠️ Пользователь ${telegramUsername} не найден в БД`);
  }
}

function notifyParcelCreated(senderTg, receiverTg, ttn) {
  sendNotification(senderTg, `📤 Вы создали новую посылку\nТТН: <code>${ttn}</code>`);
  sendNotification(receiverTg, `📥 Для вас создана новая посылка!\nТТН: <code>${ttn}</code>`);
}

function notifyStatusChange(senderTg, receiverTg, ttn, newStatus) {
  const message = `🔄 Статус посылки <code>${ttn}</code> обновлён\nНовый статус: <b>${newStatus}</b>`;
  sendNotification(senderTg, message);
  sendNotification(receiverTg, message);
}

function notifyPayment(senderTg, receiverTg, ttn, amount) {
  sendNotification(receiverTg, `💳 Оплата подтверждена!\nТТН: <code>${ttn}</code>\nСумма: ${amount} кбк`);
  sendNotification(senderTg, `💰 Получен перевод за посылку\nТТН: <code>${ttn}</code>\nСумма: ${amount} кбк`);
}

module.exports = { sendNotification, notifyParcelCreated, notifyStatusChange, notifyPayment, db };
