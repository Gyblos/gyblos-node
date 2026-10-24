// Schedules public announcements with injected transport; never infers, pays or reserves capacity.
import type {SignedPublicV2} from '@gyblos/protocol/control-types';
import type {SellerPublicRecords} from './public-records.js';
export function createSellerPublisher(options:{records:SellerPublicRecords;publish:(record:SignedPublicV2,signal:AbortSignal)=>Promise<void>;canPublish:()=>boolean;now?:()=>number;tickMs?:number;retryMs?:number}) {
 void options;throw new Error('Not implemented');
 return {tick:async()=>false,start:()=>{},stop:async()=>{},health:()=>({failures:0})};
}
