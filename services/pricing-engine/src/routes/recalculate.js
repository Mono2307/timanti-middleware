'use strict';

const { Router }               = require('express');
const { RecalculationService } = require('../services/recalculation.service');

const router  = Router();
const service = new RecalculationService();

const VALID_DISCOUNT_TYPES = ['diamond_flat', 'diamond_percent'];

router.post('/recalculate', async (req, res) => {
  const { draftOrderId, discountType = 'diamond_flat' } = req.body;

  if (!draftOrderId) {
    res.status(400).json({ success: false, error: 'draftOrderId required' });
    return;
  }

  if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
    res.status(400).json({
      success: false,
      error: `discountType must be one of: ${VALID_DISCOUNT_TYPES.join(', ')}`,
    });
    return;
  }

  try {
    const pricing = await service.recalculate({ draftOrderId, discountType });
    res.json({ success: true, pricing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Recalculation failed' });
  }
});

module.exports = router;
