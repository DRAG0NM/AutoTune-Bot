---
name: pid-tuning
description: 自主调整现有二阶倒立摆仿真的离散PID，基于真实指标反馈并自动输出CSV、SVG和HTML报告。
---

# 仿真 PID 闭环

1. 确定总墙钟预算、最多轮数、目标，缺项一次询问。用户只说“开始”时按已经讨论的预算执行。新会话默认建议12搜索+3验证，不对每一轮重复提问。
2. `node bridge/cli.js selftest --json`。失败就定位工具问题，不开始搜索。`node bridge/cli.js params --json` 可读模型参数范围。
3. 从 `configs/simulation-plan.example.json` 复制计划到 `runs/plans/<唯一campaign>.json`，更改 campaign、maxSearch 和事先选好的验证工况；总轮数不得超预算。搜索默认 x0=3°、target=0、seed=20261008、durationMs=3000。单轮支持1–60模拟秒，控制周期固定10ms、采样50ms。长模拟不需要等待实际同等时长。
4. 运行基线，保存返回 JSON 的 runId。后续每次只提出一个候选，reason写明“上一轮的哪个指标/诊断→改哪个参数→预期效果”。不能一次排完参数再称为反馈调参。

```bash
node bridge/cli.js trial --backend sim --campaign CAMPAIGN --plan runs/plans/CAMPAIGN.json --purpose search --gains 'Kp=5,Ki=0.1,Kd=5' --reason '本次基线' --json
node bridge/cli.js trial --backend sim --campaign CAMPAIGN --plan runs/plans/CAMPAIGN.json --purpose search --parent PREVIOUS_RUN_ID --gains 'Kp=4,Ki=0,Kd=8' --reason '示例：基线振荡和积分残差，采用历史已知阻尼候选进行对照；非本次发现' --json
```

上例只是命令格式与先验示例，后续参数必须读取实际结果后决定。每轮显式传完整 Kp/Ki/Kd。核对返回 gains，确保实际执行不同于基线的参数。若返回参数不一致立即停止、保留证据；不把失败调用计为成功执行。

5. 按 `metrics.fail/converged/j` 与 `diagnostics` 分析。先避免摔倒/未收敛，再比较 J 和 `metrics.jContributions`；用 `dominantCostTerm` 说明最大加权贡献，禁止直接比较原始能量、毫秒和角度的数值大小。多参数同时变化的原因只写假设，不宣称已证明独立因果。只用同工况 search 排序。`j="Infinity"` 为失败代价，不能丢弃该轮。工具禁止重复相同参数和条件、跨源码/工况混合、parent断链、计划改变和超预算。
6. 至少实际执行一个不同参数候选后，才可以称为调参。不是为了凑“改善”随意调参；如果候选都更差，保留基线为本次最好并如实说明。连续3次无改善、搜索轮数或墙钟预算耗尽时结束搜索。每次调用前检查剩余预算，留足生成报告时间。
7. 冻结已测可行最优；按 plan.validation 逐条跑 `--purpose robustness`，同时显式传对应 `--seed/--x0/--dur/--disturb` 和同一组完整 gains。工具会在执行前拒绝未收敛或非最优参数，并禁止改变评价门槛，不要为通过验证放宽门槛。每次 parent 是整个 campaign 上一轮，不是冠军runId。验证后不回到搜索。验证失败不篡改搜索结果，单独说明适用边界。
8. `node bridge/cli.js report --campaign CAMPAIGN --json`。交付 `files.html`、`files.metricsCsv`、图表和 JSON 路径，并说明实际不同参数组数、变化是否执行、验证完成情况。不能保证全局最优。导出真实 AGNES 会话作为模型参与证据；工具产物不等于模型证明。

回放只读：`trial --backend replay --csv FILE --json`，不允许给回放附加待测 gains 或冒充模型新试验。状态变量缺失留空，不伪造。
