// The governance monitor as a COMPONENT — the shipped half of governance.ts.
//
// `src/governance.ts` holds the decision and is runnable with a fake handler
// (`bun src/governance.ts`). This file is what `dwarf` compiles: the same
// decision, driven against the real WIT host imports, exported as the reconcile
// entrypoint radiant invokes.
//
// The split mirrors `src/main.ts` vs the rest of this example, and for the same
// reason the Go original gives: *"the decision is the part worth testing
// exhaustively, and a function that reaches for a cluster cannot be."*
//
// ═══════════════════════════════════════════════════════════════════════════
// ***THIS COMPONENT IMPORTS `observe` WITHOUT CALLING IT, AND THAT IS NOT A
// MISTAKE IN THE WORLD FILE.***
//
// `interface observe-cluster` declares `use observe.{obs}` — it returns the same
// three-valued `obs` the namespaced read does, rather than declaring a second
// variant that would be a different type with the same shape. In the component
// model a type dependency materialises as an INTERFACE IMPORT, so a world
// importing `observe-cluster` also imports `observe`:
//
//	world governance {
//	  import perseid:reconcile/observe-cluster@0.1.0;   // written
//	  import perseid:reconcile/observe@0.1.0;           // implied by `use`
//	}
//
// ***SO THE GRANT MUST LIST BOTH, AND ADMISSION IS WHAT WOULD CATCH IT.*** The
// capability gate compares the ARTIFACT's imports to `spec.capabilities`; the
// artifact carries three and a CR listing two is refused. That refusal is
// correct — the program genuinely can call `observe.get` — and it is worth
// knowing it is a consequence of sharing a type rather than of anything this
// program does.
//
// It is not an escalation of the cluster-read authority: `observe.get` is
// confined by the grant's namespace, which is the bound it has always had.
// ═══════════════════════════════════════════════════════════════════════════

import { wakeable } from '@apsis-io/perseid/wake.js'
import { get as hostGetCluster } from 'perseid:reconcile/observe-cluster@0.1.0'
import { status as hostSet, type ConditionStatus as HostCondStatus } from 'perseid:reconcile/status@0.1.0'

import {
  type Obs,
  type Condition,
  type Handler,
  type EffectsOf,
  defineStep,
  path,
  reconcile,
  runStepAsync,
  known,
  absent,
  unknown,
  yieldStep,
} from '@apsis-io/perseid/perseid.js'
import {
  type BindingFacts,
  type PolicyFacts,
  asCondition,
  decideGovernance,
  gazerPolicy,
} from './governance.js'

const observeCluster = reconcile.observeCluster()
const report = reconcile.status()

// BUILT, not typed. `ClusterPath` is a different canonical kind from a
// namespaced `ApiPath`, so `reconcile.observe` would refuse these and
// `observeCluster` requires them — the two read surfaces carry different
// confinement and the types say so.
const policyPath = path.cluster(
  'admissionregistration.k8s.io',
  'v1',
  'validatingadmissionpolicies',
  gazerPolicy.name,
)
const bindingPath = path.cluster(
  'admissionregistration.k8s.io',
  'v1',
  'validatingadmissionpolicybindings',
  gazerPolicy.name,
)

/**
 * Parse the facts the decision needs out of the object's JSON.
 *
 * ***TOTAL AND THREE-VALUED, BECAUSE SCHEMA DRIFT IS THE HAZARD OF SENDING A
 * WHOLE OBJECT.*** A guest reading a field the host stopped emitting gets
 * `undefined`, concludes something false, and nothing errors on either side. A
 * field that is not there is `unknown` — "I could not tell" — never a zero value.
 *
 * `failurePolicy` is the deliberate exception: Kubernetes defines UNSET as
 * `Fail`, so its absence is a known value rather than a gap.
 */
const policyFactsOf = (o: Obs<string>): Obs<PolicyFacts> => {
  if (o.t !== 'known') return o

  try {
    const spec = (JSON.parse(o.v) as { spec?: { failurePolicy?: string } }).spec ?? {}

    return known({ failurePolicy: spec.failurePolicy === 'Ignore' ? 'Ignore' : 'Fail' })
  } catch {
    return unknown
  }
}

const bindingFactsOf = (o: Obs<string>): Obs<BindingFacts> => {
  if (o.t !== 'known') return o

  try {
    const spec =
      (JSON.parse(o.v) as { spec?: { policyName?: string; validationActions?: string[] } }).spec ??
      {}

    // A binding with no policyName or no actions is not one this monitor can
    // reason about: `unknown`, never an empty one that would read as "targets
    // nothing" and produce a confident wrong verdict.
    if (typeof spec.policyName !== 'string' || !Array.isArray(spec.validationActions)) {
      return unknown
    }

    return known({
      policyName: spec.policyName,
      validationActions: spec.validationActions as BindingFacts['validationActions'],
    })
  } catch {
    return unknown
  }
}

const step = defineStep(function* () {
  const policy = policyFactsOf(yield* observeCluster(policyPath))
  const binding = bindingFactsOf(yield* observeCluster(bindingPath))

  yield* report(asCondition(decideGovernance(gazerPolicy, policy, binding)))

  // A MONITOR YIELDS RATHER THAN PARKS. Its subjects are cluster-scoped, and a
  // resume expression addresses objects in the grant's NAMESPACE — so there is
  // nothing it could name as a wake condition. Under a level-triggered host,
  // "look again next tick" is exactly right for a monitor.
  return yieldStep
})

type Effs = EffectsOf<typeof step>

/**
 * The world, as the host supplies it. `Handler<Effs>` is TOTAL: omit a key and
 * this does not compile, so the runner cannot fall behind the capability set.
 */
const hostHandler: Handler<Effs> = {
  // The variant crosses as `{ tag, val }` (dwarf's binding of WIT's `variant
  // obs`); the SDK's `Obs<T>` is `{ t, v }`. The conversion is why this cannot
  // be a cast — and `absent` must stay `absent`, because a deleted policy IS
  // the finding this monitor exists to report.
  // ***AWAITED, BECAUSE THE READ IS `async func`.*** Reading `.tag` off the
  // unawaited promise yields `undefined`, which falls through to `unknown` - the
  // program observes nothing and yields forever, looking healthy.
  get: async (p) => {
    const o = await hostGetCluster(p)

    return o.tag === 'known' ? known(o.val) : o.tag === 'absent' ? absent : unknown
  },
  // ***NOT A PASS-THROUGH, AND A CAST HERE WOULD COMPILE.*** The SDK's
  // `ConditionStatus` is Kubernetes' spelling (`'True'`); WIT's enum is
  // lowercase, so dwarf binds it lowercase. One `toLowerCase()` apart, and the
  // wrong one is a string either way — rejected at write time, invisible to the
  // step because `set` returns nothing.
  status: (c: Condition) => hostSet({ ...c, status: c.status.toLowerCase() as HostCondStatus }),
}

// Exported under a different local name: the WIT export must be called `step`,
// and `step` is already the generator that `derive-wit` reads the capability
// demand out of by declaration name.
const wake = wakeable()

const stepEntry = {
  // ***ASYNC BECAUSE ITS IMPORTS ARE, AND RACED SO IT CAN BE FREED.*** A step
  // blocked in a read cannot be stopped from outside; racing the wake future is
  // the only thing that frees it (ADR-0106). If the signal wins, the pass yields
  // rather than reporting a decision it never finished making.
  run: async (): Promise<string> => {
    const outcome = await Promise.race([
      runStepAsync(step, hostHandler),
      wake.signalled().then(() => ({ o: 'yield' }) as never),
    ])

    return JSON.stringify(outcome)
  },
}

const signalEntry = wake.handler()
export { stepEntry as step, signalEntry as signal }

export const run = {
  async run() {
    // Inside run(), never at module scope: dwarf's Wizer pre-init evaluates
    // top-level code at BUILD time, where there is no host to call.
    console.log(`governance monitor for ${gazerPolicy.name}`)
    console.log(stepEntry.run())
  },
}
