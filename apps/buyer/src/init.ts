// Guided terminal entry for the shared buyer initializer; never starts inference or queries a chain.
import type { BuyerInitAnswers, BuyerInitOptions } from '@gyblos/node/buyer-init';

export interface BuyerInitTerminal {
  read(question: string): Promise<string | undefined>;
  write(text: string): void;
  initialize(input: BuyerInitAnswers): Promise<unknown>;
}
export async function runBuyerInit(_terminal: BuyerInitTerminal): Promise<void> {}
