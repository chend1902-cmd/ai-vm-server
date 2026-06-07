// supervised.js — Supervised conference (one call at a time), NO AMD, NO bridge.
//
// New approach: instead of ElevenLabs dialing OUT to a bridge (which won't route to a
// same-account Twilio number), our conference dials INTO the ElevenLabs agent's inbound
// number. ElevenLabs answers inbound with the agent and lands in the conference.
//
//   customer answers -> joins conference
//   ~1.5s later       -> you (rep) added muted + agent number dialed into the conference
//   take over         -> unmute you + drop the agent leg
//
// Mount from index.js:  require('./supervised')(app);
// Env: PUBLIC_HOST, DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER,
//      REP_CELL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ELEVENLABS_AGENT_NUMBER, REP_NAME
//
// IMPORTANT: ELEVENLABS_AGENT_NUMBER is the agent's PHONE NUMBER (+15618165103), and that
// number must accept INBOUND calls routed to the agent (it's assigned to Stevie in ElevenLabs).

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
    ELEVENLABS_AGENT_NUMBER,
    REP_NAME,
  } = process.env;

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const domain = `https://${PUBLIC_HOST}`;

  let active = null; // { conf, fields, customerCallSid, agentCallSid, brought }

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
      active = { conf, fields, customerCallSid: null, agentCallSid: null, brought: false };

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

  // Customer answered -> join the conference, then bring in rep + agent.
  app.post('/sup-customer-twiml', (_req, res) => {
    const conf = active ? active.conf : 'sup-none';
    res.type('text/xml').send(
      `<Response><Dial><Conference waitUrl="" startConferenceOnEnter="true" endConferenceOnExit="true">${conf}</Conference></Dial></Response>`
    );
    if (active && !active.brought) {
      active.brought = true;
      setTimeout(() => bringInRepAndAgent().catch((e) => console.error('bringIn error', e.message)), 1500);
    }
  });

  async function bringInRepAndAgent() {
    const confSid = await confSidByName(active.conf);
    if (!confSid) {
      console.error('bringIn: conference not found yet for', active.conf);
      return;
    }
    // Add you (the rep), muted, listening.
    await client
      .conferences(confSid)
      .participants.create({
        from: TWILIO_NUMBER,
        to: REP_CELL,
        muted: true,
        beep: false,
        earlyMedia: true,
        waitUrl: '',
      })
      .then(() => console.log('rep added (muted)'))
      .catch((e) => console.error('addRep error', e.message));

    // Dial the ElevenLabs agent's inbound number INTO the conference.
    await client
      .conferences(confSid)
      .participants.create({
        from: TWILIO_NUMBER,
        to: ELEVENLABS_AGENT_NUMBER,
        beep: false,
        earlyMedia: true,
        waitUrl: '',
      })
      .then((p) => {
        active.agentCallSid = p.callSid;
        console.log('agent dialed into conference', p.callSid);
      })
      .catch((e) => console.error('addAgent error', e.message));

    await logCall('supervised_live');
  }

  // Take over: unmute you, drop the agent leg.
  app.post('/take-over', async (req, res) => {
    if (!active) return res.json({ ok: false, error: 'no active call' });
    try {
      const confSid = await confSidByName(active.conf);
      if (confSid) {
        const parts = await client.conferences(confSid).participants.list();
        for (const p of parts) {
          if (p.callSid === active.agentCallSid) {
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
