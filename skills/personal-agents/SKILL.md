---
name: personal-agents
description: Delegate sustained creative, design or analysis work to a persistent Claude agent from the current Codex chat, with automatic parent context, follow-ups and task recovery. Use the claude_personal MCP tools; ordinary one-step edits do not need delegation.
---

Keep the user in the current chat. Delegate a concrete goal with `agent_start`; the trusted hook supplies `contextRef` and the service supplies the parent history. Do not invent a context reference or manually reproduce the entire conversation. Keep `requireContext=true` for normal delegation.

Prefer Opus for independent creative direction, taste and consequential design choices. Give a focused task and verified constraints, ask for a clear preferred direction, then judge and implement the useful result. Profiles are `discussion` (no tools), `review` (read-only CLI tools) and `mcp` (only operator-configured MCP tools). This personal facade currently has no implementation profile; execute authorized edits through Codex or the separate authorized implementation workflow.

Use a stable request ID when retrying the same start/send. A retry returns the originally accepted task even if the hook recaptures newer parent context; use a new request ID and `agent_send` for a new instruction. Preserve the returned task ID. `agent_send` queues a follow-up in the same session and receives a fresh context revision. It does not interrupt current work; call `agent_interrupt` explicitly if the task must stop.

Use `agent_wait` with the returned cursor and a timeout at most 60 seconds. A timeout means the task is still waiting or running. Continue coordination in the current parent turn and integrate the actual result. Do not promise that an idle parent chat will automatically wake later.

After compaction or transport reconnection, use `agent_list` and `agent_status` to recover existing tasks before creating anything again. A crash can produce `unknown`; inspect the state and effects before issuing a new instruction. Never blindly repeat work with side effects. Use `agent_close` only when the task is finished or explicitly abandoned.

Hook trust, context-sharing policy, authentication and MCP capabilities are real prerequisites. If an automatic context reference is missing, report the concrete failure and correct the connection; do not silently disable `requireContext`. Enable sharing or change tool profiles only within the user's authorization. Credentials and hidden reasoning are not part of the context handoff.
