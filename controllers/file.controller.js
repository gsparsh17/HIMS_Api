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

    let opened;
    try {
      opened = await fileStorage.openRead(record);
    } catch (error) {
      if (error?.statusCode === 404 || error?.b2Code === 'not_found' || error?.code === 'ENOENT') {
        return res.status(404).json({ error: 'File content is unavailable' });
      }
      throw error;
    }

    res.setHeader('Content-Type', opened.contentType || record.mimeType || 'application/octet-stream');
    if (opened.size || record.sizeBytes) res.setHeader('Content-Length', String(opened.size || record.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(record, req.query.download === '1'));
    res.setHeader('Cache-Control', record.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    opened.stream.on('error', next);
    opened.stream.pipe(res);
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

    await fileStorage.deleteStoredFile(record);
    record.status = 'deleted';
    record.deletedAt = new Date();
    await record.save();
    return res.json({ success: true, message: 'File deleted' });
  } catch (error) {
    next(error);
  }
};
