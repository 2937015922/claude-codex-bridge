### 原生 Opus 的委托边界

- 在当前 Codex 聊天中使用 `collaboration.spawn_agent`，传入 `model="claude-opus"`，默认 `fork_turns="3"`；让 Opus 先提出有主张的方向，Codex 负责判断、集成和验收。委托前确认当前工具允许选择该模型；刚安装或修改模型目录后，需要重载 Codex 才能更新当前窗口的模型选项。不要为了委托而更换父 agent 的默认 GPT 模型。
- 原生 fork 自动提供指定范围的父聊天上下文。任务说明补齐准确的项目绝对路径、目标体验、用户偏好、关键证据和已验证限制；`workingDirectory` 不是 `spawn_agent` 的参数，项目路径写入任务说明，实际工具调用使用正确工作目录。不要声称子 agent 看到了未传入的图片、实时运行状态、隐藏推理或不可读取的加密历史。
- 保留返回的 agent ID。追问和继续工作使用 `collaboration.followup_task`；等待使用 `collaboration.wait_agent`；需停止时使用 `collaboration.interrupt_agent`。当前父回合负责接回结果与完成交付。
- 子 agent 使用 Codex 原生工具和权限边界，模型推理由本机网关交给现有 Claude CLI 的订阅登录。Godot 等 MCP 使用当前 Codex 已配置的工具，实际调用前检查连接状态；不要另起 Claude 侧 MCP 连接，也不要改为旧 `claude_query`、`claude_implement` 或 `claude_personal` 入口。
- 纯设计讨论明确要求只读；用户授权 Opus 实施时，限定独立修改范围与验收标准。模型判断不代替用户授权。
- 如果当前工具未暴露 `claude-opus`，或原生模型路由、工具循环、会话续接失败，报告具体缺口并由 Codex 继续承担工作。区分模型目录可见、网关健康、子 agent 完成和真实项目工具调用成功；不得用其中一项代替另一项的验证，也不得切换密钥、重置认证或放宽执行策略绕过故障。
