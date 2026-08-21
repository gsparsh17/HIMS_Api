const crypto = require('crypto');
const Hospital = require('../models/Hospital');
const SupportTicketOutbox = require('../models/SupportTicketOutbox');
const { platformRequest } = require('../services/platformClient.service');

const clean = (value, max = 5000) => String(value || '').trim().slice(0, max);

function normalizePriority(value) {
  const priority = clean(value, 20).toUpperCase();
  return ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority) ? priority : 'NORMAL';
}

async function sendOutbox(row) {
  row.attempts += 1;
  try {
    const response = await platformRequest('/internal/platform/support-tickets', row.payload);
    row.status = 'DELIVERED';
    row.deliveredAt = new Date();
    row.masterTicketRef = response.ticketRef;
    row.lastError = undefined;
    await row.save();
    return response;
  } catch (error) {
    row.status = row.attempts >= Number(process.env.SUPPORT_OUTBOX_MAX_ATTEMPTS || 20) ? 'FAILED' : 'PENDING';
    row.lastError = String(error.message || error).slice(0, 1000);
    const delay = Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(row.attempts, 7)));
    row.nextRetryAt = new Date(Date.now() + delay);
    await row.save();
    throw error;
  }
}

exports.submitSupportTicket = async (req, res) => {
  try {
    const subject = clean(req.body.subject, 180);
    const category = clean(req.body.category, 80) || 'General';
    const priority = normalizePriority(req.body.priority);
    const message = clean(req.body.message, 8000);
    const contactPhone = clean(req.body.contactPhone, 30);
    if (!subject || !message) return res.status(400).json({ error: 'Subject and query details are required' });

    let hospital = req.user?.hospital_id ? await Hospital.findById(req.user.hospital_id) : null;
    if (!hospital) hospital = await Hospital.findOne({ is_active: { $ne: false } });
    if (!hospital) return res.status(409).json({ error: 'Hospital is not provisioned' });

    const ticketRequestId = crypto.randomUUID();
    const payload = {
      ticketRequestId,
      category,
      priority,
      subject,
      message,
      submittedBy: {
        userId: String(req.user?._id || ''),
        name: req.user?.name || 'Hospital Admin',
        email: req.user?.email || '',
        phone: contactPhone || req.user?.phone || ''
      }
    };

    const outbox = await SupportTicketOutbox.create({
      ticketRequestId,
      hospitalId: hospital._id,
      payload,
      status: 'PENDING',
      nextRetryAt: new Date()
    });

    try {
      const response = await sendOutbox(outbox);
      return res.status(201).json({ success: true, message: 'Support ticket submitted to MediQliq', ticketRef: response.ticketRef });
    } catch (error) {
      return res.status(202).json({
        success: true,
        queued: true,
        message: 'Support request saved locally and will be retried automatically because MediQliq Master is temporarily unavailable.',
        ticketRequestId
      });
    }
  } catch (error) {
    console.error('Error submitting support ticket:', error);
    return res.status(500).json({ error: 'Unable to save support ticket request.' });
  }
};

exports._sendOutbox = sendOutbox;
