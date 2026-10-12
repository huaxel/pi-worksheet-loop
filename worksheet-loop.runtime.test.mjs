// Runtime smoke test: exercises the real watch → debounce → steer loop, the
// bash wildcard guard, and disarm-time hash behavior in a temp directory.
// Run: node worksheet-loop.runtime.test.mjs (or npm test) — requires Node >= 22.7.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "index.ts"), "utf8");
// The data-URL import is pure ESM; provide the __dirname that jiti injects.
const js = `const __dirname = ${JSON.stringify(here)};\n` + stripTypeScriptTypes(source);
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEBOUNCE_SETTLE_MS = 900;

/** Count audit-log revisions per actor for the worksheet's history sidecar. */
function actorRevisions(wsPath) {
  const histRoot = path.join(path.dirname(wsPath), ".history");
  const counts = { human: 0, agent: 0 };
  for (const sub of (existsSync(histRoot) ? readdirSync(histRoot) : [])) {
    const ev = path.join(histRoot, sub, "events.jsonl");
    if (!existsSync(ev)) continue;
    for (const line of readFileSync(ev, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const actor = JSON.parse(line).actor;
      if (actor in counts) counts[actor] += 1;
    }
  }
  return counts;
}

const workdir = mkdtempSync(path.join(tmpdir(), "worksheet-runtime-"));
const originalCwd = process.cwd();
process.chdir(workdir);

try {
  const handlers = new Map();
  const steers = [];
  let command;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, options) => {
      command = { name, options };
    },
    sendUserMessage: (text, opts) => steers.push({ text, opts }),
  };
  mod.default(pi);

  const baseCtx = {
    sessionManager: { getSessionFile: () => path.join(workdir, "session.jsonl") },
    hasUI: false,
  };
  const uiCtx = {
    ...baseCtx,
    ui: { notify: () => {}, input: async () => undefined, setStatus: () => {} },
  };

  await handlers.get("session_start")({ type: "session_start", reason: "startup" }, uiCtx);
  assert(command && command.name === "worksheet", "worksheet command registered");

  const wsPath = path.join(workdir, ".worksheets", "ws-1-abcdef-test.md");
  mkdirSync(path.dirname(wsPath), { recursive: true });
  writeFileSync(wsPath, "# Test\n\n## Todos\n- [ ] step one\n\n## Progress\n\n");

  // Attach the worksheet (also selects it → document-first mode).
  await command.options.handler(`attach ${wsPath}`, uiCtx);

  // 1. Human edit: append a progress line and tick the todo → steer with semantics.
  appendFileSync(wsPath, "- did the thing\n");
  writeFileSync(
    wsPath,
    readFileSync(wsPath, "utf8").replace("- [ ] step one", "- [x] step one"),
  );
  await sleep(DEBOUNCE_SETTLE_MS);
  assert(steers.length === 1, `one steer after human edit (got ${steers.length})`);
  assert(steers[0].opts.deliverAs === "steer", "delivered as steer");
  assert(steers[0].text.includes("[Worksheet update"), "steer is a worksheet update");
  assert(
    steers[0].text.includes("✓ completed: step one"),
    "document-first pointer carries the todo transition",
  );
  assert(!steers[0].text.includes("Saved human changes"), "document-first pointer omits the diff");

  // 2. Agent write via the `write` tool: armed → write → disarm; no steer,
  //    an actor:"agent" revision is recorded, and the spurious post-write
  //    watch event is hash-suppressed.  The tool input uses the CANONICAL
  //    (symlink-resolved) path form while attach used the raw one — the guard
  //    must arm despite the form mismatch (macOS /var vs /private/var).
  const agentContent = "# Test\n\n## Todos\n- [x] step one\n\n## Progress\n- did the thing\n- agent note\n";
  const canonicalWs = realpathSync(wsPath);
  assert(canonicalWs !== wsPath, "test requires a symlinked workdir (tmpdir)");
  handlers.get("tool_call")(
    { toolName: "write", toolCallId: "w1", input: { path: canonicalWs, content: agentContent } },
    baseCtx,
  );
  writeFileSync(wsPath, agentContent);
  handlers.get("tool_execution_end")({ toolName: "write", toolCallId: "w1", result: {}, isError: false }, baseCtx);
  await sleep(DEBOUNCE_SETTLE_MS);
  assert(steers.length === 1, "agent write produces no steer (got extra: %s)", steers.length);
  assert(actorRevisions(wsPath).agent === 1, "agent write recorded as actor 'agent'");

  // 3. Interleave: disk differs from the expected write content at disarm →
  //    a re-read steer is sent.
  const expected = "# Test\n\n## Todos\n- [x] step one\n\n## Progress\n- did the thing\n- agent note\n";
  const interleaved = expected + "- human interleaved edit\n";
  handlers.get("tool_call")(
    { toolName: "write", toolCallId: "w2", input: { path: wsPath, content: expected } },
    baseCtx,
  );
  writeFileSync(wsPath, interleaved);
  handlers.get("tool_execution_end")({ toolName: "write", toolCallId: "w2", result: {}, isError: false }, baseCtx);
  await sleep(DEBOUNCE_SETTLE_MS);
  assert(steers.length === 2, `interleaved write surfaces a re-read steer (got ${steers.length})`);
  assert(steers[1].text.includes("changed again while the agent's write was landing"), "interleave steer text");
  assert(actorRevisions(wsPath).agent === 2, "interleaved write still recorded as an agent revision");

  // 4. Bash guard: armed for the command window; a write inside is suppressed
  //    and the hash refreshed; after disarm a new human edit steers again.
  handlers.get("tool_call")(
    { toolName: "bash", toolCallId: "b1", input: { command: `echo '- [ ] step two' >> ${wsPath}` } },
    baseCtx,
  );
  appendFileSync(wsPath, "- [ ] step two\n");
  await sleep(DEBOUNCE_SETTLE_MS);
  assert(steers.length === 2, "bash-window write is suppressed by the wildcard guard");
  handlers.get("tool_execution_end")({ toolName: "bash", toolCallId: "b1", result: "", isError: false }, baseCtx);

  // Re-appending the same line would be a no-op content-wise; append a fresh line.
  appendFileSync(wsPath, "- [ ] step three\n");
  await sleep(DEBOUNCE_SETTLE_MS);
  assert(steers.length === 3, "post-disarm human edit steers again");

  // 4b. Parallel write race: two write tool calls for the SAME worksheet in
  //     one batch (pi's default toolExecution is "parallel").  The first
  //     tool_execution_end must NOT clear the guard while the second write is
  //     still in flight — otherwise the watcher sees the in-flight agent
  //     write with no guard active and attributes it to the human (plus a
  //     self-steer).
  const before = readFileSync(wsPath, "utf8");
  const parallelNote = before + "- agent parallel note\n";
  handlers.get("tool_call")(
    { toolName: "write", toolCallId: "w3", input: { path: wsPath, content: before } },
    baseCtx,
  );
  handlers.get("tool_call")(
    { toolName: "write", toolCallId: "w4", input: { path: wsPath, content: parallelNote } },
    baseCtx,
  );
  writeFileSync(wsPath, before); // w3 lands first
  handlers.get("tool_execution_end")({ toolName: "write", toolCallId: "w3", result: {}, isError: false }, baseCtx);
  writeFileSync(wsPath, parallelNote); // w4 lands later, end event still pending
  await sleep(DEBOUNCE_SETTLE_MS); // let any (incorrect) human debounce timer fire
  handlers.get("tool_execution_end")({ toolName: "write", toolCallId: "w4", result: {}, isError: false }, baseCtx);
  await sleep(DEBOUNCE_SETTLE_MS);
  const afterParallel = actorRevisions(wsPath);
  assert(
    afterParallel.human === 2,
    `parallel in-flight write must not be attributed to the human (got ${afterParallel.human} human revisions)`,
  );
  assert(afterParallel.agent === 3, `parallel write recorded as an agent revision (got ${afterParallel.agent})`);
  assert(steers.length === 3, "parallel in-flight write produces no steer");

  // 5. Shutdown tears down watchers and timers so the process can exit.
  handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, baseCtx);

  // 6. Final attribution: 3 agent revisions (write + interleave + parallel)
  //    and exactly 2 human revisions (step-1 edit + post-bash edit).
  const final = actorRevisions(wsPath);
  assert(final.agent === 3, `expected 3 agent revisions (got ${final.agent})`);
  assert(final.human === 2, `expected exactly 2 human revisions (got ${final.human})`);
} finally {
  process.chdir(originalCwd);
  rmSync(workdir, { recursive: true, force: true });
}

console.log("worksheet-loop runtime smoke test passed");
