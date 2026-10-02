# Native Model Gateway · 0.5.0-native.1

这是 [Dunqing/claude-codex-bridge](https://github.com/Dunqing/claude-codex-bridge) 的个人分支。当前方案让 Opus 参与 Codex 原生子 agent：委托、父上下文 fork、工具执行、追问和结果回收都由 Codex 管理。本机网关只转换模型请求，不再使用 bridge MCP、上下文 hook 或独立 Claude 会话后台。

## 请求与工具如何运行

- Codex 统一访问 `http://127.0.0.1:53571/v1` 的 Responses 网关。默认 GPT 模型不变；模型目录保留本机全部原有记录，追加 `claude-opus`，默认 reasoning 为 `high`，支持 `low`、`medium`、`high`、`max`，上下文窗口保守设为 128k。
- GPT 请求固定转发至 `https://chatgpt.com/backend-api/codex/responses`，保留 Codex AuthManager 提供的现有 ChatGPT 订阅认证。安装器不复制或迁移登录凭据，不替换为 API Key。
- `claude-opus` 映射到本机官方 Claude Code CLI 的 `opus`，使用该 CLI 已有的订阅登录。CLI 以 `--tools '' --safe-mode` 运行，只返回模型决策；文件、命令、MCP 和权限检查仍由 Codex 执行。Claude CLI 不另开 Godot MCP 服务，也不另建持久会话。
- 当前 provider 使用 Codex 本地压缩，留下可读摘要；Claude 路由不接受远端 `/compact`，不伪造 OpenAI 隐藏推理密文。
- Claude 响应先完成推理并校验，再转换为 Responses SSE；等待期间发送 heartbeat。这是缓冲后发送，不是逐 token 实时流。GPT 上游逐事件转发；原生协作工具在传输层使用 `native_collaboration` 别名，返回时恢复 `collaboration`，派发消息保留明文。其他请求保持原始负载。

原生 fork 无需操作者手抄父聊天。Codex 0.159.2 的派发需要显式 `encrypted_function_args: []` 才选择明文消息路径；网关为三个协作派发工具提供该元数据，避免把普通任务错误包装成不可读消息。真正的加密任务、远端压缩密文和隐藏推理无法跨模型还原，会明确报告限制，不伪造解密结果。

## 在同一聊天中委托

Codex 先检查项目，再通过 `collaboration.spawn_agent` 指定 `model="claude-opus"`、`fork_turns="3"` 和明确任务。父上下文由原生 fork 提供；任务说明交代项目路径、目标体验、用户偏好和已验证限制。让 Opus 提出有主张的创意方向，Codex 负责判断、实施与验收。

保留返回的 agent ID，用 `collaboration.followup_task` 继续追问，用 `collaboration.wait_agent` 接回结果，需要停止时用 `collaboration.interrupt_agent`。这些是 Codex 原生协作入口，不是本仓库新增的 MCP 工具。纯讨论要求只读；授权实施时限定修改范围和验收标准。

Godot 调用走 Codex 已配置的工具，网关不会另起 Claude 侧连接争抢 editor。模型选择、工具描述可见或合成 MCP 测试通过，都不能证明真实 Godot 调用成功；实际 editor 连接和调用必须另行验证。

## Windows 准备与安装

需要 Node.js 22+、Codex 0.159.2，以及已正常登录、支持上述参数的原生 Claude Code `.exe`。在仓库目录执行：

```powershell
npm install --ignore-scripts --no-package-lock
npm run build

node scripts/install-native-gateway.mjs --prepare --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
```

`--prepare` 只准备 runtime，不修改用户 `config.toml`、全局 `AGENTS.md` 或计划任务。默认 runtime 为 `C:\Users\user\.codex\tools\native-model-gateway`；它包含构建后的 `dist`、控制脚本、模型目录和配置，Claude 工作目录为没有 `CLAUDE.md` 的 `synthetic-empty`。安装器检查端口可用性，自动发现既有 Claude 原生可执行文件；需要时传入 `--claude-command` 的绝对路径。已有激活安装须先回滚，才能重新准备。

可先在一个终端检查构建后的进程能否启动，再在另一终端查看和停止：

```powershell
node "C:\Users\user\.codex\tools\native-model-gateway\dist\native-gateway.mjs" --config "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"

node scripts/control-native-gateway.mjs --status --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
node scripts/control-native-gateway.mjs --stop --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
```

正式激活：

```powershell
node scripts/install-native-gateway.mjs --install --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
```

安装器注册当前用户的 `CodexNativeModelGateway` 登录计划任务，并立即启动。任务使用隐藏窗口、交互用户和有限权限，不存密码，不修改执行策略。它在本机健康检查通过后，才更新用户配置的 `model_provider`、`model_catalog_json` 和全局 `AGENTS.md` 的 Opus 入口；原有默认 GPT 与 NAS 内容保留。配置修改后需重新加载 Codex，验证新请求确实经过网关。每次覆盖都有本机备份。

安装器仅移除精确的 `[plugins."claude-personal-agents@claude-local"]` 残留 table，不代替旧插件的正式卸载。本机迁移已通过正式 CLI 完成旧插件和缓存卸载，并移除旧 MCP、marketplace 与 skill 入口。旧会话数据和备份保留。本仓库旧 bridge 源码为历史参考保留，安装过程不激活旧插件、skill、hook 或 MCP，也不发布 npm 包。

## 运行、数据与回滚

网关只监听 `127.0.0.1`，使用新生成的本机 token。token 保存在 runtime 的 `gateway.json` 和用户 TOML 请求头中，控制脚本不会打印它；这些配置及 `backups` 应留在本机。Claude 调用不继承 GPT 的订阅认证。默认最多同时执行两个 Claude 请求，单次超时为 240 秒；原生任务与追问历史由 Codex 持有。

```powershell
node scripts/control-native-gateway.mjs --status --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
node scripts/control-native-gateway.mjs --stop --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
node scripts/control-native-gateway.mjs --rollback --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
```

`--status` 只检查状态，不启动进程。`--stop` 请求当前认证网关退出，登录任务仍保留。`--rollback` 核对本次任务的动作，停止网关并撤销本次路由配置；后续被手动修改的字段保留并报告冲突。它保留备份，移除本次登录任务，不恢复已经卸载的 bridge MCP、插件或 marketplace。

## 验证命令与证据边界

```powershell
npm run typecheck
node node_modules/vitest/vitest.mjs run
node scripts/validate-native-catalog.mjs "C:\Users\user\.codex\tools\native-model-gateway\models.json"
node scripts/validate-native-gateway.mjs --code-mode --offline-mixed
node scripts/validate-native-gateway.mjs --code-mode --live-parent --config-file "C:\Users\user\.codex\tools\native-model-gateway\gateway.json"
```

单元测试覆盖协议转换、认证与转发边界、模型目录、配置保留及回滚等行为。`--protocol-only` 使用确定性模型替身；`--offline-mixed` 还核验真实原生 fork 的随机父上下文与私有指令过滤，不调用外部模型。最后一条使用正式安装的网关和现有 GPT/Claude 订阅，消耗正常订阅额度。原生 fork 需要正常本地历史，混合测试不使用 `--ephemeral`。报告保存到被 Git 忽略的 `.personal-validation/`。

2026-10-02 本机验证：233 项测试、构建、类型检查通过；实际 `model/list` 保留全部 10 个原模型并加载 Opus；当前用户计划任务处于 Running、Interactive、Limited。正式安装的网关已通过真实 GPT 父 agent → `fork_turns="3"` → Claude Opus → Code Mode 只读 MCP → 子结果回收 → 同子 agent 追问的链路，随机父上下文确实进入子模型请求。旧插件、缓存、marketplace、MCP 登记均已移除，默认 GPT 和 Godot 配置保留。

合成验证完全剔除真实聊天与全局 AGENTS，保留实际原生的合成消息与工具历史。它证明指定原生链路和安装进程，不证明桌面当前窗口已重新加载模型目录、任意历史密文可跨模型还原、所有工具都兼容，或 Godot editor 已接通。当前 Godot 状态为未连接；重载 Codex 后在打开目标编辑器的环境中继续验证。健康检查本身只证明进程可访问。
