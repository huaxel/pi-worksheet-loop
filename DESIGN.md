# Design: Document-first Pi

## Core idea

The document is the control plane; the terminal is the execution console.

This does **not** mean streaming every keystroke into the model or exposing hidden model reasoning. Saved Markdown revisions are the interaction events. Saving a meaningful revision should steer Pi without requiring the human to copy the change into a separate prompt.

## Attention policy

There must be one canonical home for substantive collaboration:

- plans, findings, decisions, questions, and durable progress belong in the worksheet;
- the TUI shows compact status, active tool/execution state, errors, blocking questions, and explicit interruptions;
- the same full answer should not be duplicated in both the TUI and the worksheet;
- normal chat remains available as an emergency/quick-command mode.

The current extension provides the file watcher and steering transport, but does not yet enforce this response-routing policy.

The M3 footer status (`ui.setStatus("worksheet", ...)`) begins the attention split: it shows watcher state, the active worksheet, and open todo/question counts as a compact document pointer, so the TUI can stay a status/execution surface while the worksheet holds the substance.

Document-first mode (`/worksheet mode on|off`, default on when a worksheet exists) enforces the split at the prompt level: when on, a `DOCUMENT_FIRST_DIRECTIVE` is appended to the system prompt instructing Pi to keep findings/decisions/progress in the worksheet, use the TUI for compact status/errors/blocking questions, and never duplicate the same full answer in both channels. The directive is built by the pure `buildSystemPrompt(base, {documentFirst, skillContent})` helper, so routing policy is unit-testable without booting the extension.

Attention routing is enforced at the transport level too: in document-first mode the steering message for a saved worksheet change is a compact pointer (`[Worksheet update — file] Saved changes. Open the worksheet…`) instead of inlining the section diff. The diff is still recorded in the audit event (`ops`) and the full document stays authoritative; the TUI simply stops duplicating it. The pure `buildSteeringMessage(filename, summary, documentFirst)` helper keeps this logic unit-testable.

## Markdown contract

Markdown is the human-facing medium. It is portable, inspectable, searchable, editor-agnostic, and independent of Git. It is not the entire protocol; the extension supplies revision tracking, ownership, debouncing, loop prevention, and change summaries.

New worksheets use these sections:

```markdown
## Task
## Human notes
## Todos
## Progress
## Findings
## Decisions
## Questions / Next steps
```

Ownership:

- `Human notes` is human-owned and must not be overwritten by Pi.
- `Todos` express task state; unchecked items are work, checked items are completion claims to verify.
- `Progress`, `Findings`, `Decisions`, and `Questions / Next steps` are Pi-maintained durable state, appended rather than rewritten.

Markdown-native conventions are preferred over hidden HTML metadata. Headings, paragraphs, blockquotes, and checkboxes should carry meaning before introducing machine syntax.

Stable semantics (the machine-meaning contract, taught to Pi via the injected skill):

- **Comments**: a `> ` blockquote is a direct human comment to Pi. `## Human notes` is human-owned and never overwritten; Pi replies append under `## Agent response`.
- **Questions**: items under `## Questions / Next steps` are open steering asks; ticking one (`- [ ] ?` → `- [x] ?`) closes/answers it. A blank `?` item is a question awaiting an answer; deleting an open question means “remove from plan” (answer first if it was open).
- **Todos**: `- [ ]` open work, `- [x] done claim (to verify, not proof)`. Flipping back to `- [ ]` reopens the item.

The extension detects checkbox *transitions* and surfaces them as a `Semantics:` call-out in the steering message plus a `semantics` field in the audit event, so Pi doesn't re-derive meaning from a raw diff.

## Deletion and auditability

A deletion removes something from the active plan. The watcher reports removed lines to Pi, but deletion alone does not preserve why something was rejected.

When rationale matters, record it before deleting or superseding the active item:

```markdown
## Decisions

- Rejected the localStorage approach because settings must sync across devices.
- Superseded the original plan with the configuration service approach.
```

This gives the document a clean active state and a lightweight rationale trail. For full event history, each worksheet also gets an append-only sidecar under `.worksheets/.history/<id>/events.jsonl` (revision id, parent revision, actor, changed sections, operation summary, changed block ids, conversation/turn id) plus a `block-ids.json` map. The sidecar is regenerable local state (gitignored); the visible Markdown remains the canonical collaboration surface.

## Block identity

Sections are matched across saves by heading+content similarity so a block keeps a stable id through in-place edits, heading renames, section reordering, and additions/deletions. Ids live in the sidecar map, not in the visible Markdown — the document stays human-clean while machine identity stays stable (Zed's logical-anchor lesson, without full CRDT replication).

## Revision semantics

The extension should eventually send section-aware revisions:

- file path and revision identity;
- changed sections;
- additions;
- removals;
- current relevant content;
- whether the change was human-originated or agent-originated.

The current implementation stores prior file contents, reports bounded line-level additions/removals within changed Markdown sections, and points Pi to the full document on disk when broader context is needed. It watches `.worksheets` and explicitly attached Markdown files independently of Git, so untracked and gitignored documents are valid collaboration state.

## Product boundary

This is distinct from:

- `git diff`: a passive VCS comparison, not an agent interaction protocol;
- Zed ACP: an editor/agent transport, not a durable document collaboration model;
- plan review: an approval UI, not an ongoing bidirectional workspace;
- memory injection: context retrieval without human-directed document events.

## Testing

`pi/agent/extensions/pi-test-harness.mjs` is a shared, hermetic test harness for Pi extension tests. It provides `makePiHarness` (mock ExtensionAPI), `makeCtx` (stub command context with recording UI), `fakeClock`, `tempDir`, `runTests`, `assert`, and `registerResolveHook`. Each extension test may import only what it needs; tests run with plain `node` against a `pi-resolve-hook` so `@earendil-works/*` imports resolve from the pi install. See `harness.test.mjs` (self-tests) and `restart.test.mjs` (a consumer) for usage.

## Prior art

- [`pi-watcher`](https://github.com/vedang/pi-watcher) — explicit `AI!`, `AI?`, and `AI.` saved-comment triggers, queueing, and loop prevention.
- [`pi-simplewatcher`](https://github.com/studioschade/pi-simplewatcher) — active/passive filesystem watches and inbox delivery.
- [`pi-doc-review`](https://github.com/danmactough/doc-review) — Markdown review window with comments and raw edits.
- [`pi-plan-extension`](https://github.com/khoafullstack/pi-plan-extension) — Markdown plans and checklist execution.
- [`Cairn`](https://github.com/RT64M/cairn) — Markdown protocol for human intervention, plans, TODOs, and archived rationale.
- [`agent-work-mem`](https://github.com/daystar7777/agent-work-mem) — vendor-neutral Markdown memory and handoffs.
- [`Moment`](https://moment.dev/) — polished collaborative Markdown workspace with embedded agents.

No single Pi package currently combines the desired document surface, saved-revision steering, bidirectional writes, durable task semantics, and TUI attention routing.
