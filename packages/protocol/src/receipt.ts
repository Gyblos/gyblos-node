// Signs and verifies independent node attestations and their cross-binding; no expiry clock or collection.
import { CONTROL_CODES, CONTROL_LIMITS, RECEIPT } from './constants';
import {
  controlFail,
  controlHex,
  controlObject,
  controlVerify,
} from './control-validation';
import { bytesHex, hexBytes } from './public-validation';
import { parseBuyerReceipt, parseSellerReceipt } from './receipt-parser';
import type {
  BuyerReceiptV1,
  ReceiptV1,
  SellerReceiptV1,
  SignedReceipt,
} from './receipt-types';
import { sign, signingBytes, type Signer } from './signing';

export type * from './receipt-types';
export { parseBuyerReceipt, parseSellerReceipt } from './receipt-parser';
export async function sellerReceiptDigest(
  value: SellerReceiptV1,
): Promise<string> {
  const record = parseSellerReceipt(value);
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(RECEIPT.sellerDomain, record),
      ),
    ),
  );
}
async function signReceipt<T>(
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
export function signSellerReceipt(
  value: SellerReceiptV1,
  signer: Signer,
): Promise<SignedReceipt<SellerReceiptV1>> {
  const record = parseSellerReceipt(value);
  return signReceipt(record, record.sellerNodeId, RECEIPT.sellerDomain, signer);
}
export function signBuyerReceipt(
  value: BuyerReceiptV1,
  signer: Signer,
): Promise<SignedReceipt<BuyerReceiptV1>> {
  const record = parseBuyerReceipt(value);
  return signReceipt(record, record.buyerNodeId, RECEIPT.buyerDomain, signer);
}
async function verifySigned<
  T extends { sellerNodeId: string; buyerNodeId: string },
>(
  value: unknown,
  parse: (value: unknown) => T,
  domain: string,
  seller: boolean,
): Promise<SignedReceipt<T>> {
  const input = controlObject(value, ['record', 'signature']);
  const record = parse(input.record);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (
    !(await controlVerify(
      domain,
      record,
      hexBytes(seller ? record.sellerNodeId : record.buyerNodeId),
      hexBytes(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { record, signature };
}
export async function verifyReceipt(value: unknown): Promise<ReceiptV1> {
  const hasBuyer =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'buyer');
  const input = controlObject(value, [
    'seller',
    ...(hasBuyer ? ['buyer'] : []),
  ]);
  const seller = await verifySigned(
    input.seller,
    parseSellerReceipt,
    RECEIPT.sellerDomain,
    true,
  );
  if (!hasBuyer) return { seller };
  const buyer = await verifySigned(
    input.buyer,
    parseBuyerReceipt,
    RECEIPT.buyerDomain,
    false,
  );
  if (
    buyer.record.requestId !== seller.record.requestId ||
    buyer.record.sellerNodeId !== seller.record.sellerNodeId ||
    buyer.record.buyerNodeId !== seller.record.buyerNodeId ||
    buyer.record.sellerReceiptDigest !==
      (await sellerReceiptDigest(seller.record))
  )
    return controlFail(CONTROL_CODES.POLICY);
  return { seller, buyer };
}
