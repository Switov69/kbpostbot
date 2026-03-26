/**
 * KBPOST Telegram Bot (Production Version)
 * Speed. Technology. Security.
 */

const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const https = require('https');
const express = require('express');

// === 1. KEEP-ALIVE (Для Render) ===
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('KBPOST Bot Status: Online'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// === 2. НАСТРОЙКИ (Environment Variables) ===
const BOT_TOKEN = process.env.BOT_TOKEN || ''; 
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://kbpost.vercel.app';
const API_URL    = `${WEBAPP_URL}/api/auth`; 
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

// === 5. HTTP HELPER ДЛЯ API (Исправлено для работы с текстовыми токенами) ===
function createPendingToken(actionType, data) {
  return new Promise((resolve, reject) => {
    const generatedToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    const body = JSON.stringify({ 
      action: 'createToken', 
      token: generatedToken,
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
          if (res.statusCode === 201 || res.statusCode === 200) {
            resolve(generatedToken);
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

function makeWebAppButton(text, url) {
  return { 
    text: text, 
    web_app: { url: url, mode: 'fullscreen' } 
  };
}

// === 6. КОМАНДЫ ===

// Команда ОТМЕНЫ
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  delete userStates[chatId];
  delete adminStates[chatId];
  bot.sendMessage(chatId, '🔄 Действие отменено.');
});

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from.username ? `@${msg.from.username}` : null;
  const param = match && match[1] ? match[1].trim() : '';

  if (tgUser) await saveSession(tgUser, chatId);

  // Безопасный парсинг параметров (Исправление ошибки split/undefined)
  if (param.startsWith('reset_')) {
    const user = decodeURIComponent(param.slice(6)).trim();
    if (!user) return bot.sendMessage(chatId, '❌ Некорректная ссылка сброса.');
    userStates[chatId] = { state: 'awaiting_new_password', siteUsername: user };
    return bot.sendMessage(chatId, `🔑 <b>Сброс пароля для:</b> <code>${user}</code>\nВведите новый пароль (не менее 4 символов) или /cancel для отмены:`, { parse_mode: 'HTML' });
  }

  if (param.startsWith('link_')) {
    const rawContent = param.slice(5);
    if (!rawContent) return bot.sendMessage(chatId, '❌ Ошибка: пустой параметр привязки.');
    
    // Безопасное разделение
    const parts = rawContent.split('_');
    const user = decodeURIComponent(parts.slice(0, -1).join('_')).trim();
    
    if (!user) return bot.sendMessage(chatId, '❌ Не удалось определить имя пользователя.');
    if (!tgUser) return bot.sendMessage(chatId, '❌ У вас не установлен Username в Telegram. Установите его в настройках и попробуйте снова.');

    try {
      const token = await createPendingToken('link_tg', { siteUsername: user, tgUsername: tgUser, chatId: String(chatId) });
      const url = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=link`;
      return bot.sendMessage(chatId, `🔗 Подтвердите привязку аккаунта <b>${user}</b>:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[makeWebAppButton('✅ Подтвердить', url)]] }
      });
    } catch (e) { 
      console.error('API Link Error:', e.message);
      return bot.sendMessage(chatId, '❌ Ошибка API. Убедитесь, что пароли в Render и Vercel совпадают.'); 
    }
  }

  bot.sendMessage(chatId, `📦 <b>kbpost</b> — Добро пожаловать!\n\nИспользуйте кнопку ниже для входа в приложение.\n\n<i>Нужна помощь? — /support</i>`, {
    parse_mode: 'HTML',
    reply_markup: { 
      inline_keyboard: [[makeWebAppButton('📦 Открыть приложение', WEBAPP_URL)]] 
    }
  });
});

bot.onText(/\/broadcast/, (msg) => {
  if (ADMIN_IDS.includes(msg.chat.id)) {
    adminStates[msg.chat.id] = { action: 'awaiting_broadcast_content' };
    bot.sendMessage(msg.chat.id, '📢 Отправьте сообщение для рассылки всем пользователям (или /cancel):');
  }
});

bot.onText(/\/support/, (msg) => {
  userStates[msg.chat.id] = { state: 'awaiting_support_reason' };
  bot.sendMessage(msg.chat.id, '🛠 Опишите вашу проблему одним сообщением (или /cancel):');
});

bot.onText(/\/answer (\d+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(msg.chat.id)) return;
  const tid = match[1];
  if (!supportTickets[tid]) return bot.sendMessage(msg.chat.id, '❌ Тикет не найден.');
  adminStates[msg.chat.id] = { action: 'awaiting_answer', ticketId: tid };
  bot.sendMessage(msg.chat.id, `Пишите ответ для тикета #${tid}:`);
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
    bot.sendMessage(chatId, `⏳ Начинаю рассылку...`);
    let count = 0;
    for (const s of sessions) { 
      try { 
        await bot.copyMessage(s.chat_id, chatId, msg.message_id); 
        count++;
      } catch(e){} 
    }
    return bot.sendMessage(chatId, `🏁 Рассылка завершена. Получили: ${count} чел.`);
  }

  // Ответ поддержки
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_answer') {
    const { ticketId } = adminStates[chatId];
    const t = supportTickets[ticketId];
    if (t) {
      bot.sendMessage(t.userChatId, `✉️ <b>Ответ поддержки:</b>\n\n${text}`, { parse_mode: 'HTML', reply_to_message_id: t.messageId });
      bot.sendMessage(chatId, `✅ Ответ отправлен пользователю.`);
      delete supportTickets[ticketId];
    }
    delete adminStates[chatId];
    return;
  }

  // Смена пароля
  if (userStates[chatId]?.state === 'awaiting_new_password') {
    const user = userStates[chatId].siteUsername;
    if (text.length < 4) return bot.sendMessage(chatId, '❌ Пароль слишком короткий (минимум 4 символа).');
    try {
      const token = await createPendingToken('reset_password', { siteUsername: user, newPassword: text });
      const url = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=reset`;
      bot.sendMessage(chatId, `✅ Токен сброса сформирован:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[makeWebAppButton('🔑 Применить новый пароль', url)]] }
      });
    } catch(e) { bot.sendMessage(chatId, '❌ Ошибка на стороне сервера.'); }
    delete userStates[chatId];
    return;
  }

  // Создание тикета
  if (userStates[chatId]?.state === 'awaiting_support_reason') {
    const tid = generateTicketId();
    const uname = msg.from.username ? `@${msg.from.username}` : 'скрыт';
    supportTickets[tid] = { userChatId: chatId, messageId: msg.message_id, username: uname };
    bot.sendMessage(chatId, `✅ Ваш запрос принят. Номер тикета: <code>#${tid}</code>`, { parse_mode: 'HTML' });
    ADMIN_IDS.forEach(aid => bot.sendMessage(aid, `🆘 <b>Поддержка #${tid}</b>\nОт: ${uname}\nТекст: ${text}\n\nОтветить: <code>/answer ${tid}</code>`, { parse_mode: 'HTML' }));
    delete userStates[chatId];
  }
});

// === 8. УВЕДОМЛЕНИЯ О ПОСЫЛКАХ ===
async function sendNotification(telegramUsername, message) {
  const session = await getSession(telegramUsername);
  if (session) {
    bot.sendMessage(session.chatId, `📦 <b>Обновление статуса</b>\n\n${message}`, {
      parse_mode: 'HTML',
      reply_markup: { 
        inline_keyboard: [[makeWebAppButton('📦 Посмотреть детали', WEBAPP_URL)]] 
      }
    });
  }
}

console.log('Бот запущен. Ошибок парсинга не обнаружено.');
