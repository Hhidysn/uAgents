# Doubao Work desktop Agent

Use `target=doubao`, `model=default`, and `mode=analysis`. File and image inputs are not exposed. The unified adapter uses the existing loopback CDP transport; it does not expose arbitrary JavaScript or CDP evaluation to callers.

uAgents manages the Doubao Work instance itself: `submit` verifies the installed executable (Authenticode, publisher, product) and launches a dedicated isolated-profile instance with a loopback CDP port, or reuses the running managed one. The user's own Doubao windows are never connected to, navigated, or stopped. A fresh managed profile shows a login or setup screen first: the task parks in `waiting_user` with `interaction.phase=preflight_login` and `submission=not_sent`; after the user logs in once in the dedicated window, the same UUID `submit` or `resume <task-id>` continues the original attempt. CLI `probe doubao` (or MCP `uagents_probe`) stays read-only and never starts anything.

Submission obtains shared leases, establishes a blank conversation, persists `possibly_sent` before Enter, and stores the confirmed conversation identity before observation.

Approvals are handled by the user in the native window. There is no confirmed native cancel, so a cancellation request after send becomes `indeterminate`. Connection loss, ambiguous conversation identity, or timeout is never replayed with a new UUID. Doubao does not report a selectable model identity through this transport; keep `model_reported=null` and `model_verified=false`.
