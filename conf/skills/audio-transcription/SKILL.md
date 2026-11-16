---
name: audio-transcription
description: 将已授权的会议、访谈等录音实际转写为文字，保留服务返回的时间戳与说话人标记；需要从音频提取原话时使用。
metadata:
  version: "1.0.0"
---
# 录音转写

用包内 `scripts/transcribe.mjs` 实际识别录音，不以附件名、用户描述、模拟录音的预写稿或常识生成“转写”。需要 Node.js >=24.14，无第三方依赖。服务必须支持 HTTP multipart `POST <endpoint>/audio/transcriptions`，返回含 `text` 的 JSON；仅有 Realtime/WebSocket 接口不满足本包依赖。可处理的编码、时长及文件大小由所配置服务决定，不把安装成功当成服务已配置或识别成功。

执行环境按该安装提供只读私有配置 `/skill-config/audio-transcription.json`，包含 HTTPS API 基地址 `endpoint`（例如服务提供的 `https://host/v1`）、`model`、`apiKey`。可选 `language`、`responseFormat`（默认 `json`；如服务支持，可设 `verbose_json` 或 `diarized_json`）。在安装的 `networkOrigins` 中授权该确切 HTTPS origin，`webSearch` 无需开启。配置内容示例见[配置说明](configuration.md)。不得复制平台服务或其他用户的密钥；不能通过安装包授予网络或业务权限。

```sh
node <本技能目录>/scripts/transcribe.mjs --input /inputs/recording.mp3 --output /outputs/transcript.json --config /skill-config/audio-transcription.json
```

未传 `--config` 时使用 `CYF_SKILL_CONFIG_DIR/audio-transcription.json`，否则默认上述私有配置路径。显式代理沿用环境 `HTTPS_PROXY`/`HTTP_PROXY`（不允许 `NO_PROXY` 绕行）；不关闭 TLS 验证。不要把密钥放在命令行或日志中。

1. 只读取本次获准的真实音频文件。普通多人录音不需要主持人介绍；服务没有返回说话人身份时不编造姓名，必要时用“说话人未区分”。对听不清、重叠及不确定内容保留说明，不能声称自动区分了全部参会者。
2. 一次命令只发送一次实际识别请求。`transcript.json.request-started` 为持久发送标记，断线、错误或结果不明后保留，不自动重发，也不换输出路径规避标记。该标记是本地防误重发，不是服务端幂等保证；跨执行仍须检查既有操作记录。明确新调用授权后才考虑重新执行；未知结果不改写。
3. 成功的 JSON 含原音频 SHA-256、字节数、实际转写、服务返回的 segments/words/language/duration、原始 usage（如有）及请求回执。空 `text` 只代表服务未返回文字，不补造会议内容。失败则向用户明确说明缺少配置、服务拒绝或结果未知，不静默卡住，也不伪交付。文件按授权输出范围处理。
4. 长录音如需切片，应使用已提供的解码工具，按真实音频切分、记录时间范围，依序转写；不要丢片、重复重叠文字或重置未知请求。无切片工具或服务限制不明时先报告，不临时下载执行未知程序。
5. 转写核对后，模型再整理讨论要点、最终决议、待办（负责人/截止时间）、风险及待确认项。改口以最终结论为准，姓名、日期、责任人未明确就标“待确认”。需要 DOCX/Markdown 时复用已安装的文档工具；转写脚本不发布成果、不结算、不决定事项完成。

本包不包含用户音频、预写对话、Provider 密钥或真实服务配置。包内测试仅验证协议和失败处理，不能作为真实录音识别验收。
