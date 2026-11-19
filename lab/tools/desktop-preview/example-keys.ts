// Browser-only API key summaries for the connection review.
export function exampleKeys(empty: boolean) {
  const sampleKey = {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Coding tools',
    limitAtomic: '10000',
    spentAtomic: '2000',
    settledAtomic: '2000',
    approvedAtomic: '0',
    reservedAtomic: '0',
    revoked: false,
  };
  return empty
    ? []
    : [
        sampleKey,
        {
          ...sampleKey,
          id: '00000000-0000-4000-8000-000000000003',
          name: 'Research',
          limitAtomic: '50000',
          spentAtomic: '0',
          settledAtomic: '0',
        },
        {
          ...sampleKey,
          id: '00000000-0000-4000-8000-000000000004',
          name: 'Old laptop',
          limitAtomic: '20000',
          spentAtomic: '4000',
          settledAtomic: '4000',
          revoked: true,
        },
      ];
}
