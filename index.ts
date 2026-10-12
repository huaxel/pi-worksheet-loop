/**
 * Worksheet Loop — shared markdown task document for human↔agent collaboration.
 *
 * The agent creates a file in `.worksheets/ws-<epoch>-<id>-<slug>.md`, writes progress
 * into it, and re-reads it when the human edits it.  Normal chat still works too.
 *
 * Companion skill: SKILL.md (package root; injected into the system prompt
 * via before_agent_start).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

// ── pure block-identity core (module scope, unit-testable) ────────────────
// Marks a Markdown section with a stable id that survives edits, heading
// renames, block-shift/reordering, and rewrites within a section.  Ids are
// stored in a sidecar (`block-ids.json`) rather than in the visible Markdown.

// M3 attention routing directive, appended to the system prompt in
// document-first mode.  Keeps substantive responses canonical in the
// worksheet and the TUI a status/execution surface.
export const DOCUMENT_FIRST_DIRECTIVE = `You are in document-first mode. There is a shared Markdown worksheet that is the canonical home for substantive collaboration with the human.

Routing rules:
1. Keep findings, decisions, progress, and durable next steps in the worksheet (append under ## Findings, ## Decisions, ## Progress, or ## Questions / Next steps as appropriate). Do not reproduce the same full answer in both the TUI and the worksheet.
2. The TUI is a status/execution surface: use it for compact status, active tool/execution state, errors, blocking questions, and explicit interruptions. Keep TUI prose short and point at the worksheet for detail.
3. Answer a question as chat only when it is a quick clarification; if it deserves a documentable outcome, put the substantive answer in the worksheet and give a one-line pointer in the TUI.
4. When the human ticks or untick a checkbox, verify the claimed state and update the worksheet accordingly rather than replying expansively in the TUI.
5. Do not duplicate: one canonical home per piece of content.`;

/**
 * M3 attention routing — build the effective system prompt for a turn.
 * Appends the worksheet skill (if available), the attention-routing directive
 * (when document-first mode is on), and the session's active worksheet path.
 * Pure and unit-testable.
 */
export function buildSystemPrompt(
  base: string,
  opts: { documentFirst: boolean; skillContent: string; activeWorksheet?: string },
): string {
  let out = base;
  if (opts.skillContent) out += `\n\n${opts.skillContent}`;
  if (opts.documentFirst) out += `\n\n${DOCUMENT_FIRST_DIRECTIVE}`;
  if (opts.activeWorksheet) out += `\n\nActive worksheet: ${opts.activeWorksheet}`;
  return out;
}

/**
 * M3 attention routing — build the steering message for a saved worksheet
 * change.  In document-first mode the TUI gets a compact pointer (plus todo
 * transitions, which carry task-state meaning on their own); in normal mode
 * the full section diff is steered for inspection.  Pure and unit-testable.
 */
export function buildSteeringMessage(
  filename: string,
  changeSummary: string,
  semantics: string,
  documentFirst: boolean,
): string {
  if (documentFirst) {
    const base = `[Worksheet update — ${filename}] Saved changes. Read the worksheet for current state and next actions.`;
    return semantics ? `${base}\n${semantics}` : base;
  }
  const body = `[Worksheet update — ${filename}]\n\nSaved human changes in focused Markdown sections:\n${changeSummary}\n\nThe full document remains at ${filename}; read it if broader context is needed.`;
  return semantics ? `${body}\n${semantics}` : body;
}

export type BlockRecord = { id: string; heading: string; body: string };
export type BlockSection = { heading: string; body: string };

function worksheetHistoryRelativePath(filePath: string, cwd: string): string {
  return path.relative(cwd, path.resolve(filePath)).replace(/\.md$/i, "");
}

function worksheetHistorySlug(relativePath: string): string {
  return relativePath
    .replace(/[\\/]+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "worksheet";
}

/** Previous sidecar directory name, retained for one-time history migration. */
export function legacyWorksheetHistoryId(filePath: string, cwd = process.cwd()): string {
  return worksheetHistorySlug(worksheetHistoryRelativePath(filePath, cwd));
}

export function worksheetHistoryId(filePath: string, cwd = process.cwd()): string {
  const rel = worksheetHistoryRelativePath(filePath, cwd);
  const digest = crypto.createHash("sha256").update(rel).digest("hex").slice(0, 12);
  return `${worksheetHistorySlug(rel)}-${digest}`;
}

/** Move an existing unhashed sidecar into its collision-resistant directory. */
export function migrateWorksheetHistoryDirectory(
  historyRoot: string,
  legacyId: string,
  currentId: string,
): void {
  if (legacyId === currentId) return;
  const legacyPath = path.join(historyRoot, legacyId);
  const currentPath = path.join(historyRoot, currentId);
  if (!fs.existsSync(legacyPath) || fs.existsSync(currentPath)) return;
  try {
    fs.renameSync(legacyPath, currentPath);
  } catch {
    // Another process may have migrated it already; history writes are best-effort.
  }
}

export function isWorksheetPath(
  absPath: string,
  worksheetsRoot: string,
  attachedFiles: ReadonlySet<string> = new Set(),
): boolean {
  const normalizedPath = path.resolve(absPath);
  if (!normalizedPath.toLowerCase().endsWith(".md")) return false;
  if (attachedFiles.has(normalizedPath)) return true;
  const relative = path.relative(path.resolve(worksheetsRoot), normalizedPath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function normalizeBlockHeading(heading: string): string {
  return heading.toLowerCase().replace(/\s+/g, " ").trim();
}

function blockTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
}

/** Jaccard overlap of lowercase word tokens in [0, 1]. */
export function contentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = blockTokens(a);
  const tb = blockTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

/**
 * Reconcile current sections against previously persisted block ids.  Each
 * section is matched to the best unused existing block by heading match
 * (0.5) plus body similarity; a match preserves the id across edits,
 * renames, and reordering.  Unmatched sections get a fresh id (first save or
 * a genuinely new block).  Returns the reconciled records plus the ids whose
 * body changed this revision.
 */
export function reconcileBlockIds(
  existing: BlockRecord[],
  sections: BlockSection[],
  makeId: (heading: string, body: string) => string,
): { records: BlockRecord[]; changed: string[] } {
  const taken = new Set<string>();
  const records: BlockRecord[] = [];
  const changed: string[] = [];

  for (const section of sections) {
    const heading = normalizeBlockHeading(section.heading);
    let best: BlockRecord | null = null;
    let bestScore = 0;
    for (const cand of existing) {
      if (taken.has(cand.id)) continue;
      const sameHeading = normalizeBlockHeading(cand.heading) === heading ? 0.5 : 0;
      const score = sameHeading + contentSimilarity(cand.body, section.body);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best && bestScore >= 0.35) {
      taken.add(best.id);
      if (best.body !== section.body) changed.push(best.id);
      records.push({ id: best.id, heading: section.heading, body: section.body });
    } else {
      const id = makeId(heading, section.body);
      records.push({ id, heading: section.heading, body: section.body });
      changed.push(id); // a brand-new block counts as a content change
    }
  }
  return { records, changed };
}

// ── pure code-fence + section core (module scope, unit-testable) ──────────
// Markdown structure detection (headings, todos, questions) must ignore fenced
// code blocks: a `# comment` or `- [ ]` line inside a ``` fence is content,
// not structure.

/**
 * Line mask: true for lines that are part of a fenced code block (delimiters
 * included).  A fence opens with ``` or ~~~ (up to 3 leading spaces) and
 * closes on the next fence line of the same character.  An unclosed fence
 * masks to end of input.
 */
export function codeFenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let open: null | "`" | "~" = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (open === null) {
      if (m) {
        mask[i] = true;
        open = m[1][0] as "`" | "~";
      }
    } else {
      mask[i] = true;
      if (m && m[1][0] === open) open = null;
    }
  }
  return mask;
}

export type MarkdownSection = { key: string; heading: string; text: string; body: string };

/**
 * Split document content into Markdown sections keyed by lowercase heading
 * plus occurrence index (`heading#0`, `heading#1`, …).  The leading content
 * before the first heading is the `document preamble` section.  Heading
 * detection ignores fenced code blocks.
 */
export function markdownSections(content: string): Map<string, MarkdownSection> {
  const sections = new Map<string, MarkdownSection>();
  const lines = content.split(/\r?\n/);
  const masked = codeFenceMask(lines);
  let heading = "Document preamble";
  let headingLine = "";
  let body: string[] = [];
  const headingCounts = new Map<string, number>();

  const flush = (): void => {
    const baseKey = heading.toLowerCase();
    const occurrence = headingCounts.get(baseKey) ?? 0;
    headingCounts.set(baseKey, occurrence + 1);
    const key = `${baseKey}#${occurrence}`;
    const bodyText = body.join("\n");
    sections.set(key, {
      key,
      heading,
      text: headingLine ? `${headingLine}\n${bodyText}` : bodyText,
      body: bodyText,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = masked[i] ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2];
      headingLine = line;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

// ── pure todo-transition core (module scope, unit-testable) ────────────────
// Detects `- [ ]` / `- [x]` checkbox state changes that matter for steering,
// independent of the fs-bound markdownSections().  The contract (Markdown-
// native, no hidden HTML metadata) is documented in SKILL.md §8.

export type TodoItem = { state: "open" | "done"; text: string };
export type TodoTransition = { text: string; from: "open" | "done"; to: "open" | "done" };

const TODO_RE = /^\s*-\s*\[( |x|X)\s*\]\s*(.+)\s*$/;

/**
 * Extract checkbox lines by their text content, ignoring checkbox state.
 * Indented (nested) items match; lines inside fenced code blocks are ignored.
 */
export function todoItems(sectionBody: string): Map<string, TodoItem> {
  const lines = sectionBody.split(/\r?\n/);
  const masked = codeFenceMask(lines);
  const items = new Map<string, TodoItem>();
  for (let i = 0; i < lines.length; i++) {
    if (masked[i]) continue;
    const m = TODO_RE.exec(lines[i]);
    if (m) items.set(m[2].trim(), { state: m[1].toLowerCase() === "x" ? "done" : "open", text: m[2].trim() });
  }
  return items;
}

/** Determine which todo checkboxes changed state, and in which direction. */
export function todoTransitions(previous: string, current: string): TodoTransition[] {
  const before = todoItems(previous);
  const after = todoItems(current);
  const transitions: TodoTransition[] = [];
  for (const [text, item] of after) {
    const prev = before.get(text);
    if (prev && prev.state !== item.state) {
      transitions.push({ text, from: prev.state, to: item.state });
    }
  }
  return transitions;
}

// ── pure worksheet-state counts (module scope, unit-testable) ──────────────
// Counts open todos and unticked questions from worksheet content, used by the
// M3 compact footer status (the TUI shows counts; the worksheet holds meaning).

export function worksheetCounts(content: string): { openTodos: number; openQuestions: number } {
  const lines = content.split(/\r?\n/);
  const masked = codeFenceMask(lines);
  let openTodos = 0;
  let openQuestions = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (masked[i]) continue;
    const todo = /^\s*-\s*\[( |x|X)\s*\]\s*(.+)\s*$/.exec(line);
    if (todo) {
      if (todo[1].trim() === "") openTodos += 1;
      continue;
    }
    if (line.trim().endsWith("?")) openQuestions += 1;
  }
  return { openTodos, openQuestions };
}

export default function (pi: ExtensionAPI) {
  const WORKSHEETS_DIR = ".worksheets";
  const attachedFiles = new Set<string>();
  // Worksheet selection is process-local. Never infer it from the newest file:
  // parallel Pi sessions share .worksheets/ but must not steer each other.
  let activeWorksheet: string | null = null;

  // ── loop guard ──────────────────────────────────────────────────────────

  /** Stored content per file for loop prevention and human change summaries. */
  type FileState = { exact: string; norm: string; content: string };
  const fileState = new Map<string, FileState>();
  function fileHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /** Hash of the content with all whitespace collapsed (ignores formatting-only changes). */
  function normalizedHash(content: string): string {
    return crypto.createHash("sha256")
      .update(content.replace(/\s+/g, " ").trim())
      .digest("hex");
  }

  /**
   * Resolve a path to a stable identity for cross-boundary comparison.
   * fs.watch events on macOS report the canonical (symlink-resolved) path,
   * while tool inputs and user commands give the raw path (e.g. /var vs
   * /private/var under $TMPDIR).  Both must key to the same identity or the
   * guard, the file-state hashes, and the history ids silently desync.
   * Falls back to a plain resolve when the file does not exist yet.
   */
  function canonicalPath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }

  function rememberFile(filePath: string, content: string): void {
    fileState.set(canonicalPath(filePath), {
      exact: fileHash(content),
      norm: normalizedHash(content),
      content,
    });
  }

  /** Summarize the changed line range so deletions become visible to Pi. */
  function summarizeChange(previous: string | undefined, current: string): string {
    if (previous === undefined) return "(initial document state)";

    const before = previous.split(/\r?\n/);
    const after = current.split(/\r?\n/);
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) {
      start++;
    }

    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd--;
      afterEnd--;
    }

    const removed = before.slice(start, beforeEnd).map((line) => `- ${line}`);
    const added = after.slice(start, afterEnd).map((line) => `+ ${line}`);
    const changes = [...removed, ...added];
    const limit = 80;
    if (changes.length > limit) {
      return `${changes.slice(0, limit).join("\n")}\n... (${changes.length - limit} more changed lines)`;
    }
    return changes.length > 0 ? changes.join("\n") : "(content changed)";
  }

  /** Describe only the Markdown sections whose saved content changed. */
  function summarizeSections(previous: string | undefined, current: string): string {
    const before = markdownSections(previous ?? "");
    const after = markdownSections(current);
    const keys = [...new Set([...before.keys(), ...after.keys()])];
    const changed = keys.filter((key) => before.get(key)?.text !== after.get(key)?.text);
    if (changed.length === 0) return "(content changed outside a Markdown section)";

    const sections = changed.slice(0, 12).map((key) => {
      const oldSection = before.get(key);
      const newSection = after.get(key);
      const title = newSection?.heading ?? oldSection?.heading ?? "Unknown section";
      const status = !oldSection ? "added" : !newSection ? "removed" : "changed";
      const diff = summarizeChange(oldSection?.body, newSection?.body ?? "");
      const current = newSection?.text ?? "(section removed)";
      return `## ${title} — ${status}\n${diff}\n\nCurrent section:\n${current}`;
    });

    if (changed.length > sections.length) {
      sections.push(`... (${changed.length - sections.length} more changed sections)`);
    }
    return sections.join("\n\n");
  }

  // ── stable semantics for comments, questions, and todos ─────────────────
  //
  // Contract (Markdown-native; no hidden HTML metadata — see SKILL.md §8):
  //
  //   Comments: a `> ` blockquote is a direct comment from the human to Pi.
  //   The `## Human notes` section is human-owned; everything under it,
  //   including blockquotes, is input, never overwritten by Pi.  Pi replies
  //   land under `## Agent response` (append-only).
  //
  //   Questions: line items under `## Questions / Next steps` ending with `?`
  //   are steering asks.  An item is "open" when not marked done; marking it
  //   `- [ ] ...?` -> `- [x] ...?` closes it.  Deleting a question removes it
  //   from the active plan rather than silencing Pi.
  //
  //   Todos: `- [ ]` (open/work) and `- [x]` (done/claimed).  A checked todo
  //   is a completion claim to verify, not proof.  A transition to unchecked
  //   reopens the item; a checked-to-unchecked edit is a reopen.
  //
  // We detect the *transitions* that actually matter for steering and surface
  // them explicitly so Pi can instantiate the semantics without re-deriving
  // them from a raw diff.

  /**
   * Build a semantic layer over a change summary: surfaces todo transitions
   * explicitly so Pi doesn't have to parse raw checkboxes to act.
   */
  function semanticSummary(previous: string | undefined, current: string): string {
    const prev = previous ?? "";
    const notes: string[] = [];

    // Todo transitions across the whole doc.
    for (const [key, section] of markdownSections(current)) {
      if (/^todos#|^progress#|^questions \/ next steps#/.test(key)) {
        for (const t of todoTransitions(
          markdownSections(prev).get(key)?.body ?? "",
          section.body,
        )) {
          notes.push(t.to === "done" ? `✓ completed: ${t.text}` : `↻ reopened: ${t.text}`);
        }
      }
    }

    return notes.length > 0 ? `\n\nSemantics:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
  }

  // ── durable history sidecar + stable block identities ──────────────────
  //
  // Append-only audit log per worksheet:
  //   .worksheets/.history/<id>/events.jsonl   — revision event log
  //   .worksheets/.history/<id>/block-ids.json — stable block id map
  //
  // The human-facing Markdown stays the live view; the sidecar is the
  // materialized/durable state (Zed's DeltaDB ~append-only deltas over a
  // real worktree).  Block ids are reconciled across saves by content+
  // heading similarity so edits, heading renames, and section reordering do
  // NOT churn the ids, and the ids are kept OUT of the visible Markdown
  // (Zed's logical-anchors lesson: stable identities, not heading occurrence
  // keys).

  let currentConversation = "unknown";
  let currentTurn = 0;

  // Resolve at call time (not at extension load) so a cwd that differs at
  // load time cannot silently point the history root at the wrong place.
  function worksheetsRoot(): string {
    return path.resolve(WORKSHEETS_DIR);
  }
  function historyRoot(): string {
    return path.join(worksheetsRoot(), ".history");
  }

  function shortHash(hex: string): string {
    return hex.slice(0, 12);
  }

  function historyIdFor(filePath: string): string {
    return worksheetHistoryId(canonicalPath(filePath));
  }
  function historyDirFor(filePath: string): string {
    const currentId = historyIdFor(filePath);
    migrateWorksheetHistoryDirectory(historyRoot(), legacyWorksheetHistoryId(filePath), currentId);
    return path.join(historyRoot(), currentId);
  }
  function eventsPathFor(filePath: string): string {
    return path.join(historyDirFor(filePath), "events.jsonl");
  }
  function blockIdsPathFor(filePath: string): string {
    return path.join(historyDirFor(filePath), "block-ids.json");
  }

  function loadBlockRecords(filePath: string): BlockRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(blockIdsPathFor(filePath), "utf-8"));
      if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
    } catch {
      // first save
    }
    return [];
  }
  function saveBlockRecords(filePath: string, blocks: BlockRecord[]): void {
    try {
      fs.mkdirSync(historyDirFor(filePath), { recursive: true });
      fs.writeFileSync(
        blockIdsPathFor(filePath),
        JSON.stringify({ version: 1, blocks }, null, 2),
        "utf-8",
      );
    } catch {
      // storage is best-effort
    }
  }

  /**
   * Reconcile the saved revision against persisted block ids so identity
   * survives edits, renames, and reordering.  Returns the current block
   * records and the subset of ids whose content changed this revision.
   */
  function reconcileBlocks(filePath: string, current: Map<string, MarkdownSection>): {
    records: BlockRecord[];
    changed: string[];
  } {
    const existing = loadBlockRecords(filePath);
    const sections: BlockSection[] = [...current.values()].map((s) => ({
      heading: s.heading,
      body: s.body,
    }));
    const makeId = (heading: string, body: string): string => {
      const digest = crypto.createHash("sha256")
        .update(`${filePath}:${heading}:${body}`)
        .digest("hex");
      return `block-${shortHash(digest)}`;
    };
    const result = reconcileBlockIds(existing, sections, makeId);
    saveBlockRecords(filePath, result.records);
    return result;
  }

  function appendEventLine(filePath: string, event: Record<string, unknown>): void {
    try {
      fs.mkdirSync(historyDirFor(filePath), { recursive: true });
      fs.appendFileSync(eventsPathFor(filePath), JSON.stringify(event) + "\n", "utf-8");
    } catch {
      // audit log is best-effort
    }
  }

  function changedSectionKeys(previous: string | undefined, current: string): string[] {
    const before = markdownSections(previous ?? "");
    const after = markdownSections(current);
    const keys = [...new Set([...before.keys(), ...after.keys()])];
    return keys.filter((key) => before.get(key)?.text !== after.get(key)?.text);
  }

  /**
   * Persist the current save as an event (revision id, parent revision,
   * actor, changed sections, operation summary, conversation/turn id) and
   * reconcile stable block identities.  Returns the human-facing change
   * summary, or null when there is no meaningful change to surface.
   */
  function recordRevision(filePath: string, actor: "human" | "agent"): { changeSummary: string; semantic: string } | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.trim()) return null;
      const prev = fileState.get(canonicalPath(filePath));
      const exact = fileHash(content);
      if (prev && prev.exact === exact) return null; // no change
      const norm = normalizedHash(content);
      if (prev && prev.norm === norm) {
        rememberFile(filePath, content); // whitespace-only: don't log or steer
        return null;
      }

      const sections = changedSectionKeys(prev?.content, content);
      const ops = summarizeChange(prev?.content, content);
      const revision = shortHash(exact);
      const parent = prev ? shortHash(prev.exact) : null;
      const changeSummary = summarizeSections(prev?.content, content);
      // Surface todo check/uncheck transitions explicitly (the human-facing
      // semantics layer), if any, on top of the raw diff.
      const semantic = semanticSummary(prev?.content, content);
      const { changed } = reconcileBlocks(filePath, markdownSections(content));

      appendEventLine(filePath, {
        revision,
        parent,
        actor,
        sections,
        ops,
        blocks: changed,
        semantics: semantic.trim() || undefined,
        conversation: currentConversation,
        turn: currentTurn,
        ts: new Date().toISOString(),
      });

      rememberFile(filePath, content);
      return { changeSummary, semantic };
    } catch {
      return null;
    }
  }

  function isWorksheetPathForSession(absPath: string): boolean {
    return isWorksheetPath(absPath, worksheetsRoot(), attachedFiles);
  }

  // ── detect agent writes to .worksheets/ files ───────────────────────────
  //
  // Three-layer guard against re-injection loops:
  //   1. Process-local paths — set in tool_call (before the tool runs).
  //   2. Per-process filesystem sentinel — written on arm so OTHER pi
  //      processes (subagents) see which files are being written.
  //   3. Hash bookkeeping — on a guarded skip we still update the stored
  //      hash, so a later spurious fs.watch event (guard down) matches
  //      instead of injecting.
  //
  // Each process owns a different sentinel. A single shared sentinel lets
  // one process disarm another process's in-flight write. The timer is a
  // crash safety-net; normal completion removes only this process's paths.
  //
  // Bash commands that reference .worksheets arm a wildcard ("*") guard
  // covering every worksheet file: the target files are unknown, so any
  // worksheet write during the command window is treated as the agent's own.

  const SENTINEL_PREFIX = ".ws-lock-";
  const ANY_WORKSHEET = "*";
  const STALE_SENTINEL_MS = 30_000;
  const ANY_STALE_MS = 300_000; // bash commands may run long; timer is crash-only

  function sentinelPath(): string {
    return path.join(worksheetsRoot(), `${SENTINEL_PREFIX}${process.pid}`);
  }

  type WorksheetLockRecord = { pid: number; paths: string[] };

  function writeWorksheetSentinel(paths: Set<string>): void {
    const sentinel = sentinelPath();
    if (paths.size === 0) {
      try { fs.unlinkSync(sentinel); } catch { /* ignore */ }
      return;
    }
    try {
      fs.writeFileSync(
        sentinel,
        JSON.stringify({ pid: process.pid, paths: [...paths] } satisfies WorksheetLockRecord),
        "utf-8",
      );
    } catch { /* best effort */ }
  }

  function hasExternalWorksheetLock(targetPath: string): boolean {
    let entries: string[];
    try {
      entries = fs.readdirSync(worksheetsRoot());
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (!entry.startsWith(SENTINEL_PREFIX) || entry === path.basename(sentinelPath())) continue;
      const lockPath = path.join(worksheetsRoot(), entry);
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age >= STALE_SENTINEL_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
        const raw = fs.readFileSync(lockPath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<WorksheetLockRecord>;
        const identity = canonicalPath(targetPath);
        if (
          Array.isArray(parsed.paths) &&
          (parsed.paths.includes(ANY_WORKSHEET) ||
            parsed.paths.some((p) => canonicalPath(p) === identity))
        ) {
          return true;
        }
      } catch {
        // A lock being created or removed is treated as active for safety.
        return true;
      }
    }
    return false;
  }

  const worksheetGuard = {
    paths: new Set<string>(),
    timers: new Map<string, ReturnType<typeof setTimeout>>(),
    isActiveFor(targetPath: string): boolean {
      return this.paths.has(ANY_WORKSHEET) || this.paths.has(canonicalPath(targetPath));
    },
    arm(targetPath: string) {
      const normalizedPath = canonicalPath(targetPath);
      if (!targetPath || !isWorksheetPathForSession(normalizedPath)) return;
      this.setArmed(normalizedPath, STALE_SENTINEL_MS);
    },
    /** Arm the wildcard guard for any worksheet file (bash commands). */
    armAny() {
      this.setArmed(ANY_WORKSHEET, ANY_STALE_MS);
    },
    disarm(targetPath: string) {
      this.clearArmed(canonicalPath(targetPath));
    },
    disarmAny() {
      this.clearArmed(ANY_WORKSHEET);
    },
    setArmed(key: string, staleMs: number) {
      this.paths.add(key);
      const previousTimer = this.timers.get(key);
      if (previousTimer) clearTimeout(previousTimer);
      this.timers.set(key, setTimeout(() => {
        this.clearArmed(key);
      }, staleMs));
      writeWorksheetSentinel(this.paths);
    },
    clearArmed(key: string) {
      this.paths.delete(key);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
      writeWorksheetSentinel(this.paths);
    },
    reset() {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      this.paths.clear();
      writeWorksheetSentinel(this.paths);
    },
  };

  // tool_call has event.input; tool_execution_end does NOT (only result).
  // Track the armed target per toolCallId so disarm can run even though the
  // end event lacks the input fields.  For `write` tools we also keep the
  // expected post-write content hash so a concurrent edit that lands during
  // the write window is noticed instead of silently swallowed.
  type ArmedInfo = { path: string; expectedHash?: string };
  const armedPaths = new Map<string, ArmedInfo>();

  pi.on("tool_call", (event) => {
    if (!event.toolName || !["write", "edit", "bash"].includes(event.toolName)) return;
    const args = (event.input ?? {}) as Record<string, unknown>;
    if (event.toolName === "bash") {
      // Bash can write worksheets in ways we cannot target precisely; a
      // command that references .worksheets arms the wildcard guard for the
      // whole command window (disarmed on tool_execution_end).
      const command = typeof args.command === "string" ? args.command : "";
      if (command.includes(".worksheets")) {
        armedPaths.set(event.toolCallId, { path: ANY_WORKSHEET });
        worksheetGuard.armAny();
      }
      return;
    }
    const targetPath = (args.path ?? args.file ?? "") as string;
    if (targetPath && isWorksheetPathForSession(path.resolve(targetPath))) {
      const expectedContent = typeof args.content === "string" ? args.content : undefined;
      armedPaths.set(event.toolCallId, {
        path: canonicalPath(targetPath),
        expectedHash: expectedContent === undefined ? undefined : fileHash(expectedContent),
      });
      worksheetGuard.arm(targetPath);
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (!event.toolName || !["write", "edit", "bash"].includes(event.toolName)) return;
    const armed = armedPaths.get(event.toolCallId);
    if (!armed) return;
    armedPaths.delete(event.toolCallId);

    if (armed.path === ANY_WORKSHEET) {
      // Bash may have touched any worksheet; disarm and refresh stored
      // hashes so a post-window fs.watch event cannot re-inject the agent's
      // own write.  A human edit inside the window is suppressed
      // (undistinguishable from the agent's write) — see FAILURE-MODES.md.
      worksheetGuard.disarmAny();
      const targets = activeWorksheet ? [activeWorksheet, ...attachedFiles] : [...attachedFiles];
      for (const filePath of targets) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          if (content.trim()) rememberFile(filePath, content);
        } catch { /* raced */ }
      }
      return;
    }

    worksheetGuard.disarm(armed.path);
    // Record the agent's own write in the audit log.  Recording is
    // distinct from steering: we log actor "agent" but never re-inject
    // the change as a worksheet update.  This also refreshes the stored
    // hash, so a later spurious fs.watch event cannot re-inject it.
    recordRevision(armed.path, "agent");
    if (armed.expectedHash !== undefined) {
      try {
        const disk = fs.readFileSync(armed.path, "utf-8");
        if (fileHash(disk) !== armed.expectedHash) {
          pi.sendUserMessage(
            `[Worksheet update — ${path.basename(armed.path)}] The file changed again while the agent's write was landing; the current state on disk is authoritative. Re-read the worksheet before continuing.`,
            { deliverAs: "steer" },
          );
        }
      } catch { /* raced — file may have been removed */ }
    }
  });

  // ── load skill each turn ────────────────────────────────────────────
  //
  // Resolve SKILL.md next to this extension file (package root), strip YAML
  // frontmatter, and inject into the system prompt each turn.  Loaded once
  // and cached; Pi's native skill system only advertises the skill (name +
  // description + path), so this full-content injection is not duplicated.

  const skillPath = path.resolve(__dirname, "SKILL.md");
  let cachedSkillContent: string | null = null;

  function loadSkillContent(): string {
    if (cachedSkillContent !== null) return cachedSkillContent;
    try {
      let raw = fs.readFileSync(skillPath, "utf-8");
      // Strip YAML frontmatter (---\n...\n---)
      raw = raw.replace(/^---[\s\S]*?---\n*/, "");
      cachedSkillContent = raw.trim();
    } catch {
      cachedSkillContent = "";
    }
    return cachedSkillContent;
  }

  pi.on("before_agent_start", (event) => {
    // `systemPrompt` is a getter in current Pi releases. Return the supported
    // hook result instead of mutating the event object.
    const active = activeWorksheet
      ? path.relative(process.cwd(), activeWorksheet) || activeWorksheet
      : undefined;
    const next = buildSystemPrompt(event.systemPrompt, {
      documentFirst,
      skillContent: loadSkillContent(),
      activeWorksheet: active,
    });
    if (next === event.systemPrompt) return;
    return { systemPrompt: next };
  });

  // ── watch .worksheets/ for human edits ──────────────────────────────────

  let watcherPaused = false;
  // M3 document-first mode: when on, Pi routes substantive responses to the
  // worksheet (canonical home) and keeps the TUI a status/execution surface.
  // Default: on when a worksheet exists, off otherwise.
  let documentFirst = false;
  // Explicit /worksheet mode selection survives a session reload (which
  // recomputes the default); null means "use the default".
  let modeOverride: boolean | null = null;
  let closeWatcher: (() => void) | null = null;
  let rescanWatcher: (() => void) | null = null;
  let attachWatcher: ((filePath: string) => boolean) | null = null;

  pi.on("session_start", (_event, ctx) => {
    const worksheetsAbs = worksheetsRoot();
    currentConversation = ctx.sessionManager.getSessionFile() ?? "unknown";
    currentTurn = 0;
    // Do not auto-select the newest project worksheet. Another Pi session may
    // own it; selection happens explicitly via start, attach, or open. Preserve
    // an explicit selection if session_start is emitted again during reload.
    documentFirst = modeOverride ?? activeWorksheet !== null;

    // A reload can emit session_start more than once. Close the old watcher
    // first so edits are never delivered twice.
    closeWatcher?.();

    // Seed hashes for any existing files so we don't re-inject them
    seedExistingHashes(worksheetsAbs);

    // Ensure the directory exists so fs.watch has something to latch onto
    if (!fs.existsSync(worksheetsAbs)) {
      fs.mkdirSync(worksheetsAbs, { recursive: true });
    }

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const fileWatchers = new Map<string, fs.FSWatcher>();

    const processChange = (filePath: string): void => {
      if (watcherPaused) return;
      // Watcher events may carry the canonical path while activeWorksheet /
      // attachedFiles were set from raw (possibly non-canonical) paths;
      // compare canonical identities.
      const identity = canonicalPath(filePath);
      const activeIdentity = activeWorksheet ? canonicalPath(activeWorksheet) : null;
      const isTracked =
        identity === activeIdentity ||
        [...attachedFiles].some((f) => canonicalPath(f) === identity);
      if (!isTracked) return;
      const filename = path.relative(process.cwd(), filePath) || path.basename(filePath);

      // Guarded: an agent (this process or another) is writing. Skip
      // injection, but refresh the stored hash so a later fs.watch event
      // cannot re-inject the agent's own write.
      if (
        worksheetGuard.isActiveFor(identity) ||
        hasExternalWorksheetLock(identity)
      ) {
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          if (content.trim()) {
            rememberFile(filePath, content);
          }
        } catch { /* raced */ }
        return;
      }

      const previousTimer = debounceTimers.get(identity);
      if (previousTimer) clearTimeout(previousTimer);
      debounceTimers.set(identity, setTimeout(() => {
        debounceTimers.delete(identity);
        if (watcherPaused) return;
        try {
          const revision = recordRevision(filePath, "human");
          if (!revision) return;
          // M3 attention routing: in document-first mode the TUI gets a compact
          // pointer (plus todo transitions) and the worksheet carries the detail
          // (no duplication).
          pi.sendUserMessage(
            buildSteeringMessage(filename, revision.changeSummary, revision.semantic, documentFirst),
            { deliverAs: "steer" },
          );
          setWorksheetStatus(ctx);
        } catch {
          // raced — file may have been removed
        }
      }, 400));
    };

    const scheduleAllFiles = (): void => {
      try {
        if (activeWorksheet) processChange(activeWorksheet);
        for (const filePath of attachedFiles) processChange(filePath);
      } catch {
        // directory may have been removed during reload
      }
    };

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(worksheetsAbs, (_eventType, filename) => {
        const name = filename?.toString();
        if (name?.endsWith(".md")) processChange(path.join(worksheetsAbs, name));
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) {
        ctx.ui.notify(`📄 worksheet watcher unavailable: ${detail}`, "warning");
      }
      return;
    }

    const watchAttachedFile = (filePath: string): boolean => {
      if (!filePath.endsWith(".md") || !fs.existsSync(filePath)) return false;
      attachedFiles.add(filePath);
      if (!fileWatchers.has(filePath)) {
        fileWatchers.set(filePath, fs.watch(filePath, () => processChange(filePath)));
        try {
          rememberFile(filePath, fs.readFileSync(filePath, "utf-8"));
        } catch {
          // file may have disappeared between existsSync and readFileSync
        }
      }
      return true;
    };

    for (const filePath of attachedFiles) watchAttachedFile(filePath);
    attachWatcher = watchAttachedFile;
    rescanWatcher = scheduleAllFiles;
    closeWatcher = () => {
      watcher.close();
      for (const fileWatcher of fileWatchers.values()) fileWatcher.close();
      fileWatchers.clear();
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      if (rescanWatcher === scheduleAllFiles) rescanWatcher = null;
      attachWatcher = null;
      closeWatcher = null;
    };

    if (ctx.hasUI) {
      const state = watcherPaused ? "paused" : "watching";
      ctx.ui.notify(`📄 ${state} ${WORKSHEETS_DIR}/`, "info");
      setWorksheetStatus(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    worksheetGuard.reset();
    closeWatcher?.();
    closeWatcher = null;
    rescanWatcher = null;
    currentConversation = "unknown";
    currentTurn = 0;
    activeWorksheet = null;
    modeOverride = null;
  });

  // Track actor context: conversation/turn identity for the audit log.
  pi.on("turn_start", (_event, ctx) => {
    currentTurn += 1;
    if (currentConversation === "unknown") {
      currentConversation = ctx.sessionManager.getSessionFile() ?? "unknown";
    }
  });

  function seedExistingHashes(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir)) {
        const p = path.join(dir, entry);
        if (entry.endsWith(".md") && fs.statSync(p).isFile()) {
          const content = fs.readFileSync(p, "utf-8");
          rememberFile(p, content);
        }
      }
    } catch {
      // directory doesn't exist yet — fine
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  type WorksheetFile = { name: string; filePath: string; mtime: number };

  function worksheetFiles(): WorksheetFile[] {
    try {
      const dir = worksheetsRoot();
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => {
          const filePath = path.join(dir, name);
          return { name, filePath, mtime: fs.statSync(filePath).mtimeMs };
        })
        .filter((file) => fs.statSync(file.filePath).isFile())
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  function readWorksheetCounts(filePath: string): { openTodos: number; openQuestions: number } {
    try {
      return worksheetCounts(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // unreadable/missing — report zero
      return { openTodos: 0, openQuestions: 0 };
    }
  }

  /**
   * M3: compact worksheet status in the footer (via setStatus).  Shows the
   * watcher state, the active worksheet, and open todo/question counts as a
   * document pointer — the TUI stays a status view while the worksheet holds
   * the substantive state.
   */
  function setWorksheetStatus(ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined): void {
    if (!ctx?.ui?.setStatus) return;
    const ws = activeWorksheet;
    if (!ws) {
      ctx.ui.setStatus("worksheet", `${watcherPaused ? "⏸" : "📄"} no worksheets${documentFirst ? " · doc" : ""}`);
      return;
    }
    const counts = readWorksheetCounts(ws);
    const name = path.basename(ws).replace(/\.md$/i, "");
    const parts = [
      watcherPaused ? "⏸" : "📄",
      documentFirst ? "doc" : "chat",
      name,
      `${counts.openTodos} todo${counts.openTodos === 1 ? "" : "s"}`,
      `${counts.openQuestions} q`,
    ];
    ctx.ui.setStatus("worksheet", parts.join(" · "));
  }

  function requestedWorksheet(name: string): string | null {
    const dir = worksheetsRoot();
    const candidate = path.resolve(dir, name);
    const relative = path.relative(dir, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !candidate.endsWith(".md")) {
      return null;
    }
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
  }

  /** Turn arbitrary text into a short kebab-case slug. */
  function slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  }

  /** Local date stamp like `2026-07-27 14:30`. */
  function dateStamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Build a collision-resistant path for a new worksheet. */
  function worksheetPath(slug: string): string {
    const stamp = Date.now();
    const suffix = crypto.randomBytes(4).toString("hex");
    return path.resolve(WORKSHEETS_DIR, `ws-${stamp}-${suffix}-${slug}.md`);
  }

  /** Render the standard worksheet template. */
  function worksheetTemplate(title: string, task: string): string {
    return `# ${title} — ${dateStamp()}

## Task
${task}

## Human notes
<!-- Add goals, constraints, feedback, or a requested action here. -->

## Todos
- [ ] Define the next concrete step

## Progress
- Started

## Findings

## Decisions

## Questions / Next steps

`;
  }

  /**
   * Open a worksheet file in a new herdr split running nvim.
   * Fire-and-forget: herdr pane run returns immediately.
   * Falls back to printing instructions if herdr/nvim is unavailable.
   */
  async function openInSplit(
    wsPath: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const rel = path.relative(process.cwd(), wsPath);
    try {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync(
        "herdr",
        ["pane", "split", "--direction", "right", "--cwd", process.cwd(), "--focus"],
        { timeout: 5000, encoding: "utf-8" },
      );
      const parsed = JSON.parse(out) as {
        result?: { pane?: { pane_id?: string } };
      };
      const newPaneId = parsed.result?.pane?.pane_id ?? "";
      if (newPaneId) {
        execFileSync("herdr", ["pane", "run", newPaneId, "nvim", wsPath], {
          timeout: 5000,
        });
        ctx.ui.notify(`📄 ${path.basename(wsPath)} opened in split`, "info");
      } else {
        ctx.ui.notify(`📄 ${rel} (open with: nvim "${rel}")`, "info");
      }
    } catch {
      ctx.ui.notify(
        `📄 ${rel}\n  Split: herdr pane split --direction right --focus\n  Then:  nvim "${rel}"`,
        "info",
      );
    }
  }

  // ── commands ────────────────────────────────────────────────────────────

  // Subcommand list shared between autocomplete and the usage hint.
  const SUBCOMMANDS: { value: string; label: string; description: string }[] = [
    { value: "start", label: "start", description: "Create a new worksheet and open it in a split" },
    { value: "attach", label: "attach", description: "Watch an existing Markdown file" },
    { value: "list", label: "list", description: "List project worksheets" },
    { value: "search", label: "search", description: "Search project worksheets" },
    { value: "open", label: "open", description: "Open a worksheet in a split" },
    { value: "path", label: "path", description: "Show a worksheet path" },
    { value: "status", label: "status", description: "Show watcher status and latest worksheet" },
    { value: "pause", label: "pause", description: "Pause the worksheet loop" },
    { value: "resume", label: "resume", description: "Resume and scan for worksheet changes" },
    { value: "mode", label: "mode", description: "Set document-first mode: on|off|status" },
  ];

  pi.registerCommand("worksheet", {
    description: "Control the worksheet loop. Subcommands: start, attach, list, search, open, path, status, pause, resume, mode",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const filtered = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      const sub = (cmd || "").toLowerCase();

      // ── /worksheet start [slug] ────────────────────────────────────────
      // Create a new worksheet from the standard template and open it in a
      // split.  Slug is taken from the args, or prompted for if missing.
      if (sub === "start" || sub === "new" || sub === "create") {
        let slug = rest.join(" ").trim();
        if (!slug) {
          const prompted = await ctx.ui.input(
            "Worksheet slug (kebab-case):",
            "fix-auth",
          );
          if (prompted === undefined) {
            ctx.ui.notify("Cancelled", "info");
            return;
          }
          slug = prompted.trim();
        }
        slug = slugify(slug);
        if (!slug) {
          ctx.ui.notify("Invalid slug — use letters/numbers", "warning");
          return;
        }

        const wsPath = worksheetPath(slug);
        const title = slug
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
        // The real task comes from the chat conversation; leave a placeholder
        // the agent fills in on its first turn (see SKILL.md).
        const task = "<what the human asked>";

        try {
          fs.mkdirSync(worksheetsRoot(), { recursive: true });
          fs.writeFileSync(wsPath, worksheetTemplate(title, task), { encoding: "utf-8", flag: "wx" });
          // Seed the hash so the agent's own create doesn't trigger injection.
          const content = fs.readFileSync(wsPath, "utf-8");
          rememberFile(wsPath, content);
          activeWorksheet = canonicalPath(wsPath);
          documentFirst = true;
        } catch (err) {
          ctx.ui.notify(`Failed to create worksheet: ${(err as Error).message}`, "error");
          return;
        }

        const rel = path.relative(process.cwd(), wsPath);
        ctx.ui.notify(`📄 Created ${rel}`, "info");
        setWorksheetStatus(ctx);
        await openInSplit(wsPath, ctx);
        return;
      }

      // ── /worksheet attach <path> ────────────────────────────────────────
      if (sub === "attach") {
        const target = rest.join(" ").trim();
        if (!target) {
          ctx.ui.notify("Usage: /worksheet attach path/to/document.md", "warning");
          return;
        }
        const filePath = path.resolve(target);
        if (!filePath.endsWith(".md")) {
          ctx.ui.notify("Only Markdown files can be attached", "warning");
          return;
        }
        if (!attachWatcher?.(filePath)) {
          ctx.ui.notify(`Cannot attach missing file: ${target}`, "warning");
          return;
        }
        activeWorksheet = canonicalPath(filePath);
        documentFirst = true;
        ctx.ui.notify(`📎 Attached ${path.relative(process.cwd(), filePath)}`, "info");
        setWorksheetStatus(ctx);
        return;
      }

      // ── /worksheet list ────────────────────────────────────────────────
      if (sub === "list") {
        const files = worksheetFiles();
        if (files.length === 0) {
          ctx.ui.notify("No worksheets found in .worksheets/", "warning");
          return;
        }
        const listing = files
          .map((file, index) => `  ${index + 1}. ${file.name}`)
          .join("\n");
        ctx.ui.notify(`📚 Worksheets\n${listing}`, "info");
        return;
      }

      // ── /worksheet search <query> ──────────────────────────────────────
      if (sub === "search") {
        const query = rest.join(" ").trim().toLowerCase();
        if (!query) {
          ctx.ui.notify("Usage: /worksheet search <text>", "warning");
          return;
        }
        const matches: string[] = [];
        for (const file of worksheetFiles()) {
          try {
            const lines = fs.readFileSync(file.filePath, "utf-8").split(/\r?\n/);
            lines.forEach((line, lineIndex) => {
              if (line.toLowerCase().includes(query) && matches.length < 40) {
                matches.push(`  ${file.name}:${lineIndex + 1}: ${line.trim()}`);
              }
            });
          } catch {
            // file may have disappeared during the search
          }
        }
        ctx.ui.notify(
          matches.length > 0
            ? `🔎 Worksheets matching “${query}”\n${matches.join("\n")}`
            : `No worksheet matches for “${query}”`,
          matches.length > 0 ? "info" : "warning",
        );
        return;
      }

      // ── /worksheet open|path [name] ────────────────────────────────────
      if (sub === "open" || sub === "path") {
        const requested = rest.join(" ").trim();
        const ws = requested ? requestedWorksheet(requested) : activeWorksheet;
        if (!ws) {
          ctx.ui.notify("Worksheet not found — try /worksheet list or /worksheet start", "warning");
          return;
        }
        const rel = path.relative(process.cwd(), ws);

        if (sub === "path") {
          ctx.ui.notify(`📄 ${rel}`, "info");
          return;
        }

        activeWorksheet = canonicalPath(ws);
        documentFirst = true;
        if (attachWatcher) attachWatcher(ws);
        await openInSplit(ws, ctx);
        return;
      }

      // ── /worksheet pause|off ───────────────────────────────────────────
      if (sub === "off" || sub === "pause") {
        watcherPaused = true;
        ctx.ui.notify("⏸ Worksheet loop paused", "info");
        setWorksheetStatus(ctx);
        return;
      }

      // ── /worksheet resume|on ───────────────────────────────────────────
      if (sub === "on" || sub === "resume") {
        watcherPaused = false;
        rescanWatcher?.();
        ctx.ui.notify("▶ Worksheet loop resumed", "info");
        setWorksheetStatus(ctx);
        return;
      }

      // ── /worksheet mode on|off|status ─────────────────────────────────
      if (sub === "mode") {
        const choice = rest.join(" ").trim().toLowerCase();
        if (choice === "on") {
          modeOverride = true;
          documentFirst = true;
          ctx.ui.notify("📄 Document-first mode ON — substantive answers go to the worksheet", "info");
        } else if (choice === "off") {
          modeOverride = false;
          documentFirst = false;
          ctx.ui.notify("💬 Normal chat mode ON — TUI carries the full answer", "info");
        } else {
          ctx.ui.notify(
            `Document-first mode is ${documentFirst ? "ON" : "OFF"}. Usage: /worksheet mode on|off`,
            "info",
          );
        }
        setWorksheetStatus(ctx);
        return;
      }

      // ── /worksheet status ──────────────────────────────────────────────
      if (sub === "status") {
        const latest = activeWorksheet;
        const state = watcherPaused ? "paused" : "watching";
        const attached = attachedFiles.size > 0
          ? ` — attached: ${attachedFiles.size}`
          : "";
        const info = latest
          ? `${state} ${worksheetsRoot()}/ — latest: ${path.basename(latest)}${attached}`
          : `${state} ${worksheetsRoot()}/ — no worksheets yet${attached}`;
        ctx.ui.notify(info, "info");
        return;
      }

      // ── usage ──────────────────────────────────────────────────────────
      const usage = SUBCOMMANDS.map((s) => `  ${s.value.padEnd(7)} ${s.description}`).join("\n");
      ctx.ui.notify(`Usage: /worksheet {subcommand}\n${usage}`, "info");
    },
  });
}
