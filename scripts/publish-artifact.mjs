#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const DEFAULT_ROOT = path.join(os.homedir(), ".codex", "html-artifacts");

function parseArgs(argv) {
  const args = {
    root: process.env.ARTIFACT_ROOT || DEFAULT_ROOT,
    tags: [],
    checkpoints: [],
    autoCheckpoints: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--html") {
      args.html = argv[++index];
    } else if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--id") {
      args.id = argv[++index];
    } else if (arg === "--title") {
      args.title = argv[++index];
    } else if (arg === "--type") {
      args.type = argv[++index];
    } else if (arg === "--tag") {
      args.tags.push(argv[++index]);
    } else if (arg === "--collection") {
      args.collection = argv[++index];
    } else if (arg === "--checkpoint") {
      args.checkpoints.push(argv[++index]);
    } else if (arg === "--no-auto-checkpoints") {
      args.autoCheckpoints = false;
    } else if (arg === "--workspace") {
      args.workspace = argv[++index];
    }
  }

  return args;
}

function printHelp() {
  const script = path.basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} --html <file> [--title <title>] [--id <id>] [--type <type>] [--root <dir>]

Examples:
  node ${script} --html docs/ai/plan.html
  node ${script} --html report.html --collection metadata-upgrade:"Metadata Upgrade"
  node ${script} --html report.html --checkpoint research:调研完成 --checkpoint verification:验证完成
  node ${script} --html notes.html --no-auto-checkpoints

Checkpoint format:
  --checkpoint <id>:<title>

Automatic behavior:
  title:       <title>, then <h1>, then file name
  type:        inferred from title/path/content unless --type is set
  checkpoints: inferred from phase-style headings unless --checkpoint is set
  collection:  optional <id>:<title> project grouping`);
}

function slugify(value) {
  const ascii = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return ascii || "artifact";
}

function todayPrefix() {
  return new Date().toISOString().slice(0, 10);
}

function shortHash(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 8);
}

function defaultId(title, htmlPath) {
  return `${todayPrefix()}-${slugify(title)}-${shortHash(`${title}:${htmlPath}`)}`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

function decodeHtmlEntities(value) {
  const named = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", "\""],
    ["apos", "'"],
    ["nbsp", " "]
  ]);
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    }
    return named.get(lower) || match;
  });
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function matchFirst(html, pattern) {
  const match = pattern.exec(html);
  return match ? cleanHtmlText(match[1]) : "";
}

function extractTitle(html, htmlPath) {
  return matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    || matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || path.basename(htmlPath, path.extname(htmlPath));
}

function inferType(title, htmlPath, html) {
  const titleAndPath = `${title}\n${htmlPath}`.toLowerCase();
  const sample = `${titleAndPath}\n${cleanHtmlText(html).slice(0, 4000)}`.toLowerCase();
  if (/code review|pr writeup|pull request|代码评审|pr\s*说明/.test(titleAndPath)) {
    return "code-review";
  }
  if (/implementation plan|计划|实施|阶段|milestone|checkpoint/.test(sample)) {
    return "implementation-plan";
  }
  if (/code review|pr writeup|pull request|代码评审|审查|评审|pr\s*说明/.test(sample)) {
    return "code-review";
  }
  if (/architecture|架构|流程|链路|render path|module map/.test(sample)) {
    return "architecture-explainer";
  }
  if (/report|research|brief|调查|调研|报告|复盘/.test(sample)) {
    return "research-report";
  }
  if (/editor|tool|tuner|triage|编辑器|工作台|调参|分拣/.test(sample)) {
    return "custom-editor";
  }
  return "html-artifact";
}

function phaseIdFromText(value, fallbackIndex) {
  const normalized = String(value || "").toLowerCase().replace(/\s+/g, "");
  const phaseMatch = /阶段([0-9]+[a-z]?|[0-9]+-[0-9]+)/i.exec(normalized);
  if (phaseMatch) {
    return `phase-${phaseMatch[1]}`;
  }
  return `phase-${fallbackIndex + 1}`;
}

function dedupeCheckpoints(checkpoints) {
  const seen = new Set();
  return checkpoints.filter((checkpoint) => {
    if (!checkpoint.id || seen.has(checkpoint.id)) {
      return false;
    }
    seen.add(checkpoint.id);
    return true;
  });
}

function checkpointFromTexts(phaseText, titleText, fallbackIndex) {
  const phase = cleanHtmlText(phaseText);
  const title = cleanHtmlText(titleText);
  const combinedTitle = title && !title.startsWith(phase) ? `${phase}：${title}` : title || phase;
  return {
    id: phaseIdFromText(phase || title, fallbackIndex),
    title: combinedTitle,
    done: false,
    doneAt: null,
    note: ""
  };
}

function extractCheckpoints(html) {
  const checkpoints = [];
  const pairedPhasePattern = /<div[^>]*class=["'][^"']*\bphase-id\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let pairedMatch;
  while ((pairedMatch = pairedPhasePattern.exec(html))) {
    checkpoints.push(checkpointFromTexts(pairedMatch[1], pairedMatch[2], checkpoints.length));
  }

  if (checkpoints.length) {
    return dedupeCheckpoints(checkpoints);
  }

  const headingPattern = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  let headingMatch;
  while ((headingMatch = headingPattern.exec(html))) {
    const text = cleanHtmlText(headingMatch[1]);
    if (/^阶段\s*[0-9]+[A-Za-z]?\s*[:：]/.test(text) || /^阶段\s*[0-9]+-[0-9]+\s*[:：]/.test(text)) {
      checkpoints.push({
        id: phaseIdFromText(text, checkpoints.length),
        title: text,
        done: false,
        doneAt: null,
        note: ""
      });
    }
  }

  return dedupeCheckpoints(checkpoints);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseCheckpoint(value) {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    const id = slugify(value);
    return {
      id,
      title: value,
      done: false,
      doneAt: null,
      note: ""
    };
  }

  const id = slugify(value.slice(0, separatorIndex));
  const title = value.slice(separatorIndex + 1).trim() || id;
  return {
    id,
    title,
    done: false,
    doneAt: null,
    note: ""
  };
}

function parseCollection(value) {
  if (!value) {
    return null;
  }
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    const id = slugify(value);
    return {
      id,
      title: value
    };
  }
  const id = slugify(value.slice(0, separatorIndex));
  return {
    id,
    title: value.slice(separatorIndex + 1).trim() || id
  };
}

async function updateCollectionFile(root, collection, artifactId) {
  if (!collection) {
    return;
  }
  const collectionPath = path.join(root, "collection.json");
  const raw = await readJson(collectionPath, {
    collections: []
  });
  const collections = Array.isArray(raw) ? raw : raw.collections || [];
  let item = collections.find((entry) => slugify(entry.id || entry.title || entry.name || "") === collection.id);
  if (!item) {
    item = {
      id: collection.id,
      title: collection.title,
      description: "",
      artifactIds: [],
      tags: [],
      createdAt: new Date().toISOString()
    };
    collections.push(item);
  }
  item.id = collection.id;
  item.title = item.title || collection.title;
  item.artifactIds = Array.isArray(item.artifactIds) ? item.artifactIds.map(String) : [];
  if (!item.artifactIds.includes(artifactId)) {
    item.artifactIds.push(artifactId);
  }
  item.updatedAt = new Date().toISOString();
  await writeJson(collectionPath, {
    collections
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.html) {
    throw new Error("--html is required.");
  }

  const htmlPath = path.resolve(args.html);
  if (!(await pathExists(htmlPath))) {
    throw new Error(`HTML file not found: ${htmlPath}`);
  }

  const html = await fs.readFile(htmlPath, "utf8");
  const title = args.title || extractTitle(html, htmlPath);
  const id = args.id ? slugify(args.id) : defaultId(title, htmlPath);
  const type = args.type || inferType(title, htmlPath, html);
  const collection = parseCollection(args.collection);
  const checkpoints = args.checkpoints.length
    ? args.checkpoints.map(parseCheckpoint)
    : args.autoCheckpoints ? extractCheckpoints(html) : [];
  const root = path.resolve(args.root);
  const artifactDir = path.join(root, id);
  const now = new Date().toISOString();

  await fs.mkdir(artifactDir, {
    recursive: true
  });
  await fs.copyFile(htmlPath, path.join(artifactDir, "index.html"));

  const artifact = {
    id,
    title,
    type,
    createdAt: now,
    updatedAt: now,
    source: {
      workspace: args.workspace || process.cwd(),
      html: htmlPath
    },
    entry: "index.html",
    tags: args.tags
  };
  if (collection) {
    artifact.collection = collection;
  }

  await writeJson(path.join(artifactDir, "artifact.json"), artifact);

  const statePath = path.join(artifactDir, "state.json");
  if (!(await pathExists(statePath))) {
    await writeJson(statePath, {
      status: "in-progress",
      checkpoints,
      notes: [],
      history: []
    });
  } else if (checkpoints.length) {
    const state = await readJson(statePath, {
      status: "in-progress",
      checkpoints: [],
      notes: [],
      history: []
    });
    const existingIds = new Set((state.checkpoints || []).map((item) => item.id));
    for (const checkpoint of checkpoints) {
      if (!existingIds.has(checkpoint.id)) {
        state.checkpoints.push(checkpoint);
      }
    }
    await writeJson(statePath, state);
  }

  await updateCollectionFile(root, collection, id);

  console.log(JSON.stringify({
    id,
    title,
    type,
    collection,
    checkpointCount: checkpoints.length,
    artifactDir,
    url: `/artifacts/${encodeURIComponent(id)}`
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
