// Path A media-stream server (Neon Postgres + Render).
//
// Flow:
//  1. Extension arms a script (POST /arm) keyed by the agent number when you draft.
//  2. VinSolutions calls your Twilio number; Twilio hits POST /twilio/incoming,
//     which returns TwiML that accepts the "press 1" prompt, starts a media stream
//     to this server, and bridges your cell.
//  3. The WebSocket /media receives the live audio, runs beep detection, and the
//     moment it hears the voicemail beep it redirects the call to play the
//     ElevenLabs voicemail (your existing /voice-audio Function), freeing your cell.
//  4. Armed scripts + a call log live in Neon (Postgres).
//
// Host on Render (persistent WebSocket + TLS). Listens on process.env.PORT.

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const twilio = require('twilio');
const { BeepDetector } = require('./beep');

const {
  PORT = 3000,
  PUBLIC_HOST, // e.g. your-app.onrender.com  (no scheme)
  DATABASE_URL, // Neon connection string
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER, // +15615565075 (caller ID for the rep bridge)
  REP_CELL, // +13052900693
  VOICE_AUDIO_URL, // https://voicemail-drop-2425.twil.io/voice-audio
  SHARED_SECRET = '', // simple guard for /arm
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS armed (
      agent_number text PRIMARY KEY,
      script       text NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id           bigserial PRIMARY KEY,
      call_sid     text,
      agent_number text,
      outcome      text,
      script       text,
      error        text,
      at           timestamptz NOT NULL DEFAULT now()
    );`);
  console.log('Neon connected, tables ready');
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => res.send('AI VM Path A server up'));

// Extension arms the drafted script for the next call on this agent number.
app.post('/arm', async (req, res) => {
  if (SHARED_SECRET && req.body.secret !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  const agentNumber = (req.body.agentNumber || '').trim();
  const script = (req.body.script || '').trim();
  if (!agentNumber || !script) {
    return res.status(400).json({ ok: false, error: 'agentNumber and script required' });
  }
  await pool.query(
    `INSERT INTO armed (agent_number, script, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (agent_number)
     DO UPDATE SET script = EXCLUDED.script, updated_at = now()`,
    [agentNumber, script]
  );
  res.json({ ok: true });
});

// Twilio voice webhook: set your number's "A call comes in" to POST here.
app.post('/twilio/incoming', (req, res) => {
  const agentNumber = req.body.To || TWILIO_NUMBER;
  const streamUrl = `wss://${PUBLIC_HOST}/media`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="ww1"/>
  <Start>
    <Stream url="${streamUrl}">
      <Parameter name="agentNumber" value="${agentNumber}"/>
    </Stream>
  </Start>
  <Dial callerId="${TWILIO_NUMBER}">${REP_CELL}</Dial>
</Response>`;
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws) => {
  const detector = new BeepDetector();
  let callSid = null;
  let agentNumber = null;
  let handled = false;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === 'start') {
      callSid = msg.start.callSid;
      agentNumber =
        (msg.start.customParameters && msg.start.customParameters.agentNumber) || null;
      console.log('stream start', { callSid, agentNumber });
      return;
    }

    if (msg.event === 'media') {
      if (handled) return;
      const beep = detector.pushBase64(msg.media.payload);
      if (beep) {
        handled = true;
        await dropVoicemail(callSid, agentNumber);
        try { ws.close(); } catch {}
      }
      return;
    }

    if (msg.event === 'stop') {
      console.log('stream stop', { callSid });
    }
  });
});

async function dropVoicemail(callSid, agentNumber) {
  try {
    let script =
      'Hi, just following up with you. Give us a call back when you get a chance. Thanks!';
    if (agentNumber) {
      const r = await pool.query('SELECT script FROM armed WHERE agent_number = $1', [
        agentNumber,
      ]);
      if (r.rows[0] && r.rows[0].script) script = r.rows[0].script;
    }
    const playUrl = `${VOICE_AUDIO_URL}?text=${encodeURIComponent(script)}`;
    const twiml = `<Response><Play>${playUrl}</Play><Hangup/></Response>`;
    await client.calls(callSid).update({ twiml });
    await pool.query(
      `INSERT INTO calls (call_sid, agent_number, outcome, script) VALUES ($1,$2,'voicemail_dropped',$3)`,
      [callSid, agentNumber, script]
    );
    console.log('voicemail dropped', { callSid });
  } catch (e) {
    console.error('dropVoicemail error', e.message);
    await pool.query(
      `INSERT INTO calls (call_sid, agent_number, outcome, error) VALUES ($1,$2,'error',$3)`,
      [callSid, agentNumber, e.message]
    );
  }
}

initDb()
  .then(() => server.listen(PORT, () => console.log(`listening on ${PORT}`)))
  .catch((e) => {
    console.error('startup failed', e);
    process.exit(1);
  });
