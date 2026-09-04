import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRolePrompt,
  appendMarkerInstruction,
  buildCrewMarkers,
  buildRoleCommand,
  chooseSplitTarget,
  chooseAgentName,
  compactRoleOutput,
  configCandidates,
  extractMarkerOutput,
  updateMarkerOutput,
  findReusableRolePane,
  findReusableRolePaneInList,
  parseCrewConfig,
  resolveRole,
  selectLaunchCommand,
  scopedRoleName,
  normalizeTask,
  normalizeCommand,
  buildHandoff,
  serializeSessionEntries,
  selectHandoffEntries,
  parseJsonlSession,
  reconstructBranch,
  findLatestDelegationPrompt,
  resolveNativeSessionPath,
  parseModelCatalog,
  modelMatch,
  classifyAgentStatus,
  functionalPreflight,
  isStartupBlockedOutput,
} from "./index.ts";

test("unresolved delegation references are rejected conservatively", () => {
  assert.throws(() => normalizeTask("implement it"), /incomplete/i);
  assert.throws(() => normalizeTask("implement the plan above"), /incomplete/i);
  assert.throws(() => normalizeTask("fix it in auth.ts"), /incomplete/i);
  assert.doesNotThrow(() => normalizeTask("Review the authentication parser and report whether it handles expired tokens."));
  assert.doesNotThrow(() => normalizeTask("Review that", { context: "Assess the concrete Alpha Vantage and Trade212 API proposal, including command shape and failure handling." }));
  assert.doesNotThrow(() => normalizeTask("Review the previous API research and report implementation risks."));
});

test("model catalog requires exact IDs", () => {
  const catalog = parseModelCatalog("Provider          Model                 Context\nopenai-codex     gpt-5.6-luna          114k\nremote-ds4       deepseek-v4-flash     32k\nremote-ollama    qwen3.8:27b-mlx       32k");
  assert.deepEqual(catalog, ["openai-codex/gpt-5.6-luna", "remote-ds4/deepseek-v4-flash", "remote-ollama/qwen3.8:27b-mlx"]);
  assert.equal(modelMatch("openai-codex/gpt-5.6-luna", catalog), "exact");
  assert.equal(modelMatch("ds4-flash", catalog), "fuzzy");
  assert.equal(modelMatch("GML-5.3-flash", catalog), "none");
});

test("blocked and timeout statuses are not completion", () => {
  assert.equal(classifyAgentStatus("blocked"), "blocked");
  assert.equal(classifyAgentStatus("timed_out"), "timed_out");
  assert.equal(classifyAgentStatus("working"), "working");
});


const messageEntry = (id: string, role: string, content: unknown, parentId?: string, extra: Record<string, unknown> = {}) => ({ type: "message", id, parentId: parentId ?? null, message: { role, content, ...extra } });

test("handoff selects the latest complete checkpoint and excludes the current call", () => {
  const branch = [messageEntry("u1", "user", [{ type: "text", text: "old" }]), messageEntry("r1", "toolResult", "complete", "u1", { toolName: "crew_launch", isError: false, details: { complete: true } }), messageEntry("u2", "user", [{ type: "text", text: "correction" }], "r1"), messageEntry("call", "assistant", [{ type: "toolCall", id: "current", name: "crew_launch" }], "u2")];
  const result = buildHandoff(branch, "current");
  assert.match(result.text, /complete/); assert.match(result.text, /correction/); assert.doesNotMatch(result.text, /current/); assert.equal(result.checkpointEntryId, "r1");
});

test("explicit fallback does not select recent history", () => {
  const branch = [messageEntry("u1", "user", "OLD"), messageEntry("call", "assistant", [{ type: "toolCall", id: "current", name: "crew_launch" }], "u1")];
  assert.equal(buildHandoff(branch, "current", "since-last-crew", "explicit", 6, 24000, "EXPLICIT").text, "EXPLICIT");
});

test("serialization excludes hidden reasoning but retains custom messages and tool relationships", () => {
  const entries = [messageEntry("a", "assistant", [{ type: "thinking", thinking: "secret" }, { type: "text", text: "visible" }, { type: "toolCall", id: "call-1", name: "bash" }]), { type: "custom_message", id: "c", parentId: "a", customType: "note", content: "custom context" }, messageEntry("t", "toolResult", "evidence", "a", { toolName: "bash", toolCallId: "call-1", isError: false })];
  const text = serializeSessionEntries(entries); assert.match(text, /visible/); assert.match(text, /custom context/); assert.match(text, /evidence/); assert.doesNotMatch(text, /secret/);
});

test("native JSONL rejects a terminated malformed final line", () => {
  assert.throws(() => parseJsonlSession('{"type":"session","id":"s"}\nnot-json\n'), /Malformed|invalid/i);
});

test("branch reconstruction rejects missing parents and cycles", () => {
  assert.throws(() => reconstructBranch([{ id: "x", parentId: "missing", type: "message" }], "x"), /parent/i);
  assert.throws(() => reconstructBranch([{ id: "x", parentId: "y", type: "message" }, { id: "y", parentId: "x", type: "message" }], "x"), /cycle/i);
});

test("latest explicit or ephemeral delegation supersedes an older locator", () => {
  const oldPrompt = messageEntry("old", "user", "You are oracle.\n## Working directory\n/repo\n## Required response\nreturn findings\n<crew-context-source>\n{\"version\":1,\"brainSessionId\":\"brain-old\",\"upperBoundEntryId\":\"entry-old\"}\n</crew-context-source>");
  const latestPrompt = messageEntry("latest", "user", "<crew-delegation version=\"1\">\nYou are oracle.\n## Role\noracle\n## Authority\nread-only\n## Working directory\n/repo\n## Objective\nnew task\n## Context\nEXPLICIT\n## Constraints\nnone\n## Acceptance criteria\ncheck\n## Required response\nreturn findings");
  assert.equal(findLatestDelegationPrompt([oldPrompt, latestPrompt])?.id, "latest");
});

test("native session resolution rejects symlinked candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "crew-session-")); const outside = mkdtempSync(join(tmpdir(), "crew-outside-"));
  writeFileSync(join(outside, "real.jsonl"), "{}"); symlinkSync(join(outside, "real.jsonl"), join(directory, "timestamp_brain-safe.jsonl"));
  assert.throws(() => resolveNativeSessionPath(directory, "brain-safe"), /symlink|regular|containment|escapes/i);
});

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("selectLaunchCommand uses pi by default", () => {
  assert.equal(selectLaunchCommand({}), "pi");
});

test("selectLaunchCommand uses pic-proxy for bridge env", () => {
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE: "1" }), "pic-proxy");
  assert.equal(selectLaunchCommand({ PIC_HERDR_BRIDGE_HOST: "127.0.0.1" }), "pic-proxy");
});

test("role bootstrap approves the project before selecting the model", () => {
  assert.equal(buildRoleCommand("pi", "provider/model"), "pi --approve --model provider/model");
  assert.equal(buildRoleCommand("pic-proxy", "provider/model"), "pic-proxy --approve --model provider/model");
  assert.equal(buildRoleCommand("pi"), "pi --approve");
});

test("role config parsing and defaults preserve configured fields", () => {
  const config = parseCrewConfig(JSON.stringify({
    roles: {
      scout: { description: "Custom scout", model: "provider/model", authority: "read-only" },
    },
  }));
  const role = resolveRole("scout", config);
  assert.deepEqual(role, {
    name: "scout",
    description: "Custom scout",
    model: "provider/model",
    authority: "read-only",
  });
  const prompt = buildRolePrompt("scout", role, "map files", "/repo", { context: "source tree" });
  assert.match(prompt, /You are scout\. Custom scout Authority: read-only\. Task: map files/);
  assert.match(prompt, /## Working directory[\s\S]*\/repo/);
  assert.match(prompt, /## Context[\s\S]*source tree/);
});

test("compactRoleOutput keeps output after the last prompt without extra truncation", () => {
  const prompt = "You are scout. Task: say hello";
  const tail = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const output = `pi --model x\nstartup noise\n${prompt}\nThinking\nHello.\n${prompt}\n${tail}`;
  assert.equal(compactRoleOutput(output, prompt), tail);
  assert.equal(compactRoleOutput(output, prompt, 2), "line 59\nline 60");
});

test("marker helpers extract only the final answer between marker pair", () => {
  const markers = buildCrewMarkers("call:a/b");
  assert.match(markers.start, /^CREW_RESULT_START_/);
  assert.match(markers.end, /^CREW_RESULT_END_/);
  const prompt = appendMarkerInstruction("You are scout. Task: say hello", markers);
  assert.match(prompt, new RegExp(markers.start));
  assert.match(prompt, new RegExp(markers.end));
  const output = `startup\n${markers.start}\nold answer\n${markers.end}\nnoise\n${markers.start}\nFinal answer\nline 2\n${markers.end}\nfooter noise`;
  assert.deepEqual(extractMarkerOutput(output, markers), { text: "Final answer\nline 2", mode: "marker-pair" });
  assert.deepEqual(extractMarkerOutput(`${markers.start}\nFinal answer\nfooter`, markers), { text: "Final answer\nfooter", mode: "marker-start" });
  assert.deepEqual(extractMarkerOutput("missing", markers), { text: "", mode: "missing" });
});

test("marker capture survives the start marker scrolling out of later snapshots", () => {
  const markers = buildCrewMarkers("scrolled-marker");
  let capture = extractMarkerOutput("", markers);
  capture = updateMarkerOutput(capture, `${markers.start}\nline 1\nline 2`, markers);
  capture = updateMarkerOutput(capture, `line 2\nline 3\n${markers.end}\nfooter`, markers);
  assert.deepEqual(capture, { text: "line 1\nline 2\nline 3", mode: "marker-pair" });
});

test("marker text embedded in the echoed prompt is not treated as role output", () => {
  const markers = buildCrewMarkers("embedded-marker");
  const echoedPrompt = `For your final answer, print ${markers.start} on its own line, then your answer, then ${markers.end} on its own line.`;
  assert.deepEqual(extractMarkerOutput(echoedPrompt, markers), { text: "", mode: "missing" });
});

test("interactive trust prompts are treated as blocked startup", () => {
  assert.equal(isStartupBlockedOutput("Trust project folder?\n→ Trust"), true);
  assert.equal(isStartupBlockedOutput("Pi can explain its own features."), false);
});

test("scoped role names preserve uppercase workspace characters without doubled separators", () => {
  assert.equal(scopedRoleName("scout", "wA", "wA:t1"), "scout-wa-t1");
});

test("role defaults supply built-in description and authority", () => {
  const role = resolveRole("executor", {});
  assert.equal(role.name, "executor");
  assert.equal(role.authority, "can-edit");
  assert.match(role.description ?? "", /Implements the approved plan/);
  assert.equal(role.model, undefined);
});

test("unknown roles are rejected", () => {
  assert.throws(() => resolveRole("invented", {}), /Unknown crew role/);
});

test("invalid configured authority and model are rejected", () => {
  assert.throws(() => resolveRole("scout", { roles: { scout: { authority: "write-all" as never } } }), /Invalid authority/);
  assert.throws(() => resolveRole("scout", { roles: { scout: { model: "bad model" } } }), /Invalid model/);
});

test("role names must be Herdr-compatible", () => {
  assert.throws(() => resolveRole("Scout", {}), /Herdr agent names/);
  assert.throws(() => resolveRole("1scout", {}), /Herdr agent names/);
  assert.throws(() => resolveRole("scout.with.dot", {}), /Herdr agent names/);
  assert.throws(() => resolveRole("a".repeat(33), {}), /Herdr agent names/);
});

test("config candidates prefer project config before global config", () => {
  assert.deepEqual(configCandidates("/repo", "/home/me"), [
    "/repo/.pi/crew.config.json",
    "/repo/.pi/skills/crew/crew.config.json",
    "/repo/skills/crew/crew.config.json",
    "/.pi/crew.config.json",
    "/home/me/.pi/agent/skills/crew/crew.config.json",
    "/home/me/.pi/crew.config.json",
  ]);
});

test("reuse eligibility requires same role, idle or done, workspace, cwd, and pane", () => {
  const agent = { name: "reviewer", pane_id: "pane-1", workspace_id: "ws", foreground_cwd: "/repo", agent_status: "idle" };
  assert.equal(findReusableRolePane(agent, "reviewer", "ws", "/repo"), "pane-1");
  assert.equal(findReusableRolePane({ ...agent, agent_status: undefined, status: "Idle" }, "reviewer", "ws", "/repo"), "pane-1");
  assert.equal(findReusableRolePane({ ...agent, agent_status: "working" }, "reviewer", "ws", "/repo"), undefined);
  assert.equal(findReusableRolePane({ ...agent, workspace_id: "other" }, "reviewer", "ws", "/repo"), undefined);
  assert.equal(findReusableRolePane({ ...agent, foreground_cwd: "/else" }, "reviewer", "ws", "/repo"), undefined);
  assert.equal(findReusableRolePane({ ...agent, name: "scout" }, "reviewer", "ws", "/repo"), undefined);
});

test("reuse lookup finds existing role from agent list", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "ws", cwd: "/repo", agent_status: "idle" },
    { name: "reviewer", pane_id: "pane-reviewer", workspace_id: "ws", cwd: "/repo", agent_status: "idle" },
  ];
  assert.equal(findReusableRolePaneInList(agents, "reviewer", "ws", "/repo"), "pane-reviewer");
});


test("agent naming scopes to workspace and tab when base role exists elsewhere", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6");
});

test("agent naming keeps base role for same tab reuse", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "w5", tab_id: "tab-test", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "tab-test"), "scout");
});

test("agent naming does not reuse an occupied name when its requested model is unknown", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "w5", tab_id: "tab-test", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "tab-test", "provider/model"), "scout-w5-tab-test");
});

test("agent naming reuses scoped same-tab role", () => {
  const agents = [
    { name: "scout-w5-t6", pane_id: "pane-scoped", workspace_id: "w5", tab_id: "w5:t6", cwd: "/repo", status: "Idle" },
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6");
});

test("agent naming avoids busy or wrong-cwd scoped collisions", () => {
  const agents = [
    { name: "scout", pane_id: "pane-scout", workspace_id: "team", tab_id: "team-tab", cwd: "/repo", status: "Idle" },
    { name: "scout-w5-t6", pane_id: "pane-busy", workspace_id: "w5", tab_id: "w5:t6", cwd: "/repo", status: "Working" },
    { name: "scout-w5-t6-2", pane_id: "pane-other-cwd", workspace_id: "w5", tab_id: "w5:t6", cwd: "/other", status: "Idle" },
  ];
  assert.equal(chooseAgentName(agents, "scout", "w5", "/repo", "w5:t6"), "scout-w5-t6-3");
});

test("agent naming keeps scoped names Herdr-compatible and length-safe", () => {
  const agents = [{ name: "averylongcustomrolename-that-exists", pane_id: "p", workspace_id: "other", cwd: "/repo", status: "Idle" }];
  const name = chooseAgentName(agents, "averylongcustomrolename", "workspace-with-long-name", "/repo", "workspace-with-long-name:t123456789");
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(name.length <= 32);
});

test("split decision creates below existing same-cwd crew pane", () => {
  const decision = chooseSplitTarget([
    { name: "scout", pane_id: "pane-scout", workspace_id: "ws", cwd: "/repo" },
  ], "ws", "/repo");
  assert.equal(decision.policy, "below-existing-crew");
  assert.deepEqual(decision.args, ["pane", "split", "pane-scout", "--direction", "down", "--cwd", "/repo", "--no-focus"]);
});

test("split decision recognizes configured custom crew roles", () => {
  const decision = chooseSplitTarget([
    { name: "analyst-ws-t1", pane_id: "pane-analyst", workspace_id: "ws", tab_id: "t1", cwd: "/repo" },
  ], "ws", "/repo", "t1", new Set(["analyst"]));
  assert.equal(decision.policy, "below-existing-crew");
});

test("split decision creates right of current when no crew pane matches", () => {
  const decision = chooseSplitTarget([
    { name: "scout", pane_id: "pane-scout", workspace_id: "other", cwd: "/repo" },
  ], "ws", "/repo");
  assert.equal(decision.policy, "right-of-current");
  assert.deepEqual(decision.args, ["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"]);

  const crossTab = chooseSplitTarget([
    { name: "scout-ws", pane_id: "pane-scout", workspace_id: "ws", tab_id: "other-tab", cwd: "/repo" },
  ], "ws", "/repo", "current-tab");
  assert.equal(crossTab.policy, "right-of-current");
});

async function regressionTest(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); process.exitCode = 1; throw error; }
}

void regressionTest("functional preflight uses direct Herdr despite login-shell PATH", async () => {
  const oldEnv = process.env.HERDR_ENV;
  const oldPath = process.env.PATH;
  process.env.HERDR_ENV = "1";
  process.env.PATH = "/usr/bin";
  const calls: string[][] = [];
  const result = await functionalPreflight({ exec: async (command, args = []) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: '{"result":{"pane":{"cwd":"/repo"}}}', stderr: "" };
  }, registerTool() {} });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [["herdr", "pane", "current", "--current"]]);
  if (oldEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = oldEnv;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
});