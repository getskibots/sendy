# Outbound Lambda (planned)

Planned split of `sendViaSES` out of the inbound Lambda into its own function.

## Roadmap
- Move `sendViaSES`, `ensureAngleBrackets`, `truncateReferences`, `buildFromHeader`, `unwrapTrackedUrls` here
- Feed by a new `sends` SQS queue
- Both auto-send path and dashboard send path enqueue instead of calling directly
- Idempotency check moves with `sendViaSES`

**Do not build until roadmap item #2 is approved by Brandon.**
