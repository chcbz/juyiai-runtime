---
name: model-maintenance
description: 按精确模型 ID 读取后端返回的价格资料。
metadata:
  version: "1.1.0-rc.1"
---
# 模型维护（只读验证候选，不替换现行写入版本）

用 `python3 scripts/lookup.py MODEL_ID` 查询。以业务 API 回执为准，区分配置价、参考价、币种、单位、分档与缓存读写，不用相似型号或零值补缺。接口不可用时报告未查询成功，不改用其他身份。该候选不能新增模型、更新价格或切换好汉模型。

默认中文资料源（由服务端核对）：
- 模型：https://basellm.github.io/llm-metadata/api/i18n/zh/newapi/models.json
- 供应商：https://basellm.github.io/llm-metadata/api/i18n/zh/newapi/vendors.json
- 报价：https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json
