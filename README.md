# Path A Server — Setup (Render + Neon)

This server keeps **VinSolutions** placing the call (so you keep the dealership caller ID
and VinSolutions recording) and **auto-drops** the AI voicemail by listening for the beep.

Hosting: **Render** runs the Node/WebSocket server (TLS + `wss://` for free).
Database: **Neon** (Postgres) stores armed scripts and a call log.

> Why not Vercel? Twilio Media Streams need a long-lived WebSocket connection. Vercel's
> serverless functions are short-lived and can't hold one open. Render (or Railway/Fly) can.

---

## 1. Neon

1. In your Neon project, create (or reuse) a database.
2. **Connect** → copy the **pooled** connection string into `DATABASE_URL` (keep
   `?sslmode=require`).
3. That's it — the server creates its tables (`armed`, `calls`) on first boot.

## 2. Deploy the server to Render

1. Put the `server/` folder in a Git repo (GitHub).
2. Render → **New → Web Service** → connect the repo.
   - Build command: `npm install`. Start command: `npm start`.
   - Instance type: cheapest **always-on** paid tier (free tier sleeps and would miss calls).
3. Add the environment variables from `.env.example`. Set `PUBLIC_HOST` to the
   `*.onrender.com` host Render assigns (no `https://`).
4. Deploy. Visit `https://your-app.onrender.com/` — it should say the server is up.

## 3. Point your Twilio number at the server

Twilio Console → **(561) 556-5075** → Voice Configuration → **A call comes in** →
**Webhook** → `https://your-app.onrender.com/twilio/incoming` (HTTP POST).

> This replaces the Tier 1 forward TwiML Bin. Path A (VinSolutions dials, dealership caller
> ID) and Path B (extension's AI Call button, Twilio dials) can coexist — they use different
> entry points.

## 4. Extension

In `background.js`, set `SERVER_URL` to your Render URL and `SHARED_SECRET` to match the
server. The extension arms the drafted script to the server each time you draft, so it's
ready when VinSolutions calls.

## 5. Test (use a REAL cell, not Google Voice)

1. Draft a voicemail for a test customer (this arms the script in Neon).
2. In VinSolutions, set Agent Phone Number to **(561) 556-5075** and Dial Customer.
3. Answer your cell, let the customer leg ring to a **real** voicemail.
4. When the greeting's beep hits, the server detects it and the AI message drops
   automatically; your cell drops off. Watch the Render logs ("stream start",
   "voicemail dropped") and the `calls` table in Neon.

---

## Tuning the beep detector (`beep.js`)

If it misses beeps or fires early, adjust:

- `candidates` — beep frequencies to watch (add your carrier's if needed).
- `tonalThreshold` (0.6 default) — lower = more sensitive, higher = stricter.
- `consecutive` (12 ≈ 300ms) — how long the tone must hold.
- `energyFloor` — raise if background noise causes false fires.

Watch the Render logs during a test. Your manual "Leave voicemail now" button still works
as a fallback if a beep is ever missed.
