# Roadmap

## M1 — Shared document transport ✅

- [x] Watch saved Markdown changes.
- [x] Feed human changes back to Pi as steering input.
- [x] Prevent agent-write feedback loops.
- [x] Debounce per file and clean up watchers on shutdown/reload.
- [x] Pause/resume the loop.
- [x] Attach existing project Markdown files.
- [x] List, search, and open named project worksheets.

## M2 — Document interaction protocol ✅

- [x] Define human-owned notes and agent-owned durable state.
- [x] Add todos, findings, decisions, and questions to new worksheets.
- [x] Report additions and removals to Pi.
- [x] Make updates section-aware instead of sending the whole document.
- [x] Define stable semantics for comments, questions, and todo transitions.
- [x] Decide how much deletion/rejection history belongs in the document (durable audit sidecar, rationale kept in decisions).
- [x] Add a reusable Pi extension test harness.
- [x] Durable audit sidecar per worksheet (`.history/<id>/events.jsonl`) with revision id, parent, actor, changed sections, operation summary, conversation/turn id.
- [x] Stable block identities reconciled across saves via content+heading similarity, stored out-of-band (`block-ids.json`).
- [x] Formal spec for the section-aware update format (`SECTION-AWARE-FORMAT.md`).
## M3 — Attention routing ✅

- [x] Define a document-first mode versus normal chat mode (`/worksheet mode on|off`; default on when a worksheet exists).
- [x] Make substantive Pi responses canonical in the worksheet (document-first directive routes findings/decisions/progress to the worksheet).
- [x] Reduce the TUI to status, execution, errors, blocking questions, and interruptions (compact steering message in document-first mode points at the worksheet instead of inlining the diff).
- [x] Avoid duplicating full answers in both channels (compact steering message + directive both forbid inlining).
- [x] Prototype compact status and document pointers in the footer (worksheet watcher state + open todo/question counts via `ui.setStatus`).

## M4 — Real workflow validation ⬜

- [ ] Use the workflow for one real coding task from start to finish.
- [ ] Use it for a writing/review task.
- [ ] Use it with both Neovim and an external Markdown editor.
- [ ] Measure whether it reduces prompt copying and transcript scrolling.
- [x] Document failure modes and recovery behavior (`FAILURE-MODES.md`).

## Research follow-ups

- [x] Compare `pi-watcher` trigger/queue semantics with the worksheet watcher (`RESEARCH.md` — queue_until_idle, consumed-marker loop prevention vs sentinel+hash; steering richness).
- [x] Study Cairn’s archive and rationale conventions (`RESEARCH.md` — `.cairn/archive/`, decision status transitions, HUMAN.md handoff, provenance chains).
- [x] Evaluate whether `pi-doc-review` can be used as an optional review surface (`RESEARCH.md` — Glimpse review window; fit as an M4 writing/review renderer, not a dependency).
- [ ] Decide whether to publish this as a reusable Pi package after the workflow stabilizes.
