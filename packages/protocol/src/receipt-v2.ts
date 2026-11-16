// Paid receipt/v2 contract; signatures attest usage and channel claims, not chain settlement.
import { CONTROL_CODES, CONTROL_LIMITS } from './constants';
import {
  controlFail,
  controlHex,
  controlObject,
  controlVerify,
} from './control-validation';
import { bytesHex, hexBytes } from './public-validation';
import type { SignedReceipt } from './receipt-types';
import { parseBuyerReceiptV2, parseSellerReceiptV2 } from './receipt-v2-parser';
import type {
  BuyerReceiptV2,
  ReceiptV2,
  SellerReceiptV2,
} from './receipt-v2-types';
import { RECEIPT_V2 } from './receipt-v2/constants';
import { sign, signingBytes, type Signer } from './signing';

export type * from './receipt-v2-types';
export { RECEIPT_V2 } from './receipt-v2/constants';
export { parseBuyerReceiptV2, parseSellerReceiptV2 };

export async function sellerReceiptDigestV2(
  value: SellerReceiptV2,
): Promise<string> {
  const record = parseSellerReceiptV2(value);
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(RECEIPT_V2.sellerDomain, record),
      ),
    ),
  );
}
async function signedRecord<T>(
  record: T,
  nodeId: string,
  domain: string,
  signer: Signer,
): Promise<SignedReceipt<T>> {
  const signature = Uint8Array.from(await sign(domain, record, signer));
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await controlVerify(domain, record, hexBytes(nodeId), signature))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { record, signature: bytesHex(signature) };
}
export function signSellerReceiptV2(
  value: SellerReceiptV2,
  signer: Signer,
): Promise<SignedReceipt<SellerReceiptV2>> {
  const record = parseSellerReceiptV2(value);
  return signedRecord(
    record,
    record.sellerNodeId,
    RECEIPT_V2.sellerDomain,
    signer,
  );
}
export function signBuyerReceiptV2(
  value: BuyerReceiptV2,
  signer: Signer,
): Promise<SignedReceipt<BuyerReceiptV2>> {
  const record = parseBuyerReceiptV2(value);
  return signedRecord(
    record,
    record.buyerNodeId,
    RECEIPT_V2.buyerDomain,
    signer,
  );
}
function parseSigned<T>(value: unknown, parse: (record: unknown) => T) {
  const input = controlObject(value, ['record', 'signature']);
  return {
    record: parse(input.record),
    signature: controlHex(input.signature, CONTROL_LIMITS.signatureBytes),
  };
}
async function verifySigned<T>(
  value: SignedReceipt<T>,
  nodeId: string,
  domain: string,
) {
  if (
    !(await controlVerify(
      domain,
      value.record,
      hexBytes(nodeId),
      hexBytes(value.signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
}
export async function verifyReceiptV2(value: unknown): Promise<ReceiptV2> {
  const hasBuyer =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'buyer');
  const input = controlObject(value, [
    'seller',
    ...(hasBuyer ? ['buyer'] : []),
  ]);
  // Snapshot both halves before any crypto yields; no later caller mutation changes the claim.
  const seller = parseSigned(input.seller, parseSellerReceiptV2);
  const buyer = hasBuyer
    ? parseSigned(input.buyer, parseBuyerReceiptV2)
    : undefined;
  await verifySigned(
    seller,
    seller.record.sellerNodeId,
    RECEIPT_V2.sellerDomain,
  );
  if (!buyer) return { seller };
  await verifySigned(buyer, buyer.record.buyerNodeId, RECEIPT_V2.buyerDomain);
  if (
    buyer.record.requestId !== seller.record.requestId ||
    buyer.record.sellerNodeId !== seller.record.sellerNodeId ||
    buyer.record.buyerNodeId !== seller.record.buyerNodeId ||
    buyer.record.sellerReceiptDigest !==
      (await sellerReceiptDigestV2(seller.record))
  )
    return controlFail(CONTROL_CODES.POLICY);
  return { seller, buyer };
}
