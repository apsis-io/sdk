// A Perseid as a COMPONENT: its capabilities are WIT imports, so they are
// checked at link time. This file is the join — the same step contract, with
// the world supplied by the host instead of by a handler object in-process.
//
// ***THE ACTION IS A TYPED IMPORT, AND THAT IS THE WHOLE POINT OF THE FILE.***
// Until 2026-08-21 this called `act('setReplicas', JSON.stringify({path, n}))` —
// one generic function reached through a STRING. Importing `emit` therefore told
// you a program could emit SOMETHING, and nothing in its types said what, so the
// authority to scale could not be derived from the artifact and needed a second
// hand-written list.
//
// `scale(path, n)` is the same obligation with the op and the JSON deleted. What
// it buys is not brevity: a program that was not granted
// `perseid:reconcile/workloads` cannot NAME this function, so the refusal is
// the linker's rather than a runtime branch further down.

import { get, count, now } from 'perseid:reconcile/observe@0.1.0'
// ⛔ ***MIGRATED OFF `workloads.scale` 2026-09-05, AND NOT BECAUSE IT IS
// DEPRECATED.*** Its GRANT was removed (internal/aperture/effects.go, engi
// 2026-09-01: "remove. will migrate later"): `IfaceWorkloads` confers nothing
// now, and `scale(path, n)` renders `Ensure(path, "spec.replicas", n)`, whose
// symbol only `perseid:reconcile/ensure` grants. A program importing `workloads`
// still LINKS - the interface exists - and every write it makes is REFUSED.
//
// This was the last program in the tree still on it; the perseid-ts programs and
// every live Perseid had already migrated.
import { ensure } from 'perseid:reconcile/ensure@0.1.0'

type Obs = { tag: 'known'; val: string } | { tag: 'absent' } | { tag: 'unknown' }

declare const wit: {
  Future: {
    (t: number): {
      readable: { read(): Promise<unknown> }
      writable: { write(v: unknown): void }
    }
    U32: number
  }
}

// ***THE WAKE, HAND-ROLLED FOR THE SAME REASON THE RESUME IS.*** This component
// is bundled without the SDK, so `wakeable()` is not available - but a program
// that reads MUST export `signal` (engi, 2026-09-04: "we forbid io if signal
// isn't exported"), and trail refuses to serve one that does not. See ADR-0106.
let waker: { write(v: unknown): void } | undefined

export const step = {
  async run(): Promise<string> {
    const f = wit.Future(wit.Future.U32)
    waker = f.writable
    const woken = f.readable.read().then(() => 'WOKEN')

    // ***AWAITED: the reads are `async func`.*** Unawaited, `.tag` is `undefined`
    // and every observation silently becomes `unknown`.
    const want = (await Promise.race([
      get('/apis/apps/v1/namespaces/default/deployments/demo'),
      woken,
    ])) as Obs | 'WOKEN'
    if (want === 'WOKEN') return JSON.stringify({ o: 'yield' })
    if (want.tag === 'absent') return JSON.stringify({ o: 'terminate' })
    if (want.tag === 'unknown') return JSON.stringify({ o: 'yield' })

    // ***A LABEL SELECTOR, NOT A PATH.*** engi decided the contract 2026-08-21
    // and reconcile.wit records why: a selector cannot NAME a namespace, so the
    // scope is the grant's and there is nothing for a program to bind wrongly.
    //
    // This line passed a path until then, which is why this component observed
    // its Deployment and then yielded forever: `labels.Parse` rejects a path,
    // `count` returns `unknown`, and `count` never throws by contract - so
    // nothing anywhere reported it. Live: 239 answered, 119 resolved.
    const have = (await count('app=demo')) as Obs
    if (have.tag !== 'known') return JSON.stringify({ o: 'yield' })

    const w = Number(want.val)
    const h = Number(have.val)
    if (h !== w) {
      ensure('/apis/apps/v1/namespaces/default/deployments/demo', 'spec.replicas', {
        tag: 'num',
        val: BigInt(w),
      })
      return JSON.stringify({ o: 'yield' })
    }
    // ***THE RESUME IS AN aperture EXPRESSION AS OF 2026-08-21 (engi).*** It was
    // `{ r: 'countNe', query: 'app=demo', n: w }` — a tagged union whose
    // discriminant had to be spelled the same way in four languages, and did
    // not. The Go host's struct field was `Kind`, so `"r"` matched nothing,
    // `json.Unmarshal` returned NIL ERROR, and the host refused this park as "an
    // EMPTY resume expression" while query and n sat decoded beside it.
    //
    // *** SO THIS COMPONENT HAS NEVER SUCCESSFULLY PARKED. *** It reached
    // quiesce, the host rejected the outcome, and nothing said so. One string
    // has no discriminant to lose.
    //
    // Written inline rather than via the SDK's `countNe` because this component
    // is bundled without the SDK — the expression is the wire format, so a
    // literal here is the same fact the helper would produce.
    return JSON.stringify({
      o: 'quiesce',
      at: Number(await now()),
      resume: `ListPods("app=demo").length != ${w}`,
    })
  },
}

// SYNC: it runs on a stack with no task state while `run` is suspended.
export const signal = {
  signal(code: number): string {
    if (waker === undefined) return 'running'
    waker.write(code)
    waker = undefined

    return 'terminating'
  },
  // NEVER CALLED - see `wake-carrier` in wit/reconcile/reconcile.wit.
  wakeCarrier(): unknown {
    const f = wit.Future(wit.Future.U32)
    f.writable.write(0)

    return f.readable
  },
}
