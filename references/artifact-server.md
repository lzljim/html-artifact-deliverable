# Artifact Server Contract

Use this reference when an HTML artifact should be published into a local Node.js service instead of saved as a loose file. The included MVP server lives at `scripts/artifact-server.mjs` and uses Fastify, `@fastify/static`, and MiniSearch; do not start it unless the user asks for sharing, tracking, publishing, or a runnable service.

## Start Command

From the skill directory:

```bash
npm install
npm start
```

Before committing changes to the server or publish script, run:

```bash
npm run check
```

With explicit settings:

```bash
node scripts/artifact-server.mjs --root <artifact-root> --host 127.0.0.1 --port 8787
```

Publish an existing HTML file:

```bash
node scripts/publish-artifact.mjs --html <file.html> --title "<title>" --type implementation-plan --checkpoint research:调研完成
```

The publish script copies the input file to `<artifact-root>/<id>/index.html`, writes `artifact.json`, and initializes `state.json` if it does not exist.

For quick publishing, these fields are inferred when omitted:

- `title`: `<title>`, then `<h1>`, then file name.
- `type`: title/path/content keywords such as `implementation-plan`, `architecture-explainer`, `code-review`, `research-report`, or `custom-editor`.
- `checkpoints`: phase-style HTML headings, including paired `.phase-id` blocks followed by `<h3>` and standalone headings like `阶段 1：旧/新 Schema 生成`.

Pass `--checkpoint` to use explicit checkpoints instead of inferred ones, or `--no-auto-checkpoints` to publish without generated checkpoints.

Defaults:

- Artifact root: `~/.codex/html-artifacts`
- Host: `127.0.0.1`
- Port: `8787`

## When To Publish

Publish to an artifact server when any of these is true:

- The user wants to share the artifact with colleagues through a URL.
- The artifact is an execution plan with phases, checkpoints, review gates, or follow-up state.
- The artifact should stay discoverable from a dashboard or history list.
- Multiple artifacts belong to one investigation or implementation thread.
- The user asks for persistent notes, done flags, reviewer comments, or status history.

Keep a loose `.html` file when the artifact is private, disposable, tiny, or must remain fully portable without a server.

## Default Safety

- Bind the service to `127.0.0.1` by default.
- Bind to `0.0.0.0` only after the user explicitly wants LAN sharing.
- Treat source snippets, local file paths, logs, stack traces, customer data, credentials, and internal URLs as sensitive.
- Prefer a simple share token before LAN sharing if the artifact contains non-public project context.
- Never imply that LAN sharing is safe for public internet exposure.

## Directory Contract

Use one directory per artifact:

```text
artifacts/
  2026-05-17-html-skill-plan/
    index.html
    artifact.json
    state.json
```

`index.html` is the mostly immutable rendered artifact. It should still open directly from disk with useful content, even if server-only state panels are unavailable.

`artifact.json` stores stable metadata:

```json
{
  "id": "2026-05-17-html-skill-plan",
  "title": "HTML Artifact Skill 完善方案",
  "type": "implementation-plan",
  "createdAt": "2026-05-17T09:30:00+08:00",
  "updatedAt": "2026-05-17T10:00:00+08:00",
  "source": {
    "workspace": "D:/lzl/work/dev/bi/com.succez.bi",
    "thread": "optional-thread-label"
  },
  "entry": "index.html",
  "tags": ["skill", "artifact-server"]
}
```

`state.json` stores mutable state:

```json
{
  "status": "in-progress",
  "checkpoints": [
    {
      "id": "research",
      "title": "调研完成",
      "done": true,
      "doneAt": "2026-05-17T09:45:00+08:00",
      "note": "已确认 HTML artifact 有可落地价值"
    },
    {
      "id": "implementation",
      "title": "服务实现",
      "done": false,
      "doneAt": null,
      "note": ""
    }
  ],
  "notes": [],
  "history": [
    {
      "at": "2026-05-17T09:45:00+08:00",
      "type": "checkpoint.done",
      "checkpointId": "research"
    }
  ]
}
```

## Checkpoint Rules

For plans and phased work, include checkpoints in `state.json` instead of hard-coding completion state into `index.html`.

Use checkpoint ids that are stable and kebab-case:

- `research`
- `plan-review`
- `implementation`
- `verification`
- `docs-update`

Each checkpoint should have:

- `id`: stable machine key.
- `title`: human-readable label.
- `done`: boolean.
- `doneAt`: ISO timestamp or `null`.
- `note`: short free-form note.

## Service Shape

The included MVP Node.js service provides:

```text
GET  /
GET  /artifacts/:id
GET  /api/artifacts
GET  /api/artifacts/search
GET  /api/artifacts/:id
GET  /api/artifacts/:id/state
PUT  /api/artifacts/:id/state
POST /api/artifacts/:id/checkpoints/:checkpointId/toggle
POST /api/artifacts/:id/notes
```

The artifact detail page lets reviewers edit status, toggle checkpoints, maintain checkpoint notes, add artifact notes, and copy the current state as JSON or Markdown.

MVP storage should be JSON files, not a database. Use atomic writes for `state.json` when possible.

## HTML Integration

Prefer a server wrapper for mutable UI:

- The artifact remains `index.html`.
- The server displays it with an outer shell or side panel for state.
- Checkpoint toggles update `state.json` through API calls.

If embedding state controls directly into `index.html`, make them degrade gracefully when opened from disk:

- Show the static checkpoint list.
- Disable persistence controls if the API is unavailable.
- Keep an export button so state can still be copied as Markdown or JSON.

## Reply Contract

When publishing to the artifact server, reply with:

- Local file path.
- Server URL if the service exists or was started.
- Whether the URL is loopback-only or LAN-visible.
- Where mutable state is stored.
- Any privacy warning that matters for the content.
