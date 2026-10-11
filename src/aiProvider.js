import { requestChatCompletion } from "./openAiCompat.js";
import { requestCliCompletion } from "./cliProvider.js";

export function aiProviderConfigured(settings) {
  if (!settings) return false;
  if (settings.provider === "local-http") return Boolean(settings.localBaseUrl && settings.localModel);
  if (settings.provider === "cli") return settings.cliClient === "codex";
  return Boolean(settings.apiKey && settings.model);
}

export function aiProviderReady(settings) {
  return Boolean(settings?.enabled && aiProviderConfigured(settings));
}

export async function requestAiCompletion(options = {}) {
  const { settings } = options;
  if (!aiProviderReady(settings)) throw new Error("AI 未启用或当前接入方式配置不完整");
  if (settings.provider === "cli") return requestCliCompletion(options);
  if (settings.provider !== "local-http") return requestChatCompletion(options);
  return requestChatCompletion({
    ...options,
    settings: {
      ...settings,
      baseUrl: settings.localBaseUrl,
      model: settings.localModel,
      apiKey: "",
    },
    allowAnonymous: true,
  });
}

export async function probeAiProvider(settings, options = {}) {
  const message = await requestAiCompletion({
    settings: { ...settings, enabled: true },
    messages: [
      { role: "system", content: "Reply with exactly READY." },
      { role: "user", content: "Connection test. Reply with exactly READY." },
    ],
    maxTokens: 16,
    ...options,
  });
  return {
    model: settings.provider === "cli" ? "Codex CLI" : (settings.provider === "local-http" ? settings.localModel : settings.model),
    response: String(message.content || "").slice(0, 80),
  };
}
