'use strict';

const express          = require('express');
const dotenv           = require('dotenv');
const recalculateRouter = require('./routes/recalculate');

dotenv.config();

const app  = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', recalculateRouter);

app.listen(PORT, () => {
  console.log(`Pricing engine running on port ${PORT}`);
});

module.exports = app;
