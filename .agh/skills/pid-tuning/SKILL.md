---
name: pid-tuning
description: 通过 PID-Bridge 读取真实指标、逐轮决定参数，区分仿真探索与须单独授权的实车实验。
---

# 任务范围与入口

只调角度环 `AngleKp / AngleKi / AngleKd`。先读本文件、`docs/experiment_protocol.md` 和 `configs/bridge.example.json`，再运行 `node bridge/cli.js selftest --json`。仅在 `allPass=true` 时进入试验。

## Agnes 运行预检与版本证据

正式闭环试验前记录实际运行的 AGH CLI 路径、`--version` 输出、AGH 源码 commit 与工作区是否有改动；`agh 0.0.0` 不是可复现的版本号。分别运行 `doctor platform --json`、`doctor profile --json`、`doctor storage --json`、`doctor daemon --json` 并保存原始 JSON 与退出码。若当前 AGH 支持 `doctor credentials --json`，也运行并保存；旧版不支持时记录 `unsupported`，不要因此阻断 sim。只把会影响本次 workspace、Skill、shell 工具或会话持久化的 fail 视为阻断项；无关能力的 warn/fail 原样记录，不推断成 PID 仿真故障。

开始搜索前导出会话记录，保存 `session/start` 的 Agnes 版本、模型、preset 与可用的 resolved preset/profile hash。字段缺失时记为版本能力差异，不能补猜。结束后核对 `effect/intent` 与 `effect/settled` 按 effectId 配对、settled 数量相符且 `durationMs` 是非负整数；异常事件不应算作成功完成的自主闭环。保留原始 JSONL，另在审计摘要中列出缺失字段和异常计数。

用户要求 sim 时，每次试验必须显式 `--backend sim`；禁止 serial、ports、set、start、stop、rollback，也不安装串口依赖、不改固件、不写 state。仿真失败只能记录并选下一组，不能调用硬件回滚。自检中的纯协议编码检查不操作设备。

# 仿真自主搜索

1. 确认项目路径与 Node 版本。建立本次唯一 campaign，读取历史索引以区别已知先验与新实验；selftest 已公开正常参数样例，不能声称盲搜发现。
2. 固定搜索工况：target=0、x0=3、duration=3000ms、seed=20261008。参数范围和预算由用户任务指定；未指定时 Kp∈[2,8]、Ki∈{0,0.02,0.05}、Kd∈[2,16]，最多 12 次搜索，另最多 3 次鲁棒性检查。不得重复相同参数与工况，除非一次专门的可复现性检查且说明原因。
3. 每次先写一句理由，再调用一次 trial；返回后读完整 JSON 的 fail、converged、J、overshoot、settlingMs、ssErr、energy、osc。根据结果决定下一组；不得预写结果、调用网格代替智能体逐轮决策、并行启动试验。
4. 每轮显式传三个 gains 与 `--campaign`、`--purpose search`、`--reason`；首轮无 parent，后续用上一轮 runId 的 `--parent`。示意：

```bash
node bridge/cli.js trial --backend sim --gains "AngleKp=<自己决定>,AngleKi=<自己决定>,AngleKd=<自己决定>" --dur 3000 --target 0 --x0 3 --seed 20261008 --campaign <本次标识> --purpose search --reason "<依据>" --parent <上一轮runId> --json
```

5. `fail=true` 或 `converged=false` 都不能成为最优候选；后者即便 J 有限也不可行。选已测收敛候选中 J 最小者。连续 3 个新点无改善可提前停止；没有可行点就明确报告没有最优参数。
6. 搜索结束固定候选，在不同 seed、负向 x0 或扰动下最多做 3 次 `--purpose robustness`，说明改变的条件。不把不同工况 J 混排成搜索冠军，不将仿真参数提升为实车 last-known-good。

任务显式指定抗扰搜索时，按任务固定冲量幅值/时刻、种子、初态、时长，不能沿用默认无扰动条件。每轮同时读 diagnostics：施扰后peak/recovery、尾段meanAbs/RMS、输出观测饱和和积分状态。若 diagnostics.disturbance.recovered=false 或 metrics.converged=false，不当成可行冠军。找到可行点后再比较同工况J与恢复时间；没有可行点就明确报告。CLI对campaign强制上一轮parent、总预算、重复点与搜索条件一致；robustness也须连接上一轮runId。条件或代码改变必须新建campaign。

验证场景在任务开始前固定；候选冻结后再运行，不看结果替换失败场景。不把固定seed重复算作独立稳定验证。停止时说明预算耗尽/无改善/达到要求/工具故障之一，并保留全部记录。记录简短假设、预期变化与观测结果，不以模型口头DONE替代测量。

诊断的 integral.maxAbs 与观测输出饱和需联合解释：达到积分限幅不是windup的必要或充分条件，未达限幅也不能单独排除windup。需读CSV确认执行器饱和期间误差/积分累积方向和恢复过程；稀疏遥测没有饱和样本不能证明控制步内无饱和。证据不足只报告假设，不把Ki>0的不收敛叫windup。

J 的实际权重来自配置，公式为：

```
J = wOvershoot * min(overshoot / 0.5, 1)
  + wSettling * min(settlingMs / 2000, 1)
  + wSsErr * min(abs(ssErr) / max(abs(step),1), 1)
  + wEnergy * min(energy / 20000, 1)
```

energy 是输出平方按实际相邻采样间隔的左端积分；调节时间描述有限观测窗口，并要求至少 300ms 持续带内观测。不要称“永远稳定”。失败 J 为字符串 `"Infinity"`，无定义指标为 null；成功 metrics 含 jWeights/jNorm/tol；所有 trial 的 evaluation 带版本与有效配置。不同版本历史 J 不能直接混比。

# D2复测的专项约束

任务指定D2时，以`docs/experiment_protocol.md`及指定`stage-d2-t-*.json`/`stage-d2-m-*.json`为准，覆盖上文默认预算/验证数量。T是各控制器同预算的独立自主调优，M是固定参数的机制对照；不能把M叫自主搜索，也不能把T不同参数候选间的差异全归因于结构。T至少6个搜索点后才可因连续3个新点无改善停止，最多12个；全部6个验证场景预先固定，开始验证后不再搜索。M各1个固定search+3个固定validation。

本机`tools/probe-stage-d2.js`的162条是已披露方法探索，正式Agnes试验不得调用它替代逐轮决策，不得将其结果记为Agnes运行。Ki=0的成功是PD先验，不能评价条件积分收益；只有M的饱和/抑制证据及成对轨迹能检验该机制，机制覆盖须抑制>0并检验积分/输出方向，控制性能另报converged，不能要求baseline对照必须通过。T仍用3s和中点冲量；探索的4s数据固定1500ms冲量，不是CLI的4s试验，不混排J。新批次全量保留，旧D不覆盖。没有可行冠军时明确报告；为完成预定验证可使用已测非摔倒诊断候选，但不能称其为最优。“同预算”指上限相同，报告必须列实际点数、停止原因和Ki=0/Ki>0的最佳可行点；最低6点和提前停止规则由真实会话审计，CLI不校验这些软规则。

# 实车阶段

须另有明确硬件授权与现场安全确认。首次上车前完成固件编译、Stop/Start/看门狗/确认帧测试、串口执行路径验证、可靠回滚目标与中断行为检查。当前硬件待修问题见 `docs/serial.md`；selftest 通过不构成实车验收。

禁止照搬仿真 Kp 起点、从零 Kd 上探或将 sim “最优”直接下车。初始参数来自本车已验证的可用配置。真车重复试验与机械间隔按现场协议和配置执行；不把固定种子重复仿真当独立统计样本。

# 输出与证据

任务含压力配置时，使用指定`--sim-profile <JSON>`；读meta.sim.simProfile有效值。不同压力/模型/控制器不混排J，不能临时降低压力或换seed让验证通过。无压力默认复现sim-timing-2；非恒等压力为sim-pressure-3。out是执行器前命令，energy是命令能量代理，不能当实际执行器功率。噪声/延迟用于控制，angle仍是真实状态代理。范围与验证顺序按预声明plan，失败是有效结果，不触发硬件回滚。

先区分测量事实与原因假设：J/fail/converged 引用原 JSON；解释积分状态时读取 diagnostics 与原始 CSV 的 errInt/输出列，按上文联合证据判断；不能把所有 Ki>0 的不收敛叫 windup。历史样例名称 fail-windup 只是兼容标签，不证明真实饱和。Ki=0、Kd>0 是 PD。`--disturb` 单位 deg/s，在单轮中点施加可重复的角速度冲量，不是角度阶跃或不可重复手推。当前 overshoot 对回零方向定义，不能作为施扰后峰值：抗扰峰值须从原 CSV 的施扰时刻之后另算并标明时间窗口。末段均值包含恢复过程，不能直接判定长期残差，更不能据此建议改固件。少数点只支持这些点的结论，不外推整个参数区间。优先一次改变一个参数以便判断原因；预测与实际命令必须一致。

每轮列参数、runId、J、fail/converged、理由和下一步。最后报告“本次已测候选最优”、指标、预算、完整失败与无改善轨迹、鲁棒性和未验证范围。出厂参数/网格对比须相同源码与工况；未运行就标未测。保留全部 CSV/index，不删失败，不编造人工对照与真车结果。索引证明试验发生，自主决策还须真实 AGH 会话记录证明。
