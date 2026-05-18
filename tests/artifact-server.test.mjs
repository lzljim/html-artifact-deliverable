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
    personal: state.personal || {},
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
      ],
      notes: [
        {
          id: "risk-1",
          at: "2026-05-17T02:00:00.000Z",
          text: "Risk needs review.",
          author: "Reviewer",
          category: "risk",
          checkpointId: "phase-1",
          resolved: false,
          resolvedAt: null
        },
        {
          id: "action-1",
          at: "2026-05-17T03:00:00.000Z",
          text: "Action needs owner.",
          author: "Reviewer",
          category: "action",
          checkpointId: "",
          resolved: false,
          resolvedAt: null
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
    assert.equal(search.items[0].openNoteCount, 2);
    assert.equal(search.items[0].riskNoteCount, 1);
    assert.equal(search.items[0].actionNoteCount, 1);
    assert.equal(search.items[0].latestOpenNote.category, "risk");
    assert.equal(search.items[0].reviewPriority, 4);
    assert.equal(search.items[0].reviewState, "needs-review");
    assert.equal(search.items[0].highestSeverity, "high");
    assert.equal(search.items[0].checkpoints[0].review.reviewState, "needs-review");
    assert.equal(search.stats.openNotes, 2);
    assert.equal(search.stats.riskNotes, 1);
    assert.equal(search.stats.actionNotes, 1);
    assert.equal(search.stats.reviewArtifacts, 1);

    const riskSearch = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?review=risk"
    });
    assert.deepEqual(riskSearch.items.map((item) => item.id), ["plan-alpha"]);

    const dashboard = await app.inject({
      method: "GET",
      url: "/"
    });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.body, /Review Dashboard/);
    assert.match(dashboard.body, /id="personalHub"/);
    assert.match(dashboard.body, /id="quickCreateForm"/);
    assert.match(dashboard.body, /id="organizeHub"/);
    assert.match(dashboard.body, /data-organize-collection/);
    assert.match(dashboard.body, /data-organize-new-collection/);
    assert.match(dashboard.body, /data-personal-action="pin"/);
    assert.match(dashboard.body, /data-personal-action="reference"/);
    assert.match(dashboard.body, /organizeActionLabel/);
    assert.match(dashboard.body, /常用资料/);
    assert.match(dashboard.body, /data-review-filter=/);
    assert.match(dashboard.body, /待办 \/ Review 队列/);
    assert.match(dashboard.body, /暂无待办或未解决 review 项/);
    assert.match(dashboard.body, /项目集进度矩阵/);
    assert.match(dashboard.body, /id="collectionSort"/);
    assert.match(dashboard.body, /data-collection-delete-id/);
    assert.match(dashboard.body, /导出全部/);
    assert.match(dashboard.body, /导入全部/);
    assert.ok(
      dashboard.body.indexOf('id="list"') < dashboard.body.indexOf('id="collectionMatrix"'),
      "collection progress matrix should render after the artifact list slot"
    );

    const page = await app.inject({
      method: "GET",
      url: "/artifacts/plan-alpha"
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="statusSelect"/);
    assert.match(page.body, /id="copyMarkdown"/);
    assert.match(page.body, /id="copyComments"/);
    assert.match(page.body, /id="noteFilter"/);
    assert.match(page.body, /id="quickNoteForm"/);
    assert.match(page.body, /id="noteReviewState"/);
    assert.match(page.body, /data-note-action="update"/);
    assert.match(page.body, /导出全部/);
    assert.match(page.body, /checkpoint-note-save/);
  });

  it("normalizes review workflow fields and derives artifact plus checkpoint states", async () => {
    await writeArtifact("workflow-plan", {
      title: "Workflow Plan"
    }, {
      checkpoints: [
        {
          id: "stage-1",
          title: "Stage 1",
          done: false,
          doneAt: null,
          note: ""
        },
        {
          id: "stage-2",
          title: "Stage 2",
          done: false,
          doneAt: null,
          note: ""
        }
      ],
      notes: [
        {
          id: "approval-1",
          at: "2026-05-17T00:00:00.000Z",
          text: "Approved baseline.",
          category: "approval",
          resolved: false
        },
        {
          id: "change-1",
          at: "2026-05-17T01:00:00.000Z",
          text: "Adjust the review copy.",
          category: "action",
          checkpointId: "stage-1",
          reviewState: "changes-requested",
          severity: "high",
          owner: "Bob",
          dueAt: "2026-01-01"
        },
        {
          id: "question-1",
          at: "2026-05-17T02:00:00.000Z",
          text: "Confirm the edge case.",
          category: "question",
          checkpointId: "stage-2"
        },
        {
          id: "resolved-risk",
          at: "2026-05-17T03:00:00.000Z",
          text: "Old risk.",
          category: "risk",
          resolved: true,
          resolvedAt: "2026-05-17T04:00:00.000Z"
        }
      ]
    });

    const artifact = await injectJson({
      method: "GET",
      url: "/api/artifacts/workflow-plan"
    });
    assert.equal(artifact.openNoteCount, 2);
    assert.equal(artifact.reviewState, "changes-requested");
    assert.equal(artifact.reviewStateLabel, "需修改");
    assert.equal(artifact.highestSeverity, "high");
    assert.equal(artifact.overdueNoteCount, 1);
    assert.equal(artifact.approvalNoteCount, 1);
    assert.equal(artifact.latestOpenNote.owner, "Bob");
    assert.equal(artifact.latestOpenNote.overdue, true);
    assert.equal(artifact.checkpoints[0].review.reviewState, "changes-requested");
    assert.equal(artifact.checkpoints[1].review.reviewState, "needs-review");

    const filtered = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?review=changes-requested"
    });
    assert.deepEqual(filtered.items.map((item) => item.id), ["workflow-plan"]);
    assert.equal(filtered.stats.changesRequestedArtifacts, 1);
    assert.equal(filtered.stats.overdueNotes, 1);

    const state = await injectJson({
      method: "GET",
      url: "/api/artifacts/workflow-plan/state"
    });
    assert.equal(state.notes.find((item) => item.id === "approval-1").reviewState, "approved");
    assert.equal(state.notes.find((item) => item.id === "question-1").reviewState, "open");
    assert.equal(state.notes.find((item) => item.id === "question-1").severity, "medium");
    assert.equal(state.notes.find((item) => item.id === "resolved-risk").reviewState, "resolved");
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
    assert.equal(reopened.notes.at(-1).reviewState, "open");
    assert.equal(reopened.history.at(-1).type, "note.reopened");

    const updatedNote = await injectJson({
      method: "PATCH",
      url: `/api/artifacts/review-plan/notes/${noteId}`,
      headers: {
        "content-type": "application/json"
      },
      payload: {
        reviewState: "changes-requested",
        severity: "high",
        owner: "Bob",
        dueAt: "2026-01-01"
      }
    });
    assert.equal(updatedNote.notes.at(-1).reviewState, "changes-requested");
    assert.equal(updatedNote.notes.at(-1).severity, "high");
    assert.equal(updatedNote.notes.at(-1).owner, "Bob");
    assert.equal(updatedNote.notes.at(-1).dueAt, "2026-01-01");
    assert.equal(updatedNote.history.at(-1).type, "note.updated");

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
    assert.equal(diskState.notes[0].reviewState, "changes-requested");
  });

  it("supports personal task hub state, quick create, opened activity, and organizing actions", async () => {
    const created = await injectJson({
      method: "POST",
      url: "/api/artifacts",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        id: "personal-plan",
        title: "Personal Plan",
        type: "implementation-plan",
        collection: "personal-work",
        checkpointTitle: "First Step"
      }
    });
    assert.equal(created.id, "personal-plan");
    assert.equal(created.status, "draft");
    assert.equal(created.checkpointCount, 1);
    assert.equal(created.personal.priority, "focus");
    assert.equal(created.personal.reference, false);

    const duplicate = await injectJson({
      method: "POST",
      url: "/api/artifacts",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        id: "personal-plan",
        title: "Personal Plan"
      },
      expectedStatus: 409
    });
    assert.match(duplicate.error, /already exists/);

    await writeArtifact("loose-plan", {
      title: "Loose Plan"
    });
    const collected = await injectJson({
      method: "POST",
      url: "/api/artifacts/bulk",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        ids: ["loose-plan"],
        action: "collection",
        collection: "personal-work"
      }
    });
    assert.equal(collected.updatedCount, 1);
    const looseMetadata = JSON.parse(await fs.readFile(path.join(tempRoot, "loose-plan", "artifact.json"), "utf8"));
    assert.deepEqual(looseMetadata.collection, {
      id: "personal-work",
      title: "personal-work"
    });

    await writeArtifact("new-collection-plan", {
      title: "New Collection Plan"
    });
    const newCollection = await injectJson({
      method: "POST",
      url: "/api/artifacts/bulk",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        ids: ["new-collection-plan"],
        action: "collection",
        collection: "Fresh Work"
      }
    });
    assert.equal(newCollection.updatedCount, 1);
    const collections = await injectJson({
      method: "GET",
      url: "/api/collections"
    });
    assert.ok(collections.some((item) => item.id === "fresh-work" && item.artifactCount === 1));

    const personal = await injectJson({
      method: "PATCH",
      url: "/api/artifacts/personal-plan/personal",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        pinned: true,
        priority: "later",
        snoozedUntil: "2026-05-20",
        reference: true
      }
    });
    assert.equal(personal.personal.pinned, true);
    assert.equal(personal.personal.priority, "later");
    assert.equal(personal.personal.snoozedUntil, "2026-05-20");
    assert.equal(personal.personal.reference, true);

    const personalReferenceOff = await injectJson({
      method: "PATCH",
      url: "/api/artifacts/personal-plan/personal",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        reference: false
      }
    });
    assert.equal(personalReferenceOff.personal.reference, false);

    await writeArtifact("reference-plan", {
      title: "Reference Plan",
      type: "architecture-explainer",
      collection: {
        id: "personal-work",
        title: "Personal Work"
      }
    }, {
      status: "done",
      personal: {
        reference: true
      }
    });
    await writeArtifact("archived-reference", {
      title: "Archived Reference",
      type: "architecture-explainer"
    }, {
      status: "archived",
      personal: {
        reference: true
      }
    });
    const referenceSearch = await injectJson({
      method: "GET",
      url: "/api/artifacts/search"
    });
    assert.deepEqual(referenceSearch.stats.personalSections.reference.map((item) => item.id), ["reference-plan"]);
    assert.equal(referenceSearch.stats.personalSections.reference[0].typeLabel, "架构说明");
    assert.equal(referenceSearch.stats.personalSections.reference[0].collection.title, "Personal Work");
    assert.ok(!referenceSearch.stats.organizeSections.doneOpen.some((item) => item.id === "reference-plan"));
    assert.ok(!referenceSearch.stats.personalSections.closing.some((item) => item.id === "reference-plan"));
    assert.ok(!referenceSearch.stats.personalSections.reference.some((item) => item.id === "archived-reference"));

    await writeArtifact("bulk-reference-plan", {
      title: "Bulk Reference Plan",
      type: "architecture-explainer"
    }, {
      status: "done"
    });
    const bulkReference = await injectJson({
      method: "POST",
      url: "/api/artifacts/bulk",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        ids: ["bulk-reference-plan"],
        action: "reference"
      }
    });
    assert.equal(bulkReference.updatedCount, 1);
    const bulkReferenceSearch = await injectJson({
      method: "GET",
      url: "/api/artifacts/search"
    });
    assert.ok(bulkReferenceSearch.stats.personalSections.reference.some((item) => item.id === "bulk-reference-plan"));
    assert.ok(!bulkReferenceSearch.stats.organizeSections.doneOpen.some((item) => item.id === "bulk-reference-plan"));

    const opened = await injectJson({
      method: "POST",
      url: "/api/artifacts/personal-plan/activity/opened"
    });
    assert.ok(opened.personal.lastOpenedAt);
    assert.equal(opened.history.at(-1).type, "artifact.opened");

    const withCheckpoint = await injectJson({
      method: "POST",
      url: "/api/artifacts/personal-plan/checkpoints",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        title: "Follow Up"
      }
    });
    assert.equal(withCheckpoint.checkpoints.length, 2);
    assert.equal(withCheckpoint.history.at(-1).type, "checkpoint.added");

    const done = await injectJson({
      method: "PATCH",
      url: "/api/artifacts/personal-plan/status",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        status: "done"
      }
    });
    assert.equal(done.status, "done");

    const unpinned = await injectJson({
      method: "POST",
      url: "/api/artifacts/bulk",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        ids: ["personal-plan"],
        action: "unpin"
      }
    });
    assert.equal(unpinned.updatedCount, 1);

    const archived = await injectJson({
      method: "POST",
      url: "/api/artifacts/bulk",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        ids: ["personal-plan"],
        action: "archive"
      }
    });
    assert.equal(archived.updatedCount, 1);

    const direct = await injectJson({
      method: "GET",
      url: "/api/artifacts/personal-plan"
    });
    assert.equal(direct.status, "archived");

    const bundle = await injectJson({
      method: "GET",
      url: "/api/export"
    });
    assert.equal(bundle.artifacts.find((item) => item.id === "personal-plan").state.status, "archived");
  });

  it("keeps current work ahead of done artifacts while sorting inside status groups", async () => {
    await writeArtifact("done-latest", {
      title: "Done Latest",
      updatedAt: "2026-05-17T03:00:00.000Z"
    }, {
      status: "done"
    });
    await writeArtifact("active-newer", {
      title: "Active Newer",
      updatedAt: "2026-05-17T02:00:00.000Z"
    });
    await writeArtifact("active-older", {
      title: "Active Older",
      updatedAt: "2026-05-17T01:00:00.000Z"
    });

    const defaultSearch = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?sort=updated-desc"
    });
    assert.deepEqual(defaultSearch.items.map((item) => item.id), ["active-newer", "active-older", "done-latest"]);

    const doneSearch = await injectJson({
      method: "GET",
      url: "/api/artifacts/search?status=done&sort=updated-desc"
    });
    assert.deepEqual(doneSearch.items.map((item) => item.id), ["done-latest"]);

    const dashboard = await app.inject({
      method: "GET",
      url: "/"
    });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.body, /组内最近更新/);
    assert.match(dashboard.body, /statusGroupOrder = \["blocked", "in-progress", "draft", "done", "archived"\]/);
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
          text: "Needs owner.",
          category: "action",
          resolved: false
        },
        {
          id: "note-2",
          at: "2026-05-17T00:30:00.000Z",
          text: "Risk needs mitigation.",
          category: "risk",
          resolved: false
        }
      ]
    });
    await writeArtifact("plan-note", {
      title: "Plan Note",
      collection: "metadata-upgrade"
    }, {
      status: "blocked",
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
    assert.equal(collections[0].noteCount, 2);
    assert.equal(collections[0].openNoteCount, 2);
    assert.equal(collections[0].riskNoteCount, 1);
    assert.equal(collections[0].actionNoteCount, 1);
    assert.equal(collections[0].blockedArtifactCount, 1);
    assert.equal(collections[0].riskArtifactCount, 1);
    assert.equal(collections[0].reviewArtifactCount, 2);
    assert.equal(collections[0].healthStatus, "blocked");
    assert.equal(collections[0].healthLabel, "阻塞");
    assert.deepEqual(collections[0].artifacts.map((item) => item.id), ["plan-note", "research-note"]);
    assert.equal(collections[0].artifacts.find((item) => item.id === "research-note").checkpoints[0].title, "Research");

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
    assert.match(markdown.body, /项目集健康：阻塞/);

    const reviewMarkdown = await app.inject({
      method: "GET",
      url: "/api/collections/metadata-upgrade/review-markdown"
    });
    assert.equal(reviewMarkdown.statusCode, 200);
    assert.match(reviewMarkdown.headers["content-type"], /text\/markdown/);
    assert.match(reviewMarkdown.body, /# Metadata Upgrade Review 摘要/);
    assert.match(reviewMarkdown.body, /- 待办：1/);
    assert.match(reviewMarkdown.body, /最近待处理：待处理 \/ 高 \/ 风险：Risk needs mitigation\./);
  });

  it("deletes collections by unassigning member artifacts", async () => {
    await writeJson(path.join(tempRoot, "collection.json"), {
      collections: [
        {
          id: "configured-work",
          title: "Configured Work",
          artifactIds: ["configured-plan"]
        }
      ]
    });
    await writeArtifact("configured-plan", {
      title: "Configured Plan",
      collection: {
        id: "configured-work",
        title: "Configured Work"
      }
    });
    await writeArtifact("metadata-plan", {
      title: "Metadata Plan",
      collection: {
        id: "metadata-only",
        title: "Metadata Only"
      }
    });

    const configuredDelete = await injectJson({
      method: "DELETE",
      url: "/api/collections/configured-work"
    });
    assert.deepEqual(configuredDelete, {
      deleted: true,
      id: "configured-work",
      unassignedCount: 1
    });
    const configuredMetadata = JSON.parse(await fs.readFile(path.join(tempRoot, "configured-plan", "artifact.json"), "utf8"));
    assert.equal(configuredMetadata.collection, null);
    const collectionConfig = JSON.parse(await fs.readFile(path.join(tempRoot, "collection.json"), "utf8"));
    assert.deepEqual(collectionConfig.collections, []);

    const metadataDelete = await injectJson({
      method: "DELETE",
      url: "/api/collections/metadata-only"
    });
    assert.deepEqual(metadataDelete, {
      deleted: true,
      id: "metadata-only",
      unassignedCount: 1
    });
    const metadataOnly = JSON.parse(await fs.readFile(path.join(tempRoot, "metadata-plan", "artifact.json"), "utf8"));
    assert.equal(metadataOnly.collection, null);

    const collections = await injectJson({
      method: "GET",
      url: "/api/collections"
    });
    assert.deepEqual(collections.map((item) => item.id), []);

    const search = await injectJson({
      method: "GET",
      url: "/api/artifacts/search"
    });
    assert.deepEqual(search.stats.organizeSections.noCollection.map((item) => item.id).sort(), ["configured-plan", "metadata-plan"]);

    const missing = await injectJson({
      method: "DELETE",
      url: "/api/collections/missing-work",
      expectedStatus: 404
    });
    assert.equal(missing.error, "Collection not found.");
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
    assert.match(markdown.body, /Review 状态：已认可/);
    assert.match(markdown.body, /- \[x\] Stage 1/);
    assert.match(markdown.body, /已认可 \/ 严重度 低/);
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

  it("imports a full artifact bundle through the server API", async () => {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-source-test-"));
    try {
      const sourceDir = path.join(sourceRoot, "imported-plan");
      await fs.mkdir(sourceDir, {
        recursive: true
      });
      await fs.writeFile(path.join(sourceDir, "index.html"), "<!doctype html><title>Imported Plan</title>", "utf8");
      await writeJson(path.join(sourceDir, "artifact.json"), {
        id: "imported-plan",
        title: "Imported Plan",
        type: "implementation-plan",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        entry: "index.html",
        tags: ["import"]
      });
      await writeJson(path.join(sourceDir, "state.json"), {
        status: "done",
        checkpoints: [],
        notes: [],
        history: []
      });

      const bundle = await createStore(sourceRoot).getAllArtifactsBundle();
      const imported = await injectJson({
        method: "POST",
        url: "/api/import",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          bundle
        }
      });
      assert.equal(imported.artifactCount, 1);

      const artifact = await injectJson({
        method: "GET",
        url: "/api/artifacts/imported-plan"
      });
      assert.equal(artifact.title, "Imported Plan");
      assert.equal(artifact.status, "done");

      const duplicate = await injectJson({
        method: "POST",
        url: "/api/import",
        headers: {
          "content-type": "application/json"
        },
        payload: {
          bundle
        },
        expectedStatus: 409
      });
      assert.match(duplicate.error, /already exists/);
    } finally {
      await fs.rm(sourceRoot, {
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

    const blockedImport = await app.inject({
      method: "POST",
      url: "/api/import?token=read-token",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        bundle: allExportWithReadToken.json()
      }
    });
    assert.equal(blockedImport.statusCode, 403);
    assert.equal(blockedImport.json().error, "Read-only artifact token cannot modify state.");

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
