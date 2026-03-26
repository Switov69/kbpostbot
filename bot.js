/**
 * KBPOST Telegram Bot (Production Version)
 * Speed. Technology. Security.
 */

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const https = require('https');
const express = require('express');

// === 1. KEEP-ALIVE ===
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('KBPOST Bot Status: Online'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// === 2. НАСТРОЙКИ (Environment Variables) ===
const BOT_TOKEN = process.env.BOT_TOKEN || ''; 
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://kbpost.vercel.app';
const API_URL    = `${WEBAPP_URL}/api/auth`; // Путь к объединенному API
const BOT_SECRET = process.env.BOT_SECRET || ''; 
const ADMIN_IDS  = [1746547600, 1946939976];

// === 3. ПОДКЛЮЧЕНИЕ К NEON POSTGRES ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// === 4. ФУНКЦИИ БД ===
async function saveSession(tgUsername, chatId) {
  if (!tgUsername) return;
  const user = tgUsername.toLowerCase().replace('@', '');
  try {
    await pool.query(
      'INSERT INTO user_sessions (tg_username, chat_id, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (tg_username) DO UPDATE SET chat_id = $2, updated_at = NOW()',
      [user, chatId]
    );
  } catch (err) { console.error('DB Error (saveSession):', err); }
}

async function getSession(tgUsername) {
  const user = tgUsername.toLowerCase().replace('@', '');
  try {
    const res = await pool.query('SELECT chat_id FROM user_sessions WHERE tg_username = $1', [user]);
    return res.rows[0] ? { chatId: res.rows[0].chat_id } : null;
  } catch (err) { return null; }
}

async function getAllSessions() {
  try {
    const res = await pool.query('SELECT chat_id FROM user_sessions');
    return res.rows;
  } catch (err) { return []; }
}

// === 5. HTTP HELPER ДЛЯ API (FIXED FOR UNIFIED API) ===
function createPendingToken(actionType, data) {
  return new Promise((resolve, reject) => {
    // Теперь передаем action: 'createToken' внутри тела запроса
    const body = JSON.stringify({ 
      action: 'createToken', 
      actionType, 
      data 
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-bot-secret': BOT_SECRET,
      },
    };

    const req = https.request(API_URL, options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if ((res.statusCode === 201 || res.statusCode === 200) && parsed.token) {
            resolve(parsed.token);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supportTickets = {};
const adminStates = {};
const userStates = {};

function generateTicketId() {
  let id;
  do { id = Math.floor(100 + Math.random() * 900).toString(); } while (supportTickets[id]);
  return id;
}

// Кнопка с режимом Fullscreen
function makeWebAppButton(text, url) {
  return { text, web_app: { url, mode: 'fullscreen' } };
}

// === 6. КОМАНДЫ ===
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from.username ? `@${msg.from.username}` : null;
  const param = match && match[1] ? match[1].trim() : '';

  if (tgUser) await saveSession(tgUser, chatId);

  // Обработка сброса пароля
  if (param.startsWith('reset_')) {
    const user = decodeURIComponent(param.slice(6)).trim();
    userStates[chatId] = { state: 'awaiting_new_password', siteUsername: user };
    return bot.sendMessage(chatId, `🔑 <b>Сброс пароля:</b> <code>${user}</code>\nВведите новый пароль (мин. 4 символа):`, { parse_mode: 'HTML' });
  }

  // Обработка привязки аккаунта
  if (param.startsWith('link_')) {
    const user = decodeURIComponent(param.slice(5).split('_').slice(0, -1).join('_')).trim();
    if (!tgUser) return bot.sendMessage(chatId, '❌ Установите Username в настройках Telegram!');
    try {
      const token = await createPendingToken('link_tg', { siteUsername: user, tgUsername: tgUser, chatId: String(chatId) });
      const url = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=link`;
      return bot.sendMessage(chatId, `🔗 Привязка к <code>${user}</code>:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[makeWebAppButton('✅ Подтвердить', url)]] }
      });
    } catch (e) { 
      console.error('API Error:', e.message);
      return bot.sendMessage(chatId, '❌ Ошибка API. Убедитесь, что сайт и база активны.'); 
    }
  }

  // Стандартное приветствие
  bot.sendMessage(chatId, `📦 <b>kbpost</b> — Онлайн\n\nНажмите кнопку для входа.\n<i>Нужна помощь? Используйте /support</i>`, {
    parse_mode: 'HTML',
    reply_markup: { 
        inline_keyboard: [[makeWebAppButton('📦 Открыть приложение', WEBAPP_URL)]] 
    }
  });
});

bot.onText(/\/broadcast/, (msg) => {
  if (ADMIN_IDS.includes(msg.chat.id)) {
    adminStates[msg.chat.id] = { action: 'awaiting_broadcast_content' };
    bot.sendMessage(msg.chat.id, '📢 Отправьте сообщение для рассылки:');
  }
});

bot.onText(/\/support/, (msg) => {
  userStates[msg.chat.id] = { state: 'awaiting_support_reason' };
  bot.sendMessage(msg.chat.id, '🛠 Опишите проблему одним сообщением:');
});

bot.onText(/\/answer (\d+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(msg.chat.id)) return;
  const tid = match[1];
  if (!supportTickets[tid]) return bot.sendMessage(msg.chat.id, '❌ Тикет не найден.');
  adminStates[msg.chat.id] = { action: 'awaiting_answer', ticketId: tid };
  bot.sendMessage(msg.chat.id, `Пишите ответ для #${tid}:`);
});

// === 7. ОБРАБОТКА ТЕКСТА ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  // Рассылка
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_broadcast_content') {
    delete adminStates[chatId];
    const sessions = await getAllSessions();
    bot.sendMessage(chatId, `⏳ Рассылка на ${sessions.length} чел...`);
    for (const s of sessions) { try { await bot.copyMessage(s.chat_id, chatId, msg.message_id); } catch(e){} }
    return bot.sendMessage(chatId, '🏁 Готово!');
  }

  // Ответ админа
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_answer') {
    const { ticketId } = adminStates[chatId];
    const t = supportTickets[ticketId];
    if (t) {
      bot.sendMessage(t.userChatId, `✉️ <b>Ответ поддержки:</b>\n\n${text}`, { parse_mode: 'HTML', reply_to_message_id: t.messageId });
      bot.sendMessage(chatId, `✅ Отправлено!`);
      delete supportTickets[ticketId];
    }
    delete adminStates[chatId];
    return;
  }

  // Смена пароля
  if (userStates[chatId]?.state === 'awaiting_new_password') {
    const user = userStates[chatId].siteUsername;
    if (text.length < 4) return bot.sendMessage(chatId, '❌ Пароль слишком короткий!');
    try {
      const token = await createPendingToken('reset_password', { siteUsername: user, newPassword: text });
      const url = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=reset`;
      bot.sendMessage(chatId, `✅ Пароль готов к применению:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[makeWebAppButton('🔑 Применить', url)]] }
      });
    } catch(e) { bot.sendMessage(chatId, '❌ Ошибка сброса.'); }
    delete userStates[chatId];
    return;
  }

  // Поддержка
  if (userStates[chatId]?.state === 'awaiting_support_reason') {
    const tid = generateTicketId();
    const uname = msg.from.username ? `@${msg.from.username}` : 'скрыт';
    supportTickets[tid] = { userChatId: chatId, messageId: msg.message_id, username: uname };
    bot.sendMessage(chatId, `✅ Запрос отправлен! Тикет: <code>#${tid}</code>`, { parse_mode: 'HTML' });
    ADMIN_IDS.forEach(aid => bot.sendMessage(aid, `🆘 <b>Поддержка #${tid}</b>\nОт: ${uname}\nТекст: ${text}\n\n<code>/answer ${tid}</code>`, { parse_mode: 'HTML' }));
    delete userStates[chatId];
  }
});

// === 8. УВЕДОМЛЕНИЯ ===
async function sendNotification(telegramUsername, message) {
  const session = await getSession(telegramUsername);
  if (session) {
    bot.sendMessage(session.chatId, `📦 <b>kbpost</b>\n\n${message}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[makeWebAppButton('📦 Открыть', WEBAPP_URL)]] }
    });
  }
}

console.log('Бот успешно запущен и готов к работе!');
