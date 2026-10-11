# 配置与排错

## Node与工作区

运行 `node --version` 确认版本至少24.10。Agnes 的非交互shell也必须能找到同一Node。WSL源码及依赖建议放在Linux文件系统；串口在Windows可见不代表WSL可以直接访问。

## 参数和配置

`node bridge/cli.js params --json` 显示有效配置、参数状态及来源。覆盖文件为 `configs/bridge.local.json`，默认不入库。`PID_PORT` 可覆盖端口；`AUTOTUNE_RUNS_DIR`、`AUTOTUNE_STATE_DIR` 可隔离运行产物。白名单外参数、非法数字及范围冲突会被拒绝。

## 结果解释

`allPass` 是测试断言结果；`converged` 是单次响应判据；`validationPassed` 是整批预定验证结果，三者不同。未收敛但J有限的点不能成为可行最优候选。没有可行点时报告该事实，保留数据。

回放时 gains 不改变曲线。CSV须包含ms、angle、target、out，数值有限且时间严格递增；读取时不插值。历史数据核验使用冻结评价器，当前源码改动不应追写到旧记录。

## 串口状态未知

检查实际固件的确认协议和遥测格式。没有Stop/Start回执时，主机拒绝继续属于预期行为，不能通过延长等待、忽略ACK或改写deviceState绕过。现场接线、断电保护及设备状态读回须独立验证。

## 证据核验失败

CSV散列失败时检查文件是否被编辑或换行转换。版本模块散列失败时检查是否改动了历史模块；恢复原发布文件后再核验。修改当前代码时创建新campaign，旧数据保持原身份。
