# 开发与贡献

使用Node.js 24.10或更高版本。提交前运行 `npm test`、`npm run selftest`；涉及历史复现或图表时再运行 `npm run verify:evidence`、`npm run verify:history` 和 `npm run plot:evidence`。

修改按问题分别提交，描述触发条件、行为变化和验证方法。代码注释解释协议约束、算法理由或边界条件；使用文档描述稳定接口，开发讨论留在issue或PR。

新增控制器或模型使用显式版本身份。历史记录和冻结模块不追写成新版本；新增试验使用独立campaign并保留失败结果。`runs/`、`state/`、本机配置、会话登录令牌和API密钥不提交。

串口测试使用注入的桩设备。自动化测试不打开实际设备，不编译或烧录固件。涉及实际硬件的验证在现场执行并单独记录条件。
