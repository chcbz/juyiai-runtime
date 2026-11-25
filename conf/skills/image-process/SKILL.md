---
name: image-process
description: 离线调整已授权图片的尺寸，支持等比缩放、透明或白色留边，输出新的 PNG；不用于生图、语义改图或识图。
metadata:
  version: "1.0.0"
---
# 离线图片处理

仅处理本轮授权素材或本轮工具返回的只读图片。无需网络、服务配置或密钥；只用包内编解码器，不下载依赖。执行前确认尺寸和背景要求。没有用户要求时不要擅自改尺寸或铺白。

```sh
node <技能目录>/scripts/resize.mjs --input <本轮图片路径> --output /outputs/resized.png --size 800x600 --background white
node <技能目录>/scripts/resize.mjs --input <本轮图片路径> --output /outputs/resized.png --size-from <本轮参考图片路径>
```

`--size` 与 `--size-from` 二选一。采用原图显示方向，等比缩放、居中留边，不裁剪或拉伸。默认透明留边；`white` 将透明像素及边缘合成到纯白不透明画布，不会重绘原图的不透明背景。若用户要求白底，生图或语义改图时也须明确要求主体在纯白背景上。无法解码、动画或多页图片不静默丢帧；如实报告。

输出路径必须不存在。脚本校验实际 PNG 尺寸，白底模式额外校验不透明，并以新文件保存。处理失败只重试本地步骤，不重发模型调用。只提交符合要求的成品：用 `artifact_stage` 暂存新文件，再用 `result_propose` 选择成品引用，不选中间原图代替成品。
