// Owns the seller catalog/presence/withdrawal lifecycle over one durable allocator; no engine or payments.
import type {PublicCatalogV2,SignedPublicV2} from '@gyblos/protocol/control-types';
import type {Signer} from '@gyblos/protocol/signing';
import type {SellerSequence} from './public-sequence.js';
export interface SellerPublicRecords {
 current():SignedPublicV2;
 refresh(force?:boolean):Promise<SignedPublicV2>;
 presence():Promise<SignedPublicV2>;
 withdraw():Promise<SignedPublicV2|undefined>;
}
export async function createSellerRecords(options:{template:PublicCatalogV2;sequence:SellerSequence;signer:Signer;now:()=>number;validUntil:()=>number;catalogMs?:number;renewBeforeMs?:number}):Promise<SellerPublicRecords> {
 void options;throw new Error('Not implemented');
}
