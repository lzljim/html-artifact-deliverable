import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp, createStore } from "../scripts/artifact-server.mjs";
import { importBundle } from "../scripts/import-artifact-bundle.mjs";

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
    tags: metadata.tags || [],
    collection: metadata.collection || null
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

    const health = await injectJson({
      method: "GET",
      url: "/api/health"
    });
    assert.equal(health.status, "ok");
    assert.equal(health.artifactCount, 2);
    assert.equal(health.collectionCount, 0);
    assert.equal(health.root, tempRoot);

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
    assert.match(page.body, /id="copyComments"/);
    assert.match(page.body, /id="noteFilter"/);
    assert.match(page.body, /导出全部/);
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
        text: "Review note.",
        author: "Alice",
        category: "question",
        checkpointId: "stage-1"
      }
    });
    assert.equal(withNote.notes.at(-1).text, "Review note.");
    assert.equal(withNote.notes.at(-1).author, "Alice");
    assert.equal(withNote.notes.at(-1).category, "question");
    assert.equal(withNote.notes.at(-1).checkpointId, "stage-1");
    assert.equal(withNote.notes.at(-1).resolved, false);
    assert.equal(withNote.history.at(-1).type, "note.added");

    const noteId = withNote.notes.at(-1).id;
    const resolved = await injectJson({
      method: "POST",
      url: `/api/artifacts/review-plan/notes/${noteId}/resolve`
    });
    assert.equal(resolved.notes.at(-1).resolved, true);
    assert.ok(resolved.notes.at(-1).resolvedAt);
    assert.equal(resolved.history.at(-1).type, "note.resolved");

    const reopened = await injectJson({
      method: "POST",
      url: `/api/artifacts/review-plan/notes/${noteId}/reopen`
    });
    assert.equal(reopened.notes.at(-1).resolved, false);
    assert.equal(reopened.notes.at(-1).resolvedAt, null);
    assert.equal(reopened.history.at(-1).type, "note.reopened");

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
    assert.equal(diskState.notes[0].author, "Alice");
    assert.equal(diskState.notes[0].checkpointId, "stage-1");
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

  it("groups artifacts into collections and exports collection markdown", async () => {
    await writeArtifact("research-note", {
      title: "Research Note",
      type: "research-report",
      collection: {
        id: "metadata-upgrade",
        title: "Metadata Upgrade"
      }
    }, {
      checkpoints: [
        {
          id: "research",
          title: "Research",
          done: true,
          doneAt: "2026-05-17T00:00:00.000Z",
          note: ""
        }
      ],
      notes: [
        {
          id: "note-1",
          at: "2026-05-17T00:00:00.000Z",
          text: "Looks good."
        }
      ]
    });
    await writeArtifact("plan-note", {
      title: "Plan Note",
      collection: "metadata-upgrade"
    }, {
      checkpoints: [
        {
          id: "plan",
          title: "Plan",
          done: false,
          doneAt: null,
          note: ""
        }
      ]
    });

    const collections = await injectJson({
      method: "GET",
      url: "/api/collections"
    });
    assert.equal(collections.length, 1);
    assert.equal(collections[0].id, "metadata-upgrade");
    assert.equal(collections[0].artifactCount, 2);
    assert.equal(collections[0].checkpointCount, 2);
    assert.equal(collections[0].doneCheckpointCount, 1);
    assert.equal(collections[0].progressPercent, 50);
    assert.equal(collections[0].noteCount, 1);

    const filtered = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?collection=metadata-upgrade"
    });
    assert.deepEqual(filtered.items.map((item) => item.id).sort(), ["plan-note", "research-note"]);

    const markdown = await app.inject({
      method: "GET",
      url: "/api/collections/metadata-upgrade/markdown"
    });
    assert.equal(markdown.statusCode, 200);
    assert.match(markdown.headers["content-type"], /text\/markdown/);
    assert.match(markdown.body, /# Metadata Upgrade/);
    assert.match(markdown.body, /Research Note/);
    assert.match(markdown.body, /阶段进度：1\/2/);
  });

  it("hides archived artifacts by default but keeps them searchable", async () => {
    await writeArtifact("active-plan", {
      title: "Active Plan"
    });
    await writeArtifact("old-plan", {
      title: "Old Plan"
    }, {
      status: "archived"
    });

    const defaultSearch = await injectJson({
      method: "GET",
      url: "/api/artifacts/search"
    });
    assert.deepEqual(defaultSearch.items.map((item) => item.id), ["active-plan"]);
    assert.equal(defaultSearch.stats.total, 2);

    const includeArchived = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?archived=include"
    });
    assert.deepEqual(includeArchived.items.map((item) => item.id).sort(), ["active-plan", "old-plan"]);

    const onlyArchived = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?archived=only"
    });
    assert.deepEqual(onlyArchived.items.map((item) => item.id), ["old-plan"]);

    const direct = await injectJson({
      method: "GET",
      url: "/api/artifacts/old-plan"
    });
    assert.equal(direct.status, "archived");
  });

  it("exports artifact markdown reports and migration bundles", async () => {
    await writeArtifact("export-plan", {
      title: "Export Plan",
      tags: ["export"]
    }, {
      checkpoints: [
        {
          id: "stage-1",
          title: "Stage 1",
          done: true,
          doneAt: "2026-05-17T00:00:00.000Z",
          note: "Ready for review."
        }
      ],
      notes: [
        {
          id: "note-1",
          at: "2026-05-17T00:00:00.000Z",
          text: "Looks good.",
          author: "Alice",
          category: "approval",
          checkpointId: "stage-1",
          resolved: false,
          resolvedAt: null
        }
      ],
      history: [
        {
          at: "2026-05-17T00:00:00.000Z",
          type: "checkpoint.done",
          checkpointId: "stage-1"
        }
      ]
    });

    const markdown = await app.inject({
      method: "GET",
      url: "/api/artifacts/export-plan/markdown"
    });
    assert.equal(markdown.statusCode, 200);
    assert.match(markdown.headers["content-type"], /text\/markdown/);
    assert.match(markdown.headers["content-disposition"], /export-plan-status\.md/);
    assert.match(markdown.body, /# Export Plan/);
    assert.match(markdown.body, /- \[x\] Stage 1/);
    assert.match(markdown.body, /Looks good\./);

    const bundle = await injectJson({
      method: "GET",
      url: "/api/artifacts/export-plan/export"
    });
    assert.equal(bundle.artifact.id, "export-plan");
    assert.equal(bundle.state.checkpoints[0].note, "Ready for review.");
    assert.match(bundle.indexHtml, /Export Plan/);
    assert.ok(bundle.exportedAt);
  });

  it("exports all artifacts and imports them into another root", async () => {
    await writeJson(path.join(tempRoot, "collection.json"), {
      collections: [
        {
          id: "migration",
          title: "Migration",
          artifactIds: ["first-plan", "old-plan"]
        }
      ]
    });
    await writeArtifact("first-plan", {
      title: "First Plan",
      collection: "migration"
    }, {
      checkpoints: [
        {
          id: "stage-1",
          title: "Stage 1",
          done: true,
          doneAt: "2026-05-17T00:00:00.000Z",
          note: "Done."
        }
      ]
    });
    await writeArtifact("old-plan", {
      title: "Old Plan"
    }, {
      status: "archived"
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/export"
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /application\/json/);
    assert.match(response.headers["content-disposition"], /html-artifacts-\d{4}-\d{2}-\d{2}\.json/);
    const bundle = response.json();
    assert.equal(bundle.format, "html-artifact-deliverable.all.v1");
    assert.equal(bundle.artifactCount, 2);
    assert.deepEqual(bundle.artifacts.map((item) => item.id).sort(), ["first-plan", "old-plan"]);
    assert.equal(bundle.artifacts.find((item) => item.id === "old-plan").state.status, "archived");

    const bundlePath = path.join(tempRoot, "bundle.json");
    const importRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-import-test-"));
    await writeJson(bundlePath, bundle);
    try {
      const imported = await importBundle({
        bundlePath,
        root: importRoot
      });
      assert.equal(imported.artifactCount, 2);

      const importedStore = createStore(importRoot);
      const artifacts = await importedStore.listArtifacts();
      assert.deepEqual(artifacts.map((item) => item.id).sort(), ["first-plan", "old-plan"]);
      const oldState = await importedStore.getState("old-plan");
      assert.equal(oldState.status, "archived");
      const collectionConfig = JSON.parse(await fs.readFile(path.join(importRoot, "collection.json"), "utf8"));
      assert.equal(collectionConfig.collections[0].id, "migration");
    } finally {
      await fs.rm(importRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("protects pages, APIs, and artifact files when a token is configured", async () => {
    await writeArtifact("secure-plan", {
      title: "Secure Plan"
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

    await app.close();
    app = await createApp(createStore(tempRoot), {
      token: "secret-token"
    });
    await app.ready();

    const apiWithoutToken = await app.inject({
      method: "GET",
      url: "/api/artifacts"
    });
    assert.equal(apiWithoutToken.statusCode, 401);
    assert.equal(apiWithoutToken.json().error, "Artifact token is required.");

    const healthWithToken = await injectJson({
      method: "GET",
      url: "/api/health?token=secret-token"
    });
    assert.equal(healthWithToken.status, "ok");

    const pageWithoutToken = await app.inject({
      method: "GET",
      url: "/artifacts/secure-plan"
    });
    assert.equal(pageWithoutToken.statusCode, 401);
    assert.match(pageWithoutToken.headers["content-type"], /text\/html/);
    assert.match(pageWithoutToken.body, /name="token"/);

    const pageWithToken = await app.inject({
      method: "GET",
      url: "/artifacts/secure-plan?token=secret-token"
    });
    assert.equal(pageWithToken.statusCode, 200);
    assert.match(pageWithToken.body, /token=secret-token/);
    assert.match(String(pageWithToken.headers["set-cookie"]), /artifact_token=secret-token/);

    const apiWithHeader = await injectJson({
      method: "GET",
      url: "/api/artifacts/secure-plan/state",
      headers: {
        "x-artifact-token": "secret-token"
      }
    });
    assert.equal(apiWithHeader.status, "in-progress");

    const fileWithToken = await app.inject({
      method: "GET",
      url: "/files/secure-plan/index.html?token=secret-token"
    });
    assert.equal(fileWithToken.statusCode, 200);
    assert.match(fileWithToken.body, /Secure Plan/);

    const fileWithoutToken = await app.inject({
      method: "GET",
      url: "/files/secure-plan/index.html"
    });
    assert.equal(fileWithoutToken.statusCode, 401);
  });

  it("allows read-only tokens to view and export without mutating state", async () => {
    await writeArtifact("readonly-plan", {
      title: "Readonly Plan"
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

    await app.close();
    app = await createApp(createStore(tempRoot), {
      token: "write-token",
      readToken: "read-token"
    });
    await app.ready();

    const stateWithReadToken = await injectJson({
      method: "GET",
      url: "/api/artifacts/readonly-plan/state?token=read-token"
    });
    assert.equal(stateWithReadToken.status, "in-progress");

    const pageWithReadToken = await app.inject({
      method: "GET",
      url: "/artifacts/readonly-plan?token=read-token"
    });
    assert.equal(pageWithReadToken.statusCode, 200);
    assert.match(pageWithReadToken.body, /只读模式/);

    const markdownWithReadToken = await app.inject({
      method: "GET",
      url: "/api/artifacts/readonly-plan/markdown?token=read-token"
    });
    assert.equal(markdownWithReadToken.statusCode, 200);
    assert.match(markdownWithReadToken.body, /Readonly Plan/);

    const allExportWithReadToken = await app.inject({
      method: "GET",
      url: "/api/export?token=read-token"
    });
    assert.equal(allExportWithReadToken.statusCode, 200);
    assert.equal(allExportWithReadToken.json().artifactCount, 1);

    const blockedToggle = await app.inject({
      method: "POST",
      url: "/api/artifacts/readonly-plan/checkpoints/stage-1/toggle?token=read-token"
    });
    assert.equal(blockedToggle.statusCode, 403);
    assert.equal(blockedToggle.json().error, "Read-only artifact token cannot modify state.");

    const writeToggle = await injectJson({
      method: "POST",
      url: "/api/artifacts/readonly-plan/checkpoints/stage-1/toggle?token=write-token"
    });
    assert.equal(writeToggle.checkpoints[0].done, true);
  });
});
