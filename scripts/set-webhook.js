#!/usr/bin/env node
// Usage: TELEGRAM_BOT_TOKEN=xxx WORKER_URL=https://your-worker.workers.dev node scripts/set-webhook.js

const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrl = process.env.WORKER_URL;

if (!token || !workerUrl) {
  console.error('Usage: TELEGRAM_BOT_TOKEN=xxx WORKER_URL=https://your-worker.workers.dev node scripts/set-webhook.js');
  process.exit(1);
}

const webhookUrl = `${workerUrl}/webhook`;

fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: webhookUrl }),
})
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      console.log(`✅ Webhook set to: ${webhookUrl}`);
    } else {
      console.error('❌ Failed:', data.description);
    }
  })
  .catch(err => console.error('❌ Error:', err));
