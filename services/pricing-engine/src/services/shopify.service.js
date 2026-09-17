'use strict';

const axios  = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const shopifyClient = axios.create({
  baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN ?? '',
    'Content-Type': 'application/json',
  },
});

class ShopifyService {}

module.exports = { ShopifyService, shopifyClient };
