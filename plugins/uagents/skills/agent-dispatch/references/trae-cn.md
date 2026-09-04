# TRAE CN desktop Agent

Use `target=trae`, `model=default`, and either `analysis` or `implementation`. The route uses the explicitly started loopback TRAE gateway and the user's logged-in TRAE CN Solo surface; it does not substitute `traecli`, TRAE Work, or another billing source.

The user starts TRAE CN on its dedicated CDP port and separately runs the bundled gateway launcher at `mcp/trae/scripts/start-gateway.mjs`. The adapter verifies the workbench identity before the send checkpoint. It always requests a new Solo conversation with `autoContinue=false` and `autoApproveDialog=false`, then persists the native task ID.

Probe is connection-only and does not prove quota. Native approvals remain in the TRAE window. Insufficient credits map to `quota_exhausted`; no UUID/model/provider fallback occurs. The current transport does not report a trustworthy concrete model, so `model_reported=null` and `model_verified=false`. Native cancel is not considered confirmed by this adapter.
