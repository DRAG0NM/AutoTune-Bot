# AutoTune-Bot

通过 Agnes Harness 执行平衡车角度环 PID 实验：提出参数、运行试验、读取指标，再根据反馈选择下一组参数。主机工具使用 Node.js，支持仿真、CSV 回放和串口三个后端。

PID调参通常需要反复修改参数、运行试验和分析曲线，实验过程也容易缺少完整记录。AutoTune-Bot将这些步骤连接到Agnes Harness，让智能体根据反馈选择参数、执行多工况验证，并保存可复算的数据与决策过程。

目前已完成仿真搜索、压力场景验证及串口执行层的离线桩测试。实车固件和协议尚待现场验收；现有固件说明缺少 Stop/Start 确认，串口工具会在缺少确认时拒绝继续执行。

## 快速开始

需要 Node.js **24.10 或更高版本**。仿真、回放和测试没有必需的第三方依赖。

```bash
git clone https://github.com/DRAG0NM/AutoTune-Bot.git
cd AutoTune-Bot
node bridge/cli.js selftest --json
npm test

# 单次仿真
node bridge/cli.js trial --backend sim --gains "AngleKp=4,AngleKi=0,AngleKd=8" --json

# 回放附带的合成样例
node bridge/cli.js trial --backend replay --csv testdata/sample_step_response.csv --json

# 当前模型的固定网格扫描
node tools/scan.js --ki 0 --json
```

`selftest` 包含8个仿真样例和1个回放样例。`allPass=true` 表示预期断言全部通过，包含正确识别的失败与未收敛场景。`npm test` 运行68项回归测试，其中34项使用串口桩设备。

## 使用 Agnes

单次 `trial` 返回参数、运行标识、指标、诊断和源码身份。Agnes 通过 shell 工具调用 CLI；搜索方法定义在 [pid-tuning Skill](.agh/skills/pid-tuning/SKILL.md)。

1. 在 Agnes 中将工作区设为本项目目录，并确认它能读取 Skill、执行 Node 命令。
2. 先运行 selftest，再固定本次参数范围、搜索条件、预算和验证场景。
3. 每轮由 Agnes 选择参数并写明依据，读取完整返回结果后决定下一轮。
4. 冻结最佳可行候选后完成预定验证，保存 CSV、索引和会话记录。

仿真任务应明确要求 `--backend sim`。改变源码、模型或评价条件时使用新的 campaign，不混排不同版本的 J。完整方法见[实验协议](docs/experiment_protocol.md)。

## 结果与复现

保存的12批实验共110条运行记录，覆盖早期搜索、时序修正、压力模型和控制器对照，包含全部失败与未收敛结果。[验证报告](evidence/05_validation/report.md)说明条件与结论，[图表索引](evidence/05_validation/figures/README.md)列出15组图表。

### 自主搜索

D2-T中，Agnes分别完成6、10、12个参数试验，再对冻结候选执行6项预定验证。图中序号表示试验顺序，实心圆与空心三角分别表示收敛与未收敛，粗环标记各批最佳可行搜索点。

[![D2-T自主搜索轨迹与验证结果](evidence/05_validation/figures/d2-t-search-trajectories.png)](evidence/05_validation/figures/d2-t-search-trajectories.svg)

### 同条件控制器对照

D2-M2固定Kp/Ki/Kd=6/0.02/16、执行器滞后10ms和3秒窗口，以±20°初态及两个seed形成四组配对。蓝线为baseline，绿线为条件积分；曲线显示50ms采样的绝对角度误差。

[![D2-M2四组配对角度响应](evidence/05_validation/figures/d2-m2-response-traces.png)](evidence/05_validation/figures/d2-m2-response-traces.svg)

| 四组配对结果（含1组search及3组验证） | Baseline | 条件积分 |
|---|---:|---:|
| 收敛运行 | 0/4 | 4/4 |
| 平均J | 0.598025 | 0.483000 |
| 调节时间 | 2650–2700ms | 1700–1750ms |
| 积分抑制步数 / 300 | 0 | 11 |

该组匹配工况下平均J降低19.23%。[配对指标与条件说明](evidence/05_validation/report.md#d2-m2积分与饱和对照)给出分项结果和均值口径；[原始数据](evidence/05_validation/agnes-stage-d2-m2-conditional-integral-20261010/index.jsonl)保留参数、工况及每次运行标识。

### 全部验证结果

每行表示一个实验批次，每个圆点表示该批一项预定验证。右侧为收敛数/验证总数；case编号对应各批自身的验证顺序。

[![12批实验的验证收敛情况](evidence/05_validation/figures/campaign-validation-scorecard.png)](evidence/05_validation/figures/campaign-validation-scorecard.svg)

[查看全部15组图表](evidence/05_validation/figures/README.md#图表预览)：参数网格、初期搜索、压力诊断、未收敛判据及积分/饱和统计。

### 复算

```bash
npm run verify:evidence
npm run verify:history
npm run audit:sessions
npm run plot:evidence
```

历史模型放在 `evidence/versions/`，只用于复现已有结果。它们保留原执行逻辑，发布散列与原快照映射见[版本说明](evidence/versions/README.md)。当前模型的扫描结果不要求与早期模型相同。

## 结构

| 目录 | 内容 |
|---|---|
| `bridge/` | CLI、协议、指标、记录存储及三个后端 |
| `.agh/skills/pid-tuning/` | Agnes 搜索与验证方法 |
| `configs/` | 主机配置、压力场景和实验计划 |
| `test/`、`testdata/` | 回归测试与合成回放样例 |
| `tools/` | 网格扫描、诊断、证据核验及制图 |
| `firmware/` | STM32 接口改造说明 |
| `evidence/` | 实验数据、图表、历史模型与会话审计 |
| `runs/`、`state/` | 本机生成的运行记录和参数状态，默认不入库 |

## 文档

- [架构与设计](docs/architecture.md)
- [指标与代价函数](docs/metrics.md)
- [串口执行与设备协议](docs/serial.md)
- [配置与排错](docs/troubleshooting.md)
- [开发和贡献](CONTRIBUTING.md)

## 来源与许可

Agnes Harness 是独立的智能体运行底座，见 [AgnesAI-Labs/agnes-harness](https://github.com/AgnesAI-Labs/agnes-harness)。本仓库不包含 AGH 本体或其本机修补。

固件接口说明基于江协科技平衡车课程的09版工程，见 [firmware/README.md](firmware/README.md)。第三方固件工程未随仓库分发。开发过程中使用了 AI 编码与审查工具；保存的自主搜索记录来自 Agnes 会话，固定网格及方法探索由本机脚本执行，来源在数据说明中分别标记。

本项目用于2026年江苏省高校 AI+科学与工程创新实践黑客松。项目代码采用 [Apache-2.0](LICENSE)；第三方材料适用各自许可。
