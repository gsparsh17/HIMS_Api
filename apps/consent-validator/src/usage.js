const crypto = require('crypto');
const mongoose = require('mongoose');
const { config } = require('./config');
const {
  ConsentUsageWindow,
  ConsentUsageReservation
} = require('./models');

function addWindow(start, unit, value) {
  const end = new Date(start);
  if (unit === 'HOUR') end.setUTCHours(end.getUTCHours() + value);
  if (unit === 'DAY') end.setUTCDate(end.getUTCDate() + value);
  if (unit === 'WEEK') end.setUTCDate(end.getUTCDate() + value * 7);
  if (unit === 'MONTH') end.setUTCMonth(end.getUTCMonth() + value);
  if (unit === 'YEAR') end.setUTCFullYear(end.getUTCFullYear() + value);
  return end;
}

function windowBounds(frequency, at = new Date()) {
  const unit = frequency.unit;
  const value = frequency.value;
  if (unit === 'MONTH') {
    const month = at.getUTCFullYear() * 12 + at.getUTCMonth();
    const bucket = Math.floor(month / value) * value;
    const start = new Date(Date.UTC(Math.floor(bucket / 12), bucket % 12, 1));
    return { start, end: addWindow(start, unit, value) };
  }
  if (unit === 'YEAR') {
    const year = Math.floor(at.getUTCFullYear() / value) * value;
    const start = new Date(Date.UTC(year, 0, 1));
    return { start, end: addWindow(start, unit, value) };
  }
  const sizeMs = {
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
    WEEK: 7 * 24 * 60 * 60 * 1000
  }[unit] * value;
  const start = new Date(Math.floor(at.getTime() / sizeMs) * sizeMs);
  return { start, end: new Date(start.getTime() + sizeMs) };
}

async function withOptionalTransaction(callback) {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await callback(session);
      });
      return result;
    } catch (error) {
      if (
        !config.requireMongoTransactions &&
        /Transaction numbers are only allowed|replica set|mongos/i.test(error.message)
      ) {
        return callback(null);
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
}

async function releaseExpiredReservations() {
  const expired = await ConsentUsageReservation.find({
    status: 'RESERVED',
    expiresAt: { $lte: new Date() }
  }).limit(200);
  for (const reservation of expired) {
    // eslint-disable-next-line no-await-in-loop
    await releaseReservation(reservation.reservationId, 'EXPIRED');
  }
}

async function reserveUsage({ consentIdHash, operationType, operationHash, frequency }) {
  if (!frequency?.maxUses) return null;
  await releaseExpiredReservations();
  const existing = await ConsentUsageReservation.findOne({ operationHash });
  if (existing?.status === 'COMMITTED' || existing?.status === 'RESERVED') {
    return existing;
  }

  const bounds = windowBounds(frequency);
  return withOptionalTransaction(async (session) => {
    const queryOptions = session ? { session } : {};
    const previous = await ConsentUsageReservation.findOne({ operationHash }, null, queryOptions);
    if (previous?.status === 'COMMITTED' || previous?.status === 'RESERVED') return previous;

    let window = await ConsentUsageWindow.findOne(
      { consentIdHash, operationType, windowStart: bounds.start },
      null,
      queryOptions
    );
    if (!window) {
      try {
        const created = await ConsentUsageWindow.create(
          [{
            consentIdHash,
            operationType,
            windowStart: bounds.start,
            windowEnd: bounds.end,
            maxUses: frequency.maxUses,
            used: 0,
            reserved: 0
          }],
          queryOptions
        );
        window = created[0];
      } catch (error) {
        if (error.code !== 11000) throw error;
        window = await ConsentUsageWindow.findOne(
          { consentIdHash, operationType, windowStart: bounds.start },
          null,
          queryOptions
        );
      }
    }
    window = await ConsentUsageWindow.findOneAndUpdate(
      {
        _id: window._id,
        $expr: { $lt: [{ $add: ['$used', '$reserved'] }, '$maxUses'] }
      },
      { $inc: { reserved: 1 } },
      { new: true, ...queryOptions }
    );

    if (!window) {
      const error = new Error('Consent frequency limit has been reached');
      error.code = 'CONSENT_FREQUENCY_EXCEEDED';
      error.statusCode = 409;
      throw error;
    }

    const reservationId = crypto.randomUUID();
    if (previous && ['RELEASED', 'EXPIRED'].includes(previous.status)) {
      previous.reservationId = reservationId;
      previous.windowId = window._id;
      previous.status = 'RESERVED';
      previous.expiresAt = new Date(Date.now() + config.reservationTtlSeconds * 1000);
      previous.committedAt = undefined;
      previous.releasedAt = undefined;
      await previous.save(queryOptions);
      return previous;
    }

    return ConsentUsageReservation.create(
      [
        {
          reservationId,
          operationHash,
          consentIdHash,
          operationType,
          windowId: window._id,
          status: 'RESERVED',
          expiresAt: new Date(Date.now() + config.reservationTtlSeconds * 1000)
        }
      ],
      queryOptions
    ).then((items) => items[0]);
  });
}

async function commitReservation(reservationId) {
  return withOptionalTransaction(async (session) => {
    const queryOptions = session ? { session } : {};
    const reservation = await ConsentUsageReservation.findOne({ reservationId }, null, queryOptions);
    if (!reservation) {
      const error = new Error('Consent usage reservation was not found');
      error.code = 'CONSENT_RESERVATION_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    if (reservation.status === 'COMMITTED') return reservation;
    if (reservation.status !== 'RESERVED') {
      const error = new Error(`Consent usage reservation is ${reservation.status}`);
      error.code = 'CONSENT_RESERVATION_NOT_ACTIVE';
      error.statusCode = 409;
      throw error;
    }
    await ConsentUsageWindow.updateOne(
      { _id: reservation.windowId, reserved: { $gte: 1 } },
      { $inc: { reserved: -1, used: 1 } },
      queryOptions
    );
    reservation.status = 'COMMITTED';
    reservation.committedAt = new Date();
    await reservation.save(queryOptions);
    return reservation;
  });
}

async function releaseReservation(reservationId, status = 'RELEASED') {
  return withOptionalTransaction(async (session) => {
    const queryOptions = session ? { session } : {};
    const reservation = await ConsentUsageReservation.findOne({ reservationId }, null, queryOptions);
    if (!reservation) return null;
    if (reservation.status !== 'RESERVED') return reservation;
    await ConsentUsageWindow.updateOne(
      { _id: reservation.windowId, reserved: { $gte: 1 } },
      { $inc: { reserved: -1 } },
      queryOptions
    );
    reservation.status = status;
    reservation.releasedAt = new Date();
    await reservation.save(queryOptions);
    return reservation;
  });
}

module.exports = {
  windowBounds,
  reserveUsage,
  commitReservation,
  releaseReservation,
  releaseExpiredReservations
};
