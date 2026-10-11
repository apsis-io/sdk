// apogeos' gazer-governance monitor, ported to the Perseid contract.
//
//	bun src/governance.ts
//
// The original is `internal/apogeos/gazergovernance.go`. It asks one question —
// *is the fleet's Gazer authorisation actually in force?* — and reports a
// verdict. It does not mutate anything, which is what makes it the best of the
// twenty-six apogeos controllers to port first: a Perseid can already WRITE what
// it produces.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***IT IS NOW FULLY PORTED, AND THE READ IS WHY THIS FILE EXISTED AS A STUB
// FIRST.***
//
// THE DECISION — the half the Go file itself calls valuable: *"the decision is
// the part worth testing exhaustively, and a function that reaches for a cluster
// cannot be."* Pure there, pure here, same seven cases as
// `TestEvaluateGazerGovernance` plus one the Go version needs a second function
// for (a failed read), which `Obs` carries natively.
//
// THE REPORT — `SetCondition` is self-targeted, so a verdict and its reason were
// expressible before any of this.
//
// THE READ — blocked until 2026-08-29, and the blocker was measured rather than
// assumed. The monitor fetches a `ValidatingAdmissionPolicy` and its `Binding`,
// which are CLUSTER-SCOPED, and `observe.get` confines a path by comparing its
// namespace to the grant's. A cluster-scoped object has none, so that comparison
// is structurally incapable of confining it - which made admitting one a
// DECISION rather than a patch.
//
// ***WHAT THIS FILE DID NOT DO WHILE IT WAS BLOCKED IS THE PART WORTH KEEPING.***
// `unsafeApiPath` would have made the observation compile, and the host would
// have answered `unknown` forever: `get` never throws by contract, so the
// monitor would have reported nothing and looked healthy. That is the exact
// failure this contract has paid for twice (`observe('replicas')`,
// `count(path)`), and shipping a third to make an example run would have been
// the worst possible trade.
//
// engi decided the authority model instead: a SEPARATE interface
// (`perseid:reconcile/observe-cluster`) confers the verb at link time, and
// `spec.reads` names WHICH objects, by exact path. Both halves are required, and
// they mirror how writes already work - importing `workloads` allows scaling,
// `spec.writes` says of what.
//
// The Perseid this file needs therefore declares BOTH:
//
//	spec:
//	  capabilities:
//	    - perseid:reconcile/observe-cluster@0.1.0
//	    - perseid:reconcile/status@0.1.0
//	  reads:
//	    - /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies/apsis-gazer-owns-itself
//	    - /apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings/apsis-gazer-owns-itself
//
// Omit `reads` and every observation is `absent` - "not in your world" is
// correctly indistinguishable from "not there" - so the monitor reports the
// policy as deleted. That is a loud, correct-looking wrong answer, and it is why
// the grant is per-object rather than per-kind.
// ═══════════════════════════════════════════════════════════════════════════

import { match, matchValue, when } from '@apsis-io/perseid/match'
import {
  type Obs,
  type Condition,
  type Outcome,
  defineStep,
  path,
  reconcile,
  runStep,
  known,
  absent,
  unknown,
  yieldStep,
} from '@apsis-io/perseid/perseid'

// ---------------------------------------------------------------------------
// The facts the decision needs. A projection of the two objects, not the
// objects: the Go original takes the typed API structs and reads four fields
// off them, and carrying the rest would make the decision look like it depends
// on more than it does.

/** What matters about a `ValidatingAdmissionPolicy`. */
export type PolicyFacts = {
  /** `spec.failurePolicy`. ABSENT means unset, and unset defaults to `Fail`. */
  readonly failurePolicy?: 'Fail' | 'Ignore'
}

/** What matters about a `ValidatingAdmissionPolicyBinding`. */
export type BindingFacts = {
  /** `spec.policyName` — which policy this binding actually targets. */
  readonly policyName: string
  /** `spec.validationActions`. */
  readonly validationActions: readonly ('Deny' | 'Warn' | 'Audit')[]
}

/** The policy under audit, as `gazerPolicy` describes it in Go. */
export type GovernedPolicy = {
  readonly name: string
  readonly governs: string
  readonly stake: string
}

export type Verdict = 'enforced' | 'not-enforced' | 'unknown'

export type Finding = { readonly verdict: Verdict; readonly reason: string }

// ---------------------------------------------------------------------------
// The decision.

/**
 * Decide whether a governed policy is actually in force.
 *
 * ***THE THREE-VALUED INPUT IS WHAT THE PORT ADDS, AND IT MERGES TWO GO
 * FUNCTIONS.*** `evaluatePolicyGovernance` takes pointers where `nil` means
 * "does not exist", and a SEPARATE wrapper (`gazerGovernanceCheck`) turns a
 * failed read into `unknown` — `TestGazerGovernanceCheck_AFailedReadIsUnknown`
 * pins that split.
 *
 * `Obs` already carries the distinction, so the two collapse into one function
 * and the collapse cannot lose it: there is no way to write this signature such
 * that a failed read and a deleted object arrive as the same value. That is the
 * single most repeated defect in this codebase, designed out rather than tested
 * for.
 */
export function decideGovernance(
  gp: GovernedPolicy,
  policy: Obs<PolicyFacts>,
  binding: Obs<BindingFacts>,
): Finding {
  // A read that did not resolve is not an absent object. Reporting
  // "not enforced" from an apiserver blip would raise a false alarm about the
  // fleet's authorisation; reporting nothing at all would hide a real one.
  if (policy.t === 'unknown' || binding.t === 'unknown') {
    return {
      verdict: 'unknown',
      reason: `could not read policy ${gp.name} or its binding: the check did not run, ` +
        `which is not the same as the check passing (ADR-0076)`,
    }
  }

  if (policy.t === 'absent') {
    return {
      verdict: 'not-enforced',
      reason: `ValidatingAdmissionPolicy "${gp.name}" does not exist: ${gp.stake}`,
    }
  }

  // ***THE POLICY EXISTS AND IS INERT.*** An unbound policy validates nothing
  // and looks entirely healthy to anyone checking that the policy exists.
  if (binding.t === 'absent') {
    return {
      verdict: 'not-enforced',
      reason: `ValidatingAdmissionPolicyBinding "${gp.name}" does not exist: the policy is ` +
        `present and INERT - an unbound policy validates nothing, and looks entirely ` +
        `healthy to anyone checking that the policy exists`,
    }
  }

  if (binding.v.policyName !== gp.name) {
    return {
      verdict: 'not-enforced',
      reason: `binding '${gp.name}' targets policy '${binding.v.policyName}', not ` +
        `'${gp.name}': both objects exist and neither governs ${gp.governs}`,
    }
  }

  // ***THE ONE AN EXISTENCE CHECK CANNOT SEE.*** Both objects present, healthy
  // to every dashboard, and nothing is denied. The manifest's own words: "A
  // reporter here is MORE dangerous than an open hole: it generates evidence of
  // working."
  if (!binding.v.validationActions.includes('Deny')) {
    return {
      verdict: 'not-enforced',
      reason: `binding '${gp.name}' has validationActions ` +
        `[${binding.v.validationActions.join(', ')}] and does not include Deny: violations ` +
        `are REPORTED and ADMITTED. This generates evidence of working while enforcing nothing`,
    }
  }

  // failurePolicy defaults to Fail when unset, which is the safe value, so only
  // an explicit Ignore is a finding. MEASURED on the live cluster (ADR-0081):
  // with an expression that ERRORS - not one returning false - Ignore ADMITS.
  if (policy.v.failurePolicy === 'Ignore') {
    return {
      verdict: 'not-enforced',
      reason: `policy '${gp.name}' has failurePolicy: Ignore: a CEL expression that ERRORS ` +
        `now ADMITS the write. A check that could not run is not a check that passed (ADR-0076)`,
    }
  }

  return { verdict: 'enforced', reason: `policy '${gp.name}' is bound and denying` }
}

// ---------------------------------------------------------------------------
// The report — expressible with today's host.

/**
 * A finding as a Kubernetes condition on the Perseid's OWN object.
 *
 * `type` is the condition's IDENTITY: a second `set` with `Governed` replaces
 * this one rather than appending. `status` is Kubernetes' spelling, and the
 * SDK's union makes `'true'` a compile error — a lower-cased value is
 * well-formed JSON that fails apiserver validation, and `set` returns nothing,
 * so the step could never see the rejection.
 *
 * ***`unknown` REPORTS AS `Unknown`, NOT AS `False`.*** Collapsing them would
 * turn an apiserver blip into an alarm that the fleet's authorisation is off -
 * and `condition-status` is three-valued in the WIT for exactly this reason.
 */
export const asCondition = (f: Finding): Condition => ({
  type: 'Governed',
  status: matchValue({ o: f.verdict } as { o: Verdict }, 'o', {
    enforced: () => 'True' as const,
    'not-enforced': () => 'False' as const,
    unknown: () => 'Unknown' as const,
  }),
  reason: matchValue({ o: f.verdict } as { o: Verdict }, 'o', {
    enforced: () => 'PolicyBoundAndDenying',
    'not-enforced': () => 'PolicyNotEnforced',
    unknown: () => 'PolicyUnreadable',
  }),
  message: f.reason,
})

const report = reconcile.status()

/**
 * The reporting half of the monitor, as a real step.
 *
 * It YIELDS the condition, so `derive-wit` reads `perseid:reconcile/status`
 * out of its type and the component's world names it. This is the part that
 * runs today; the observation above it is what does not.
 *
 * It returns `yieldStep` rather than parking: a governance monitor has nothing
 * to wait FOR that it could name as a resume expression — the objects it watches
 * are not addressable by a Perseid at all, which is the same gap by a different
 * door. Under a level-triggered host that means "look again next tick", which is
 * exactly right for a monitor.
 */
export const reportFinding = (f: Finding) =>
  defineStep(function* () {
    yield* report(asCondition(f))

    return yieldStep
  })

// ---------------------------------------------------------------------------
// ⭐ THE STEP. It reads two CLUSTER-SCOPED objects and reports a verdict.
//
// ***THIS WAS A COMMENT EXPLAINING WHY IT COULD NOT EXIST.*** The blocker was
// real and measured: `observe.get` is confined by comparing a path's namespace
// to the grant's, and a cluster-scoped object has none, so admitting one was a
// decision rather than a patch. engi made it on 2026-08-29 - a separate
// interface confers the verb at link time, `spec.reads` names the objects - and
// the host now serves it end to end.
//
// The two paths are BUILT, and they are a different canonical kind from a
// namespaced one: `path.cluster(...)` yields `ClusterPath`, which
// `reconcile.observe` will not accept and `observeCluster` requires. The
// confinement each surface carries is different, so the types are too.

export const gazerPolicy: GovernedPolicy = {
  // ⛔ RENAMED 2026-09-03. The policy was `perigeos-gazer-identity` until it
  // became `apsis-gazer-owns-itself`; this constant kept the old name and the
  // monitor reported `PolicyNotEnforced — "any node could claim any Gazer
  // identity"` for four days. TRUE about the name, FALSE about the danger: the
  // real policy was deployed and enforcing throughout.
  //
  // ⚠ THIS NAME AND THE PERSEID'S `spec.reads` ARE TWO DECLARATIONS THAT MUST
  // AGREE AND NOTHING MAKES THEM. `spec.reads` AUTHORISES a path; this chooses
  // which path to look up. Correcting only the grant does not fix it and makes
  // the symptom WORSE — the lookup then goes ungranted, and an authorisation
  // refusal returns `absent`, which is deliberately indistinguishable from the
  // object being missing. Same message, different cause. Change both together.
  name: 'apsis-gazer-owns-itself',
  governs: 'which node may claim a Gazer identity',
  stake: 'any node could claim any Gazer identity',
}

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

const observeCluster = reconcile.observeCluster()

/**
 * Parse the facts the decision needs out of the object's JSON.
 *
 * ***TOTAL AND THREE-VALUED, FOR THE REASON `obs` IS.*** The host sends the
 * whole object because a cluster-scoped object has no single scalar a
 * reconciler maintains. That makes SCHEMA DRIFT the hazard: a guest reading a
 * field the host stopped sending gets `undefined`, concludes something false,
 * and nothing errors on either side.
 *
 * So a field that is not there is `unknown` - "I could not tell" - and never a
 * zero value. `failurePolicy` is the exception and deliberately so: Kubernetes
 * defines UNSET as `Fail`, so its absence is a known value rather than a gap.
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
    const spec = (JSON.parse(o.v) as {
      spec?: { policyName?: string; validationActions?: string[] }
    }).spec ?? {}

    // A binding with no policyName or no actions is not a binding this monitor
    // can reason about - `unknown`, not an empty one that would read as "targets
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

export const step = defineStep(function* () {
  const policy = policyFactsOf(yield* observeCluster(policyPath))
  const binding = bindingFactsOf(yield* observeCluster(bindingPath))

  yield* report(asCondition(decideGovernance(gazerPolicy, policy, binding)))

  // A MONITOR YIELDS RATHER THAN PARKS. Its subjects are cluster-scoped, and a
  // resume expression addresses objects by the grant's namespace - so there is
  // nothing it could name as a wake condition. Under a level-triggered host
  // "look again next tick" is exactly right for a monitor.
  return yieldStep
})

// ---------------------------------------------------------------------------
// The demo: the seven decisions, and the report path driven for real.

const deny = ['Deny'] as const
const warn = ['Warn'] as const

const cases: readonly (readonly [string, Obs<PolicyFacts>, Obs<BindingFacts>])[] = [
  ['enforced', known({ failurePolicy: 'Fail' }), known({ policyName: gazerPolicy.name, validationActions: deny })],
  ['failurePolicy unset', known({}), known({ policyName: gazerPolicy.name, validationActions: deny })],
  ['policy deleted', absent, known({ policyName: gazerPolicy.name, validationActions: deny })],
  ['binding deleted', known({ failurePolicy: 'Fail' }), absent],
  ['actions are Warn', known({ failurePolicy: 'Fail' }), known({ policyName: gazerPolicy.name, validationActions: warn })],
  ['binding targets another', known({ failurePolicy: 'Fail' }), known({ policyName: 'something-else', validationActions: deny })],
  ['failurePolicy Ignore', known({ failurePolicy: 'Ignore' }), known({ policyName: gazerPolicy.name, validationActions: deny })],
  ['read failed', unknown, known({ policyName: gazerPolicy.name, validationActions: deny })],
]

if (import.meta.main) {
  console.log(`auditing ${gazerPolicy.name}\n`)

  for (const [label, policy, binding] of cases) {
    const finding = decideGovernance(gazerPolicy, policy, binding)
    const emitted: string[] = []

    // The report path, driven against a fake world - the same shape radiant
    // supplies in production.
    const outcome: Outcome = runStep(reportFinding(finding), {
      status: (c) => {
        emitted.push(`set(${c.type}=${c.status} ${c.reason})`)
      },
    })

    console.log(`${label.padEnd(24)} ${finding.verdict.padEnd(13)} ${emitted.join('')}`)
    console.log(`${''.padEnd(24)} ${finding.reason.slice(0, 96)}`)
    void outcome
  }
}

void match
void when
