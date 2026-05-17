---
name: html-artifact-deliverable
description: Create a self-contained HTML artifact instead of Markdown when the user asks for a substantial report, plan, comparison, code review, PR writeup, architecture explanation, timeline, diagram-heavy document, visual prototype, slide-like walkthrough, or one-off editor/tool where layout, color, navigation, interaction, checkpoint tracking, or shareability materially improves the result. Use this for Chinese or English deliverables that need to be opened locally as a single .html file or published into a local Node.js artifact server for team viewing and state tracking. Stay in Markdown for short replies, code-only snippets, terminal instructions, durable git-reviewed docs, or content that is mainly plain text.
---

# HTML Artifact Deliverable

Use this skill to turn substantial agent deliverables into a single local HTML file when HTML is a better medium than Markdown. When the artifact needs team sharing, progress tracking, or later review, publish it into a local artifact server contract instead of leaving it as a loose file.

## Decision Rule

Choose HTML when at least one of these is true:

- The user must compare options side by side.
- The content has spatial structure: diff, module map, timeline, flow, architecture, before/after.
- The reader benefits from visual hierarchy, severity color, filters, tabs, anchors, collapsible sections, or a table of contents.
- The output is likely to be shared, presented, reviewed, or revisited.
- The user needs a one-off editor, tuner, triage board, checklist, or structured review surface.
- The output is an execution plan with phases, checkpoints, review gates, or follow-up status.
- The Markdown version would exceed roughly 100 lines or force the reader to mentally hold several sections at once.

Stay in Markdown when the answer is short, code-only, command-oriented, or intended to live in git as a frequently edited source document. For durable docs, consider producing Markdown as the source and HTML as an optional review/view layer.

## Output Contract

Every HTML artifact must:

1. Be one self-contained `.html` file.
2. Work offline unless the user explicitly accepts external dependencies.
3. Include responsive layout with `<meta name="viewport" content="width=device-width, initial-scale=1">`.
4. Use semantic HTML, stable dimensions, and readable typography.
5. Use real layout instead of wrapping a Markdown outline in HTML.
6. Include a clear title, short framing summary, and the main usable content within the first viewport.
7. Avoid decorative noise, generic gradient dashboards, and nested-card layouts.
8. Include export/copy controls for any interactive editor so the user's changes can round-trip back to Markdown, JSON, a prompt, or a config patch.
9. Keep mutable state outside `index.html` when publishing through an artifact server.

## Workflow

1. Identify the artifact type: comparison, plan, code review, report, diagram explainer, prototype, deck, or editor.
2. Read `references/patterns.md` for the matching pattern if the task is non-trivial.
3. Read `references/artifact-server.md` when the user asks to share with colleagues, publish, track phases, persist checklist state, or use a Node.js service.
4. Gather the task evidence first. Do not make the HTML prettier than the analysis is true.
5. Save the artifact in the current workspace using a descriptive kebab-case filename, or under `docs/ai/` when it is a planning/research artifact for a repository.
6. If artifact-server publication is requested or clearly useful, write the artifact using the directory contract in `references/artifact-server.md`.
7. If the artifact includes JavaScript interactions, keep state local to the page and provide a visible copy/export button.
8. Verify the file opens: for simple files inspect the HTML statically; for UI-heavy files use the browser or Playwright when available.
9. Reply with the path or URL, the reason HTML/server publication was chosen, and any validation that was or was not performed.

## Artifact Server Script

This skill includes a Node.js artifact server built with Fastify, `@fastify/static`, and MiniSearch. Install dependencies once after cloning or updating:

```bash
npm install
```

Start the server:

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Windows helper:

```powershell
.\scripts\start-artifact-server.ps1
.\scripts\start-artifact-server.ps1 -Lan
.\scripts\start-artifact-server.ps1 -Lan -Token <edit-token> -ReadToken <view-token>
```

Run regression checks before committing server or publish-script changes:

```bash
npm run check
```

Default behavior:

- Artifact root: `~/.codex/html-artifacts`
- Host: `127.0.0.1`
- Port: `8787`
- Detail pages provide status editing, checkpoint toggles, per-checkpoint notes, reviewer comments, resolve/reopen review flow, and JSON/Markdown status export.
- The dashboard can group related artifacts into collections with aggregate progress and collection-level Markdown export.
- The dashboard includes a Review Dashboard for unresolved comments, risks, actions, blocked/risk items, recent updates, and a prioritized review queue, with click-to-filter review shortcuts.
- Archived artifacts use `state.status = "archived"`; they are hidden from default dashboard search but remain available through direct URLs, collections, and explicit archive filters.
- Single artifacts can be exported as Markdown status reports or JSON migration bundles through the detail page and API.
- The dashboard provides one-click full export through `GET /api/export` and full import through `POST /api/import`; restore from CLI with `node scripts/import-artifact-bundle.mjs --bundle <file.json>`.
- Health check: `GET /api/health`

Use explicit flags when needed:

```bash
node scripts/artifact-server.mjs --root <artifact-root> --host 127.0.0.1 --port 8787
```

For LAN sharing, prefer enabling a token:

```bash
node scripts/artifact-server.mjs --host 0.0.0.0 --token <share-token>
```

The token can also be supplied with `ARTIFACT_TOKEN`. When configured, pages, API routes, and artifact files all require the token through `?token=...`, `x-artifact-token`, `Authorization: Bearer ...`, or the browser cookie set after a valid token visit.

For view-only sharing, add `--read-token <view-token>` or set `ARTIFACT_READ_TOKEN`. The normal `--token` / `ARTIFACT_TOKEN` remains the edit token; the read token can open pages and export reports but receives `403` for writes.

If the port is already in use, start with a different port:

```bash
node scripts/artifact-server.mjs --port 8788
```

Publish an existing HTML file into the artifact root:

```bash
node scripts/publish-artifact.mjs --html <file.html> --title "<title>" --type implementation-plan --checkpoint research:调研完成
```

Publish into a collection:

```bash
node scripts/publish-artifact.mjs --html <file.html> --collection project-id:"Project Title"
```

When the server is already running, pass server settings to make the publish output include directly openable URLs:

```bash
node scripts/publish-artifact.mjs --html <file.html> --server-host 0.0.0.0 --server-token <share-token>
```

When `--title`, `--type`, or `--checkpoint` are omitted, the publish script infers them from the HTML:

- Title: `<title>` first, then `<h1>`, then the file name.
- Type: inferred from title, path, and document text.
- Checkpoints: inferred from phase headings such as `阶段 0` / `阶段 1A`.
- Collection: explicit through `--collection`; the script writes artifact metadata and updates root `collection.json`.

Only use `--host 0.0.0.0` after the user explicitly wants LAN sharing and has accepted the privacy risk. Avoid LAN sharing without a token for artifacts that include source snippets, local paths, logs, customer data, credentials, or internal URLs.

## Layout Defaults

- Comparisons: equal-width columns on desktop, stacked sections on mobile, identical substructure per option, recommendation visible after the comparison.
- Plans: timeline/milestones, affected areas, data or control-flow diagram, risk table, validation checklist.
- Code reviews: finding list first, severity coloring, file anchors, line-focused notes, compact summary.
- Reports: executive conclusion first, evidence sections, timeline or matrix when chronology or tradeoffs matter.
- Editors: dominant work surface, prefilled user data, immediate validation, keyboard-friendly controls, export bar.
- Published artifacts: `index.html` for stable content, `artifact.json` for metadata, `state.json` for mutable checkpoints and notes.
- Collections: root `collection.json` groups multiple artifact ids into one project/topic and derives progress from child checkpoints.

## Guardrails

- Do not use HTML just to look fancy.
- Do not invent runtime data or screenshots.
- Do not use external fonts, CDNs, or image URLs unless there is a clear benefit.
- Do not bury the conclusion below a large hero section.
- Do not create an app when a static artifact is enough.
- Do not omit a Markdown/JSON export path for editors.
- Do not expose internal code, logs, paths, or business data on a network-bound artifact server without an explicit sharing decision.
