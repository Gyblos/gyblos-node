const AGE_DAYS: Record<number, number> = {
  0: 4,
  1: 1,
  3: 2,
  4: 3,
  5: 5,
  6: 8,
  7: 12,
  8: 20,
};
const SEED_INDEX = { PINNED: 0, UNREAD: 2 } as const;

export function previewChatSeed(seeded: readonly string[]) {
  return {
    ages: Object.fromEntries(
      seeded.map((id, index) => [id, AGE_DAYS[index] ?? 0]),
    ),
    pinned: seeded.filter((_, index) => index === SEED_INDEX.PINNED),
    unread: seeded.filter((_, index) => index === SEED_INDEX.UNREAD),
  };
}
