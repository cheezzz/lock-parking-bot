// Lock Parking Bot - Cloudflare Worker + D1 + Telegram
// Commands:
//   /parkcheck <checkin> <checkout>     - Check if parking is available
//   /parkbook <checkin> <checkout> <name> - Book parking for a guest
//   /parkunbook                          - List bookings to remove
//   /parkstatus                          - Show today's parking status
//   /parkall                             - Show all future bookings

// ============================================================
// DATE PARSING
// ============================================================

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Parse a date string like "5 July", "5 July 2026", or "2026-07-05"
 * Returns ISO date string (YYYY-MM-DD) or null if unparseable.
 */
function parseDate(str) {
  str = str.trim();

  // ISO format: 2026-07-05
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Natural format: "5 July" or "5 July 2026"
  const match = str.match(/^(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?$/);
  if (match) {
    const day = parseInt(match[1], 10);
    const monthStr = match[2].toLowerCase();
    const month = MONTHS[monthStr];
    if (month === undefined) return null;

    let year;
    if (match[3]) {
      year = parseInt(match[3], 10);
    } else {
      // Default to current year; if date is in the past, use next year
      const now = new Date();
      year = now.getFullYear();
      const candidate = new Date(year, month, day);
      if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        year++;
      }
    }

    const mm = String(month + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  return null;
}

/**
 * Extract two dates and optional remaining text from command arguments.
 * Supports: "5 July 8 July", "5 July 2026 8 July 2026", "2026-07-05 2026-07-08"
 * Returns { checkin, checkout, remainder } or null.
 */
function parseDateRange(argsStr) {
  argsStr = argsStr.trim();
  if (!argsStr) return null;

  // Try ISO pair first: "2026-07-05 2026-07-08 ..."
  const isoMatch = argsStr.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})(.*)$/);
  if (isoMatch) {
    return {
      checkin: isoMatch[1],
      checkout: isoMatch[2],
      remainder: isoMatch[3].trim(),
    };
  }

  // Try natural format: "5 July 8 July ..." or "5 July 2026 8 July 2026 ..."
  // Strategy: try splitting tokens to find two valid dates
  const tokens = argsStr.split(/\s+/);

  // Attempt patterns: [day month] [day month ...] or [day month year] [day month year ...]
  for (const firstLen of [2, 3]) {
    for (const secondLen of [2, 3]) {
      if (firstLen + secondLen > tokens.length) continue;
      const first = tokens.slice(0, firstLen).join(' ');
      const second = tokens.slice(firstLen, firstLen + secondLen).join(' ');
      const d1 = parseDate(first);
      const d2 = parseDate(second);
      if (d1 && d2) {
        return {
          checkin: d1,
          checkout: d2,
          remainder: tokens.slice(firstLen + secondLen).join(' ').trim(),
        };
      }
    }
  }

  return null;
}

function formatDate(isoStr) {
  const d = new Date(isoStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function todayISO() {
  // SAST = UTC+2
  const now = new Date();
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  return sast.toISOString().split('T')[0];
}

// ============================================================
// DATABASE QUERIES
// ============================================================

/**
 * Find bookings that overlap with the given date range.
 * Overlap logic: existing.checkin < new_checkout AND existing.checkout > new_checkin
 * This correctly treats checkout day as free for a new arrival.
 */
async function findConflicts(db, checkin, checkout, excludeId = null) {
  let query = `SELECT * FROM parking_bookings WHERE checkin < ? AND checkout > ?`;
  const params = [checkout, checkin];

  if (excludeId) {
    query += ` AND id != ?`;
    params.push(excludeId);
  }

  query += ` ORDER BY checkin ASC`;
  const { results } = await db.prepare(query).bind(...params).all();
  return results;
}

async function addBooking(db, guestName, checkin, checkout, notes = null) {
  const result = await db.prepare(
    `INSERT INTO parking_bookings (guest_name, checkin, checkout, notes) VALUES (?, ?, ?, ?)`
  ).bind(guestName, checkin, checkout, notes).run();
  return result;
}

async function removeBooking(db, id) {
  await db.prepare(`DELETE FROM parking_bookings WHERE id = ?`).bind(id).run();
}

async function getBooking(db, id) {
  return await db.prepare(`SELECT * FROM parking_bookings WHERE id = ?`).bind(id).first();
}

async function getFutureBookings(db) {
  const today = todayISO();
  const { results } = await db.prepare(
    `SELECT * FROM parking_bookings WHERE checkout > ? ORDER BY checkin ASC`
  ).bind(today).all();
  return results;
}

async function getTodayBooking(db) {
  const today = todayISO();
  // Active today: checkin <= today AND checkout > today
  const { results } = await db.prepare(
    `SELECT * FROM parking_bookings WHERE checkin <= ? AND checkout > ? ORDER BY checkin ASC`
  ).bind(today, today).all();
  return results;
}

// ============================================================
// TELEGRAM API
// ============================================================

async function sendTelegram(token, method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function sendMessage(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return sendTelegram(token, 'sendMessage', body);
}

async function answerCallback(token, callbackId, text = '') {
  return sendTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
  });
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

async function handleParkCheck(db, token, chatId, argsStr) {
  const parsed = parseDateRange(argsStr);
  if (!parsed) {
    return sendMessage(token, chatId,
      '⚠️ Usage: <code>/parkcheck 5 July 8 July</code>\n\nProvide checkin and checkout dates.');
  }

  const { checkin, checkout } = parsed;

  if (checkin >= checkout) {
    return sendMessage(token, chatId, '⚠️ Checkout must be after checkin.');
  }

  const conflicts = await findConflicts(db, checkin, checkout);

  if (conflicts.length === 0) {
    return sendMessage(token, chatId,
      `✅ <b>Lock parking is AVAILABLE</b>\n📅 ${formatDate(checkin)} → ${formatDate(checkout)}`);
  }

  let msg = `❌ <b>Lock parking is TAKEN</b>\n📅 ${formatDate(checkin)} → ${formatDate(checkout)}\n\n<b>Conflicts:</b>\n`;
  for (const c of conflicts) {
    msg += `• ${c.guest_name} — ${formatDate(c.checkin)} → ${formatDate(c.checkout)}\n`;
  }
  return sendMessage(token, chatId, msg);
}

async function handleParkBook(db, token, chatId, argsStr) {
  const parsed = parseDateRange(argsStr);
  if (!parsed || !parsed.remainder) {
    return sendMessage(token, chatId,
      '⚠️ Usage: <code>/parkbook 5 July 8 July Guest Name</code>\n\nProvide checkin, checkout, and guest name.');
  }

  const { checkin, checkout, remainder: guestName } = parsed;

  if (checkin >= checkout) {
    return sendMessage(token, chatId, '⚠️ Checkout must be after checkin.');
  }

  const conflicts = await findConflicts(db, checkin, checkout);
  if (conflicts.length > 0) {
    let msg = `❌ <b>Cannot book — dates conflict:</b>\n`;
    for (const c of conflicts) {
      msg += `• ${c.guest_name} — ${formatDate(c.checkin)} → ${formatDate(c.checkout)}\n`;
    }
    return sendMessage(token, chatId, msg);
  }

  await addBooking(db, guestName, checkin, checkout);
  return sendMessage(token, chatId,
    `✅ <b>Parking booked!</b>\n👤 ${guestName}\n📅 ${formatDate(checkin)} → ${formatDate(checkout)}`);
}

async function handleParkUnbook(db, token, chatId) {
  const bookings = await getFutureBookings(db);

  if (bookings.length === 0) {
    return sendMessage(token, chatId, 'ℹ️ No upcoming parking bookings.');
  }

  let msg = '🗑️ <b>Tap a booking to remove it:</b>\n';
  const buttons = [];
  for (const b of bookings) {
    msg += `\n• ${b.guest_name} — ${formatDate(b.checkin)} → ${formatDate(b.checkout)}`;
    buttons.push([{
      text: `❌ ${b.guest_name} (${formatDate(b.checkin)})`,
      callback_data: `unbook:${b.id}`,
    }]);
  }

  buttons.push([{ text: '↩️ Cancel', callback_data: 'unbook:cancel' }]);

  return sendMessage(token, chatId, msg, { inline_keyboard: buttons });
}

async function handleParkStatus(db, token, chatId) {
  const today = todayISO();
  const active = await getTodayBooking(db);

  let msg;
  if (active.length > 0) {
    const b = active[0];
    msg = `🅿️ <b>Lock parking today (${formatDate(today)}):</b>\n\n` +
      `🔒 BOOKED — ${b.guest_name}\n📅 ${formatDate(b.checkin)} → ${formatDate(b.checkout)}`;
  } else {
    msg = `🅿️ <b>Lock parking today (${formatDate(today)}):</b>\n\n✅ AVAILABLE`;
  }

  // Show next upcoming booking
  const future = await getFutureBookings(db);
  const nextBooking = future.find(b => b.checkin > today);
  if (nextBooking) {
    msg += `\n\n📋 Next booking: ${nextBooking.guest_name} — ${formatDate(nextBooking.checkin)}`;
  }

  return sendMessage(token, chatId, msg);
}

async function handleParkAll(db, token, chatId) {
  const bookings = await getFutureBookings(db);

  if (bookings.length === 0) {
    return sendMessage(token, chatId, 'ℹ️ No upcoming parking bookings.');
  }

  let msg = '🅿️ <b>All upcoming parking bookings:</b>\n';
  for (const b of bookings) {
    const today = todayISO();
    const active = (b.checkin <= today && b.checkout > today) ? ' ← NOW' : '';
    msg += `\n• ${b.guest_name}\n  📅 ${formatDate(b.checkin)} → ${formatDate(b.checkout)}${active}`;
  }
  return sendMessage(token, chatId, msg);
}

async function handleCallbackQuery(db, token, callback) {
  const chatId = callback.message.chat.id;
  const data = callback.data;

  if (data === 'unbook:cancel') {
    await answerCallback(token, callback.id, 'Cancelled');
    return sendMessage(token, chatId, '↩️ Cancelled.');
  }

  if (data.startsWith('unbook:')) {
    const id = parseInt(data.split(':')[1], 10);
    const booking = await getBooking(db, id);

    if (!booking) {
      await answerCallback(token, callback.id, 'Booking not found');
      return sendMessage(token, chatId, '⚠️ Booking not found — may have already been removed.');
    }

    await removeBooking(db, id);
    await answerCallback(token, callback.id, 'Removed!');
    return sendMessage(token, chatId,
      `🗑️ <b>Parking removed:</b>\n👤 ${booking.guest_name}\n📅 ${formatDate(booking.checkin)} → ${formatDate(booking.checkout)}`);
  }

  await answerCallback(token, callback.id);
}

function handleHelp(token, chatId) {
  const msg = `🅿️ <b>Lock Parking Bot</b>\n\n` +
    `<b>Commands:</b>\n` +
    `<code>/parkcheck 5 July 8 July</code>\nCheck if parking is available\n\n` +
    `<code>/parkbook 5 July 8 July Guest Name</code>\nBook parking for a guest\n\n` +
    `<code>/parkunbook</code>\nRemove a parking booking\n\n` +
    `<code>/parkstatus</code>\nToday's parking status\n\n` +
    `<code>/parkall</code>\nList all upcoming bookings\n\n` +
    `<b>Date formats:</b> <code>5 July</code>, <code>5 July 2026</code>, or <code>2026-07-05</code>\n\n` +
    `💡 Checkout day = available for new guest (e.g. booking 1-3 July means spot is free on 3 July)`;
  return sendMessage(token, chatId, msg);
}

// ============================================================
// CRON: DAILY REMINDER
// ============================================================

async function handleCron(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  const db = env.DB;
  const today = todayISO();
  const active = await getTodayBooking(db);

  let msg;
  if (active.length > 0) {
    const b = active[0];
    msg = `🅿️ <b>Daily parking update</b>\n\n` +
      `🔒 BOOKED — ${b.guest_name}\n📅 Checks out ${formatDate(b.checkout)}`;
  } else {
    msg = `🅿️ <b>Daily parking update</b>\n\n✅ Lock parking is AVAILABLE today`;
  }

  // Check if someone is arriving today
  const arrivals = await db.prepare(
    `SELECT * FROM parking_bookings WHERE checkin = ?`
  ).bind(today).all();

  if (arrivals.results.length > 0) {
    const a = arrivals.results[0];
    msg += `\n\n📥 Arriving today: ${a.guest_name}`;
  }

  // Next upcoming
  const future = await getFutureBookings(db);
  const nextBooking = future.find(b => b.checkin > today);
  if (nextBooking) {
    msg += `\n📋 Next booking: ${nextBooking.guest_name} — ${formatDate(nextBooking.checkin)}`;
  }

  await sendMessage(token, chatId, msg);
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Webhook endpoint for Telegram
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const update = await request.json();
      const token = env.TELEGRAM_BOT_TOKEN;
      const db = env.DB;

      try {
        // Handle callback queries (inline keyboard taps)
        if (update.callback_query) {
          await handleCallbackQuery(db, token, update.callback_query);
          return new Response('OK');
        }

        // Handle text messages
        const message = update.message;
        if (!message || !message.text) return new Response('OK');

        const chatId = message.chat.id;
        const text = message.text.trim();

        // Parse command and arguments
        const spaceIdx = text.indexOf(' ');
        const command = (spaceIdx > -1 ? text.slice(0, spaceIdx) : text).toLowerCase().replace(/@\w+$/, '');
        const argsStr = spaceIdx > -1 ? text.slice(spaceIdx + 1) : '';

        switch (command) {
          case '/parkcheck':
            await handleParkCheck(db, token, chatId, argsStr);
            break;
          case '/parkbook':
            await handleParkBook(db, token, chatId, argsStr);
            break;
          case '/parkunbook':
            await handleParkUnbook(db, token, chatId);
            break;
          case '/parkstatus':
            await handleParkStatus(db, token, chatId);
            break;
          case '/parkall':
            await handleParkAll(db, token, chatId);
            break;
          case '/start':
          case '/help':
          case '/park':
            await handleHelp(token, chatId);
            break;
          default:
            // Ignore unknown commands
            break;
        }
      } catch (err) {
        console.error('Error handling update:', err);
        // Attempt to notify user of error
        try {
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (chatId) {
            await sendMessage(token, chatId, `⚠️ Something went wrong: ${err.message}`);
          }
        } catch (_) { /* ignore */ }
      }

      return new Response('OK');
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Lock Parking Bot', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
};
