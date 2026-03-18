const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const TRIGGER = 'FROOTZE OTP';

console.log('Starting frootze WhatsApp OTP Bot...');
console.log('whatsapp-web.js version:', require('./node_modules/whatsapp-web.js/package.json').version);

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'frootze',
    dataPath: './whatsapp-session'
  }),
  puppeteer: {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('\n[EVENT] QR received — scan with WhatsApp\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('[EVENT] authenticated fired ✅');
});

client.on('auth_failure', (msg) => {
  console.log('[EVENT] auth_failure:', msg);
});

client.on('loading_screen', (percent, message) => {
  console.log(`[EVENT] loading_screen: ${percent}% - ${message}`);
});

client.on('ready', () => {
  console.log('[EVENT] ready fired ✅ Bot is ready!');
});

client.on('disconnected', (reason) => {
  console.log('[EVENT] disconnected:', reason);
});

client.on('message', async (msg) => {
  const body = msg.body.trim().toUpperCase();
  console.log(`[MSG] From: ${msg.from} | Body: ${msg.body}`);

  if (!body.startsWith(TRIGGER)) return;

  const parts = body.split(' ');
  const phone = parts[2]?.replace(/\D/g, '');

  if (!phone || phone.length < 10) {
    await msg.reply('Format: FROOTZE OTP 9448102615');
    return;
  }

  try {
    const response = await axios.post(`${BACKEND_URL}/api/auth/whatsapp-verify`, { phone });
    const { otp, name } = response.data;
    const greeting = name ? `வணக்கம் ${name}! 🙏\n\n` : '';
    await msg.reply(
      `${greeting}🔐 உங்கள் frootze OTP:\n\n*${otp}*\n\n⏰ Valid for 10 minutes\n\n🌳 www.frootze.com`
    );
    console.log(`[OTP Sent] ${phone} → ${otp}`);
  } catch (err) {
    console.error('[Error]', err.response?.data || err.message);
    await msg.reply('❌ Please visit www.frootze.com and request OTP first.');
  }
});

console.log('Initializing client...');
client.initialize();
