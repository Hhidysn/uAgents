# WorkBuddy

Use `target=workbuddy` and `model=default`. Policy resolves this to `route_id=workbuddy-default` while `model_resolved` remains null because the backend chooses the model. Do not replace that with `auto` or a guessed concrete model. Current native events may report a label, but it remains unverified unless a future adapter can bind it to the resolved route.

Supported modes are `analysis` and `implementation`. Implementation opts into the native `acceptEdits` mode; analysis inherits native permissions and is not enforced read-only. The adapter locates the existing WorkBuddy `codebuddy.js`, uses stdin plus stream-json, assigns a per-task native session, disables model-created background tasks, and never bypasses approvals.

Probe is version-only: it does not prove login, quota, or model availability. Completion requires the matching session/cwd, one valid terminal result, no unresolved background task, and verified declared outputs. Cancellation interrupts the locally held process, but a sent task remains `indeterminate` unless remote cancellation is proven.
