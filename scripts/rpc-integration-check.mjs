// Pi RPC integration check for the worksheet-loop extension.
// Drives a real `pi --mode rpc` subprocess with ONLY the extension loaded
// (-ne -e) and verifies each dynamic pi-API integration point at runtime:
// session_start, registerCommand, command execution, the before_agent_start
// systemPrompt override, and the tool_call/tool_execution_end guard + audit
// sidecar (including human/agent attribution).
//
// Usage: PI_BIN=/path/to/pi node scripts/rpc-integration-check.mjs ./index.ts
// Not part of `npm test` — it spawns a real pi session and makes two model
// calls. Run it after pi updates to catch API refactors early.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EXT = path.resolve(process.argv[2] ?? "./index.ts");
if (!existsSync(EXT)) throw new Error(`extension not found: ${EXT}`);
// Prefer $PI_BIN (managed installs may live off-PATH); fall back to `pi`.
const PI = process.env.PI_BIN ?? "pi";

const workdir = mkdtempSync(path.join(tmpdir(), "ws-rpc-"));

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── minimal JSONL RPC client ──────────────────────────────────────────────
const child = spawn(PI, ["--mode", "rpc", "--no-session", "-ne", "-e", EXT], {
  cwd: workdir,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

let buf = "";
const responders = new Map(); // id -> resolve
const eventLog = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).replace(/\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "response" && rec.id && responders.has(rec.id)) {
      const r = responders.get(rec.id);
      responders.delete(rec.id);
      r(rec);
    } else if (rec.type !== "response") {
      eventLog.push(rec);
    }
  }
});

let nextId = 0;
function command(type, extra = {}, timeoutMs = 30000) {
  const id = `req-${++nextId}`;
  const p = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (responders.has(id)) {
        responders.delete(id);
        reject(new Error(`timeout waiting for ${type}`));
      }
    }, timeoutMs);
    responders.set(id, (rec) => { clearTimeout(t); resolve(rec); });
  });
  child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
  return p;
}

async function waitAgentSettled(timeoutMs = 90000) {
  const start = eventLog.length;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = start; i < eventLog.length; i++) {
      if (eventLog[i].type === "agent_settled") return eventLog[i];
    }
    if (Date.now() > deadline) throw new Error("timeout waiting for agent_settled");
    await sleep(150);
  }
}

async function promptAndWait(message, timeoutMs = 90000) {
  const resp = await command("prompt", { message }, 30000);
  if (!resp.success) throw new Error(`prompt failed: ${resp.error}`);
  if (resp.data?.disposition === "started") await waitAgentSettled(timeoutMs);
  return resp;
}

function lastAssistantText() {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const text = (e.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (text) return text;
    }
  }
  return null;
}

// ── run ───────────────────────────────────────────────────────────────────
try {
  // Phase 1: registerCommand — /worksheet must be present.
  const cmds = await command("get_commands", {}, 30000);
  const names = (cmds.data?.commands ?? []).map((c) => c.name);
  record("registerCommand: /worksheet registered", cmds.success && names.includes("worksheet"), `commands seen: ${names.join(", ") || "(none)"}`);

  // Phase 2: session_start fired — handler mkdir's .worksheets in cwd.
  const wsDir = path.join(workdir, ".worksheets");
  record("session_start: .worksheets/ created in cwd", existsSync(wsDir), wsDir);

  // Phase 2b: create a human-authored worksheet, then attach it via the command.
  const ws = path.join(wsDir, "ws-rpc-verify.md");
  writeFileSync(ws, "# RPC verify\n\n## Todos\n- [ ] agent will check this\n\n## Progress\n- started\n");
  const attach = await promptAndWait(`/worksheet attach ${ws}`);
  record("command exec: /worksheet attach handled", attach.data?.disposition === "handled", `disposition=${attach.data?.disposition}`);

  // Phase 3: before_agent_start systemPrompt override honored — after attach,
  // the model's system prompt must contain the Active worksheet line + skill.
  await promptAndWait(
    "Do not use any tools. On the first line, reply with exactly the text after 'Active worksheet: ' in your system prompt, or NONE if there is no such line. On the second line, reply exactly SKILL if your system prompt contains a section titled 'Shared worksheet', otherwise NOSKILL.",
  );
  const text3 = lastAssistantText() ?? "";
  const lines3 = text3.split("\n").map((l) => l.trim()).filter(Boolean);
  record(
    "before_agent_start: 'Active worksheet:' line injected",
    lines3[0] === "ws-rpc-verify.md" || lines3[0]?.endsWith("ws-rpc-verify.md"),
    `line1=${JSON.stringify(lines3[0] ?? null)}`,
  );
  record("before_agent_start: skill content injected", lines3.some((l) => l === "SKILL"), `line2=${JSON.stringify(lines3[1] ?? null)}`);

  // Phase 4: tool_call + tool_execution_end guard + audit. Ask the agent to
  // edit the attached worksheet with a real tool; verify an actor:"agent"
  // revision lands in the audit sidecar and block-ids.json is written, with no
  // self-injection loop (clean settle).
  await promptAndWait(
    `Use the edit tool to change the line "- [ ] agent will check this" in ${ws} to "- [x] agent will check this". Make exactly that one edit, then stop. Do not do anything else.`,
  );
  const fileAfter = readFileSync(ws, "utf8");
  record("agent tool write: file was edited", fileAfter.includes("- [x] agent will check this"), "");

  // find the history sidecar
  const histDir = path.join(wsDir, ".history");
  let agentRevision = false, humanRevision = false, blockIds = false;
  const scanHistory = () => {
    if (!existsSync(histDir)) return;
    for (const sub of readdirSync(histDir)) {
      const ev = path.join(histDir, sub, "events.jsonl");
      const bi = path.join(histDir, sub, "block-ids.json");
      if (existsSync(bi)) blockIds = true;
      if (!existsSync(ev)) continue;
      for (const line of readFileSync(ev, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.actor === "agent") agentRevision = true;
          if (e.actor === "human") humanRevision = true;
        } catch {}
      }
    }
  };
  scanHistory();
  record("tool_call/tool_execution_end: actor:'agent' revision recorded", agentRevision, histDir);
  record("block-id reconciliation: block-ids.json written", blockIds, "");

  // Phase 5: human edit → watcher → recordRevision (audit actor:'human').
  // Simulate a human save by editing out-of-band, wait past the 400ms debounce.
  appendFileSync(ws, "\n## Decisions\n- made by the human\n");
  await sleep(1500);
  scanHistory();
  record("watcher: human save recorded as actor:'human'", humanRevision, "");

  // Phase 6 (best-effort): the extension's sendUserMessage steer is observable
  // as a queued steering/user message in the event stream.
  const sawSteer = eventLog.some(
    (e) =>
      (e.type === "message_start" || e.type === "message_end" || e.type === "message_update") &&
      JSON.stringify(e).includes("[Worksheet update"),
  );
  record("sendUserMessage steer: '[Worksheet update' delivered (best-effort)", sawSteer, sawSteer ? "" : "not observed in event stream");
} catch (err) {
  record("run", false, err.message);
  console.log("\n--- stderr tail ---\n" + stderr.split("\n").slice(-25).join("\n"));
} finally {
  child.stdin.end();
  const killT = setTimeout(() => child.kill("SIGKILL"), 4000);
  await new Promise((r) => child.on("close", r));
  clearTimeout(killT);
  rmSync(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} integration checks passed ===`);
process.exit(failed.length ? 1 : 0);
