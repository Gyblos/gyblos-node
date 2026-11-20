// The authenticated desktop buyer accepts a seller binding and signed listing prices, never a transport address.
import { parseModelSelection } from '../control-requests';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlInteger,
  controlObject,
} from '../control-validation';

export function parseBuyerSellerChoice(input: unknown, now: number) {
  const row = controlObject(input, [
    'owner',
    'nodeId',
    'modelId',
    'variant',
    'quantization',
    'contextTokens',
    'expiresAt',
    'inputAtomicPerMtok',
    'outputAtomicPerMtok',
  ]);
  const selection = parseModelSelection({
    modelId: row.modelId,
    variant: row.variant,
    quantization: row.quantization,
  });
  const expiresAt = controlInteger(row.expiresAt, now + 1);
  const inputAtomicPerMtok = controlAtomic(row.inputAtomicPerMtok);
  const outputAtomicPerMtok = controlAtomic(row.outputAtomicPerMtok);
  if (inputAtomicPerMtok === '0' && outputAtomicPerMtok === '0')
    throw new Error('Expected a paid listing');
  return {
    ...selection,
    owner: controlAddress(row.owner),
    nodeId: controlHex(row.nodeId),
    contextTokens: controlInteger(row.contextTokens, 1),
    expiresAt,
    inputAtomicPerMtok,
    outputAtomicPerMtok,
  };
}
export type BuyerSellerChoice = ReturnType<typeof parseBuyerSellerChoice>;
