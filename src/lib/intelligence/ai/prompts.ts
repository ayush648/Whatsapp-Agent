// Centralised system prompts for the intelligence layer.
// Tune carefully — every prompt has paired Zod schemas in extractor files.
//
// All prompts assume Indian SMB context: Hindi/Hinglish/English mix, WhatsApp
// short-form, money in ₹, dates in IST.

export const INTENT_PROMPT = `You classify WhatsApp business chat messages.

Output JSON only: {"intent": "<one of: greeting|question|promise|complaint|status_check|info|confirmation|other>", "confidence": <0..1>}

Definitions:
- greeting:     hi/hello/namaste/no-content messages
- question:     they ask us something ("kab tak bhejoge?", "price kya hai?")
- promise:      they commit to do something ("kal bhejunga", "shaam tak ho jayega")
- complaint:    frustration/issue ("abhi tak nahi mila", "ye galat hai")
- status_check: they're asking about progress without urgency
- info:         they're sharing information (specs, addresses, photos described)
- confirmation: yes/no/done/ok-style acknowledgements
- other:        anything else

Be conservative with promise: only if a clear commitment is being made.`;

export const ENTITY_PROMPT = `Extract structured entities from a WhatsApp business chat message.

Output JSON only: {"entities": [{"type": "...", "value": "...", "normalized": {...}}]}

Allowed types: person, org, product, amount, date, location, sku, phone, email, other.

Rules:
- "amount" types: include normalized.value_inr (number, e.g. 5000) and normalized.raw (string from message).
- "date" types: include normalized.iso if you can resolve it relative to today (do NOT guess year if absent — leave date partial).
- "phone" types: normalized.e164 if possible.
- "product" types: just value=product name, normalized optional.
- Don't extract pronouns or generic nouns.
- Empty array if nothing extractable. Never invent entities not in the text.`;

export const SENTIMENT_PROMPT = `Score the sentiment and urgency of a WhatsApp business chat message.

Output JSON only: {
  "sentiment": "positive"|"neutral"|"negative",
  "urgency": "low"|"medium"|"high",
  "priority": <integer 0..100>
}

priority blends sentiment + urgency:
- urgent complaint → 80-100
- pending question / pressure → 50-70
- routine update / greeting → 10-30
- pure acknowledgement → 0-10

Be calibrated: Indian SMB tone often sounds blunt without being hostile. "Bhejo jaldi" alone is medium, not high.`;

export const TASK_PROMPT = `Extract concrete tasks/promises/pending items from a WhatsApp business chat message.

Output JSON only: {"tasks": [{
  "direction": "inbound_promise"|"outbound_promise"|"question_to_us"|"question_to_them",
  "description": "<short — what's owed>",
  "owner": "us"|"them",
  "soft_due": "<relative hint: 'today'|'tomorrow'|'this_week'|'unspecified'|'2_hours'|'4_hours'|'eod'>",
  "evidence": "<the exact substring from the message that triggered this>",
  "confidence": <0..1>
}]}

Rules:
- inbound_promise: counterparty says they'll do X → owner=them
- outbound_promise: we say we'll do X → owner=us
- question_to_us: they ask us for something → owner=us
- question_to_them: we ask them → owner=them
- Treat soft commitments ("jaldi", "thodi der me") as soft_due='4_hours'.
- Treat "kal" / "tomorrow" → soft_due='tomorrow'.
- Treat "aaj" / "today" / "EOD" → soft_due='eod'.
- Pure status questions without specific ask → confidence < 0.5.
- Empty array if no actionable item. Don't invent tasks. Don't extract our own greetings as tasks.`;

export const FULFILLMENT_PROMPT = `You're given a new inbound message and a list of currently-open promises/asks from the counterparty.

Decide: does the new message fulfill any open item?

Output JSON only: {
  "fulfilled_task_id": "<uuid or null>",
  "confidence": <0..1>,
  "evidence": "<the part of the message that fulfills it, or null>"
}

Rules:
- Only mark fulfilled if the message clearly delivers or confirms the open item.
- "ho gaya" / "done" / "bhej diya" / "kar diya" → strong signal of fulfillment.
- Photo/document/file send + relevant prior task → likely fulfillment.
- "kar dunga thodi der me" → NOT fulfillment (still pending).
- Pure acknowledgement of receipt ("got it", "thanks") → not fulfillment of their promise.
- If confidence < 0.7, return fulfilled_task_id=null.`;

export const SALIENCE_PROMPT = `Decide if this message contains information worth remembering long-term.

Output JSON only: {
  "salient": true|false,
  "kind": "fact"|"preference"|"history"|"relationship"|"policy"|"outcome"|null,
  "summary": "<one short sentence capturing the durable info, or null>"
}

Worth remembering:
- Stable facts: pricing agreements, addresses, IDs, specs
- Preferences: "always send invoice before dispatch", "prefers calls over WhatsApp"
- Outcomes: deliveries, payments, decisions made
- Relationship signals: roles, family, business relationships

NOT worth remembering:
- Pure pleasantries
- Status checks
- Routine chitchat
- Re-statements of facts already established

If salient=false, kind and summary must be null.`;
