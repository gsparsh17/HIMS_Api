const fs = require('fs');
const path = require('path');
const StoredFile = require('../models/StoredFile');
const fileStorage = require('../services/fileStorage.service');

function contentDisposition(record, download) {
  const type = download ? 'attachment' : 'inline';
  const fallback = `file-${record._id}`;
  const name = String(record.originalName || fallback).replace(/[\r\n"]/g, '_');
  return `${type}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

exports.streamFile = async (req, res, next) => {
  try {
    const record = await StoredFile.findOne({ _id: req.params.fileId, status: 'active' });
    if (!record || !fileStorage.canAccess(record, req.user)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const filePath = fileStorage.absolutePath(record.storageKey);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File content is unavailable' });

    res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(record.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(record, req.query.download === '1'));
    res.setHeader('Cache-Control', record.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    const stream = fs.createReadStream(filePath);
    stream.on('error', next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
};

exports.deleteFile = async (req, res, next) => {
  try {
    const record = await StoredFile.findOne({ _id: req.params.fileId, status: 'active' });
    if (!record || !fileStorage.canAccess(record, req.user)) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!['admin', 'mediqliq_super_admin'].includes(req.user?.role) && String(record.uploadedBy || '') !== String(req.user?._id || '')) {
      return res.status(403).json({ error: 'You are not allowed to delete this file' });
    }

    const filePath = fileStorage.absolutePath(record.storageKey);
    await fs.promises.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    record.status = 'deleted';
    record.deletedAt = new Date();
    await record.save();
    return res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    next(error);
  }
};
