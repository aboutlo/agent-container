import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type ExecResult = { code: number | null; stdout: string; stderr: string; killed?: boolean };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
type ToolUpdate = (partialResult: ToolResult) => void;
type SessionMessage = { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: unknown; details?: Record<string, unknown> };
export type SessionEntryLike = { id?: string; parentId?: string | null; type?: string; timestamp?: string; message?: SessionMessage; customType?: string; content?: unknown };
type ExtensionContext = { cwd: string; sessionManager: { getBranch(): SessionEntryLike[]; getLeafId(): string | null; getSessionFile(): string | undefined; getSessionId(): string; getSessionDir(): string } };

type ExtensionAPI = {
  exec(command: string, args?: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  registerTool(tool: {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    executionMode?: "parallel" | "sequential";
    execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: ToolUpdate, ctx?: ExtensionContext): Promise<unknown>;
  }): void;
};

type Role = {
  description?: string;
  model?: string;
  authority?: "read-only" | "can-edit";
};

type CrewConfig = { roles?: Record<string, Role> };
type AgentLike = {
  name?: string;
  pane_id?: string;
  workspace_id?: string;
  tab_id?: string;
  foreground_cwd?: string;
  cwd?: string;
  agent_status?: string;
  status?: string;
  model?: string;
  model_id?: string;
  agent_session_path?: string;
  agent_session_id?: string;
};

const VERSION = "0.1.0";
const STARTUP_TIMEOUT_MS = 120_000;
const PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LINES = 200;
const FAILURE_READ_LINES = 160;
const STARTUP_READY_STABLE_MS = 3_000;
const STARTUP_POLL_MS = 500;
const MARKER_READ_LINES = 2_000;
const ROLE_POLL_MS = 15_000;
const PROMPT_START_GRACE_MS = 5_000;
const KNOWN_ROLES = new Set(["scout", "oracle", "executor", "reviewer"]);

const DEFAULT_ROLES: Record<string, Required<Pick<Role, "description" | "authority">>> = {
  scout: {
    description: "Finds local and online context. Reports relevant facts, files, sources, risks, and suggested next steps.",
    authority: "read-only",
  },
  oracle: {
    description: "Advises on plans, architecture, sequencing, tradeoffs, alternatives, and risks.",
    authority: "read-only",
  },
  executor: {
    description: "Implements the approved plan with minimal pragmatic changes and reports changed files, validation, and risks.",
    authority: "can-edit",
  },
  reviewer: {
    description: "Reviews plans or diffs for correctness, missed requirements, test gaps, maintainability risks, and actionable findings.",
    authority: "read-only",
  },
};

export function selectLaunchCommand(env: NodeJS.ProcessEnv = process.env): "pic-proxy" | "pi" {
  return env.PIC_HERDR_BRIDGE === "1" || !!env.PIC_HERDR_BRIDGE_HOST ? "pic-proxy" : "pi";
}

export function selectDiscoveryCommand(): "pi" { return "pi"; }

function shellQuote(value: string): string { return /^[A-Za-z0-9._:/~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`; }
export function buildRoleCommand(baseCommand: "pic-proxy" | "pi", launchModel?: string, sessionDir?: string): string {
  return `${baseCommand} --approve${launchModel ? ` --model ${shellQuote(launchModel)}` : ""}${sessionDir ? ` --session-dir ${shellQuote(sessionDir)}` : ""}`;
}

export function parseCrewConfig(raw: string): CrewConfig {
  const parsed = JSON.parse(raw) as CrewConfig;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function normalizedCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try { return realpathSync(absolute); } catch { return absolute.replace(/[\\\\/]+$/, "") || absolute; }
}

export function configCandidates(cwd = process.cwd(), home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")): string[] {
  const candidates: string[] = [];
  let current = normalizedCwd(cwd);
  const selected = current;
  while (true) {
    candidates.push(join(current, ".pi", "crew.config.json"));
    if (current === selected) {
      candidates.push(join(current, ".pi", "skills", "crew", "crew.config.json"));
      candidates.push(join(current, "skills", "crew", "crew.config.json"));
    }
    if (current === dirname(current)) break;
    current = dirname(current);
  }
  candidates.push(join(agentDir, "skills", "crew", "crew.config.json"));
  candidates.push(join(home, ".pi", "crew.config.json"));
  return [...new Set(candidates)];
}

export function loadCrewConfig(cwd = process.cwd(), home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")): { config: CrewConfig; path?: string } {
  for (const path of configCandidates(cwd, home, agentDir)) {
    if (!existsSync(path)) continue;
    return { config: parseCrewConfig(readFileSync(path, "utf8")), path };
  }
  return { config: {}, path: undefined };
}

function assertValidAuthority(authority: unknown, roleName: string): asserts authority is Role["authority"] | undefined {
  if (authority === undefined) return;
  if (authority !== "read-only" && authority !== "can-edit") {
    throw new Error(`Invalid authority for crew role ${roleName}: expected read-only or can-edit`);
  }
}

function assertValidModel(model: unknown, roleName: string): asserts model is string | undefined {
  if (model === undefined) return;
  if (typeof model !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:~-]+$/.test(model)) {
    throw new Error(`Invalid model for crew role ${roleName}: expected exact provider/model id`);
  }
}

export function assertValidSessionId(id: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw new Error("Invalid session ID");
}

function assertValidRoleName(roleName: string): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(roleName)) {
    throw new Error("crew_launch role must match Herdr agent names: lowercase letter followed by lowercase letters, numbers, underscore, or hyphen; max 32 chars");
  }
}

export function resolveRole(roleName: string, config: CrewConfig): Role & { name: string } {
  assertValidRoleName(roleName);
  const configured = config.roles?.[roleName];
  const fallback = DEFAULT_ROLES[roleName];
  if (!configured && !fallback) {
    throw new Error(`Unknown crew role: ${roleName}`);
  }
  const authority = configured?.authority ?? fallback?.authority;
  const model = configured?.model;
  assertValidAuthority(authority, roleName);
  assertValidModel(model, roleName);
  return {
    name: roleName,
    description: configured?.description ?? fallback?.description,
    authority,
    model,
  };
}

export type DelegationFields = { context?: string; constraints?: string; acceptanceCriteria?: string; expectedOutput?: string };

export type ContextMode = "explicit" | "since-last-crew";
export type CheckpointFallback = "recent" | "explicit" | "error";
export type CrewContextSource = { version: 1; brainSessionId: string; checkpointEntryId?: string; retrievalCutoffEntryId?: string; upperBoundEntryId: string };
export type HandoffSelection = {
  automaticText?: string;
  entries: SessionEntryLike[];
  semanticCheckpointEntryId?: string;
  retrievalCutoffEntryId?: string;
  fallbackUsed?: CheckpointFallback;
};
export type CrewLaunchContext = HandoffSelection & { text: string; source?: CrewContextSource; checkpointEntryId?: string };

function messageText(message: SessionMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : "";
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const part = item as { type?: string; text?: unknown; name?: unknown; id?: unknown };
    if (part.type === "thinking" || part.type === "thinkingSignature") return [];
    if (part.type === "text" && typeof part.text === "string") return [part.text];
    if (part.type === "toolCall") return [`[tool call: ${typeof part.name === "string" ? part.name : "unknown"}${typeof part.id === "string" ? ` id=${part.id}` : ""}]`];
    if (part.type === "image") { const image = part as { mimeType?: unknown; mediaType?: unknown; width?: unknown; height?: unknown }; const mime = typeof image.mimeType === "string" ? image.mimeType : typeof image.mediaType === "string" ? image.mediaType : "unknown"; const dimensions = typeof image.width === "number" && typeof image.height === "number" ? ` ${image.width}x${image.height}` : ""; return [`[image ${mime}${dimensions}]`]; }
    return [];
  }).join("\n");
}
function eligibleEntry(entry: SessionEntryLike): boolean { if (entry.type === "custom_message") return typeof entry.content === "string" || Array.isArray(entry.content); if (entry.type !== "message" || !entry.message) return false; return ["user", "assistant", "toolResult", "custom"].includes(entry.message.role ?? "") && !!messageText(entry.message).replace(/<crew-context-source>[\s\S]*?<\/crew-context-source>/g, "").trim(); }
function entryText(entry: SessionEntryLike): string { const text = entry.type === "custom_message" ? (typeof entry.content === "string" ? entry.content : Array.isArray(entry.content) ? messageText({ content: entry.content }) : "") : messageText(entry.message); return text.replace(/<crew-context-source>[\s\S]*?<\/crew-context-source>/g, ""); }

export function selectHandoffEntries(entries: SessionEntryLike[]): SessionEntryLike[] {
  return entries.filter((entry) => {
    if (!eligibleEntry(entry)) return false;
    if (entry.type === "custom_message") return true;
    const message = entry.message;
    if (!message || message.role !== "toolResult" || message.toolName === "crew_launch") return true;
    const callIds = new Set(entries.flatMap(item => Array.isArray(item.message?.content) ? item.message.content.flatMap(part => part && typeof part === "object" && (part as { type?: string }).type === "toolCall" && typeof (part as { id?: string }).id === "string" ? [(part as { id: string }).id] : []) : []));
    return typeof message.toolCallId === "string" && callIds.has(message.toolCallId);
  });
}
export function serializeSessionEntries(entries: SessionEntryLike[]): string {
  return entries.filter(eligibleEntry).flatMap((entry) => {
    const text = entryText(entry);
    if (!text) return [];
    const message = entry.message;
    const label = entry.type === "custom_message" ? `custom${entry.customType ? `:${entry.customType}` : ""}` : message?.role === "toolResult" ? `toolResult ${message.toolName ?? "unknown"}${message.toolCallId ? ` (${message.toolCallId})` : ""}` : message?.role ?? "message";
    return [`[${label}]\n${text}`];
  }).join("\n\n");
}
export function findCurrentCrewLaunch(branch: SessionEntryLike[], toolCallId: string): SessionEntryLike | undefined { return branch.find((entry) => entry.message?.role === "assistant" && Array.isArray(entry.message.content) && (entry.message.content as unknown[]).some((item) => item && typeof item === "object" && (item as { id?: string; name?: string }).id === toolCallId && (item as { name?: string }).name === "crew_launch")); }
export function findCheckpoint(branch: SessionEntryLike[], beforeIndex: number): SessionEntryLike | undefined { for (let i = beforeIndex - 1; i >= 0; i -= 1) { const m = branch[i].message; if (m?.role === "toolResult" && m.toolName === "crew_launch" && m.isError === false && m.details?.complete === true) return branch[i]; } return undefined; }
function userBoundaryIndex(branch: SessionEntryLike[], end: number, turns: number): number { let seen = 0; for (let i = end - 1; i >= 0; i -= 1) if (branch[i].message?.role === "user" && ++seen >= turns) return i; return 0; }
export function buildHandoff(branch: SessionEntryLike[], toolCallId: string, mode: ContextMode = "since-last-crew", fallback: CheckpointFallback = "recent", recentTurns = 6, maxChars = 24_000, explicitText = ""): CrewLaunchContext {
  if (mode === "explicit") return { text: explicitText, entries: [] };
  const current = findCurrentCrewLaunch(branch, toolCallId); if (!current) throw new Error(`Cannot build crew handoff: current crew_launch tool call ${toolCallId} was not found in the active branch.`);
  const end = branch.findIndex(e => e.id === current.id); const checkpoint = findCheckpoint(branch, end);
  if (!checkpoint) {
    if (fallback === "error") throw new Error("Cannot build crew handoff: no successful complete crew_launch checkpoint exists in the active branch.");
    if (fallback === "explicit") return { text: explicitText, entries: [], fallbackUsed: "explicit" };
  }
  const boundary = checkpoint ?? branch[userBoundaryIndex(branch, end, recentTurns)];
  const start = branch.findIndex(e => e.id === boundary?.id); const entries = selectHandoffEntries(branch.slice(start, end)); const text = serializeSessionEntries(entries);
  if (text.length > maxChars) throw new Error(`Crew handoff exceeds maxHandoffChars: ${entries.length} entries, ${text.length} characters (limit ${maxChars}).`);
  return { text, automaticText: text, entries, semanticCheckpointEntryId: checkpoint?.id, checkpointEntryId: checkpoint?.id, retrievalCutoffEntryId: boundary?.id, fallbackUsed: checkpoint ? undefined : "recent" };
}
export function sourceLocatorBlock(source: CrewContextSource): string { return `<crew-context-source>\n${JSON.stringify(source)}\n</crew-context-source>`; }
function parseSource(text: string): CrewContextSource | undefined {
  const matches = [...text.matchAll(/<crew-context-source>\s*([\s\S]*?)\s*<\/crew-context-source>/g)];
  const raw = matches.at(-1)?.[1]; if (!raw) return undefined;
  try { const value = JSON.parse(raw) as CrewContextSource; if (value.version !== 1 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value.brainSessionId) || !/^[A-Za-z0-9_-]{1,256}$/.test(value.upperBoundEntryId)) return undefined; if (value.checkpointEntryId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(value.checkpointEntryId)) return undefined; if (value.retrievalCutoffEntryId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(value.retrievalCutoffEntryId)) return undefined; return value; } catch { return undefined; }
}
function isPromptStructure(entry: SessionEntryLike): boolean {
  if (entry.type !== "message" || entry.message?.role !== "user") return false;
  const text = messageText(entry.message);
  const normalized = text.replace(/^<crew-delegation version="1">\s*/, "");
  return normalized.startsWith("You are ") && ["## Role", "## Authority", "## Working directory", "## Objective", "## Context", "## Constraints", "## Acceptance criteria", "## Required response"].every(section => normalized.includes(section));
}
function isGeneratedDelegationPrompt(entry: SessionEntryLike): boolean { return isPromptStructure(entry) && messageText(entry.message).includes('<crew-delegation version="1">'); }
function generatedSource(entry: SessionEntryLike): CrewContextSource | undefined { return isGeneratedDelegationPrompt(entry) ? parseSource(messageText(entry.message)) : undefined; }
export function findLatestDelegationPrompt(branch: SessionEntryLike[]): SessionEntryLike | undefined { return [...branch].reverse().find(isGeneratedDelegationPrompt); }
export function parseJsonlSession(raw: string): { sessionId: string; entries: SessionEntryLike[] } {
  const endsWithNewline = /\r?\n$/.test(raw);
  const lines = raw.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  if (!lines.length || (lines.length === 1 && !lines[0])) throw new Error("Native session is empty");
  const parsed: unknown[] = [];
  lines.forEach((line, index) => { try { parsed.push(JSON.parse(line)); } catch { if (!endsWithNewline && index === lines.length - 1) return; throw new Error(`Malformed native session JSONL at line ${index + 1}`); } });
  const header = parsed[0];
  if (!header || typeof header !== "object") throw new Error("Native session has an invalid header");
  const h = header as { type?: unknown; id?: unknown; sessionId?: unknown; session_id?: unknown };
  const sessionId = h.sessionId ?? h.session_id ?? h.id;
  if (h.type !== "session" || typeof sessionId !== "string") throw new Error("Native session has an invalid header");
  assertValidSessionId(sessionId);
  const entries = parsed.slice(1) as SessionEntryLike[];
  const ids = new Set<string>();
  for (const entry of entries) { if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || ids.has(entry.id)) throw new Error("Native session contains an invalid or duplicate entry ID"); ids.add(entry.id); }
  return { sessionId, entries };
}

export function resolveNativeSessionPath(sessionDir: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  const directory = resolve(sessionDir);
  const candidates = readdirSync(directory).filter(name => name.endsWith(`_${sessionId}.jsonl`));
  if (candidates.length !== 1) throw new Error("Invoking brain session could not be resolved unambiguously");
  const path = resolve(directory, candidates[0]);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Native session candidate is a symlink");
  if (!stat.isFile()) throw new Error("Native session candidate is not a regular file");
  const realDirectory = realpathSync(directory); const realPath = realpathSync(path);
  if (dirname(realPath) !== realDirectory) throw new Error("Native session candidate escapes the session directory");
  if (parseJsonlSession(readFileSync(realPath, "utf8")).sessionId !== sessionId) throw new Error("Brain session header ID mismatch");
  return realPath;
}
export function reconstructBranch(entries: SessionEntryLike[], upperBoundId: string): SessionEntryLike[] {
  const byId = new Map<string, SessionEntryLike>();
  for (const entry of entries) { if (!entry.id || byId.has(entry.id)) throw new Error("Native session contains duplicate or missing entry IDs"); byId.set(entry.id, entry); }
  const chain: SessionEntryLike[] = []; const visited = new Set<string>(); let cursor = byId.get(upperBoundId);
  if (!cursor) throw new Error(`upperBoundEntryId ${upperBoundId} was not found in the native session`);
  while (cursor) { if (!cursor.id || visited.has(cursor.id)) throw new Error("Native session branch contains a cycle"); visited.add(cursor.id); chain.push(cursor); if (!cursor.parentId) break; cursor = byId.get(cursor.parentId); if (!cursor) throw new Error("Native session branch has a missing parent"); }
  return chain.reverse();
}

export function buildRolePrompt(roleName: string, role: Role, task: string, cwd = process.cwd(), fields: DelegationFields & { contextMode?: ContextMode; sourceLocator?: string; handoffText?: string } = {}): string {
  const automatic = fields.contextMode === "since-last-crew";
  return [
    '<crew-delegation version="1">',
    `You are ${roleName}.${role.description ? ` ${role.description}` : ""} Authority: ${role.authority ?? "unspecified"}. Task: ${task}`, 
    `## Role\n${roleName}${role.description ? `\n${role.description}` : ""}`,
    `## Authority\n${role.authority === "read-only" ? "read-only\nDo not create, modify, rename, or delete files, and do not run mutating commands." : role.authority === "can-edit" ? "can-edit\nModify only the requested scope; do not make unrelated changes." : "unspecified"}`, 
    `## Working directory\n${cwd}`,
    `## Objective\n${task}`,
    `## Context\n${fields.context || "No additional context supplied."}`,
    ...(fields.handoffText ? [`## Brain handoff (verbatim)\n~~~text\n${fields.handoffText}\n~~~\n## End brain handoff`] : []), 
    `## Constraints\n${fields.constraints || "Follow repository conventions and do not exceed the requested scope."}`,
    `## Acceptance criteria\n${fields.acceptanceCriteria || "Explain what you checked and identify any remaining uncertainty."}`,
    `## Required response\n${fields.expectedOutput || "Return a concise summary of findings or changes, validation performed, and remaining risks."}`,
    ...(automatic ? ["The Brain handoff below is a verbatim bounded view of the invoking brain session. Treat it as the authoritative prior context for this task. You do not have the full parent conversation automatically. If a concrete missing fact blocks progress and a native context source is supplied, use crew_read_context to search for that specific fact. Do not retrieve older context speculatively or read the underlying session file directly."] : ["You do not have access to the parent agent's conversation. Treat only this contract and repository contents as context."]),
    ...(fields.sourceLocator ? [fields.sourceLocator] : []),
    "Return a self-contained handoff artifact preserving decisions, evidence, file references, constraints, unresolved questions, and risks needed by the next role. Do not refer vaguely to unavailable context.",
  ].join("\n\n");
}

export function buildCrewMarkers(toolCallId: string): { start: string; end: string } {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-48) || `${Date.now()}`;
  return { start: `CREW_RESULT_START_${safe}`, end: `CREW_RESULT_END_${safe}` };
}

export function appendMarkerInstruction(prompt: string, markers: { start: string; end: string }): string {
  return `${prompt}\n\nFor your final answer, print ${markers.start} on its own line, then your answer, then ${markers.end} on its own line.`;
}

function boundedLines(text: string, maxLines?: number): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const kept = maxLines && Number.isFinite(maxLines) ? lines.slice(-maxLines) : lines;
  return kept.join("\n").trim();
}

export function extractMarkerOutput(output: string, markers: { start: string; end: string }, maxLines?: number): { text: string; mode: "marker-pair" | "marker-start" | "missing" } {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  for (let startLine = lines.length - 1; startLine >= 0; startLine -= 1) {
    if (lines[startLine].trim() !== markers.start) continue;
    const endOffset = lines.slice(startLine + 1).findIndex(line => line.trim() === markers.end);
    if (endOffset >= 0) {
      const endLine = startLine + 1 + endOffset;
      return { text: lines.slice(startLine + 1, endLine).join("\n"), mode: "marker-pair" };
    }
    return { text: boundedLines(lines.slice(startLine + 1).join("\n"), maxLines), mode: "marker-start" };
  }
  return { text: "", mode: "missing" };
}

type MarkerOutput = ReturnType<typeof extractMarkerOutput>;

function mergeOverlappingText(previous: string, next: string): string {
  const previousLines = previous.replace(/\r\n/g, "\n").split("\n");
  const nextLines = next.replace(/\r\n/g, "\n").split("\n");
  const maxOverlap = Math.min(previousLines.length, nextLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previousLines.slice(-overlap).every((line, index) => line === nextLines[index])) {
      return [...previousLines, ...nextLines.slice(overlap)].join("\n");
    }
  }
  return [...previousLines, ...nextLines].join("\n");
}

export function updateMarkerOutput(previous: MarkerOutput, snapshot: string, markers: { start: string; end: string }): MarkerOutput {
  const observed = extractMarkerOutput(snapshot, markers);
  if (observed.mode === "marker-pair" || observed.mode === "marker-start") return observed;
  if (previous.mode !== "marker-start") return previous;

  const lines = snapshot.replace(/\r\n/g, "\n").split("\n");
  const endLine = lines.findIndex(line => line.trim() === markers.end);
  const continuation = (endLine >= 0 ? lines.slice(0, endLine) : lines).join("\n");
  return {
    text: mergeOverlappingText(previous.text, continuation),
    mode: endLine >= 0 ? "marker-pair" : "marker-start",
  };
}

export function compactRoleOutput(output: string, prompt: string, maxLines?: number): string {
  const normalized = output.replace(/\r\n/g, "\n");
  const promptIndex = normalized.lastIndexOf(prompt);
  const relevant = promptIndex >= 0 ? normalized.slice(promptIndex + prompt.length) : normalized;
  const lines = relevant
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const kept = maxLines && Number.isFinite(maxLines) ? lines.slice(-maxLines) : lines;
  return kept.join("\n").trim() || normalized.split("\n").slice(maxLines ? -maxLines : undefined).join("\n").trim();
}

function normalizedAgentStatus(agent: AgentLike): string {
  return String(agent.agent_status ?? agent.status ?? "").toLowerCase();
}

export function scopedRoleName(role: string, workspaceId: string, tabId?: string): string {
  const tabSuffix = tabId?.includes(":") ? tabId.split(":").pop() : tabId;
  const suffix = `${workspaceId}-${tabSuffix || "tab"}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  const maxRoleLength = Math.max(1, 31 - suffix.length);
  const safeRole = role.slice(0, maxRoleLength).replace(/-+$/g, "") || "r";
  return `${safeRole}-${suffix}`.slice(0, 32).replace(/-+$/g, "");
}

function roleNameInUse(agents: AgentLike[], name: string): boolean {
  return agents.some((agent) => agent.name === name);
}

function isKnownCrewAgentName(name: string, roleNames: Set<string>): boolean {
  for (const role of roleNames) {
    if (name === role || name.startsWith(`${role}-`)) return true;
  }
  return false;
}

export function isReusableRoleAgent(agent: AgentLike, role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): boolean {
  const status = normalizedAgentStatus(agent);
  return (
    agent.name === role &&
    (status === "idle" || status === "done") &&
    agent.workspace_id === workspaceId &&
    (!tabId || !agent.tab_id || agent.tab_id === tabId) &&
    (normalizedCwd(agent.foreground_cwd || agent.cwd || "") === normalizedCwd(cwd)) &&
    (!requestedModel || agent.model === requestedModel || agent.model_id === requestedModel) &&
    typeof agent.pane_id === "string" &&
    agent.pane_id.length > 0
  );
}

export function findReusableRolePane(agent: AgentLike | undefined, role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): string | undefined {
  return agent && isReusableRoleAgent(agent, role, workspaceId, cwd, tabId, requestedModel) ? agent.pane_id : undefined;
}

export function findReusableRolePaneInList(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): string | undefined {
  return agents.find((agent) => isReusableRoleAgent(agent, role, workspaceId, cwd, tabId, requestedModel))?.pane_id;
}

export function chooseAgentName(agents: AgentLike[], role: string, workspaceId: string, cwd: string, tabId?: string, requestedModel?: string): string {
  if (findReusableRolePaneInList(agents, role, workspaceId, cwd, tabId, requestedModel)) return role;
  const baseName = roleNameInUse(agents, role) ? scopedRoleName(role, workspaceId, tabId) : role;
  if (findReusableRolePaneInList(agents, baseName, workspaceId, cwd, tabId, requestedModel)) return baseName;
  if (!roleNameInUse(agents, baseName)) return baseName;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!roleNameInUse(agents, candidate)) return candidate;
  }
  throw new Error(`Could not choose an unused crew agent name for role ${role}`);
}

export function chooseSplitTarget(
  agents: AgentLike[],
  workspaceId: string,
  cwd: string,
  tabId?: string,
  roleNames = new Set(Object.keys(DEFAULT_ROLES)),
): { args: string[]; policy: "below-existing-crew" | "right-of-current" } {
  const crew = agents.find(
    (agent) =>
      !!agent.pane_id &&
      !!agent.name &&
      isKnownCrewAgentName(agent.name, roleNames) &&
      agent.workspace_id === workspaceId &&
      (!tabId || !agent.tab_id || agent.tab_id === tabId) &&
      (agent.foreground_cwd === cwd || agent.cwd === cwd),
  );
  if (crew?.pane_id) {
    return { args: ["pane", "split", crew.pane_id, "--direction", "down", "--cwd", cwd, "--no-focus"], policy: "below-existing-crew" };
  }
  return { args: ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"], policy: "right-of-current" };
}

function parseJson(stdout: string, context: string): any {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse ${context} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expectOk(result: ExecResult, context: string): void {
  if (result.code !== 0) {
    throw new Error(`${context} failed with code ${result.code}: ${result.stderr || result.stdout}`);
  }
}

async function herdr(pi: ExtensionAPI, args: string[], timeout = PROMPT_TIMEOUT_MS): Promise<ExecResult> {
  return pi.exec("herdr", args, { timeout });
}

async function readAgent(pi: ExtensionAPI, role: string, lines: number): Promise<string> {
  const result = await herdr(pi, ["agent", "read", role, "--source", "recent-unwrapped", "--lines", String(lines)]);
  expectOk(result, `herdr agent read ${role}`);
  return result.stdout || result.stderr;
}

async function readPane(pi: ExtensionAPI, paneId: string, lines: number): Promise<string> {
  const result = await herdr(pi, ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]);
  expectOk(result, `herdr pane read ${paneId}`);
  return result.stdout || result.stderr;
}

type StartupState = { agent?: AgentLike; status: "ready" | "blocked" | "timed_out"; output?: string };

export function isStartupBlockedOutput(output: string): boolean {
  return /trust project folder\?|approval required|waiting for (?:user )?approval/i.test(output);
}

async function waitForAgentReady(pi: ExtensionAPI, paneId: string, timeoutMs: number): Promise<StartupState> {
  const deadline = Date.now() + timeoutMs;
  let readySince: number | undefined;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const agents = await listAgents(pi);
    const agent = agents.find(item => item.pane_id === paneId);
    if (agent) {
      const status = normalizedAgentStatus(agent);
      if (status === "blocked") return { agent, status: "blocked" };
      if (status === "idle" || status === "done") {
        lastOutput = await readPane(pi, paneId, FAILURE_READ_LINES);
        if (isStartupBlockedOutput(lastOutput)) return { agent, status: "blocked", output: lastOutput };
        readySince ??= Date.now();
        if (Date.now() - readySince >= STARTUP_READY_STABLE_MS) return { agent, status: "ready", output: lastOutput };
      } else {
        readySince = undefined;
      }
    } else {
      readySince = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(STARTUP_POLL_MS, Math.max(50, deadline - Date.now()))));
  }
  return { status: "timed_out", output: lastOutput || undefined };
}

type CrewStatus = "done" | "idle" | "working" | "blocked" | "timed_out" | "failed" | "unknown";
export function classifyAgentStatus(value: unknown): CrewStatus {
  const status = String(value ?? "").toLowerCase().replace(/[- ]/g, "_");
  if (status.includes("block")) return "blocked";
  if (status.includes("timeout") || status.includes("timed_out")) return "timed_out";
  if (status.includes("fail") || status.includes("error")) return "failed";
  if (status === "working" || status === "busy" || /(?:^|[\\s"'])status[\\s"':=]+(?:working|busy)/.test(status)) return "working";
  if (status === "done" || status === "completed" || status === "complete" || /(?:^|[\\s"'])status[\\s"':=]+(?:done|completed|complete)/.test(status)) return "done";
  if (status === "idle" || status === "ready" || /(?:^|[\\s"'])status[\\s"':=]+(?:idle|ready)/.test(status)) return "idle";
  return "unknown";
}

async function maybeGetAgent(pi: ExtensionAPI, role: string): Promise<AgentLike | undefined> {
  const result = await herdr(pi, ["agent", "get", role]);
  if (result.code !== 0) return undefined;
  return parseJson(result.stdout, "herdr agent get").result?.agent;
}

async function listAgents(pi: ExtensionAPI): Promise<AgentLike[]> {
  const result = await herdr(pi, ["agent", "list"]);
  expectOk(result, "herdr agent list");
  return parseJson(result.stdout, "herdr agent list").result?.agents ?? [];
}

export async function functionalPreflight(pi: ExtensionAPI): Promise<ExecResult> {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("I am not currently running inside Herdr (HERDR_ENV must equal 1).");
  }
  return pi.exec("herdr", ["pane", "current", "--current"]);
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`crew_launch ${name} must be a positive integer`);
  }
  return value;
}

export function normalizeTask(value: unknown, fields: DelegationFields = {}): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("crew_launch requires a non-blank task string");
  const task = value.trim();
  const supplemental = [fields.context, fields.constraints, fields.acceptanceCriteria, fields.expectedOutput]
    .filter(value => typeof value === "string" && value.trim().length >= 20)
    .join(" ");
  const unresolvedOnly = /^(?:please\s+)?(?:implement|fix|review|do|follow|continue)\s+(?:it|that|this|the plan(?: above)?|the above|above)(?:\s+(?:in|from|using)\b.*)?[.!]?$/i;
  if (unresolvedOnly.test(task) && !supplemental) throw new Error("Delegation contract is incomplete: replace the unresolved task reference with an explicit objective, or supply concrete context, constraints, acceptance criteria, or expected output.");
  return task;
}

export function normalizeCommand(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error("crew_launch command must be a non-blank Pi slash command");
  const command = value.trim();
  if (!command.startsWith("/") || command.includes("\n") || command.includes("\r") || command.length > 512) throw new Error("crew_launch command must be a single Pi slash command beginning with / and no longer than 512 characters");
  return command;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("crew_launch was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("crew_launch was cancelled")); }, { once: true });
  });
}

type CrewLaunchParams = DelegationFields & {
  role?: string; task?: string; command?: string; contextMode?: ContextMode; checkpointFallback?: CheckpointFallback; recentTurns?: number; maxHandoffChars?: number; startupTimeoutMs?: number; timeoutMs?: number; readLines?: number; configCwd?: string; toolCallId?: string;
};

export function parseModelCatalog(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const slash = line.match(/\b([A-Za-z0-9._-]+)\/([A-Za-z0-9._:~-]+)\b/);
    if (slash) { models.push(`${slash[1]}/${slash[2]}`); continue; }
    // `pi --list-models` prints provider and model as separate whitespace columns.
    const columns = line.trim().split(/\s{2,}|\t+/).map(x => x.trim()).filter(Boolean);
    if (columns.length >= 2 && /^[A-Za-z][A-Za-z0-9._-]*$/.test(columns[0]) && /^[A-Za-z0-9._:~-]+$/.test(columns[1]) && !/^provider$/i.test(columns[0]) && !/^model$/i.test(columns[1])) {
      models.push(`${columns[0]}/${columns[1]}`);
    }
  }
  return [...new Set(models)];
}
export function modelMatch(requested: string, catalog: string[]): "exact" | "fuzzy" | "none" {
  if (catalog.includes(requested)) return "exact";
  const suffix = requested.split("/").pop()?.toLowerCase() ?? "";
  return catalog.some(id => {
    const candidate = id.split("/").pop()?.toLowerCase() ?? "";
    return suffix === "ds4-flash" && candidate.includes("deepseek-v4-flash");
  }) ? "fuzzy" : "none";
}

async function executeCrewLaunch(pi: ExtensionAPI, params: CrewLaunchParams, signal?: AbortSignal, onUpdate?: ToolUpdate, ctx?: ExtensionContext) {
  const roleName = params.role ?? "scout";
  assertValidRoleName(roleName);
  const task = normalizeTask(params.task, params);
  const command = normalizeCommand(params.command);
  const startupTimeoutMs = positiveInteger(params.startupTimeoutMs, STARTUP_TIMEOUT_MS, "startupTimeoutMs");
  const timeoutMs = positiveInteger(params.timeoutMs, PROMPT_TIMEOUT_MS, "timeoutMs");
  const readLines = positiveInteger(params.readLines, DEFAULT_READ_LINES, "readLines");
  const contextMode = params.contextMode ?? "since-last-crew";
  const fallback = params.checkpointFallback ?? "recent";
  const recentTurns = positiveInteger(params.recentTurns, 6, "recentTurns");
  const maxHandoffChars = positiveInteger(params.maxHandoffChars, 24_000, "maxHandoffChars");
  const handoff = ctx && params.toolCallId ? buildHandoff(ctx.sessionManager.getBranch(), params.toolCallId, contextMode, fallback, recentTurns, maxHandoffChars, params.context) : undefined;
  const effectiveAutomatic = contextMode === "since-last-crew" && handoff?.fallbackUsed !== "explicit";
  const current = await functionalPreflight(pi);
  expectOk(current, "herdr pane current");
  const currentPane = parseJson(current.stdout, "herdr pane current").result?.pane;
  const reportedCwd = currentPane?.foreground_cwd || currentPane?.cwd;
  if (!reportedCwd) throw new Error("herdr pane current did not report a cwd");
  const roleCwd = normalizedCwd(reportedCwd);
  const workspaceId = currentPane?.workspace_id || "";
  const tabId = currentPane?.tab_id || "";
  const { config, path: configPath } = loadCrewConfig(params.configCwd ?? roleCwd);
  const roleNames = new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(config.roles ?? {})]);
  const role = resolveRole(roleName, config);
  const source = effectiveAutomatic && ctx?.sessionManager.getSessionFile() && ctx.sessionManager.getLeafId() && ctx.sessionManager.getSessionId() ? { version: 1 as const, brainSessionId: ctx.sessionManager.getSessionId(), checkpointEntryId: handoff?.semanticCheckpointEntryId, retrievalCutoffEntryId: handoff?.retrievalCutoffEntryId, upperBoundEntryId: ctx.sessionManager.getLeafId()! } : undefined;
  const basePrompt = buildRolePrompt(roleName, role, task, roleCwd, { ...params, context: params.context, handoffText: effectiveAutomatic ? handoff?.automaticText : undefined, contextMode: effectiveAutomatic ? "since-last-crew" : "explicit", sourceLocator: source ? sourceLocatorBlock(source) : undefined });
  // Native slash-command execution is intentionally not exposed until Herdr can submit a separate input.
  const commandPrompt = basePrompt;
  const markers = buildCrewMarkers(params.toolCallId ?? "crew_launch");
  const prompt = appendMarkerInstruction(commandPrompt, markers);
  const baseCommand = selectLaunchCommand();
  const launchModel = role.model;
  if (launchModel) {
    const catalogResult = await pi.exec(selectDiscoveryCommand(), ["--list-models"], { timeout: 10_000 });
    const catalog = parseModelCatalog(catalogResult.stdout);
    if (catalogResult.code !== 0 || modelMatch(launchModel, catalog) !== "exact") {
      const nearby = catalog.filter(id => id.toLowerCase().includes(launchModel.toLowerCase().split("/").pop() ?? "")).slice(0, 5);
      throw new Error(`Configured model ${launchModel} is not an exact match in the launch catalog.${nearby.length ? ` Nearby matches: ${nearby.join(", ")}` : " No nearby matches found."}`);
    }
  }
  const roleCommand = buildRoleCommand(baseCommand, launchModel, ctx?.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionDir() : undefined);

  let agents = await listAgents(pi);
  let agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId, role.model);
  let paneId = findReusableRolePaneInList(agents, agentName, workspaceId, roleCwd, tabId, role.model);
  let createdPane: string | undefined;
  let splitPolicy: string | undefined;
  let renameConflictRecovered = false;

  if (!paneId) {
    const split = chooseSplitTarget(agents, workspaceId, roleCwd, tabId, roleNames);
    splitPolicy = split.policy;
    const splitResult = await herdr(pi, split.args);
    expectOk(splitResult, "herdr pane split");
    paneId = parseJson(splitResult.stdout, "herdr pane split").result?.pane?.pane_id;
    if (!paneId) throw new Error("herdr pane split did not return pane_id");
    createdPane = paneId;

    const runResult = await herdr(pi, ["pane", "run", paneId, roleCommand]);
    expectOk(runResult, "herdr pane run");

    const startup = await waitForAgentReady(pi, paneId, startupTimeoutMs);
    if (startup.status !== "ready") {
      const output = startup.output ?? await readPane(pi, paneId, FAILURE_READ_LINES);
      const message = startup.status === "blocked"
        ? `agent startup is blocked in pane ${paneId}; inspect the pane and resolve the interactive prompt before retrying.`
        : `agent was not ready in pane ${paneId} within startupTimeoutMs=${startupTimeoutMs}; the process may still be loading.`;
      const error = new Error(`${message}\n\n${output}`) as Error & { details?: unknown };
      error.details = { paneId, status: startup.status === "blocked" ? "startup_blocked" : "startup_timeout", startupTimeoutMs, agentContinues: true, output };
      throw error;
    }

    let rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
    if (rename.code !== 0 && /agent_name_taken/.test(rename.stderr || rename.stdout)) {
      agents = await listAgents(pi);
      agentName = chooseAgentName(agents, roleName, workspaceId, roleCwd, tabId, role.model);
      rename = await herdr(pi, ["agent", "rename", paneId, agentName]);
      renameConflictRecovered = rename.code === 0;
    }
    expectOk(rename, "herdr agent rename");
  }

  onUpdate?.({ content: [{ type: "text", text: `Starting ${roleName}…` }], details: { role: roleName, agentName, paneId, status: "starting" } });
  const promptResult = await herdr(pi, ["agent", "prompt", agentName, prompt], 10_000);
  if (promptResult.code !== 0) {
    const diagnostic = await readAgent(pi, agentName, FAILURE_READ_LINES);
    throw new Error(`crew role prompt submission failed for ${agentName}: ${promptResult.stderr || promptResult.stdout}\n\n${diagnostic}`);
  }

  const submittedAt = Date.now();
  let lastProgressAt = submittedAt;
  let previousEvidence = "";
  let observedWorking = false;
  let heartbeatCount = 0;
  let output = "";
  let currentAgent: AgentLike | undefined;
  let lastKnownAgent: AgentLike | undefined;
  let agentExited = false;
  let status: CrewStatus = "unknown";
  let markerOutput = extractMarkerOutput("", markers);

  while (true) {
    if (signal?.aborted) throw new Error("crew_launch was cancelled");
    currentAgent = await maybeGetAgent(pi, agentName);
    if (currentAgent) lastKnownAgent = currentAgent;
    status = classifyAgentStatus(currentAgent?.agent_status || currentAgent?.status);
    output = currentAgent
      ? await readAgent(pi, agentName, Math.max(readLines, MARKER_READ_LINES))
      : await readPane(pi, paneId, Math.max(readLines, MARKER_READ_LINES));
    markerOutput = updateMarkerOutput(markerOutput, output, markers);
    const settled = status === "done" || status === "idle";
    const evidence = `${status}\n${output}`;
    if (evidence !== previousEvidence) {
      previousEvidence = evidence;
      lastProgressAt = Date.now();
    }
    if (status === "working") {
      observedWorking = true;
      // A positively working role is alive even when its visible output is unchanged.
      lastProgressAt = Date.now();
    }
    if (!currentAgent && Date.now() - submittedAt >= PROMPT_START_GRACE_MS) {
      agentExited = true;
      status = markerOutput.mode === "marker-pair" ? "done" : "failed";
      break;
    }

    if (markerOutput.mode === "marker-pair" && settled) break;
    if (status === "blocked" || status === "failed") break;
    if (observedWorking && settled) break;
    if (!observedWorking && settled && Date.now() - submittedAt >= PROMPT_START_GRACE_MS) break;
    if (Date.now() - lastProgressAt >= timeoutMs) {
      status = "timed_out";
      break;
    }

    heartbeatCount += 1;
    const dots = ".".repeat((heartbeatCount - 1) % 3 + 1);
    onUpdate?.({
      content: [{ type: "text", text: `Processing ${roleName}${dots}` }],
      details: { role: roleName, agentName, paneId, status, heartbeat: heartbeatCount, elapsedMs: Date.now() - submittedAt },
    });
    const pollMs = observedWorking ? ROLE_POLL_MS : Math.min(1_000, ROLE_POLL_MS);
    await delay(pollMs, signal);
  }

  const settled = status === "done" || status === "idle";
  const complete = settled && markerOutput.mode === "marker-pair";
  const agentContinues = status === "working" || status === "timed_out" || status === "blocked" || status === "unknown";

  const compactOutput = complete && markerOutput.text
    ? markerOutput.text
    : `[CREW STATUS: ${status}; complete: false] ${settled ? "The role settled without a confirmed final marker pair; this is incomplete diagnostic output, not a final answer." : "The role did not complete. This is partial diagnostic output, not a final answer."}\n\n${compactRoleOutput(output, prompt, readLines)}`;
  return {
    content: [{ type: "text", text: compactOutput }],
    details: {
      version: VERSION,
      role: roleName,
      agentName,
      tabId,
      paneId,
      createdPane,
      reusedPane: !createdPane,
      workspaceId,
      cwd: roleCwd,
      command: baseCommand,
      requestedModel: role.model ?? null,
      actualModel: lastKnownAgent?.model ?? lastKnownAgent?.model_id ?? null,
      actualModelKnown: !!(lastKnownAgent?.model ?? lastKnownAgent?.model_id),
      modelWarning: role.model && lastKnownAgent?.model && lastKnownAgent.model !== role.model ? `Running model ${lastKnownAgent.model} differs from requested ${role.model}.` : (!createdPane && role.model ? "Reused pane model was not queried." : null),
      status,
      complete,
      agentContinues,
      agentExited,
      heartbeatCount,
      elapsedMs: Date.now() - submittedAt,
      authority: role.authority ?? null,
      configPath: configPath ?? null,
      splitPolicy: splitPolicy ?? null,
      renameConflictRecovered,
      markerFound: markerOutput.mode !== "missing",
      extractionMode: markerOutput.mode === "missing" ? "prompt-fallback" : markerOutput.mode,
      extractionWarning: markerOutput.mode !== "marker-pair" || !complete ? "No confirmed final marker pair for a completed delegation." : null,
      outputLineCount: output.split(/\r?\n/).filter(Boolean).length,
      markerCaptureLines: Math.max(readLines, MARKER_READ_LINES),
      compactOutputLineCount: compactOutput.split(/\r?\n/).filter(Boolean).length,
      contextMode,
      contextSourceIncluded: !!source,
      brainSessionId: source?.brainSessionId ?? null,
      checkpointEntryId: handoff?.checkpointEntryId ?? null,
      upperBoundEntryId: source?.upperBoundEntryId ?? null,
      handoffEntryCount: handoff?.entries.length ?? 0,
      handoffCharCount: handoff?.text.length ?? 0,
      checkpointFallbackUsed: handoff?.fallbackUsed ?? false,
    },
  };
}

const crewQueues = new Map<string, Promise<void>>();
function enqueueCrewLaunch<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = crewQueues.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  crewQueues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

type CrewRulesParams = { configCwd?: string };

async function executeCrewRules(pi: ExtensionAPI, params: CrewRulesParams = {}) {
  let configCwd = params.configCwd;
  if (!configCwd) {
    const current = await herdr(pi, ["pane", "current", "--current"]);
    if (current.code === 0) configCwd = parseJson(current.stdout, "herdr pane current").result?.pane?.foreground_cwd || parseJson(current.stdout, "herdr pane current").result?.pane?.cwd;
  }
  const { config, path: configPath } = loadCrewConfig(configCwd ?? process.cwd());
  const roleNames = [...new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(config.roles ?? {})])].sort();
  const catalogResult = await pi.exec(selectDiscoveryCommand(), ["--list-models"], { timeout: 10_000 });
  const catalog = parseModelCatalog(catalogResult.stdout);
  const roles = Object.fromEntries(roleNames.map((name) => {
    const role = resolveRole(name, config);
    const modelState = role.model ? modelMatch(role.model, catalog) : "default";
    const catalogPresent = role.model ? (catalogResult.code === 0 && modelState === "exact") : null;
    return [name, { description: role.description ?? null, authority: role.authority ?? null, configured: role.model ?? null,
      model: role.model ?? null, modelState, catalogPresent, authenticationUnknown: true,
      launchable: role.model ? catalogPresent : true, currentlyUsed: null }];
  }));
  return {
    content: [{ type: "text", text: JSON.stringify({ configPath: configPath ?? null, roles }, null, 2) }],
    details: { version: VERSION, configPath: configPath ?? null, roles },
  };
}

export type ReadContextParams = { mode?: string; query?: string; entryId?: string; maxChars?: number; cursor?: string };
export function encodeCursor(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
export function decodeCursor(value: string): any { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!parsed || typeof parsed !== "object") throw new Error(); return parsed; } catch { throw new Error("Invalid cursor"); } }
export function calculateReadBudget(priorCount: number, usedChars: number, returnedChars: number): { remainingChars: number; remainingCalls: number } {
  return { remainingChars: 24_000 - usedChars - returnedChars, remainingCalls: 4 - priorCount - 1 };
}
export function selectReadableEntries(entries: SessionEntryLike[]): SessionEntryLike[] { return entries.filter(e => eligibleEntry(e) && !!entryText(e)); }
export function searchContext(entries: SessionEntryLike[], query: string, maxHits = 20): SessionEntryLike[] { const q = query.toLocaleLowerCase(); return entries.filter(e => entryText(e).toLocaleLowerCase().includes(q)).slice(0, maxHits); }
export function readContextEntry(entries: SessionEntryLike[], id: string): SessionEntryLike { const e = entries.find(x => x.id === id && eligibleEntry(x)); if (!e) throw new Error("entryId is outside the allowed range"); return e; }
export function readContextAround(entries: SessionEntryLike[], id: string, radius = 2): SessionEntryLike[] { const i = entries.findIndex(x => x.id === id); if (i < 0 || !eligibleEntry(entries[i])) throw new Error("entryId is outside the allowed range"); return entries.slice(Math.max(0, i-radius), i+radius+1).filter(eligibleEntry); }
export function findLatestDelegationContext(branch: SessionEntryLike[]): { prompt: SessionEntryLike; source: CrewContextSource } {
  const prompt = [...branch].reverse().find(isPromptStructure); const source = prompt && isGeneratedDelegationPrompt(prompt) ? generatedSource(prompt) : undefined;
  if (!prompt || !source) throw new Error("No valid crew context source locator found");
  return { prompt, source };
}
function readContextParameters() { return { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["search", "entry", "around"] }, query: { type: "string" }, entryId: { type: "string" }, maxChars: { type: "number" }, cursor: { type: "string" } }, additionalProperties: false }; }
async function executeReadContext(p: ReadContextParams, roleCtx: ExtensionContext) {
  const roleBranch = roleCtx.sessionManager.getBranch(); const { prompt, source } = findLatestDelegationContext(roleBranch);
  const native = parseJsonlSession(readFileSync(resolveNativeSessionPath(roleCtx.sessionManager.getSessionDir(), source.brainSessionId), "utf8"));
  const branch = reconstructBranch(native.entries, source.upperBoundEntryId); const cutoffId = source.retrievalCutoffEntryId ?? source.checkpointEntryId;
  const cutoff = cutoffId ? branch.findIndex(e => e.id === cutoffId) : branch.length; if (cutoff < 0) throw new Error("Retrieval cutoff is not on the frozen branch");
  const promptIndex = branch.findIndex(e => e.id === prompt.id);
  const end = Math.min(cutoff, promptIndex < 0 ? cutoff : promptIndex);
  const readable = selectReadableEntries(branch.slice(0, end));
  const rolePromptIndex = roleBranch.findIndex(e => e.id === prompt.id);
  if (rolePromptIndex < 0) throw new Error("Delegation prompt is not on the active role branch");
  const reads = roleBranch.slice(rolePromptIndex + 1).filter(e => e.message?.role === "toolResult" && e.message.toolName === "crew_read_context");
  const used = reads.reduce((n, e) => n + (typeof e.message?.details?.returnedChars === "number" ? e.message.details.returnedChars : 0), 0);
  if (reads.length >= 4 || used >= 24_000) throw new Error("crew_read_context budget exhausted");
  const requestedLimit = p.maxChars === undefined ? 6000 : p.maxChars; if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 8000) throw new Error("maxChars must be an integer from 1 through 8000"); const limit = Math.min(requestedLimit, 24_000 - used); if (limit < 1) throw new Error("crew_read_context character budget exhausted");
  if (p.mode !== "search" && p.mode !== "entry" && p.mode !== "around") throw new Error("mode must be search, entry, or around");
  let selected: SessionEntryLike[];
  let candidateIndices: number[] = [];
  let startIndex = 0;
  let offset = 0;
  let cursorState: any;
  if (p.cursor) {
    cursorState = decodeCursor(p.cursor);
    if (cursorState.version !== 1 || cursorState.source !== source.upperBoundEntryId || cursorState.mode !== p.mode || !Array.isArray(cursorState.indices) || !cursorState.indices.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < readable.length) || !Number.isInteger(cursorState.nextIndex) || cursorState.nextIndex < 0 || cursorState.nextIndex > cursorState.indices.length) throw new Error("Invalid cursor");
    candidateIndices = cursorState.indices; startIndex = cursorState.nextIndex; offset = Number.isInteger(cursorState.offset) ? cursorState.offset : 0;
    selected = candidateIndices.slice(startIndex).map(i => readable[i]);
    // Cursor selection is reconstructed from the validated candidate indices above.
  } else if (p.mode === "search") {
    if (!p.query?.trim()) throw new Error("search requires a non-blank query");
    selected = searchContext(readable, p.query); candidateIndices = selected.map(e => readable.findIndex(x => x.id === e.id));
  } else {
    if (!p.entryId) throw new Error("entryId is required");
    selected = p.mode === "around" ? readContextAround(readable, p.entryId) : [readContextEntry(readable, p.entryId)]; candidateIndices = selected.map(e => readable.findIndex(x => x.id === e.id));
  }
  const chunks: string[] = [];
  let consumed = 0;
  for (const entry of selected) {
    const serialized = serializeSessionEntries([entry]);
    const available = limit - consumed;
    if (serialized.length <= available) { chunks.push(serialized); consumed += serialized.length; startIndex += 1; offset = 0; continue; }
    const part = serialized.slice(offset, offset + Math.max(0, available));
    if (part) chunks.push(part);
    offset += part.length;
    break;
  }
  const text = chunks.join("\n\n");
  const hasMore = startIndex < candidateIndices.length && selected.length > 0;
  const nextCursor = hasMore ? encodeCursor({ version: 1, source: source.upperBoundEntryId, mode: p.mode, indices: candidateIndices, nextIndex: startIndex, offset }) : undefined;
  const budget = calculateReadBudget(reads.length, used, text.length);
  return { content: [{ type: "text", text }], details: { sourceBrainSessionId: source.brainSessionId, sourceCheckpointEntryId: source.checkpointEntryId ?? null, sourceUpperBoundEntryId: source.upperBoundEntryId, mode: p.mode, matchedEntryIds: selected.map(e => e.id).filter(Boolean), returnedChars: text.length, remainingChars: budget.remainingChars, remainingCalls: budget.remainingCalls, truncated: !!nextCursor, nextCursor } };
}

export function crewExtension(pi: ExtensionAPI) {
  const parameters = { type: "object", required: ["role", "task"], properties: {
    role: { type: "string", description: "Crew role name, such as scout, oracle, executor, or reviewer." },

    task: { type: "string", description: "Self-contained delegation objective. Automatic mode supplies a bounded handoff; explicit mode uses caller context only. Put concrete supporting information in context, constraints, acceptanceCriteria, and expectedOutput; avoid unresolved references such as 'implement it'." },
    context: { type: "string", description: "Relevant prior decisions, files, findings, or requirements." }, constraints: { type: "string", description: "Boundaries and invariants." },
    acceptanceCriteria: { type: "string", description: "How the result should be judged." }, expectedOutput: { type: "string", description: "Required response format." },
    startupTimeoutMs: { type: "number", description: "Maximum startup detection wait. Defaults to 120000." }, timeoutMs: { type: "number", description: "Maximum inactivity wait after prompt submission. Progress and a working agent refresh this timeout. Defaults to 120000." }, readLines: { type: "number", description: "Recent output lines. Defaults to 200." }, contextMode: { type: "string", enum: ["explicit", "since-last-crew"] }, checkpointFallback: { type: "string", enum: ["recent", "explicit", "error"] }, recentTurns: { type: "number" }, maxHandoffChars: { type: "number" }, configCwd: { type: "string", description: "Explicit config lookup override." },
  }, additionalProperties: false };
  const execute = async (toolCallId: string, rawParams: unknown, signal?: AbortSignal, onUpdate?: ToolUpdate, ctx?: ExtensionContext) => {
    const params = { ...((rawParams ?? {}) as CrewLaunchParams), toolCallId };
    const authority = DEFAULT_ROLES[params.role ?? "scout"]?.authority ?? (params.configCwd ? resolveRole(params.role ?? "scout", loadCrewConfig(params.configCwd).config).authority : "can-edit");
    const key = authority === "read-only" ? `readonly:${normalizedCwd(params.configCwd ?? process.cwd())}:${Date.now()}:${Math.random()}` : `writer:${params.configCwd ? normalizedCwd(params.configCwd) : "pane"}`;
    return enqueueCrewLaunch(key, () => executeCrewLaunch(pi, params, signal, onUpdate, ctx));
  };
  pi.registerTool({ name: "crew_launch", label: "Crew Launch", executionMode: "sequential", description: "Run or reuse a visible Herdr role pane and return structured status.", promptSnippet: "Delegate a self-contained task to a visible crew role pane.", promptGuidelines: ["Use crew_launch for delegation.", "Use explicit context when automatic handoff is disabled; keep delegation objectives concrete."], parameters, execute });
  pi.registerTool({ name: "crew_read_context", label: "Crew Read Context", description: "Read a bounded older passage from the invoking brain session.", parameters: readContextParameters(), async execute(_id, raw, _signal, _update, roleCtx) {
    if (!roleCtx) throw new Error("crew_read_context is unavailable without native session context");
    return executeReadContext((raw ?? {}) as ReadContextParams, roleCtx);
  } });


  pi.registerTool({
    name: "crew_rules",
    label: "Crew Rules",
    description: "Load resolved crew role configuration: descriptions, authority, models, and config source.",
    promptSnippet: "Inspect configured crew roles and models.",
    parameters: {
      type: "object",
      properties: {
        configCwd: { type: "string", description: "Directory for project .pi/crew.config.json lookup. Defaults to current process cwd." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawParams) {
      return executeCrewRules(pi, (rawParams ?? {}) as CrewRulesParams);
    },
  });
}

export default crewExtension;
