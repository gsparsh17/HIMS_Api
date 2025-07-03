// sendEmail.js placeholder
const nodemailer = require('nodemailer');

const sendEmail = async ({ to, subject, text }) => {
  const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

  await transporter.sendMail({
    from: `"HMS" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text
  });
};

module.exports = sendEmail;
