# 历史仿真证据（只读）

保留2026-10-10至11的仿真CSV、指标、计划、冻结数值模块和真实AGNES会话。当前报告格式新增真实状态列，旧CSV保持原样，包括当时合成的spdL/spdR；这些旧列不是物理轮速证据，当前仿真已不输出它们。

`05_validation/`：历史数值实验；`01_agh/`：模型参与会话；`versions/`：复核时使用的原版本模块和散列。运行 `npm run verify:history` / `npm run verify:evidence` / `npm run audit:sessions` 复核。

当前新试验写runs，不修改此处。旧实车证据已转入私人归档，不作为本项目仿真调优证据。
