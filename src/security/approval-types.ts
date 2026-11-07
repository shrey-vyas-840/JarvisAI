export interface ApprovalContent {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ApprovalRequest {
  readonly toolName: string;
  readonly operation: string;
  readonly root?: string | undefined;
  readonly relativePath?: string | undefined;
  readonly absolutePath?: string | undefined;
  readonly action: string;
  readonly warning: string;
  readonly content?: ApprovalContent | undefined;
}

export type ApprovalOutcome = 'approved' | 'denied' | 'cancelled' | 'unavailable';

export interface ApprovalProvider {
  requestApproval(
    request: ApprovalRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ApprovalOutcome>;
}
