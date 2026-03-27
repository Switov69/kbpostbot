/**
 * KBPOST Telegram Bot
 * Работает на Render.com, подключается к той же Neon Postgres, что и сайт.
 * 
 * Переменные окружения (задать в Render → Environment):
 *   DATABASE_URL  — строка подключения к Neon (та же что у Vercel)
 *   BOT_TOKEN     — токен бота от @BotFather
 *   BOT_SECRET    — секрет для проверки запросов с сайта к /api/auth (createToken)
 *   WEBAPP_URL    — URL сайта (https://kbpost.vercel.app)
 */

const TelegramBot  = require('node-telegram-bot-api');
const { neon }     = require('@neondatabase/serverless');
const bcrypt       = require('bcryptjs');
const https        = require('https');

// ===== КОНФИГ (берётся из переменных окружения) =====
const BOT_TOKEN  = process.env.BOT_TOKEN  || '8656385676:AAFY7HZ5AhAhDl_60oz3wqczjTOBnPEanzw';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://kbpost.vercel.app';
const BOT_SECRET = process.env.BOT_SECRET || '7d5dc33e5de4ea38e964155dbd42ec13';
const DB_URL     = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('❌ DATABASE_URL не задан! Бот не может запуститься без БД.');
  process.exit(1);
}

// ===== ПОДКЛЮЧЕНИЕ К NEON =====
const sql = neon(DB_URL);

// ===== ИНИЦИАЛИЗАЦИЯ БД (создание таблиц если не существуют) =====
async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        balance       INTEGER NOT NULL DEFAULT 0,
        telegram_id   TEXT UNIQUE,
        citizenship   TEXT NOT NULL DEFAULT '',
        account       TEXT NOT NULL DEFAULT '',
        is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        token      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS parcels (
        id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ttn                        TEXT UNIQUE NOT NULL,
        sender_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_username            TEXT NOT NULL,
        receiver_username          TEXT NOT NULL,
        status                     INTEGER NOT NULL DEFAULT 1,
        status_history             JSONB NOT NULL DEFAULT '[]',
        description                TEXT NOT NULL DEFAULT '',
        from_branch_id             TEXT NOT NULL DEFAULT '',
        to_branch_id               TEXT,
        to_coordinates             TEXT,
        cash_on_delivery           BOOLEAN NOT NULL DEFAULT FALSE,
        cash_on_delivery_amount    INTEGER NOT NULL DEFAULT 0,
        cash_on_delivery_paid      BOOLEAN NOT NULL DEFAULT FALSE,
        cash_on_delivery_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS pending_actions (
        token       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        action_type TEXT NOT NULL,
        data        JSONB NOT NULL DEFAULT '{}',
        expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS branches (
        id          TEXT PRIMARY KEY,
        number      INTEGER NOT NULL,
        region      TEXT NOT NULL,
        prefecture  TEXT NOT NULL DEFAULT '',
        address     TEXT NOT NULL DEFAULT ''
      )
    `;

    // Дефолтные отделения
    await sql`
      INSERT INTO branches (id, number, region, prefecture, address)
      VALUES
        ('br_stolica_1',   1, 'Столица',  'Holeland',   'аскб авеню, 6'),
        ('br_antegriya_1', 1, 'Антегрия', 'Данюшатаун', '')
      ON CONFLICT (id) DO NOTHING
    `;

    // Аккаунт администратора (admin / admin8961)
    await sql`
      INSERT INTO users (id, username, password_hash, telegram_id, citizenship, account, is_admin)
      VALUES (
        '00000000-0000-0000-0000-000000000001',
        'admin',
        '$2b$10$YQfR.A/Bc0P1VeXvJ5k6oOb0YjnwJyGl.0EGQ8.bXWR1Mm/0j2Jny',
        'admin',
        'Столица',
        'Свит',
        TRUE
      )
      ON CONFLICT (id) DO UPDATE SET
        username      = EXCLUDED.username,
        password_hash = EXCLUDED.password_hash,
        is_admin      = TRUE
    `;

    console.log('✅ БД инициализирована');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ БД =====

async function getUserByTelegram(tgUsername) {
  // tgUsername без @, нижний регистр
  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  const rows = await sql`SELECT * FROM users WHERE telegram_id = ${norm} LIMIT 1`;
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const rows = await sql`SELECT * FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
  return rows[0] || null;
}

async function saveTelegramId(userId, tgUsername) {
  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  await sql`UPDATE users SET telegram_id = ${norm} WHERE id = ${userId}::uuid`;
}

async function createPendingToken(actionType, data) {
  const rows = await sql`
    INSERT INTO pending_actions (action_type, data)
    VALUES (${actionType}, ${JSON.stringify(data)}::jsonb)
    RETURNING token
  `;
  return rows[0].token;
}

async function getUserParcels(userId) {
  return sql`
    SELECT * FROM parcels
    WHERE sender_id = ${userId}::uuid OR receiver_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT 10
  `;
}

// ===== УВЕДОМЛЕНИЯ =====

async function sendTgMessage(chatId, text, withAppButton = true) {
  if (!chatId) return;
  try {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(withAppButton ? {
        reply_markup: {
          inline_keyboard: [[{ text: '📦 Открыть kbpost', web_app: { url: WEBAPP_URL } }]]
        }
      } : {}),
    });
    await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(opts, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('sendTgMessage error:', err.message);
  }
}

async function notifyUserByTelegram(tgUsername, message) {
  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  const user = await getUserByTelegram(norm);
  if (!user || !user.telegram_id) return;
  // Нам нужен chat_id, который боту неизвестен без сессии.
  // Используем sendMessage через username — Telegram поддерживает это для ботов.
  // Альтернатива: хранить chat_id в отдельной таблице при первом /start.
  // Реализуем хранение chat_id:
  const chatRows = await sql`SELECT chat_id FROM bot_sessions WHERE tg_username = ${norm} LIMIT 1`.catch(() => []);
  if (!chatRows.length) return;
  await sendTgMessage(chatRows[0].chat_id, message);
}

// ===== СЕССИИ БОТА (хранит chat_id пользователей) =====

async function ensureBotSessionsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      tg_username TEXT PRIMARY KEY,
      chat_id     BIGINT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function saveBotSession(tgUsername, chatId) {
  if (!tgUsername) return;
  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  await sql`
    INSERT INTO bot_sessions (tg_username, chat_id, updated_at)
    VALUES (${norm}, ${chatId}, NOW())
    ON CONFLICT (tg_username) DO UPDATE SET chat_id = EXCLUDED.chat_id, updated_at = NOW()
  `;
}

async function getAllChatIds() {
  const rows = await sql`SELECT chat_id FROM bot_sessions`;
  return rows.map(r => r.chat_id);
}

// ===== БОТ =====

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Состояния в памяти (сбрасываются при рестарте — не критично)
const userStates  = {};   // { [chatId]: { state, siteUsername, ... } }
const adminStates = {};   // { [chatId]: { action, ticketId, ... } }
const supportTickets = {}; // { [ticketId]: { userChatId, messageId, username } }
const ADMIN_IDS = [1746547600]; // Telegram chat_id администраторов бота

// Генерация ID тикета
function generateTicketId() {
  let id;
  do { id = Math.floor(100 + Math.random() * 900).toString(); }
  while (supportTickets[id]);
  return id;
}

// ===== /start =====
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUsername = msg.from.username ? `@${msg.from.username}` : null;
  const param = match && match[1] ? match[1].trim() : '';

  // Сохраняем сессию бота в БД
  if (tgUsername) {
    await saveBotSession(tgUsername, chatId).catch(console.error);
  }

  // === DEEP LINK: сброс пароля ===
  if (param.startsWith('reset_')) {
    const siteUsername = decodeURIComponent(param.slice(6)).trim();
    if (!siteUsername) {
      return bot.sendMessage(chatId, '❌ <b>Неверная команда сброса пароля.</b>', { parse_mode: 'HTML' });
    }

    // Проверяем что пользователь существует
    const siteUser = await getUserByUsername(siteUsername).catch(() => null);
    if (!siteUser) {
      return bot.sendMessage(chatId, `❌ Пользователь <code>${siteUsername}</code> не найден.`, { parse_mode: 'HTML' });
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

    if (!tgUsername) {
      return bot.sendMessage(chatId,
        '❌ <b>Не удалось определить ваш Telegram username.</b>\n\nУстановите username в настройках Telegram и попробуйте снова.',
        { parse_mode: 'HTML' }
      );
    }

    // Проверяем что пользователь сайта существует
    const siteUser = await getUserByUsername(siteUsername).catch(() => null);
    if (!siteUser) {
      return bot.sendMessage(chatId, `❌ Пользователь <code>${siteUsername}</code> не найден на сайте.`, { parse_mode: 'HTML' });
    }

    // Проверяем не занят ли этот TG другим аккаунтом
    const norm = tgUsername.replace(/^@/, '').toLowerCase();
    const existingBinding = await sql`SELECT username FROM users WHERE telegram_id = ${norm} LIMIT 1`.catch(() => []);
    if (existingBinding.length && existingBinding[0].username.toLowerCase() !== siteUsername.toLowerCase()) {
      return bot.sendMessage(chatId,
        `❌ Этот Telegram уже привязан к аккаунту <code>${existingBinding[0].username}</code>.`,
        { parse_mode: 'HTML' }
      );
    }

    // Создаём токен в pending_actions
    let callbackUrl;
    try {
      const token = await createPendingToken('link_tg', {
        siteUsername,
        tgUsername,
        chatId: String(chatId),
      });
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=link`;
    } catch (err) {
      console.error('createPendingToken error:', err.message);
      // Фолбэк на legacy формат
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=link&user=${encodeURIComponent(siteUsername)}&tg=${encodeURIComponent(tgUsername)}&token=${encodeURIComponent(legacyToken)}&cid=${chatId}`;
    }

    return bot.sendMessage(chatId,
      `🔗 <b>Привязка Telegram к kbpost</b>\n\nАккаунт kbpost: <code>${siteUsername}</code>\nTelegram: ${tgUsername}\n\nНажмите кнопку ниже чтобы подтвердить привязку:`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Подтвердить привязку', web_app: { url: callbackUrl } }]]
        }
      }
    );
  }

  // === Обычный /start ===
  return bot.sendMessage(chatId,
    `📦 <b>kbpost</b> — Speed. Technology. Security.\n\n🚀 <b>Mini App:</b> Нажмите кнопку ниже для управления посылками.\n\n🎧 <b>Поддержка:</b> /support\n📋 <b>Мои посылки:</b> /parcels`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '📦 Открыть kbpost', web_app: { url: WEBAPP_URL } }]]
      }
    }
  );
});

// ===== /parcels — показать посылки пользователя =====
bot.onText(/\/parcels/, async (msg) => {
  const chatId = msg.chat.id;
  const tgUsername = msg.from.username ? `@${msg.from.username}` : null;
  if (!tgUsername) return bot.sendMessage(chatId, '❌ Установите Telegram username в настройках.', { parse_mode: 'HTML' });

  const siteUser = await getUserByTelegram(tgUsername).catch(() => null);
  if (!siteUser) {
    return bot.sendMessage(chatId,
      '❌ <b>Аккаунт kbpost не найден.</b>\n\nЗарегистрируйтесь на сайте и привяжите Telegram.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📦 Открыть kbpost', web_app: { url: WEBAPP_URL } }]] } }
    );
  }

  const parcels = await getUserParcels(siteUser.id).catch(() => []);
  if (!parcels.length) {
    return bot.sendMessage(chatId, '📦 У вас нет посылок.', { parse_mode: 'HTML' });
  }

  const STATUS_LABELS = {
    1: 'Оформлена', 2: 'В отделении', 3: 'Выехала', 4: 'В терминале',
    5: 'Из терминала', 6: 'Прибыла', 7: 'Получена', 8: 'Доставлена'
  };

  let text = `📦 <b>Ваши посылки</b> (${parcels.length}):\n\n`;
  for (const p of parcels.slice(0, 5)) {
    const isSender = p.sender_id === siteUser.id;
    const other = isSender ? p.receiver_username : p.sender_username;
    text += `<code>${p.ttn}</code> — ${isSender ? '→' : '←'} <b>${other}</b>\n`;
    text += `   ${STATUS_LABELS[p.status] || p.status}\n`;
    if (p.cash_on_delivery) {
      text += `   💰 ${p.cash_on_delivery_amount} кбк`;
      if (p.cash_on_delivery_confirmed) text += ' ✅';
      else if (p.cash_on_delivery_paid) text += ' ⏳';
      text += '\n';
    }
    text += '\n';
  }
  if (parcels.length > 5) text += `<i>...и ещё ${parcels.length - 5} посылок</i>`;

  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '📦 Открыть kbpost', web_app: { url: WEBAPP_URL } }]] }
  });
});

// ===== /cancel =====
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  let reset = false;
  if (userStates[chatId])  { delete userStates[chatId];  reset = true; }
  if (adminStates[chatId]) { delete adminStates[chatId]; reset = true; }
  bot.sendMessage(chatId, reset ? '❌ <b>Действие отменено.</b>' : 'У вас нет активных действий.', { parse_mode: 'HTML' });
});

// ===== /support =====
bot.onText(/\/support/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { state: 'awaiting_support_reason' };
  bot.sendMessage(chatId, '🛠 <b>Поддержка</b>\n\nОпишите проблему одним сообщением.\n\nДля отмены введите /cancel', { parse_mode: 'HTML' });
});

// ===== /broadcast (только для ADMIN_IDS) =====
bot.onText(/\/broadcast/, (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  adminStates[chatId] = { action: 'awaiting_broadcast_content' };
  bot.sendMessage(chatId, '📢 <b>Рассылка</b>\n\nОтправьте сообщение для рассылки.\n\nДля отмены введите /cancel', { parse_mode: 'HTML' });
});

// ===== /answer <ticketId> =====
bot.onText(/\/answer (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  const ticketId = match[1];
  if (!supportTickets[ticketId]) return bot.sendMessage(chatId, '❌ Тикет не найден или закрыт.');
  adminStates[chatId] = { action: 'awaiting_answer', ticketId };
  bot.sendMessage(chatId, `Напишите ответ для тикета <b>#${ticketId}</b>:\n\nДля отмены введите /cancel`, { parse_mode: 'HTML' });
});

// ===== Обработчик всех сообщений =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Игнорируем команды — они уже обработаны выше
  if (text && text.startsWith('/')) return;

  // Сохраняем сессию при любом сообщении
  if (msg.from.username) {
    await saveBotSession(`@${msg.from.username}`, chatId).catch(() => {});
  }

  // === Рассылка (admin) ===
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_broadcast_content') {
    delete adminStates[chatId];
    const chatIds = await getAllChatIds().catch(() => []);
    let success = 0, failed = 0;
    bot.sendMessage(chatId, `⏳ Рассылка на ${chatIds.length} пользователей...`);
    for (const cid of chatIds) {
      try { await bot.copyMessage(cid, chatId, msg.message_id); success++; }
      catch { failed++; }
    }
    bot.sendMessage(chatId, `🏁 <b>Рассылка завершена!</b>\n\n✅ Успешно: ${success}\n❌ Ошибок: ${failed}`, { parse_mode: 'HTML' });
    return;
  }

  // === Ответ на тикет (admin) ===
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_answer') {
    const { ticketId } = adminStates[chatId];
    const ticket = supportTickets[ticketId];
    if (ticket) {
      bot.sendMessage(ticket.userChatId, `✉️ <b>Ответ от поддержки:</b>\n\n${text}`, {
        parse_mode: 'HTML',
        reply_to_message_id: ticket.messageId,
      });
      bot.sendMessage(chatId, `✅ Ответ отправлен пользователю ${ticket.username}`);
      delete supportTickets[ticketId];
    }
    delete adminStates[chatId];
    return;
  }

  // === Сброс пароля ===
  if (userStates[chatId]?.state === 'awaiting_new_password') {
    const { siteUsername } = userStates[chatId];
    const newPassword = text ? text.trim() : '';

    if (!newPassword || newPassword.length < 4) {
      return bot.sendMessage(chatId,
        '❌ <b>Пароль слишком короткий.</b>\n\nМинимум 4 символа. Попробуйте снова или /cancel',
        { parse_mode: 'HTML' }
      );
    }

    // Создаём токен в pending_actions — мини-апп применит его
    try {
      const token = await createPendingToken('reset_password', { siteUsername });
      const callbackUrl = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=reset`;

      bot.sendMessage(chatId,
        `✅ <b>Новый пароль готов!</b>\n\nАккаунт: <code>${siteUsername}</code>\n\nНажмите кнопку чтобы применить пароль:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔑 Применить и войти', web_app: { url: callbackUrl } }]]
          }
        }
      );
    } catch (err) {
      console.error('reset token error:', err.message);
      // Фолбэк: передаём пароль напрямую (legacy)
      const callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=reset&user=${encodeURIComponent(siteUsername)}&pwd=${encodeURIComponent(newPassword)}`;
      bot.sendMessage(chatId,
        `✅ <b>Нажмите кнопку чтобы применить новый пароль:</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🔑 Применить и войти', web_app: { url: callbackUrl } }]] }
        }
      );
    }

    delete userStates[chatId];
    return;
  }

  // === Тикет поддержки ===
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

// ===== ЗАПУСК =====
async function start() {
  await ensureBotSessionsTable();
  await initDB();
  console.log(`🚀 KBPOST bot запущен!`);
  console.log(`   WEBAPP: ${WEBAPP_URL}`);
  console.log(`   DB: подключено к Neon`);
}

start().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});

// Экспорт для возможного использования
module.exports = { sql, getUserByTelegram, sendTgMessage };
