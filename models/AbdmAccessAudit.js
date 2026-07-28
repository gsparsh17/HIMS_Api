const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    importedRecordId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmImportedRecord', index: true },
    packetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmPacket', index: true },
    packetVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AbdmPacketVersion', index: true },
    consentId: { type: String, index: true },
    action: {
      type: String,
      enum: [
        'LIST',
        'VIEW',
        'DOWNLOAD',
        'EXPORT',
        'CONSENT_REQUEST',
        'HI_REQUEST',
        'PACKET_PREVIEW',
        'PACKET_VIEW',
        'PACKET_FHIR_VIEW',
        'PACKET_VALIDATE',
        'PACKET_APPROVE',
        'DISCLOSURE_VIEW'
      ],
      required: true,
      index: true
    },
    purpose: String,
    sourceIpHash: String,
    userAgentHash: String,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

schema.index({ hospitalId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('AbdmAccessAudit', schema);
