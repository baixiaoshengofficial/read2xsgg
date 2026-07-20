const TOKEN_KEY = "read2xsgg.adminToken";

const els = {
  token: document.getElementById("token"),
  authForm: document.getElementById("auth-form"),
  authStatus: document.getElementById("auth-status"),
  createForm: document.getElementById("create-form"),
  createStatus: document.getElementById("create-status"),
  url: document.getElementById("url"),
  name: document.getElementById("name"),
  mode: document.getElementById("mode"),
  jobs: document.getElementById("jobs"),
  refresh: document.getElementById("refresh"),
};

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

function setToken(value) {
  sessionStorage.setItem(TOKEN_KEY, value);
}

function showStatus(el, message, ok = true) {
  el.hidden = !message;
  el.textContent = message || "";
  el.classList.toggle("ok", Boolean(ok));
  el.classList.toggle("bad", !ok);
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
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
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  return status || "";
}

function phaseLabel(job) {
  const phase = job.phase || "";
  if (job.status === "queued") return "等待调度";
  if (job.status === "done") return job.count != null ? `保留 ${job.count} 源` : "完成";
  if (job.status === "failed") return job.error || "失败";
  if (phase === "download") return "下载阅读源…";
  if (phase === "convert") return "转换规则…";
  if (phase === "verify") {
    if (job.progress?.total) {
      return `抽测 ${job.progress.done || 0}/${job.progress.total} · 保留 ${job.progress.kept || 0} · 跳过 ${job.progress.skipped || 0}`;
    }
    return "抽测中…";
  }
  if (phase === "analyze") return "识站分析…";
  if (phase === "save") return "写入制品…";
  if (job.status === "running") return "处理中…";
  return "等待中";
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
      ? `<div class="meta" style="color:var(--bad)">${escapeHtml(job.error)}</div>`
      : "";
    const actions = [
      job.status === "done" ? `<button type="button" data-copy="${job.id}">复制订阅 URL</button>` : "",
      job.status === "failed" ? `<button type="button" data-retry="${job.id}">重试</button>` : "",
      `<button type="button" class="danger" data-del="${job.id}">删除</button>`,
    ].filter(Boolean).join("");
    return `
      <article class="job" data-id="${job.id}">
        <p class="job-title"><span class="badge ${job.status}">${statusLabel(job.status)}</span>${escapeHtml(job.title || job.id)}</p>
        <p class="meta">${escapeHtml(job.sourceUrl || "")}</p>
        <p class="meta">${escapeHtml(progressText)}</p>
        <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
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

async function refreshJobs() {
  const data = await api("/api/jobs");
  renderJobs(data.jobs || []);
  const busy = (data.jobs || []).some((job) => job.status === "queued" || job.status === "running");
  if (busy) schedulePoll();
}

let pollTimer = 0;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    refreshJobs().catch(() => {});
  }, 2000);
}

els.token.value = getToken();

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setToken(els.token.value.trim());
  try {
    await refreshJobs();
    showStatus(els.authStatus, "口令已保存，任务列表可访问", true);
  } catch (error) {
    showStatus(els.authStatus, error.message || "鉴权失败", false);
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
    showStatus(els.createStatus, error.message || "创建失败", false);
  } finally {
    button.disabled = false;
  }
});

els.refresh.addEventListener("click", () => {
  refreshJobs().catch((error) => showStatus(els.authStatus, error.message, false));
});

els.jobs.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const copyId = target.getAttribute("data-copy");
  const retryId = target.getAttribute("data-retry");
  const delId = target.getAttribute("data-del");
  try {
    if (copyId) {
      const job = (await api(`/api/jobs/${copyId}`));
      await navigator.clipboard.writeText(subscribeUrl(job));
      showStatus(els.createStatus, "订阅 URL 已复制", true);
    }
    if (retryId) {
      await api(`/api/jobs/${retryId}/retry`, { method: "POST", body: "{}" });
      await refreshJobs();
    }
    if (delId) {
      if (!window.confirm("删除该任务及制品？")) return;
      await api(`/api/jobs/${delId}`, { method: "DELETE" });
      await refreshJobs();
    }
  } catch (error) {
    showStatus(els.createStatus, error.message || "操作失败", false);
  }
});

if (getToken()) {
  refreshJobs().catch((error) => showStatus(els.authStatus, error.message, false));
} else {
  renderJobs([]);
  showStatus(els.authStatus, "请先填写 ADMIN_TOKEN", false);
}
