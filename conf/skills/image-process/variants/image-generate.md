---
name: image-generate
description: 使用 Runtime 原生工具生图；需要精确尺寸或白色留边时，用包内离线脚本处理成品。
metadata:
  version: "2.0.0"
---
# 原生生图与离线成品处理

使用本轮已授权的 `native_image_generate`，不要运行任何联网脚本。如果用户指定白底，在提示中明确要求主体在纯白背景上。单轮最多发起一次图片请求。工具返回原始 PNG 的只读路径和候选引用；不确定是否成功时，不改调用身份或重发。

用户指定尺寸或白色留边时，读取 [离线图片处理](image-process.md) 并自行运行包内脚本；用返回的只读路径作为输入，不取宿主路径。用 `artifact_stage` 暂存处理后 PNG，再以 `result_propose` 选择派生版本。只在无需加工且原件符合要求时选择原图候选。
