'use strict';

const NotificationDelivery = require('../models/NotificationDelivery');
const { getOrCreateNabhSetting } = require('./nabhSetting.service');
const sendEmail = require('../utils/sendEmail');
const net = require('net');

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_error) { return String(value); }
}

function isPrivateIp(hostname) {
  if (net.isIP(hostname) === 4) {
    const octets = hostname.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (net.isIP(hostname) === 6) {
    const value = hostname.toLowerCase();
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  }
  return false;
}

function validatedProviderUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_error) {
    throw new Error('Notification provider endpoint is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Notification provider endpoint must use HTTP or HTTPS');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('Notification provider endpoint must use HTTPS in production');
  }
  const hostname = parsed.hostname.toLowerCase();
  const allowPrivate = String(process.env.ALLOW_PRIVATE_NOTIFICATION_ENDPOINTS || 'false').toLowerCase() === 'true';
  if (!allowPrivate && (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || isPrivateIp(hostname)
  )) {
    throw new Error('Private or loopback notification endpoints are not allowed');
  }
  return parsed.toString();
}

async function sendWebhook(url, delivery, headers = {}) {
  if (!url) throw new Error('Webhook endpoint is not configured');
  const response = await fetch(validatedProviderUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      id: delivery._id,
      eventType: delivery.eventType,
      correlationId: delivery.correlationId,
      subject: delivery.subject,
      body: delivery.body,
      payload: delivery.payload
    }),
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Webhook failed (${response.status}): ${text.slice(0, 300)}`);
  return { statusCode: response.status, response: text.slice(0, 1000) };
}

async function sendChannel(channel, delivery, setting) {
  const config = (setting.notifications?.channels || []).find((item) => item.channel === channel);
  if (channel === 'portal') {
    return { provider: 'internal_outbox', success: true, response: { stored: true } };
  }
  if (!config?.enabled) throw new Error(`${channel} channel is disabled`);
  if (channel === 'email') {
    if (!delivery.contact?.email) throw new Error('Recipient email is missing');
    await sendEmail({
      to: delivery.contact.email,
      subject: delivery.subject || delivery.eventType,
      text: delivery.body
    });
    return { provider: 'configured_email', success: true };
  }
  if (channel === 'webhook') {
    const result = await sendWebhook(
      config.endpoint,
      delivery,
      config.headers || {}
    );
    return { provider: 'webhook', success: true, ...result };
  }
  if (channel === 'sms' || channel === 'whatsapp') {
    if (!delivery.contact?.phone) throw new Error('Recipient mobile number is missing');
    if (!config.endpoint) throw new Error(`${channel} provider endpoint is not configured`);
    const response = await fetch(validatedProviderUrl(config.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(config.headers || {})
      },
      body: JSON.stringify({
        to: delivery.contact.phone,
        sender: config.sender,
        message: delivery.body,
        subject: delivery.subject,
        eventType: delivery.eventType,
        correlationId: delivery.correlationId
      }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${channel} provider failed (${response.status}): ${text.slice(0, 300)}`);
    return {
      provider: `configured_${channel}`,
      success: true,
      statusCode: response.status,
      response: text.slice(0, 1000)
    };
  }
  throw new Error(`Unsupported notification channel: ${channel}`);
}

/**
 * Deliver a one-time code without persisting the secret in the outbox.
 * Only the redacted audit row and provider outcome are stored. Retries are
 * intentionally disabled because a recoverable message must never contain an
 * OTP that remains readable in the database.
 */
async function sendSensitiveSms({ hospitalId, phone, message, subject, eventType, correlationId, createdBy }) {
  const setting = await getOrCreateNabhSetting(hospitalId, createdBy, { includeSecrets: true });
  const delivery = await NotificationDelivery.create({
    hospitalId,
    eventType,
    correlationId,
    recipientType: 'patient',
    contact: { phone },
    requestedChannels: ['sms'],
    subject,
    body: 'A one-time verification code was sent to the registered mobile number.',
    payload: { sensitiveContentRedacted: true },
    priority: 'high',
    status: 'sending',
    createdBy
  });
  try {
    const transientDelivery = {
      ...delivery.toObject(),
      body: message
    };
    const result = await sendChannel('sms', transientDelivery, setting);
    delivery.status = 'sent';
    delivery.sentAt = new Date();
    delivery.attempts.push({
      channel: 'sms',
      provider: result.provider,
      success: true,
      statusCode: result.statusCode
    });
  } catch (error) {
    delivery.status = 'failed';
    delivery.attempts.push({ channel: 'sms', success: false, error: error.message });
  }
  await delivery.save();
  return delivery;
}

async function processNotification(deliveryOrId) {
  const delivery = typeof deliveryOrId === 'string'
    ? await NotificationDelivery.findById(deliveryOrId)
    : deliveryOrId;
  if (!delivery || ['sent', 'acknowledged', 'cancelled'].includes(delivery.status)) return delivery;
  const setting = await getOrCreateNabhSetting(delivery.hospitalId, delivery.createdBy, { includeSecrets: true });
  delivery.status = 'sending';
  await delivery.save();

  let successes = 0;
  const requestedChannels = delivery.requestedChannels?.length
    ? delivery.requestedChannels
    : ['portal'];
  for (const channel of requestedChannels) {
    try {
      const result = await sendChannel(channel, delivery, setting);
      successes += 1;
      delivery.attempts.push({
        channel,
        provider: result.provider,
        success: true,
        statusCode: result.statusCode,
        response: result.response
      });
    } catch (error) {
      delivery.attempts.push({
        channel,
        success: false,
        error: error.message,
        response: safeJson(error.response?.data).slice(0, 1000)
      });
    }
  }

  const attempted = requestedChannels.length;
  if (successes === attempted && attempted > 0) {
    delivery.status = 'sent';
    delivery.sentAt = new Date();
  } else if (successes > 0) {
    delivery.status = 'partially_sent';
    delivery.sentAt = new Date();
  } else {
    delivery.retryCount += 1;
    const retryLimit = Number(setting.notifications?.retryLimit ?? 3);
    if (delivery.retryCount >= retryLimit) {
      delivery.status = 'failed';
    } else {
      delivery.status = 'queued';
      delivery.nextAttemptAt = new Date(
        Date.now() + Number(setting.notifications?.retryDelayMinutes ?? 5) * 60000
      );
    }
  }
  await delivery.save();
  return delivery;
}

async function queueNotification(input, { processImmediately = true } = {}) {
  const setting = await getOrCreateNabhSetting(input.hospitalId, input.createdBy);
  const priority = input.priority || 'normal';
  const delivery = await NotificationDelivery.create({
    ...input,
    priority,
    requireAcknowledgement: input.requireAcknowledgement
      ?? (priority === 'critical' && setting.notifications?.requireAcknowledgementForCritical)
  });
  if (processImmediately) {
    try { await processNotification(delivery); } catch (error) {
      delivery.status = 'failed';
      delivery.attempts.push({ channel: 'system', success: false, error: error.message });
      await delivery.save();
    }
  }
  return delivery;
}

async function processDueNotifications({ limit = 100 } = {}) {
  const deliveries = await NotificationDelivery.find({
    status: 'queued',
    nextAttemptAt: { $lte: new Date() }
  }).sort({ nextAttemptAt: 1 }).limit(limit);
  for (const delivery of deliveries) {
    await processNotification(delivery); // eslint-disable-line no-await-in-loop
  }
  return deliveries.length;
}

module.exports = {
  queueNotification,
  processNotification,
  processDueNotifications,
  sendSensitiveSms,
  validatedProviderUrl
};
