// Runtime smoke test: exercises the real watch → debounce → steer loop, the
// bash wildcard guard, and disarm-time hash behavior in a temp directory.
// Run: node worksheet-loop.runtime.test.mjs (or npm test) — requires Node >= 22.7.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
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
  //    and the spurious post-write watch event is hash-suppressed.
  const agentContent = "# Test\n\n## Todos\n- [x] step one\n\n## Progress\n- did the thing\n- agent note\n";
  handlers.get("tool_call")(
    { toolName: "write", toolCallId: "w1", input: { path: wsPath, content: agentContent } },
    baseCtx,
  );
  writeFileSync(wsPath, agentContent);
  handlers.get("tool_execution_end")({ toolName: "write", toolCallId: "w1", result: {}, isError: false }, baseCtx);
  await sleep(DEBOUNCE_SETTLE_MS);
  assert(steers.length === 1, "agent write produces no steer (got extra: %s)", steers.length);

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

  // 5. Shutdown tears down watchers and timers so the process can exit.
  handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, baseCtx);
} finally {
  process.chdir(originalCwd);
  rmSync(workdir, { recursive: true, force: true });
}

console.log("worksheet-loop runtime smoke test passed");
