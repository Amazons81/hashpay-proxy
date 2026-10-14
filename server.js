// server.js
// Minimal proxy so the Flutter WEB app never talks to HashBack directly.
// Mobile builds can keep calling HashBack directly if you want — this is
// only strictly required for the web deployment (CORS + key exposure).
//
// Supports multiple tills (HashBack accounts) behind ONE proxy.
// The app sends  "account": "apex" | "billy"  and the server maps that
// to the real HashBack account ID. If "account" is omitted, "apex" is used,
// so existing apps keep working unchanged.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// ── CORS ──
// Lock this down to your actual deployed web origin(s) once you know them.
// During local testing "*" is fine; in production, list exact origins.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  })
);

// ── HashBack config (server-side only — never sent to the browser) ──
const HASHBACK_BASE_URL = process.env.HASHBACK_BASE_URL || 'https://api.hashback.co.ke';
const HASHBACK_API_KEY = process.env.HASHBACK_API_KEY;
const CALLBACK_URL = process.env.CALLBACK_URL; // your backend's own callback route

// ── Accounts (tills) ──
// Key = name the app sends in "account". Value = HashBack account ID (from env).
//   apex  -> HP502244 (till 5295968)  [default]
//   billy -> HP386957 (till 1813149)
const ACCOUNTS = {
  apex: process.env.HASHBACK_ACCOUNT_ID,
  billy: process.env.HASHBACK_ACCOUNT_ID_BILLY,
  one: process.env.HASHBACK_ACCOUNT_ID_ONE,

};
const DEFAULT_ACCOUNT = 'apex';

if (!HASHBACK_API_KEY) {
  console.error('Missing HASHBACK_API_KEY in environment.');
}
for (const [name, id] of Object.entries(ACCOUNTS)) {
  if (!id) console.warn(`Account "${name}" has no account ID set in environment.`);
}

// Returns the HashBack account ID for the requested account name,
// or null if the name is unknown / not configured.
function resolveAccountId(account) {
  const name = account || DEFAULT_ACCOUNT;
  if (!Object.prototype.hasOwnProperty.call(ACCOUNTS, name)) return null;
  return ACCOUNTS[name] || null;
}

// Basic health check — useful to confirm the server deployed correctly
app.get('/health', (req, res) => res.json({ ok: true }));

// ── STEP 1: initiate STK push ──
// Flutter calls THIS endpoint instead of HashBack's /initiatestk directly.
app.post('/api/deposit', async (req, res) => {
  try {
    const { amount, msisdn, reference, description, account } = req.body;

    if (!amount || !msisdn) {
      return res.status(400).json({ message: 'amount and msisdn are required' });
    }

    const accountId = resolveAccountId(account);
    if (!accountId) {
      return res.status(400).json({ message: 'Unknown or unconfigured account' });
    }

    const hashbackResp = await fetch(`${HASHBACK_BASE_URL}/initiatestk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: HASHBACK_API_KEY,
        account_id: accountId,
        amount,
        msisdn,
        reference: reference || `Aero_${Date.now()}`,
        callback_url: CALLBACK_URL,
        description: description || 'Wallet Deposit',
      }),
    });

    const data = await hashbackResp.json();

    // Pass HashBack's response straight back to Flutter.
    // Your Flutter code already knows how to parse this shape.
    res.status(hashbackResp.status).json(data);
  } catch (err) {
    console.error('Deposit proxy error:', err);
    res.status(502).json({ message: 'Failed to reach HashBack', error: String(err) });
  }
});

// ── STEP 2: poll transaction status ──
// Flutter calls THIS endpoint instead of HashBack's /transactionstatus directly.
// Send the same "account" you used for the deposit.
app.post('/api/status', async (req, res) => {
  try {
    const { transaction_id, account } = req.body;

    if (!transaction_id) {
      return res.status(400).json({ message: 'transaction_id is required' });
    }

    const accountId = resolveAccountId(account);
    if (!accountId) {
      return res.status(400).json({ message: 'Unknown or unconfigured account' });
    }

    const hashbackResp = await fetch(`${HASHBACK_BASE_URL}/transactionstatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: HASHBACK_API_KEY,
        account_id: accountId,
        transaction_id,
      }),
    });

    const data = await hashbackResp.json();
    res.status(hashbackResp.status).json(data);
  } catch (err) {
    console.error('Status proxy error:', err);
    res.status(502).json({ message: 'Failed to reach HashBack', error: String(err) });
  }
});

// ── Optional: HashBack's own async callback lands here ──
// If you use callback_url-based confirmation instead of/alongside polling,
// point HASHBACK's callback_url env var at this route (must be a public
// HTTPS URL — HashBack can't reach localhost).
// Both tills share this one callback. Use the reference prefix
// (e.g. NYOTA-... vs BILLY-...) to tell which till a payment belongs to.
app.post('/api/hashpay-callback', (req, res) => {
  console.log('HashBack callback received:', req.body);
  // TODO: verify signature if HashBack provides one, then update your DB
  // or notify the client via websockets/push. For now just acknowledge.
  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HashPay proxy listening on port ${PORT}`);
});
