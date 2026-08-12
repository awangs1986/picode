import { readFileSync } from "node:fs";
import { ContextGovernor, type ContextGovernorMessage } from "../src/devloop/context/context-governor.ts";

interface BlobRef { __claude_tap_blob_ref__: { hash: string } }
interface CompactTrace {
  records: Array<{ record: { request: { body: Record<string, unknown> } } }>;
  blobs: Record<string, { payload: unknown }>;
}

function expand(value: unknown, blobs: CompactTrace["blobs"]): unknown {
  if (Array.isArray(value)) return value.map((entry) => expand(entry, blobs));
  if (value === null || typeof value !== "object") return value;
  const reference = value as Partial<BlobRef>;
  if (reference.__claude_tap_blob_ref__ !== undefined) {
    return expand(blobs[reference.__claude_tap_blob_ref__.hash]?.payload, blobs);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry, blobs)]));
}

function responseItemsToMessages(items: unknown[]): ContextGovernorMessage[] {
  const messages: ContextGovernorMessage[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "function_call_output") {
      messages.push({
        role: "toolResult",
        toolCallId: String(row.call_id ?? "unknown"),
        toolName: "captured-provider-tool",
        content: [{ type: "text", text: typeof row.output === "string" ? row.output : JSON.stringify(row.output) }],
        isError: false,
      });
      continue;
    }
    if (row.type === "reasoning") {
      messages.push({ role: "assistant", content: [{ type: "thinking", thinking: JSON.stringify(row) }] });
      continue;
    }
    if (row.type === "message") {
      messages.push({ role: String(row.role ?? "user"), content: row.content });
      continue;
    }
    if (row.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [{
          type: "toolCall",
          id: String(row.id ?? row.call_id ?? "unknown"),
          name: String(row.name ?? "unknown"),
          arguments: typeof row.arguments === "string" ? row.arguments : row.arguments ?? {},
        }],
      });
    }
  }
  return messages;
}

const tracePath = process.argv[2];
if (tracePath === undefined) throw new Error("Usage: tsx scripts/context-trace-regression.ts <captured.ctap.json>");
const trace = JSON.parse(readFileSync(tracePath, "utf8")) as CompactTrace;
const body = expand(trace.records[0]?.record.request.body, trace.blobs) as Record<string, unknown>;
const input = Array.isArray(body.input) ? body.input : [];
const messages = responseItemsToMessages(input);
const tools = Array.isArray(body.tools)
  ? body.tools.map((tool) => {
      const row = tool as Record<string, unknown>;
      return {
        name: String(row.name ?? "unknown"),
        description: typeof row.description === "string" ? row.description : undefined,
        parameters: row.parameters,
      };
    })
  : [];
const result = new ContextGovernor().prepareRequest({
  messages,
  systemPrompt: typeof body.instructions === "string" ? body.instructions : "",
  tools,
  declaredContextWindow: 1_000_000,
  maxOutputTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : 128_000,
  thirdPartyGateway: true,
});

const report = {
  sourceItems: input.length,
  compiledMessages: messages.length,
  action: result.action,
  beforeTokens: result.before.totalTokens,
  afterTokens: result.after.totalTokens,
  hardInputTokens: result.budget.hardInputTokens,
  effectiveContextWindow: result.budget.effectiveContextWindow,
  stats: result.stats,
};
console.log(JSON.stringify(report, null, 2));
if (result.action !== "compact" || result.after.totalTokens > result.budget.hardInputTokens) process.exitCode = 1;
