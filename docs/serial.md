# 串口执行与设备协议

硬件后端通过 CH340 与 STM32 USART2 通信，默认115200、8N1。串口依赖按需安装：`npm install --no-save serialport`。COM5 是配置示例，使用时替换为实际端口；WSL 需要单独配置 USB/串口访问。

## 当前状态

主机执行层已通过34项串口桩测试。当前固件说明仅定义 `OK,<参数名>`，尚无 Stop/Start 回执和实际参数读回。因此 trial/set/rollback 在 Stop 未获确认时拒绝继续；Start 未获确认时不维持心跳。桩设备中的命令回执是测试输入，不代表实际固件支持。

`deviceState=unknown` 与主机执行状态分开。write/drain 完成不能证明电机停机；ACK只能证明协议动作被确认，不能代替物理状态读回。

## 主机流程

```text
参数预检 → 打开串口 → Stop确认 → 参数逐项回执
        → Start确认 → 有限遥测 → 尝试Stop → 关闭串口
```

缺确认、I/O异常、遥测异常或中断时停止后续动作并尝试清理。不会自动下发回滚参数。未验证默认值、旧状态或损坏状态不可作为回滚目标。

| 检查 | 默认设置 |
|---|---|
| 打开、写入/排空、关闭 | 每项等待上限2000ms |
| 命令/参数ACK | 500ms |
| Start后首条遥测 | 最多500ms |
| 最大遥测间隔 | 250ms |
| 最低覆盖率 | 80% |
| 最少样本 | 20 |
| 心跳周期 | 100ms；仅Start获确认后维持 |

试验主机期限使用单调时钟；遥测时间使用设备tick差值，支持uint32回绕。重复tick、倒退、断流、字段无效或角度越限结束采集。主机期限受操作系统调度影响，设备侧保护仍须由固件执行。

## 命令示例

以下命令会访问实际设备，仅在现场验收条件满足后运行：

```bash
node bridge/cli.js ports
node bridge/cli.js trial --backend serial --port COM5 --gains "AngleKp=<本车已验证值>,AngleKi=<本车已验证值>,AngleKd=<本车已验证值>" --json
node bridge/cli.js stop --port COM5
```

固件设计片段见[PATCHES.md](../firmware/PATCHES.md)。该文件不是已烧录工程；尚需编译、烧录及现场验证。
