# Lock Parking Bot 🅿️

Telegram bot for managing a single lock parking spot across multiple guesthouse units. Built on Cloudflare Workers + D1.

## What it does

- Check if lock parking is available for specific dates
- Book and unbook parking with guest names
- Daily morning reminder of parking status (08:00 SAST)
- Handles checkout-day logic: a booking for 1–3 July means the spot is free for a new arrival on 3 July

## Commands

| Command | Description |
|---------|-------------|
| `/parkcheck 1-3 July` | Check availability for dates |
| `/parkbook 1-3 July Jan van Niekerk` | Book parking for a guest |
| `/parkunbook` | List bookings with remove buttons |
| `/parkstatus` | Today's parking status |
| `/parkall` | All upcoming bookings |
| `/help` | Show command reference |

**Date formats supported:**
- `1-3 July` — same month shorthand
- `30 June 1 July` — cross-month
- `31 December 2026 1 January 2027` — cross-year (include year on both)
- `5 July 8 July` — original format still works
- `2026-07-05 2026-07-08` — ISO format

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → follow prompts → save the **bot token**
3. Set commands (optional):
   ```
   /setcommands
   parkcheck - Check parking availability
   parkbook - Book parking for a guest
   parkunbook - Remove a parking booking
   parkstatus - Today's parking status
   parkall - List all upcoming bookings
   help - Show commands
   ```
4. Get your **chat ID**: message [@userinfobot](https://t.me/userinfobot) or send a message to your bot and check `https://api.telegram.org/bot<TOKEN>/getUpdates`

### 2. Create D1 Database

```bash
npx wrangler d1 create lock-parking-db
```

Copy the `database_id` from the output into `wrangler.toml`.

### 3. Initialise the Database

```bash
# Remote (production)
npx wrangler d1 execute lock-parking-db --file=schema.sql

# Local (for dev)
npx wrangler d1 execute lock-parking-db --local --file=schema.sql
```

### 4. Set Secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Paste your bot token

npx wrangler secret put TELEGRAM_CHAT_ID
# Paste your chat ID (for daily reminders)
```

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. Set Webhook

```bash
TELEGRAM_BOT_TOKEN=<your-token> WORKER_URL=https://lock-parking-bot.<your-subdomain>.workers.dev node scripts/set-webhook.js
```

### 7. Test

Send `/parkstatus` to your bot. You should get a response showing the parking is available.

## Local Development

```bash
npx wrangler dev
```

Then use a tool like ngrok to expose your local server and set the webhook to the ngrok URL for testing.

## Daily Reminder

The cron trigger runs at 06:00 UTC (08:00 SAST) daily and sends a parking status summary to your `TELEGRAM_CHAT_ID`. Adjust the cron schedule in `wrangler.toml` if needed.

## Architecture

```
Telegram → Cloudflare Worker (/webhook) → D1 Database
                                        → Telegram API (responses)
Cron (daily) → Worker → D1 → Telegram API (reminder)
```

Single D1 table: `parking_bookings` (id, guest_name, checkin, checkout, created_at, notes)
