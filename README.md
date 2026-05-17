# HTML Artifact Deliverable

把较大的 AI 交付物发布成本地 HTML artifact 服务，便于查看、分享、阶段跟踪、评论评审和项目集管理。

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

Windows helper 会在 `-Lan` 时自动生成 token：

```powershell
.\scripts\start-artifact-server.ps1 -Lan
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
- `state.json`：状态、checkpoints、评论、历史记录等可变数据。
- `collection.json`：项目集定义，用于把多个 artifact 归为同一个主题。

## 端口占用

如果 `8787` 已被占用，服务会提示换端口：

```bash
node scripts/artifact-server.mjs --port 8788
```

也可以先关闭已有的 artifact server 进程后重试。
