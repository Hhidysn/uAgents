# Verified Execution Timeout Release Acceptance

Date: 2026-09-06

Release candidate: `0.2.0-alpha.1+codex.20260906234542`

Source implementation commit: `3fb582e feat: enforce verified OpenCode execution timeouts`

Release metadata commit: `a231a5a chore: version verified timeout release candidate`

## Scope

This acceptance verifies the Windows OpenCode `execution_timeout_ms` follow-up built on the previously accepted durable native-execution runtime. It does not claim provider/native cancellation acknowledgement and does not enable execution timeout for agy, WorkBuddy, desktop targets, or non-Windows OpenCode.

No real OpenCode/provider timeout request was sent during this acceptance.

## Source gate

The release-candidate source passed the full provider-free suite twice, including after the build-metadata bump:

- Core: `254/254`
- Doubao MCP: `11/11`
- TRAE MCP: `9/9`
- Unified MCP: `2/2`
- Total: `276/276`

The suite includes:

- PID/start-time/executable ownership mismatch refusing `taskkill`;
- a real harmless Windows Node process-tree termination and post-kill quiescence proof;
- guardian durable-ready handshake and pre-send fail-closed behavior;
- a live Worker observing `indeterminate + execution_timeout`;
- a Worker killed after native acceptance while the detached timeout guardian survives to the execution deadline;
- exactly one original prompt write after Worker death;
- workspace guard release only after root death plus descendant quiescence;
- a second overlapping writer admitted only after that guard release;
- original timed-out Attempt reconcile with zero spawn and zero prompt resend;
- unconfirmed timeout termination retaining an unknown workspace guard;
- existing durable cancel/observation behavior and all previous runtime/MCP tests.

Validation commands also passed:

```powershell
python C:\Users\24590\.codex\skills\.system\skill-creator\scripts\quick_validate.py plugins\uagents\skills\agent-dispatch
python C:\Users\24590\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\uagents
git diff --check
```

The source capability projection on Windows returned `execution_timeout=true` for OpenCode and did not expose the capability for WorkBuddy.

## Marketplace synchronization

The repository tracked plugin set was treated as authoritative via `git ls-files -- plugins/uagents`.

The synchronized release set contains:

- `120` tracked plugin files;
- `4,134,966` total bytes.

Repository tracked files were copied into a staging source and verified per-file by SHA-256 before replacing the personal marketplace source.

The previous marketplace source was preserved at:

```text
C:\Users\24590\plugins\uagents-backup-before-20260906234542
```

The active marketplace source is:

```text
C:\Users\24590\plugins\uagents
```

Existing plugin caches were not deleted.

## Installation

Normal installation used:

```powershell
codex plugin add uagents@personal --json
```

Codex returned:

- plugin: `uagents@personal`
- version: `0.2.0-alpha.1+codex.20260906234542`
- installed/enabled: true
- installed cache:

```text
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542
```

## Three-way file verification

The release was verified across:

1. repository tracked plugin files;
2. personal marketplace source;
3. newly installed Codex cache.

Results:

```text
tracked=120
bytes=4134966
market_files=120
cache_files=120
repo_market_mismatch=0
repo_cache_mismatch=0
```

Both the marketplace source and the installed cache passed the plugin validator.

Direct execution from the new cache returned:

- OpenCode modes: `analysis`, `implementation`
- file input: true
- file output: true
- `execution_timeout`: true
- routes:
  - `commandcode-goat/deepseek/deepseek-v4-flash`
  - `commandcode-goat/z-ai/glm-5.3-flash`

## Fresh Codex host verification

A new independent Codex process was launched with:

```text
codex exec --ephemeral --sandbox read-only
```

The validation prompt explicitly prohibited uAgents `submit`, `probe`, `ensure`, `reconcile`, `resume`, `cancel`, `stop`, any Agent/provider target action, and file modification.

The fresh process explicitly loaded:

```text
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542\skills\agent-dispatch\SKILL.md
```

It then ran only the installed cache's local read-only discovery commands and reported:

```text
Loaded plugin root:
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260906234542

Targets:
agy, workbuddy, opencode, doubao, trae

OpenCode modes:
analysis, implementation

Files:
inputs=true, outputs=true

execution_timeout=true

Routes:
commandcode-goat/deepseek/deepseek-v4-flash
commandcode-goat/z-ai/glm-5.3-flash
```

The fresh host process used GPT-5.6 Luna as Codex's own model. Its normal Codex startup/network activity is separate from uAgents target execution; no uAgents OpenCode/provider timeout request was made.

## Result

`0.2.0-alpha.1+codex.20260906234542` is the locally installed and fresh-host-verified release candidate for verified Windows OpenCode execution timeouts.

The remaining explicit limitation is unchanged: local owned process-tree termination is not provider/native cancellation acknowledgement. A real provider timeout smoke remains optional and requires explicit user authorization.
