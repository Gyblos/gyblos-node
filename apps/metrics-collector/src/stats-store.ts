// Owns the stats read port: what the public stats use case needs from aggregate storage. Row types
// come from the aggregate schema; the D1 adapter is stats-read.ts.
import type { DayRange } from './days';
import type {
  aggDemandDaily,
  aggObservedDaily,
  ReceiptTotals,
} from './schema-aggregates';

// Summed receipt totals of grouped rows, with the newest computation time and the formula versions
// they were computed with.
export type TotalsRow = ReceiptTotals & {
  aggregatedAt: number | null;
  minFormulaVersion: number | null;
  maxFormulaVersion: number | null;
};
export type NetworkRow = TotalsRow & {
  day: string;
  conflicts: number;
  activeSellers: number;
  buyers: number;
  modelsServed: number;
};
export type ModelRow = TotalsRow & {
  modelId: string;
  variant: string;
  quantization: string;
  sellers: number;
};
export type SellerDayRow = TotalsRow & { day: string };
export type SellerModelRow = TotalsRow & {
  modelId: string;
  variant: string;
  quantization: string;
};
export interface SellerBuyersRow {
  day: string;
  paid: number;
  buyers: number;
}
export type ObservedRow = typeof aggObservedDaily.$inferSelect;
export type DemandRow = typeof aggDemandDaily.$inferSelect;

export interface StatsReader {
  // Network rows per day and paid flag; observed rows per day; demand rows, at most
  // AGGREGATES.maxPublicDemandPerDay per day, largest first.
  network(range: DayRange): Promise<{
    network: NetworkRow[];
    observed: ObservedRow[];
    demand: DemandRow[];
  }>;
  // Rows per model and paid flag, at most AGGREGATES.maxPublicModels models, most completed first.
  models(range: DayRange): Promise<ModelRow[]>;
  seller(
    nodeId: string,
    range: DayRange,
  ): Promise<{
    days: SellerDayRow[];
    models: SellerModelRow[];
    buyers: SellerBuyersRow[];
  }>;
}
