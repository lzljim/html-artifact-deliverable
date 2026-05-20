# Stage 5: 详情页个人推进提效

## 问题与目标

Stage 5 不再扩展多人 Review 工作流。目标是把首页、项目集、报告和详情页从协作型 Review 语义收回到个人使用：保留备注、待办、风险、处理/重新打开、阶段推进和常用资料入口。

## 验收标准

- 首页不再展示 Review Dashboard、Review 筛选、待办 / Review 队列、复制 Review 或 PR Review 摘要。
- 详情页展示“个人备注”，不再展示负责人、截止日期、严重度、Review 状态等协作字段。
- 新增备注只写文本、分类、关联 checkpoint、处理状态相关字段；旧 notes 中已有 Review 字段继续兼容读取。
- 项目集健康只表达正常、有风险、阻塞；报告中心保留项目集周报和全局报告。
- `npm run check` 通过，并完成首页与详情页浏览器验证。

## 不做范围

- 不删除磁盘上已有 notes 历史。
- 不迁移到 SQLite。
- 不引入前端构建链路。
- 不新增复杂内容类型或多人协作模型。

## Review Slices

1. `done` 首页、项目集和报告去协作化。
2. `done` 详情页个人备注和个人推进动作。
3. `done` 兼容旧 notes 字段，同时避免新备注生成协作字段。
4. `done` 测试、文档和 roadmap checkpoint 更新。
5. `done` 本地检查、浏览器验证、提交并推送。

## 验证计划

- `npm run check`
- 启动 LAN token 服务。
- 浏览器验证首页无 Review Dashboard/PR Review 入口。
- 浏览器打开详情页，验证个人备注表单和常用资料按钮。
