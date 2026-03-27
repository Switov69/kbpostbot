/**
 * KBPOST Telegram Bot
 * Render.com + Neon Postgres (та же БД что и Vercel-сайт)
 *
 * Переменные окружения (Render → Environment):
 *   DATABASE_URL  — строка подключения к Neon
 *   BOT_TOKEN     — токен от @BotFather
 *   BOT_SECRET    — секрет для API createToken
 *   WEBAPP_URL    — https://kbpost.vercel.app
 */

const TelegramBot = require('node-telegram-bot-api');
const { neon }    = require('@neondatabase/serverless');
const bcrypt      = require('bcryptjs');
const https       = require('https');

// ===== КОНФИГ =====
const BOT_TOKEN  = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const BOT_SECRET = process.env.BOT_SECRET;
const DB_URL     = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('❌ DATABASE_URL не задан!');
  process.exit(1);
}

const sql = neon(DB_URL);

// ===== ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ =====
async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        balance INTEGER NOT NULL DEFAULT 0,
        telegram_id TEXT UNIQUE,
        citizenship TEXT NOT NULL DEFAULT '',
        account TEXT NOT NULL DEFAULT '',
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        subscription_active BOOLEAN NOT NULL DEFAULT FALSE,
        subscription_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_active BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires TIMESTAMPTZ`;

    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS parcels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ttn TEXT UNIQUE NOT NULL,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_username TEXT NOT NULL,
        receiver_username TEXT NOT NULL,
        status INTEGER NOT NULL DEFAULT 1,
        status_history JSONB NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        from_branch_id TEXT NOT NULL DEFAULT '',
        to_branch_id TEXT,
        to_coordinates TEXT,
        cash_on_delivery BOOLEAN NOT NULL DEFAULT FALSE,
        cash_on_delivery_amount INTEGER NOT NULL DEFAULT 0,
        cash_on_delivery_paid BOOLEAN NOT NULL DEFAULT FALSE,
        cash_on_delivery_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS pending_actions (
        token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        action_type TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}',
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        region TEXT NOT NULL,
        prefecture TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT ''
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        tg_username TEXT PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        no_ads BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS no_ads BOOLEAN NOT NULL DEFAULT FALSE`;

    await sql`
      CREATE TABLE IF NOT EXISTS subscription_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

// ===== DB HELPERS =====

async function getUserByTelegram(tgUsername) {
  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  const rows = await sql`SELECT * FROM users WHERE telegram_id = ${norm} LIMIT 1`;
  return rows[0] || null;
}

async function getUserByUsername(username) {
  const rows = await sql`SELECT * FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
  return rows[0] || null;
}

async function createPendingToken(actionType, data) {
  const rows = await sql`
    INSERT INTO pending_actions (action_type, data)
    VALUES (${actionType}, ${JSON.stringify(data)}::jsonb)
    RETURNING token
  `;
  return rows[0].token;
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

// Получить chat_id пользователей у которых no_ads = FALSE (для рекламы)
async function getAdChatIds() {
  const rows = await sql`SELECT chat_id FROM bot_sessions WHERE no_ads = FALSE`;
  return rows.map(r => r.chat_id);
}

async function hasActiveSubscription(tgUsername) {
  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  const rows = await sql`
    SELECT subscription_active, subscription_expires
    FROM users
    WHERE telegram_id = ${norm}
    LIMIT 1
  `;
  if (!rows.length) return false;
  const u = rows[0];
  return u.subscription_active && u.subscription_expires && new Date(u.subscription_expires) > new Date();
}

// ===== SEND HELPER =====

async function sendTgMessage(chatId, text, withAppButton = true) {
  if (!chatId) return;
  try {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(withAppButton ? {
        reply_markup: { inline_keyboard: [[{ text: '📦 Открыть kbpost', web_app: { url: WEBAPP_URL } }]] }
      } : {}),
    });
    await new Promise((resolve) => {
      const opts = {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(opts, (r) => { r.resume(); resolve(); });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('sendTgMessage error:', err.message);
  }
}

// ===== BOT =====

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const userStates   = {};
const adminStates  = {};
const supportTickets = {};
const ADMIN_IDS = [1746547600];

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

  if (tgUsername) await saveBotSession(tgUsername, chatId).catch(console.error);

  // === DEEP LINK: сброс пароля ===
  if (param.startsWith('reset_')) {
    const siteUsername = decodeURIComponent(param.slice(6)).trim();
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

  // === DEEP LINK: prelink_ — привязка TG до регистрации ===
  // Пользователь ещё НЕ зарегистрирован, просто хочет привязать свой TG-аккаунт к будущему нику
  if (param.startsWith('prelink_')) {
    const parts = param.slice(8).split('_');
    if (parts.length < 2) {
      return bot.sendMessage(chatId, '❌ Неверная команда привязки.', { parse_mode: 'HTML' });
    }
    const token = parts[parts.length - 1];
    const siteUsername = decodeURIComponent(parts.slice(0, -1).join('_')).trim();

    if (!tgUsername) {
      return bot.sendMessage(chatId,
        '❌ <b>Не удалось определить ваш Telegram username.</b>\n\nУстановите username в настройках Telegram и попробуйте снова.',
        { parse_mode: 'HTML' }
      );
    }

    // Проверяем не занят ли этот TG другим зарегистрированным аккаунтом
    const norm = tgUsername.replace(/^@/, '').toLowerCase();
    const existingBinding = await sql`SELECT username FROM users WHERE telegram_id = ${norm} LIMIT 1`.catch(() => []);
    if (existingBinding.length && existingBinding[0].username.toLowerCase() !== siteUsername.toLowerCase()) {
      return bot.sendMessage(chatId,
        `❌ Этот Telegram уже привязан к аккаунту <code>${existingBinding[0].username}</code>.`,
        { parse_mode: 'HTML' }
      );
    }

    // Создаём callback — мини-апп получит tgUsername и запомнит его для регистрации
    const callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=link&user=${encodeURIComponent(siteUsername)}&tg=${encodeURIComponent(tgUsername)}&token=${encodeURIComponent(token)}&cid=${chatId}`;

    return bot.sendMessage(chatId,
      `🔗 <b>Привязка Telegram к kbpost</b>\n\nНик на сайте: <code>${siteUsername}</code>\nTelegram: ${tgUsername}\n\nНажмите кнопку ниже, чтобы подтвердить и вернуться к регистрации:`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить и продолжить', web_app: { url: callbackUrl } }]] }
      }
    );
  }

  // === DEEP LINK: link_ — привязка TG к СУЩЕСТВУЮЩЕМУ аккаунту (из профиля) ===
  if (param.startsWith('link_')) {
    const parts = param.slice(5).split('_');
    if (parts.length < 2) {
      return bot.sendMessage(chatId, '❌ Неверная команда привязки.', { parse_mode: 'HTML' });
    }
    const legacyToken = parts[parts.length - 1];
    const siteUsername = decodeURIComponent(parts.slice(0, -1).join('_')).trim();

    if (!tgUsername) {
      return bot.sendMessage(chatId,
        '❌ <b>Не удалось определить ваш Telegram username.</b>\n\nУстановите username в настройках Telegram и попробуйте снова.',
        { parse_mode: 'HTML' }
      );
    }

    const siteUser = await getUserByUsername(siteUsername).catch(() => null);
    if (!siteUser) {
      // Пользователь не найден — перенаправляем как prelink (для сайта это одно и то же)
      const callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=link&user=${encodeURIComponent(siteUsername)}&tg=${encodeURIComponent(tgUsername)}&token=${encodeURIComponent(legacyToken)}&cid=${chatId}`;
      return bot.sendMessage(chatId,
        `🔗 <b>Привязка Telegram</b>\n\nНик: <code>${siteUsername}</code>\nTelegram: ${tgUsername}\n\nНажмите кнопку ниже:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить привязку', web_app: { url: callbackUrl } }]] }
        }
      );
    }

    const norm = tgUsername.replace(/^@/, '').toLowerCase();
    const existingBinding = await sql`SELECT username FROM users WHERE telegram_id = ${norm} LIMIT 1`.catch(() => []);
    if (existingBinding.length && existingBinding[0].username.toLowerCase() !== siteUsername.toLowerCase()) {
      return bot.sendMessage(chatId,
        `❌ Этот Telegram уже привязан к аккаунту <code>${existingBinding[0].username}</code>.`,
        { parse_mode: 'HTML' }
      );
    }

    let callbackUrl;
    try {
      const token = await createPendingToken('link_tg', { siteUsername, tgUsername, chatId: String(chatId) });
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=link`;
    } catch {
      callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=link&user=${encodeURIComponent(siteUsername)}&tg=${encodeURIComponent(tgUsername)}&token=${encodeURIComponent(legacyToken)}&cid=${chatId}`;
    }

    return bot.sendMessage(chatId,
      `🔗 <b>Привязка Telegram к kbpost</b>\n\nАккаунт: <code>${siteUsername}</code>\nTelegram: ${tgUsername}\n\nНажмите кнопку ниже:`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Подтвердить привязку', web_app: { url: callbackUrl } }]] }
      }
    );
  }

  // === Обычный /start ===
  return bot.sendMessage(chatId,
    `📦 <b>kbpost</b> — Speed. Technology. Security.\n\n🚀 <b>Mini App:</b> Нажмите кнопку ниже для управления посылками.\n\n🎧 <b>Поддержка:</b> /support`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '📦 Открыть kbpost', web_app: { url: WEBAPP_URL } }]] }
    }
  );
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

// ===== /broadcast — рассылка всем (admin) =====
bot.onText(/\/broadcast/, (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  adminStates[chatId] = { action: 'awaiting_broadcast_content' };
  bot.sendMessage(chatId, '📢 <b>Рассылка всем</b>\n\nОтправьте сообщение. Будет разослано ВСЕМ пользователям.\n\nДля отмены: /cancel', { parse_mode: 'HTML' });
});

// ===== /ad — рекламная рассылка (admin, только без подписки) =====
bot.onText(/\/ad/, (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  adminStates[chatId] = { action: 'awaiting_ad_content' };
  bot.sendMessage(chatId,
    '📣 <b>Рекламная рассылка</b>\n\nОтправьте рекламное сообщение.\nОно будет разослано только пользователям <b>без активной подписки</b>.\n(Пользователи с подпиской и /disadv не получат)\n\nДля отмены: /cancel',
    { parse_mode: 'HTML' }
  );
});

// ===== /disadv — отключить рекламу (если есть подписка) =====
bot.onText(/\/disadv/, async (msg) => {
  const chatId = msg.chat.id;
  const tgUsername = msg.from.username ? `@${msg.from.username}` : null;

  if (!tgUsername) {
    return bot.sendMessage(chatId, '❌ Установите Telegram username в настройках.', { parse_mode: 'HTML' });
  }

  const hasSub = await hasActiveSubscription(tgUsername).catch(() => false);
  if (!hasSub) {
    return bot.sendMessage(chatId,
      '⭐ <b>Эта функция доступна только подписчикам.</b>\n\nПодписка позволяет отключить рекламу в боте.\nКупить подписку (5 кбк/мес) можно на сайте kbpost.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⭐ Купить подписку', web_app: { url: WEBAPP_URL } }]] } }
    );
  }

  const norm = tgUsername.replace(/^@/, '').toLowerCase();
  try {
    // Переключаем no_ads
    const current = await sql`SELECT no_ads FROM bot_sessions WHERE tg_username = ${norm} LIMIT 1`;
    const currentVal = current.length ? current[0].no_ads : false;
    await sql`UPDATE bot_sessions SET no_ads = ${!currentVal} WHERE tg_username = ${norm}`;

    if (!currentVal) {
      return bot.sendMessage(chatId, '🔇 <b>Реклама отключена.</b>\n\nВы больше не будете получать рекламные сообщения.', { parse_mode: 'HTML' });
    } else {
      return bot.sendMessage(chatId, '🔔 <b>Реклама включена.</b>\n\nВы снова будете получать рекламные сообщения.', { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('disadv error:', err.message);
    return bot.sendMessage(chatId, '❌ Ошибка. Попробуйте позже.', { parse_mode: 'HTML' });
  }
});

// ===== /answer <ticketId> (admin) =====
bot.onText(/\/answer (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(chatId)) return;
  const ticketId = match[1];
  if (!supportTickets[ticketId]) return bot.sendMessage(chatId, '❌ Тикет не найден или закрыт.');
  adminStates[chatId] = { action: 'awaiting_answer', ticketId };
  bot.sendMessage(chatId, `Напишите ответ для тикета <b>#${ticketId}</b>:\n\nДля отмены: /cancel`, { parse_mode: 'HTML' });
});

// ===== Обработчик сообщений =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && text.startsWith('/')) return;

  if (msg.from.username) await saveBotSession(`@${msg.from.username}`, chatId).catch(() => {});

  // === Рассылка всем (broadcast) ===
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

  // === Рекламная рассылка (ad — только без подписки/no_ads) ===
  if (ADMIN_IDS.includes(chatId) && adminStates[chatId]?.action === 'awaiting_ad_content') {
    delete adminStates[chatId];
    const chatIds = await getAdChatIds().catch(() => []);
    let success = 0, failed = 0;
    bot.sendMessage(chatId, `⏳ Рекламная рассылка на ${chatIds.length} пользователей (без подписки и без /disadv)...`);
    for (const cid of chatIds) {
      try { await bot.copyMessage(cid, chatId, msg.message_id); success++; }
      catch { failed++; }
    }
    bot.sendMessage(chatId, `🏁 <b>Рекламная рассылка завершена!</b>\n\n✅ Успешно: ${success}\n❌ Ошибок: ${failed}`, { parse_mode: 'HTML' });
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
      return bot.sendMessage(chatId, '❌ <b>Пароль слишком короткий.</b>\n\nМинимум 4 символа. Попробуйте снова или /cancel', { parse_mode: 'HTML' });
    }
    try {
      const token = await createPendingToken('reset_password', { siteUsername });
      const callbackUrl = `${WEBAPP_URL}/#/tg-callback?token=${token}&action=reset`;
      bot.sendMessage(chatId,
        `✅ <b>Новый пароль готов!</b>\n\nАккаунт: <code>${siteUsername}</code>\n\nНажмите кнопку чтобы применить:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔑 Применить и войти', web_app: { url: callbackUrl } }]] } }
      );
    } catch {
      const callbackUrl = `${WEBAPP_URL}/#/tg-callback?action=reset&user=${encodeURIComponent(siteUsername)}&pwd=${encodeURIComponent(newPassword)}`;
      bot.sendMessage(chatId, '✅ <b>Нажмите кнопку чтобы применить новый пароль:</b>',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔑 Применить и войти', web_app: { url: callbackUrl } }]] } }
      );
    }
    delete userStates[chatId];
    return;
  }

  // === Тикет поддержки ===
  if (userStates[chatId]?.state === 'awaiting_support_reason') {
    const ticketId = generateTicketId();
    const username = msg.from.username ? `@${msg.from.username}` : 'скрыт';

    // Проверяем приоритет (если есть подписка — помечаем)
    let priority = '';
    if (msg.from.username) {
      const hasSub = await hasActiveSubscription(`@${msg.from.username}`).catch(() => false);
      if (hasSub) priority = ' ⭐ <b>[Подписчик — приоритет]</b>';
    }

    supportTickets[ticketId] = { userChatId: chatId, messageId: msg.message_id, username };
    bot.sendMessage(chatId, `✅ <b>Запрос отправлен!</b>\n\nТикет: <code>#${ticketId}</code>\nОжидайте ответа.`, { parse_mode: 'HTML' });
    ADMIN_IDS.forEach(adminId => {
      bot.sendMessage(adminId,
        `🆘 <b>Новый запрос в поддержку!</b>${priority}\n\nОт: ${username}\nСообщение: <b>${text || '[Медиафайл]'}</b>\n\nОтветить: <code>/answer ${ticketId}</code>`,
        { parse_mode: 'HTML' }
      );
    });
    delete userStates[chatId];
    return;
  }
});

// ===== ЗАПУСК =====
async function start() {
  await initDB();
  console.log(`🚀 KBPOST bot запущен!`);
  console.log(`   WEBAPP: ${WEBAPP_URL}`);
  console.log(`   DB: подключено к Neon`);
}

start().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});

module.exports = { sql, getUserByTelegram, sendTgMessage };
