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

  // Dash shorthand: "1-2 July", "1-2 July 2026"
  const dashMatch = argsStr.match(/^(\d{1,2})-(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?\s*(.*)$/);
  if (dashMatch) {
    const [, day1, day2, month, year, rest] = dashMatch;
    const dateStr1 = year ? `${day1} ${month} ${year}` : `${day1} ${month}`;
    const dateStr2 = year ? `${day2} ${month} ${year}` : `${day2} ${month}`;
    const d1 = parseDate(dateStr1);
    const d2 = parseDate(dateStr2);
    if (d1 && d2) {
      return { checkin: d1, checkout: d2, remainder: rest.trim() };
    }
  }

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
// REPLY KEYBOARD
// ============================================================

const REPLY_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Status' }, { text: '📋 All Bookings' }, { text: '🗑️ Unbook' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

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
    reply_markup: replyMarkup || REPLY_KEYBOARD,
  };
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
    `<code>/parkcheck 1-3 July</code> (or <code>/pc</code>)\nCheck if parking is available\n\n` +
    `<code>/parkbook 1-3 July Guest Name</code> (or <code>/pb</code>)\nBook parking for a guest\n\n` +
    `<code>/parkunbook</code> (or <code>/pu</code>)\nRemove a parking booking\n\n` +
    `<code>/parkstatus</code> (or <code>/ps</code>)\nToday's parking status\n\n` +
    `<code>/parkall</code> (or <code>/pa</code>)\nList all upcoming bookings\n\n` +
    `<b>Date formats:</b>\n` +
    `<code>1-3 July</code> — same month\n` +
    `<code>30 June 1 July</code> — cross-month\n` +
    `<code>31 December 2026 1 January 2027</code> — cross-year\n\n` +
    `💡 Checkout day = available for new guest (e.g. booking 1-3 July means spot is free on 3 July)\n\n` +
    `💡 Use the keyboard buttons below for quick access to status, bookings, and unbook.`;
  return sendMessage(token, chatId, msg);
}

// ============================================================
// ICAL FETCHING & PARSING
// ============================================================

const UNIT_LABELS = {
  COTTAGE: 'Cottage',
  TINYHOME: 'Tiny Home',
  GLAMPING: 'Glamping',
};

const PLATFORM_LABELS = {
  LEKKESLAAP: 'LekkeSlaap',
  GOOGLE: 'Google Calendar',
  AIRBNB: 'Airbnb',
};

/**
 * Collect iCal feeds from known env vars.
 * Returns [{ unit, platform, url }]
 */
function getIcalFeeds(env) {
  const FEED_KEYS = [
    ['ICAL_COTTAGE_LEKKESLAAP', 'COTTAGE', 'LEKKESLAAP'],
    ['ICAL_COTTAGE_GOOGLE', 'COTTAGE', 'GOOGLE'],
    ['ICAL_COTTAGE_AIRBNB', 'COTTAGE', 'AIRBNB'],
    ['ICAL_TINYHOME_LEKKESLAAP', 'TINYHOME', 'LEKKESLAAP'],
    ['ICAL_TINYHOME_GOOGLE', 'TINYHOME', 'GOOGLE'],
    ['ICAL_TINYHOME_AIRBNB', 'TINYHOME', 'AIRBNB'],
    ['ICAL_GLAMPING_LEKKESLAAP', 'GLAMPING', 'LEKKESLAAP'],
    ['ICAL_GLAMPING_GOOGLE', 'GLAMPING', 'GOOGLE'],
    ['ICAL_GLAMPING_AIRBNB', 'GLAMPING', 'AIRBNB'],
  ];

  const feeds = [];
  for (const [key, unitKey, platformKey] of FEED_KEYS) {
    if (env[key]) {
      feeds.push({
        unit: UNIT_LABELS[unitKey],
        platform: PLATFORM_LABELS[platformKey],
        url: env[key],
      });
    }
  }
  return feeds;
}

/**
 * Unfold iCal lines (continuation lines start with a space or tab).
 */
function unfoldIcal(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

/**
 * Parse VEVENT blocks from iCal text.
 * Returns [{ startDate, endDate, summary }] with dates as YYYY-MM-DD.
 */
function parseIcalEvents(icalText) {
  const unfolded = unfoldIcal(icalText);
  const events = [];
  const blocks = unfolded.split('BEGIN:VEVENT');

  for (const block of blocks.slice(1)) {
    const end = block.indexOf('END:VEVENT');
    if (end === -1) continue;
    const content = block.slice(0, end);

    const dtstartMatch = content.match(/DTSTART[^:]*:(\d{8})/);
    const dtendMatch = content.match(/DTEND[^:]*:(\d{8})/);
    const summaryMatch = content.match(/SUMMARY:(.*)/);

    if (dtstartMatch) {
      const ds = dtstartMatch[1];
      const startDate = `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`;
      let endDate = null;
      if (dtendMatch) {
        const de = dtendMatch[1];
        endDate = `${de.slice(0,4)}-${de.slice(4,6)}-${de.slice(6,8)}`;
      }
      const summary = summaryMatch ? summaryMatch[1].trim() : 'Unknown';
      events.push({ startDate, endDate, summary });
    }
  }
  return events;
}

/**
 * Check if an iCal event should be skipped (e.g. Airbnb blocked dates).
 */
function shouldSkipEvent(summary) {
  return /not available/i.test(summary);
}

/**
 * Extract a guest name from an iCal SUMMARY.
 * LekkeSlaap format: "Reference: LS-XXX - Customer: John Smith - ..."
 * Airbnb: "Reserved"
 * Falls back to the full summary (truncated).
 */
function extractGuestName(summary) {
  // LekkeSlaap: look for "Customer: Name"
  const customerMatch = summary.match(/Customer:\s*([^-\n]+)/i);
  if (customerMatch) return customerMatch[1].trim();

  // Generic: return summary, truncated
  return summary.length > 30 ? summary.slice(0, 30) + '…' : summary;
}

/**
 * Fetch all iCal feeds and return today's bookings grouped by unit.
 * Returns { unitName: [{ platform, guestName }] }
 */
async function fetchTodayBookings(env) {
  const feeds = getIcalFeeds(env);
  if (feeds.length === 0) return {};

  const today = todayISO();
  const results = {};

  // Initialize all units
  for (const feed of feeds) {
    if (!results[feed.unit]) results[feed.unit] = [];
  }

  const fetches = feeds.map(async (feed) => {
    try {
      const resp = await fetch(feed.url, {
        headers: { 'User-Agent': 'LockParkingBot/1.0' },
      });
      if (!resp.ok) return;
      const text = await resp.text();
      const events = parseIcalEvents(text);

      for (const event of events) {
        if (shouldSkipEvent(event.summary)) continue;
        // Active today: startDate <= today < endDate
        const isActive = event.startDate <= today &&
          (event.endDate ? event.endDate > today : event.startDate === today);
        if (isActive) {
          results[feed.unit].push({
            platform: feed.platform,
            guestName: extractGuestName(event.summary),
          });
        }
      }
    } catch (err) {
      console.error(`Failed to fetch iCal for ${feed.unit}/${feed.platform}:`, err.message);
    }
  });

  await Promise.all(fetches);
  return results;
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

  // Parking status
  let msg;
  if (active.length > 0) {
    const b = active[0];
    msg = `🅿️ <b>Parking:</b> Booked — ${b.guest_name} (out ${formatDate(b.checkout)})`;
  } else {
    msg = `🅿️ <b>Parking:</b> Available`;
  }

  // Today's bookings from iCal feeds
  const bookings = await fetchTodayBookings(env);
  const units = Object.keys(bookings);

  if (units.length > 0) {
    msg += `\n\n📋 <b>Today's Bookings:</b>`;
    for (const unit of units) {
      const unitBookings = bookings[unit];
      if (unitBookings.length > 0) {
        // Deduplicate by guest name (same guest may appear in multiple calendars)
        const seen = new Set();
        const unique = unitBookings.filter(b => {
          const key = b.guestName.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        for (const b of unique) {
          msg += `\n• ${unit}: ${b.guestName} (${b.platform})`;
        }
      } else {
        msg += `\n• ${unit}: No booking`;
      }
    }
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
          case '/pc':
          case '/parkcheck':
            await handleParkCheck(db, token, chatId, argsStr);
            break;
          case '/pb':
          case '/parkbook':
            await handleParkBook(db, token, chatId, argsStr);
            break;
          case '/pu':
          case '/parkunbook':
            await handleParkUnbook(db, token, chatId);
            break;
          case '/ps':
          case '/parkstatus':
            await handleParkStatus(db, token, chatId);
            break;
          case '/pa':
          case '/parkall':
            await handleParkAll(db, token, chatId);
            break;
          case '/start':
          case '/help':
          case '/park':
            await handleHelp(token, chatId);
            break;
          default:
            // Handle reply keyboard button taps
            if (text === '📊 Status') {
              await handleParkStatus(db, token, chatId);
            } else if (text === '📋 All Bookings') {
              await handleParkAll(db, token, chatId);
            } else if (text === '🗑️ Unbook') {
              await handleParkUnbook(db, token, chatId);
            }
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
