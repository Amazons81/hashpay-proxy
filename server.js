// server.js
// Minimal proxy so the Flutter WEB app never talks to HashBack directly.
// Mobile builds can keep calling HashBack directly if you want — this is
// only strictly required for the web deployment (CORS + key exposure).

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
const HASHBACK_ACCOUNT_ID = process.env.HASHBACK_ACCOUNT_ID;
const CALLBACK_URL = process.env.CALLBACK_URL; // your backend's own callback route

if (!HASHBACK_API_KEY || !HASHBACK_ACCOUNT_ID) {
  console.error('Missing HASHBACK_API_KEY or HASHBACK_ACCOUNT_ID in environment. Set them in .env.');
}

// Basic health check — useful to confirm the server deployed correctly
app.get('/health', (req, res) => res.json({ ok: true }));

// ── STEP 1: initiate STK push ──
// Flutter calls THIS endpoint instead of HashBack's /initiatestk directly.
app.post('/api/deposit', async (req, res) => {
  try {
    const { amount, msisdn, reference, description } = req.body;

    if (!amount || !msisdn) {
      return res.status(400).json({ message: 'amount and msisdn are required' });
    }

    const hashbackResp = await fetch(`${HASHBACK_BASE_URL}/initiatestk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: HASHBACK_API_KEY,
        account_id: HASHBACK_ACCOUNT_ID,
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
app.post('/api/status', async (req, res) => {
  try {
    const { transaction_id } = req.body;

    if (!transaction_id) {
      return res.status(400).json({ message: 'transaction_id is required' });
    }

    const hashbackResp = await fetch(`${HASHBACK_BASE_URL}/transactionstatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: HASHBACK_API_KEY,
        account_id: HASHBACK_ACCOUNT_ID,
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
