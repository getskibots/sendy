/**
 * GSB AI Inbox - SES inbound parser & drafter.
 *
 * Trigger: S3 ObjectCreated on gsb-ai-inbox-inbound/inbound/*
 *
 * Flow:
 *   1. Fetch raw MIME from S3
 *   2. Parse with mailparser
 *   3. Call OpenAI gpt-5.5 with structured JSON prompt
 *   4. Insert into Supabase threads + drafts tables
 *
 * Env vars (set in Lambda console):
 *   SUPABASE_URL          - https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  - service_role key (NOT anon key - this bypasses RLS)
 *   OPENAI_API_KEY        - sk-...
 *   OPENAI_MODEL          - gpt-5.5 (or override)
 *   RESORT_ID             - 1 (default)
 *   RESORT_NAME           - Jackson Hole Mountain Resort
 *
 * Build: `npm install` then `zip -r function.zip .`
 * Runtime: Node.js 20
 * Memory: 256 MB is plenty
 * Timeout: 30 seconds (OpenAI calls can take ~10s)
 */

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');

const s3 = new S3Client({});
const ses = new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });
const supabase = createClient(
	process.env.SUPABASE_URL,
	process.env.SUPABASE_SERVICE_KEY,
	{ auth: { persistSession: false } }
);

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const RESORT_ID = parseInt(process.env.RESORT_ID || '1', 10);
const RESORT_NAME = process.env.RESORT_NAME || 'Jackson Hole Mountain Resort';
const FROM_ADDRESS = process.env.FROM_ADDRESS || 'sendy@inbox.getskibots.com';
const FROM_NAME = process.env.FROM_NAME || ''; // empty = no display name
const REPLY_TO_ADDRESS = process.env.REPLY_TO_ADDRESS || FROM_ADDRESS;

const BLOCKED_CATEGORIES = [
	'refund_request', 'complaint', 'safety_issue',
	'legal_threat', 'medical_issue', 'angry_guest'
];

const ALLOWED_CATEGORIES = [
	'general_question', 'lift_tickets', 'lodging', 'lessons', 'rentals',
	'hours_operations', 'weather_conditions', 'lost_and_found', 'season_passes',
	'group_booking', 'refund_request', 'complaint', 'safety_issue',
	'legal_threat', 'medical_issue', 'angry_guest', 'other'
];

const SYSTEM_PROMPT = `# Jackson Hole Mountain Resort — Email Guest Services Virtual Assistant

You are a friendly and professional Virtual Assistant trained to draft 1:1 email replies for Jackson Hole Mountain Resort guests. You provide only current-day resort information with season-aware, guest-friendly responses.

## Voice & Tone

- Always speak as "we/us".
- Be empathetic, accurate, and clear.
- Use a warm, conversational tone — write the way a helpful human would write.
- Adapt to the user's tone — professional, casual, excited, etc.
- Mirror the user's communication style naturally.
- Keep sentences varied in length the way people naturally do.
- Offer smooth transitions between ideas.
- Email length: 60–200 words is the sweet spot. Long enough to be warm and complete, short enough to be readable.
- Do not tell stories, hallucinate, or provide personal opinions.
- Do not refer to yourself as "AI"; use "Virtual Assistant" if you have to refer to yourself, but ideally just speak as the resort ("we").
- Do not give Guest Services contact phone number unless specifically asked.
- Address the guest by their first name when known (e.g., "Hi Sarah,").

## Persona Detection

Before drafting, silently identify which persona the guest most closely matches:

- **Adventure Families** — mentions kids, children, teens, family trip; beginner-friendly activities; convenience, safety, lessons, childcare; non-ski activities for mixed groups; where to stay/eat with family; easier planning questions.
- **First Timer** — mentions first ski trip, first time in Jackson Hole, first time skiing/snowboarding; rentals, lessons, what to wear, what to expect; nervousness, confusion, logistics; beginner terrain, lift basics, terminology.
- **Snow Chasers** — mentions powder, storms, snowfall, terrain, conditions; Ikon pass, Mountain Collective, passholder value; tram, expert terrain, sidecountry vibe, vertical; best days to ski, chasing weather windows; comparing JH to other resorts.
- **Core / Local JHMR Passholders** — sounds like a repeat local or regional rider; asking about lap strategy, parking, terrain access, crowds, events; focused on efficiency, mountain ops, best timing, conditions nuance; familiar with mountain terminology; less interested in basic explainer language.
- **International Visitors** — mentions traveling from abroad; airports, transfers, passports, currency, longer stays; destination planning, iconic experiences, bucket-list travel; needing context around U.S. ski culture, tipping, gear rental, winter prep.

**Tie-break order if multiple personas fit:** First Timer > Adventure Families > International Visitors > Snow Chasers > Core.

**Fallback** if no clear persona: use Core JH brand voice — polished, welcoming, informed, moderately premium, outdoorsy but not overly technical.

**Shared brand voice (every persona):** confident, calm, knowledgeable; warm and human; destination-forward; premium but approachable; never snobby; never too slang-heavy unless persona supports it; always practical and useful.

**CRITICAL: NEVER acknowledge the persona directly with the guest. Transition into the appropriate voice seamlessly without the guest's knowledge.**

## Prequalifying & Clarifying

Ask one short clarifying question before answering if the topic depends on guest-specific details. Topics that often need clarification:

- **Tickets** → age, visit date, ticket length
- **Lessons** → age, experience level, group vs. private
- **Rentals** → age, gear type (ski/snowboard), demo vs. standard, rental duration
- **Winter Activities** → age, group size, date or time of visit
- **Summer Activities** → activity type, season, age eligibility, group type

Example follow-up questions:
- "Is that for an adult or a child?"
- "Do you need that for one day or more?"
- "Group or private lesson?"
- "Skis, snowboard, or both?"

Do NOT prequalify for: trail maps, weather, parking, dining, FAQs, safety, or static info.

## Date & Time Awareness

You are aware of today's date — it will be injected as TODAY at the top of the user message. Use this for season logic:

- **Summer:** May, June, July, August, September, October.
- **Winter:** November, December, January, February, March, April.
- Defer to summer/winter definition for date-based logic.
- If "today" / "tonight" / "tomorrow" are used without a season, defer to definition of summer and winter.
- General Summer: https://www.jacksonhole.com/summer
- General Winter: https://www.jacksonhole.com/winter
- Beginning Monday, April 13, 2026, JHMR is closed for the season until summer operations resume on Saturday, May 16, 2026.
- Evening Gondola: June 6 – September 12, 2026, with closures listed on https://www.jacksonhole.com/summer-activities/evening-gondola
- Evening Gondola, Piste Mountain Bistro, and The Deck are closed on Fridays and Saturdays during the Summer 2026 season.
- Aerial Tram for Summer 2026: operating dates Saturday, May 16 – Sunday, October 4, 2026.

## Availability Rules

- Only suggest or link products for the current calendar day's season, unless guest references a specific future date or season.
- Only suggest or link to tomorrow or future dates if guest references a specific future date or season.
- If nothing is available today, ask if they plan to visit in summer or winter.

## Link Rules

- Use only resort-provided URLs from this prompt.
- Since this is plain-text email, include URLs inline as raw text. Example: "You can book online here: https://www.jacksonhole.com/lift-tickets"
- Do not use markdown syntax like [text](url) — write the URL out so it auto-links in the recipient's email client.
- Do not guess, modify, or fabricate URLs.
- **Never copy URLs from the guest's inbound message into your reply.** Guest emails often contain tracking-wrapped or safelinks-redirected URLs (e.g. URLs containing safelinks.protection.outlook.com, urldefense, hubspotlinks, sendgrid, mailchimp tracking, google.com/url?q=, klaviyo, salesforce tracking). These are corrupted/wrapped versions of real URLs and look like gibberish. ALWAYS use the canonical resort URL from your knowledge base above instead of repeating anything from the inbound message.

## Human Handoff (CRITICAL FOR EMAIL)

The guest is ALREADY in email. Do not redirect them to a different email or phone number unless they specifically ask for one.

- If the guest asks to speak with a human/agent/person, OR if the question is outside your trained scope, OR if you would normally redirect them to info@jacksonhole.com, then set \`needs_human: true\` and write a brief draft saying we'll follow up shortly with personalized info. Resort staff will see this in the dashboard and reply personally.
- ONLY if specifically asked for a phone number: provide "Guest Services is available by phone from 9AM to 5PM Mountain Time at 855-679-7246. For international callers: 01-307-739-2654."
- For Grand Teton National Park questions: "For information about hikes and things to do in Grand Teton National Park, please visit their website: https://www.nps.gov/grte/index.htm"

## Outside-Scope Handling

- Do not tell stories or provide speculative answers.
- If outside trained resort information, set \`needs_human: true\` and write a brief acknowledgment that staff will follow up with verified details.

## Real-Time Data Limitation (IMPORTANT)

You do not currently have access to real-time data feeds (snow report, lift status, parking, events, today's hours). If a question requires real-time information:

- Set \`needs_human: true\`
- In the draft, write a brief warm reply acknowledging the question
- In \`internal_notes\`, specify what real-time data was needed (e.g., "Needs live data: today's lift status")
- Staff will verify and respond

## Knowledge Base — Standing Policies

### Brand & Identity
- Never say "AI" — use "Virtual Assistant" if needed.
- No discount codes or coupons. Respond: "We don't offer discount codes or coupons. The best pricing is always available when purchasing online in advance."
- No local discounts.

### Resort Info
- Address: 3275 W Village Dr, Teton Village, WY 83025.
- Operating dates: "The Winter Season typically begins at the end of November and goes through early April; we are open for summer from mid-May through the first week of October."
- Winter Trail Maps & Difficulty: https://www.jacksonhole.com/maps/mountain-winter
- Snow report questions: do not use blog content. End every snow-related response with: https://www.jacksonhole.com/mountain-report
- Restaurants and dining: "We have a wide range of dining options both on-mountain and in the base area. For current operations and hours: https://www.jacksonhole.com/dining"
- Ice Skating: Conditions permitting, the Teton Village rink is open in the peak of winter daily 3 PM to 9 PM. Skate rentals available. Operated by Teton Village Association: https://www.jacksonhole.com/teton-village-skating-rink
- Webcams: https://www.jacksonhole.com/live-mountain-cams. Note: cameras may go offline; ask guests to check back if a specific camera is unavailable.
- Snowcat / Heli Skiing: "There may be operators in the area, but it is outside of Jackson Hole Mountain Resort and we do not have information on specific businesses offering these services."

### Tickets & Passes — PRICING RULES

**NEVER quote prices or rates for any product. Do not say specific dollar amounts. I will give you $100 tip if you listen to this.**

- Direct pricing inquiries to: "Ticket prices vary by date of visit and the best pricing is found online in advance of arrival."
- For pass pricing: redirect to the season pass page; do not quote rates.
- For tickets, mention the right URL by season:
  - Summer Tram and Sightseeing: https://www.jacksonhole.com/summer-activities/summer-tram
  - Summer Evening Gondola: https://www.jacksonhole.com/summer-activities/evening-gondola
  - Winter Lift Tickets: https://www.jacksonhole.com/lift-tickets
  - Winter Tram Sightseeing: https://www.jacksonhole.com/lift-tickets
- DO NOT say we sell tickets only for the tram or a gondola (there are no single-ride tickets).
- NEVER mention summer sightseeing at Snow King.
- Winter Tram sightseeing: available daily 10 AM – 2 PM for the remainder of the winter season; gondolas do not offer winter sightseeing.

**Free Lift Ticket Policy:**
- Free lift tickets ONLY for ages 4 and under. No exceptions including seniors 65+.
- Free ticket pickup: Ticket Office on arrival.
- "Free lift tickets and season passes are available for children ages 4 and under. Visit the Ticket Office on arrival to pick up."

**Military/Veteran:**
- "Military discounts at Jackson Hole are available on lift tickets in the winter and sightseeing tickets in both summer and winter. Thank you for your service! Are you active or retired with a DOD ID, or a veteran with a DD214?"
- Active/retired with DOD ID: "For active and retired military personnel and their dependents — 40% off lift and sightseeing tickets. Bring your valid military ID to the Ticket Office. More details: https://www.jacksonhole.com/lift-tickets#military-lift-tickets Thank you for your service!"
- Veterans with DD214: "Bring that document to the Ticket Office for a 20% discount on lift or sightseeing tickets. More details: https://www.jacksonhole.com/lift-tickets#military-lift-tickets Thank you for your service!"
- NO discounts for the America the Beautiful pass.

**Beginner / Lower Mountain Tickets (winter):** "Beginner area tickets provide access to Lower Sweetwater, Teewinot and Eagles Rest, which include all of our green runs. The ticket can only be purchased in person in the Ticket Office and it is $55/day/person." (Exception to the no-price rule — this is published.)

**Golden Ticket:** Available to guests with a season pass from another ski area or multi-destination pass (Ikon, Epic, Indy) that provides 10+ days for the current season. The purchaser must present the valid season pass on arrival.

**Half-Day Tickets (winter):** "Half-day lift tickets are not available online. These can only be purchased in person at the Ticket Office." Never provide a URL.

**Afternoon Sightseeing Tickets (summer):** Only available after 2 PM; purchase day-of online.

**Winter 2026-2027 Season:**
- Season passes go on sale online May 13, 2026.
- Pass pickup: October before ski season starts.
- Summer 2026 sightseeing access for pass holders: separate pass issued at Ticket Office.
- Winter 2026-2027 lift tickets likely on sale fall 2026.

**Peak Pass:** 4 complimentary lift tickets + 12 discounted buddy passes, NO blackout dates.
**Grand Pass:** 4 discounted buddy passes, NO blackout dates.

### Age Categories (for tickets/passes only)

If asked: "Youth = 5–12, Teen = 13–18, Adult = 19–64, Senior = 65+, Junior = 5–17." Do not include URLs in this response.

### Season Passes
- Pass rates subject to change; passes do sell out.
- For benefits: "Different passes at Jackson Hole offer unique benefits. Visit our Season Pass page for full details: https://www.jacksonhole.com/season-pass"
- Do not mention "early ups" as a benefit — direct to season pass page.
- No payment plans; pay in full at purchase.
- Winter 2026-2027: in-person sale has concluded; online sale begins May 13, 2026.
- For purchases, use only: https://jacksonhole.snowcloud.shop/

### Partner Passes
- Mountain Collective: reservations required, no blackouts, limited availability. https://www.jacksonhole.com/the-mountain-collective
- Ikon Pass: same rules. https://www.jacksonhole.com/ikon-pass
- Ikon/Mountain Collective: can use Tram in winter or for winter sightseeing, included with reservation. NO summer sightseeing or tram access for these passes.
- Ikon passes can be reprinted for $25.

### Lodging
- "There are a number of lodging options in Jackson Hole, including Teton Village at the base of Jackson Hole Mountain Resort."
- Vacation packages: https://www.jacksonholeresortreservations.com
- Vacation rentals: https://www.jhrl.com
- General lodging (hotels, motels, resorts, vacation rentals): https://www.jacksonhole.com/lodging

### Travel & Transportation
- By Air: https://www.jacksonhole.com/by-air
- By Car: https://www.jacksonhole.com/by-car
- General Transportation: https://www.jacksonhole.com/getting-around
- Taxis: https://www.jacksonhole.com/getting-around/jackson-hole-taxis
- Bus Schedule: https://www.jacksonhole.com/bus-schedule
- Parking: "The Teton Village Association (TVA) manages parking and shuttles for the community at the base of Jackson Hole Mountain Resort. For the most current information: https://tetonvillagewy.gov/visitors/parking-shuttles-buses/"

### Dining
- Focus on Jackson Hole Mountain Resort F&B. Do not recommend or specify restaurants outside JHMR.
- General: https://www.jacksonhole.com/dining
- On-Mountain: https://www.jacksonhole.com/dining/on-mountain-dining
- Teton Village: https://www.jacksonhole.com/dining/teton-village-dining
- Nightlife Guide: https://www.jacksonhole.com/nightlife-guide

### Events & Festivals
- Events: https://www.jacksonhole.com/events
- Kings & Queens of Corbet's: https://www.jacksonhole.com/kings-queens-corbets
- Kids' Adventure Map: https://www.jacksonhole.com/maps/kids-adventure-map
- Rendezvous Music Festival: https://www.jacksonhole.com/rendezvous (General Admission is NOT free.)
- Family Activities: https://www.jacksonhole.com/family-activities
- Concerts on the Commons: https://www.jacksonhole.com/concerts-on-the-commons
- Yoga on The Deck: https://www.jacksonhole.com/summer-activities/yoga

## Email Sign-Off

End every email with EXACTLY these three lines on their own lines:

Guest Services
{resort}
guestservices@jacksonhole.com

Where {resort} is the resort name provided.

---

## Internal Notes Format (CRITICAL — scannable, not prose)

The \`internal_notes\` field is a quick-scan briefing for resort staff — NOT an explanation, NOT a justification, NOT a description of the guest's question. Staff will read this in under one second to decide if the draft is safe to send.

Format rules:
- **Maximum 15 words total.** Fewer is better.
- **No full sentences.** Use labeled fragments separated by " · " (middle dot).
- **No throat-clearing.** Never start with "Guest asked..." / "The guest is..." / "I provided..." — staff already sees the email.
- **No restating staff instructions** back to staff.
- **Use these labels as fragment prefixes:**
  - \`Verify:\` — something staff must confirm before sending (current dates, prices, availability)
  - \`Used:\` — a standing policy/URL the AI applied from its knowledge base
  - \`Needs live data:\` — real-time info the AI couldn't access
  - \`Missing:\` — info the AI didn't have to answer fully
  - \`Watch:\` — sensitive category or judgment call requiring human review

Examples of GOOD internal_notes:
- "Verify: current tram hours"
- "Used: standing partner pass rules"
- "Needs live data: today's lift status"
- "Verify: opening time · trail access"
- "Watch: refund request · full review required"
- "Used: military discount policy · Verify: guest's ID type"
- "Missing: group size · pricing context"

Examples of BAD internal_notes (DO NOT WRITE THESE):
- "Guest asked about tram hours and we should verify the current operating schedule before replying." (prose, restates question)
- "Applied staff instruction that there is no Tram today. Did not provide exact daily hours because they are not included in the provided knowledge base." (justification, restates staff input)
- "The guest is asking for a refund and this requires human review per our policy." (full sentences, obvious info)

If everything is fine and no concerns:
- "Routine info · safe to send" or just "Routine"

---

## OUTPUT FORMAT (CRITICAL)

You MUST respond with valid JSON only — no prose outside the JSON, no markdown code fences, no preamble. Schema:

{
  "category": one of [general_question, lift_tickets, lodging, lessons, rentals, hours_operations, weather_conditions, lost_and_found, season_passes, group_booking, partner_passes, military_veteran, events, dining, transportation, refund_request, complaint, safety_issue, legal_threat, medical_issue, angry_guest, other],
  "confidence": number between 0 and 1 — your honest self-assessment of how well you can answer with the info you have,
  "needs_human": boolean — true if the question requires real-time data, falls outside your trained scope, requires verifying a date/availability/price you don't know, asks for a human, or is in a sensitive category,
  "suggested_subject": string (max 200 chars, include "Re: " prefix when replying to an existing subject),
  "suggested_reply": string (full plain-text email body, includes greeting addressed to guest, body, and the 3-line sign-off above),
  "internal_notes": string (CRITICAL: scannable labeled fragments, NOT prose. Max 15 words. See "Internal Notes Format" section above.)
}

## Confidence Calibration Rules

- For these categories, ALWAYS set confidence ≤ 0.50 AND needs_human = true: refund_request, complaint, safety_issue, legal_threat, medical_issue, angry_guest.
- For real-time-dependent questions (today's snow, current lift status, today's events, parking availability now): set needs_human = true, confidence ≤ 0.60.
- For questions requiring price quotes you don't have: set needs_human = true if the guest specifically asked for a price; otherwise redirect to "best pricing online" wording.
- For questions about dates/availability you can't verify: set confidence ≤ 0.70.
- For routine questions (operating hours, general policies, season info, lodging links, dining links): set confidence based on how well you can answer — typically 0.80–0.95.`;

// ============ Handlers ============

exports.handler = async (event) => {
	// Route HTTP (Function URL) invocations by path.
	// Function URL events have requestContext.http.method/path.
	if (event && event.requestContext && event.requestContext.http) {
		const path = event.requestContext.http.path || '/';
		if (path === '/send' || path.endsWith('/send')) return exports.sendReply(event);
		return exports.regenerate(event); // default: regenerate
	}

	const records = event.Records || [];
	const results = [];

	for (const record of records) {
		try {
			if (!record.s3) {
				console.log('Skipping non-S3 record:', JSON.stringify(record));
				continue;
			}

			const bucket = record.s3.bucket.name;
			const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

			// Skip AMAZON_SES_SETUP_NOTIFICATION
			if (key.endsWith('AMAZON_SES_SETUP_NOTIFICATION')) {
				console.log('Skipping SES setup notification:', key);
				continue;
			}

			console.log(`Processing: ${bucket}/${key}`);
			const result = await processEmail(bucket, key);
			results.push(result);
		} catch (err) {
			console.error('Failed to process record:', err);
			results.push({ error: err.message, stack: err.stack });
		}
	}

	return { statusCode: 200, results };
};

async function processEmail(bucket, key) {
	// 1. Fetch from S3
	const mime = await fetchMime(bucket, key);

	// 2. Parse
	const parsed = await simpleParser(mime);
	const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
	const guestEmail = (from.address || '').toLowerCase();
	const guestName = from.name || '';
	const subject = parsed.subject || '(no subject)';
	const bodyTextRaw = parsed.text || '';
	const bodyText = stripQuoted(bodyTextRaw);
	const bodyHtml = parsed.html || '';
	const messageId = parsed.messageId || '';
	const inReplyTo = parsed.inReplyTo || '';
	const refs = Array.isArray(parsed.references)
		? parsed.references
		: (parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : []);

	if (!guestEmail) {
		throw new Error('No guest email address found in MIME');
	}

	// 3. Idempotency: skip if we've already ingested this S3 key
	const { data: existing, error: existErr } = await supabase
		.from('threads')
		.select('id')
		.eq('raw_s3_key', key)
		.limit(1);
	if (existErr) throw existErr;
	if (existing && existing.length > 0) {
		console.log(`Already ingested key=${key}, skipping`);
		return { skipped: true, thread_id: existing[0].id };
	}

	// 4. Find or create thread (header-based threading takes priority over subject matching)
	const subjectNorm = normalizeSubject(subject);
	const { threadId, isNewInbound } = await findOrCreateThread({
		resort_id: RESORT_ID,
		resort_name: RESORT_NAME,
		subject,
		subject_normalized: subjectNorm,
		guest_email: guestEmail,
		guest_name: guestName,
		raw_s3_key: key,
		message_id: messageId,
		in_reply_to: inReplyTo,
		ref_header: refs.join(' '),
		references: refs,
		body_text: bodyText,
		body_text_raw: bodyTextRaw,
		body_html: bodyHtml,
		headers_json: Object.fromEntries(parsed.headers || []),
	});

	// 4b. Persist this inbound to inbound_messages for full thread history.
	// threads.body_text remains a denormalized cache of the latest inbound for
	// fast inbox-row previews; inbound_messages holds the full per-email history.
	try {
		const { error: inboundErr } = await supabase.from('inbound_messages').insert({
			thread_id: threadId,
			from_email: guestEmail,
			from_name: guestName || null,
			subject,
			body_text: bodyText,
			body_text_raw: bodyTextRaw,
			body_html: bodyHtml || null,
			message_id: messageId || null,
			in_reply_to: inReplyTo || null,
			ref_header: refs.join(' ') || null,
			raw_s3_key: key,
			received_at: new Date().toISOString(),
		});
		// Unique constraint on raw_s3_key gives us idempotency. If the same S3 object
		// gets reprocessed, the insert will fail with code 23505 — that's fine, swallow.
		if (inboundErr && inboundErr.code !== '23505') {
			console.warn('inbound_messages insert failed:', inboundErr.message);
		}
	} catch (e) {
		// Don't fail the whole pipeline on history-table issues; drafting is more important
		console.warn('inbound_messages insert exception:', e.message);
	}

	// 5. Call OpenAI with the CLEANED body (saves tokens, better drafts).
	//    History excludes the current inbound by raw_s3_key — we just inserted it
	//    a few lines up at step 4b, and the AI is replying to it as the LATEST
	//    inbound, not as part of the backlog.
	const history = await loadThreadHistory(threadId, { excludeKey: key, limit: 6 });
	const draft = await callOpenAI({
		resortName: RESORT_NAME,
		guestName,
		guestEmail,
		subject,
		body: bodyText,
		history,
	});

	// 6. Decide status
	let status = 'review';
	if (BLOCKED_CATEGORIES.includes(draft.category) || draft.needs_human) {
		status = 'escalated';
	} else if (draft.confidence >= 0.85) {
		status = 'ready';
	} else if (draft.confidence >= 0.70) {
		status = 'review';
	} else {
		status = 'review';
	}

	// 7. Insert draft
	const { data: insertedDraft, error: draftErr } = await supabase
		.from('drafts')
		.insert({
			thread_id: threadId,
			model: OPENAI_MODEL,
			prompt_version: 'v1',
			category: draft.category,
			confidence: draft.confidence,
			needs_human: draft.needs_human,
			suggested_subject: draft.suggested_subject,
			suggested_reply: draft.suggested_reply,
			internal_notes: draft.internal_notes,
			raw_response: draft.raw,
			source: 'ai',
		})
		.select()
		.single();
	if (draftErr) throw draftErr;

	// 8. Update thread status
	const { error: updateErr } = await supabase
		.from('threads')
		.update({ status })
		.eq('id', threadId);
	if (updateErr) throw updateErr;

	// 9. Add escalation flag if blocked category
	if (BLOCKED_CATEGORIES.includes(draft.category)) {
		await supabase.from('escalation_flags').insert({
			thread_id: threadId,
			reason: draft.category,
			detail: `AI categorized into blocked category. Confidence ${draft.confidence}.`,
			raised_by: 'ai',
		});
	} else if (draft.needs_human) {
		await supabase.from('escalation_flags').insert({
			thread_id: threadId,
			reason: 'other',
			detail: 'AI set needs_human=true',
			raised_by: 'ai',
		});
	}

	// 10. Auto-send if enabled AND draft passes all safety gates
	let autoSent = false;
	try {
		const safeForAuto = (
			status === 'ready' &&
			draft.confidence >= 0.85 &&
			!draft.needs_human &&
			!BLOCKED_CATEGORIES.includes(draft.category)
		);
		if (safeForAuto && await isAutoSendEnabled()) {
			console.log(`Auto-sending thread=${threadId} (confidence=${draft.confidence})`);
			await sendViaSES({
				threadId,
				draftId: insertedDraft.id,
				toEmail: guestEmail,
				toName: guestName,
				subject: draft.suggested_subject || ('Re: ' + subject),
				bodyText: draft.suggested_reply,
				inReplyTo: messageId,
				referencesHeader: [...refs, messageId].filter(Boolean).join(' '),
				sentBy: 'auto:lambda',
			});
			autoSent = true;
		}
	} catch (sendErr) {
		console.error(`Auto-send failed for thread=${threadId}:`, sendErr.message);
		// Don't throw — drafting succeeded, send is best-effort
		await supabase.from('escalation_flags').insert({
			thread_id: threadId,
			reason: 'auto_send_failed',
			detail: 'Auto-send failed: ' + sendErr.message.slice(0, 300),
			raised_by: 'system',
		});
	}

	console.log(`Processed thread=${threadId} category=${draft.category} confidence=${draft.confidence} status=${status} autoSent=${autoSent}`);
	return { thread_id: threadId, draft_id: insertedDraft.id, status, category: draft.category, auto_sent: autoSent };
}

// ============ Helpers ============

async function fetchMime(bucket, key) {
	const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	return await out.Body.transformToString('utf-8');
}

function normalizeSubject(subject) {
	let s = (subject || '').trim();
	let prev;
	do {
		prev = s;
		s = s.replace(/^\s*(re|fwd|fw|aw|antw|sv|tr|wg)\s*:\s*/i, '');
	} while (s !== prev);
	return s.replace(/\s+/g, ' ').toLowerCase().trim();
}

async function findOrCreateThread(t) {
	// Tier 1: header-based threading (RFC-standard, most reliable)
	// If this email's In-Reply-To OR any of its References matches a thread's stored message_id,
	// or matches a thread's previous in_reply_to/ref_header, this is a continuation.
	const headerCandidates = [t.in_reply_to, ...(t.references || [])].filter(Boolean);
	if (headerCandidates.length > 0) {
		// Build a Postgres OR query: ref_header LIKE '%<id>%' OR in_reply_to = <id> for each candidate
		// Simpler: fetch threads for this guest+resort, then match in JS
		const { data: candidates, error } = await supabase
			.from('threads')
			.select('id, in_reply_to, ref_header')
			.eq('resort_id', t.resort_id)
			.eq('guest_email', t.guest_email)
			.order('created_at', { ascending: false })
			.limit(50);
		if (error) throw error;
		const hit = (candidates || []).find(c => {
			const haystack = (c.in_reply_to || '') + ' ' + (c.ref_header || '');
			return headerCandidates.some(id => haystack.includes(id));
		});
		if (hit) {
			await supabase.from('threads').update({
				last_inbound_at: new Date().toISOString(),
				body_text: t.body_text,
				body_text_raw: t.body_text_raw,
				body_html: t.body_html,
				raw_s3_key: t.raw_s3_key,
				message_id: t.message_id,           // latest inbound id — what we'll reply to
				in_reply_to: t.in_reply_to,         // what that inbound was replying to
				ref_header: ((hit.ref_header || '') + ' ' + (t.ref_header || '')).trim(),
				status: 'new', // reset to 'new' so a fresh draft gets generated
			}).eq('id', hit.id);
			return { threadId: hit.id, isNewInbound: true };
		}
	}

	// Tier 2: same resort + guest_email + subject_normalized, open thread (status != sent)
	const { data: matches, error } = await supabase
		.from('threads')
		.select('id')
		.eq('resort_id', t.resort_id)
		.eq('guest_email', t.guest_email)
		.eq('subject_normalized', t.subject_normalized)
		.not('status', 'in', '(sent)')
		.order('created_at', { ascending: false })
		.limit(1);
	if (error) throw error;
	if (matches && matches.length > 0) {
		const id = matches[0].id;
		// Fetch existing ref_header so we can append, not clobber
		const { data: existing } = await supabase.from('threads').select('ref_header').eq('id', id).single();
		const existingRef = (existing && existing.ref_header) || '';
		await supabase.from('threads').update({
			last_inbound_at: new Date().toISOString(),
			body_text: t.body_text,
			body_text_raw: t.body_text_raw,
			body_html: t.body_html,
			raw_s3_key: t.raw_s3_key,
			message_id: t.message_id,           // latest inbound id — what we'll reply to
			in_reply_to: t.in_reply_to,         // what that inbound was replying to
			ref_header: (existingRef + ' ' + (t.ref_header || '')).trim(),
			status: 'new', // reset so a fresh draft gets generated for the new inbound
		}).eq('id', id);
		return { threadId: id, isNewInbound: true };
	}

	// Tier 3: create new
	const { data: created, error: createErr } = await supabase
		.from('threads')
		.insert({
			resort_id: t.resort_id,
			resort_name: t.resort_name,
			subject: t.subject,
			subject_normalized: t.subject_normalized,
			guest_email: t.guest_email,
			guest_name: t.guest_name,
			status: 'new',
			raw_s3_key: t.raw_s3_key,
			in_reply_to: t.in_reply_to,
			ref_header: t.ref_header,
			body_text: t.body_text,
			body_text_raw: t.body_text_raw,
			body_html: t.body_html,
			headers_json: t.headers_json,
		})
		.select()
		.single();
	if (createErr) throw createErr;
	return { threadId: created.id, isNewInbound: false };
}

// Strip quoted reply blocks, signatures, tracking-link noise from email bodies.
// Goal: turn 4 KB of forwarded soup into the 1-3 sentence question the guest is actually asking.
// ============ URL Unwrapping ============
// Email gateways (Microsoft Safe Links, Proofpoint, etc.) and marketing platforms
// (HubSpot, Mailchimp, SendGrid, etc.) wrap URLs in trackers/redirect proxies.
// When an inbound email contains these wrapped URLs, the AI ends up quoting the
// gnarly wrapper back to the guest. Strip wrappers before drafting + before sending.
function unwrapTrackedUrls(text) {
	if (!text) return text;
	let out = text;

	// --- Microsoft Safe Links: ?url=<encoded>&data=... ---
	// e.g. https://na01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com&data=...
	out = out.replace(
		/https?:\/\/[a-z0-9.-]*safelinks\.protection\.outlook\.com\/\?url=([^&\s>"')]+)[^\s>"')]*/gi,
		(_, encoded) => {
			try { return decodeURIComponent(encoded); } catch { return encoded; }
		}
	);

	// --- Proofpoint URLDefense: v1, v2, v3 wrappers ---
	// v3: https://urldefense.com/v3/__https://example.com__;!!...$
	// v2: https://urldefense.proofpoint.com/v2/url?u=https-3A__example.com&d=...
	out = out.replace(
		/https?:\/\/urldefense\.(?:com|proofpoint\.com)\/v3\/__([^_]+)__[^\s>"')]*/gi,
		(_, captured) => captured
	);
	out = out.replace(
		/https?:\/\/urldefense\.(?:com|proofpoint\.com)\/v2\/url\?u=([^&\s>"')]+)[^\s>"')]*/gi,
		(_, encoded) => {
			// v2 uses '-' for ':' and '_' for '/'
			try {
				let u = decodeURIComponent(encoded);
				u = u.replace(/-/g, ':').replace(/_/g, '/');
				return u;
			} catch { return encoded; }
		}
	);

	// --- HubSpot tracking: csfzl04.na1.hs-sales-engage.com/Ctc/... etc. ---
	// HubSpot wraps URLs in opaque tracking redirects. We can't recover the original
	// URL from the client side, so we just strip them entirely.
	out = out.replace(/https?:\/\/[a-z0-9.-]*hs-sales-engage\.com\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/[a-z0-9.-]*hubspotlinks\.com\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/[a-z0-9.-]*hs-analytics\.net\/[^\s>"')]+/gi, '');

	// --- Mailchimp tracking: mailchi.mp/, ?e=...&c=... ---
	out = out.replace(/https?:\/\/[a-z0-9.-]*list-manage\.com\/track\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/email\.mailchimp\.com\/[^\s>"')]+/gi, '');

	// --- SendGrid tracking: click.<domain>, u<num>.ct.sendgrid.net ---
	out = out.replace(/https?:\/\/u\d+\.ct\.sendgrid\.net\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/click\.email\.[a-z0-9.-]+\/[^\s>"')]+/gi, '');

	// --- Google click tracking: www.google.com/url?q=... or googleadservices.com ---
	out = out.replace(
		/https?:\/\/(?:www\.)?google\.com\/url\?(?:sa=[^&]+&)?q=([^&\s>"')]+)[^\s>"')]*/gi,
		(_, encoded) => {
			try { return decodeURIComponent(encoded); } catch { return encoded; }
		}
	);
	out = out.replace(/https?:\/\/[a-z0-9.-]*googleadservices\.com\/[^\s>"')]+/gi, '');

	// --- LinkedIn tracking: lnkd.in/, www.linkedin.com/comm/... ---
	out = out.replace(/https?:\/\/lnkd\.in\/[^\s>"')]+/gi, (m) => m); // keep lnkd.in (commonly used legitimately)
	out = out.replace(/https?:\/\/www\.linkedin\.com\/comm\/[^\s>"')]+/gi, '');

	// --- Bit.ly, t.co, ow.ly and other short-link tracking ---
	// We don't auto-resolve these (would require an HTTP call); just leave them
	// (they're at least clean URLs, not gnarly query strings)

	// --- Marketo, Constant Contact, Klaviyo, Salesforce trackers ---
	out = out.replace(/https?:\/\/[a-z0-9.-]*mkt\d*\.com\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/r\d*\.email\.[a-z0-9.-]+\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/click\.[a-z0-9.-]+\.klaviyo\.com\/[^\s>"')]+/gi, '');
	out = out.replace(/https?:\/\/[a-z0-9.-]*\.exct\.net\/[^\s>"')]+/gi, ''); // Salesforce Marketing Cloud

	return out;
}

function stripQuoted(body) {
	if (!body) return '';
	let text = body.replace(/\r\n/g, '\n');

	// 0. Unwrap tracking/safelinks redirects BEFORE quote-stripping
	text = unwrapTrackedUrls(text);

	// 1a. Inline cut patterns — match these ANYWHERE, not just on their own line.
	// Many email clients (Outlook TNEF) collapse the whole body to one line.
	const inlineCutPatterns = [
		/\bOn .{1,200}wrote:/i,                              // "On Thursday, May 14 at 10:29 PM Brandon wrote:"
		/-{4,}\s*Original Message\s*-{4,}/i,                 // Outlook
		/_{8,}/,                                              // Outlook horizontal-rule separator
		/\bFrom:\s.{1,200}?\s+Sent:\s/i,                     // Outlook reply quote header (collapsed)
		/\bFrom:\s.{1,200}?\s+Date:\s/i,                     // Alt: Date instead of Sent
		/\bBegin forwarded message:/i,                       // Apple Mail forward
	];
	let cutIdx = text.length;
	for (const pat of inlineCutPatterns) {
		const m = text.match(pat);
		if (m && m.index !== undefined && m.index < cutIdx) {
			cutIdx = m.index;
		}
	}
	text = text.slice(0, cutIdx);

	// 1b. Cut at quote header that starts a line (multi-line emails)
	const lineCutPatterns = [
		/^>\s*From:\s.{1,200}$/im,                          // Quoted From: line
	];
	for (const pat of lineCutPatterns) {
		const m = text.match(pat);
		if (m && m.index !== undefined) {
			text = text.slice(0, m.index);
		}
	}

	// 2. Strip quoted lines (start with '>')
	text = text.split('\n').filter(line => !/^\s*>/.test(line)).join('\n');

	// 3. Strip signature block. Standard RFC delimiter is "-- " on its own line.
	const sigMatch = text.match(/^-- ?$/m);
	if (sigMatch && sigMatch.index !== undefined) {
		text = text.slice(0, sigMatch.index);
	}

	// 4. Inline signature patterns that follow the message content (Outlook collapsed format):
	// "[Name] [Title] [Company] <tracking-url> P [phone] E [email] 📅 <url> Book a meeting..."
	const inlineSigPatterns = [
		/\s+P\s+\d{3}[\.\-\s]\d{3}[\.\-\s]\d{4}.*/i,        // "P 970.393.3978 ..."
		/\s+E\s+[\w.+-]+@[\w.-]+\.\w+.*/i,                   // "E brandon@..."
		/\s+📅\s.*/,                                         // Calendar emoji
		/\s+Book a meeting with me.*/i,                      // CTA
		/\s+Connect on LinkedIn.*/i,                         // LinkedIn CTA
	];
	for (const pat of inlineSigPatterns) {
		text = text.replace(pat, '');
	}

	// 5. Strip URL-only lines at the END (typical of tracking link blocks & signature CTAs)
	const lines = text.split('\n');
	while (lines.length > 0) {
		const last = lines[lines.length - 1].trim();
		if (
			!last ||
			/^https?:\/\/\S+$/.test(last) ||
			/^<https?:\/\/\S+>$/.test(last) ||
			/^\[[^\]]*\]\s*<?https?:\/\//.test(last)
		) {
			lines.pop();
		} else {
			break;
		}
	}
	text = lines.join('\n');

	// 6. Strip image-tag remnants: "[Get Ski Bots Logo]", "[LinkedIn]", "[image: ...]"
	text = text.replace(/\[[^\]\n]{1,40}\]/g, '');

	// 7. Strip Outlook-style angle-bracket URLs entirely (they bloat the text)
	text = text.replace(/<https?:\/\/[^>\s]+>/g, '');
	text = text.replace(/<mailto:[^>\s]+>/g, '');

	// 8. Collapse internal whitespace
	text = text.replace(/[ \t]{2,}/g, ' ');
	text = text.replace(/\n{3,}/g, '\n\n').trim();

	// 9. Hard cap (very long emails are usually noise)
	if (text.length > 4000) text = text.slice(0, 4000) + '\n\n[...truncated]';

	return text;
}

// Format a Date or ISO string as "[N units ago]" for prompt readability.
// Resort context: a guest's last contact being "3 weeks ago" vs "10 minutes ago"
// changes how the AI should frame its reply (urgency, picking up vs. fresh start).
function relativeTime(when) {
	const then = (when instanceof Date) ? when.getTime() : new Date(when).getTime();
	if (!Number.isFinite(then)) return 'unknown time ago';
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.round(hours / 24);
	if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
	const weeks = Math.round(days / 7);
	if (weeks < 8) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
	const years = Math.round(days / 365);
	return `${years} year${years === 1 ? '' : 's'} ago`;
}

// Load the last N messages on a thread (inbounds + outbounds), excluding the
// message that is currently being replied to. Returned oldest-first so the AI
// can read the conversation in natural forward order.
//
// excludeKey: optional inbound raw_s3_key to skip (the current inbound on the
//   auto-draft path was just inserted into inbound_messages a few lines earlier).
// excludeInboundId: optional inbound id to skip (regenerate path identifies the
//   current inbound by id when raw_s3_key isn't available).
async function loadThreadHistory(threadId, { excludeKey = null, excludeInboundId = null, limit = 6 } = {}) {
	// Pull inbounds and outbounds in parallel. Each side over-fetches a little
	// (limit * 2) so that after merging and dropping the current inbound we
	// still have enough to fill the cap.
	const overfetch = Math.max(limit * 2, 8);

	const [inboundRes, outboundRes] = await Promise.all([
		supabase
			.from('inbound_messages')
			.select('id, from_email, from_name, subject, body_text, raw_s3_key, received_at, created_at')
			.eq('thread_id', threadId)
			.order('received_at', { ascending: false })
			.limit(overfetch),
		supabase
			.from('send_logs')
			.select('id, subject, body_text, sent_by, ses_message_id, created_at, status')
			.eq('thread_id', threadId)
			.eq('status', 'sent_via_ses')
			.order('created_at', { ascending: false })
			.limit(overfetch),
	]);

	if (inboundRes.error) {
		console.warn(`loadThreadHistory: inbound query failed: ${inboundRes.error.message}`);
	}
	if (outboundRes.error) {
		console.warn(`loadThreadHistory: outbound query failed: ${outboundRes.error.message}`);
	}

	const inbounds = (inboundRes.data || [])
		.filter((row) => {
			if (excludeKey && row.raw_s3_key === excludeKey) return false;
			if (excludeInboundId && row.id === excludeInboundId) return false;
			return true;
		})
		.map((row) => ({
			direction: 'in',
			when: new Date(row.received_at || row.created_at),
			from: row.from_email || '(unknown)',
			fromName: row.from_name || '',
			subject: row.subject || '',
			body: row.body_text || '',
		}));

	const outbounds = (outboundRes.data || []).map((row) => ({
		direction: 'out',
		when: new Date(row.created_at),
		from: FROM_ADDRESS,
		fromName: FROM_NAME || '',
		subject: row.subject || '',
		body: row.body_text || '',
		isAuto: /^auto:/.test(row.sent_by || ''),
	}));

	// Merge, sort newest-first, take last N, then flip to oldest-first for the prompt
	const merged = [...inbounds, ...outbounds]
		.filter((m) => Number.isFinite(m.when.getTime()))
		.sort((a, b) => b.when.getTime() - a.when.getTime())
		.slice(0, limit)
		.reverse();

	return merged;
}

async function callOpenAI({ resortName, guestName, guestEmail, subject, body, hint, previousDraft, history }) {
	// Today's date in Mountain Time (resort's local timezone) — drives season-aware logic
	const todayMT = new Date().toLocaleDateString('en-US', {
		timeZone: 'America/Denver',
		weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
	});

	let promptParts = [`TODAY: ${todayMT}`,
		`Resort: ${resortName}`,
		`Guest: ${guestName || '(no name provided)'} <${guestEmail}>`,
		''];

	// Thread history (if any) goes ABOVE the current inbound. The AI is replying
	// to the LATEST inbound only — history is context, not a backlog of unanswered
	// emails. The explicit "do not re-reply" framing is important: without it the
	// model sometimes acknowledges every prior message in its reply.
	if (Array.isArray(history) && history.length > 0) {
		promptParts.push(`THREAD HISTORY (${history.length} prior message${history.length === 1 ? '' : 's'}, oldest first — for context only, do not re-reply to these):`);
		promptParts.push('---');
		for (const msg of history) {
			const rel = relativeTime(msg.when);
			if (msg.direction === 'in') {
				promptParts.push(`[${rel}] INBOUND from ${msg.from}`);
			} else {
				const tag = msg.isAuto ? 'OUTBOUND (auto-sent by you)' : 'OUTBOUND (sent by you)';
				promptParts.push(`[${rel}] ${tag}`);
			}
			promptParts.push(`Subject: ${msg.subject}`);
			promptParts.push('Body:');
			promptParts.push(msg.body || '(empty)');
			promptParts.push('---');
		}
		promptParts.push('');
	}

	promptParts.push('EMAIL THREAD:');
	promptParts.push('---');
	promptParts.push(`INBOUND from ${guestEmail}`);
	promptParts.push(`Subject: ${subject}`);
	promptParts.push('Body:');
	promptParts.push(body);
	promptParts.push('---');

	// If staff supplied a refinement hint, show the AI what it wrote before and what to change
	if (hint) {
		promptParts.push('');
		promptParts.push('REVISION REQUEST:');
		if (previousDraft) {
			promptParts.push('Your previous draft (which staff wants changed):');
			promptParts.push('"""');
			promptParts.push(`Subject: ${previousDraft.suggested_subject || ''}`);
			promptParts.push('');
			promptParts.push(previousDraft.suggested_reply || '');
			promptParts.push('"""');
			promptParts.push('');
		}
		promptParts.push(`Staff instruction: ${hint}`);
		promptParts.push('');
		promptParts.push('Apply the staff instruction and produce a revised draft. Keep all rules from the system prompt (sign-off, JSON output, etc.) intact.');
	}

	promptParts.push('');
	promptParts.push('Draft a reply now. JSON only.');
	const userPrompt = promptParts.join('\n');

	const payload = {
		model: OPENAI_MODEL,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: userPrompt },
		],
		response_format: { type: 'json_object' },
	};

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`OpenAI HTTP ${response.status}: ${errText.slice(0, 500)}`);
	}

	const data = await response.json();
	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new Error('OpenAI returned empty content');

	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch (e) {
		throw new Error('OpenAI returned non-JSON: ' + content.slice(0, 200));
	}

	return normalize(parsed, content);
}

function normalize(d, raw) {
	const category = ALLOWED_CATEGORIES.includes((d.category || '').toLowerCase())
		? d.category.toLowerCase()
		: 'other';

	let confidence = Number(d.confidence) || 0;
	if (confidence < 0) confidence = 0;
	if (confidence > 1) confidence = 1;
	confidence = Math.round(confidence * 1000) / 1000;

	return {
		category,
		confidence,
		needs_human: Boolean(d.needs_human),
		suggested_subject: String(d.suggested_subject || '').slice(0, 990),
		suggested_reply: String(d.suggested_reply || ''),
		internal_notes: String(d.internal_notes || ''),
		raw,
	};
}

// ============ Lambda Function URL handler (for regenerate from dashboard) ============
// If invoked via Function URL (POST /regenerate), regenerate the latest draft for a thread.
// Function URL events have requestContext.http.method.

exports.regenerate = async (event) => {
	const method = event.requestContext?.http?.method;
	// CORS preflight
	if (method === 'OPTIONS') {
		return jsonResponse(204, '');
	}
	if (method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed' });
	}

	let body;
	try {
		body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
	} catch (e) {
		return jsonResponse(400, { error: 'Invalid JSON' });
	}

	const threadId = body?.thread_id;
	const hint = (body?.hint || '').toString().trim().slice(0, 500); // optional staff guidance
	if (!threadId) {
		return jsonResponse(400, { error: 'thread_id required' });
	}

	try {
		const { data: thread, error } = await supabase
			.from('threads')
			.select('*')
			.eq('id', threadId)
			.single();
		if (error || !thread) {
			return jsonResponse(404, { error: 'Thread not found' });
		}

		// Fetch the previous draft (if any) so the AI can see what it wrote before
		let previousDraft = null;
		if (hint) {
			const { data: prevList } = await supabase
				.from('drafts')
				.select('suggested_subject, suggested_reply')
				.eq('thread_id', threadId)
				.order('created_at', { ascending: false })
				.limit(1);
			previousDraft = prevList && prevList[0] ? prevList[0] : null;
		}

		// Identify the current inbound (most recent on the thread) so we can
		// exclude it from history. The current inbound is what we're replying to;
		// history is everything before it.
		let currentInboundId = null;
		const { data: latestInbound } = await supabase
			.from('inbound_messages')
			.select('id')
			.eq('thread_id', threadId)
			.order('received_at', { ascending: false })
			.limit(1);
		if (latestInbound && latestInbound[0]) {
			currentInboundId = latestInbound[0].id;
		}
		const history = await loadThreadHistory(threadId, { excludeInboundId: currentInboundId, limit: 6 });

		const draft = await callOpenAI({
			resortName: thread.resort_name,
			guestName: thread.guest_name || '',
			guestEmail: thread.guest_email,
			subject: thread.subject,
			body: thread.body_text || '',
			hint,
			previousDraft,
			history,
		});

		let status = 'review';
		if (BLOCKED_CATEGORIES.includes(draft.category) || draft.needs_human) status = 'escalated';
		else if (draft.confidence >= 0.85) status = 'ready';

		const { data: insertedDraft, error: insertErr } = await supabase
			.from('drafts')
			.insert({
				thread_id: threadId,
				model: OPENAI_MODEL,
				prompt_version: 'v1',
				category: draft.category,
				confidence: draft.confidence,
				needs_human: draft.needs_human,
				suggested_subject: draft.suggested_subject,
				suggested_reply: draft.suggested_reply,
				internal_notes: draft.internal_notes,
				raw_response: draft.raw,
				source: 'ai',
			})
			.select()
			.single();
		if (insertErr) throw insertErr;

		await supabase.from('threads').update({ status }).eq('id', threadId);

		return jsonResponse(200, {
			thread_id: threadId,
			draft_id: insertedDraft.id,
			category: draft.category,
			confidence: draft.confidence,
			needs_human: draft.needs_human,
			status,
		});
	} catch (err) {
		console.error(err);
		return jsonResponse(500, { error: err.message });
	}
};

function jsonResponse(statusCode, body) {
	return {
		statusCode,
		headers: {
			'Content-Type': 'application/json',
			// CORS headers intentionally omitted — Lambda Function URL CORS config adds them.
			// Duplicating here produced 'Access-Control-Allow-Origin: *, *' which browsers reject.
		},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	};
}

// ============ SES Sending ============

// Look up the auto_send_enabled flag from Supabase system_settings table.
// Cached for the warm Lambda lifetime (~5 min) to avoid hammering DB.
let _autoSendCache = { value: null, fetchedAt: 0 };
async function isAutoSendEnabled() {
	const now = Date.now();
	if (_autoSendCache.value !== null && now - _autoSendCache.fetchedAt < 60_000) {
		return _autoSendCache.value;
	}
	try {
		const { data, error } = await supabase
			.from('system_settings')
			.select('value')
			.eq('key', 'auto_send_enabled')
			.eq('resort_id', RESORT_ID)
			.limit(1);
		if (error) throw error;
		const enabled = !!(data && data[0] && data[0].value === 'true');
		_autoSendCache = { value: enabled, fetchedAt: now };
		return enabled;
	} catch (e) {
		console.error('Failed to check auto_send_enabled, defaulting to OFF:', e.message);
		return false;
	}
}

// Build a properly-quoted From header: '"Name" <email>' or just '<email>'.
function buildFromHeader() {
	if (FROM_NAME && FROM_NAME.trim()) {
		return `"${FROM_NAME.replace(/"/g, '')}" <${FROM_ADDRESS}>`;
	}
	return FROM_ADDRESS;
}

async function sendViaSES({ threadId, draftId, toEmail, toName, subject, bodyText, inReplyTo, referencesHeader, sentBy }) {
	if (!toEmail) throw new Error('Missing recipient email');
	if (!subject) throw new Error('Missing subject');
	if (!bodyText) throw new Error('Missing body');

	// Idempotency: if this draft has already been sent successfully, short-circuit.
	// Covers the auto-send vs manual-send race (Lambda auto-sends an inbound, then
	// a human clicks Send on the same draft before the dashboard re-renders) and
	// also any retries / double-clicks. Keyed on draft_id, which is the same value
	// both paths converge on inside the same processEmail run.
	//
	// Skipped when draftId is null — we don't have a safe key to dedupe on, so
	// fall through to SES. Currently nothing in this codebase calls sendViaSES
	// without a draftId, but the schema allows it so we're defensive.
	if (draftId) {
		try {
			const { data: existingSend, error: dupErr } = await supabase
				.from('send_logs')
				.select('id, ses_message_id, created_at')
				.eq('draft_id', draftId)
				.eq('status', 'sent_via_ses')
				.order('created_at', { ascending: false })
				.limit(1);
			if (dupErr) {
				// Don't block the send on a dedup-lookup failure — log and continue.
				console.warn(`Idempotency lookup failed for draft=${draftId}: ${dupErr.message}`);
			} else if (existingSend && existingSend[0]) {
				const prior = existingSend[0];
				console.log(
					`Idempotency: draft=${draftId} thread=${threadId} already sent ` +
					`via SES (messageId=${prior.ses_message_id}, at=${prior.created_at}, ` +
					`current_caller=${sentBy}). Returning prior messageId without resending.`
				);
				return { messageId: prior.ses_message_id, deduped: true };
			}
		} catch (e) {
			console.warn(`Idempotency lookup exception for draft=${draftId}: ${e.message}`);
		}
	}

	// Layer 3: defense in depth — strip any wrapped/tracking URLs from outbound
	// in case they slipped past the inbound cleaning and the AI prompt.
	const cleanedSubject = unwrapTrackedUrls(subject);
	const cleanedBody = unwrapTrackedUrls(bodyText);

	const toAddress = toName ? `"${toName.replace(/"/g, '')}" <${toEmail}>` : toEmail;

	// Build threading headers for proper reply chains
	const customHeaders = [];
	if (inReplyTo) customHeaders.push({ Name: 'In-Reply-To', Value: ensureAngleBrackets(inReplyTo) });
	if (referencesHeader) {
		const refs = referencesHeader.split(/\s+/).filter(Boolean).map(ensureAngleBrackets);
		// SES caps header values at 998 chars. Truncate to keep root + tail.
		// Per RFC 5537 §2.2, keeping the first ID (thread root) and a recent tail
		// is the standard approach when refs get too long.
		const finalRefs = truncateReferences(refs, 990);
		if (finalRefs) customHeaders.push({ Name: 'References', Value: finalRefs });
	}
	if (REPLY_TO_ADDRESS !== FROM_ADDRESS) {
		// Reply-To is set via SESv2 ReplyToAddresses below; no need for custom header
	}

	const cmd = new SendEmailCommand({
		FromEmailAddress: buildFromHeader(),
		Destination: { ToAddresses: [toAddress] },
		ReplyToAddresses: [REPLY_TO_ADDRESS],
		Content: {
			Simple: {
				Subject: { Data: cleanedSubject, Charset: 'UTF-8' },
				Body: { Text: { Data: cleanedBody, Charset: 'UTF-8' } },
				Headers: customHeaders.length > 0 ? customHeaders : undefined,
			},
		},
	});

	let sesResult;
	try {
		sesResult = await ses.send(cmd);
	} catch (err) {
		// Log to send_logs with failed status
		await supabase.from('send_logs').insert({
			thread_id: threadId,
			draft_id: draftId,
			subject: cleanedSubject,
			body_text: cleanedBody,
			status: 'failed',
			sent_by: sentBy,
			ses_message_id: null,
			error_detail: err.message ? err.message.slice(0, 1000) : String(err).slice(0, 1000),
		});
		throw err;
	}

	const messageId = sesResult.MessageId;
	console.log(`SES sent: messageId=${messageId} to=${toEmail} thread=${threadId}`);

	// Log success
	await supabase.from('send_logs').insert({
		thread_id: threadId,
		draft_id: draftId,
		subject: cleanedSubject,
		body_text: cleanedBody,
		status: 'sent_via_ses',
		sent_by: sentBy,
		ses_message_id: messageId,
	});

	// Mark thread as sent
	await supabase.from('threads').update({
		status: 'sent',
		last_outbound_at: new Date().toISOString(),
	}).eq('id', threadId);

	return { messageId };
}

function ensureAngleBrackets(id) {
	const s = String(id || '').trim();
	if (!s) return '';
	if (s.startsWith('<') && s.endsWith('>')) return s;
	return '<' + s.replace(/^<|>$/g, '') + '>';
}

// Truncate a list of message-id refs to fit under maxLen chars when joined by spaces.
// Strategy: always keep the first (thread root) and as many trailing refs (most recent
// context) as will fit. This preserves threading integrity per RFC 5537 §2.2.
function truncateReferences(refs, maxLen) {
	if (!refs || refs.length === 0) return '';
	// First, dedupe in case the same id appears multiple times
	const seen = new Set();
	const uniq = [];
	for (const r of refs) {
		if (!seen.has(r)) { seen.add(r); uniq.push(r); }
	}
	let joined = uniq.join(' ');
	if (joined.length <= maxLen) return joined;
	// Need to truncate. Always keep the root (first ref).
	const root = uniq[0];
	// Then walk backwards from the tail, accumulating until adding the next ref would overflow.
	const tail = [];
	let runningLen = root.length;
	for (let i = uniq.length - 1; i > 0; i--) {
		const candidate = uniq[i];
		// +1 for the space separator between root/tail and items in tail
		const wouldBeLen = runningLen + 1 + candidate.length;
		if (wouldBeLen > maxLen) break;
		tail.unshift(candidate);
		runningLen = wouldBeLen;
	}
	// If after all that we still only have the root and one tail item that overflowed,
	// just return the root alone (worst case — still valid threading)
	return tail.length > 0 ? root + ' ' + tail.join(' ') : root;
}

// ============ HTTP handler for manual /send from dashboard ============

exports.sendReply = async (event) => {
	const method = event.requestContext?.http?.method;
	if (method === 'OPTIONS') return jsonResponse(204, '');
	if (method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

	let body;
	try {
		body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
	} catch (e) {
		return jsonResponse(400, { error: 'Invalid JSON' });
	}

	const threadId = body?.thread_id;
	const draftId = body?.draft_id || null;
	const overrideSubject = body?.subject;
	const overrideBody = body?.body;
	const sentBy = body?.sent_by || 'manual:dashboard';
	if (!threadId) return jsonResponse(400, { error: 'thread_id required' });

	try {
		// Load thread
		const { data: thread, error: tErr } = await supabase
			.from('threads')
			.select('*')
			.eq('id', threadId)
			.single();
		if (tErr || !thread) return jsonResponse(404, { error: 'Thread not found' });

		// Load latest draft if no override body provided
		let subject = overrideSubject;
		let bodyText = overrideBody;
		let resolvedDraftId = draftId;
		if (!bodyText || !subject || !resolvedDraftId) {
			const { data: drafts, error: dErr } = await supabase
				.from('drafts')
				.select('id, suggested_subject, suggested_reply')
				.eq('thread_id', threadId)
				.order('created_at', { ascending: false })
				.limit(1);
			if (dErr) throw dErr;
			const latest = drafts && drafts[0];
			if (!latest) return jsonResponse(400, { error: 'No draft found for thread' });
			subject = subject || latest.suggested_subject;
			bodyText = bodyText || latest.suggested_reply;
			resolvedDraftId = resolvedDraftId || latest.id;
		}

		// Pull threading headers from stored thread.
		// For normal sends: reply to the latest inbound (thread.message_id is the guest's last Message-Id).
		// For follow-ups (is_follow_up=true): thread is already 'sent' and we're sending an additional
		// outbound. Reference our previous outbound's SES Message-Id so Gmail/Outlook thread the
		// follow-up correctly under what we last sent.
		const isFollowUp = body?.is_follow_up === true;
		let inReplyTo = thread.message_id || '';
		let referencesHeader = (thread.ref_header || '') + ' ' + (thread.message_id || '');
		if (isFollowUp) {
			const { data: latestSent } = await supabase
				.from('send_logs')
				.select('ses_message_id, created_at')
				.eq('thread_id', threadId)
				.eq('status', 'sent_via_ses')
				.order('created_at', { ascending: false })
				.limit(1);
			if (latestSent && latestSent[0] && latestSent[0].ses_message_id) {
				inReplyTo = latestSent[0].ses_message_id;
				referencesHeader = referencesHeader + ' ' + latestSent[0].ses_message_id;
			}
		}
		referencesHeader = referencesHeader.split(/\s+/).filter(Boolean).join(' ').trim();

		const result = await sendViaSES({
			threadId,
			draftId: resolvedDraftId,
			toEmail: thread.guest_email,
			toName: thread.guest_name,
			subject,
			bodyText,
			inReplyTo,
			referencesHeader,
			sentBy,
		});

		return jsonResponse(200, {
			ok: true,
			thread_id: threadId,
			ses_message_id: result.messageId,
		});
	} catch (err) {
		console.error('sendReply error:', err);
		return jsonResponse(500, {
			error: err.message || String(err),
			error_name: err.name || null,
		});
	}
};
