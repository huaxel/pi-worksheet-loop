# Section-aware update format — spec

Status: implemented (worksheet-loop.ts) and now formally specified.
Applies to: `pi/agent/extensions/worksheet-loop.ts` (watcher + steering).

## Goal

When a shared Markdown worksheet changes, Pi should receive *what changed and
what it means* — not the whole document. The full document stays on disk as the
source of truth; the steering message is a bounded, section-scoped delta with a
semantics layer so Pi can act without re-parsing a raw diff.

## The section model

A worksheet is parsed into **sections** by Markdown headings (`#{1,6}`). The
text before the first heading is the implicit `Document preamble` section.

```
type MarkdownSection = {
  key: string;    // "<normalized-heading>#<occurrence>"  e.g. "progress#0"
  heading: string; // original heading text, e.g. "## Progress"
  text: string;   // heading line + body
  body: string;   // body only (no heading line)
}
```

Keys use the normalized lowercase heading plus a zero-based occurrence counter
(`progress#0`, `progress#1`) to disambiguate repeated headings. These are
**structural keys** for diffing, not stable identities — stable block ids live
in the audit sidecar (`block-ids.json`) and are reconciled by content+heading
similarity (see the durable-audit design in DESIGN.md).

## Change detection

Given the previous and current file content:

1. Parse both into `Map<key, MarkdownSection>`.
2. A section is **changed** when its full `text` differs between revisions
   (added if absent before, removed if absent now, else changed).
3. Sections with identical text are skipped entirely — no diff work, no output.

Whitespace-only edits are caught earlier by a normalized hash (all whitespace
collapsed) and produce **no** steering event at all.

## Steering message shape

When at least one section changed, Pi receives a `sendUserMessage(..., {deliverAs:
"steer"})` with this shape:

```
[Worksheet update — <filename>]

Saved human changes in focused Markdown sections:
## <Heading> — <added|removed|changed>
<line-level diff: - removed / + added, capped at 80 lines>
(if > 12 changed sections: ... (N more changed sections))

Current section:
<heading line + body of the section as it is now>
...
[Semantics:
- ✓ completed: <todo text>
- ↻ reopened: <todo text>]

The full document remains at <filename>; read it if broader context is needed.
```

Constraints:

- At most **12 changed sections** are described; the remainder is summarized as
  a count.
- Each section's diff is capped at **80 changed lines** (`... (N more changed
  lines)`).
- The **current full section text** is included so Pi sees the post-edit state
  without an extra read when the change is small.
- The optional `Semantics:` block surfaces checkbox *transitions* (todo
  completed/reopened) explicitly, per the stable-semantics contract.

## Audit event schema

Each recorded revision appends one JSON line to `.worksheets/.history/<id>/events.jsonl`:

```
{
  revision:     "sha256(content)[:12]",
  parent:       "sha256(previous)[:12]" | null,
  actor:        "human" | "agent",
  sections:     string[],            // changed section keys
  ops:          string,              // bounded +/- line diff
  blocks:       string[],            // stable block ids whose body changed
  semantics:    string | undefined,  // "Semantics:" layer text, if any
  conversation: string,              // session file id
  turn:         number,              // turn counter
  ts:           string               // ISO timestamp
}
```

`parent` chains revisions so the log is a linked list of deltas over the
materialized worktree (Zed DeltaDB-style), and `blocks` links each revision to
the stable identities that changed.

## Design decisions

- **Markdown is the wire format, not a hidden protocol.** Sections are derived
  from visible Markdown headings; no HTML comments or metadata are injected.
- **The diff is bounded.** Whole-document sends are avoided; caps (12 sections,
  80 lines) keep the steering prompt small and the model's attention on the
  delta.
- **Semantics ride on top, not in place of, the diff.** The `Semantics:` layer
  is the machine-meaning call-out; the raw diff remains for inspection.
- **Block ids are out-of-band.** The visible Markdown never carries ids; stable
  identity is a sidecar concern (reconciled by similarity), so renames and
  reorders don't churn ids.
- **Full document remains authoritative.** The steering message points Pi at the
  file on disk for broader context; the section delta is a focused pointer, not
  a replacement.

## Known limits / future work

- Repeated identical headings disambiguate by occurrence order, which is
  fragile to reordering; stable block ids are the intended long-term anchor.
- Line-level diff within a section (common-prefix/suffix trimming) is a
  heuristic — interleaved small edits across many lines can exceed the cap and
  degrade to a count.
- The `Semantics:` layer currently detects todo transitions only; questions
  and comment routing are covered by the skill contract but not yet encoded as
  machine events. A checkbox item ending in `?` is a *question-todo* (tracked
  work whose content is a question) and counts as a todo, not an open question.
