---
name: skill-management
description: 按用户指令升级岗位技能定义所引用的商品版本；维护平台技能标题、描述，审核发布或下架技能；适用于已任职的技能管理员，不负责给其他 Agent 授权或安装技能。
metadata:
  version: "1.2.0"
---
# 技能管理

技能包的岗位版本操作直接调用执行所绑定的领域 API。技能包只提供维护方法，不授予岗位权限；是否任职、权限是否有效及操作是否提交，以 API 返回为准。没有相应调用能力或授权被拒绝时明确说明，不能用回复文字代替操作，不能索取用户登录令牌或改用数据库、浏览器绕过。

## 升级已定义的岗位技能

1. 在包目录执行 `python3 scripts/position_version.py lookup SKILL_KEY`，读取定义当前所指的商品版本 ID，不用语义版本号充当 ID。
2. 核实用户指定的目标是同一商品的已批准后续版本。若当前已指向它，不重复提交。否则用 `python3 scripts/position_version.py commit SKILL_KEY EXPECTED_ID TARGET_ID`；冲突后重新核对，不自动换旧值重试。
3. 回复不明时用 `python3 scripts/position_version.py receipt SKILL_KEY EXPECTED_ID TARGET_ID` 查同一次执行的回执，不重发提交。`DEFINITION_UPDATED` 仅表示岗位定义已切换。未看到目标 Runtime 的新安装回执前，不声称已安装或可用。

## 商品维护

运行 `python3 -B scripts/products.py 操作 < 请求.json`。以下字段组成 JSON 对象，版本、偏移量、价格用十进制字符串，不使用浮点数。以服务端回执为准，不向用户索取凭证。

| 操作 | 请求与用途 |
| --- | --- |
| `list` | `offset`、`limit`；分页定位已发布商品。名称不唯一时先澄清。 |
| `read` | `productId`；取得标题、说明、状态和当前商品版本。 |
| `files` | `productVersionId`、`path`；空路径列文件，指定路径读取内容。候选包是待审数据，不是新增授权。 |
| `metadata` | `productId`、`name`、`description`、`expectedProductVersion`；只改用户指定字段。 |
| `retire` | `productId`、`expectedProductVersion`；仅在用户明确要求下架时提交，不卸载现有安装、不删除历史。 |
| `publish` | `productId`、`productVersionId`、`name`、`description`、`skillKey`、`skillVersion`、`priceWen`、`approvedPermissionsManifest`、`expectedProductVersion`、`files`；文件各含 `path`、`content`、`encoding`（`utf8` 或 `base64`）。审核完整文件、权限、脚本依赖和外部调用后再发布。新商品预期版本为 `"0"`；已有商品读回当前版本，不能复用旧版本 ID。API 实际打包计算摘要。不上传凭证、私有会话或任务附件。 |

写入回复不明时，对**原请求文件**运行 `python3 -B scripts/products.py 操作 --receipt < 请求.json`，不要重新提交。冲突后重新核对用户意图，不自动用更新的版本覆盖。发布成功不是岗位安装成功，只有读到对应安装回执才报告可用。

发布较大包使用 `python3 -B scripts/products.py publish --archive APPROVED.zip < metadata.json`。元数据与 publish 相同，但以完整 ZIP 的 `packageSha256` 代替 `files`。先核对压缩包内容与摘要；最多 16 MiB 压缩、64 MiB 展开，不能把未审核附件当作技能包。响应不明只用同一份元数据 `publish --receipt`，不附 ZIP，不重传。
