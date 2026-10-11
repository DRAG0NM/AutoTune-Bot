# 实验与验证材料

`05_validation/` 保存12批110条运行记录、36点初期网格、162点方法探索及15组图表。`06_testcases/` 保存软件测试与各阶段selftest结果。`01_agh/` 保存脱敏会话与审计资料。`versions/` 提供历史复现所需模拟器和评价实现。

运行 `npm run verify:evidence`、`npm run verify:history` 和 `npm run audit:sessions` 可分别核验数值、重现模型输出和检查会话事件。数据方法与结论见[验证报告](05_validation/report.md)。

CSV内容保持原样；会话中的本机路径、用户标识、凭据、账号路由及上游请求追踪标识已脱敏，事件顺序与实验关联标识保留。具体范围见[会话说明](01_agh/README.md)。版本说明列出发布模块与历史快照的对应关系。
