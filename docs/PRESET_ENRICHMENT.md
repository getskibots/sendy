# Preset-Aware AI Enrichment

How the vertical preset (chosen in omni-odin's Settings → General) reaches
Sendy's AI enrichment, so inbound email is classified against the **active
vertical's** question types — a hotel's emails get hotel categories
(Reservations & Booking, Rooms & Suites, …), not the built-in ski taxonomy —
and the inbox represents them with the vertical's own labels.

This extends the `accounts.instructions` JSONB contract
(omni-odin: `docs/handoff/INSTRUCTIONS_CONTRACT.md`) with one additive key.
Additive = non-breaking under that contract's versioning policy.

---

## The contract extension — `instructions.preset`

```jsonc
{
  // ...existing contract fields (parent, chat, voice, email, auto_send, ...)
  "preset": {
    "id": "lodging",                     // KnowledgePreset id
    "label": "Hotel & Accommodations",   // display label
    "emoji": "🏨",
    "version": "1.0",                    // KnowledgePreset version
    "categories": [                      // the vertical's question-type taxonomy
      { "key": "reservations_booking", "label": "Reservations & Booking", "emoji": "🛎️" },
      { "key": "rooms_suites",         "label": "Rooms & Suites" },
      { "key": "amenities",            "label": "Amenities & Facilities" }
    ]
  }
}
```

**Writer (omni-odin):** on preset apply / Knowledge save, derive `categories`
from the active `KnowledgePreset.knowledgeGroups` — one category per group
(`group.id` → `key`, `group.label` → `label`, `group.emoji` → `emoji`) — and
write the block alongside the rest of the JSONB. Keys should be
lowercase snake_case; the consumer sanitizes anyway (lowercases, converts
non-alphanumerics to `_`, drops empties and duplicates of the universal set).

**Absent/invalid `preset` → zero behavior change.** The Lambda falls back to
the built-in ski taxonomy, exactly as before this feature.

## Category universe at classification time

```
allowed = [vertical categories] + [universal categories]
```

- **Vertical**: from `instructions.preset.categories`; fallback = the ski set
  (`lift_tickets`, `season_passes`, `lessons`, `rentals`, …).
- **Universal** (every vertical, fixed): `general_question`, `group_booking`,
  `lost_and_found`, `refund_request`, `complaint`, `safety_issue`,
  `legal_threat`, `medical_issue`, `angry_guest`, `other`.

The six **sensitive** categories (`refund_request` → `angry_guest`) are
load-bearing and never vary by preset: the auto-send escalation gates
(`auto_send.blocked_categories` defaults) and the Confidence Calibration Rules
in the drafting machinery reference them by name. The taxonomy guide instructs
the model that sensitive situations always take their sensitive category even
when a business-specific type also fits — so a "refund my hotel room" email
escalates the same way a "refund my lift ticket" email does.

## Consumer 1 — inbound Lambda (`lambdas/inbound/index.js`)

- `getPresetConfig()` reads `instructions.preset` (cached ~60s, same pattern
  as `getAutoSendPolicy()`), sanitizes it via `normalizePreset()`.
- `buildSystemPrompt(...)` rewrites the machinery's `"category": one of [...]`
  enum to the active universe and, when a preset is present, inserts a
  **Question-Type Taxonomy** section (key → label per category) ahead of
  OUTPUT FORMAT so the model understands each type, not just its slug.
- `normalize()` validates the model's category against the same universe;
  anything else coerces to `other`.
- Applies to both drafting paths: inbound SQS and dashboard regenerate.

`drafts.category` stores the key as plain text — no schema change.

## Consumer 2 — dashboard (`dashboard/sendy.htm`)

- Loads `instructions.preset` at init; builds a key → `{label, emoji}` map.
- Category chips (thread detail + AI banners) render the vertical's labels
  with emoji, falling back to prettified keys.
- Thread rows show a question-type chip once the thread's latest draft is
  known (opened, drawer-loaded, or filter-loaded).
- A **question-type filter** dropdown sits under the inbox search: options are
  the vertical's categories + the universal ones; selecting one bulk-loads the
  latest draft per thread and filters the list.

## Verifying end-to-end

1. In Supabase, merge a `preset` block (shape above) into the single
   `accounts` row's `instructions` JSONB.
2. Send a test email → the new draft's `category` should be one of the
   vertical's keys (check `drafts.category`).
3. Open the dashboard → chips show the vertical's labels; the filter lists
   the vertical's question types.
4. Remove the block → within ~60s (cache TTL) classification reverts to the
   ski taxonomy.

## Not covered here (known gaps, unchanged by this feature)

- **Multi-tenancy**: the Lambda still serves one account (first `accounts`
  row). When per-tenant lands, `getPresetConfig()` keys by account like
  everything else at the MULTI-TENANT INSERTION POINT.
- **omni-odin writer**: the authoring side must start writing
  `instructions.preset` on preset apply/save (see "Writer" above). Until it
  does, the ski fallback stays active.
