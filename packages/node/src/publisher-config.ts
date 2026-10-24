// Reads explicit publication opt-in only; never reads local keys or starts requests.
import type {HomeEnvironment} from '@gyblos/config';
export function sellerPublicationConfig(environment:HomeEnvironment):{baseUrl:string}|undefined {
 void environment;throw new Error('Not implemented');
}
