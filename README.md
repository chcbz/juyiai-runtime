# JuyiAI Runtime

聚义 Agent Runtime、codex-bridge 与配套技能源码。由原共享安装仓提取，不包含 new-api、数据库、邮件等无关安装器。

保留 `conf/cyf-agent-runtime-v1/` 与 `conf/codex-bridge/` 相邻结构，避免打断已有导入与打包契约。组件版本、协议名称和生产安装路径不因仓库改名而变化。

- [Runtime 架构与配置](conf/cyf-agent-runtime-v1/README.md)
- [codex-bridge](conf/codex-bridge/README.md)
- [自行部署与接入](docs/cyf-agent-runtime-v1-self-host.md)
- [技能](conf/skills/README.md)

## 开发与打包

`conf/codex-bridge/package-lock.json` 锁定 Node 依赖。安装依赖后使用各组件既有 Node 测试；根目录 `tests/` 包含提取后的 Runtime 工具回归。
打包入口为 `conf/cyf-agent-runtime-v1/install.sh`，参数使用其 `--help`/usage 文档。需要自行提供受支持的 Node/npm/Python 工具链与外部依赖。

```sh
# This prints usage; it does not install or activate a service.
bash conf/cyf-agent-runtime-v1/install.sh --help
```

原共享安装仓的顶层 `install.sh --profile agent` 不属于本仓，请直接使用上述 Runtime 打包入口或 `shell/cyf_agent_runtime_v1_install.sh` 包装入口。
任何安装、身份注册、服务启停须在明确的目标环境执行；源码迁移不会激活或升级线上 Runtime。
本仓不携带用户会话、私有 HOME、私有凭证、部署日志或历史技能压缩包。

MIT；第三方包与技能素材保留各自声明。

## 历史验证边界

原仓固定旧提交 `5666fd2` 的历史安装验收 harness 及其专属单元用例留在原仓，不随无历史迁移导入；不把旧通过记录改写成当前验收。当前安装器、依赖闭包、隔离与通道测试保留。
