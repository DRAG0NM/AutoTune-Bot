# PID AI · 二阶倒立摆仿真调参助手

AGNES 根据仿真反馈自主调整 PID：询问预算和目标 → 运行基线 → 分析响应 → 选择并实际执行新参数 → 冻结候选做验证 → 自动生成 CSV、指标图表和报告。

沿用项目已有的非线性二阶单倒立摆（θ/ω）及离散 PID。当前项目仅包含仿真与CSV回放。

[项目说明与实测结果](docs/project-description.md) · [从零复现](docs/reproduce.md) · [来源及AI辅助披露](docs/sources-and-ai.md) · [赛事材料对照](docs/submission-checklist.md)

## 快速开始

Node.js >=24.10，无第三方运行依赖：

Windows 网页入口位于项目根目录，使用 PowerShell 7，需要 WSL 中已安装的 AGNES Harness：

```powershell
& '.\启动调参助手.ps1'
```

自动打开 AGNES 网页端，注入本项目 agent.md、Skill 和使用手册。默认地址4177；在新会话给出时间、轮数和目标，即可开始自主仿真调参。发行版和 AGH 安装路径可通过启动参数指定，详见 [使用手册](docs/simulation-manual.md)。首次初始化会请求模型回复；框架的工具执行授权按网页提示处理。

跨平台工具自检与固定演示：

```bash
npm test
npm run selftest
npm run demo
npm run verify:submission
```

`demo` 使用固定参数验证工具和产物，不算AI自主调参。模型参与需真实AGNES会话佐证。已有历史先验会公开说明，不包装成新发现。

随项目提供的完整AGNES仿真证据包含373个连续事件、7次真实试验、4组不同搜索参数。基线5/0.1/5未收敛，采用历史先验4/0/8后收敛，J从0.7235变为0.149；其余两个候选未超过该先验。三个验证场景通过2/3，未通过的扰动整轮指标完整保留。`verify:submission`离线复现七轮轨迹并匹配模型调用链，无需API Key。详见[本次证据索引](evidence/07_simulation-release-20261015/README.md)。

[模型能力验证图集](#模型能力验证历史仿真闭环) · [项目输出结果图集](#项目输出结果本次工具生成)

## 自动产物

- 每轮：原始状态CSV、指标与诊断JSON、角度响应/控制量/相轨迹SVG、可离线打开HTML。
- 每批：全部成功及失败轮的metrics.csv、PID变化图、目标值变化图、汇总JSON/HTML。
- 审计：冻结计划、逐轮决策理由与parent链、源码和CSV散列；生成报告时复算指标。

```bash
node bridge/cli.js trial --backend sim --gains 'Kp=4,Ki=0,Kd=8' --dur 3000 --json
node bridge/cli.js report --campaign YOUR_CAMPAIGN --json
```

默认模拟3秒；可选1–60秒，每10ms一步。模拟时长与AGNES思考耗时分别计算。长时长会改变评价，必须在实验计划中统一。

## 项目结构

| 路径 | 内容 |
|---|---|
| `bridge/` | 仿真、回放、PID、指标、报告CLI |
| `agent.md` / `.agh/skills/pid-tuning/` | 助手行为与闭环工作流 |
| `configs/` | 模型压力配置、冻结计划示例与历史仿真计划 |
| `启动调参助手.ps1` | Windows网页启动入口 |
| `tools/` | 网页初始化辅助、工具演示、历史证据复核 |
| `runs/` | 当前轮次CSV、JSON、SVG、HTML及计划 |
| `evidence/` | 保留的历史仿真与真实AGNES会话证据 |
| `test/` | 数值模型、工具、报告及启动入口测试 |

仿真不是物理设备验证；不承诺全局最优。模型、控制单位、收敛门槛和代价函数见手册。旧设备路线已退休，不参与当前助手流程。

## 模型能力验证：历史仿真闭环

以下15组图来自仓库原有的2026-10-10仿真数据。12批实验共110条运行记录；自主搜索、固定参数对照和脚本网格分别标注。图表保留成功与未通过结果，用于展示反馈选参、独立验证和失败分析的过程。

模型参与以[AGH会话记录](evidence/01_agh/README.md)和[会话审计](evidence/01_agh/session-audit.json)为依据，图本身不能单独证明模型参与。8份历史导出满足完整性检查；M2两份导出不完整，只能提供有限交互证据。不同阶段的模型、目标及评价口径不同，J不跨批直接排名。详细来源见[验证报告](evidence/05_validation/report.md)与[15组图表索引](evidence/05_validation/figures/README.md)。

展开下方图集即可在本README查看全部图表；历史图使用PNG预览，点击打开同源SVG。

<details open>
<summary>D2-T 自主搜索与候选选择</summary>

三种控制器的逐轮搜索及独立验证；实际搜索轮数不同。

[![D2-T 自主搜索与候选选择](evidence/05_validation/figures/d2-t-search-trajectories.png)](evidence/05_validation/figures/d2-t-search-trajectories.svg)

</details>

<details>
<summary>Stage A 搜索遥测</summary>

6条搜索的角度、控制命令、积分及J。

[![Stage A 搜索遥测](evidence/05_validation/agnes-stage-a-20261010/search-traces.png)](evidence/05_validation/agnes-stage-a-20261010/search-traces.svg)

</details>

<details>
<summary>Stage B 搜索遥测</summary>

4条搜索，采用时序修正后的模型。

[![Stage B 搜索遥测](evidence/05_validation/agnes-stage-b-20261010/search-traces.png)](evidence/05_validation/agnes-stage-b-20261010/search-traces.svg)

</details>

<details>
<summary>Stage C 搜索遥测</summary>

4条压力模型搜索。

[![Stage C 搜索遥测](evidence/05_validation/agnes-stage-c-20261010/search-traces.png)](evidence/05_validation/agnes-stage-c-20261010/search-traces.svg)

</details>

<details>
<summary>早期及 A–C 搜索轨迹</summary>

各面板独立评价，不按跨模型J变化排名。

[![早期及 A–C 搜索轨迹](evidence/05_validation/figures/early-search-trajectories.png)](evidence/05_validation/figures/early-search-trajectories.svg)

</details>

<details open>
<summary>12批验证收敛总览</summary>

包含固定参数对照与未通过场景；不是12批全部自主搜索成功。

[![12批验证收敛总览](evidence/05_validation/figures/campaign-validation-scorecard.png)](evidence/05_validation/figures/campaign-validation-scorecard.svg)

</details>

<details>
<summary>先期与 A–C 验证诊断</summary>

恢复、峰值、误差积分和控制命令平方积分。

[![先期与 A–C 验证诊断](evidence/05_validation/figures/abc-validation-diagnostics.png)](evidence/05_validation/figures/abc-validation-diagnostics.svg)

</details>

<details>
<summary>D2-T 压力验证诊断</summary>

18条压力验证；保留微分滤波末条未过门的结果。

[![D2-T 压力验证诊断](evidence/05_validation/figures/d2-t-pressure-diagnostics.png)](evidence/05_validation/figures/d2-t-pressure-diagnostics.svg)

</details>

<details>
<summary>原 D 未收敛判据</summary>

固定参数对照，18条未收敛记录均保留。

[![原 D 未收敛判据](evidence/05_validation/figures/stage-d-criterion-breakdown.png)](evidence/05_validation/figures/stage-d-criterion-breakdown.svg)

</details>

<details>
<summary>D2-M2 配对响应</summary>

固定参数、四组同工况控制器对照；M2模型会话导出不完整。

[![D2-M2 配对响应](evidence/05_validation/figures/d2-m2-response-traces.png)](evidence/05_validation/figures/d2-m2-response-traces.svg)

</details>

<details>
<summary>D2-M2 配对指标</summary>

同参数及同工况下的性能比较，不当作自主选参成果。

[![D2-M2 配对指标](evidence/05_validation/figures/d2-m2-paired-metrics.png)](evidence/05_validation/figures/d2-m2-paired-metrics.svg)

</details>

<details>
<summary>D2-M2 积分与饱和</summary>

展示机制实际触发；M2数值可复核，但交互证据不完整。

[![D2-M2 积分与饱和](evidence/05_validation/figures/d2-m2-integral-saturation.png)](evidence/05_validation/figures/d2-m2-integral-saturation.svg)

</details>

<details>
<summary>Ki=0 固定网格热图</summary>

36点脚本网格，提供搜索先验；不是模型自主搜索。

[![Ki=0 固定网格热图](evidence/05_validation/figures/grid-v23-ki0-heatmap.png)](evidence/05_validation/figures/grid-v23-ki0-heatmap.svg)

</details>

<details>
<summary>selftest 正常、边界与失败样例</summary>

9个预设工具行为样例；自检通过与控制收敛分别解释。

[![selftest 正常、边界与失败样例](evidence/05_validation/figures/selftest-v23-outcomes.png)](evidence/05_validation/figures/selftest-v23-outcomes.svg)

</details>

<details>
<summary>D2 本机方法探索</summary>

162点脚本实验，用于机制和工况选择；不是模型自主搜索。

[![D2 本机方法探索](evidence/05_validation/figures/d2-method-exploration.png)](evidence/05_validation/figures/d2-method-exploration.svg)

</details>

## 项目输出结果：本次工具生成

以下为本次整理中使用项目报告工具生成或保留的实际输出：2张批次图、七轮试验各3张单轮图，以及真实AGH完成截图。图表读取同一批真实会话CSV，不增加试验数；便携批次报告由当前工具派生，逐轮图保留原始产物。这里展示自动生成CSV、SVG、HTML的能力，并与上面的历史模型能力验证分开展示。

本批真实会话由agnes-3.0-flash执行4次搜索与3次冻结参数验证。4/0/8是已知先验，其他候选未超过它；三个验证场景仅2/3收敛。未通过结果完整展示。[七轮CSV与指标](evidence/07_simulation-release-20261015/campaign/index.jsonl) · [完整HTML报告](evidence/07_simulation-release-20261015/campaign/reports/agnes-sim-acceptance-20261015/report.html) · [证据及离线复核](evidence/07_simulation-release-20261015/README.md)

### 批次输出

![实际执行的PID参数变化](evidence/07_simulation-release-20261015/campaign/reports/agnes-sim-acceptance-20261015/pid-history.svg)

![搜索与验证目标值变化，保留未收敛轮次](evidence/07_simulation-release-20261015/campaign/reports/agnes-sim-acceptance-20261015/objective-history.svg)

### 单轮输出（七轮完整图集）

每轮都展示角度响应、控制量与相轨迹；具体模型、单位及指标定义见[仿真手册](docs/simulation-manual.md)。

<details>
<summary>搜索1：初始基线 · 5/0.1/5 · J=0.7235 · 未收敛</summary>

![搜索1：初始基线：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/0db44080-7dcc-45eb-97cc-5d9c4abf374d/response.svg)

![搜索1：初始基线：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/0db44080-7dcc-45eb-97cc-5d9c4abf374d/control.svg)

![搜索1：初始基线：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/0db44080-7dcc-45eb-97cc-5d9c4abf374d/phase.svg)

</details>

<details open>
<summary>搜索2：已知先验复测 · 4/0/8 · J=0.149 · 收敛</summary>

![搜索2：已知先验复测：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/fdd939a6-694e-41c9-8fcd-736ef5b1e1da/response.svg)

![搜索2：已知先验复测：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/fdd939a6-694e-41c9-8fcd-736ef5b1e1da/control.svg)

![搜索2：已知先验复测：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/fdd939a6-694e-41c9-8fcd-736ef5b1e1da/phase.svg)

</details>

<details>
<summary>搜索3：降低Kp · 3.5/0/8 · J=0.3251 · 未收敛</summary>

![搜索3：降低Kp：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/8628f5a8-3b75-4fbe-a626-4a0768ca99ca/response.svg)

![搜索3：降低Kp：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/8628f5a8-3b75-4fbe-a626-4a0768ca99ca/control.svg)

![搜索3：降低Kp：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/8628f5a8-3b75-4fbe-a626-4a0768ca99ca/phase.svg)

</details>

<details>
<summary>搜索4：提高Kd · 4/0/12 · J=0.1669 · 收敛</summary>

![搜索4：提高Kd：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/027bddc3-43d0-4e67-874f-3148cbabdda2/response.svg)

![搜索4：提高Kd：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/027bddc3-43d0-4e67-874f-3148cbabdda2/control.svg)

![搜索4：提高Kd：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/027bddc3-43d0-4e67-874f-3148cbabdda2/phase.svg)

</details>

<details>
<summary>验证1：更换seed · 4/0/8 · J=0.1531 · 收敛</summary>

![验证1：更换seed：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/15820bee-bf85-4054-ac86-24783423e25e/response.svg)

![验证1：更换seed：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/15820bee-bf85-4054-ac86-24783423e25e/control.svg)

![验证1：更换seed：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/15820bee-bf85-4054-ac86-24783423e25e/phase.svg)

</details>

<details>
<summary>验证2：负向初态 · 4/0/8 · J=0.1526 · 收敛</summary>

![验证2：负向初态：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/94d9c382-f244-4017-adc8-cc653e229aba/response.svg)

![验证2：负向初态：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/94d9c382-f244-4017-adc8-cc653e229aba/control.svg)

![验证2：负向初态：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/94d9c382-f244-4017-adc8-cc653e229aba/phase.svg)

</details>

<details>
<summary>验证3：角速度冲量（未收敛） · 4/0/8 · J=0.3265 · 未收敛</summary>

![验证3：角速度冲量（未收敛）：角度响应](evidence/07_simulation-release-20261015/campaign/artifacts/9da158d9-c853-420c-8132-e9dc867009bf/response.svg)

![验证3：角速度冲量（未收敛）：控制量](evidence/07_simulation-release-20261015/campaign/artifacts/9da158d9-c853-420c-8132-e9dc867009bf/control.svg)

![验证3：角速度冲量（未收敛）：相轨迹](evidence/07_simulation-release-20261015/campaign/artifacts/9da158d9-c853-420c-8132-e9dc867009bf/phase.svg)

</details>

<details>
<summary>真实AGH会话完成截图</summary>

截图只用于直观展示；模型调用、反馈顺序和实际执行参数以完整JSONL及离线校验为准。

![真实AGH会话完成截图](evidence/07_simulation-release-20261015/agh-completed.png)

</details>

复核历史数值与本批实际执行链：

```bash
npm run verify:evidence
npm run verify:history
npm run audit:sessions
npm run verify:submission
```
