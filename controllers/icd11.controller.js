const ICD11 = require('../models/icd11.model');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// Search ICD-11 codes
exports.searchICD = async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const results = await ICD11.find({
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { code: { $regex: q, $options: 'i' } },
        { search_terms: { $in: [new RegExp(q, 'i')] } }
      ]
    })
    .limit(parseInt(limit))
    .sort({ code: 1 });
    
    res.json({
      success: true,
      results: results.map(r => ({
        code: r.code,
        title: r.title,
        full_name: `${r.code} - ${r.title}`
      }))
    });
  } catch (err) {
    console.error('Error searching ICD-11:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get ICD-11 by code
exports.getICDByCode = async (req, res) => {
  try {
    const { code } = req.params;
    const icdCode = await ICD11.findOne({ code: code.toUpperCase() });
    
    if (!icdCode) {
      return res.status(404).json({ error: 'ICD-11 code not found' });
    }
    
    res.json({
      success: true,
      data: {
        code: icdCode.code,
        title: icdCode.title,
        definition: icdCode.definition
      }
    });
  } catch (err) {
    console.error('Error fetching ICD-11 code:', err);
    res.status(500).json({ error: err.message });
  }
};

// Import ICD-11 data
exports.importICD11Data = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a JSON or CSV file' });
    }
    
    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    
    let data = [];
    
    if (fileExt === '.json') {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(fileContent);
    } else if (fileExt === '.csv') {
      data = await parseCSV(filePath);
    } else {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Unsupported file format. Please upload JSON or CSV.' });
    }
    
    fs.unlinkSync(filePath);
    
    let inserted = 0;
    let skipped = 0;
    
    for (const item of data) {
      try {
        const existing = await ICD11.findOne({ code: item.code });
        
        if (!existing) {
          const searchTerms = item.title
            .toLowerCase()
            .split(/[\s,()/-]+/)
            .filter(term => term.length > 2);
          
          await ICD11.create({
            entityId: item.entityId,
            code: item.code,
            title: item.title,
            definition: item.definition || '',
            parent: item.parent || null,
            children: item.children || [],
            search_terms: searchTerms
          });
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error('Error inserting item:', item.code, err.message);
      }
    }
    
    res.json({
      success: true,
      message: 'ICD-11 data imported successfully',
      stats: { inserted, skipped, total: data.length }
    });
  } catch (err) {
    console.error('Error importing ICD-11 data:', err);
    res.status(500).json({ error: err.message });
  }
};

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}