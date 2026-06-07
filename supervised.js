// supervised.js — Supervised conference (one call at a time), NO AMD.
//
// You're on every supervised call, so we don't try to auto-detect voicemail.
// The moment the customer answers, they join a conference; we add you (muted) and
// bring the ElevenLabs agent in via the bridge. You listen, then Take Over to barge in.
//
//   customer answers -> joins conference
//   ~1.5s later       -> you (rep) added muted + agent dialed into the bridge
//   take over         -> unmute you + drop the agent
//
// Mount from index.js:  require('./supervised')(app);
// Env: PUBLIC_HOST, DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER,
//      REP_CELL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ELEVENLABS_API_KEY,
//      ELEVENLABS_AGENT_ID, ELEVENLABS_AGENT_PHONE_ID, BRIDGE_NUMBER, REP_NAME

const twilio = require('twilio');
const { Pool } = require('pg');

module.exports = function mountSupervised(app) {
  const {
    PUBLIC_HOST,
    DATABASE_URL,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_NUMBER,
    REP_CELL,
    ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL,
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    ELEVENLABS_AGENT_PHONE_ID,
    BRIDGE_NUMBER,
    REP_NAME,
  } = process.env;

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const domain = `https://${PUBLIC_HOST}`;

  // One supervised call at a time.
  let active = null; // { conf, fields, customerCallSid, agentBridgeCallSid, brought }

  async function extractFields(screenText) {
    const fallback = {
      customer_name: 'there',
      vehicle: 'the vehicle you inquired about',
      lead_source: 'your inquiry',
    };
    try {
      const prompt =
        `From this car dealership CRM screen text, extract customer_name (first name), ` +
        `vehicle (year/make/model if present), and lead_source. Respond STRICT JSON only: ` +
        `{"customer_name":"","vehicle":"","lead_source":""}. Unknown -> sensible short default.` +
        `\n\n"""${(screenText || '').slice(0, 6000)}"""`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL || 'claude-sonnet-4-5',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const d = await r.json();
      return { ...fallback, ...JSON.parse((d.content[0].text || '').trim()) };
    } catch {
      return fallback;
    }
  }

  async function confSidByName(name) {
    const list = await client.conferences.list({
      friendlyName: name,
      status: 'in-progress',
      limit: 1,
    });
    return list[0] ? list[0].sid : null;
  }

  // 1) Start a supervised call (from the extension).
  app.post('/start-supervised-call', async (req, res) => {
    try {
      const to = (req.body.customerNumber || '').trim();
      if (!to) return res.json({ ok: false, error: 'No customer number' });
      const fields = await extractFields(req.body.screenText || '');
      const conf = 'sup-' + Date.now();
      active = { conf, fields, customerCallSid: null, agentBridgeCallSid: null, brought: false };

      const call = await client.calls.create({
        to,
        from: TWILIO_NUMBER,
        url: `${domain}/sup-customer-twiml`,
        method: 'POST',
        record: true,
      });
      active.customerCallSid = call.sid;
      res.json({ ok: true, conf, fields });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Customer answered -> join the conference, and bring in rep + agent shortly after.
  app.post('/sup-customer-twiml', (_req, res) => {
    const conf = active ? active.conf : 'sup-none';
    res.type('text/xml').send(
      `<Response><Dial><Conference waitUrl="" startConferenceOnEnter="true" endConferenceOnExit="true">${conf}</Conference></Dial></Response>`
    );
    // Give the conference ~1.5s to come up, then add you (muted) + the agent.
    if (active && !active.brought) {
      active.brought = true;
      setTimeout(() => bringInRepAndAgent().catch((e) => console.error('bringIn error', e.message)), 1500);
    }
  });

  async function bringInRepAndAgent() {
    const confSid = await confSidByName(active.conf);
    if (confSid) {
      await client.conferences(confSid).participants.create({
        from: TWILIO_NUMBER,
        to: REP_CELL,
        muted: true,
        beep: false,
        earlyMedia: true,
        waitUrl: '',
      });
    } else {
      console.error('bringIn: conference not found yet for', active.conf);
    }
    await triggerAgent();
    await logCall('supervised_live');
  }

  async function triggerAgent() {
    const r = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: ELEVENLABS_AGENT_ID,
        agent_phone_number_id: ELEVENLABS_AGENT_PHONE_ID,
        to_number: BRIDGE_NUMBER,
        conversation_initiation_client_data: {
          dynamic_variables: {
            customer_name: active.fields.customer_name,
            vehicle: active.fields.vehicle,
            lead_source: active.fields.lead_source,
            rep_name: REP_NAME || 'your rep',
          },
        },
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('triggerAgent ElevenLabs error', r.status, t);
    } else {
      console.log('triggerAgent ok');
    }
  }

  // The ElevenLabs agent's call lands on BRIDGE_NUMBER -> join the conference.
  app.post('/agent-bridge', (req, res) => {
    if (!active) return res.type('text/xml').send('<Response><Hangup/></Response>');
    active.agentBridgeCallSid = req.body.CallSid;
    res.type('text/xml').send(
      `<Response><Dial><Conference waitUrl="" startConferenceOnEnter="true" endConferenceOnExit="false">${active.conf}</Conference></Dial></Response>`
    );
  });

  // Take over: unmute you, drop the agent leg.
  app.post('/take-over', async (req, res) => {
    if (!active) return res.json({ ok: false, error: 'no active call' });
    try {
      const confSid = await confSidByName(active.conf);
      if (confSid) {
        const parts = await client.conferences(confSid).participants.list();
        for (const p of parts) {
          if (p.callSid === active.agentBridgeCallSid) {
            await client.conferences(confSid).participants(p.callSid).remove().catch(() => {});
          } else if (p.callSid !== active.customerCallSid) {
            await client
              .conferences(confSid)
              .participants(p.callSid)
              .update({ muted: false })
              .catch(() => {});
          }
        }
      }
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  async function logCall(outcome) {
    try {
      await pool.query(
        `INSERT INTO calls (call_sid, agent_number, outcome, script) VALUES ($1,$2,$3,$4)`,
        [active && active.customerCallSid, TWILIO_NUMBER, outcome, JSON.stringify(active && active.fields)]
      );
    } catch {}
  }
};
