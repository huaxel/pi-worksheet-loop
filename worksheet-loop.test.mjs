// Behavioral tests for the pure core of index.ts (block identity, prompt/
// steering builders, section/todo parsing, history ids).
// Run: node worksheet-loop.test.mjs (or npm test) — requires Node >= 22.7.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { worksheet } from "./worksheet-test-source.mjs";

const { reconcileBlockIds, contentSimilarity, todoItems, todoTransitions, worksheetCounts, worksheetHistoryId, legacyWorksheetHistoryId, migrateWorksheetHistoryDirectory, isWorksheetPath, codeFenceMask, markdownSections, buildSystemPrompt, buildSteeringMessage, DOCUMENT_FIRST_DIRECTIVE } = worksheet;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const seqId = (() => {
  let n = 0;
  return () => `block-${++n}`;
})();

const sec = (heading, body) => ({ heading, body });
const ids = (records) => records.map((r) => r.id);

// First save: every section gets a fresh id.
{
  const { records, changed } = reconcileBlockIds(
    [],
    [sec("Progress", "did a thing"), sec("Decisions", "chose the approach")],
    seqId,
  );
  assert(ids(records).length === 2, "first save creates two ids");
  assert(changed.length === 2, "first save records both blocks as changed");
}

// Stable identity across an in-place edit: id preserved, marked changed.
{
  const first = reconcileBlockIds(
    [],
    [sec("Progress", "did a thing")],
    seqId,
  ).records;
  const { records, changed } = reconcileBlockIds(
    first,
    [sec("Progress", "did a thing and fixed the bug")],
    seqId,
  );
  assert(records[0].id === first[0].id, "in-place edit keeps the block id");
  assert(changed.length === 1, "an edited block is marked changed");
}

// Heading rename keeps the id (body similarity dominates).
{
  const first = reconcileBlockIds(
    [],
    [sec("## Progress", "we shipped milestones steadily together")],
    seqId,
  ).records;
  const { records } = reconcileBlockIds(
    first,
    [sec("## Milestones", "we shipped milestones steadily together")],
    seqId,
  );
  assert(records[0].id === first[0].id, "heading rename keeps the block id");
}

// Section reordering keeps ids but preserves pairwise identity.
{
  const first = reconcileBlockIds(
    [],
    [sec("A", "alpha content"), sec("B", "beta content")],
    seqId,
  ).records;
  const { records } = reconcileBlockIds(
    first,
    [sec("B", "beta content"), sec("A", "alpha content")],
    seqId,
  );
  assert(records[0].id === first[1].id && records[1].id === first[0].id, "reorder preserves pairwise ids");
}

// Deleting a section and adding an unrelated one gives a fresh id, not a collision.
{
  const first = reconcileBlockIds(
    [],
    [sec("Keep", "alpha content"), sec("Remove", "beta content")],
    seqId,
  ).records;
  const { records } = reconcileBlockIds(
    first,
    [sec("Keep", "alpha content"), sec("BrandNew", "totally unrelated thing here")],
    seqId,
  );
  assert(records[0].id === first[0].id, "unchanged section keeps its id");
  assert(!ids(records).includes(first[1].id), "a genuinely new section gets a new id");
}

// contentSimilarity is symmetric and exact-match is 1.
assert(contentSimilarity("a b c", "a b c") === 1, "identical content scores 1");
assert(contentSimilarity("a b c", "a b") > contentSimilarity("a b c", "x y z"), "related content outranks unrelated");

// Worksheet paths stay inside the configured root unless explicitly attached.
{
  const root = "/repo/.worksheets";
  assert(isWorksheetPath("/repo/.worksheets/ws-a.md", root), "worksheet under configured root is accepted");
  assert(!isWorksheetPath("/tmp/.worksheets/ws-a.md", root), "unrelated .worksheets directory is rejected");
  assert(!isWorksheetPath("/repo/.worksheets-other/ws-a.md", root), "similarly named sibling directory is rejected");
  assert(isWorksheetPath("/tmp/notes.md", root, new Set(["/tmp/notes.md"])), "explicitly attached markdown is accepted");
  assert(worksheetHistoryId("/repo/a-b/c.md") !== worksheetHistoryId("/repo/a/b-c.md"), "different paths with colliding slugs get distinct history IDs");
  for (const filePath of ["/repo/a/b-c.md", "/repo/a//b...c.md", "/repo/ümlaut/name.md"]) {
    const relative = path.relative("/repo", path.resolve(filePath)).replace(/\.md$/i, "");
    const expectedLegacyId = relative
      .replace(/[\\/]+/g, "-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "worksheet";
    assert(legacyWorksheetHistoryId(filePath, "/repo") === expectedLegacyId, "legacy ID exactly matches the old slug algorithm");
  }
}

{
  const root = mkdtempSync(path.join(tmpdir(), "worksheet-history-migration-"));
  try {
    const oldId = legacyWorksheetHistoryId("/repo/.worksheets/ws-test.md", "/repo");
    const newId = worksheetHistoryId("/repo/.worksheets/ws-test.md", "/repo");
    const oldDir = path.join(root, oldId);
    mkdirSync(oldDir);
    writeFileSync(path.join(oldDir, "block-ids.json"), '{"blocks":[]}');
    migrateWorksheetHistoryDirectory(root, oldId, newId);
    assert(!existsSync(oldDir), "legacy history directory is moved");
    assert(readFileSync(path.join(root, newId, "block-ids.json"), "utf8") === '{"blocks":[]}', "legacy sidecar contents survive migration");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── todo-transition semantics ──────────────────────────────────────────────

// todoItems extracts checkbox state by text content.
{
  const items = todoItems("- [ ] open task\n- [x] done task\n- plain line\n- [X] uppercase");
  assert(items.get("open task")?.state === "open", "unchecked todo parsed as open");
  assert(items.get("done task")?.state === "done", "checked todo parsed as done");
  assert(items.get("uppercase")?.state === "done", "uppercase X parsed as done");
  assert(!items.has("plain line"), "non-checkbox lines are ignored");
}

// Transition open -> done is a completion claim.
{
  const t = todoTransitions("- [ ] fix the bug", "- [x] fix the bug");
  assert(t.length === 1 && t[0].from === "open" && t[0].to === "done", "open->done is a completion");
}

// Transition done -> open is a reopen.
{
  const t = todoTransitions("- [x] fix the bug", "- [ ] fix the bug");
  assert(t.length === 1 && t[0].from === "done" && t[0].to === "open", "done->open is a reopen");
}

// Unchanged and newly-added todos are not transitions.
{
  const t = todoTransitions("- [ ] a\n- [x] b", "- [ ] a\n- [x] b\n- [ ] c");
  assert(t.length === 0, "no state change yields no transition (additions ignored)");
}

// Text edits that also change state are still a transition on the same item.
{
  const t = todoTransitions("- [ ] write docs", "- [x] write docs completely");
  assert(t.length === 0 || t[0].from === "open", "renamed+checked item at worst reports open->done");
}

// ── worksheet-state counts (M3 footer status) ─────────────────────────────

{
  const c = worksheetCounts("## Todos\n- [ ] open one\n- [x] done one\n## Questions\n- Should we?\n- plain line\n");
  assert(c.openTodos === 1, "open todos counted");
  assert(c.openQuestions === 1, "open questions counted");
}
{
  const c = worksheetCounts("- [X] done uppercase\n- [ ] open\n- [ ] another\n- ends with ?\n- [ ] checkbox ending?\n");
  assert(c.openTodos === 3, "3 open todos (uppercase X not counted open; checkbox question is a todo not a question)");
  assert(c.openQuestions === 1, "bare '?' line counted as a question; checkbox '?' is a todo");
}

// Indented (nested) todos are counted and transitioned like top-level ones.
{
  const c = worksheetCounts("## Todos\n- [ ] top\n  - [ ] nested open\n  - [x] nested done\n");
  assert(c.openTodos === 2, "nested open todos counted (2 open)");
}
{
  const t = todoTransitions("  - [ ] nested task", "  - [x] nested task");
  assert(t.length === 1 && t[0].from === "open" && t[0].to === "done", "nested todo flip is a completion");
}

// ── code-fence masking (structure inside fences is content) ─────────────────

{
  const mask = codeFenceMask([
    "before",
    "```bash",
    "# not a heading",
    "- [ ] not a todo",
    "```",
    "# real heading",
  ]);
  assert(mask.join(",") === "false,true,true,true,true,false", "fence delimiters and body masked");
}
{
  // A different fence character inside a fence does not close it.
  const mask = codeFenceMask(["```", "~~~", "~~~", "```", "after"]);
  assert(mask.join(",") === "true,true,true,true,false", "tilde inside backtick fence stays masked");
}
{
  // Unclosed fence masks to end of input.
  const mask = codeFenceMask(["```", "x", "y"]);
  assert(mask.every(Boolean), "unclosed fence masks remaining lines");
}

// Headings, todos, and question lines inside fences are not structure.
{
  const sections = markdownSections("# Real\ntext\n```\n# Fenced\n- [ ] fake todo\nends?\n```\n# After\ndone");
  const keys = [...sections.keys()];
  const real = keys.filter((k) => k !== "document preamble#0");
  assert(real.length === 2, "fenced '#' does not split sections (2 real sections)");
  assert(real[0] === "real#0" && real[1] === "after#0", "fenced content stays in the preceding section");
  assert(sections.get("real#0").body.includes("# Fenced"), "fenced lines remain section body");
}
{
  const c = worksheetCounts("```\n# Title?\n- [ ] fake?\nx?\n```\n- [ ] real open\n");
  assert(c.openTodos === 1, "fenced todos not counted");
  assert(c.openQuestions === 0, "fenced '?' lines not counted as questions");
}
{
  const items = todoItems("```\n- [ ] fenced\n```\n- [ ] live");
  assert(!items.has("fenced"), "fenced checkbox not a todo");
  assert(items.get("live")?.state === "open", "unfenced checkbox is a todo");
}

// ── system prompt + steering message builders ───────────────────────────────

{
  // No additions: base returned unchanged (handler skips the override).
  assert(
    buildSystemPrompt("base", { documentFirst: false, skillContent: "" }) === "base",
    "empty options leave the base prompt untouched",
  );
  // All additions, in documented order: skill, directive, active worksheet.
  const out = buildSystemPrompt("base", {
    documentFirst: true,
    skillContent: "SKILL",
    activeWorksheet: ".worksheets/ws-1-abcd-fix-auth.md",
  });
  assert(
    out === `base\n\nSKILL\n\n${DOCUMENT_FIRST_DIRECTIVE}\n\nActive worksheet: .worksheets/ws-1-abcd-fix-auth.md`,
    "skill, directive, and active worksheet appended in order",
  );
}
{
  // Document-first: compact pointer, no diff, but todo transitions kept.
  const semantics = "\n\nSemantics:\n- ✓ completed: fix the bug";
  const doc = buildSteeringMessage("ws-1.md", "## Progress — changed\n+ line", semantics, true);
  assert(doc.includes("ws-1.md") && doc.includes("✓ completed: fix the bug"), "doc-first pointer carries transitions");
  assert(!doc.includes("Saved human changes"), "doc-first pointer omits the section diff");
  const docPlain = buildSteeringMessage("ws-1.md", "## Progress — changed", "", true);
  assert(!docPlain.includes("Semantics"), "doc-first pointer without semantics stays compact");
  // Normal mode: full diff, semantics appended when present.
  const normal = buildSteeringMessage("ws-1.md", "## Progress — changed\n+ line", semantics, false);
  assert(normal.includes("Saved human changes") && normal.includes("## Progress — changed") && normal.includes("✓ completed"), "normal mode steers the diff plus semantics");
}

console.log("worksheet-loop block-identity tests passed");