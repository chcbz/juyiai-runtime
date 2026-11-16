# 安装后配置

由安装所属用户授权配置，按现有 Runtime 私有安装配置机制交付，不把此示例当作实际配置：

```json
{
  "endpoint": "https://speech.example.invalid/v1",
  "model": "PROVIDER_SUPPORTED_TRANSCRIPTION_MODEL",
  "apiKey": "OWNER_CONFIGURED_SECRET",
  "language": "zh",
  "responseFormat": "json"
}
```

`endpoint` 是 API 基路径，不是完整 transcription URL；保留服务的基路径后追加 `/audio/transcriptions`。默认 JSON 可兼容仅提供 text 的服务；时间戳/说话人输出需服务与模型实际支持对应 responseFormat。不能把 Realtime 模型名填入本配置并假定兼容。

安装级 `networkOrigins` 需包含对应 origin（本例仅为占位，不能用于真实运行）。配置无效时先本地失败，不发网络请求。脚本不从全局 OpenAI/平台 API 环境变量窃取凭据。

协议验收需真实可用且获准的服务、一次明确授权的音频与实际返回文字；HTTP mock 测试不能证明某个服务支持该协议。脚本不会自行分块、重试、下载解码器或估算费用。服务的原始 usage 会随结果及宿主提供的 `CYF_PROVIDER_USAGE_DIR` 日志保存；无 usage 时为 null，不补造 token 或价格。
