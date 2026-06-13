const nodemailer = require('nodemailer');
console.log('📧 sendEmail module loaded, SMTP_HOST:', process.env.SMTP_HOST ? 'SET' : 'MISSING');
let transporter;

async function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  } else {
    const test = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: test.user, pass: test.pass }
    });
  }
  await transporter.verify();
  console.log('✅ SMTP transporter ready');
  return transporter;
}

const FROM = process.env.FROM_EMAIL || process.env.EMAIL_FROM || 'MarketMix <noreply@marketmix.com>';

async function sendEmail({ to, subject, html }) {
  try {
    const t = await getTransporter();
    const info = await t.sendMail({ from: FROM, to, subject, html });
    if (!process.env.SMTP_HOST) console.log('Email preview:', nodemailer.getTestMessageUrl(info));
    return true;
} catch (err) {
  console.error('sendEmail error:', err.message);
  throw err; // ← let the caller see it
}
}

module.exports = { sendEmail };
