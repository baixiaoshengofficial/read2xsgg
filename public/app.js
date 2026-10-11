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
  aiBaseUrl: document.getElementById("ai-base-url"),
  aiModel: document.getElementById("ai-model"),
  aiApiKey: document.getElementById("ai-api-key"),
  aiLocalBaseUrl: document.getElementById("ai-local-base-url"),
  aiLocalModel: document.getElementById("ai-local-model"),
  mcpEndpoint: document.getElementById("mcp-endpoint"),
  mcpToken: document.getElementById("mcp-token"),
  aiTimeout: document.getElementById("ai-timeout"),
  aiAttempts: document.getElementById("ai-attempts"),
  aiConcurrency: document.getElementById("ai-concurrency"),
  mcpToolCalls: document.getElementById("mcp-tool-calls"),
  aiConfigState: document.getElementById("ai-config-state"),
  aiSettingsStatus: document.getElementById("ai-settings-status"),
  aiTest: document.getElementById("ai-test"),
  mcpTest: document.getElementById("mcp-test"),
  aiClearKey: document.getElementById("ai-clear-key"),
  mcpClearToken: document.getElementById("mcp-clear-token"),
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

function statusLabel(job) {
  if (job.status === "queued") return "排队中";
  if (job.status === "running") return "运行中";
  if (job.status === "done") {
    const skipped = Number(job.progress?.skipped || 0);
    const unverified = Number(job.progress?.unverified || 0);
    return skipped || unverified ? "本轮结束·待调优" : "验证通过";
  }
  if (job.status === "failed") return "失败";
  return job.status || "";
}

function statusClass(job) {
  if (job.status === "done" && (Number(job.progress?.skipped || 0) || Number(job.progress?.unverified || 0))) {
    return "partial";
  }
  return job.status || "";
}

function phaseLabel(job) {
  const phase = job.phase || "";
  const current = currentSitesLabel(job);
  if (job.status === "queued") return "等待调度";
  if (job.status === "done") {
    const unverifiedCount = Number(job.progress?.unverified || 0);
    const verified = Math.max(0, Number(job.progress?.kept ?? job.count ?? 0) - unverifiedCount);
    const aiRepaired = Number(job.progress?.aiRepaired || 0);
    const summary = `实测通过 ${verified}${aiRepaired ? `（AI 修复 ${aiRepaired}）` : ""}${unverifiedCount ? ` · 未验证保留 ${unverifiedCount}` : ""}`;
    const skipped = Number(job.progress?.skipped || 0);
    if (!skipped) return job.count != null ? `本轮结束 · ${summary}` : "本轮处理结束";
    const unreachable = Number(job.skippedBuckets?.["dead-origin"] || 0);
    const repairable = Math.max(0, skipped - unreachable);
    const reasons = Object.entries(job.skippedReasons || {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([reason, count]) => `${reason}×${count}`)
      .join("，");
    const sampleNames = (Array.isArray(job.skippedSources) ? job.skippedSources : [])
      .slice()
      .sort((a, b) => Number(/dead-origin|上游站点不可访问/i.test(a?.reason || ""))
        - Number(/dead-origin|上游站点不可访问/i.test(b?.reason || "")))
      .slice(0, 3)
      .map((item) => String(item?.source || "").trim())
      .filter(Boolean);
    const samples = sampleNames.length
      ? ` · 待处理样例 ${sampleNames.join("、")}${skipped > sampleNames.length ? ` 等 ${skipped - sampleNames.length} 个` : ""}`
      : "";
    const breakdown = [
      repairable ? `待调优 ${repairable}` : "",
      unreachable ? `不可达 ${unreachable}` : "",
      reasons ? `原因 ${reasons}` : "",
    ].filter(Boolean).join(" · ");
    return `本轮结束 · ${summary} · 跳过 ${skipped}${breakdown ? `（${breakdown}）` : ""}${samples}`;
  }
  if (job.status === "failed") return job.error || "失败";
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
      ? `AI 识站 ${job.progress.aiAttempt || 1}/${job.progress.aiAttempts || 1}`
      : job.progress?.step === "analyze" ? "通用识站修复" : "抽测";
    if (job.progress?.total) {
      const unverified = Number(job.progress.unverified || 0);
      const verified = Math.max(0, Number(job.progress.kept || 0) - unverified);
      const aiRepaired = Number(job.progress.aiRepaired || 0);
      const base = `${step} ${job.progress.done || 0}/${job.progress.total} · 实测通过 ${verified}${aiRepaired ? `（AI 修复 ${aiRepaired}）` : ""} · 跳过 ${job.progress.skipped || 0}${unverified ? ` · 未验证保留 ${unverified}` : ""}`;
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
      `<button type="button" class="danger" data-del="${job.id}">删除</button>`,
    ].filter(Boolean).join("");
    return `
      <article class="job" data-id="${job.id}">
        <p class="job-title"><span class="badge ${statusClass(job)}">${statusLabel(job)}</span><span class="job-name">${escapeHtml(job.title || job.id)}</span></p>
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
  els.aiClearKey.hidden = local || cli;
}

function aiConfigStateText(settings) {
  const provider = settings.provider === "local-http"
    ? `本地模型 ${settings.localModel || "未配置"}`
    : (settings.provider === "cli" ? `CLI ${settings.cliClient || "codex"}` : (settings.apiKeyConfigured ? "AI Key 已保存" : "尚未设置 AI Key"));
  const mcp = settings.mcpEndpoint
    ? `MCP ${settings.mcpTokenConfigured ? "已配置认证" : "未配置认证"}`
    : "MCP 未配置";
  return `${provider} · ${mcp}`;
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
  els.mcpEndpoint.value = settings.mcpEndpoint || "";
  els.aiTimeout.value = Math.round((Number(settings.timeoutMs) || 30_000) / 1000);
  els.aiAttempts.value = settings.maxAttempts || 2;
  els.aiConcurrency.value = settings.concurrency || 2;
  els.mcpToolCalls.value = settings.maxToolCalls ?? 4;
  els.aiApiKey.value = "";
  els.mcpToken.value = "";
  els.aiConfigState.textContent = aiConfigStateText(settings);
  updateAiProviderView();
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
    showStatus(els.createStatus, `已创建任务 ${job.id}，后台转换中`, true);
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

els.aiProvider.addEventListener("change", updateAiProviderView);

els.aiSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = els.aiSettingsForm.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const settings = {
      enabled: els.aiEnabled.checked,
      provider: els.aiProvider.value,
      baseUrl: els.aiBaseUrl.value.trim(),
      model: els.aiModel.value.trim(),
      localBaseUrl: els.aiLocalBaseUrl.value.trim(),
      localModel: els.aiLocalModel.value.trim(),
      cliClient: els.aiCliClient.value,
      mcpEndpoint: els.mcpEndpoint.value.trim(),
      timeoutMs: Number(els.aiTimeout.value) * 1000,
      maxAttempts: Number(els.aiAttempts.value),
      concurrency: Number(els.aiConcurrency.value),
      maxToolCalls: Number(els.mcpToolCalls.value),
    };
    if (els.aiApiKey.value.trim()) settings.apiKey = els.aiApiKey.value.trim();
    if (els.mcpToken.value.trim()) settings.mcpToken = els.mcpToken.value.trim();
    const result = await api("/api/settings/ai", { method: "PUT", body: JSON.stringify(settings) });
    els.aiApiKey.value = "";
    els.mcpToken.value = "";
    const state = result.settings;
    els.aiConfigState.textContent = aiConfigStateText(state);
    showStatus(els.aiSettingsStatus, "AI 设置已安全保存；新启动的任务将使用此配置", true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, error.message || "保存设置失败", false);
  } finally {
    button.disabled = false;
  }
});

els.aiTest.addEventListener("click", async () => {
  els.aiTest.disabled = true;
  try {
    const result = await api("/api/settings/ai/test", { method: "POST", body: "{}" });
    showStatus(els.aiSettingsStatus, `AI 服务连通：${result.model} · ${result.response || "服务已响应"}`, true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, error.message || "AI 服务测试失败", false);
  } finally {
    els.aiTest.disabled = false;
  }
});

els.mcpTest.addEventListener("click", async () => {
  els.mcpTest.disabled = true;
  try {
    const result = await api("/api/settings/mcp/test", { method: "POST", body: "{}" });
    showStatus(els.aiSettingsStatus, `MCP 连通：发现 ${result.toolCount} 个工具${result.toolNames?.length ? `（${result.toolNames.join("、")}）` : ""}`, true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, error.message || "MCP 测试失败", false);
  } finally {
    els.mcpTest.disabled = false;
  }
});

els.aiClearKey.addEventListener("click", async () => {
  if (!await confirmAction("清除已保存的 AI API Key，并关闭 AI 识站？", {
    title: "清除 AI API Key",
    confirmLabel: "清除",
  })) return;
  els.aiClearKey.disabled = true;
  try {
    const result = await api("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify({ clearApiKey: true, enabled: false }),
    });
    els.aiEnabled.checked = false;
    els.aiConfigState.textContent = aiConfigStateText(result.settings);
    showStatus(els.aiSettingsStatus, "AI API Key 已清除，AI 识站已关闭", true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, error.message || "清除 Key 失败", false);
  } finally {
    els.aiClearKey.disabled = false;
  }
});

els.mcpClearToken.addEventListener("click", async () => {
  if (!await confirmAction("清除已保存的 MCP Bearer Token？", {
    title: "清除 MCP Token",
    confirmLabel: "清除",
  })) return;
  els.mcpClearToken.disabled = true;
  try {
    const result = await api("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify({ clearMcpToken: true }),
    });
    els.mcpToken.value = "";
    els.aiConfigState.textContent = aiConfigStateText(result.settings);
    showStatus(els.aiSettingsStatus, "MCP Bearer Token 已清除", true);
  } catch (error) {
    if (error.status === 401 || error.status === 503) logout(error.message);
    else showStatus(els.aiSettingsStatus, error.message || "清除 MCP Token 失败", false);
  } finally {
    els.mcpClearToken.disabled = false;
  }
});

els.jobs.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const copyId = target.getAttribute("data-copy");
  const retryId = target.getAttribute("data-retry");
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
