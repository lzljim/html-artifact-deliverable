import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
let tempRoot;

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function runPublish(args, options = {}) {
  return execFileAsync(process.execPath, ["scripts/publish-artifact.mjs", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    windowsHide: true,
    ...options
  });
}

describe("publish-artifact", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "publish-artifact-test-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("copies HTML and infers metadata plus phase checkpoints", async () => {
    const htmlPath = path.join(tempRoot, "plan.html");
    await fs.writeFile(htmlPath, `<!doctype html>
      <title>Metadata Upgrade Plan</title>
      <h1>Metadata Upgrade Plan</h1>
      <h2>阶段 0：准备检查</h2>
      <h2>阶段 1A：灰度验证</h2>`, "utf8");

    const { stdout } = await runPublish([
      "--html", htmlPath,
      "--root", tempRoot,
      "--id", "metadata-plan",
      "--tag", "ai"
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.id, "metadata-plan");
    assert.equal(result.title, "Metadata Upgrade Plan");
    assert.equal(result.type, "implementation-plan");
    assert.equal(result.checkpointCount, 2);

    const artifactDir = path.join(tempRoot, "metadata-plan");
    assert.equal(await fs.readFile(path.join(artifactDir, "index.html"), "utf8"), await fs.readFile(htmlPath, "utf8"));

    const artifact = await readJson(path.join(artifactDir, "artifact.json"));
    assert.equal(artifact.id, "metadata-plan");
    assert.deepEqual(artifact.tags, ["ai"]);
    assert.equal(artifact.entry, "index.html");

    const state = await readJson(path.join(artifactDir, "state.json"));
    assert.equal(state.status, "in-progress");
    assert.deepEqual(state.checkpoints.map((item) => item.id), ["phase-0", "phase-1a"]);
    assert.deepEqual(state.checkpoints.map((item) => item.title), ["阶段 0：准备检查", "阶段 1A：灰度验证"]);
  });

  it("preserves existing state and appends only new checkpoints", async () => {
    const htmlPath = path.join(tempRoot, "plan.html");
    const artifactDir = path.join(tempRoot, "merge-plan");
    await fs.mkdir(artifactDir, {
      recursive: true
    });
    await fs.writeFile(htmlPath, `<!doctype html>
      <title>Merge Plan</title>
      <h2>阶段 1：旧阶段</h2>
      <h2>阶段 2：新增阶段</h2>`, "utf8");
    await fs.writeFile(path.join(artifactDir, "state.json"), `${JSON.stringify({
      status: "blocked",
      checkpoints: [
        {
          id: "phase-1",
          title: "阶段 1：旧阶段",
          done: true,
          doneAt: "2026-05-17T00:00:00.000Z",
          note: "keep me"
        }
      ],
      notes: [
        {
          id: "note-1",
          at: "2026-05-17T00:00:00.000Z",
          text: "existing"
        }
      ],
      history: []
    }, null, 2)}\n`, "utf8");

    await runPublish([
      "--html", htmlPath,
      "--root", tempRoot,
      "--id", "merge-plan"
    ]);

    const state = await readJson(path.join(artifactDir, "state.json"));
    assert.equal(state.status, "blocked");
    assert.equal(state.checkpoints.length, 2);
    assert.equal(state.checkpoints[0].done, true);
    assert.equal(state.checkpoints[0].note, "keep me");
    assert.equal(state.checkpoints[1].id, "phase-2");
    assert.equal(state.checkpoints[1].title, "阶段 2：新增阶段");
    assert.equal(state.notes[0].text, "existing");
  });
});
