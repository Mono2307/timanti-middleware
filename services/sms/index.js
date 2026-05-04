const axios = require('axios');

async function sendSMS(phone, message) {
  if (!process.env.FAST2SMS_API_KEY) {
    console.warn('FAST2SMS_API_KEY not set — SMS skipped');
    return false;
  }
  try {
    await axios.post('https://www.fast2sms.com/dev/bulkV2', {
      route: 'q', message, language: 'english', flash: 0, numbers: phone
    }, { headers: { authorization: process.env.FAST2SMS_API_KEY }, timeout: 10000 });
    console.log(`✅ SMS sent to ${phone}`);
    return true;
  } catch (err) {
    console.error(`❌ SMS failed to ${phone}:`, err.response?.data || err.message);
    return false;
  }
}

module.exports = { sendSMS };
