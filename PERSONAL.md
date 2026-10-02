# Personal Claude Agents · 0.4.0-personal.1

这是 [Dunqing/claude-codex-bridge](https://github.com/Dunqing/claude-codex-bridge) 的个人分支。目的：在一个 Codex 聊天里委托 Opus、追问并接回结果，让上下文和会话延续由 bridge 处理。

## 已实现

- `agent_start/send/wait/status/list/interrupt/close` 七个 MCP 工具；默认 Opus。
- 每个任务独立 Claude session ID；同任务追问串行排队，多个任务最多同时运行两个。请求 ID 与业务参数相同会复用原请求；自动重新采集的上下文不把重试变成新工作。需要更新指令时使用新请求 ID；业务参数或父聊天冲突会拒绝。
- PreToolUse hook 读取当前父聊天的可见历史、可用工具文字结果和适用 AGENTS。优先 `thread/read`，失败时只读 hook 指定且 session ID 匹配的 transcript。不扫描其他聊天，不调用 `thread/resume`。
- 每次 start/send 创建不可变上下文快照，随请求附上当前快照、revision 与遗漏说明。追问也附上完整的有界快照；目前没有增量压缩。历史、指令和输出有容量上限，截图像素与隐藏推理不传递。
- 本机多个 MCP 连接共用一个后台服务。任务、游标和会话关系持久保存；重启后未完成任务标为 `unknown`，不会擅自重放。取消无法确认整个 worker 已退出时也进入 `unknown`。
- 纯讨论无工具；review 只有 Read/Grep/Glob；MCP 模式必须由操作者明确配置工具清单。个人接口没有写文件的 implementation profile，Codex 负责集成。
- 分享默认关闭，有独立的一次性开关。接收请求与开始执行时都会检查开关；关闭后尚未交给 Claude 的上下文任务会失败，已经发出的内容无法撤回。配置里不包含登录信息；继续使用本机 Claude CLI 的现有认证。

这提供统一的委托流程，仍然是外部 CLI worker。它没有替换 Codex 的原生子 agent，也没有证明能唤醒已结束的父回合。当前回合须持续使用 `agent_wait` 接回结果。

## 本地构建与安装

需要 Node.js 22+、已正常登录且支持这些参数的 Claude Code CLI，以及支持 MCP PreToolUse 重写的 Codex。实际模型验证使用过 Claude Code 2.1.287。

```powershell
npm install --ignore-scripts --no-package-lock
npm run build
npm run typecheck
npm test
node dist/personal-control.mjs --print-config
```

`plugin.json`、`mcp.json`、`hooks/hooks.json` 和 `skills/personal-agents/` 是完整插件包。旧的单次工具技能保存在 `legacy-skills/`，避免新插件自动选择不存在的旧工具。使用本地插件安装入口时安装构建后的包；Git 安装不会自动生成 `dist`，应先构建，或使用预构建的 npm tarball。

也可以按 `--print-config` 打印的绝对路径注册 `claude_personal` MCP，并把同一个 hook 配置加入 Codex hooks 文件。这个输出只准备配置，不会自动修改已有设置。MCP 单独安装不包含自动上下文能力；还要加载 skill，并通过正常 `/hooks` 流程检查和信任 hook。MCP 服务名、hook matcher、`BRIDGE_MCP_SERVER` 必须一致。

Hook 的 `permissionDecision: "allow"` 是 Codex `updatedInput` 重写协议要求；本包没有自动批准 `PermissionRequest` 的 hook。它只匹配自己的 start/send 工具，不能授权其他工具。后台仍检查上下文分享开关。

查看分享范围后，明确启用：

```powershell
node dist/personal-control.mjs --enable-context-sharing
```

启用代表允许把之后主动委托的当前聊天可见内容和适用 AGENTS 交给本机 Claude CLI，继而由该 CLI 的现有模型服务处理。文本会脱敏常见密钥、口令、Bearer、私钥等模式；这种过滤不能保证识别任意形式的秘密。没有上下文时默认报错，不会偷偷降级为手动摘要。

```powershell
node dist/personal-control.mjs --disable-context-sharing
node dist/personal-control.mjs --status
node dist/personal-control.mjs --stop
```

后台在 MCP 客户端断开后继续运行，`--stop` 请求取消任务并等待后台退出。升级前停止旧后台，再构建和重新加载插件。后台进程持有初次启动的配置；修改 CLI/MCP 环境后需重启。不要删除正在使用的状态目录。

## 工具连接与本地数据

`CLAUDE_CLI_PATH` 可指定绝对原生可执行文件，Windows 应使用 `.exe`，不通过 shell 包装器启动。`BRIDGE_CODEX_COMMAND` 可指定本机 Codex CLI，用于只读当前 thread。`BRIDGE_STATE_DIR` 可指定状态目录；默认 Windows 为 `%LOCALAPPDATA%/claude-codex-bridge-personal`，其他系统为 `~/.local/state/claude-codex-bridge-personal`。快照和任务会保存在该目录，Claude CLI 自身也会保存用于 resume 的会话。不会把这些内容提交到仓库。

后台只监听随机 loopback 端口，并使用随机认证 token；token 写在本机状态目录，子 worker 不继承该 token。这个目录应仅供当前用户使用；POSIX 文件模式不等于 Windows ACL 隔离，其他拥有相同本机账号权限的进程仍可能读取它。

MCP profile 读取后台启动时的 `BRIDGE_MCP_CONFIG`（可信绝对路径）与 `BRIDGE_MCP_ALLOWED_TOOLS`（逗号分隔、精确 `mcp__server__tool` 名称）。CLI 启动后会核对实际工具和连接清单，不一致则停止。它不会自动继承 Codex 的 Godot、其他 MCP、skill 或截图；Godot 是否可用要对实际配置单独验证。多个 Claude worker 不应各自启动争抢同一 Godot editor 端口的服务；需要共享 endpoint 或单独网关。此版本未实现通用 MCP 网关。

## 验证与实际边界

```powershell
npm run validate:personal
npm run validate:personal -- --live
```

普通验证不调用模型。`--live` 只创建和发送合成聊天口令，不读取当前私聊或真实 AGENTS；它会调用现有 Opus 服务，产生正常模型费用。结果保存在被 Git 忽略的 `.personal-validation/`。

2026-10-02 验证通过：120 项单元测试、构建、类型校验、lint 和 skill 格式检查；真实 Opus 的 12 个合成端到端场景覆盖两个 MCP transport 共用后台、缺上下文拒绝、默认禁止分享、hook 快照实际到达 Opus、重新捕获 hook 后 start/send 重试不新增任务、两个会话隔离、跨父聊天拒绝、同一 Claude 会话记住旧口令并获得新上下文、关闭分享立即生效、重启后找回已关闭任务，以及显式配置的 MCP echo 实际调用。

这里的 live 验证直接向 hook 送入合成 Codex 输入，再通过 MCP 调用；它证明 hook→快照→后台→Claude 的数据链路。尚未证明桌面宿主安装后的真实工具名称、hook 信任与自动触发路径。安装后应在一个合成测试聊天验证该宿主路径，再用于真实项目。Windows 下完整子进程树回收受账号权限影响；不能确认时保留 `unknown`，不自动恢复执行。

官方接口依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[插件打包](https://developers.openai.com/plugins/build/plugins)、[Claude headless](https://code.claude.com/docs/en/headless)。个人分支不自动向 npm 发布，也不向上游提交更改。
