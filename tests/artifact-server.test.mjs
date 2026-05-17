import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp, createStore } from "../scripts/artifact-server.mjs";

let tempRoot;
let app;

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeArtifact(id, metadata = {}, state = {}) {
  const dir = path.join(tempRoot, id);
  await fs.mkdir(dir, {
    recursive: true
  });
  await fs.writeFile(path.join(dir, "index.html"), `<!doctype html><title>${metadata.title || id}</title><h1>${metadata.title || id}</h1>`, "utf8");
  await writeJson(path.join(dir, "artifact.json"), {
    id,
    title: metadata.title || id,
    type: metadata.type || "implementation-plan",
    createdAt: metadata.createdAt || "2026-05-17T00:00:00.000Z",
    updatedAt: metadata.updatedAt || "2026-05-17T00:00:00.000Z",
    entry: "index.html",
    tags: metadata.tags || []
  });
  await writeJson(path.join(dir, "state.json"), {
    status: state.status || "in-progress",
    checkpoints: state.checkpoints || [],
    notes: state.notes || [],
    history: state.history || []
  });
}

async function injectJson(options) {
  const response = await app.inject(options);
  assert.equal(response.statusCode, options.expectedStatus || 200, response.body);
  return response.json();
}

describe("artifact server", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-server-test-"));
    const store = createStore(tempRoot);
    app = await createApp(store);
    await app.ready();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("lists, searches, and renders detail workbench controls", async () => {
    await writeArtifact("plan-alpha", {
      title: "Alpha Plan",
      tags: ["alpha", "plan"]
    }, {
      checkpoints: [
        {
          id: "phase-1",
          title: "Phase 1",
          done: false,
          doneAt: null,
          note: ""
        }
      ]
    });
    await writeArtifact("architecture-note", {
      title: "Architecture Note",
      type: "architecture-explainer",
      tags: ["architecture"]
    }, {
      status: "done"
    });

    const list = await injectJson({
      method: "GET",
      url: "/api/artifacts"
    });
    assert.deepEqual(list.map((item) => item.id).sort(), ["architecture-note", "plan-alpha"]);

    const search = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?q=alpha&status=in-progress"
    });
    assert.equal(search.filteredCount, 1);
    assert.equal(search.items[0].id, "plan-alpha");

    const page = await app.inject({
      method: "GET",
      url: "/artifacts/plan-alpha"
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="statusSelect"/);
    assert.match(page.body, /id="copyMarkdown"/);
    assert.match(page.body, /checkpoint-note-save/);
  });

  it("persists status, checkpoint notes, notes, and checkpoint toggles", async () => {
    await writeArtifact("review-plan", {
      title: "Review Plan"
    }, {
      checkpoints: [
        {
          id: "stage-1",
          title: "Stage 1",
          done: false,
          doneAt: null,
          note: ""
        }
      ]
    });

    const state = await injectJson({
      method: "GET",
      url: "/api/artifacts/review-plan/state"
    });
    state.status = "blocked";
    state.checkpoints[0].note = "Need reviewer confirmation.";
    state.history.push({
      at: "2026-05-17T01:00:00.000Z",
      type: "status.changed",
      from: "in-progress",
      to: "blocked"
    });

    const saved = await injectJson({
      method: "PUT",
      url: "/api/artifacts/review-plan/state",
      headers: {
        "content-type": "application/json"
      },
      payload: state
    });
    assert.equal(saved.status, "blocked");
    assert.equal(saved.checkpoints[0].note, "Need reviewer confirmation.");
    assert.equal(saved.history.at(-1).type, "status.changed");

    const withNote = await injectJson({
      method: "POST",
      url: "/api/artifacts/review-plan/notes",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        text: "Review note."
      }
    });
    assert.equal(withNote.notes.at(-1).text, "Review note.");
    assert.equal(withNote.history.at(-1).type, "note.added");

    const toggled = await injectJson({
      method: "POST",
      url: "/api/artifacts/review-plan/checkpoints/stage-1/toggle"
    });
    assert.equal(toggled.checkpoints[0].done, true);
    assert.ok(toggled.checkpoints[0].doneAt);
    assert.equal(toggled.history.at(-1).type, "checkpoint.done");

    const diskState = JSON.parse(await fs.readFile(path.join(tempRoot, "review-plan", "state.json"), "utf8"));
    assert.equal(diskState.status, "blocked");
    assert.equal(diskState.checkpoints[0].note, "Need reviewer confirmation.");
    assert.equal(diskState.checkpoints[0].done, true);
  });

  it("returns clear errors for missing artifacts and invalid note writes", async () => {
    await writeArtifact("note-plan");

    const missing = await injectJson({
      method: "GET",
      url: "/api/artifacts/not-found/state",
      expectedStatus: 404
    });
    assert.equal(missing.error, "Artifact not found.");

    const invalidNote = await injectJson({
      method: "POST",
      url: "/api/artifacts/note-plan/notes",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        text: "   "
      },
      expectedStatus: 400
    });
    assert.equal(invalidNote.error, "Note text is required.");
  });
});
