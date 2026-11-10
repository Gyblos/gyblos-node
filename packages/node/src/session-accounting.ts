// Parses public session approval metadata; approval never asserts an on-chain charge or refund.
import {
  controlAtomic,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { sessionFail } from '@gyblos/protocol/payment-session';

export interface SessionApproval {
  approvedAtomic: string;
  cumulativeAtomic: string;
  depositAtomic: string;
}
export function sessionApproval(value: unknown): SessionApproval {
  try {
    const row = controlObject(value, [
      'approvedAtomic',
      'cumulativeAtomic',
      'depositAtomic',
    ]);
    const result = {
      approvedAtomic: controlAtomic(row.approvedAtomic),
      cumulativeAtomic: controlAtomic(row.cumulativeAtomic),
      depositAtomic: controlAtomic(row.depositAtomic),
    };
    if (
      BigInt(result.approvedAtomic) > BigInt(result.cumulativeAtomic) ||
      BigInt(result.cumulativeAtomic) > BigInt(result.depositAtomic) ||
      result.depositAtomic === '0'
    )
      return sessionFail();
    return result;
  } catch {
    return sessionFail();
  }
}
