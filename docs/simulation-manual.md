# 使用仿真 PID AI 助手

在 PowerShell 启动 WSL 中已安装的 AGNES 网页端：

```powershell
& 'D:\Stranger_things\hacksong\autotune-public\启动调参助手.ps1'
```

入口读取本项目 agent.md、Skill、手册全文并用 UTF-8 注入独立新会话，再打开 `http://127.0.0.1:4177/?session=...`。不是自动系统提示词注入，也不会复用旧实车会话。默认 WSL 发行版 Ubuntu-24.04，AGH 位于 `/home/drag0nm/agh/packages/cli/dist/local/agnes.mjs`；可用 `-Distro/-AghCli/-Profile/-Port` 覆盖。`-CheckOnly` 只检查文件和版本。后台已有合法网页服务时复用服务，新建会话；端口被无关服务占用时拒绝注入。

脚本始终以自身所在目录为项目根目录，不依赖当前PowerShell工作目录。更换安装位置时，直接运行新位置的根目录脚本。例如：`& '.\启动调参助手.ps1' -Distro Ubuntu-24.04 -AghCli '/home/你的用户名/agh/packages/cli/dist/local/agnes.mjs'`。

建议回答：“总共10分钟，最多15轮（搜索12+验证3），先恢复稳定再降低超调和控制量。你自主完成，生成CSV和图表。”之后 AGNES 自主执行，不需要每轮确认。墙钟预算与模拟时长不同，单轮3秒仿真通常很快；长时观察可在冻结计划前指定30或60模拟秒。

AGH框架可能另外请求工具执行审批；这是运行平台权限界面，项目不会自动修改全局权限。一开始的一次性初始化故意不调用工具；实际调参在网页继续。框架网络错误不算仿真失败，自动拒绝也不应被描述为用户亲自拒绝。

## 工具和产物

要求 Node.js >=24.10，无第三方运行依赖。

```bash
node bridge/cli.js selftest --json
node bridge/cli.js trial --backend sim --gains 'Kp=4,Ki=0,Kd=8' --json
node bridge/cli.js runs --json
node bridge/cli.js report --campaign YOUR_CAMPAIGN --json
npm run demo
```

`demo` 是固定参数的工具验证，不是 AI 自主调参。正式 AI 证据应包含真实会话、先后决策理由和对应工具输出。AGNES 不必写搜索脚本；CLI 已负责采集、指标和报告，避免模型长时间重造工具。

每轮保存 `runs/*.csv`、`runs/index.jsonl` 和 `runs/artifacts/<runId>/` 中的记录JSON、角度响应、控制量、相轨迹SVG及HTML。CSV列：ms（毫秒）、angle/target（度）、angularVelocity（度/秒）、out/appliedOut（归一化控制）、errInt（逐控制步误差累计）。回放缺少的可选物理状态列留空。汇总报告在 `runs/reports/<campaign>/`：metrics.csv、summary.json、objective-history.svg、pid-history.svg、report.html。报告生成时核对原始CSV散列并复算指标。

## 模型与评价

沿用既有非线性二阶单倒立摆，不是双摆。状态为θ和ω，内部弧度制；θ=0倒立，默认初始3°、初速度0。半隐式欧拉步长10ms，采样50ms；角度超过50°提前终止并保留末端失败证据。

`θ''=(9.81/0.15)sinθ−(20/DEG)·controlScale·u_applied·cosθ−4.3·dampingScale·θ'`，`DEG=180/π`。控制方向、离散PID与数值模型参见 `bridge/backends/sim.js` 和 `bridge/lib/sim-controller.js`；积分为逐步求和、微分为测量差，不按dt归一化。Kp/Ki/Kd不是连续PID单位，范围分别0–20/0–5/0–20。模型支持噪声、死区、执行器滞后、测量延迟、控制/阻尼缩放以及角速度冲击，用于数值压力测试，不代表已辨识真实设备。

默认容差为初始偏差2%与0.1°的较大者，末尾持续在带内至少300ms，且超调≤30%、稳态误差在带内，才判收敛。J为超调、调节时间、稳态误差、控制能量代理的归一化加权和（0.4/0.3/0.2/0.1），越低越好。失败J为Infinity，未收敛也不得参加可行冠军排序。能量只是控制平方积分，不是焦耳。

默认历史先验4/0/8在默认工况收敛，J=0.149；默认5/0.1/5未收敛。不得把历史先验直接称为本次自主发现。改变目标/时长/扰动/评价配置就改变比较问题；同一搜索campaign不能混用。

工具直接输出J的各加权分项 `jContributions` 及最大项 `dominantCostTerm`，减少模型心算和量纲混淆。扰动恢复成功不必然等于整轮收敛：后者还约束末段均值误差和超调。验证未全过必须明确显示，不能用“恢复成功”替代全部门槛。

冻结plan限制搜索预算、范围和验证工况；parent连接每次执行，CSV与源码散列用于复核。验证轮只衡量冻结候选的外推表现，不与搜索轮混排。图表和工具日志证明执行，不能独立证明AI参与。

验证入口会在运行前确认参数就是当前已测可行最优，并禁止改变评价门槛；不能把未收敛候选送去验证再等报告拒绝。报告逐字段复算指标，包括振荡次数及已有的J分项，兼容没有新增分项字段的旧记录。
