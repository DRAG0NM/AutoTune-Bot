# 软件测试记录

保存v2.3、Stage B/C、D2和串口执行层加固后的selftest，以及Windows/WSL回归日志。不同阶段记录对应各自实现，不按独立试验合并计数。

最终软件回归68项，其中34项为注入FakeSerialPort的串口专项；没有打开真实设备。覆盖确认缺失、I/O失败与超时、中断、断流、tick异常、角度越限及未验证状态回滚等路径。

当前代码检查：`npm test`、`npm run selftest`。历史v2.3行为复现：`npm run verify:history`。PASS表示符合预期，包括预期失败与未收敛场景。
