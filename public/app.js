const TOKEN_KEY = "read2xsgg.adminToken";

const els = {
  login: document.getElementById("login"),
  app: document.getElementById("app"),
  heroTitle: document.getElementById("hero-title"),
  heroLede: document.getElementById("hero-lede"),
  token: document.getElementById("token"),
  loginForm: document.getElementById("login-form"),
  loginStatus: document.getElementById("login-status"),
  createForm: document.getElementById("create-form"),
  createStatus: document.getElementById("create-status"),
  url: document.getElementById("url"),
  name: document.getElementById("name"),
  mode: document.getElementById("mode"),
  jobs: document.getElementById("jobs"),
  refresh: document.getElementById("refresh"),
  logout: document.getElementById("logout"),
  aiSettingsForm: document.getElementById("ai-settings-form"),
  aiEnabled: document.getElementById("ai-enabled"),
  aiProvider: document.getElementById("ai-provider"),
  aiApiFields: document.getElementById("ai-api-fields"),
  aiLocalFields: document.getElementById("ai-local-fields"),
  aiCliFields: document.getElementById("ai-cli-fields"),
  aiCliClient: document.getElementById("ai-cli-client"),
  aiCliModel: document.getElementById("ai-cli-model"),
  aiCliModelCustom: document.getElementById("ai-cli-model-custom"),
  aiCliCustomFields: document.getElementById("ai-cli-custom-fields"),
  aiReasoningEffort: document.getElementById("ai-reasoning-effort"),
  aiReasoningHint: document.getElementById("ai-reasoning-hint"),
  aiLocalReasoningEffort: document.getElementById("ai-local-reasoning-effort"),
  aiLocalReasoningHint: document.getElementById("ai-local-reasoning-hint"),
  aiCliReasoningEffort: document.getElementById("ai-cli-reasoning-effort"),
  aiCliReasoningHint: document.getElementById("ai-cli-reasoning-hint"),
  aiApiModels: document.getElementById("ai-api-models"),
  aiLocalModels: document.getElementById("ai-local-models"),
  aiModelsRefresh: document.getElementById("ai-models-refresh"),
  aiModelsStatus: document.getElementById("ai-models-status"),
  aiBaseUrl: document.getElementById("ai-base-url"),
  aiModel: document.getElementById("ai-model"),
  aiApiKey: document.getElementById("ai-api-key"),
  aiLocalBaseUrl: document.getElementById("ai-local-base-url"),
  aiLocalModel: document.getElementById("ai-local-model"),
  aiTimeout: document.getElementById("ai-timeout"),
  aiAttempts: document.getElementById("ai-attempts"),
  aiConcurrency: document.getElementById("ai-concurrency"),
  aiConfigState: document.getElementById("ai-config-state"),
  aiSettingsStatus: document.getElementById("ai-settings-status"),
  aiTest: document.getElementById("ai-test"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmMessage: document.getElementById("confirm-message"),
  confirmOk: document.getElementById("confirm-ok"),
};

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

function setToken(value) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

function showStatus(el, message, ok = true) {
  el.hidden = !message;
  el.textContent = message || "";
  el.classList.toggle("ok", Boolean(ok));
  el.classList.toggle("bad", !ok);
}

function authHeaders() {
  const token = getToken();
  return token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || "无效响应" };
  }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function shell() {
  return document.querySelector(".shell");
}

function showLogin(message = "", ok = false) {
  els.login.hidden = false;
  els.app.hidden = true;
  shell()?.classList.add("is-login");
  document.title = "登录 · read2xsgg";
  els.heroTitle.textContent = "登录";
  els.heroLede.innerHTML = "请输入部署时在 <code>.env</code> 中配置的 <code>ADMIN_TOKEN</code> 后进入。";
  els.token.value = "";
  els.token.focus();
  if (message) showStatus(els.loginStatus, message, ok);
  else {
    els.loginStatus.hidden = true;
    els.loginStatus.textContent = "";
  }
}

function showApp() {
  els.login.hidden = true;
  els.app.hidden = false;
  shell()?.classList.remove("is-login");
  document.title = "源管理 · read2xsgg";
  els.heroTitle.textContent = "源管理";
  els.heroLede.textContent = "异步完整抽测转换，完成后生成可订阅的稳定 XBS 地址。同步直转路径仍然可用。";
  els.loginStatus.hidden = true;
}

function subscribeUrl(job) {
  const path = job.subscribePath || `/library/${job.id}.xbs`;
  return `${window.location.origin}${path}`;
}

function progressRatio(job) {
  const total = Number(job.progress?.total || 0);
  const done = Number(job.progress?.done || 0);
  if (!total) return job.status === "done" ? 1 : 0;
  return Math.max(0, Math.min(1, done / total));
}

function statusLabel(status) {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "paused") return "已暂停";
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  return status || "";
}

function phaseLabel(job) {
  const phase = job.phase || "";
  const current = currentSitesLabel(job);
  if (job.status === "queued") return "等待调度";
  if (job.status === "done") {
    const unverified = job.progress?.unverified ? ` · 未抽测保留 ${job.progress.unverified}` : "";
    const skipped = job.progress?.skipped != null ? ` · 跳过 ${job.progress.skipped}` : "";
    const aiCount = job.aiRepairCount ?? job.progress?.aiRepaired;
    const aiAttempts = job.aiAttemptCount ?? job.progress?.aiAttemptsTotal;
    const ai = aiCount != null
      ? ` · ${aiAttempts != null ? `AI 尝试 ${aiAttempts} 次 / ` : ""}AI 验链成功 ${aiCount}`
      : "";
    return job.count != null ? `保留 ${job.count} 源${skipped}${ai}${unverified}` : "完成";
  }
  if (job.status === "failed") return job.error || "失败";
  if (job.status === "paused") {
    const done = Number(job.progress?.done || 0);
    const total = Number(job.progress?.total || 0);
    return `已暂停 · 进度 ${done}/${total} 保留；继续时将从头重跑`;
  }
  if (phase === "download") return "下载阅读源…";
  if (phase === "convert") {
    if (job.progress?.total) return `转换规则 ${job.progress.done || 0}/${job.progress.total}`;
    return "转换规则…";
  }
  if (phase === "preflight") {
    const base = job.progress?.total
      ? `探活 ${job.progress.done || 0}/${job.progress.total}`
      : "探活上游站点…";
    return current ? `${base} · ${current}` : base;
  }
  if (phase === "verify") {
    const step = job.progress?.step === "ai-analyze"
      ? `AI 识站${job.progress.aiAttempt && job.progress.aiAttempts ? ` ${job.progress.aiAttempt}/${job.progress.aiAttempts}` : ""}`
      : job.progress?.step === "ai-verify" ? "AI 候选验链"
        : job.progress?.step === "analyze" ? "通用识站修复" : "抽测";
    if (job.progress?.total) {
      const unverified = job.progress.unverified ? ` · 未抽测保留 ${job.progress.unverified}` : "";
      const aiRepaired = Number(job.progress.aiRepaired || 0);
      const aiAttempts = Number(job.progress.aiAttemptsTotal || 0);
      const aiStatus = aiAttempts ? ` · AI 累计尝试 ${aiAttempts} / 验链成功 ${aiRepaired}` : "";
      const base = `${step} ${job.progress.done || 0}/${job.progress.total} · 保留 ${job.progress.kept || 0}${aiRepaired ? `（AI 修复 ${aiRepaired}）` : ""} · 跳过 ${job.progress.skipped || 0}${aiStatus}${unverified}`;
      return current ? `${base}\n当前：${current}` : base;
    }
    return current ? `${step}中… · ${current}` : `${step}中…`;
  }
  if (phase === "analyze") return current ? `识站修复… · ${current}` : "识站修复…";
  if (phase === "save") return "写入制品…";
  if (job.status === "running") return "处理中…";
  return "等待中";
}

function currentSitesLabel(job) {
  const active = Array.isArray(job.progress?.active) ? job.progress.active.filter(Boolean) : [];
  if (active.length) return active.join(" · ");
  return String(job.progress?.current || "").trim();
}

function renderJobs(jobs) {
  if (!jobs?.length) {
    els.jobs.innerHTML = `<p class="empty">暂无任务。粘贴阅读源 URL 开始转换。</p>`;
    return;
  }
  els.jobs.innerHTML = jobs.map((job) => {
    const ratio = progressRatio(job);
    const pct = Math.round(ratio * 100);
    const progressText = phaseLabel(job);
    const sub = job.status === "done"
      ? `<div class="meta">订阅：<code>${subscribeUrl(job)}</code></div>`
      : "";
    const err = job.error && job.status === "failed"
      ? `<div class="meta meta-error">${escapeHtml(job.error)}</div>`
      : "";
    const actions = [
      job.status === "done" ? `<button type="button" data-copy="${job.id}">复制订阅 URL</button>` : "",
      (job.status === "done" || job.status === "failed")
        ? `<button type="button" data-retry="${job.id}">重新转换</button>`
        : "",
      (job.status === "queued" || job.status === "running")
        ? `<button type="button" data-pause="${job.id}">暂停</button>`
        : "",
      job.status === "paused"
        ? `<button type="button" data-resume="${job.id}">继续（从头重跑）</button>`
        : "",
      `<button type="button" class="danger" data-del="${job.id}">删除</button>`,
    ].filter(Boolean).join("");
    return `
      <article class="job" data-id="${job.id}">
        <p class="job-title"><span class="badge ${job.status}">${statusLabel(job.status)}</span><span class="job-name">${escapeHtml(job.title || job.id)}</span></p>
        <p class="meta">${escapeHtml(job.sourceUrl || "")}</p>
        <p class="meta progress-text">${escapeHtml(progressText).replaceAll("\n", "<br>")}</p>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="转换进度"><span style="width:${pct}%"></span></div>
        ${sub}
        ${err}
        <div class="actions">${actions}</div>
      </article>
    `;
  }).join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function confirmAction(message, { title = "确认操作", confirmLabel = "确认" } = {}) {
  const dialog = els.confirmDialog;
  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(window.confirm(message));
  }
  els.confirmMessage.textContent = message;
  const titleEl = dialog.querySelector("#confirm-title");
  if (titleEl) titleEl.textContent = title;
  if (els.confirmOk) els.confirmOk.textContent = confirmLabel;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
  });
}

async function refreshJobs() {
  const data = await api("/api/jobs");
  renderJobs(data.jobs || []);
  const busy = (data.jobs || []).some((job) => job.status === "queued" || job.status === "running");
  if (busy) schedulePoll();
}

function updateAiProviderView() {
  const local = els.aiProvider.value === "local-http";
  const cli = els.aiProvider.value === "cli";
  els.aiApiFields.hidden = local || cli;
  els.aiLocalFields.hidden = !local;
  els.aiCliFields.hidden = !cli;
}

function selectedCliModel() {
  return els.aiCliModel.value === "__custom__" ? els.aiCliModelCustom.value.trim() : els.aiCliModel.value;
}

const reasoningLabels = {
  none: "关闭推理（none）", minimal: "极低（minimal）", low: "低（low）", medium: "中（medium）",
  high: "高（high）", xhigh: "超高（xhigh）", max: "最高（max）", ultra: "极致（ultra）",
};
const providerModels = { api: [], "local-http": [], cli: [] };

function reasoningControls(provider) {
  if (provider === "cli") return { select: els.aiCliReasoningEffort, hint: els.aiCliReasoningHint, model: selectedCliModel() };
  if (provider === "local-http") return { select: els.aiLocalReasoningEffort, hint: els.aiLocalReasoningHint, model: els.aiLocalModel.value.trim() };
  return { select: els.aiReasoningEffort, hint: els.aiReasoningHint, model: els.aiModel.value.trim() };
}

function updateReasoningView(provider, effort) {
  const { select, hint, model } = reasoningControls(provider);
  const selected = effort ?? select.value;
  const capabilities = providerModels[provider].find((item) => item.id === model);
  const known = Array.isArray(capabilities?.reasoningEfforts);
  const allowed = Object.keys(reasoningLabels).filter((level) => provider === "cli" || level !== "ultra");
  const levels = known ? capabilities.reasoningEfforts.filter((level) => allowed.includes(level)) : allowed;
  const preferred = capabilities?.defaultReasoningEffort;
  const options = [new Option(`模型默认${preferred && reasoningLabels[preferred] ? ` · ${reasoningLabels[preferred]}` : "（不发送档位参数）"}`, "")];
  for (const level of levels) options.push(new Option(reasoningLabels[level], level));
  const unsupported = Boolean(selected && !levels.includes(selected));
  if (unsupported) options.push(new Option(`原档位 ${selected} 不受支持，请重新选择`, selected));
  select.replaceChildren(...options);
  select.value = selected;
  select.dataset.unsupported = String(unsupported);
  hint.textContent = unsupported ? "当前模型不支持原档位，保存前请重新选择；不会自动改成其他档位。"
    : known ? (levels.length ? "仅显示该模型公布的档位。较高档位可能增加耗时和额度消耗，仍须验证转换规则。" : "该模型未公布可用推理档位，请使用模型默认。")
      : "尚无该模型的档位信息；以下选项需服务支持，选择后请检查 AI 连接。不支持时会报错，不自动降档。";
}

function updateCliModelView() {
  els.aiCliCustomFields.hidden = els.aiCliModel.value !== "__custom__";
  updateReasoningView("cli");
}

function setCliModelOptions(model, models = []) {
  providerModels.cli = models;
  const options = [new Option("使用 Codex 内置默认模型", "")];
  for (const item of models) options.push(new Option(item.name === item.id ? item.id : `${item.name} · ${item.id}`, item.id));
  options.push(new Option("手动输入模型名称…", "__custom__"));
  els.aiCliModel.replaceChildren(...options);
  const known = models.some((item) => item.id === model);
  els.aiCliModel.value = !model ? "" : known ? model : "__custom__";
  els.aiCliModelCustom.value = known ? "" : model;
  updateCliModelView();
}

let modelsRequestVersion = 0;
async function loadAiModels() {
  const version = ++modelsRequestVersion;
  const provider = els.aiProvider.value;
  els.aiModelsStatus.textContent = "正在读取已保存的服务配置对应的模型列表…";
  try {
    const result = await api(`/api/settings/ai/models?provider=${encodeURIComponent(provider)}`);
    if (version !== modelsRequestVersion || provider !== els.aiProvider.value) return;
    const models = Array.isArray(result.models) ? result.models : [];
    providerModels[provider] = models;
    if (provider === "cli") setCliModelOptions(selectedCliModel(), models);
    else {
      const list = provider === "local-http" ? els.aiLocalModels : els.aiApiModels;
      list.replaceChildren(...models.map((item) => new Option(item.name || item.id, item.id)));
      updateReasoningView(provider);
    }
    els.aiModelsStatus.textContent = result.warning || (result.source === "codex-cache"
      ? `已读取 ${models.length} 个 Codex 缓存模型。账号权限可能变化，选择后请检查 AI 连接。`
      : `已读取 ${models.length} 个服务端模型。列表可能包含非文本模型，选择后请检查 AI 连接。`);
  } catch (error) {
    if (version !== modelsRequestVersion || provider !== els.aiProvider.value) return;
    els.aiModelsStatus.textContent = `${error.message || "模型列表读取失败"}；仍可手动输入。更改服务地址或密钥后，请点击“保存并读取模型列表”。`;
  }
}

function aiConfigStateText(settings) {
  if (!settings.enabled) return "已关闭 · 继续使用常规转换和通用识站";
  const provider = settings.provider === "local-http"
    ? `本地模型 ${settings.localModel || "未配置"}`
    : settings.provider === "cli"
      ? `Codex（服务器账号）· ${settings.cliModel || "内置默认模型"}`
      : settings.apiKeyConfigured ? `API 服务 · ${settings.model || "未填模型名称"}` : "API 服务 · 尚未填写密钥";
  const effort = settings.provider === "cli" ? settings.cliReasoningEffort : settings.provider === "local-http" ? settings.localReasoningEffort : settings.reasoningEffort;
  return `已启用 · ${provider} · 档位 ${reasoningLabels[effort] || "模型默认"} · 已保存配置`;
}

async function loadAiSettings() {
  const { settings } = await api("/api/settings/ai");
  els.aiEnabled.checked = Boolean(settings.enabled);
  els.aiProvider.value = settings.provider || "api";
  els.aiBaseUrl.value = settings.baseUrl || "https://api.openai.com/v1";
  els.aiModel.value = settings.model || "";
  els.aiLocalBaseUrl.value = settings.localBaseUrl || "";
  els.aiLocalModel.value = settings.localModel || "";
  els.aiCliClient.value = settings.cliClient || "codex";
  setCliModelOptions(settings.cliModel || "");
  updateReasoningView("api", settings.reasoningEffort || "");
  updateReasoningView("local-http", settings.localReasoningEffort || "");
  updateReasoningView("cli", settings.cliReasoningEffort || "");
  els.aiTimeout.value = Math.round((Number(settings.timeoutMs) || 30_000) / 1000);
  els.aiAttempts.value = settings.maxAttempts || 2;
  els.aiConcurrency.value = settings.concurrency || 2;
  els.aiApiKey.value = "";
  els.aiConfigState.textContent = aiConfigStateText(settings);
  updateAiProviderView();
  void loadAiModels();
}

let pollTimer = 0;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    refreshJobs().catch((error) => {
      if (error.status === 401 || error.status === 503) logout(error.message);
    });
  }, 2000);
}

async function enterApp(token) {
  setToken(token);
  await refreshJobs();
  showApp();
  loadAiSettings().catch((error) => showStatus(els.aiSettingsStatus, error.message || "读取 AI 设置失败", false));
}

function logout(message = "") {
  clearTimeout(pollTimer);
  setToken("");
  if (message) showLogin(message, false);
  else showLogin("已退出登录", true);
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = els.token.value.trim();
  if (!token) {
    showStatus(els.loginStatus, "请输入管理口令", false);
    return;
  }
  const button = els.loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await enterApp(token);
  } catch (error) {
    setToken("");
    if (error.status === 503) {
      showStatus(els.loginStatus, "服务器未配置 ADMIN_TOKEN，请先在 .env 中设置", false);
    } else if (error.status === 401) {
      showStatus(els.loginStatus, "口令不正确", false);
    } else {
      showStatus(els.loginStatus, error.message || "登录失败", false);
    }
  } finally {
    button.disabled = false;
  }
});

els.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = els.createForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const job = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        url: els.url.value.trim(),
        name: els.name.value.trim(),
        mode: els.mode.value,
      }),
    });
    showStatus(
      els.createStatus,
      job.reused ? `已复用任务 ${job.id}，未创建重复任务` : `已创建任务 ${job.id}，后台转换中`,
      true,
    );
    els.url.value = "";
    els.name.value = "";
    await refreshJobs();
  } catch (error) {
    if (error.status === 401 || error.status === 503) {
      logout(error.message);
      return;
    }
    showStatus(els.createStatus, error.message || "创建失败", false);
  } finally {
    button.disabled = false;
  }
});

els.refresh.addEventListener("click", () => {
  refreshJobs().catch((error) => {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.createStatus, error.message, false);
  });
});

els.logout.addEventListener("click", () => logout());

els.aiProvider.addEventListener("change", () => {
  updateAiProviderView();
  void loadAiModels();
});
els.aiCliModel.addEventListener("change", updateCliModelView);
els.aiCliModelCustom.addEventListener("input", updateCliModelView);
els.aiModel.addEventListener("input", () => updateReasoningView("api"));
els.aiLocalModel.addEventListener("input", () => updateReasoningView("local-http"));
for (const provider of ["api", "local-http", "cli"]) {
  reasoningControls(provider).select.addEventListener("change", () => updateReasoningView(provider));
  updateReasoningView(provider);
}
async function saveAiSettings() {
  if (reasoningControls(els.aiProvider.value).select.dataset.unsupported === "true") throw new Error("当前模型不支持原推理档位，请重新选择");
  const settings = {
    enabled: els.aiEnabled.checked,
    provider: els.aiProvider.value,
    baseUrl: els.aiBaseUrl.value.trim(),
    model: els.aiModel.value.trim(),
    reasoningEffort: els.aiReasoningEffort.value,
    localBaseUrl: els.aiLocalBaseUrl.value.trim(),
    localModel: els.aiLocalModel.value.trim(),
    localReasoningEffort: els.aiLocalReasoningEffort.value,
    cliClient: els.aiCliClient.value,
    cliModel: selectedCliModel(),
    cliReasoningEffort: els.aiCliReasoningEffort.value,
    timeoutMs: Number(els.aiTimeout.value) * 1000,
    maxAttempts: Number(els.aiAttempts.value),
    concurrency: Number(els.aiConcurrency.value),
  };
  if (els.aiApiKey.value.trim()) settings.apiKey = els.aiApiKey.value.trim();
  const result = await api("/api/settings/ai", { method: "PUT", body: JSON.stringify(settings) });
  els.aiApiKey.value = "";
  els.aiConfigState.textContent = aiConfigStateText(result.settings);
  return result.settings;
}

function setAiSettingsBusy(busy) {
  els.aiSettingsForm.querySelector("button[type=submit]").disabled = busy;
  els.aiTest.disabled = busy;
  els.aiModelsRefresh.disabled = busy;
}

els.aiModelsRefresh.addEventListener("click", async () => {
  setAiSettingsBusy(true);
  try {
    await saveAiSettings();
    await loadAiModels();
  } catch (error) {
    showStatus(els.aiSettingsStatus, error.message || "保存设置失败", false);
  } finally { setAiSettingsBusy(false); }
});

els.aiSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAiSettingsBusy(true);
  try {
    const settings = await saveAiSettings();
    showStatus(els.aiSettingsStatus, settings.enabled
      ? "设置已保存。请在任务列表重试原任务；连接可通过旁边的按钮检查。"
      : "设置已保存，AI 辅助修复已关闭。常规转换和通用识站继续可用。", true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, error.message || "保存 AI 设置失败", false);
  } finally {
    setAiSettingsBusy(false);
  }
});

els.aiTest.addEventListener("click", async () => {
  setAiSettingsBusy(true);
  let saved = false;
  try {
    const settings = await saveAiSettings();
    saved = true;
    showStatus(els.aiSettingsStatus, "设置已保存，正在检查 AI 是否能响应…", true);
    const result = await api("/api/settings/ai/test", { method: "POST", body: "{}" });
    showStatus(els.aiSettingsStatus, `AI 连接成功：${result.model} 已响应，请求档位 ${reasoningLabels[result.reasoningEffort] || "模型默认"}。${settings.enabled ? "可在任务列表重试原任务。" : "AI 当前已关闭，请勾选启用并保存后重试任务。"}实际修复成功数请看任务中的“AI 验链成功”。`, true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, `${saved ? "设置已保存，但 AI 连接检查失败：" : "设置保存失败："}${error.message || "请检查配置"}`, false);
  } finally {
    setAiSettingsBusy(false);
  }
});

els.jobs.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const copyId = target.getAttribute("data-copy");
  const retryId = target.getAttribute("data-retry");
  const pauseId = target.getAttribute("data-pause");
  const resumeId = target.getAttribute("data-resume");
  const delId = target.getAttribute("data-del");
  try {
    if (copyId) {
      const job = await api(`/api/jobs/${copyId}`);
      await navigator.clipboard.writeText(subscribeUrl(job));
      showStatus(els.createStatus, "订阅 URL 已复制", true);
    }
    if (retryId) {
      await api(`/api/jobs/${retryId}/retry`, { method: "POST", body: "{}" });
      await refreshJobs();
    }
    if (pauseId) {
      await api(`/api/jobs/${pauseId}/pause`, { method: "POST", body: "{}" });
      await refreshJobs();
    }
    if (resumeId) {
      await api(`/api/jobs/${resumeId}/retry`, { method: "POST", body: "{}" });
      await refreshJobs();
    }
    if (delId) {
      const ok = await confirmAction("删除该任务及制品？", {
        title: "删除任务",
        confirmLabel: "删除",
      });
      if (!ok) return;
      await api(`/api/jobs/${delId}`, { method: "DELETE" });
      await refreshJobs();
    }
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.createStatus, error.message || "操作失败", false);
  }
});

(async function boot() {
  const saved = getToken();
  if (!saved) {
    showLogin();
    return;
  }
  try {
    await enterApp(saved);
  } catch (error) {
    setToken("");
    if (error.status === 503) showLogin("服务器未配置 ADMIN_TOKEN，请先在 .env 中设置");
    else if (error.status === 401) showLogin("登录已失效，请重新输入口令");
    else showLogin(error.message || "无法进入源管理");
  }
})();
