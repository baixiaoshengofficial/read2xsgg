// Provider/model capabilities decide which of these protocol values are usable.
export const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function normalizeReasoningEffort(value) {
  const effort = String(value ?? "").trim();
  if (effort && !REASONING_EFFORTS.includes(effort)) throw new Error("推理档位无效");
  return effort;
}

export function reasoningCapabilities(item = {}) {
  const advertised = item.reasoningEfforts ?? item.supported_reasoning_levels;
  if (!Array.isArray(advertised)) return {};
  const reasoningEfforts = [...new Set(advertised.map((level) => typeof level === "string" ? level : level?.effort)
    .filter((effort) => REASONING_EFFORTS.includes(effort)))];
  const preferred = item.defaultReasoningEffort ?? item.default_reasoning_level;
  return { reasoningEfforts, ...(reasoningEfforts.includes(preferred) ? { defaultReasoningEffort: preferred } : {}) };
}

export function selectedReasoningEffort(settings = {}) {
  return normalizeReasoningEffort(settings.provider === "cli" ? settings.cliReasoningEffort
    : settings.provider === "local-http" ? settings.localReasoningEffort : settings.reasoningEffort);
}
