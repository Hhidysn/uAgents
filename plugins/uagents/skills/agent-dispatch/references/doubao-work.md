# Doubao Work desktop Agent

Use `target=doubao`, `model=default`, and `mode=analysis`. File and image inputs are not exposed. The unified adapter uses the existing loopback CDP transport; it does not expose arbitrary JavaScript or CDP evaluation to callers.

The user must start one dedicated Doubao Work instance with a loopback remote-debugging port. CLI `probe doubao` (or MCP `uagents_probe`) confirms the application target without sending a message. Submission obtains shared leases, establishes a blank conversation, persists `possibly_sent` before Enter, and stores the confirmed conversation identity before observation.

Approvals are handled by the user in the native window. There is no confirmed native cancel, so a cancellation request after send becomes `indeterminate`. Connection loss, ambiguous conversation identity, or timeout is never replayed with a new UUID. Doubao does not report a selectable model identity through this transport; keep `model_reported=null` and `model_verified=false`.
