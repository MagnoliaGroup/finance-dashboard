/**
 * ============================================================
 *  FINANCE DASHBOARD — Express Backend (Render.com)
 * ============================================================
 *
 *  SETUP STEPS:
 *  1. Push this "backend" folder to a GitHub repo
 *     (can be the same repo as your dashboard.html, just in a subfolder,
 *      or a separate repo — either works)
 *
 *  2. Go to render.com → New → Web Service → connect your GitHub repo
 *     Settings:
 *       Root Directory:  backend          (if in a subfolder)
 *       Build Command:   npm install
 *       Start Command:   npm start
 *       Instance Type:   Free
 *
 *  3. In Render → Environment → add these variables:
 *       PLAID_CLIENT_ID   = your Plaid client id
 *       PLAID_SECRET      = your Plaid secret key
 *       PLAID_ENV         = sandbox  (use "development" for real Chase)
 *       ALLOWED_ORIGIN    = *  (or your GitHub Pages URL once you know it)
 *
 *  4. Copy your Render service URL (e.g. https://finance-backend.onrender.com)
 *     and paste it into dashboard.html as the BACKEND_URL
 *
 *  NOTE: Free Render instances spin down after 15 min of inactivity.
 *  First load after idle takes ~30 seconds. Upgrade to $7/mo Starter
 *  if you want it always-on.
 * ============================================================
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Plaid client ──
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ── Middleware ──
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// ── Health check (Render pings this to keep alive) ──
app.get('/', (req, res) => res.json({ status: 'ok', service: 'finance-dashboard' }));

// ── Category map ──
// Maps Plaid personal_finance_category → your dashboard categories
const CATEGORY_MAP = {
  FOOD_AND_DRINK:            'Food & Restaurants',
  RESTAURANTS:               'Food & Restaurants',
  FAST_FOOD:                 'Food & Restaurants',
  COFFEE_SHOP:               'Food & Restaurants',
  GROCERIES:                 'Food & Restaurants',
  GENERAL_MERCHANDISE:       'Shopping',
  CLOTHING_AND_ACCESSORIES:  'Shopping',
  ELECTRONICS:               'Shopping',
  ONLINE_MARKETPLACE:        'Shopping',
  SPORTING_GOODS:            'Shopping',
  HOME_IMPROVEMENT:          'Home Improvement',
  HARDWARE:                  'Home Improvement',
  FURNITURE:                 'Home Improvement',
  RENT_AND_UTILITIES:        'Home Utilities',
  UTILITIES:                 'Home Utilities',
  ELECTRIC:                  'Home Utilities',
  GAS_AND_UTILITIES:         'Home Utilities',
  INTERNET_AND_CABLE:        'Home Utilities',
  WATER:                     'Home Utilities',
  MORTGAGE:                  'Mortgage',
  LOAN_PAYMENTS:             'Mortgage',
  TRANSPORTATION:            'Transportation',
  GAS_STATIONS:              'Transportation',
  AUTO:                      'Transportation',
  AUTO_INSURANCE:            'Transportation',
  PARKING:                   'Transportation',
  PUBLIC_TRANSIT:            'Transportation',
  TAXI:                      'Transportation',
  TRAVEL:                    'Travel',
  AIRLINES_AND_AVIATION:     'Travel',
  HOTELS_AND_MOTELS:         'Travel',
  CAR_RENTAL:                'Travel',
  TRAVEL_AGENCIES:           'Travel',
  GYMS_AND_FITNESS_CENTERS:  'Gym',
  SPORTS_CLUBS:              'Gym',
  GOVERNMENT_AND_NON_PROFIT: 'Tax',
  TAX_PAYMENT:               'Tax',
  INCOME:                    '_INCOME',
  PAYROLL:                   '_INCOME',
  TRANSFER_IN:               '_TRANSFER',
  TRANSFER_OUT:              '_TRANSFER',
  CREDIT_CARD_PAYMENT:       '_IGNORE',
  INTERNAL_ACCOUNT_TRANSFER: '_IGNORE',
};

function categorize(tx) {
  const detail  = (tx.personal_finance_category?.detailed  || '').toUpperCase();
  const primary = (tx.personal_finance_category?.primary   || '').toUpperCase();
  // Try detail first (more specific), then primary
  for (const key of [detail, primary]) {
    for (const [pattern, cat] of Object.entries(CATEGORY_MAP)) {
      if (key.includes(pattern)) return cat;
    }
  }
  return 'Other';
}

// ── Routes ──

// 1. Create Link token  (browser calls this first to open Plaid Link)
app.post('/link/token/create', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user:          { client_user_id: 'dashboard-user' },
      client_name:   'My Finance Dashboard',
      products:      [Products.Transactions],
      country_codes: [CountryCode.Us],
      language:      'en',
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// 2. Exchange public token → access token
app.post('/item/public_token/exchange', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    // Return access token to client — stored in localStorage for personal use
    res.json({ access_token: response.data.access_token });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// 3. Fetch accounts
app.post('/accounts', async (req, res) => {
  try {
    const { access_token } = req.body;
    const response = await plaidClient.accountsGet({ access_token });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// 4. Fetch + categorize transactions (last 12 months)
app.post('/transactions', async (req, res) => {
  try {
    const { access_token, start_date } = req.body;
    const endDate   = new Date().toISOString().split('T')[0];
    const startDate = start_date || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() - 11);
      d.setDate(1);
      return d.toISOString().split('T')[0];
    })();

    const response = await plaidClient.transactionsGet({
      access_token,
      start_date: startDate,
      end_date:   endDate,
      options: {
        count: 500,
        include_personal_finance_category: true,
      },
    });

    const transactions = (response.data.transactions || [])
      .filter(tx => !tx.pending)
      .map(tx => ({
        id:           tx.transaction_id,
        date:         tx.date,
        name:         tx.merchant_name || tx.name,
        amount:       tx.amount,   // positive = debit (expense)
        category:     categorize(tx),
        raw_category: tx.personal_finance_category?.primary,
        account_id:   tx.account_id,
      }))
      .filter(tx => tx.category !== '_IGNORE' && tx.category !== '_TRANSFER');

    res.json({ transactions, total_transactions: response.data.total_transactions });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => console.log(`Finance backend running on port ${PORT}`));
