const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// A simple test to see if the brain is awake
app.get('/', (req, res) => {
  res.send('The Retail Middleware Brain is Awake!');
});

// The endpoint Retool will hit to push to terminal
app.post('/api/push-to-terminal', (req, res) => {
  const { draftOrderName, amount } = req.body;
  console.log(`Received request to push ${draftOrderName} for ${amount} paisa`);
  // Later, we will add the real Pine Labs code here
  res.json({ status: 'success', message: 'Sent to terminal' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
