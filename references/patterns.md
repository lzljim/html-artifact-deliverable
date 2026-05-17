# HTML Artifact Patterns

Load only the section that matches the current request.

## Comparison Or Option Study

Best for方案对比、技术选型、实现路线评估。

Required structure:

- One panel per option with the same internal headings.
- Metrics row: complexity, risk, verification cost, maintenance cost, or other domain-specific measures.
- Pros/cons as a table, not loose bullets.
- A final recommendation that actually chooses one option unless the user explicitly asks not to decide.

Avoid:

- Three options that are only tiny variants of the same approach.
- Long prose before the comparison.
- Different criteria per option.

## Implementation Plan

Best for需要交给人或另一个 agent 执行的计划。

Required structure:

- Problem and target outcome.
- Milestone strip or timeline.
- Affected areas grouped by component, not a flat file dump.
- Data flow, call flow, or dependency diagram when more than two components are involved.
- Risk table and validation checklist.
- Explicit non-goals.

Avoid:

- Only copying a Markdown task list into HTML.
- Listing every touched file without explaining the shape of the change.
- Hiding verification at the end as an afterthought.

## Code Review Or PR Writeup

Best for审查、PR 描述、变更讲解。

Required structure:

- Findings first, sorted by severity.
- File anchors and line references when available.
- Short change map grouped by theme.
- Risk and test evidence.
- Review focus section for PR writeups.

Avoid:

- Reprinting huge diffs without annotation.
- Mixing praise, questions, and blocking issues in one undifferentiated list.
- Making visual styling more prominent than the findings.

## Architecture Or Flow Explainer

Best for模块地图、渲染流程、请求链路、升级链路。

Required structure:

- One-sentence system summary.
- Diagram or flow lane showing entry points, hot path, and extension points.
- Per-module notes: responsibility, important types/functions, known pitfalls.
- A realistic input or scenario traced through the flow.

Avoid:

- Drawing every edge in the codebase.
- Treating generated API docs as an explainer.
- Leaving suspicious points unlabeled as confirmed or unconfirmed.

## Report Or Research Brief

Best for调查报告、趋势研究、故障复盘、学习材料。

Required structure:

- Conclusion first.
- Evidence table with sources, dates, and confidence.
- Timeline if recency matters.
- Decision matrix when recommendations are being made.
- Clear next actions.

Avoid:

- A blog-post style essay when the user needs decisions.
- Overquoting sources.
- Mixing confirmed facts with inference without labels.

## One-Off Editor

Best for分拣、排序、打标、配置开关、prompt 调参、数据集清洗。

Required structure:

- Prefill the data from the prompt or local files.
- Show the main work area immediately.
- Use natural controls: drag/drop for ordering, toggles for booleans, selects for enums, sliders/inputs for values.
- Show live validation or counts.
- Provide a final export: copy Markdown, copy JSON, copy prompt, download CSV, or copy config diff.

Avoid:

- Generic productivity apps.
- Editors without export.
- Server dependencies.
- Requiring the user to paste the same data twice.
