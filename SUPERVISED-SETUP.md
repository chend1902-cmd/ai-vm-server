# Supervised Call — Setup (listen from the start, barge in anytime)

One call at a time: we dial the customer, you join the conference **muted** and hear everything
from the first word, the ElevenLabs agent runs the appointment pitch, and you hit **Take Over**
to unmute and finish the call (the agent drops). If the customer goes to voicemail, we skip the
conference and drop the short appointment voicemail instead.

This is the most complex piece — expect a live test/tune pass.

---

## How the call is wired

```
[🎧 Supervised Call] → /start-supervised-call
   → we dial CUSTOMER with AMD
        machine → drop appt voicemail (done)
        human   → customer joins conference
                  → YOU added to conference, muted (your cell rings, you listen)
                  → ElevenLabs agent dials BRIDGE_NUMBER → /agent-bridge → joins conference
                  → agent pitches; you listen
[🎤 Take Over] → /take-over  → unmute you + remove the agent → you finish
```

## 1. Two new Twilio numbers

- **Agent number** — imported into ElevenLabs and assigned to the Solo Appt agent (this is the
  agent's `agent_phone_number_id`). Set up during the agent build.
- **Bridge number** — a plain Twilio number. Set its Voice "A call comes in" webhook to
  `https://ai-vm-server.onrender.com/agent-bridge` (HTTP POST). The agent dials this to enter
  the conference.

(Your original `+15615565075` stays on Path A — don't reuse it here.)

## 2. Mount the module in the server

Add the supervised file to your `server/` repo, then add **one line** to `index.js` just
before `server.listen(...)`:

```js
require('./supervised')(app);
```

Redeploy on Render.

## 3. Environment variables (add to Render)

| Key | Value |
|-----|-------|
| `ELEVENLABS_API_KEY` | your ElevenLabs key |
| `ELEVENLABS_AGENT_ID` | the Solo Appt agent ID |
| `ELEVENLABS_AGENT_PHONE_ID` | the agent's imported-number ID |
| `BRIDGE_NUMBER` | the new bridge Twilio number, e.g. `+1XXXXXXXXXX` |
| `REP_NAME` | `Chris` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | for lead-field extraction |

(`TWILIO_*`, `REP_CELL`, `VOICE_AUDIO_URL`, `PUBLIC_HOST`, `DATABASE_URL` are already set.)

## 4. Extension

Reload it. You'll see two new buttons: **🎧 Supervised Call** and **🎤 Take Over**.

## 5. Test (real cell, one at a time)

1. Open a lead, click **🎧 Supervised Call**.
2. Your cell rings — answer; you're in, muted. (If it's a real person, they're already on.)
3. Listen to the agent open and pitch.
4. Click **🎤 Take Over** to unmute and drop the agent; finish the appointment yourself.
5. If the lead goes to voicemail instead, the short appt voicemail drops automatically.

---

## Things that will likely need tuning (watch the Render logs)

- **Timing:** the agent is brought in right after the customer is confirmed human; if the agent
  starts talking before the customer is fully in the conference, add a short delay before
  `triggerAgent()`.
- **Mute behavior:** you're added with `muted: true`. If you can be heard before Take Over,
  we adjust how the participant is muted.
- **ElevenLabs into the bridge:** ElevenLabs may run its own answering-machine check on the
  bridge number. If the agent won't talk, we set the bridge to answer "human-like" or disable
  that check on this path.
- **Agent drop on Take Over:** we remove the bridge participant by its call SID; if the agent
  lingers, we widen the removal.
- **Single concurrency:** this handles one supervised call at a time by design (matches your
  one-at-a-time workflow). A second simultaneous one would collide.

Paste me the Render logs from the first real test and we'll tune it together, same as Path A.
