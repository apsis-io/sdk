# Quickstart: a Perseid in five minutes

A Perseid is one operator program: a generator that **observes**, emits
**obligations as effects**, and **yields**. It performs no I/O - effects are
data it hands to the host, which executes them and re-runs the step when its
wake condition says the world changed. This walk takes you from an empty file
to a running program on a cluster.

## 1. Install

```sh
bun add @apsis-io/perseid
```

Importing it obliges **no `periapsis:*` interface** in your world: a step's
effects are data, and the host supplies the world. There is no barrel - import
the module you use.

## 2. Write the step

```ts
// step.ts
import {
  defineStep, reconcile, path, yieldStep, terminate, quiesce, fieldNe,
} from '@apsis-io/perseid/perseid.js'

const WEB = path.ns('default').deployments('web')

export const step = defineStep(function* () {
  const observe = reconcile.observe<number>()
  const ensure = reconcile.ensure()

  const have = yield* observe(WEB)
  switch (have.t) {
    case 'absent':
    case 'unknown':
      // Observation is three-valued: `absent` is not `unknown`, and neither
      // is an error. A pass that cannot see says so and yields.
      return yieldStep
    case 'known':
      if (have.v !== 2) {
        yield* ensure({ path: WEB, field: 'spec.replicas', value: 2 })
        return yieldStep
      }
      // Converged: park, and wake only if it drifts.
      return quiesce(fieldNe(WEB, 'spec.replicas', 2))
  }
})
```

That is the whole program. `ensure` is an obligation the host fulfils through
the program's own derived credentials; `quiesce` carries a wake condition the
host evaluates without running you.

## 3. Drive it locally - no cluster

`runStep` runs the step against a fake handler. A step is a pure function of
its observations, so the test IS the program:

```ts
// step.test.ts
import { expect, test } from 'bun:test'
import { runStep, known } from '@apsis-io/perseid/perseid.js'
import { step } from './step.js'

test('converged parks on drift', () => {
  const acts: string[] = []
  const outcome = runStep(step, {
    get: () => known(2),
    ensure: (args) => {
      if ('value' in args) acts.push(`${args.field}=${args.value}`)
    },
  })
  expect(acts).toEqual([])
  expect(outcome.o).toBe('quiesce')
})
```

## 4. Generate the manifest and apply

**The manifest is the code.** It carries the program and deliberately nothing
else - capabilities and write objects are derived at admission and recorded on
the status, so there is nothing to hand-maintain and nothing to drift.

```ts
// manifest.ts  (bun run manifest.ts | kubectl apply -f -)
import { perseid, toYaml } from '@apsis-io/perseid/manifest.js'

console.log(toYaml(perseid({
  metadata: { name: 'scaler', namespace: 'default' },
  spec: { step: await Bun.file('./step.ts').text(), backstopMs: 90_000 },
})))
```

```yaml
# what comes out:
apiVersion: perseid.apsis/v1
kind: Perseid
metadata:
  name: scaler
  namespace: default
spec:
  step: |
    export const step = defineStep(function* () {
      ...
    })
  backstopMs: 90000
```

```sh
bun run manifest.ts | kubectl apply -f -
```

Admission compiles the step, derives its capabilities and write objects from
the yields, and provisions the RBAC - a typo in an effect or an unresolvable
write path is refused there, with the reason.

## 5. Watch it

```sh
kubectl get psd scaler -o yaml
```

`psd` is the short name. The status tells you what admission decided and where
the program is: `phase` (`Admitted` → `Running`, or `Parked` with the wake
condition in `message`), plus the derived `capabilities` and `writes` - the
derivation, on the object, where an operator can read it.

## Where to go next

- **Parking vocabulary** - `fieldIs`, `fieldNoLonger` (fires on deletion,
  where a bare `!=` goes silent), `pinned` (multi-hop chains: Pod → PVC → PV,
  guards that wake a re-trace), `anyPods`/`noPods` (set parks by literal
  selector), `allOf`/`anyOf`, `backstop`/`deadlineIn`.
- **Invariants** (`invariant.ts`) - TypeBox-backed runtime assertions for
  trust boundaries the type system cannot see.
- **`match.ts`** - exhaustive tagged-union matching for code that yields.
- **`manifest.ts` options** - `stepRef.image` (push the source as an OCI
  artifact instead of inline), `engine`, `suspend`.

The full module list lives in [README.md](README.md). License: Apache-2.0.
