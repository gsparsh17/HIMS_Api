'use strict';

const HelpArticle = require('../models/HelpArticle');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

exports.create = async (req, res) => {
  try {
    required(req.body, ['slug', 'category', 'title', 'content']);

    const row = await HelpArticle.create({
      hospitalId: hospitalId(req),
      slug: req.body.slug,
      category: req.body.category,
      title: req.body.title,
      content: req.body.content,
      keywords: req.body.keywords || [],
      active: req.body.active !== false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.list = async (req, res) => {
  try {
    const hid = hospitalId(req);
    const search = String(req.query.search || '').trim();

    const filter = {
      $or: [
        { hospitalId: hid },
        { hospitalId: null }
      ],
      active: true
    };

    if (req.query.category) {
      filter.category = req.query.category;
    }

    if (search) {
      const rx = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );

      filter.$and = [
        {
          $or: [
            { title: rx },
            { content: rx },
            { keywords: rx }
          ]
        }
      ];
    }

    const data = await HelpArticle
      .find(filter)
      .sort({ category: 1, title: 1 })
      .limit(200)
      .lean();

    return res.json({
      success: true,
      data
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.get = async (req, res) => {
  try {
    const row = await HelpArticle
      .findOne({
        hospitalId: hospitalId(req),
        slug: req.params.slug,
        active: true
      })
      .lean();

    if (!row) {
      return res.status(404).json({
        error: 'Help article not found'
      });
    }

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};