### 原生 Opus 的委托边界

- 在当前 Codex 聊天中使用 `collaboration.spawn_agent`，传入 `model="claude-opus"`、`fork_turns="3"` 和准确的任务说明；让 Opus 先提出有主张的方向，Codex 负责判断、集成和验收。
- 原生 fork 提供指定范围的父聊天上下文。任务说明仍须交代实际项目路径、目标体验和已验证限制；不要声称它看到了未传入的图片或运行状态。
- 保留返回的 agent ID。追问和继续工作使用 `collaboration.followup_task`；等待使用 `collaboration.wait_agent`；需停止时使用 `collaboration.interrupt_agent`。当前父回合负责接回结果与完成交付。
- 子 agent 使用 Codex 原生工具和权限边界，模型推理由本机网关交给现有 Claude CLI。不要改为旧 `claude_query`、`claude_implement` 或 `claude_personal` MCP 入口。
- 纯设计讨论明确要求只读；用户授权 Opus 实施时，限定独立修改范围与验收标准。模型判断不代替用户授权。
- 如果原生模型路由、工具循环或会话续接失败，报告实际失败并由 Codex 继续承担工作。不得切换密钥、重置认证或放宽执行策略绕过故障。
