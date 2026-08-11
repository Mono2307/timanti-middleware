'use strict';

/**
 * The single Supabase client.
 *
 * Constructed once and shared, rather than per-module, so connection state and auth are
 * consistent and there is exactly one place to change if the client options ever need to.
 *
 * Supabase is this system's source of truth for things Shopify cannot hold:
 * the live Shopify access token (`config` table), serial counters and their ledger, the
 * credit-instrument ledger (vouchers / exchange notes), and terminal transactions.
 */

const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

module.exports = { supabase };
