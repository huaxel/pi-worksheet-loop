# Decisions

## 2026-08-19 — Markdown is the primary human surface

Use ordinary Markdown as the collaboration medium. Prefer headings, paragraphs, blockquotes, and checkboxes over hidden HTML metadata or editor-specific syntax.

## 2026-08-19 — Saved revisions, not keystrokes

The workflow does not stream every keystroke into the model. A saved meaningful revision is the interaction event, and saving should steer Pi without a second copy-pasted prompt.

## 2026-08-19 — Git is not the boundary

Worksheets may be untracked, gitignored, generated, or never committed. The extension watches filesystem documents directly.

## 2026-08-19 — One canonical home for substantive work

Plans, findings, decisions, questions, and durable progress belong in the worksheet. The TUI remains an execution/status/interrupt surface and should not duplicate full document answers in document-first mode.

## 2026-08-19 — Keep rationale before deletion

Deleting an active item is allowed, but important rejection or supersession rationale should be recorded under `## Decisions` or `## Progress` before removal.

## 2026-08-23 — Durable audit sidecar (`events.jsonl`) with stable block ids

Revisions are recorded to an append-only `events.jsonl` per worksheet with revision id, parent revision, actor (human/agent), changed section keys, operation summary, changed block ids, conversation and turn id. Block identity is reconciled across saves from content+heading similarity so edits, renames, and reordering do not churn ids — idempots live in the sidecar, never in the visible Markdown. This follows Zed's DeltaDB (append-only deltas over a real worktree) and logical-anchor lessons from the worksheet research, without full CRDT text replication.

## 2026-09-23 — Explicit worksheet ownership per session

Parallel Pi processes share `.worksheets/`; selecting the newest file on startup lets one session steer or display another session's work. Sessions now start unselected and in normal chat mode. `/worksheet start`, `/worksheet open <name>`, and `/worksheet attach <path>` explicitly claim the active worksheet for that process; unselected sessions ignore worksheet edits.

## 2026-08-24 — Stable semantics for comments, questions, todos

Markdown-native contract, no hidden HTML metadata:
- Comments are `> ` blockquotes; `## Human notes` is human-owned, Pi appends under `## Agent response`.
- Questions are `## Questions / Next steps` items ending in `?`; ticking one closes/answers it, deleting one removes it from the plan (answer first if open).
- Todos: `- [ ]` open work, `- [x]` a done claim to verify (not proof); flipping back to `- [ ]` is a reopen.
The extension detects checkbox transitions and surfaces them as a `Semantics:` call-out plus a `semantics` audit field, so Pi needn't re-derive meaning from a raw diff. Codified in SKILL.md and DESIGN.md.

## 2026-08-24 — Document-first mode (M3 attention routing)

Substantive responses belong in the worksheet; the TUI is a status/execution/error/interrupt surface. `/worksheet mode on|off` toggles it (default on when a worksheet exists). When on, a `DOCUMENT_FIRST_DIRECTIVE` is appended to the system prompt via the pure `buildSystemPrompt()` helper, enforcing: findings/decisions/progress go in the worksheet, TUI prose stays short with document pointers, quick clarifications can stay in chat, and no content is duplicated across both channels.

## 2026-10-12 — Review fixes: injection wiring, bash guard, fence-aware parsing

After a full code review (2026-10-12), the following behaviors are now load-bearing:

- **Skill injection resolves the package-root `SKILL.md`** (the old `../skills/worksheet-loop/` path never resolved and silently injected nothing). Content is cached after first read. Pi's native skill system only advertises name+description+path, so full-content injection is not duplicated.
- **The system prompt names the active worksheet.** In document-first mode the `before_agent_start` hook appends `Active worksheet: <path>` so the agent knows the canonical file without guessing (guessing is forbidden by the skill).
- **Bash writes are guarded.** A `bash` tool call whose command mentions `.worksheets` arms a wildcard (`"*"`) guard covering every worksheet file for the whole command window (disarmed on `tool_execution_end`, 300s crash timer, `"*"` also visible in other processes' `.ws-lock-<pid>` sentinels). Hashes of active/attached files are refreshed at disarm so the agent's own bash write never re-injects.
- **Write-window interleaves are surfaced.** `write` tools carry the expected post-write content hash; if the file on disk differs at disarm, a re-read steer is sent and the merged state is logged as the agent revision.
- **Markdown structure parsing is fence-aware.** Headings, todos, and question lines inside ```/~~~ fences are content, not structure (`codeFenceMask`). Indented (nested) todos now count and transition like top-level ones.
- **Document-first steering keeps `Semantics:` lines** (todo check/reopen) in the compact pointer; the section diff stays in normal mode only.
- **Explicit `/worksheet mode` survives reloads.** `session_start` recomputes the default only when the user has not set the mode explicitly.
- **History root resolves at call time**, not at extension load.
- **Path identities are canonicalized** (`fs.realpathSync`, falling back to the deepest existing ancestor for not-yet-existing files). fs.watch on macOS reports symlink-resolved paths while tool inputs and commands give raw ones (e.g. `/var` vs `/private/var` under `$TMPDIR`); without canonicalization the guard, the stored-hash bookkeeping, and the history ids silently desync and steering is dropped. Caught by the runtime smoke test, not by review. The arming side (`isWorksheetPathForSession`) canonicalizes both the tool-input path and the stored root/attached paths, so a model passing either symlink form still arms the guard.
- **Agent-write attribution uses an arm-time content snapshot.** The guarded-skip path refreshes the stored hash while the agent's write is in flight, so comparing against the stored state at disarm sees "no change" and the `actor:"agent"` revision never reaches the audit log. The guard now captures the file content at `tool_call` time and `recordRevision` accepts an explicit previous (`prevOverride`), so agent writes are always recorded even when the stored hash already moved.
- **A real-pi RPC integration check exists** (`scripts/rpc-integration-check.mjs`, not part of `npm test` — it spawns a real session and makes two model calls). It drives `pi --mode rpc -ne -e index.ts` and verifies registerCommand, session_start, command execution, the `before_agent_start` prompt override, and human/agent audit attribution at runtime. Run it after pi updates: the 1.0.4→1.1.0 API diff was additive (`durationMs`, `outputPad`, `aborted` — none used by this extension), but the team is refactoring and the static `.d.ts` can lag.
- **The guard is reference-counted, because pi executes tool batches in parallel by default** (`toolExecution: "parallel"` in pi-agent-core's `Agent`; per-file disk mutations are still serialized by pi's file-mutation-queue, but the guard windows overlap). Without refcounting, the first `tool_execution_end` of a two-write batch cleared the guard while the sibling write was still in flight, and the watcher attributed that in-flight agent write to the human (spurious `actor:"human"` revision + self-steer). `worksheetGuard` now counts arms per key and only releases at zero; the 300s crash timer releases the whole key (matching the sentinel's external stale-expiry). The debounce timer also re-checks the guard/external-lock at fire time, so a timer scheduled by a genuine human edit never attributes an in-flight agent write. Regression: runtime test phase 4b (fails on the old guard, verified). An external adversarial review surfaced this; most of its other High claims were false positives (see the review-triage note below).
- **`block-ids.json` is written atomically** (tmp + `renameSync`) so a crash mid-write cannot leave a truncated JSON file that wipes persisted block identities on next load. The audit JSONL stays a plain `O_APPEND` append, which is safe on local disks for single small lines.
- **Review-triage note (method).** An LLM review of `index.ts` produced 23 confident, line-numbered findings, several of them contradicted by the passing 10/10 real-pi integration check (e.g. `__dirname` "fatal in ESM" — pi's extension loader provides it; `process.cwd()` "crashes the turn" — pi wraps handler throws in `extension_error` and continues; system-prompt "accumulation" — `forceSystemPrompt` is per-call). Every claim was verified against the source or the live runtime before a single line was changed: 3 real issues fixed, the rest documented as false positives or as the known in-window suppression limitation.
- A strict `tsc --noEmit` typecheck (`npm run typecheck`, tsconfig against the pi 1.1.0 SDK) is part of the dev gate; the pure core and the watch→steer loop each have automated tests.
