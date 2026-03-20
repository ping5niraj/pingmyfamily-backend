const express = require('express');
const router = express.Router();
const supabase = require('../supabase');

// ─────────────────────────────────────────
// POST /api/telegram/webhook
// Telegram bot webhook — handles messages
// ─────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond 200 to Telegram

  const update = req.body;
  if (!update) return;

  // Handle /start command
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const firstName = msg.from?.first_name || '';

    if (text.startsWith('/start')) {
      await sendTelegramMessage(chatId,
        `🌳 வணக்கம் ${firstName}! *frootze குடும்ப மரம்*-க்கு வரவேற்கிறோம்!\n\n` +
        `உங்கள் தொலைபேசி எண்ணை பதிவு செய்ய, கீழே உள்ள button-ஐ கிளிக் செய்யவும்.\n\n` +
        `_Welcome to frootze Family Tree! Click the button below to register your phone number._`,
        {
          reply_markup: {
            keyboard: [[{ text: '📱 எண்ணை பகிர் / Share Phone', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        }
      );
    }

    // Handle contact sharing
    else if (msg.contact) {
      const phone = msg.contact.phone_number?.replace(/\D/g, '').replace(/^91/, '');

      if (!phone || phone.length < 10) {
        await sendTelegramMessage(chatId, '❌ தவறான எண் / Invalid phone number. Please try again.');
        return;
      }

      // Check if phone exists in frootze
      const { data: user } = await supabase
        .from('pmf_users')
        .select('id, name, phone')
        .eq('phone', phone)
        .single();

      if (!user) {
        await sendTelegramMessage(chatId,
          `❌ +91${phone} frootze-ல் பதிவு செய்யப்படவில்லை.\n\n` +
          `முதலில் frootze.com-ல் பதிவு செய்யவும்:\nhttps://frootze.com\n\n` +
          `_This number is not registered on frootze. Please register first._`
        );
        return;
      }

      // Save telegram chat_id mapped to user
      await supabase
        .from('pmf_users')
        .update({ telegram_chat_id: chatId.toString() })
        .eq('id', user.id);

      await sendTelegramMessage(chatId,
        `✅ வணக்கம் *${user.name}*!\n\n` +
        `உங்கள் Telegram இப்போது frootze-உடன் இணைக்கப்பட்டது.\n` +
        `இனி குடும்ப கோரிக்கைகள் இங்கே வரும்! 🌳\n\n` +
        `_Hi ${user.name}! Your Telegram is now linked to frootze. You'll receive family notifications here!_`
      );
    }
  }
});

// ─────────────────────────────────────────
// GET /api/telegram/set-webhook
// One-time setup to register webhook with Telegram
// ─────────────────────────────────────────
router.get('/set-webhook', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookUrl = `${process.env.BACKEND_URL}/api/telegram/webhook`;

  if (!token) return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  if (!process.env.BACKEND_URL) return res.status(400).json({ error: 'BACKEND_URL not set' });

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await response.json();
    return res.json({ success: data.ok, result: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function sendTelegramMessage(chatId, text, extra = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra })
  });
}

module.exports = router;
