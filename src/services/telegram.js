const TelegramBot = require('node-telegram-bot-api');

let bot = null;

function getBot() {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
}

// Send invite message via Telegram
async function sendTelegramInvite({ to_username, from_name, relation_tamil, invite_link }) {
  const telegramBot = getBot();
  if (!telegramBot) {
    console.log('Telegram bot not configured');
    return { success: false, error: 'Bot not configured' };
  }

  try {
    const message = `🌳 *frootze குடும்ப அழைப்பு!*\n\n` +
      `*${from_name}* உங்களை frootze குடும்ப மரத்தில் *${relation_tamil || 'குடும்பத்தினர்'}* ஆக சேர்க்க அழைக்கிறார்.\n\n` +
      `_${from_name} has invited you to join their family tree on frootze._\n\n` +
      `👉 [குடும்ப மரத்தில் சேரவும் / Join Family Tree](${invite_link || 'https://frootze.com'})\n\n` +
      `🆓 இலவசம் · frootze.com`;

    // to_username can be chat_id or @username
    const chatId = to_username.startsWith('@') ? to_username : to_username;
    await telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    return { success: true };
  } catch (err) {
    console.error('Telegram error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendTelegramInvite };
