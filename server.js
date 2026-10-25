// server.js
// Proxy for the Aurix Capital Flutter app.
// Keeps the HashBack API key server-side and handles CORS for web builds.
//
// The Flutter app POSTs to /api/deposit with { amount, msisdn, reference, description }.
// The proxy attaches the API key + Aurix account ID and forwards to HashBack.

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// ── CORS ──
// During local testing "*" is fine; in production list exact origins.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  })
);

// ── HashBack config (server-side only — never sent to the browser) ──
const HASHBACK_BASE_URL =
  process.env.HASHBACK_BASE_URL || 'https://api.hashback.co.ke';
const HASHBACK_API_KEY = process.env.HASHBACK_API_KEY;
const CALLBACK_URL = process.env.CALLBACK_URL; // your own public callback route

// ── Aurix account ──
// Render env var: HASHBACK_ACCOUNT_ID_AURIX = HP875543
const AURIX_ACCOUNT_ID = process.env.HASHBACK_ACCOUNT_ID_AURIX;

if (!HASHBACK_API_KEY) {
  console.error('Missing HASHBACK_API_KEY in environment.');
}
if (!AURIX_ACCOUNT_ID) {
  console.error('Missing HASHBACK_ACCOUNT_ID_AURIX in environment.');
}
if (!CALLBACK_URL) {
  console.warn(
    'Missing CALLBACK_URL. STK push will work but you will not receive payment confirmations.'
  );
}

// Health check — useful for confirming the Render deployment is live.
app.get('/health', (req, res) => res.json({ ok: true, service: 'aurix-proxy' }));

// ── STEP 1: initiate STK push ──
// Flutter calls THIS endpoint instead of HashBack's /initiatestk directly.
app.post('/api/deposit', async (req, res) => {
  try {
    const { amount, msisdn, reference, description } = req.body;

    if (!amount || !msisdn) {
      return res
        .status(400)
        .json({ message: 'amount and msisdn are required' });
    }

    if (!AURIX_ACCOUNT_ID) {
      return res
        .status(500)
        .json({ message: 'Aurix account is not configured on the server' });
    }

    const hashbackResp = await fetch(`${HASHBACK_BASE_URL}/initiatestk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: HASHBACK_API_KEY,
        account_id: AURIX_ACCOUNT_ID,
        amount,
        msisdn,
        reference: reference || `AURIX_${Date.now()}`,
        callback_url: CALLBACK_URL,
        description: description || 'Trading Account Deposit',
      }),
    });

    const data = await hashbackResp.json();

    // Pass HashBack's response straight back to Flutter.
    // Flutter parses { transaction_id, ... } from this shape.
    res.status(hashbackResp.status).json(data);
  } catch (err) {
    console.error('Deposit proxy error:', err);
    res
      .status(502)
      .json({ message: 'Failed to reach HashBack', error: String(err) });
  }
});

// ── STEP 2: poll transaction status ──
// Flutter calls THIS endpoint instead of HashBack's /transactionstatus directly.
app.post('/api/status', async (req, res) => {
  try {
    const { transaction_id } = req.body;

    if (!transaction_id) {
      return res.status(400).json({ message: 'transaction_id is required' });
    }

    if (!AURIX_ACCOUNT_ID) {
      return res
        .status(500)
        .json({ message: 'Aurix account is not configured on the server' });
    }

    const hashbackResp = await fetch(
      `${HASHBACK_BASE_URL}/transactionstatus`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: HASHBACK_API_KEY,
          account_id: AURIX_ACCOUNT_ID,
          transaction_id,
        }),
      }
    );

    const data = await hashbackResp.json();
    res.status(hashbackResp.status).json(data);
  } catch (err) {
    console.error('Status proxy error:', err);
    res
      .status(502)
      .json({ message: 'Failed to reach HashBack', error: String(err) });
  }
});

// ── STEP 3: HashBack async callback ──
// Point HashBack's callback_url at this public HTTPS route:
//   https://<your-service>.onrender.com/api/hashpay-callback
app.post('/api/hashpay-callback', (req, res) => {
  console.log('HashBack callback received:', req.body);
  // TODO: verify signature (if HashBack provides one), then update your DB
  // or notify the client via websockets/push. For now just acknowledge.
  res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aurix HashBack proxy listening on port ${PORT}`);
});
