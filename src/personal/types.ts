export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown"
  | "closed";
export type AgentProfile = "discussion" | "review" | "mcp";
export interface ContextSnapshot {
  version: 1;
  id: string;
  parentThreadId: string;
  parentTurnId?: string;
  workingDirectory: string;
  createdAt: string;
  revision: string;
  source: "app-server" | "transcript" | "synthetic";
  text: string;
  coverage: { messages: number; toolResults: number; instructions: number };
  omissions: string[];
}
export interface AgentEvent {
  sequence: number;
  taskId: string;
  requestId: string;
  type: string;
  timestamp: string;
  data: unknown;
}
export interface ProviderRequest {
  sessionId: string;
  resume: boolean;
  prompt: string;
  workingDirectory: string;
  model: string;
  maxTurns: number;
  profile: AgentProfile;
  reviewTools?: string[];
  containsParentContext?: boolean;
  mcpConfigPath?: string;
  mcpAllowedTools?: string[];
  signal: AbortSignal;
}
export interface ProviderResult {
  sessionId: string;
  status: "completed" | "failed" | "interrupted";
  text: string;
  error?: string;
  costUsd?: number;
  terminationConfirmed?: boolean;
  outcomeUnknown?: boolean;
}
export interface AgentProvider {
  run(
    request: ProviderRequest,
    emit: (type: string, data: unknown) => void,
  ): Promise<ProviderResult>;
}
export interface StartAgentRequest {
  requestId: string;
  task: string;
  workingDirectory: string;
  contextRef?: string;
  requireContext?: boolean;
  model?: string;
  maxTurns?: number;
  profile?: AgentProfile;
}
export interface SendAgentRequest {
  taskId: string;
  requestId: string;
  message: string;
  contextRef?: string;
  workingDirectory?: string;
}
export interface AgentTask {
  version: 1;
  taskId: string;
  sessionId: string;
  parentThreadId?: string;
  workingDirectory: string;
  model: string;
  maxTurns: number;
  profile: AgentProfile;
  requireContext: boolean;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  contextRevision?: string;
  result?: string;
  error?: string;
  requests: Array<{ requestId: string; prompt: string; contextRef?: string; status: AgentStatus }>;
  events: AgentEvent[];
}
export interface ContextStore {
  read(id: string): Promise<ContextSnapshot>;
}
export interface BrokerOptions {
  stateDirectory: string;
  provider: AgentProvider;
  contextStore: ContextStore;
  maxConcurrency?: number;
  mcpConfigPath?: string;
  mcpAllowedTools?: string[];
}
