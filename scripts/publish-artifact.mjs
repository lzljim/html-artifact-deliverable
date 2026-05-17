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
    type: "html-artifact",
    tags: [],
    checkpoints: []
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
    } else if (arg === "--checkpoint") {
      args.checkpoints.push(argv[++index]);
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
  node ${script} --html docs/ai/plan.html --title "执行计划" --type implementation-plan
  node ${script} --html report.html --checkpoint research:调研完成 --checkpoint verification:验证完成

Checkpoint format:
  --checkpoint <id>:<title>`);
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

  const title = args.title || path.basename(htmlPath, path.extname(htmlPath));
  const id = args.id ? slugify(args.id) : defaultId(title, htmlPath);
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
    type: args.type,
    createdAt: now,
    updatedAt: now,
    source: {
      workspace: args.workspace || process.cwd(),
      html: htmlPath
    },
    entry: "index.html",
    tags: args.tags
  };

  await writeJson(path.join(artifactDir, "artifact.json"), artifact);

  const statePath = path.join(artifactDir, "state.json");
  if (!(await pathExists(statePath))) {
    await writeJson(statePath, {
      status: "in-progress",
      checkpoints: args.checkpoints.map(parseCheckpoint),
      notes: [],
      history: []
    });
  } else if (args.checkpoints.length) {
    const state = await readJson(statePath, {
      status: "in-progress",
      checkpoints: [],
      notes: [],
      history: []
    });
    const existingIds = new Set((state.checkpoints || []).map((item) => item.id));
    for (const checkpoint of args.checkpoints.map(parseCheckpoint)) {
      if (!existingIds.has(checkpoint.id)) {
        state.checkpoints.push(checkpoint);
      }
    }
    await writeJson(statePath, state);
  }

  console.log(JSON.stringify({
    id,
    artifactDir,
    url: `/artifacts/${encodeURIComponent(id)}`
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
