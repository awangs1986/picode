const PROVIDER_LABELS = {
  anthropic: "Claude / Anthropic",
  cursor: "Cursor",
  openai: "Codex / OpenAI",
  "openai-codex": "Codex",
};

export function modelProviderLabel(provider) {
  const normalized = String(provider || "").trim();
  return PROVIDER_LABELS[normalized] || normalized || "Other";
}

export function modelOptionLabel(model) {
  const id = String(model?.id || "").replace(/-\d{8}$/, "");
  return `${id || "model"} · ${modelProviderLabel(model?.provider)}`;
}

export function summarizeModelProviders(models) {
  const counts = new Map();
  for (const model of models || []) {
    const provider = String(model?.provider || "").trim();
    if (!provider) continue;
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return Array.from(counts, ([provider, count]) => ({
    provider,
    label: modelProviderLabel(provider),
    count,
  })).sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.provider.localeCompare(right.provider),
  );
}

export function filterModelsByProvider(models, provider) {
  if (!provider) return Array.from(models || []);
  return Array.from(models || []).filter((model) => model?.provider === provider);
}
