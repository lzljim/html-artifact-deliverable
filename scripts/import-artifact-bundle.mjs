#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.join(os.homedir(), ".codex", "html-artifacts");
const BUNDLE_FORMAT = "html-artifact-deliverable.all.v1";

function parseArgs(argv) {
  const args = {
    root: process.env.ARTIFACT_ROOT || DEFAULT_ROOT,
    bundle: "",
    overwrite: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--root") {
      args.root = argv[++index];
    } else if (arg === "--bundle") {
      args.bundle = argv[++index] || "";
    } else if (arg === "--overwrite") {
      args.overwrite = true;
    }
  }

  return args;
}

function printHelp() {
  const script = path.basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} --bundle <html-artifacts.json> [--root <dir>] [--overwrite]

Default root: ${DEFAULT_ROOT}

Options:
  --bundle      JSON bundle exported from GET /api/export
  --root        Target artifact root
  --overwrite   Replace existing artifact directories with same ids`);
}

function isArtifactId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeBundle(raw) {
  if (raw?.format !== BUNDLE_FORMAT || !Array.isArray(raw.artifacts)) {
    throw new Error(`Unsupported bundle format. Expected ${BUNDLE_FORMAT}.`);
  }
  return raw;
}

function normalizeCollectionConfig(value) {
  if (!value || typeof value !== "object") {
    return {
      collections: []
    };
  }
  return {
    ...value,
    collections: Array.isArray(value.collections) ? value.collections : []
  };
}

function mergeCollectionConfig(existing, incoming) {
  const merged = new Map();
  for (const collection of normalizeCollectionConfig(existing).collections) {
    if (collection?.id) {
      merged.set(collection.id, {
        ...collection,
        artifactIds: Array.isArray(collection.artifactIds) ? [...collection.artifactIds] : []
      });
    }
  }
  for (const collection of normalizeCollectionConfig(incoming).collections) {
    if (!collection?.id) {
      continue;
    }
    const previous = merged.get(collection.id) || {
      artifactIds: []
    };
    const artifactIds = new Set([
      ...(Array.isArray(previous.artifactIds) ? previous.artifactIds : []),
      ...(Array.isArray(collection.artifactIds) ? collection.artifactIds : [])
    ]);
    merged.set(collection.id, {
      ...previous,
      ...collection,
      artifactIds: [...artifactIds]
    });
  }
  return {
    collections: [...merged.values()]
  };
}

async function importBundle({ bundlePath, root, overwrite = false }) {
  if (!bundlePath) {
    throw new Error("--bundle is required.");
  }

  const bundle = normalizeBundle(await readJson(bundlePath));
  const absoluteRoot = path.resolve(root || DEFAULT_ROOT);
  await fs.mkdir(absoluteRoot, {
    recursive: true
  });

  const writtenArtifacts = [];
  for (const item of bundle.artifacts) {
    const id = String(item?.id || item?.artifact?.id || "");
    if (!isArtifactId(id)) {
      throw new Error(`Invalid artifact id in bundle: ${id}`);
    }
    const dir = path.join(absoluteRoot, id);
    if ((await pathExists(dir)) && !overwrite) {
      throw new Error(`Artifact already exists: ${id}. Re-run with --overwrite to replace it.`);
    }
    await fs.mkdir(dir, {
      recursive: true
    });
    await fs.writeFile(path.join(dir, "index.html"), String(item.indexHtml || ""), "utf8");
    await writeJson(path.join(dir, "artifact.json"), {
      ...item.artifact,
      id,
      entry: item.artifact?.entry || "index.html"
    });
    await writeJson(path.join(dir, "state.json"), item.state || {
      status: "in-progress",
      checkpoints: [],
      notes: [],
      history: []
    });
    writtenArtifacts.push(id);
  }

  const collectionPath = path.join(absoluteRoot, "collection.json");
  const existingCollectionConfig = await pathExists(collectionPath)
    ? await readJson(collectionPath)
    : {
        collections: []
      };
  const nextCollectionConfig = overwrite
    ? normalizeCollectionConfig(bundle.collectionConfig)
    : mergeCollectionConfig(existingCollectionConfig, bundle.collectionConfig);
  await writeJson(collectionPath, nextCollectionConfig);

  return {
    root: absoluteRoot,
    artifactCount: writtenArtifacts.length,
    artifacts: writtenArtifacts
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const result = await importBundle({
    bundlePath: args.bundle,
    root: args.root,
    overwrite: args.overwrite
  });
  console.log(`Imported ${result.artifactCount} artifacts into ${result.root}`);
}

export {
  importBundle,
  parseArgs
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
