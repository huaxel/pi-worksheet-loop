# Research follow-ups — findings

Status: M4 research. Updates the preliminary "Prior art" notes in DESIGN.md with
primary-source detail on the three tools flagged for deeper study, and records
the worksheet-loop design implications.

## pi-watcher (vedang/pi-watcher) — trigger/queue semantics vs. worksheet loop

Primary source: the repo README + source (cloned locally).

**Marker model.** Watches files in the pi working dir for explicit comment
markers; dispatches focused prompts on save:
- `AI!` — edit request (use normal read/edit/write tools).
- `AI?` — question (answer without editing unless the comment asks).
- `AI.` — context anchor, included with the next actionable `AI!`/`AI?` batch but
  does not trigger a turn alone.
- Markers are case-insensitive, supported as `#`, `//`, `--`, `;` comments; bare
  `AI` (no punctuation) is ignored.

**Queue/busy semantics.** `busyPolicy: "queue_until_idle"` — a trigger that
arrives while the agent is running is queued and dispatched once idle. After the
agent fully settles (including retries/compaction/queue continuation), handled
marker comments are **removed from the source file** by default; if cleanup is
disabled, a processed-marker ledger suppresses re-dispatches until the comment
text changes or `/watcher retry` is run.

**Config.** Precedence: defaults → global `~/.pi/agent/pi-watcher.json` → project
`<cwd>/.pi/extensions/pi-watcher.json`. Root/include/ignore globs, `debounceMs`
(300), `maxFileBytes`, `maxPromptBytes`, `removeHandledMarkerComments`.

**Loop prevention** = marker removal + intent ledger. The marker is the trigger
_and_ gets consumed; a stale marker never re-fires.

**Comparison → worksheet loop.**
- **Trigger source**: pi-watcher uses in-code `AI!` markers in arbitrary files;
  the worksheet loop uses section-aware *saves* of `.worksheets/*.md`. The
  worksheet is document-grade collaboration; pi-watcher is edit-request dispatch.
- **Busy policy**: pi-watcher queues until idle; the worksheet loop waits for the
  debounce then steers immediately (deliverAs "steer"). pi-watcher's queue
  semantics are richer but the worksheet loop's section diff already carries
  intent.
- **Loop prevention**: pi-watcher removes the marker; the worksheet loop uses a
  `.ws-lock-<pid>` sentinel + hash bookkeeping. Both avoid re-injection; the worksheet
  approach is non-destructive (doesn't rewrite the source).
- **Steering richness**: the worksheet loop sends a section diff + semantics
  layer; pi-watcher sends file:line + snippet. The worksheet loop is strictly
  more informative.
- **What to adopt**: pi-watcher's `queue_until_idle` busy policy and its explicit
  "consumed marker" model are worth borrowing if the worksheet loop grows
  dispatch of queued edits.

## Cairn archive/rationale conventions

Primary sources: RT64M/cairn (Markdown collaboration protocol) and
cairn-framework (decision provenance chains).

**RT64M/cairn — single-instruction protocol.** Drop `AGENTS.md` in the repo root
and it takes effect (no install). Owns a `.cairn/` dir; the root keeps only
`AGENTS.md`. Core files: `plan.md` (outline, init-only), `ARCHITECTURE.md`,
`TODO.md` (work ledger), `HUMAN.md` (human-only tasks / direction decisions).
Supplemental `fix_*.md` (defect feedback) and `fix-plan_*.md` (plan revision)
files run a `fix / fix-plan → TODO ⇄ HUMAN` loop.

- **Archive**: closed `fix`/`fix-plan` batches move to `.cairn/archive/` — history
  is preserved, the active root stays compact. `plan.md` is only rewritten via two
  entry points (fix archive correction, or fix-plan after user final
  confirmation) to stop per-session drift.
- **Human handoff**: agent packages what it can't do or decide into `HUMAN.md`;
  the human edits status/feedback any time; the agent pauses the affected scope
  and continues independent work.
- **TODO** statuses include active, parked, deprecated, done; sub-items, blockers,
  and source provenance.

**cairn-framework — decision provenance.** Decisions carry
`status` (`proposed|accepted|deprecated|superseded`), `date`, optional
`revisited` + `revisit_triggers`, and typed edges `informed_by` (research),
`supersedes`, `refines`, `related`. A provenance chain
`Source → Research → Decision → (Blueprint + Contract + Code)` links evidence to
architecture. Status transitions: `proposed → accepted`, `accepted →
deprecated`, `accepted → superseded`.

**Comparison → worksheet loop.**
- **Archive**: the worksheet loop's `.history/<id>/` audit sidecar already
  archives every revision, but the *Markdown* has no "move closed items to an
  archive" behavior. Our `DECISIONS.md` records rationale but doesn't formally
  transition decision statuses. Adopt `supersedes`/`deprecated` as first-class
  transitions and a `.cairn/archive/`-style sweep for closed todo lists.
- **Human handoff**: our `## Human notes` / `## Questions / Next steps` serve
  Cairn's `HUMAN.md` role — the worksheet already packages human decision points.
- **Provenance**: the worksheet's `semantics` audit field + `parent` revisions are
  a lightweight analogue of Cairn's typed decision graph (`informed_by`,
  `supersedes`). We could enrich decision lines with explicit `supersedes:` refs.

## pi-doc-review as an optional review surface

Primary source: pi.dev package page.

**What it is.** A Pi extension that reviews Markdown documents with the AI agent.
Opens a native **Glimpse review window** rendering the Markdown, supports
selection-level and document-level comments, permits direct **raw Markdown
edits**, and sends the resulting feedback back to the agent. Install
`pi install npm:pi-doc-review` (v0.1.1, MIT).

**Fit with the worksheet loop.** It is *review-oriented* (a feedback surface on a
rendered document) rather than a persistent shared workspace. Its comment + raw
edit model overlaps with our `## Questions / Next steps` (comments) and the
Markdown sections (edits).

- **Adopt as optional review surface**: when a worksheet needs review-style
  feedback on a rendered document (writing/review task), pi-doc-review's Glimpse
  window is a good complement to the plain-Markdown worksheet loop. Our
  document-first mode already expects "the worksheet is the canonical home";
  pi-doc-review could be the *review renderer* on top of it.
- **Caution**: it's a separate feedback loop with its own comments/edits; we'd
  need to reconcile its output back into the worksheet (mirror comment → `## Q`
  item, edit → worksheet write under agent guard) to keep one canonical home. Not
  wired today; flagged as a future integration point, not a current dependency.

## Implication for the worksheet loop

1. **Borrow `queue_until_idle`** — the worksheet loop currently steers every save
   immediately; queueing edits during a busy agent (with compaction-aware
   dispatch) would reduce cancellation churn.
2. **Add explicit decision transitions** to `## Decisions` (``/### superseded by
   <id>``) and optionally sweep closed todo lists to an archive — mirroring
   Cairn.
3. **Keep pi-doc-review uninstalled for now** — optional review surface for an
   M4 writing/review validation run, reconciled back into the worksheet; not a
   dependency.