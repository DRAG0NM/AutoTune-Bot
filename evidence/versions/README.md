# 历史复现实现

六个目录分别对应v2.3、Stage A/B/C/D和D2。这里只保留重现采样及指标所需的sim、metrics、diagnostics、sim-options、sim-controller模块；模块仅由核验工具加载，不参与当前CLI。

历史模块仅调整注释，执行token序列保持一致。`manifest.json`列出原始字节散列、发布字节散列、token散列及原完整ZIP散列，用于关联保存的实验版本。

CSV及索引中的sourceHash仍标识当时完整项目，不改写为整理后的项目身份。公开复现校验这里的发布散列，并逐条重现输出；它不把最小模块集合冒充原完整项目源码包。

运行 `npm run verify:history` 重现全部110条campaign采样、36个v2.3网格点及9个v2.3 selftest样例。运行 `npm run verify:evidence` 复算指标、诊断和72条控制环统计。
