const sendEmail = require('../utils/sendEmail');
const Hospital = require('../models/Hospital');

const clean = (value, max = 5000) => String(value || '').trim().slice(0, max);

exports.submitSupportTicket = async (req, res) => {
  try {
    const subject = clean(req.body.subject, 180);
    const category = clean(req.body.category, 80) || 'General';
    const priority = clean(req.body.priority, 40) || 'Normal';
    const message = clean(req.body.message, 8000);
    const contactPhone = clean(req.body.contactPhone, 30);
    if (!subject || !message) return res.status(400).json({ error: 'Subject and query details are required' });

    const supportEmail = process.env.MEDIQLIQ_SUPPORT_EMAIL || process.env.RECIPIENT_EMAIL;
    if (!supportEmail) return res.status(500).json({ error: 'MEDIQLIQ_SUPPORT_EMAIL is not configured' });

    let hospital = req.user?.hospital_id ? await Hospital.findById(req.user.hospital_id) : null;
    if (!hospital) hospital = await Hospital.findOne();
    const submittedBy = [req.user?.first_name || req.user?.firstName, req.user?.last_name || req.user?.lastName].filter(Boolean).join(' ') || req.user?.name || 'Admin';
    const ticketRef = `MQ-${Date.now().toString(36).toUpperCase()}`;
    const body = [
      `MediQliq Support Ticket: ${ticketRef}`,
      '',
      `Hospital: ${hospital?.hospitalName || hospital?.name || 'Not available'}`,
      `Hospital ID: ${req.user?.hospital_id || hospital?._id || 'Not available'}`,
      `Submitted by: ${submittedBy} (${req.user?.email || 'No email'})`,
      `Contact phone: ${contactPhone || req.user?.phone || 'Not provided'}`,
      `Category: ${category}`,
      `Priority: ${priority}`,
      `Subject: ${subject}`,
      '',
      'Query:',
      message,
      '',
      `Submitted at: ${new Date().toISOString()}`
    ].join('\n');

    await sendEmail({
      to: supportEmail,
      subject: `[${priority}] ${ticketRef} - ${subject}`,
      text: body
    });

    res.status(201).json({ success: true, message: 'Support ticket emailed to MediQliq', ticketRef });
  } catch (error) {
    console.error('Error submitting support ticket:', error);
    res.status(500).json({ error: 'Unable to submit support ticket. Please verify email configuration.' });
  }
};
