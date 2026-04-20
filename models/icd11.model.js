const mongoose = require("mongoose");

const icdSchema = new mongoose.Schema({
  entityId: { type: String, unique: true }, // @id
  code: { type: String, index: true },
  title: String,
  definition: String,
  parent: String,
  children: [String]
}, { timestamps: true });

module.exports = mongoose.model("ICD11", icdSchema);