const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  }
});

// ─── WhatsApp invite link ────────────────
function getWhatsAppLink({ to_phone, from_name, relation_tamil, type = 'request' }) {
  const appLink = 'https://frootze.com';
  let message;

  if (type === 'request') {
    message = `🌳 வணக்கம்!\n\n*${from_name}* frootze-ல் உங்களை தங்கள் *${relation_tamil}* ஆக சேர்க்க கோரிக்கை அனுப்பியுள்ளார்.\n\nஏற்க / நிராகரிக்க frootze.com-ஐ திறக்கவும்:\n${appLink}\n\n_${from_name} has sent you a family connection request on frootze._`;
  } else {
    message = `🌳 வணக்கம்!\n\n*${from_name}* உங்களை frootze குடும்ப மரத்தில் *${relation_tamil}* ஆக சேர்க்க அழைக்கிறார்.\n\nபதிவு செய்ய:\n${appLink}\n\n_${from_name} has invited you to join frootze family tree._`;
  }

  const encoded = encodeURIComponent(message);
  if (to_phone) return `https://wa.me/91${to_phone}?text=${encoded}`;
  return `https://wa.me/?text=${encoded}`;
}

// ─── Email notification ──────────────────
async function sendEmail({ to_email, from_name, relation_tamil, type = 'request' }) {
  if (!to_email) return { success: false, error: 'No email' };
  const appLink = 'https://frootze.com';

  const isRequest = type === 'request';
  const subject = isRequest
    ? `${from_name} உங்களை frootze-ல் ${relation_tamil} ஆக சேர்க்க கோருகிறார்`
    : `${from_name} உங்களை frootze குடும்ப மரத்தில் அழைக்கிறார்`;

  try {
    await transporter.sendMail({
      from: `"frootze குடும்பம் 🌳" <${process.env.GMAIL_USER}>`,
      to: to_email,
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f4ff;padding:20px;border-radius:16px;">
          <div style="text-align:center;margin-bottom:20px;">
            <h1 style="color:#6B21A8;font-size:28px;margin:0;">🌳 frootze</h1>
            <p style="color:#666;font-size:13px;">Your Family. Your Roots.</p>
          </div>
          <div style="background:white;border-radius:12px;padding:24px;margin-bottom:16px;">
            <h2 style="color:#1a0533;font-size:18px;">வணக்கம்! 👋</h2>
            <p style="color:#444;font-size:15px;line-height:1.6;">
              <strong>${from_name}</strong> ${isRequest
                ? `frootze-ல் உங்களை <strong>${relation_tamil}</strong> ஆக சேர்க்க கோரிக்கை அனுப்பியுள்ளார்.`
                : `உங்களை frootze குடும்ப மரத்தில் <strong>${relation_tamil}</strong> ஆக சேர்க்க அழைக்கிறார்.`
              }
            </p>
            <p style="color:#666;font-size:13px;">
              ${isRequest
                ? `${from_name} has sent you a family connection request on frootze.`
                : `${from_name} has invited you to join their family tree on frootze.`
              }
            </p>
          </div>
          <div style="text-align:center;margin:20px 0;">
            <a href="${appLink}" style="background:linear-gradient(135deg,#6B21A8,#059669);color:white;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:bold;font-size:15px;">
              ${isRequest ? 'frootze-ல் பார்க்கவும் / View on frootze' : 'பதிவு செய்யவும் / Register Now'}
            </a>
          </div>
          <p style="color:#999;font-size:11px;text-align:center;">இலவசம் · frootze.com</p>
        </div>
      `
    });
    return { success: true };
  } catch (err) {
    console.error('Email error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Telegram notification ───────────────
async function sendTelegram({ chat_id, from_name, relation_tamil, type = 'request' }) {
  if (!chat_id || !process.env.TELEGRAM_BOT_TOKEN) return { success: false };
  const appLink = 'https://frootze.com';

  const message = type === 'request'
    ? `🌳 *frootze குடும்ப கோரிக்கை!*\n\n*${from_name}* உங்களை தங்கள் *${relation_tamil}* ஆக சேர்க்க கோருகிறார்.\n\nஏற்க / நிராகரிக்க:\n${appLink}\n\n_${from_name} sent you a family request on frootze._`
    : `🌳 *frootze அழைப்பு!*\n\n*${from_name}* உங்களை frootze குடும்ப மரத்தில் *${relation_tamil}* ஆக சேர்க்க அழைக்கிறார்.\n\nபதிவு செய்ய: ${appLink}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: message, parse_mode: 'Markdown' })
    });
    const data = await res.json();
    if (data.ok) return { success: true };
    return { success: false, error: data.description };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { getWhatsAppLink, sendEmail, sendTelegram };
