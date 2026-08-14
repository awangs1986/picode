import type {
  ContextArtifactRef,
  ContextArtifactStorePort,
} from "../../shared/types.ts";

export interface ToolOutputContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolOutputRetentionInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  content: ToolOutputContentBlock[];
}

export interface ToolOutputRetentionResult {
  retained: boolean;
  content: ToolOutputContentBlock[];
  artifact?: ContextArtifactRef;
}

const DEFAULT_MAX_INLINE_BYTES = 64 * 1024;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(text.length - length)) <= maxBytes) low = length;
    else high = length - 1;
  }
  return text.slice(text.length - low);
}

function boundedEnvelope(
  text: string,
  maxBytes: number,
  notice: string,
): string {
  const separator = "\n\n…\n\n";
  const noticeBytes = utf8Bytes(notice);
  if (noticeBytes >= maxBytes) return takeUtf8Prefix(notice, maxBytes);
  const previewBudget = maxBytes - noticeBytes - utf8Bytes(separator);
  const headBudget = Math.max(0, Math.floor(previewBudget / 2));
  const tailBudget = Math.max(0, previewBudget - headBudget);
  const envelope = `${takeUtf8Prefix(text, headBudget)}${separator}${takeUtf8Suffix(text, tailBudget)}${notice}`;
  return utf8Bytes(envelope) <= maxBytes ? envelope : takeUtf8Prefix(envelope, maxBytes);
}

/**
 * Compile one accepted tool result into bounded model-visible content. The
 * complete value moves to Store; this module owns only the retention policy.
 */
export async function retainToolOutput(
  input: ToolOutputRetentionInput,
  store: ContextArtifactStorePort,
  options: { maxInlineBytes?: number } = {},
): Promise<ToolOutputRetentionResult> {
  const maxInlineBytes = Math.max(1_024, options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES);
  if (input.content.length === 0 || input.content.some((block) => block.type !== "text" || typeof block.text !== "string")) {
    return { retained: false, content: input.content };
  }
  const fullText = input.content.map((block) => block.text ?? "").join("\n");
  if (utf8Bytes(fullText) <= maxInlineBytes) return { retained: false, content: input.content };

  const saved = await store.saveContextArtifact({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    text: fullText,
  });
  const notice = saved.ok
    ? `\n\n[Picode retained ${saved.value.bytes} bytes outside active context. ` +
      `Full result: ${saved.value.path}. Use read with offset/limit, or grep this path to search within it. ` +
      `sha256=${saved.value.sha256}]`
    : `\n\n[Picode artifact storage failed (${saved.error.code}); the oversized full output was omitted ` +
      `to protect the provider request. Re-run the tool with a narrower query.]`;
  return {
    retained: true,
    content: [{ type: "text", text: boundedEnvelope(fullText, maxInlineBytes, notice) }],
    ...(saved.ok ? { artifact: saved.value } : {}),
  };
}
