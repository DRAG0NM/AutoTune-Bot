# 完整AGNES仿真闭环证据

本目录以2026-10-15真实会话为主证据：`cedae5af-2686-4e75-bddb-f9079834f642`，373个连续事件，17组工具调用/返回、34组effect意图/结算、7/7正式runId覆盖。模型为agnes-3.0-flash。核心调用链依次为读取计划、自检、冻结计划、基线、反馈选参和执行、冻结最优、三项验证、生成报告。

```bash
npm run verify:submission
```

该命令先核对文件散列，再用本目录source中的冻结模拟器独立生成七轮状态轨迹并复算全量指标，最后配对模型的真实参数提议与工具返回。无需网络或API Key。

| 文件／目录 | 说明 |
|---|---|
| agh-session.jsonl | 官方export获得后精确脱敏的完整模型与工具事件；不把失败或被拒绝动作删去 |
| agh-completed.png | 网页完成截图，只作直观辅助，主证据采用JSONL |
| campaign/index.jsonl及CSV | 7轮原始记录，CSV字节和散列保留 |
| campaign/plan.json | 原冻结计划：4搜索+3验证 |
| campaign/artifacts/ | 原逐轮JSON、SVG和HTML |
| [批次HTML报告](campaign/reports/agnes-sim-acceptance-20261015/report.html) | 当前工具根据原CSV派生的便携报告，汇总JSON使用相对文件名；不是重新执行的AI实验 |
| source/ | 复现与源码身份核对所需的12个冻结文件，附ESM声明；不是当前运行入口 |
| manifest.json | 不可变输入、源码散列及脱敏方法；跨平台保留原字节 |
| environment.json与agh-effect-duration.patch | 原AGH提交、构建身份、模型标识、计时补丁；不含Key或账户凭据 |
| original-audit.json | 整理时原审核结果，当前可通过verify:submission复核 |

结果：四组搜索参数依次5/0.1/5、4/0/8、3.5/0/8、4/0/12；已测可行最优4/0/8是已知历史先验，本次复测而非从零发现。验证2/3通过，冲击虽恢复但整轮残差门未过，不声称全通过。

原会话发生过审批阻碍及TRANSPORT错误，并含错误因果解释和时间估计，记录完整保留。真实最后turn耗时395289ms；不能引用模型“4.5分钟、预算内”的错误文字。工具分项、时间措辞和验证前检查是在此后修正；当前工具离线测试通过，不代表已经在相同新版本上重跑模型或保证今后不再犯错。

原始未脱敏记录在私人档案。公开副本只做manifest所列精确替换，保留事件ID、序号、时间、试验数值和调用关联；冻结source文件不改写。新实验写runs，不覆盖这里。
