#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import MiniSearch from "minisearch";
import { importBundleData } from "./import-artifact-bundle.mjs";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ROOT = path.join(os.homedir(), ".codex", "html-artifacts");

const STATUS_LABELS = {
  draft: "草稿",
  "in-progress": "进行中",
  blocked: "阻塞",
  done: "已完成",
  archived: "已归档"
};

const TYPE_LABELS = {
  "architecture-explainer": "架构说明",
  "code-review": "代码评审",
  "custom-editor": "定制编辑器",
  "html-artifact": "HTML Artifact",
  "implementation-plan": "实施计划",
  "research-report": "调研报告"
};

function parseArgs(argv) {
  const args = {
    root: process.env.ARTIFACT_ROOT || DEFAULT_ROOT,
    host: process.env.ARTIFACT_HOST || DEFAULT_HOST,
    port: Number(process.env.ARTIFACT_PORT || DEFAULT_PORT),
    token: process.env.ARTIFACT_TOKEN || "",
    readToken: process.env.ARTIFACT_READ_TOKEN || ""
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
    } else if (arg === "--token") {
      args.token = argv[++index] || "";
    } else if (arg === "--read-token") {
      args.readToken = argv[++index] || "";
    }
  }

  return args;
}

function printHelp() {
  const script = path.basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} [--root <dir>] [--host <host>] [--port <port>] [--token <token>] [--read-token <token>]

Default root: ${DEFAULT_ROOT}
Default host: ${DEFAULT_HOST}
Default port: ${DEFAULT_PORT}

Environment variables:
  ARTIFACT_ROOT
  ARTIFACT_HOST
  ARTIFACT_PORT
  ARTIFACT_TOKEN
  ARTIFACT_READ_TOKEN

Routes:
  GET  /
  GET  /artifacts/:id
  GET  /api/health
  GET  /api/artifacts
  GET  /api/artifacts/search
  GET  /api/export
  POST /api/import
  GET  /api/collections
  GET  /api/collections/:id/markdown
  GET  /api/artifacts/:id
  GET  /api/artifacts/:id/markdown
  GET  /api/artifacts/:id/export
  GET  /api/artifacts/:id/state
  PUT  /api/artifacts/:id/state
  POST /api/artifacts/:id/checkpoints/:checkpointId/toggle
  POST /api/artifacts/:id/notes
  POST /api/artifacts/:id/notes/:noteId/resolve
  POST /api/artifacts/:id/notes/:noteId/reopen`);
}

function isArtifactId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug || "collection";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function typeLabel(type) {
  return TYPE_LABELS[type] || type || "未分类";
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (key) {
      cookies.set(key, decodeURIComponent(value));
    }
  }
  return cookies;
}

function authTokenFromRequest(request) {
  const queryToken = request.query?.token;
  if (typeof queryToken === "string" && queryToken) {
    return queryToken;
  }

  const headerToken = request.headers["x-artifact-token"];
  if (typeof headerToken === "string" && headerToken) {
    return headerToken;
  }

  const authorization = request.headers.authorization || "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearerMatch) {
    return bearerMatch[1];
  }

  return parseCookies(request.headers.cookie).get("artifact_token") || "";
}

function isApiRequest(request) {
  return request.url.startsWith("/api/");
}

function isReadMethod(method) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function authModeFromRequest(request, { writeToken, readToken }) {
  const requestToken = authTokenFromRequest(request);
  if (writeToken && requestToken === writeToken) {
    return {
      mode: "write",
      token: requestToken
    };
  }
  if (readToken && requestToken === readToken) {
    return {
      mode: "read",
      token: requestToken
    };
  }
  return null;
}

function tokenPromptPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>需要访问 Token</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f6f7f9;
      color: #1f2933;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      border: 1px solid #d7dde5;
      border-radius: 8px;
      background: #ffffff;
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
    }
    p {
      color: #667085;
      line-height: 1.6;
    }
    form {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }
    input,
    button {
      min-height: 40px;
      border: 1px solid #d7dde5;
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    button {
      background: #2563eb;
      color: #ffffff;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main>
    <h1>需要访问 Token</h1>
    <p>这个 Artifact 服务启用了局域网访问保护。请输入启动服务时配置的 token。</p>
    <form method="get">
      <input name="token" type="password" autocomplete="current-password" autofocus>
      <button type="submit">进入</button>
    </form>
  </main>
</body>
</html>`;
}

function appendToken(url, token) {
  if (!token) {
    return url;
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function localNetworkUrls(port) {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`http://${item.address}:${port}`);
      }
    }
  }
  return urls;
}

function serverUrls({ host, port, token }) {
  const loopbackUrl = appendToken(`http://127.0.0.1:${port}`, token);
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  const primaryUrl = appendToken(`http://${displayHost}:${port}`, token);
  const lanUrls = host === "0.0.0.0"
    ? localNetworkUrls(port).map((url) => appendToken(url, token))
    : [];
  return {
    primaryUrl,
    loopbackUrl,
    lanUrls
  };
}

function startupListenError(error, args) {
  if (error?.code !== "EADDRINUSE") {
    return error;
  }
  const message = [
    `Port ${args.port} is already in use on ${args.host}.`,
    `Try another port: node scripts/artifact-server.mjs --port ${args.port + 1}`,
    "Or stop the existing artifact server process and retry."
  ].join("\n");
  const wrapped = new Error(message);
  wrapped.code = error.code;
  wrapped.cause = error;
  return wrapped;
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

    artifacts.sort(compareArtifacts("updated-desc"));
    return artifacts;
  }

  async function readCollectionConfig() {
    const raw = await readJson(path.join(absoluteRoot, "collection.json"), {
      collections: []
    });
    const collections = Array.isArray(raw) ? raw : raw.collections;
    return Array.isArray(collections)
      ? collections.map(normalizeCollectionConfig).filter((item) => item.id)
      : [];
  }

  async function listCollections() {
    const artifacts = await listArtifacts();
    const configs = await readCollectionConfig();
    return buildCollections(configs, artifacts);
  }

  async function getCollectionMarkdown(id) {
    const collection = (await listCollections()).find((item) => item.id === id);
    if (!collection) {
      return null;
    }
    return collectionMarkdown(collection);
  }

  async function searchArtifacts(filters) {
    const allArtifacts = await listArtifacts();
    let items = allArtifacts;

    const query = String(filters.query || "").trim();
    if (query) {
      const search = new MiniSearch({
        fields: ["title", "type", "status", "tagsText", "id"],
        storeFields: ["id"],
        searchOptions: {
          boost: {
            title: 3,
            tagsText: 2,
            type: 1.5
          },
          fuzzy: 0.2,
          prefix: true
        }
      });
      search.addAll(allArtifacts.map((artifact) => ({
        ...artifact,
        tagsText: artifact.tags.join(" ")
      })));
      const matchedIds = new Set(search.search(query).map((result) => result.id));
      items = items.filter((artifact) => matchedIds.has(artifact.id));
    }

    if (filters.status) {
      items = items.filter((artifact) => artifact.status === filters.status);
    } else if (filters.archived === "only") {
      items = items.filter((artifact) => artifact.status === "archived");
    } else if (filters.archived !== "include") {
      items = items.filter((artifact) => artifact.status !== "archived");
    }
    if (filters.type) {
      items = items.filter((artifact) => artifact.type === filters.type);
    }
    if (filters.tag) {
      items = items.filter((artifact) => artifact.tags.includes(filters.tag));
    }
    if (filters.collection) {
      const collection = (await listCollections()).find((item) => item.id === filters.collection);
      const artifactIds = new Set((collection?.artifacts || []).map((artifact) => artifact.id));
      items = items.filter((artifact) => artifactIds.has(artifact.id));
    }

    items = items.slice().sort(compareArtifacts(filters.sort || "updated-desc"));
    return {
      items,
      facets: buildFacets(allArtifacts),
      stats: buildStats(allArtifacts),
      filteredCount: items.length
    };
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

  async function getArtifactMarkdown(id) {
    const artifact = await getArtifact(id);
    if (!artifact) {
      return null;
    }
    const state = await getState(id);
    return artifactStateMarkdown(artifact, state);
  }

  async function getArtifactBundle(id) {
    const artifact = await getArtifact(id);
    if (!artifact) {
      return null;
    }
    const state = await getState(id);
    const indexHtml = await fs.readFile(path.join(artifactDir(id), artifact.entry || "index.html"), "utf8");
    return {
      exportedAt: new Date().toISOString(),
      artifact,
      state,
      indexHtml
    };
  }

  async function getAllArtifactsBundle() {
    const artifacts = await listArtifacts();
    const collectionConfig = await readJson(path.join(absoluteRoot, "collection.json"), {
      collections: []
    });
    const bundledArtifacts = [];

    for (const artifact of artifacts) {
      const dir = artifactDir(artifact.id);
      const indexPath = path.join(dir, artifact.entry || "index.html");
      const metadata = await readJson(path.join(dir, "artifact.json"), artifact);
      const state = await getState(artifact.id);
      const indexHtml = await fs.readFile(indexPath, "utf8");
      bundledArtifacts.push({
        id: artifact.id,
        artifact: metadata,
        state,
        indexHtml
      });
    }

    return {
      format: "html-artifact-deliverable.all.v1",
      exportedAt: new Date().toISOString(),
      artifactCount: bundledArtifacts.length,
      collectionConfig,
      artifacts: bundledArtifacts
    };
  }

  async function importAllArtifactsBundle(payload) {
    const bundle = payload?.bundle || payload;
    const overwrite = Boolean(payload?.overwrite);
    return importBundleData({
      bundle,
      root: absoluteRoot,
      overwrite
    });
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
      const error = new Error(`Checkpoint not found: ${checkpointId}`);
      error.statusCode = 404;
      throw error;
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
    const text = String(note?.text ?? "").trim();
    if (!text) {
      const error = new Error("Note text is required.");
      error.statusCode = 400;
      throw error;
    }

    const item = {
      id: `note-${Date.now()}`,
      at: new Date().toISOString(),
      text,
      author: String(note?.author || "").trim(),
      category: String(note?.category || "general").trim() || "general",
      checkpointId: String(note?.checkpointId || "").trim(),
      resolved: false,
      resolvedAt: null
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

  async function setNoteResolved(id, noteId, resolved) {
    const state = await getState(id);
    const note = state.notes.find((item) => item.id === noteId);
    if (!note) {
      const error = new Error(`Note not found: ${noteId}`);
      error.statusCode = 404;
      throw error;
    }

    note.resolved = Boolean(resolved);
    note.resolvedAt = note.resolved ? new Date().toISOString() : null;
    state.history.push({
      at: new Date().toISOString(),
      type: note.resolved ? "note.resolved" : "note.reopened",
      noteId
    });

    await putState(id, state);
    return state;
  }

  function getArtifactFileRoot(id) {
    return artifactDir(id);
  }

  return {
    root: absoluteRoot,
    ensureRoot,
    listArtifacts,
    searchArtifacts,
    listCollections,
    getCollectionMarkdown,
    getArtifact,
    getArtifactMarkdown,
    getArtifactBundle,
    getAllArtifactsBundle,
    importAllArtifactsBundle,
    getState,
    putState,
    toggleCheckpoint,
    addNote,
    setNoteResolved,
    getArtifactFileRoot
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
  const checkpointCount = state.checkpoints.length;
  const doneCheckpointCount = state.checkpoints.filter((item) => item.done).length;
  return {
    id: String(metadata.id || fallbackId),
    title: String(metadata.title || metadata.id || fallbackId),
    type: String(metadata.type || "html-artifact"),
    typeLabel: typeLabel(metadata.type || "html-artifact"),
    createdAt: metadata.createdAt || null,
    updatedAt: metadata.updatedAt || metadata.createdAt || null,
    source: metadata.source || {},
    entry: metadata.entry || "index.html",
    tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
    collection: normalizeArtifactCollection(metadata.collection),
    status: state.status || "in-progress",
    statusLabel: statusLabel(state.status || "in-progress"),
    checkpointCount,
    doneCheckpointCount,
    progressPercent: checkpointCount ? Math.round((doneCheckpointCount / checkpointCount) * 100) : null,
    noteCount: state.notes.length
  };
}

function normalizeArtifactCollection(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return {
      id: slugify(value),
      title: value
    };
  }
  const rawId = value.id || value.title || value.name || "";
  if (!rawId) {
    return null;
  }
  const id = slugify(rawId);
  return {
    id,
    title: String(value.title || value.name || value.id || id)
  };
}

function normalizeCollectionConfig(value) {
  const rawId = value?.id || value?.title || value?.name || "";
  if (!rawId) {
    return null;
  }
  const id = slugify(rawId);
  return {
    id,
    title: String(value.title || value.name || value.id || id),
    description: String(value.description || ""),
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds.map(String) : [],
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || value.createdAt || null
  };
}

function buildCollections(configs, artifacts) {
  const collections = new Map();
  for (const config of configs) {
    collections.set(config.id, {
      ...config,
      artifactIds: [...config.artifactIds]
    });
  }

  for (const artifact of artifacts) {
    if (!artifact.collection?.id) {
      continue;
    }
    const existing = collections.get(artifact.collection.id) || {
      id: artifact.collection.id,
      title: artifact.collection.title || artifact.collection.id,
      description: "",
      tags: [],
      artifactIds: [],
      createdAt: null,
      updatedAt: null
    };
    if (!existing.artifactIds.includes(artifact.id)) {
      existing.artifactIds.push(artifact.id);
    }
    if (artifact.collection.title && (!existing.title || existing.title === existing.id)) {
      existing.title = artifact.collection.title;
    }
    collections.set(existing.id, existing);
  }

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return [...collections.values()].map((collection) => {
    const collectionArtifacts = collection.artifactIds
      .map((id) => artifactById.get(id))
      .filter(Boolean);
    const checkpointCount = collectionArtifacts.reduce((sum, item) => sum + item.checkpointCount, 0);
    const doneCheckpointCount = collectionArtifacts.reduce((sum, item) => sum + item.doneCheckpointCount, 0);
    const noteCount = collectionArtifacts.reduce((sum, item) => sum + item.noteCount, 0);
    const updatedAt = collection.updatedAt
      || collectionArtifacts.map((item) => item.updatedAt).filter(Boolean).sort().at(-1)
      || null;
    return {
      id: collection.id,
      title: collection.title,
      description: collection.description,
      tags: collection.tags,
      createdAt: collection.createdAt,
      updatedAt,
      artifactCount: collectionArtifacts.length,
      checkpointCount,
      doneCheckpointCount,
      progressPercent: checkpointCount ? Math.round((doneCheckpointCount / checkpointCount) * 100) : null,
      noteCount,
      artifacts: collectionArtifacts
    };
  }).filter((collection) => collection.artifactCount > 0)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
      || left.title.localeCompare(right.title, "zh-CN"));
}

function collectionMarkdown(collection) {
  const lines = [
    `# ${collection.title}`,
    "",
    collection.description || "",
    "",
    `- Artifact 数量：${collection.artifactCount}`,
    `- 阶段进度：${collection.checkpointCount ? `${collection.doneCheckpointCount}/${collection.checkpointCount}` : "0/0"}`,
    `- 评论数量：${collection.noteCount}`,
    ""
  ].filter((line, index, array) => line || array[index - 1] !== "");

  for (const artifact of collection.artifacts) {
    const progress = artifact.checkpointCount
      ? `${artifact.doneCheckpointCount}/${artifact.checkpointCount} (${artifact.progressPercent}%)`
      : "无阶段";
    lines.push(`## ${artifact.title}`, "");
    lines.push(`- ID：${artifact.id}`);
    lines.push(`- 类型：${artifact.typeLabel}`);
    lines.push(`- 状态：${artifact.statusLabel}`);
    lines.push(`- 阶段进度：${progress}`);
    lines.push(`- 评论数量：${artifact.noteCount}`);
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function artifactStateMarkdown(artifact, state) {
  const lines = [
    `# ${artifact.title}`,
    "",
    `- ID：${artifact.id}`,
    `- 类型：${artifact.typeLabel}`,
    `- 状态：${statusLabel(state.status)}`,
    `- 阶段进度：${state.checkpoints.length ? `${state.checkpoints.filter((item) => item.done).length}/${state.checkpoints.length}` : "0/0"}`,
    `- 评论数量：${state.notes.length}`,
    ""
  ];

  if (state.checkpoints.length) {
    lines.push("## 阶段", "");
    for (const item of state.checkpoints) {
      const doneAt = item.done && item.doneAt ? ` （${item.doneAt}）` : "";
      lines.push(`- [${item.done ? "x" : " "}] ${item.title}${doneAt}`);
      if (item.note) {
        lines.push(`  - 备注：${item.note}`);
      }
    }
    lines.push("");
  }

  if (state.notes.length) {
    lines.push("## 评论", "");
    lines.push(...commentsMarkdownLines(state));
    lines.push("");
  }

  if (state.history.length) {
    lines.push("## 最近历史", "");
    for (const item of state.history.slice(-10).reverse()) {
      const type = item.type || "event";
      lines.push(`- ${item.at || ""}：${type}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function commentsMarkdownLines(state) {
  const checkpointTitles = new Map(state.checkpoints.map((item) => [item.id, item.title]));
  const groups = new Map([["", []]]);
  for (const checkpoint of state.checkpoints) {
    groups.set(checkpoint.id, []);
  }
  for (const item of state.notes) {
    const key = groups.has(item.checkpointId) ? item.checkpointId : "";
    groups.get(key).push(item);
  }

  const lines = [];
  for (const [checkpointId, items] of groups) {
    if (!items.length) {
      continue;
    }
    lines.push(`### ${checkpointId ? checkpointTitles.get(checkpointId) || checkpointId : "全局"}`);
    for (const item of items) {
      const meta = [
        item.resolved ? "已解决" : "未解决",
        item.category || "general",
        item.author || "",
        item.at || ""
      ].filter(Boolean).join(" / ");
      lines.push(`- ${meta}：${item.text}`);
    }
    lines.push("");
  }
  return lines.length && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
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
          text: String(item.text || ""),
          author: String(item.author || ""),
          category: String(item.category || "general"),
          checkpointId: String(item.checkpointId || ""),
          resolved: Boolean(item.resolved),
          resolvedAt: item.resolvedAt || null
        })).filter((item) => item.text)
      : [],
    history: Array.isArray(state?.history) ? state.history : []
  };
}

function compareArtifacts(sort) {
  return (left, right) => {
    if (sort === "title") {
      return left.title.localeCompare(right.title, "zh-CN");
    }
    if (sort === "progress") {
      return (right.progressPercent ?? -1) - (left.progressPercent ?? -1)
        || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    }
    if (sort === "created-desc") {
      return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
    }
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  };
}

function buildFacets(artifacts) {
  const statuses = new Map();
  const types = new Map();
  const tags = new Map();

  for (const artifact of artifacts) {
    incrementFacet(statuses, artifact.status, artifact.statusLabel);
    incrementFacet(types, artifact.type, artifact.typeLabel);
    for (const tag of artifact.tags) {
      incrementFacet(tags, tag, tag);
    }
  }

  return {
    statuses: mapFacets(statuses),
    types: mapFacets(types),
    tags: mapFacets(tags)
  };
}

function incrementFacet(map, value, label) {
  if (!value) {
    return;
  }
  const item = map.get(value) || {
    value,
    label,
    count: 0
  };
  item.count += 1;
  map.set(value, item);
}

function mapFacets(map) {
  return [...map.values()].sort((left, right) => {
    return right.count - left.count || left.label.localeCompare(right.label, "zh-CN");
  });
}

function buildStats(artifacts) {
  const totalCheckpoints = artifacts.reduce((sum, item) => sum + item.checkpointCount, 0);
  const doneCheckpoints = artifacts.reduce((sum, item) => sum + item.doneCheckpointCount, 0);
  return {
    total: artifacts.length,
    inProgress: artifacts.filter((item) => item.status === "in-progress").length,
    done: artifacts.filter((item) => item.status === "done").length,
    blocked: artifacts.filter((item) => item.status === "blocked").length,
    totalCheckpoints,
    doneCheckpoints
  };
}

function getSearchFilters(query) {
  return {
    query: query.q,
    status: query.status,
    type: query.type,
    tag: query.tag,
    collection: query.collection,
    archived: query.archived,
    sort: query.sort
  };
}

function dashboardPage(root) {
  return pageShell("Artifact 工作台", `
    <main class="dashboard">
      <header class="topbar">
        <div>
          <p class="eyebrow">HTML Artifact Workbench</p>
          <h1>Artifact 工作台</h1>
          <p>发布目录：<code>${escapeHtml(root)}</code></p>
        </div>
        <div class="toolbar">
          <a class="button-link" id="exportAll" href="${escapeHtml(appendToken("/api/export", ""))}" download="html-artifacts-bundle.json">导出全部</a>
          <button id="importAll" type="button">导入全部</button>
          <input id="importFile" type="file" accept="application/json,.json" hidden>
          <button id="refresh" type="button">刷新</button>
        </div>
      </header>

      <section id="stats" class="stats" aria-label="统计概览"></section>

      <section id="collections" class="collections" aria-label="项目集"></section>

      <section class="filters" aria-label="筛选条件">
        <label>
          <span>搜索</span>
          <input id="query" type="search" placeholder="搜索标题、类型、标签、ID">
        </label>
        <label>
          <span>状态</span>
          <select id="status"></select>
        </label>
        <label>
          <span>类型</span>
          <select id="type"></select>
        </label>
        <label>
          <span>标签</span>
          <select id="tag"></select>
        </label>
        <label>
          <span>归档</span>
          <select id="archived">
            <option value="">隐藏归档</option>
            <option value="include">包含归档</option>
            <option value="only">只看归档</option>
          </select>
        </label>
        <label>
          <span>排序</span>
          <select id="sort">
            <option value="updated-desc">最近更新</option>
            <option value="created-desc">最近创建</option>
            <option value="progress">进度优先</option>
            <option value="title">标题</option>
          </select>
        </label>
      </section>

      <section class="result-head">
        <div>
          <h2>交付物</h2>
          <p id="resultSummary">加载中...</p>
        </div>
        <div id="activeFilters" class="active-filters"></div>
      </section>

      <section id="list" class="artifact-groups" aria-live="polite"></section>
    </main>
    <script>
      const elements = {
        stats: document.querySelector("#stats"),
        collections: document.querySelector("#collections"),
        list: document.querySelector("#list"),
        query: document.querySelector("#query"),
        status: document.querySelector("#status"),
        type: document.querySelector("#type"),
        tag: document.querySelector("#tag"),
        archived: document.querySelector("#archived"),
        sort: document.querySelector("#sort"),
        refresh: document.querySelector("#refresh"),
        importAll: document.querySelector("#importAll"),
        importFile: document.querySelector("#importFile"),
        resultSummary: document.querySelector("#resultSummary"),
        activeFilters: document.querySelector("#activeFilters")
      };

      let searchResult = null;
      let collectionResult = [];
      let debounceTimer = null;
      const authToken = new URLSearchParams(location.search).get("token") || "";
      let activeCollection = new URLSearchParams(location.search).get("collection") || "";
      document.querySelector("#exportAll").href = withAuthPath("/api/export");

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
          return "无时间";
        }
        return new Date(value).toLocaleString();
      }

      function highlight(value) {
        const text = escapeHtml(value);
        const query = elements.query.value.trim();
        if (!query) {
          return text;
        }
        const words = query.split(/\\s+/).filter(Boolean).map(escapeRegExp);
        if (!words.length) {
          return text;
        }
        return text.replace(new RegExp("(" + words.join("|") + ")", "gi"), "<mark>$1</mark>");
      }

      function escapeRegExp(value) {
        return String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, "\\\\$&");
      }

      function withAuthPath(path) {
        if (!authToken) {
          return path;
        }
        const separator = path.includes("?") ? "&" : "?";
        return path + separator + "token=" + encodeURIComponent(authToken);
      }

      function setOptions(select, items, emptyLabel) {
        const selected = select.value;
        select.innerHTML = '<option value="">' + emptyLabel + '</option>'
          + items.map((item) => '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + ' (' + item.count + ')</option>').join("");
        select.value = [...select.options].some((option) => option.value === selected) ? selected : "";
      }

      function renderFacets(facets) {
        setOptions(elements.status, facets.statuses || [], "全部状态");
        setOptions(elements.type, facets.types || [], "全部类型");
        setOptions(elements.tag, facets.tags || [], "全部标签");
      }

      function renderStats(stats) {
        const checkpointText = stats.totalCheckpoints
          ? stats.doneCheckpoints + "/" + stats.totalCheckpoints
          : "0/0";
        elements.stats.innerHTML = [
          ["总数", stats.total],
          ["进行中", stats.inProgress],
          ["阻塞", stats.blocked],
          ["已完成", stats.done],
          ["阶段进度", checkpointText]
        ].map(([label, value]) => \`
          <article class="stat-card">
            <span>\${escapeHtml(label)}</span>
            <strong>\${escapeHtml(value)}</strong>
          </article>
        \`).join("");
      }

      function renderCollections(collections) {
        collectionResult = collections || [];
        if (!collectionResult.length) {
          elements.collections.innerHTML = "";
          return;
        }
        elements.collections.innerHTML = \`
          <div class="section-head">
            <div>
              <h2>项目集</h2>
              <p>按主题汇总多个 artifact 的进度。</p>
            </div>
            \${activeCollection ? '<button id="clearCollection" type="button">显示全部</button>' : ""}
          </div>
          <div class="collection-list">
            \${collectionResult.map(renderCollectionCard).join("")}
          </div>
        \`;
      }

      function renderCollectionCard(collection) {
        const progress = collection.checkpointCount
          ? collection.doneCheckpointCount + "/" + collection.checkpointCount + " 阶段 · " + collection.progressPercent + "%"
          : "无阶段";
        const href = withAuthPath("/?collection=" + encodeURIComponent(collection.id));
        return \`
          <article class="collection-card \${collection.id === activeCollection ? "active" : ""}">
            <div>
              <a href="\${href}">\${escapeHtml(collection.title)}</a>
              <p>\${escapeHtml(collection.description || progress)}</p>
              <small>\${collection.artifactCount} 个 artifact · \${escapeHtml(progress)} · \${collection.noteCount} 条评论</small>
            </div>
            <button type="button" data-collection-id="\${escapeHtml(collection.id)}">复制摘要</button>
          </article>
        \`;
      }

      function groupByStatus(items) {
        const grouped = new Map();
        for (const item of items) {
          const key = item.status || "unknown";
          if (!grouped.has(key)) {
            grouped.set(key, {
              label: item.statusLabel || key,
              items: []
            });
          }
          grouped.get(key).items.push(item);
        }
        return [...grouped.entries()];
      }

      function renderActiveFilters() {
        const chips = [];
        if (elements.query.value.trim()) {
          chips.push("搜索：" + elements.query.value.trim());
        }
        for (const element of [elements.status, elements.type, elements.tag, elements.archived]) {
          if (element.value) {
            chips.push(element.selectedOptions[0].textContent);
          }
        }
        if (activeCollection) {
          const collection = collectionResult.find((item) => item.id === activeCollection);
          chips.push("项目集：" + (collection?.title || activeCollection));
        }
        elements.activeFilters.innerHTML = chips.map((chip) => '<span>' + escapeHtml(chip) + '</span>').join("");
      }

      function renderList(items) {
        elements.resultSummary.textContent = "显示 " + items.length + " / " + searchResult.stats.total + " 个 artifact";
        renderActiveFilters();

        if (!items.length) {
          elements.list.innerHTML = '<div class="empty">没有匹配的 artifact。调整搜索词或筛选条件试试。</div>';
          return;
        }

        elements.list.innerHTML = groupByStatus(items).map(([status, group]) => \`
          <section class="artifact-group">
            <header>
              <h3>\${escapeHtml(group.label)}</h3>
              <span>\${group.items.length}</span>
            </header>
            <div class="artifact-list">
              \${group.items.map(renderCard).join("")}
            </div>
          </section>
        \`).join("");
      }

      function renderCard(artifact) {
        const progress = artifact.checkpointCount
          ? artifact.doneCheckpointCount + "/" + artifact.checkpointCount + " 阶段 · " + artifact.progressPercent + "%"
          : "无阶段";
        const tags = artifact.tags.length
          ? artifact.tags.map((tag) => '<span class="tag">' + highlight(tag) + '</span>').join("")
          : '<span class="tag muted">无标签</span>';
        return \`
          <article class="artifact-card">
            <div class="card-main">
              <a class="artifact-title" href="\${withAuthPath("/artifacts/" + encodeURIComponent(artifact.id))}">\${highlight(artifact.title)}</a>
              <p>\${escapeHtml(artifact.typeLabel)} · \${escapeHtml(progress)} · 更新于 \${escapeHtml(formatDate(artifact.updatedAt))}</p>
              <div class="tags">\${tags}</div>
            </div>
            <div class="card-side">
              <span class="status" data-status="\${escapeHtml(artifact.status)}">\${escapeHtml(artifact.statusLabel)}</span>
              <small>\${escapeHtml(artifact.id)}</small>
            </div>
          </article>
        \`;
      }

      function currentParams() {
        const params = new URLSearchParams();
        if (elements.query.value.trim()) {
          params.set("q", elements.query.value.trim());
        }
        for (const [key, element] of [["status", elements.status], ["type", elements.type], ["tag", elements.tag], ["archived", elements.archived], ["sort", elements.sort]]) {
          if (element.value) {
            params.set(key, element.value);
          }
        }
        if (authToken) {
          params.set("token", authToken);
        }
        if (activeCollection) {
          params.set("collection", activeCollection);
        }
        return params;
      }

      async function load({ preserveFacets = false } = {}) {
        elements.resultSummary.textContent = "加载中...";
        const [collectionsResponse, response] = await Promise.all([
          fetch(withAuthPath("/api/collections")),
          fetch("/api/artifacts/search?" + currentParams().toString())
        ]);
        collectionResult = await collectionsResponse.json();
        searchResult = await response.json();
        renderCollections(collectionResult);
        renderStats(searchResult.stats);
        if (!preserveFacets) {
          renderFacets(searchResult.facets);
        }
        renderList(searchResult.items);
      }

      async function importBundleFile(file) {
        if (!file) {
          return;
        }
        elements.importAll.disabled = true;
        elements.importAll.textContent = "导入中...";
        try {
          const bundle = JSON.parse(await file.text());
          const response = await fetch(withAuthPath("/api/import"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              bundle,
              overwrite: false
            })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(result.error || "导入失败。");
          }
          elements.importAll.textContent = "已导入 " + result.artifactCount + " 个";
          await load();
          setTimeout(() => {
            elements.importAll.textContent = "导入全部";
          }, 1800);
        } catch (error) {
          elements.resultSummary.textContent = "导入失败：" + error.message;
          elements.importAll.textContent = "导入全部";
        } finally {
          elements.importAll.disabled = false;
          elements.importFile.value = "";
        }
      }

      function scheduleLoad() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          load({ preserveFacets: true }).catch(renderError);
        }, 160);
      }

      function renderError(error) {
        elements.resultSummary.textContent = "加载失败";
        elements.list.innerHTML = '<div class="empty">加载失败：' + escapeHtml(error.message) + '</div>';
      }

      elements.query.addEventListener("input", scheduleLoad);
      for (const element of [elements.status, elements.type, elements.tag, elements.archived, elements.sort]) {
        element.addEventListener("change", () => load({ preserveFacets: true }).catch(renderError));
      }
      elements.refresh.addEventListener("click", () => load().catch(renderError));
      elements.importAll.addEventListener("click", () => {
        elements.importFile.click();
      });
      elements.importFile.addEventListener("change", () => {
        importBundleFile(elements.importFile.files?.[0]).catch(renderError);
      });
      elements.collections.addEventListener("click", async (event) => {
        const target = event.target;
        if (target instanceof HTMLButtonElement && target.id === "clearCollection") {
          activeCollection = "";
          history.replaceState(null, "", withAuthPath("/"));
          load({ preserveFacets: true }).catch(renderError);
          return;
        }
        if (!(target instanceof HTMLButtonElement) || !target.dataset.collectionId) {
          return;
        }
        const response = await fetch(withAuthPath("/api/collections/" + encodeURIComponent(target.dataset.collectionId) + "/markdown"));
        const markdown = await response.text();
        await navigator.clipboard.writeText(markdown);
        target.textContent = "已复制";
        setTimeout(() => {
          target.textContent = "复制摘要";
        }, 1200);
      });
      load().catch(renderError);
    </script>
  `);
}

function artifactPage(artifact, pageToken = "", readOnly = false) {
  const title = escapeHtml(artifact.title);
  const fileSrc = appendToken(`/files/${encodeURIComponent(artifact.id)}/${encodeURIComponent(artifact.entry)}`, pageToken);
  const backHref = appendToken("/", pageToken);
  const markdownHref = appendToken(`/api/artifacts/${encodeURIComponent(artifact.id)}/markdown`, pageToken);
  const bundleHref = appendToken(`/api/artifacts/${encodeURIComponent(artifact.id)}/export`, pageToken);
  const fullBundleHref = appendToken("/api/export", pageToken);
  return pageShell(`${title} - Artifact`, `
    <main class="artifact-view">
      <section class="artifact-frame">
        <header>
          <a href="${escapeHtml(backHref)}" class="back">返回列表</a>
          <div>
            <h1>${title}</h1>
            <p>${escapeHtml(artifact.typeLabel)} · ${escapeHtml(artifact.statusLabel)}</p>
          </div>
        </header>
        <iframe title="${title}" src="${escapeHtml(fileSrc)}"></iframe>
      </section>
      <aside class="state-panel">
        <div class="panel-header">
          <h2>执行状态</h2>
          <span id="statusLabel" class="status" data-status="${escapeHtml(artifact.status)}">${escapeHtml(artifact.statusLabel)}</span>
        </div>
        ${readOnly ? '<div class="readonly-banner">只读模式：可以查看和导出，不能修改状态、阶段或评论。</div>' : ""}
        <label class="status-control">
          <span>当前状态</span>
          <select id="statusSelect" data-write-control></select>
        </label>
        <div id="stateFeedback" class="state-feedback" role="status" aria-live="polite"></div>
        <section>
          <h3>阶段</h3>
          <div id="checkpoints" class="checkpoints"></div>
        </section>
        <section>
          <h3>评论</h3>
          <form id="noteForm">
            <div class="note-fields">
              <input id="noteAuthor" type="text" placeholder="作者" data-write-control>
              <select id="noteCategory" data-write-control>
                <option value="general">一般</option>
                <option value="question">问题</option>
                <option value="risk">风险</option>
                <option value="action">待办</option>
                <option value="approval">认可</option>
              </select>
            </div>
            <select id="noteCheckpoint" data-write-control></select>
            <textarea id="noteText" rows="3" placeholder="留下评审意见" data-write-control></textarea>
            <button type="submit" data-write-control>保存评论</button>
          </form>
          <label class="note-filter">
            <span>筛选</span>
            <select id="noteFilter"></select>
          </label>
          <div id="notes" class="notes"></div>
        </section>
        <section>
          <h3>导出</h3>
          <div class="panel-actions">
            <button id="copyMarkdown" type="button">复制 Markdown 状态</button>
            <a class="button-link" href="${escapeHtml(markdownHref)}" download="${escapeHtml(artifact.id)}-status.md">下载 Markdown</a>
            <a class="button-link" href="${escapeHtml(bundleHref)}" download="${escapeHtml(artifact.id)}-artifact-bundle.json">下载迁移包</a>
            <a class="button-link" href="${escapeHtml(fullBundleHref)}" download="html-artifacts-bundle.json">导出全部</a>
            <button id="copyComments" type="button">复制评论摘要</button>
            <button id="copyState" type="button">复制状态 JSON</button>
          </div>
        </section>
      </aside>
    </main>
    <script>
      const artifactId = ${JSON.stringify(artifact.id)};
      const artifactTitle = ${JSON.stringify(artifact.title)};
      const checkpoints = document.querySelector("#checkpoints");
      const notes = document.querySelector("#notes");
      const statusLabel = document.querySelector("#statusLabel");
      const statusSelect = document.querySelector("#statusSelect");
      const stateFeedback = document.querySelector("#stateFeedback");
      const noteForm = document.querySelector("#noteForm");
      const noteAuthor = document.querySelector("#noteAuthor");
      const noteCategory = document.querySelector("#noteCategory");
      const noteCheckpoint = document.querySelector("#noteCheckpoint");
      const noteFilter = document.querySelector("#noteFilter");
      const noteText = document.querySelector("#noteText");
      const copyMarkdown = document.querySelector("#copyMarkdown");
      const copyComments = document.querySelector("#copyComments");
      const copyState = document.querySelector("#copyState");
      const statusLabels = ${JSON.stringify(STATUS_LABELS)};
      const statusOptions = Object.keys(statusLabels);
      const noteCategoryLabels = {
        general: "一般",
        question: "问题",
        risk: "风险",
        action: "待办",
        approval: "认可"
      };
      const authToken = ${JSON.stringify(pageToken)} || new URLSearchParams(location.search).get("token") || "";
      const readOnly = ${JSON.stringify(readOnly)};
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

      function setFeedback(message, tone = "") {
        stateFeedback.textContent = message || "";
        stateFeedback.className = "state-feedback" + (tone ? " " + tone : "");
      }

      function renderStatusOptions() {
        statusSelect.innerHTML = statusOptions.map((status) => \`
          <option value="\${escapeHtml(status)}">\${escapeHtml(statusLabels[status] || status)}</option>
        \`).join("");
      }

      function checkpointTitle(checkpointId) {
        const checkpoint = state?.checkpoints.find((item) => item.id === checkpointId);
        return checkpoint ? checkpoint.title : "";
      }

      function noteCategoryLabel(category) {
        return noteCategoryLabels[category] || category || "一般";
      }

      function renderNoteControls() {
        const checkpointOptions = state.checkpoints.map((item) => \`
          <option value="\${escapeHtml(item.id)}">\${escapeHtml(item.title)}</option>
        \`).join("");
        noteCheckpoint.innerHTML = '<option value="">不关联阶段</option>' + checkpointOptions;
        const selectedFilter = noteFilter.value || "open";
        noteFilter.innerHTML = [
          '<option value="open">未解决评论</option>',
          '<option value="all">全部评论</option>',
          '<option value="resolved">已解决评论</option>',
          ...state.checkpoints.map((item) => \`<option value="checkpoint:\${escapeHtml(item.id)}">阶段：\${escapeHtml(item.title)}</option>\`)
        ].join("");
        noteFilter.value = [...noteFilter.options].some((option) => option.value === selectedFilter) ? selectedFilter : "open";
      }

      function withAuthPath(path) {
        if (!authToken) {
          return path;
        }
        const separator = path.includes("?") ? "&" : "?";
        return path + separator + "token=" + encodeURIComponent(authToken);
      }

      function renderState() {
        const status = state.status || "in-progress";
        statusLabel.textContent = statusLabels[status] || status;
        statusLabel.dataset.status = status;
        statusSelect.value = status;
        renderNoteControls();
        if (!state.checkpoints.length) {
          checkpoints.innerHTML = '<div class="empty compact">这个 artifact 没有配置阶段，适合作为资料查看和备注沉淀。</div>';
        } else {
          checkpoints.innerHTML = state.checkpoints.map((item) => \`
            <article class="checkpoint">
              <label class="checkpoint-row">
                <input type="checkbox" data-id="\${escapeHtml(item.id)}" data-write-control \${item.done ? "checked" : ""}>
                <span>
                  <strong>\${escapeHtml(item.title)}</strong>
                  <small>\${item.doneAt ? "完成于 " + escapeHtml(formatDate(item.doneAt)) : "未完成"}</small>
                </span>
              </label>
              <div class="checkpoint-note">
                <textarea rows="2" data-note-id="\${escapeHtml(item.id)}" placeholder="阶段备注" data-write-control>\${escapeHtml(item.note || "")}</textarea>
                <button type="button" class="checkpoint-note-save" data-id="\${escapeHtml(item.id)}" data-write-control>保存</button>
              </div>
            </article>
          \`).join("");
        }

        const visibleNotes = filteredNotes();
        if (!state.notes.length) {
          notes.innerHTML = '<div class="empty compact">暂无评论。可以记录 review 结论、阻塞点或下一步动作。</div>';
        } else if (!visibleNotes.length) {
          notes.innerHTML = '<div class="empty compact">当前筛选下没有评论。</div>';
        } else {
          notes.innerHTML = visibleNotes.slice().reverse().map((item) => \`
            <article class="note \${item.resolved ? "resolved" : ""}">
              <div class="note-meta">
                <span>\${escapeHtml(noteCategoryLabel(item.category))}</span>
                \${item.author ? '<span>' + escapeHtml(item.author) + '</span>' : ""}
                \${item.checkpointId ? '<span>' + escapeHtml(checkpointTitle(item.checkpointId) || item.checkpointId) + '</span>' : '<span>全局</span>'}
                <time>\${escapeHtml(formatDate(item.at))}</time>
              </div>
              <p>\${escapeHtml(item.text)}</p>
              <div class="note-actions">
                <span>\${item.resolved ? "已解决" + (item.resolvedAt ? " · " + escapeHtml(formatDate(item.resolvedAt)) : "") : "未解决"}</span>
                <button type="button" data-note-id="\${escapeHtml(item.id)}" data-note-action="\${item.resolved ? "reopen" : "resolve"}" data-write-control>\${item.resolved ? "重新打开" : "标记解决"}</button>
              </div>
            </article>
          \`).join("");
        }
        applyReadOnly();
      }

      function applyReadOnly() {
        for (const element of document.querySelectorAll("[data-write-control]")) {
          element.disabled = readOnly;
        }
        noteText.placeholder = readOnly ? "只读模式下不能新增评论" : "留下评审意见";
      }

      function filteredNotes() {
        const filter = noteFilter.value || "open";
        if (filter === "all") {
          return state.notes;
        }
        if (filter === "resolved") {
          return state.notes.filter((item) => item.resolved);
        }
        if (filter.startsWith("checkpoint:")) {
          const checkpointId = filter.slice("checkpoint:".length);
          return state.notes.filter((item) => item.checkpointId === checkpointId);
        }
        return state.notes.filter((item) => !item.resolved);
      }

      async function fetchJson(url, options = {}) {
        const response = await fetch(withAuthPath(url), options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "请求失败，请稍后重试。");
        }
        return data;
      }

      async function loadState() {
        setFeedback("正在加载状态...");
        state = await fetchJson(\`/api/artifacts/\${encodeURIComponent(artifactId)}/state\`);
        renderState();
        setFeedback("");
      }

      async function saveState(nextState, successMessage) {
        state = await fetchJson(\`/api/artifacts/\${encodeURIComponent(artifactId)}/state\`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(nextState)
        });
        renderState();
        setFeedback(successMessage || "已保存。");
        setTimeout(() => {
          setFeedback("");
        }, 1400);
      }

      function withHistory(nextState, event) {
        return {
          ...nextState,
          history: [
            ...(Array.isArray(nextState.history) ? nextState.history : []),
            {
              at: new Date().toISOString(),
              ...event
            }
          ]
        };
      }

      function renderLoadError(error) {
        checkpoints.innerHTML = '<div class="empty compact error">状态加载失败：' + escapeHtml(error.message) + '</div>';
        notes.innerHTML = '<div class="empty compact">状态加载成功后会显示备注。</div>';
        stateFeedback.className = "state-feedback error";
        stateFeedback.innerHTML = '状态加载失败。<button id="retryState" type="button">重试</button>';
      }

      checkpoints.addEventListener("change", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }
        if (readOnly) {
          target.checked = !target.checked;
          setFeedback("只读模式下不能修改阶段状态。", "error");
          return;
        }
        const checkpointId = target.dataset.id;
        try {
          state = await fetchJson(\`/api/artifacts/\${encodeURIComponent(artifactId)}/checkpoints/\${encodeURIComponent(checkpointId)}/toggle\`, {
            method: "POST"
          });
          renderState();
          setFeedback("阶段状态已更新。");
          setTimeout(() => {
            setFeedback("");
          }, 1400);
        } catch (error) {
          target.checked = !target.checked;
          setFeedback(error.message, "error");
        }
      });

      checkpoints.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement) || !target.classList.contains("checkpoint-note-save")) {
          return;
        }
        if (readOnly) {
          setFeedback("只读模式下不能保存阶段备注。", "error");
          return;
        }
        const checkpointId = target.dataset.id;
        const textarea = [...checkpoints.querySelectorAll("textarea[data-note-id]")]
          .find((item) => item.dataset.noteId === checkpointId);
        const checkpoint = state.checkpoints.find((item) => item.id === checkpointId);
        if (!checkpoint || !textarea) {
          return;
        }
        const note = textarea.value.trim();
        if (checkpoint.note === note) {
          setFeedback("阶段备注没有变化。");
          return;
        }
        target.disabled = true;
        try {
          const nextState = {
            ...state,
            checkpoints: state.checkpoints.map((item) => item.id === checkpointId ? { ...item, note } : item)
          };
          await saveState(withHistory(nextState, {
            type: "checkpoint.note.updated",
            checkpointId
          }), "阶段备注已保存。");
        } catch (error) {
          setFeedback(error.message, "error");
        } finally {
          target.disabled = false;
        }
      });

      statusSelect.addEventListener("change", async () => {
        if (readOnly) {
          setFeedback("只读模式下不能修改状态。", "error");
          return;
        }
        if (!state) {
          setFeedback("状态还没有加载完成。", "error");
          return;
        }
        const nextStatus = statusSelect.value;
        const previousStatus = state.status || "in-progress";
        if (nextStatus === previousStatus) {
          return;
        }
        statusSelect.disabled = true;
        try {
          const nextState = withHistory({
            ...state,
            status: nextStatus
          }, {
            type: "status.changed",
            from: previousStatus,
            to: nextStatus
          });
          await saveState(nextState, "状态已更新。");
        } catch (error) {
          statusSelect.value = previousStatus;
          setFeedback(error.message, "error");
        } finally {
          statusSelect.disabled = false;
        }
      });

      noteForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (readOnly) {
          setFeedback("只读模式下不能新增评论。", "error");
          return;
        }
        if (!state) {
          setFeedback("状态还没有加载完成。", "error");
          return;
        }
        const text = noteText.value.trim();
        if (!text) {
          return;
        }
        try {
          state = await fetchJson(\`/api/artifacts/\${encodeURIComponent(artifactId)}/notes\`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              text,
              author: noteAuthor.value.trim(),
              category: noteCategory.value,
              checkpointId: noteCheckpoint.value
            })
          });
          noteText.value = "";
          renderState();
          setFeedback("评论已保存。");
          setTimeout(() => {
            setFeedback("");
          }, 1400);
        } catch (error) {
          setFeedback(error.message, "error");
        }
      });

      noteFilter.addEventListener("change", () => {
        if (state) {
          renderState();
        }
      });

      notes.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement) || !target.dataset.noteId) {
          return;
        }
        if (readOnly) {
          setFeedback("只读模式下不能修改评论状态。", "error");
          return;
        }
        const action = target.dataset.noteAction;
        target.disabled = true;
        try {
          state = await fetchJson(\`/api/artifacts/\${encodeURIComponent(artifactId)}/notes/\${encodeURIComponent(target.dataset.noteId)}/\${action}\`, {
            method: "POST"
          });
          renderState();
          setFeedback(action === "resolve" ? "评论已解决。" : "评论已重新打开。");
          setTimeout(() => {
            setFeedback("");
          }, 1400);
        } catch (error) {
          setFeedback(error.message, "error");
        } finally {
          target.disabled = false;
        }
      });

      function toMarkdown() {
        const lines = [
          "# " + artifactTitle,
          "",
          "- 状态：" + (statusLabels[state.status] || state.status || "未知")
        ];

        if (state.checkpoints.length) {
          lines.push("", "## 阶段");
          for (const item of state.checkpoints) {
            lines.push("- [" + (item.done ? "x" : " ") + "] " + item.title);
            if (item.note) {
              lines.push("  - 备注：" + item.note);
            }
          }
        }

        if (state.notes.length) {
          lines.push("", "## 评论");
          lines.push(...commentsMarkdownLines());
        }

        return lines.join("\\n");
      }

      function commentsMarkdownLines() {
        const groups = new Map([["", []]]);
        for (const checkpoint of state.checkpoints) {
          groups.set(checkpoint.id, []);
        }
        for (const item of state.notes) {
          const key = groups.has(item.checkpointId) ? item.checkpointId : "";
          groups.get(key).push(item);
        }

        const lines = [];
        for (const [checkpointId, items] of groups) {
          if (!items.length) {
            continue;
          }
          const title = checkpointId ? checkpointTitle(checkpointId) || checkpointId : "全局";
          lines.push("### " + title);
          for (const item of items) {
            const meta = [
              item.resolved ? "已解决" : "未解决",
              noteCategoryLabel(item.category),
              item.author || "",
              item.at ? formatDate(item.at) : ""
            ].filter(Boolean).join(" / ");
            lines.push("- " + meta + "：" + item.text);
          }
          lines.push("");
        }
        return lines.length && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
      }

      copyMarkdown.addEventListener("click", async () => {
        if (!state) {
          setFeedback("状态还没有加载完成。", "error");
          return;
        }
        await navigator.clipboard.writeText(toMarkdown());
        copyMarkdown.textContent = "已复制";
        setTimeout(() => {
          copyMarkdown.textContent = "复制 Markdown 状态";
        }, 1200);
      });

      copyComments.addEventListener("click", async () => {
        if (!state) {
          setFeedback("状态还没有加载完成。", "error");
          return;
        }
        const lines = ["# " + artifactTitle + " 评论摘要", "", ...commentsMarkdownLines()];
        await navigator.clipboard.writeText(lines.join("\\n"));
        copyComments.textContent = "已复制";
        setTimeout(() => {
          copyComments.textContent = "复制评论摘要";
        }, 1200);
      });

      copyState.addEventListener("click", async () => {
        if (!state) {
          setFeedback("状态还没有加载完成。", "error");
          return;
        }
        await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
        copyState.textContent = "已复制";
        setTimeout(() => {
          copyState.textContent = "复制状态 JSON";
        }, 1200);
      });

      stateFeedback.addEventListener("click", (event) => {
        if (event.target instanceof HTMLButtonElement && event.target.id === "retryState") {
          loadState().catch(renderLoadError);
        }
      });

      renderStatusOptions();
      loadState().catch(renderLoadError);
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
      --panel-soft: #eef3f7;
      --text: #1f2933;
      --muted: #667085;
      --border: #d7dde5;
      --accent: #2563eb;
      --done: #0f766e;
      --blocked: #b42318;
      --warning: #a16207;
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
    .button-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      padding: 8px 12px;
      text-align: center;
      text-decoration: none;
    }
    button:hover,
    .button-link:hover,
    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--accent);
      outline: none;
    }
    button:disabled,
    select:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    code {
      font-family: "Cascadia Code", Consolas, monospace;
      font-size: 0.92em;
    }
    mark {
      border-radius: 3px;
      background: #fff2a8;
      color: #111827;
      padding: 0 2px;
    }
    .dashboard {
      width: min(1240px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--accent);
      font-weight: 700;
      font-size: 13px;
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
    h2 {
      margin-bottom: 4px;
      font-size: 20px;
      letter-spacing: 0;
    }
    h3 {
      letter-spacing: 0;
    }
    p {
      color: var(--muted);
      line-height: 1.6;
    }
    .toolbar {
      display: flex;
      gap: 8px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px 14px;
    }
    .stat-card span {
      display: block;
      color: var(--muted);
      font-size: 13px;
    }
    .stat-card strong {
      display: block;
      margin-top: 5px;
      font-size: 24px;
      line-height: 1.1;
    }
    .collections {
      margin-bottom: 14px;
    }
    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .section-head h2 {
      margin-bottom: 2px;
    }
    .section-head p {
      margin-bottom: 0;
      font-size: 14px;
    }
    .collection-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .collection-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
    }
    .collection-card.active {
      border-color: var(--accent);
    }
    .collection-card a {
      color: var(--text);
      font-weight: 700;
      text-decoration: none;
    }
    .collection-card p {
      margin: 4px 0;
      font-size: 14px;
    }
    .collection-card small {
      color: var(--muted);
      font-size: 12px;
    }
    .collection-card button {
      white-space: nowrap;
    }
    .filters {
      display: grid;
      grid-template-columns: minmax(220px, 1.4fr) repeat(5, minmax(118px, 0.8fr));
      gap: 10px;
      margin-bottom: 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
    }
    .filters label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    .filters input,
    .filters select,
    textarea {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      padding: 8px 10px;
    }
    .result-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin: 16px 0 10px;
    }
    .result-head p {
      margin-bottom: 0;
    }
    .active-filters {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .active-filters span,
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      padding: 2px 8px;
      font-size: 12px;
    }
    .artifact-groups {
      display: grid;
      gap: 12px;
    }
    .artifact-group {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .artifact-group > header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      background: var(--panel-soft);
      border-bottom: 1px solid var(--border);
      padding: 10px 14px;
    }
    .artifact-group h3 {
      margin: 0;
      font-size: 15px;
    }
    .artifact-list {
      display: grid;
    }
    .artifact-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      padding: 14px 16px;
    }
    .artifact-card + .artifact-card {
      border-top: 1px solid var(--border);
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
      margin: 4px 0 8px;
      font-size: 14px;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .muted {
      color: var(--muted);
    }
    .card-side {
      display: grid;
      justify-items: end;
      gap: 6px;
    }
    .card-side small {
      color: var(--muted);
      font-size: 12px;
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
      height: calc(100vh - 96px);
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
    .status-control {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .status-control select,
    .checkpoint-note textarea,
    #noteForm input,
    #noteForm select,
    .note-filter select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      padding: 8px 10px;
    }
    .state-feedback {
      min-height: 20px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .state-feedback.error {
      color: var(--blocked);
    }
    .readonly-banner {
      border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--warning) 10%, var(--panel));
      color: var(--warning);
      padding: 10px;
      margin-bottom: 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    .state-feedback button {
      margin-left: 8px;
      padding: 4px 8px;
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
      gap: 9px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .checkpoint-row {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 10px;
      align-items: start;
    }
    .checkpoint small {
      display: block;
      color: var(--muted);
      line-height: 1.45;
      margin-top: 2px;
    }
    .checkpoint-note {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: start;
      padding-left: 28px;
    }
    .checkpoint-note textarea {
      min-height: 58px;
      resize: vertical;
    }
    .checkpoint-note-save {
      min-width: 58px;
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
    .note.resolved {
      background: var(--panel-soft);
    }
    .note-meta,
    .note-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .note-meta span,
    .note-actions span {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
    }
    .note-actions {
      justify-content: space-between;
      margin-top: 8px;
    }
    .note-actions button {
      padding: 4px 8px;
      font-size: 12px;
    }
    .note p {
      color: var(--text);
      margin: 8px 0 0;
    }
    #noteForm {
      display: grid;
      gap: 8px;
    }
    .note-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 112px;
      gap: 8px;
    }
    .note-filter {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .panel-actions {
      display: grid;
      gap: 8px;
    }
    @media (max-width: 980px) {
      .stats,
      .filters {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .collection-list {
        grid-template-columns: 1fr;
      }
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
      .result-head,
      .artifact-card,
      .artifact-frame header {
        display: block;
      }
      .filters,
      .stats,
      .collection-card {
        grid-template-columns: 1fr;
      }
      .dashboard {
        width: min(100vw - 20px, 1240px);
      }
      .card-side {
        justify-items: start;
        margin-top: 10px;
      }
      .active-filters {
        justify-content: flex-start;
        margin-top: 8px;
      }
      .checkpoint-note {
        grid-template-columns: 1fr;
        padding-left: 0;
      }
      .checkpoint-note-save {
        justify-self: start;
      }
      .note-fields {
        grid-template-columns: 1fr;
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --panel: #172033;
        --panel-soft: #1f2a3d;
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

async function createApp(store, options = {}) {
  const authToken = String(options.token || "");
  const readToken = String(options.readToken || "");
  const app = Fastify({
    bodyLimit: 50 * 1024 * 1024,
    logger: false
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", {
    parseAs: "string"
  }, (request, body, done) => {
    done(null, body ? Object.fromEntries(new URLSearchParams(body)) : {});
  });

  await app.register(fastifyStatic, {
    root: store.root,
    serve: false
  });

  if (authToken || readToken) {
    app.addHook("onRequest", async (request, reply) => {
      const auth = authModeFromRequest(request, {
        writeToken: authToken,
        readToken
      });
      if (auth) {
        request.artifactAuth = auth;
        if (request.query?.token === auth.token) {
          reply.header("set-cookie", `artifact_token=${encodeURIComponent(auth.token)}; Path=/; SameSite=Lax`);
        }
        if (auth.mode === "read" && !isReadMethod(request.method)) {
          return reply.code(403).send({
            error: "Read-only artifact token cannot modify state."
          });
        }
        return;
      }

      if (isApiRequest(request)) {
        return reply.code(401).send({
          error: "Artifact token is required."
        });
      }

      return reply.code(401).type("text/html; charset=utf-8").send(tokenPromptPage());
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    reply.code(statusCode).send({
      error: error.message || "Internal server error"
    });
  });

  app.get("/", async (request, reply) => {
    return reply.type("text/html; charset=utf-8").send(dashboardPage(store.root));
  });

  app.get("/api/health", async () => {
    const [artifacts, collections] = await Promise.all([
      store.listArtifacts(),
      store.listCollections()
    ]);
    return {
      status: "ok",
      root: store.root,
      artifactCount: artifacts.length,
      collectionCount: collections.length,
      now: new Date().toISOString()
    };
  });

  app.get("/artifacts/:id", async (request, reply) => {
    const artifact = await store.getArtifact(request.params.id);
    if (!artifact) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    const pageToken = typeof request.query?.token === "string" ? request.query.token : "";
    const readOnly = request.artifactAuth?.mode === "read";
    return reply.type("text/html; charset=utf-8").send(artifactPage(artifact, pageToken, readOnly));
  });

  app.get("/api/artifacts", async () => {
    return store.listArtifacts();
  });

  app.get("/api/artifacts/search", async (request) => {
    return store.searchArtifacts(getSearchFilters(request.query));
  });

  app.get("/api/export", async (request, reply) => {
    const bundle = await store.getAllArtifactsBundle();
    const date = new Date().toISOString().slice(0, 10);
    reply.header("content-disposition", `attachment; filename="html-artifacts-${date}.json"`);
    return reply.type("application/json; charset=utf-8").send(bundle);
  });

  app.post("/api/import", async (request, reply) => {
    const result = await store.importAllArtifactsBundle(request.body);
    return reply.send(result);
  });

  app.get("/api/collections", async () => {
    return store.listCollections();
  });

  app.get("/api/collections/:id/markdown", async (request, reply) => {
    const markdown = await store.getCollectionMarkdown(request.params.id);
    if (markdown === null) {
      return reply.code(404).send({
        error: "Collection not found."
      });
    }
    return reply.type("text/markdown; charset=utf-8").send(markdown);
  });

  app.get("/api/artifacts/:id", async (request, reply) => {
    const artifact = await store.getArtifact(request.params.id);
    if (!artifact) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return artifact;
  });

  app.get("/api/artifacts/:id/markdown", async (request, reply) => {
    const markdown = await store.getArtifactMarkdown(request.params.id);
    if (markdown === null) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    reply.header("content-disposition", `attachment; filename="${request.params.id}-status.md"`);
    return reply.type("text/markdown; charset=utf-8").send(markdown);
  });

  app.get("/api/artifacts/:id/export", async (request, reply) => {
    const bundle = await store.getArtifactBundle(request.params.id);
    if (bundle === null) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    reply.header("content-disposition", `attachment; filename="${request.params.id}-artifact-bundle.json"`);
    return reply.type("application/json; charset=utf-8").send(bundle);
  });

  app.get("/api/artifacts/:id/state", async (request, reply) => {
    if (!(await store.getArtifact(request.params.id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return store.getState(request.params.id);
  });

  app.put("/api/artifacts/:id/state", async (request, reply) => {
    if (!(await store.getArtifact(request.params.id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return store.putState(request.params.id, request.body);
  });

  app.post("/api/artifacts/:id/checkpoints/:checkpointId/toggle", async (request, reply) => {
    if (!(await store.getArtifact(request.params.id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return store.toggleCheckpoint(request.params.id, request.params.checkpointId);
  });

  app.post("/api/artifacts/:id/notes", async (request, reply) => {
    if (!(await store.getArtifact(request.params.id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return store.addNote(request.params.id, request.body);
  });

  app.post("/api/artifacts/:id/notes/:noteId/resolve", async (request, reply) => {
    if (!(await store.getArtifact(request.params.id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return store.setNoteResolved(request.params.id, request.params.noteId, true);
  });

  app.post("/api/artifacts/:id/notes/:noteId/reopen", async (request, reply) => {
    if (!(await store.getArtifact(request.params.id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    return store.setNoteResolved(request.params.id, request.params.noteId, false);
  });

  app.get("/files/:id/*", async (request, reply) => {
    const { id } = request.params;
    if (!isArtifactId(id) || !(await store.getArtifact(id))) {
      return reply.code(404).send({
        error: "Artifact not found."
      });
    }
    const relativePath = request.params["*"] || "index.html";
    return reply.sendFile(relativePath, store.getArtifactFileRoot(id), {
      cacheControl: false
    });
  });

  return app;
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
  const app = await createApp(store, {
    token: args.token,
    readToken: args.readToken
  });
  try {
    await app.listen({
      host: args.host,
      port: args.port
    });
  } catch (error) {
    throw startupListenError(error, args);
  }

  const urls = serverUrls(args);
  console.log(`Artifact server listening at ${urls.primaryUrl}`);
  console.log(`Loopback URL: ${urls.loopbackUrl}`);
  if (urls.lanUrls.length) {
    console.log(`LAN URLs: ${urls.lanUrls.join(", ")}`);
  }
  console.log(`Health check: ${appendToken(`${urls.loopbackUrl.split("?")[0]}/api/health`, args.token)}`);
  console.log(`Artifact root: ${store.root}`);
  console.log(`Access token: ${args.token ? "enabled" : "disabled"}`);
  console.log(`Read-only token: ${args.readToken ? "enabled" : "disabled"}`);
  if (args.host === "0.0.0.0") {
    if (args.token) {
      console.log("LAN sharing is enabled with token protection. Share URLs only with trusted colleagues.");
    } else {
      console.log("LAN sharing is enabled without token protection. Review artifact contents before sharing the URL.");
    }
  }
}

export {
  createApp,
  createStore,
  normalizeState
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.code === "EADDRINUSE" ? error.message : error.stack || error.message);
    process.exitCode = 1;
  });
}
