export async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand?.("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard is unavailable");
}

export async function loadSessionEntries(session, project) {
  if (!project?.dirName || !session?.file) throw new Error("Session file is unavailable");
  const response = await fetch(`/api/sessions/${project.dirName}/${session.file}`);
  if (!response.ok) throw new Error(`Cannot read session transcript (HTTP ${response.status})`);
  const data = await response.json();
  return Array.isArray(data.entries) ? data.entries : [];
}

export function buildSessionTranscript(
  entries,
  { userLabel = "User", assistantLabel = "Assistant" } = {},
) {
  const parts = [];
  for (const entry of entries || []) {
    if (entry?.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text =
      typeof content === "string"
        ? content
        : (Array.isArray(content) ? content : [])
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n");
    if (!text.trim()) continue;
    parts.push(`${role === "user" ? userLabel : assistantLabel}:\n${text.trim()}`);
  }
  return parts.join("\n\n");
}
