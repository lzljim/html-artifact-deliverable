# HTML Artifact Deliverable

把较大的 AI 交付物发布成本地 HTML artifact 服务，便于查看、分享、阶段跟踪、个人备注和项目集管理。

## 安装

```bash
npm install
```

## 启动

本机访问：

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:8787
```

开发模式会在脚本变更后自动重启：

```bash
npm run dev
```

Windows 可以用 helper：

```powershell
.\scripts\start-artifact-server.ps1
```

## 局域网分享

局域网访问建议启用 token：

```bash
node scripts/artifact-server.mjs --host 0.0.0.0 --token <share-token>
```

如果只希望同事查看和导出，不希望他们误改状态，可以额外配置只读 token：

```bash
node scripts/artifact-server.mjs --host 0.0.0.0 --token <edit-token> --read-token <view-token>
```

`<edit-token>` 可以查看和修改，`<view-token>` 只能访问页面、文件、Markdown 报告和迁移包导出，不能写入 `state.json`。

Windows helper 会在 `-Lan` 时自动生成 token：

```powershell
.\scripts\start-artifact-server.ps1 -Lan
.\scripts\start-artifact-server.ps1 -Lan -Token <edit-token> -ReadToken <view-token>
```

启动后终端会打印 loopback URL、LAN URL、健康检查地址和安全提示。只把带 token 的 URL 发给可信同事。

不要在未启用 token 的局域网服务里分享包含源码片段、本地路径、日志、客户数据、凭据或内部 URL 的 artifact。

## 健康检查

```bash
curl http://127.0.0.1:8787/api/health
```

启用 token 时：

```bash
curl "http://127.0.0.1:8787/api/health?token=<share-token>"
```

返回内容包含服务状态、artifact root、artifact 数量和 collection 数量。

## 发布 HTML

```bash
node scripts/publish-artifact.mjs --html docs/ai/plan.html
```

指定标题、类型、标签和阶段：

```bash
node scripts/publish-artifact.mjs --html report.html --title "方案评审" --type code-review --tag review --checkpoint review:评审完成
```

发布到项目集：

```bash
node scripts/publish-artifact.mjs --html report.html --collection metadata-upgrade:"Metadata Upgrade"
```

发布脚本会复制 HTML 到 artifact root，写入 `artifact.json` / `state.json`，并输出可直接打开的本机 URL。使用 `--server-host 0.0.0.0 --server-token <token>` 时，也会输出 LAN URL。

## 常用命令

```bash
npm run check
```

`npm run check` 会执行语法检查和 `node:test` 回归用例。提交服务或发布脚本改动前请先运行。

## 状态、归档和导出

详情页可以修改状态、勾选 checkpoints、保存阶段备注、记录个人备注，并复制或下载当前状态报告。首页按个人任务中枢组织 artifact，用来快速判断当前重点、最近继续、阻塞/待处理和可收尾内容。

- `archived` 状态表示已归档。归档 artifact 默认不出现在工作台搜索结果里，但直接 URL、项目集和显式“包含归档 / 只看归档”筛选仍可访问。
- 个人任务中枢固定展示“当前重点”“常用资料”“最近继续”“阻塞/待处理”“可收尾/可归档”。
- Artifact 卡片提供置顶、稍后、设为资料、完成、归档、快速备注和新增阶段等个人快捷动作。
- Artifact 卡片和项目集卡片会显示未处理备注、风险、待办和最近备注，减少逐个打开页面查看的成本。
- 交付物列表默认按工作状态优先展示：阻塞、进行中、草稿在前，已完成和已归档在后；排序下拉只影响每个状态组内部的顺序。
- 项目集会派生健康状态：正常、有风险、阻塞；首页提供项目集进度矩阵，按 artifact 行展示阶段完成情况和风险/备注标记。
- 项目集可按最近更新、健康状态、完成率、阻塞数、未处理备注排序，方便先处理最需要推进的项目集。
- 报告中心可以复制项目集周报和全局报告，使用个人待办/风险措辞，不再提供协作型 Review 摘要。
- `GET /api/artifacts/<id>/markdown` 会从 `state.json` 生成可贴到周报或个人记录的 Markdown 状态报告。
- `GET /api/artifacts/<id>/export` 会导出包含 `artifact.json` 视图、`state.json` 和 `index.html` 内容的 JSON 迁移包。
- 首页右上角“导出全部”会请求 `GET /api/export`，一次性导出 `collection.json` 和所有 artifact 的 HTML、元数据、状态。
- 首页右上角“导入全部”可以选择上述 JSON 包，写入当前 artifact root。只读 token 不能导入。

在另一台机器恢复全部 artifact：

```bash
node scripts/import-artifact-bundle.mjs --bundle html-artifacts-2026-05-17.json
```

目标目录默认是 `~/.codex/html-artifacts`，也可以通过 `--root <artifact-root>` 指定。若目标机器已有同名 artifact，脚本默认停止，确认要替换时再加 `--overwrite`。

## 目录结构

```text
~/.codex/html-artifacts/
  collection.json
  artifact-id/
    index.html
    artifact.json
    state.json
```

- `index.html`：原始 HTML artifact 副本。
- `artifact.json`：标题、类型、标签、来源、项目集等稳定元数据。
- `state.json`：状态、checkpoints、个人备注、历史记录等可变数据。
- `collection.json`：项目集定义，用于把多个 artifact 归为同一个主题。

## 端口占用

如果 `8787` 已被占用，服务会提示换端口：

```bash
node scripts/artifact-server.mjs --port 8788
```

也可以先关闭已有的 artifact server 进程后重试。
