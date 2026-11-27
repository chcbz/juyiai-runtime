---
name: model-maintenance
description: 查询及新增版本化模型单价，维护资源路由计价映射，按原值调整指定好汉的目标模型。
metadata:
  version: "1.2.0"
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

## 资源计价路由映射

仅在明确的维护任务中操作，沿现有模型维护职位的发布权限；不属于普通询价或Runtime自动注册。映射按租户/客户端共享，不按好汉或事项区分。

- `route-lookup REQUEST_JSON`：请求只有`reference`，其字段为`kind/component/namespace/modelOrTool/normalizationBasis`。只能使用真实资源适配器测量且已核实来源的引用；不能从模型名猜namespace、渠道或档位。
- `route-commit REQUEST_JSON`：发布请求包含上述`reference`、刚查询到的`expectedRevision`十进制字符串、`action:"PUBLISH"`及`route`。`route`仅三种：`{type:"TOKEN",channel,model,tier,basis}`、`{type:"UNIT",channel,tool,unit}`、`{type:"ZERO",contractVersion}`。所有值均为明确字符串；ZERO必须有已确认免费合同，缺单价不等于免费。TOKEN的basis必须与引用normalizationBasis一致。
- 撤回使用同一commit，`action:"WITHDRAW"`、确切`expectedRevision`和`reference`，不携带route。不会删除历史修订或改变已签价格。
- lookup返回MISSING时revision为"0"；ACTIVE和WITHDRAWN均返回当前修订。撤回后重新发布须使用撤回修订，不能从"0"重建。相同model不同namespace分别维护，不能自动把旧owner私有JSON合并成域内映射。
- 写入结果不明时，仅以**完全相同请求**执行`route-receipt REQUEST_JSON`。回执不存在不代表写入失败，不自动重发；冲突重新查询并报告。映射是报价参考身份，不证明实际供应商账单身份。

请求JSON仅为本次业务请求，不是本地权威配置；数据库修订及原执行回执由后端保存。不得把密钥、baseUrl或用户正文放入请求。
