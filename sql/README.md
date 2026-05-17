# SQL Migrations

Place actual migration files here (001–005 from Brandon's machine).

## Schema reference (reverse-engineered from Lambda source)

### threads
`id`, `resort_id`, `resort_name`, `guest_email`, `guest_name`, `subject`,
`body_text`, `body_text_raw`, `body_html`, `status` (new/ready/review/escalated/sent),
`message_id`, `in_reply_to`, `ref_header`, `last_inbound_at`, `last_outbound_at`,
`headers_json`, `subject_normalized`, `raw_s3_key`, `deleted_at` (migration 004),
`created_at`, `updated_at`.

### inbound_messages (migration 005)
`id`, `thread_id` (FK → threads CASCADE), `from_email`, `from_name`, `subject`,
`body_text`, `body_text_raw`, `body_html`, `message_id`, `in_reply_to`, `ref_header`,
`raw_s3_key` (UNIQUE WHERE NOT NULL), `received_at`, `created_at`.
Index on `(thread_id, received_at)`.

### drafts
`id`, `thread_id`, `model`, `prompt_version`, `category`, `confidence`,
`needs_human`, `suggested_subject`, `suggested_reply`, `internal_notes`,
`raw_response`, `source`, `created_at`.

### send_logs
`id`, `thread_id`, `draft_id`, `subject`, `body_text`, `to_email`,
`ses_message_id`, `status`, `sent_by`, `created_at`.
**TODO migration 006: add index on (draft_id, status)**

### system_settings
`key`, `value`, `updated_at`. Required: `auto_send_enabled`.

### escalation_flags
`thread_id`, `reason`, `detail`, `raised_by`.
