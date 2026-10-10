// Deliberately incomplete: exports observe, NOT emit.
export const observe = {
  get: (_p: string) => ({ tag: 'known', val: '3' }),
  count: (_q: string) => ({ tag: 'known', val: '1' }),
  now: () => BigInt(1_760_000_000),
}
