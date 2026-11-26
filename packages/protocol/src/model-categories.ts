import { MODEL_CATEGORIES } from './constants';

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export const isModelCategory = (value: unknown): value is ModelCategory =>
  MODEL_CATEGORIES.some((category) => category === value);

export function sortedCategories(values: readonly string[]): ModelCategory[] {
  const unique = new Set(values);
  return MODEL_CATEGORIES.filter((category) => unique.has(category));
}
