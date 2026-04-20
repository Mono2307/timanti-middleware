'use strict';

const { Router }               = require('express');
const { RecalculationService } = require('../services/recalculation.service');

const router  = Router();
const service = new RecalculationService();

router.post('/recalculate', async (req, res) => {
  const { draftOrderId } = req.body;
  if (!draftOrderId) {
    res.status(400).json({ success: false, error: 'draftOrderId required' });
    return;
  }
  try {
    const pricing = await service.recalculate({ draftOrderId });
    res.json({ success: true, pricing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Recalculation failed' });
  }
});

module.exports = router;
