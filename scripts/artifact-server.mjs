#!/usr/bin/env node
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ROOT = path.join(os.homedir(), ".codex", "html-artifacts");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"]
]);

const STATUS_LABELS = {
  draft: "草稿",
  "in-progress": "进行中",
  blocked: "阻塞",
  done: "已完成",
  archived: "已归档"
};

function parseArgs(argv) {
  const args = {
    root: process.env.ARTIFACT_ROOT || DEFAULT_ROOT,
    host: process.env.ARTIFACT_HOST || DEFAULT_HOST,
    port: Number(process.env.ARTIFACT_PORT || DEFAULT_PORT)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--host") {
      args.host = argv[++index];
    } else if (arg === "--port") {
      args.port = Number(argv[++index]);
    }
  }

  return args;
}

function printHelp() {
  const script = path.basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} [--root <dir>] [--host <host>] [--port <port>]

Default root: ${DEFAULT_ROOT}
Default host: ${DEFAULT_HOST}
Default port: ${DEFAULT_PORT}

Environment variables:
  ARTIFACT_ROOT
  ARTIFACT_HOST
  ARTIFACT_PORT

Routes:
  GET  /
  GET  /artifacts/:id
  GET  /api/artifacts
  GET  /api/artifacts/:id
  GET  /api/artifacts/:id/state
  PUT  /api/artifacts/:id/state
  POST /api/artifacts/:id/checkpoints/:checkpointId/toggle
  POST /api/artifacts/:id/notes`);
}

function isArtifactId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

function sendError(res, status, message) {
  sendJson(res, status, {
    error: message
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    const size = chunks.reduce((sum, current) => sum + current.length, 0);
    if (size > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, {
    recursive: true
  });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function createStore(root) {
  const absoluteRoot = path.resolve(root);

  function artifactDir(id) {
    if (!isArtifactId(id)) {
      throw new Error(`Invalid artifact id: ${id}`);
    }
    return path.join(absoluteRoot, id);
  }

  async function ensureRoot() {
    await fs.mkdir(absoluteRoot, {
      recursive: true
    });
  }

  async function listArtifacts() {
    await ensureRoot();
    const entries = await fs.readdir(absoluteRoot, {
      withFileTypes: true
    });
    const artifacts = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !isArtifactId(entry.name)) {
        continue;
      }

      const dir = artifactDir(entry.name);
      const metadataPath = path.join(dir, "artifact.json");
      const statePath = path.join(dir, "state.json");
      const indexPath = path.join(dir, "index.html");
      if (!(await fileExists(indexPath))) {
        continue;
      }

      const stat = await fs.stat(indexPath);
      const metadata = await readJson(metadataPath, {
        id: entry.name,
        title: entry.name,
        type: "html-artifact",
        entry: "index.html",
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        tags: []
      });
      const state = await readJson(statePath, defaultState());

      artifacts.push(normalizeArtifact(metadata, state, entry.name));
    }

    artifacts.sort((left, right) => {
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });
    return artifacts;
  }

  async function getArtifact(id) {
    const dir = artifactDir(id);
    const indexPath = path.join(dir, "index.html");
    if (!(await fileExists(indexPath))) {
      return null;
    }
    const stat = await fs.stat(indexPath);
    const metadata = await readJson(path.join(dir, "artifact.json"), {
      id,
      title: id,
      type: "html-artifact",
      entry: "index.html",
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      tags: []
    });
    const state = await getState(id);
    return normalizeArtifact(metadata, state, id);
  }

  async function getState(id) {
    return normalizeState(await readJson(path.join(artifactDir(id), "state.json"), defaultState()));
  }

  async function putState(id, state) {
    const normalized = normalizeState(state);
    await writeJsonAtomic(path.join(artifactDir(id), "state.json"), normalized);
    return normalized;
  }

  async function toggleCheckpoint(id, checkpointId) {
    const state = await getState(id);
    const checkpoint = state.checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    checkpoint.done = !checkpoint.done;
    checkpoint.doneAt = checkpoint.done ? new Date().toISOString() : null;
    state.history.push({
      at: new Date().toISOString(),
      type: checkpoint.done ? "checkpoint.done" : "checkpoint.reopened",
      checkpointId
    });

    await putState(id, state);
    return state;
  }

  async function addNote(id, note) {
    const state = await getState(id);
    const text = String(note.text ?? "").trim();
    if (!text) {
      throw new Error("Note text is required.");
    }

    const item = {
      id: `note-${Date.now()}`,
      at: new Date().toISOString(),
      text
    };
    state.notes.push(item);
    state.history.push({
      at: item.at,
      type: "note.added",
      noteId: item.id
    });

    await putState(id, state);
    return state;
  }

  async function readStaticFile(id, relativePath) {
    const dir = artifactDir(id);
    const safeRelativePath = relativePath || "index.html";
    const targetPath = path.resolve(dir, safeRelativePath);
    const relativeToDir = path.relative(dir, targetPath);
    if (relativeToDir.startsWith("..") || path.isAbsolute(relativeToDir)) {
      return null;
    }

    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        return null;
      }
      return {
        buffer: await fs.readFile(targetPath),
        contentType: MIME_TYPES.get(path.extname(targetPath).toLowerCase()) || "application/octet-stream"
      };
    } catch {
      return null;
    }
  }

  return {
    root: absoluteRoot,
    ensureRoot,
    listArtifacts,
    getArtifact,
    getState,
    putState,
    toggleCheckpoint,
    addNote,
    readStaticFile
  };
}

function defaultState() {
  return {
    status: "in-progress",
    checkpoints: [],
    notes: [],
    history: []
  };
}

function normalizeArtifact(metadata, state, fallbackId) {
  return {
    id: String(metadata.id || fallbackId),
    title: String(metadata.title || metadata.id || fallbackId),
    type: String(metadata.type || "html-artifact"),
    createdAt: metadata.createdAt || null,
    updatedAt: metadata.updatedAt || metadata.createdAt || null,
    source: metadata.source || {},
    entry: metadata.entry || "index.html",
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    status: state.status || "in-progress",
    checkpointCount: state.checkpoints.length,
    doneCheckpointCount: state.checkpoints.filter((item) => item.done).length
  };
}

function normalizeState(state) {
  return {
    status: String(state?.status || "in-progress"),
    checkpoints: Array.isArray(state?.checkpoints)
      ? state.checkpoints.map((item) => ({
          id: String(item.id || ""),
          title: String(item.title || item.id || ""),
          done: Boolean(item.done),
          doneAt: item.doneAt || null,
          note: String(item.note || "")
        })).filter((item) => item.id)
      : [],
    notes: Array.isArray(state?.notes)
      ? state.notes.map((item) => ({
          id: String(item.id || `note-${Date.now()}`),
          at: item.at || null,
          text: String(item.text || "")
        })).filter((item) => item.text)
      : [],
    history: Array.isArray(state?.history) ? state.history : []
  };
}

function dashboardPage(root) {
  return pageShell("Artifact 工作台", `
    <main class="dashboard">
      <header class="topbar">
        <div>
          <h1>Artifact 工作台</h1>
          <p>发布目录：<code>${escapeHtml(root)}</code></p>
        </div>
        <button id="refresh" type="button">刷新</button>
      </header>
      <section class="filters">
        <input id="query" type="search" placeholder="搜索标题、类型、标签">
        <select id="status">
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="in-progress">进行中</option>
          <option value="blocked">阻塞</option>
          <option value="done">已完成</option>
          <option value="archived">已归档</option>
        </select>
      </section>
      <section id="list" class="artifact-list" aria-live="polite"></section>
    </main>
    <script>
      const list = document.querySelector("#list");
      const query = document.querySelector("#query");
      const status = document.querySelector("#status");
      const refresh = document.querySelector("#refresh");
      let artifacts = [];

      function escapeHtml(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function formatDate(value) {
        if (!value) {
          return "";
        }
        return new Date(value).toLocaleString();
      }

      function render() {
        const text = query.value.trim().toLowerCase();
        const selectedStatus = status.value;
        const filtered = artifacts.filter((artifact) => {
          const haystack = [artifact.title, artifact.type, artifact.status, ...(artifact.tags || [])].join(" ").toLowerCase();
          return (!text || haystack.includes(text)) && (!selectedStatus || artifact.status === selectedStatus);
        });

        if (!filtered.length) {
          list.innerHTML = '<div class="empty">暂无匹配 artifact。把包含 index.html 的目录放进发布目录即可显示。</div>';
          return;
        }

        list.innerHTML = filtered.map((artifact) => {
          const progress = artifact.checkpointCount
            ? \`\${artifact.doneCheckpointCount}/\${artifact.checkpointCount} 阶段完成\`
            : "无阶段";
          return \`
            <article class="artifact-card">
              <div>
                <a class="artifact-title" href="/artifacts/\${encodeURIComponent(artifact.id)}">\${escapeHtml(artifact.title)}</a>
                <p>\${escapeHtml(artifact.type)} · \${escapeHtml(progress)} · 更新于 \${escapeHtml(formatDate(artifact.updatedAt))}</p>
              </div>
              <span class="status" data-status="\${escapeHtml(artifact.status)}">\${escapeHtml(artifact.status)}</span>
            </article>
          \`;
        }).join("");
      }

      async function load() {
        list.innerHTML = '<div class="empty">加载中...</div>';
        const response = await fetch("/api/artifacts");
        artifacts = await response.json();
        render();
      }

      query.addEventListener("input", render);
      status.addEventListener("change", render);
      refresh.addEventListener("click", load);
      load().catch((error) => {
        list.innerHTML = '<div class="empty">加载失败：' + escapeHtml(error.message) + '</div>';
      });
    </script>
  `);
}

function artifactPage(artifact) {
  const title = escapeHtml(artifact.title);
  return pageShell(`${title} - Artifact`, `
    <main class="artifact-view">
      <section class="artifact-frame">
        <header>
          <a href="/" class="back">返回列表</a>
          <h1>${title}</h1>
        </header>
        <iframe title="${title}" src="/files/${encodeURIComponent(artifact.id)}/${encodeURIComponent(artifact.entry)}"></iframe>
      </section>
      <aside class="state-panel">
        <div class="panel-header">
          <h2>执行状态</h2>
          <span id="statusLabel" class="status">${escapeHtml(STATUS_LABELS[artifact.status] || artifact.status)}</span>
        </div>
        <section>
          <h3>阶段</h3>
          <div id="checkpoints" class="checkpoints"></div>
        </section>
        <section>
          <h3>备注</h3>
          <form id="noteForm">
            <textarea id="noteText" rows="3" placeholder="添加备注"></textarea>
            <button type="submit">保存备注</button>
          </form>
          <div id="notes" class="notes"></div>
        </section>
        <section>
          <h3>导出</h3>
          <button id="copyState" type="button">复制状态 JSON</button>
        </section>
      </aside>
    </main>
    <script>
      const artifactId = ${JSON.stringify(artifact.id)};
      const checkpoints = document.querySelector("#checkpoints");
      const notes = document.querySelector("#notes");
      const statusLabel = document.querySelector("#statusLabel");
      const noteForm = document.querySelector("#noteForm");
      const noteText = document.querySelector("#noteText");
      const copyState = document.querySelector("#copyState");
      let state = null;

      function escapeHtml(value) {
        return String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function formatDate(value) {
        return value ? new Date(value).toLocaleString() : "";
      }

      function renderState() {
        statusLabel.textContent = state.status || "in-progress";
        if (!state.checkpoints.length) {
          checkpoints.innerHTML = '<div class="empty compact">没有阶段。可在 state.json 中添加 checkpoints。</div>';
        } else {
          checkpoints.innerHTML = state.checkpoints.map((item) => \`
            <label class="checkpoint">
              <input type="checkbox" data-id="\${escapeHtml(item.id)}" \${item.done ? "checked" : ""}>
              <span>
                <strong>\${escapeHtml(item.title)}</strong>
                <small>\${item.doneAt ? "完成于 " + escapeHtml(formatDate(item.doneAt)) : "未完成"}\${item.note ? " · " + escapeHtml(item.note) : ""}</small>
              </span>
            </label>
          \`).join("");
        }

        if (!state.notes.length) {
          notes.innerHTML = '<div class="empty compact">暂无备注。</div>';
        } else {
          notes.innerHTML = state.notes.slice().reverse().map((item) => \`
            <article class="note">
              <time>\${escapeHtml(formatDate(item.at))}</time>
              <p>\${escapeHtml(item.text)}</p>
            </article>
          \`).join("");
        }
      }

      async function loadState() {
        const response = await fetch(\`/api/artifacts/\${encodeURIComponent(artifactId)}/state\`);
        state = await response.json();
        renderState();
      }

      checkpoints.addEventListener("change", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        const checkpointId = target.dataset.id;
        const response = await fetch(\`/api/artifacts/\${encodeURIComponent(artifactId)}/checkpoints/\${encodeURIComponent(checkpointId)}/toggle\`, {
          method: "POST"
        });
        state = await response.json();
        renderState();
      });

      noteForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = noteText.value.trim();
        if (!text) {
          return;
        }
        const response = await fetch(\`/api/artifacts/\${encodeURIComponent(artifactId)}/notes\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ text })
        });
        state = await response.json();
        noteText.value = "";
        renderState();
      });

      copyState.addEventListener("click", async () => {
        await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
        copyState.textContent = "已复制";
        setTimeout(() => {
          copyState.textContent = "复制状态 JSON";
        }, 1200);
      });

      loadState().catch((error) => {
        checkpoints.innerHTML = '<div class="empty compact">状态加载失败：' + escapeHtml(error.message) + '</div>';
      });
    </script>
  `);
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1f2933;
      --muted: #667085;
      --border: #d7dde5;
      --accent: #2563eb;
      --done: #0f766e;
      --blocked: #b42318;
      font-family: Inter, "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }
    button,
    input,
    select,
    textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      padding: 8px 12px;
    }
    button:hover {
      border-color: var(--accent);
    }
    code {
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 0.92em;
    }
    .dashboard {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h1,
    h2,
    h3,
    p {
      margin-top: 0;
    }
    h1 {
      margin-bottom: 6px;
      font-size: 28px;
      letter-spacing: 0;
    }
    p {
      color: var(--muted);
      line-height: 1.6;
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr 160px;
      gap: 10px;
      margin-bottom: 14px;
    }
    .filters input,
    .filters select,
    textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      padding: 10px 12px;
    }
    .artifact-list {
      display: grid;
      gap: 10px;
    }
    .artifact-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px 16px;
    }
    .artifact-title {
      color: var(--text);
      font-weight: 700;
      text-decoration: none;
    }
    .artifact-title:hover {
      color: var(--accent);
    }
    .artifact-card p {
      margin: 4px 0 0;
      font-size: 14px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 4px 10px;
      color: var(--muted);
      white-space: nowrap;
      font-size: 13px;
    }
    .status[data-status="done"] {
      color: var(--done);
      border-color: color-mix(in srgb, var(--done) 40%, var(--border));
    }
    .status[data-status="blocked"] {
      color: var(--blocked);
      border-color: color-mix(in srgb, var(--blocked) 40%, var(--border));
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      padding: 20px;
    }
    .empty.compact {
      padding: 10px;
      font-size: 14px;
    }
    .artifact-view {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      min-height: 100vh;
    }
    .artifact-frame {
      min-width: 0;
      padding: 16px;
    }
    .artifact-frame header {
      display: flex;
      align-items: baseline;
      gap: 14px;
      margin-bottom: 12px;
    }
    .back {
      color: var(--accent);
      text-decoration: none;
      white-space: nowrap;
    }
    iframe {
      width: 100%;
      height: calc(100vh - 88px);
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #ffffff;
    }
    .state-panel {
      border-left: 1px solid var(--border);
      background: var(--panel);
      padding: 18px;
      overflow: auto;
      max-height: 100vh;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }
    .state-panel section {
      border-top: 1px solid var(--border);
      padding-top: 16px;
      margin-top: 16px;
    }
    .checkpoints {
      display: grid;
      gap: 10px;
    }
    .checkpoint {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 10px;
      align-items: start;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .checkpoint small {
      display: block;
      color: var(--muted);
      line-height: 1.45;
      margin-top: 2px;
    }
    .notes {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .note {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .note time {
      color: var(--muted);
      font-size: 12px;
    }
    .note p {
      color: var(--text);
      margin: 6px 0 0;
    }
    #noteForm {
      display: grid;
      gap: 8px;
    }
    @media (max-width: 900px) {
      .artifact-view {
        grid-template-columns: 1fr;
      }
      .state-panel {
        border-left: 0;
        border-top: 1px solid var(--border);
        max-height: none;
      }
      iframe {
        height: 70vh;
      }
    }
    @media (max-width: 640px) {
      .topbar,
      .artifact-card,
      .artifact-frame header {
        display: block;
      }
      .filters {
        grid-template-columns: 1fr;
      }
      .dashboard {
        width: min(100vw - 20px, 1120px);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --panel: #172033;
        --text: #f3f4f6;
        --muted: #a8b3c7;
        --border: #314058;
        --accent: #7aa2ff;
      }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function routeMatch(pathname, pattern) {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = safeDecode(pathParts[index]);
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}

async function handleRequest(store, req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/") {
      return send(res, 200, dashboardPage(store.root), "text/html; charset=utf-8");
    }

    let params = routeMatch(pathname, "/artifacts/:id");
    if (req.method === "GET" && params) {
      const artifact = await store.getArtifact(params.id);
      if (!artifact) {
        return sendError(res, 404, "Artifact not found.");
      }
      return send(res, 200, artifactPage(artifact), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && pathname === "/api/artifacts") {
      return sendJson(res, 200, await store.listArtifacts());
    }

    params = routeMatch(pathname, "/api/artifacts/:id");
    if (req.method === "GET" && params) {
      const artifact = await store.getArtifact(params.id);
      if (!artifact) {
        return sendError(res, 404, "Artifact not found.");
      }
      return sendJson(res, 200, artifact);
    }

    params = routeMatch(pathname, "/api/artifacts/:id/state");
    if (params) {
      if (!(await store.getArtifact(params.id))) {
        return sendError(res, 404, "Artifact not found.");
      }
      if (req.method === "GET") {
        return sendJson(res, 200, await store.getState(params.id));
      }
      if (req.method === "PUT") {
        return sendJson(res, 200, await store.putState(params.id, await readBody(req)));
      }
    }

    params = routeMatch(pathname, "/api/artifacts/:id/checkpoints/:checkpointId/toggle");
    if (req.method === "POST" && params) {
      if (!(await store.getArtifact(params.id))) {
        return sendError(res, 404, "Artifact not found.");
      }
      return sendJson(res, 200, await store.toggleCheckpoint(params.id, params.checkpointId));
    }

    params = routeMatch(pathname, "/api/artifacts/:id/notes");
    if (req.method === "POST" && params) {
      if (!(await store.getArtifact(params.id))) {
        return sendError(res, 404, "Artifact not found.");
      }
      return sendJson(res, 200, await store.addNote(params.id, await readBody(req)));
    }

    if (req.method === "GET" && pathname.startsWith("/files/")) {
      const parts = pathname.split("/").filter(Boolean);
      const id = safeDecode(parts[1] || "");
      const relativePath = parts.slice(2).map(safeDecode).join("/") || "index.html";
      if (!isArtifactId(id)) {
        return sendError(res, 400, "Invalid artifact id.");
      }

      const file = await store.readStaticFile(id, relativePath);
      if (!file) {
        return sendError(res, 404, "File not found.");
      }
      return send(res, 200, file.buffer, file.contentType);
    }

    return sendError(res, 404, "Not found.");
  } catch (error) {
    return sendError(res, 500, error.message || "Internal server error.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new Error("Port must be a positive integer.");
  }

  const store = createStore(args.root);
  await store.ensureRoot();

  const server = createServer((req, res) => {
    void handleRequest(store, req, res);
  });

  server.listen(args.port, args.host, () => {
    const urlHost = args.host === "0.0.0.0" ? "localhost" : args.host;
    console.log(`Artifact server listening at http://${urlHost}:${args.port}`);
    console.log(`Artifact root: ${store.root}`);
    if (args.host === "0.0.0.0") {
      console.log("LAN sharing is enabled. Review artifact contents before sharing the URL.");
    }
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
