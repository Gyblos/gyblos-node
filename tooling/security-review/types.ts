// Owns source-review contracts; model output is data and never execution evidence.
import type {
  PiThinkingLevel,
  REVIEW_VALUES,
  ReviewerId,
  ReviewFailure,
} from './constants';

type Value<Key extends keyof typeof REVIEW_VALUES> =
  (typeof REVIEW_VALUES)[Key];
export type ReviewMode = Value<'BASELINE' | 'PR'>;
export type ReviewStatus = Value<'CLEAN' | 'PENDING' | 'ERROR' | 'NOT_RUN'>;
export type ReviewUnitKind = Value<
  'APP' | 'PACKAGE' | 'CROSS_CUTTING' | 'REPOSITORY'
>;
export type VerificationDecision = Value<'NEEDS_VALIDATION' | 'REJECTED'>;

export interface ReviewUnit {
  id: string;
  label: string;
  kind: ReviewUnitKind;
  paths: string[];
}
export interface ReviewTask {
  id: string;
  reviewer: ReviewerId;
  unit: ReviewUnit;
  prompt: string;
}
export interface ReviewPlan {
  mode: ReviewMode;
  sourceRef: string;
  baseRef?: string;
  changedFiles: string[];
  units: ReviewUnit[];
  tasks: ReviewTask[];
  excludedFiles: string[];
}
export interface AgentEvidence {
  file: string;
  line: number;
  revision: Value<'HEAD' | 'BASE'>;
  scope: string;
  description: string;
}
export interface AgentFinding {
  fingerprint: string;
  category: Value<'SECURITY' | 'QUALITY'>;
  title: string;
  description: string;
  evidence: AgentEvidence[];
  lower_trust_principal: string;
  affected_resource: string;
  observed_result: string;
  suggested_fix: string;
}
export interface AgentReviewResponse {
  status: Value<'COMPLETE' | 'PENDING'>;
  reviewer: ReviewerId;
  coverage: { reviewed_paths: string[]; notes: string };
  findings: AgentFinding[];
}
export interface TaskResult {
  taskId: string;
  status: Value<'COMPLETE' | 'ERROR' | 'SKIPPED' | 'PENDING'>;
  findings: { fingerprint: string; title: string }[];
  error?: string;
  failure?: ReviewFailure;
  coverage?: string[];
  omissions?: SourceBundle['omissions'];
}
export interface VerificationResponse {
  decision: VerificationDecision;
  fingerprint: string;
  reason: string;
  evidence: AgentEvidence[];
  blockers: string[];
  validation_plan: string;
}
export interface VerificationResult {
  fingerprint: string;
  decision: VerificationDecision | Value<'ERROR'>;
  record?: VerificationResponse;
  error?: string;
  failure?: ReviewFailure;
}
export interface PiProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  failure?: ReviewFailure;
  reportedTokens?: number;
  truncated: boolean;
  timedOut: boolean;
}
export interface SourceFile {
  path: string;
  revision: Value<'HEAD' | 'BASE'>;
  text: string;
}
export interface SourceBundle {
  files: SourceFile[];
  diff: string;
  omissions: { path: string; reason: string }[];
}
export interface ReviewRunResult {
  version: number;
  mode: ReviewMode;
  sourceRef: string;
  baseRef?: string;
  status: ReviewStatus;
  plan: ReviewPlanSummary;
  candidates: AgentFinding[];
  tasks: TaskResult[];
  verifications: VerificationResult[];
  findingsValidation: Value<'PASSED' | 'FAILED' | 'NOT_RUN'>;
  execution?: {
    model: string | null;
    thinking: PiThinkingLevel;
    maxCalls: number;
    callsStarted: number;
    reportedTokens?: number;
  };
}
export interface ReviewPlanSummary {
  taskCount: number;
  unitCount: number;
  reviewers: ReviewerId[];
  changedFiles: string[];
  excludedFiles: string[];
}
export interface CliOptions {
  command: Value<'RUN' | 'PLAN'>;
  mode: ReviewMode;
  root: string;
  output: string;
  sourceRef?: string;
  baseRef?: string;
  model?: string;
  thinking: PiThinkingLevel;
  concurrency: number;
  maxCalls: number;
  dryRun: boolean;
}
