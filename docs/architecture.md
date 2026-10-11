# 架构与设计

Agnes 负责实验决策，PID-Bridge 负责参数检查、执行、采样与记录。两者通过命令行 JSON 交互。10ms 控制循环由仿真模型或车端固件执行，LLM 不参与逐控制步运算。

```text
Agnes Harness → shell → bridge/cli.js
                            ├─ sim    倒立摆代理模型
                            ├─ replay CSV 原始采样
                            └─ serial STM32 串口
                                      ↓
                              指标、诊断、CSV、索引
```

## 后端边界

`sim` 使用固定种子的确定性模型，控制周期默认10ms，遥测周期50ms。时序为状态位于 t、输出保持在下一控制区间；终点只报告状态，不额外积分。压力配置可加入执行器滞后、死区、测量延迟、噪声及控制/阻尼比例变化。集总参数未经过实车辨识。

`replay` 读取 CSV 并保留其时间戳和采样点，不进行插值。这样可以避免重采样掩盖越界或改变输出平方积分。回放传入的 gains 不会改变历史曲线。

`serial` 在打开设备前检查参数，然后按 Stop 确认、参数回执、Start 确认、有限采集、清理的顺序执行。主机传输完成与车端物理状态分开记录，详见[串口说明](serial.md)。

## 参数与配置

主机可调参数仅为 `AngleKp`、`AngleKi`、`AngleKd`。协议文件还保留课程其他参数的限幅定义，但 CLI 不写入这些参数。串口试验必须显式提供全部三个角度环参数。

配置优先级是内置默认值、`configs/bridge.example.json`、`configs/bridge.local.json`。参数限幅表必须与 `protocol.js` 一致，冲突时拒绝执行。`agents` 段记录策略建议值；声明式 plan 和 Skill 决定实际搜索预算，CLI 不执行所有策略层软规则。

## 记录与源码身份

每次试验生成 CSV 和追加式 `index.jsonl`，包含 gains、evaluation、sourceHash、工况、decision、metrics 和可用诊断。campaign 固定源码及搜索条件，并通过 parent 串联逐轮记录。候选进入独立验证后不重新搜索。

只读核验工具复算保存的记录；历史复现使用对应版本的模拟器。`last_good.json` 保存验证状态，sim/replay 不提升实车参数，未验证默认值不可用于回滚。

## 控制器对照

仿真支持 baseline、conditional-integral 和 derivative-filter。条件积分在输出饱和且误差会继续推向饱和方向时抑制累积；微分滤波的时间常数由配置给出。机制是否触发从控制环统计判断，性能仍按同工况指标评价。Ki=0 的 PD 结果不用于证明积分抑制收益。
