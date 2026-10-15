# 从零复现与评委检查

## 无模型账号：离线完整复核

只需要Node.js >=24.10（本次验证24.16.0）。本项目无第三方运行依赖，不需要node_modules、API Key、Git凭据或私人仓库。

解压提交ZIP，进入包含package.json的目录；或者克隆代码仓库后进入根目录：

```bash
node --version
npm test
npm run selftest
npm run verify:submission
npm run verify:history
npm run verify:evidence
npm run demo
```

`selftest`覆盖正常、边界、失败三类共9例；`verify:submission`核对冻结散列、复现7轮状态轨迹和原指标、匹配真实模型的参数提议及工具返回；`verify:history`复现110轮历史仿真。固定demo另外生成6轮CSV、SVG和HTML，它不调用模型，不能当作AI决策证据。demo最后输出report.html绝对路径，直接用浏览器打开即可。

手动试验示例：

```bash
# 正常：应收敛
node bridge/cli.js trial --gains 'Kp=4,Ki=0,Kd=8' --json
# 边界：Kd贴参数上限，允许性能不同
node bridge/cli.js trial --gains 'Kp=8,Ki=0,Kd=20' --json
# 失败：无控制，应识别摔倒并保存失败CSV
node bridge/cli.js trial --gains 'Kp=0,Ki=0,Kd=0' --json
```

新数据写runs，历史evidence只读。不同机器或换版本的新运行会产生新runId/时间戳；固定种子和固定数值实现的轨迹与指标可复算，不要求新旧文件名相同。

## 有模型账号：运行真正AGNES闭环

AGH是外部依赖，不随ZIP复制整个已配置运行目录。官方安装说明：[Agnes Harness](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/guide/install.md)。已有可用AGH时无需重装。

本次使用AGH源码提交`cde816b88c737b9fd04e7ef55b899e7b4cd55eb7`，本地版本号0.0.0。该预览版本采用源码构建：Node >=24.10、pnpm 10.34.5以及平台原生构建工具。Linux命令隔离另需bubblewrap和可用user namespace。请按官方指南准备环境。

```bash
git clone https://github.com/AgnesAI-Labs/agnes-harness.git
cd agnes-harness
git checkout cde816b88c737b9fd04e7ef55b899e7b4cd55eb7
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs serve --profile local-dev
```

通过AGH网页设置配置你自己的Agnes账户并选择`agnes-3.0-flash`；模型调用可能消耗额度。不要复制作者的账户文件或Key。保留同一profile，启动器会复用合法网页服务并新建独立会话。

原验收运行时另含effect耗时计量补丁，用单调时钟避免系统校时产生负duration；补丁只影响日志计时，不改PID与仿真。若要复现同一补丁环境，在上述构建前于AGH根目录运行`git apply <本项目绝对路径>/evidence/07_simulation-release-20261015/agh-effect-duration.patch`。补丁来源和散列见证据manifest；官方AGH是Apache-2.0，补丁保留上下文并明确标出改动。不要求把二进制构建散列当作跨机器可重现构建保证。

Windows + WSL推荐入口（PowerShell7）：

```powershell
& '.\启动调参助手.ps1' -Distro Ubuntu-24.04 -AghCli '/home/你的用户名/agnes-harness/packages/cli/dist/local/agnes.mjs' -Profile local-dev
```

纯Linux/WSL也可从项目根目录调用同一网页辅助：

```bash
node tools/launch-agnes-web.mjs --cli /absolute/path/to/agnes-harness/packages/cli/dist/local/agnes.mjs --project "$PWD" --profile local-dev --port 4177
```

打开返回的url，在新会话给出预算与目标，例如“最多4轮搜索和3轮验证，每轮模拟3秒，先收敛再降J”。按AGH权限界面处理工具请求；助手不替你修改全局权限。模型根据实际反馈选下一组参数；工具错误不伪装成已执行。录制新演示时使用新campaign，不能续接不同源码身份的旧campaign。

若网络、模型额度或框架版本导致新AI会话无法完成，仍可离线核验已附的完整会话及原始数据；应把新会话失败如实报告，不用demo冒充成功。
