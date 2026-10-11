# CSV样例

`sample_step_response.csv` 是历史仿真生成的合成回放样例，带非零时间戳起点。它用于验证CSV解析和指标计算，不是实车采集。

列为 `ms,angle,target,out,spdL,spdR,errInt`。ms单位为毫秒，angle和target为度，errInt按控制步累加。sim中的out为执行器前控制命令，轮速列为派生proxy；serial中的字段按已验收设备协议解释。

回放保留原采样点，不重采样。`tools/make_sample_csv.js` 使用当前模型重新生成样例，结果可能与历史样例不同；历史selftest复算依赖仓库附带文件，应在独立副本中生成新样例。
