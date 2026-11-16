// Owns source-review contracts; model output is data and never execution evidence.
import type { PiThinkingLevel, ReviewerId } from './constants';

export type ReviewMode = 'baseline' | 'pull-request';
export type ReviewStatus = 'clean' | 'needs-validation' | 'error' | 'not-run';
export type ReviewUnitKind = 'app' | 'package' | 'cross-cutting' | 'repository';
export type VerificationDecision = 'needs_validation' | 'rejected';

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
  revision: 'head' | 'base';
  scope: string;
  description: string;
}
export interface AgentFinding {
  fingerprint: string;
  category: 'security' | 'quality';
  title: string;
  description: string;
  evidence: AgentEvidence[];
  lower_trust_principal: string;
  affected_resource: string;
  observed_result: string;
  suggested_fix: string;
}
export interface AgentReviewResponse {
  status: 'complete' | 'needs-validation';
  reviewer: ReviewerId;
  coverage: { reviewed_paths: string[]; notes: string };
  findings: AgentFinding[];
}
export interface TaskResult {
  taskId: string;
  status: 'complete' | 'error' | 'skipped' | 'needs-validation';
  findings: { fingerprint: string; title: string }[];
  error?: string;
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
  decision: VerificationDecision | 'error';
  record?: VerificationResponse;
  error?: string;
}
export interface PiProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  truncated: boolean;
  timedOut: boolean;
}
export interface SourceFile {
  path: string;
  revision: 'head' | 'base';
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
  findingsValidation: 'passed' | 'failed' | 'not-run';
  findingsValidationMessage?: string;
  execution?: {
    model: string | null;
    thinking: PiThinkingLevel;
    maxCalls: number;
    callsStarted: number;
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
  command: 'run' | 'plan';
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
