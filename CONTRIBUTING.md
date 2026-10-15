# 开发与验证

运行 `npm test` 与 `npm run selftest`。修改物理方程、控制器或指标时，增加独立数值检查；不能修改历史数据来适配新实现。历史复核：`npm run verify:history`、`npm run verify:evidence`、`npm run audit:sessions`。

新实验写runs；历史evidence只读。相同campaign固定源码、评价与搜索条件，改变条件新建campaign。失败和未收敛不得删去。新功能只面向仿真、回放和报告，不恢复已退休的硬件接口。
