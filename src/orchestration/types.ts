export type PlanState =
  | 'PLANNED'
  | 'RUNNING'
  | 'WAITING_FOR_USER'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED';

export type StepState = 'PENDING' | 'RUNNING' | 'WAITING_VERIFICATION' | 'VERIFIED' | 'FAILED' | 'SKIPPED';

export type BackendName = 'playwriter' | 'agent-desktop' | 'pywinauto' | 'vision';

export interface Step {
  readonly id: string;
  readonly description: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly backend: BackendName;
  readonly dependsOn: readonly string[];
  readonly expectedOutcome: string;
  verification?: {
    tool: string;
    args: Record<string, unknown>;
    expected: unknown;
  };
  state: StepState;
  result?: unknown;
  error?: string;
  retryCount: number;
  startedAt?: string;
  completedAt?: string;
}

export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly steps: Step[];
  state: PlanState;
  currentStepIndex: number;
  context: ExecutionContext;
  error?: string;
}

export interface ExecutionContext {
  readonly browserTabs: readonly BrowserTabContext[];
  readonly desktopWindows: readonly DesktopWindowContext[];
  readonly activeApp?: string;
  readonly activeWindowId?: string;
  readonly lastSnapshotRef?: string;
  readonly lastScreenshotPath?: string;
  readonly variables: Record<string, unknown>;
}

export interface BrowserTabContext {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly windowHandle?: string;
  readonly isActive: boolean;
}

export interface DesktopWindowContext {
  readonly id: string;
  readonly title: string;
  readonly appName: string;
  readonly processId: number;
  readonly isFocused: boolean;
}

export interface OrchestratorOptions {
  readonly registry: ToolRegistry;
  readonly logger: Logger;
  readonly persistencePath?: string;
  readonly maxRetries?: number;
  readonly verificationTimeoutMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface ToolRegistry {
  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionReceipt>;
  has(name: string): boolean;
  listNames(): string[];
}

export interface ToolExecutionContext {
  executionId: string;
  callId: string;
  logger: Logger;
  signal: AbortSignal;
  now: () => Date;
}

export interface ToolExecutionReceipt {
  executionId: string;
  callId: string;
  toolName: string;
  status: 'success' | 'failure' | 'approval_required' | 'approval_unavailable' | 'denied' | 'timeout' | 'cancelled';
  approval: 'not_required' | 'required' | 'approved' | 'denied' | 'cancelled' | 'unavailable';
  verification: 'verified' | 'failed' | 'not_applicable';
  result: unknown;
  error: string | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface PersistedPlan {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  steps: Step[];
  state: PlanState;
  currentStepIndex: number;
  context: ExecutionContext;
  error?: string;
}