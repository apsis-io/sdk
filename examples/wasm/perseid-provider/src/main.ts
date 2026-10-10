// Supplies a step's capabilities, and CONVERGES: applying the obligation
// changes what the next observation reports. That makes the emit provable —
// the step's second run sees a different world because of its first run.
//
// Note there is no console.log here. This world imports neither wasi:cli/stdout
// nor anything else it was not granted, and an earlier version that logged
// trapped with "console.log requires importing wasi:cli/stdout" — the capability
// check firing at the point of use.
let podCount = 1

export const observe = {
  get: (path: string) => (path.includes('deployments') ? { tag: 'known', val: '3' } : { tag: 'unknown' }),
  count: (_q: string) => ({ tag: 'known', val: String(podCount) }),
  now: () => BigInt(1_760_000_000),
}

// ***THE ACTION IS TYPED, SO THIS PROVIDER CANNOT MIS-DISPATCH IT.***
// It was `emit.act(op, args)` until 2026-08-21: a string compare on `op` and a
// JSON.parse of `args`, both of which could be wrong at runtime and neither of
// which any type checked. `scale(path, replicas)` deletes the dispatch and the
// parse — the signature is the contract.
export const workloads = {
  scale: (_path: string, replicas: number) => {
    podCount = replicas
  },
}
