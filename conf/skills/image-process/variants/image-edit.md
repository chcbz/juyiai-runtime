---
name: image-edit
description: 使用 Runtime 原生工具按描述编辑已授权图片；尺寸、留边等确定性操作由包内离线脚本完成。
metadata:
  version: "2.0.0"
---
# 原生改图与离线成品处理

若只改尺寸或留边，直接读 [离线图片处理](image-process.md) 并运行包内脚本，不调用图片服务。语义改图使用本轮已授权的 `native_image_edit`，只传本轮授权素材引用；若要求保留白底或其他视觉内容，在提示中明确要求。单轮最多发起一次；结果不明不重发。

工具返回改图原件的只读路径和候选引用。默认保留被编辑主图的尺寸：按 [离线图片处理](image-process.md) 用 `--size-from` 指向最初的主图，或按用户指定尺寸使用 `--size`。白色留边用 `--background white`。不覆盖任何输入文件。用 `artifact_stage` 暂存实际派生 PNG，再 `result_propose` 选中成品引用。
