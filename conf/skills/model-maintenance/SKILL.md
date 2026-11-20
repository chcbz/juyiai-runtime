---
name: model-maintenance
description: 查询及新增版本化模型单价，按原值调整指定好汉的目标模型。
metadata:
  version: "1.1.0"
---
# 模型维护

从本安装包目录执行 `python3 scripts/lookup.py`，使用以下子命令。不要寻找密议专用工具、读取令牌或直接访问数据库。

- `price MODEL`：查已配置价。仅在用户要求新增且还未配置时用 `add-price MODEL`，服务端按来源生成价目；随后用 `price MODEL` 读回。精确区分输入、输出、缓存命中和写入费用、分档、币种、单位与版本，不用旧比例补价。
- `binding PERSONA`：用已确认的规范好汉标识查询目标模型。要改模型时，用 `bind PERSONA OLD NEW` 携带刚读到的旧值；读回保存结果。已是期望值不用再写，也不把已保存说成活跃会话已切换。
- 写入应答不明时，只用 `price-receipt MODEL` 或 `binding-receipt PERSONA OLD NEW` 查同次执行、原参数回执，不重发提交。若查不到，报告未确认，不推断成功或失败。冲突先读回，不覆盖他人修改。

默认中文资料源（资料语言 zh；当前价格导入使用报价源）：
- 模型：https://basellm.github.io/llm-metadata/api/i18n/zh/newapi/models.json
- 供应商：https://basellm.github.io/llm-metadata/api/i18n/zh/newapi/vendors.json
- 报价：https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json
