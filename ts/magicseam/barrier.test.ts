import { describe, expect, test } from "bun:test"
import { Barrier, DrainTimeoutError } from "./barrier.js"
import { CAP_BARRIER, barrierAgreed, capsOffered, opcodeOnWire, parseCaps } from "./stream.js"

describe("capability advertising", () => {
  // THE DANGEROUS DIRECTION, and the one the Go SDK shipped wrong. A provider
  // with NO barrier must not advertise the token: it would ack a marker without
  // draining and without refusing, so the coordinator reads that ack as "my
  // channel is empty", snapshots, and takes a torn cut from a provider that
  // never stopped serving. It also defeats the guard meant to catch it, since
  // trail fails a barrier when a peer does NOT advertise the capability.
  test("no barrier means no advertised capability", () => {
    expect(parseCaps(Buffer.from(capsOffered(false)))).not.toContain(CAP_BARRIER)
  })

  test("a configured barrier is advertised", () => {
    expect(parseCaps(Buffer.from(capsOffered(true)))).toContain(CAP_BARRIER)
  })

  // Two-sided (§5): the peer must advertise it AND we must actually have one.
  test("barrier requires both sides", () => {
    expect(barrierAgreed([CAP_BARRIER], true)).toBe(true)
    expect(barrierAgreed([CAP_BARRIER], false)).toBe(false)
    expect(barrierAgreed(["stream"], true)).toBe(false)
  })

  // The spec defines barrier as two-sided but never says it requires stream, so
  // a conforming consumer may advertise barrier ALONE. Gating the opcode read on
  // stream only means its OP_MARKER is eaten as caller-frame length and the
  // marker becomes a garbled call - the failure §5 makes barrier two-sided to
  // prevent, arriving by the other door. Found and fixed in the Go SDK first.
  test("barrier alone still puts the opcode on the wire", () => {
    expect(opcodeOnWire([CAP_BARRIER], true)).toBe(true)
    expect(opcodeOnWire(["stream"], false)).toBe(true)
    expect(opcodeOnWire([], true)).toBe(false)
    // ...and the peer's claim alone must NOT open it, or the first byte of an
    // ordinary call is eaten by a capability neither end is using.
    expect(opcodeOnWire([CAP_BARRIER], false)).toBe(false)
  })
})

describe("the drain contract", () => {
  // THE ACK MEANS "MY CHANNEL IS EMPTY", not "I received your marker". arm()
  // must not resolve while a call is in flight, because the coordinator treats
  // the ack as permission to snapshot.
  test("arm does not resolve while a call is in flight", async () => {
    const b = new Barrier()
    const done = b.enter()
    await expect(b.arm(50)).rejects.toBeInstanceOf(DrainTimeoutError)
    done()
  })

  test("arm resolves once the channel drains", async () => {
    const b = new Barrier()
    const done = b.enter()
    setTimeout(done, 20)
    await b.arm(2000)
    expect(b.armed).toBe(true)
  })

  // §8 rule 3: a FAILED drain leaves the barrier ARMED. Un-arming would silently
  // resume a provider the coordinator still believes it is negotiating with - it
  // never got an ack, so it will send a Resume on its abort path.
  test("a failed drain leaves it armed", async () => {
    const b = new Barrier()
    b.enter()
    await expect(b.arm(20)).rejects.toBeInstanceOf(DrainTimeoutError)
    expect(b.armed).toBe(true)
  })

  // Resume must never wait to drain: the abort path exists precisely for a
  // provider that is busy.
  test("resume never waits", async () => {
    const b = new Barrier()
    b.enter()
    await expect(b.arm(10)).rejects.toBeInstanceOf(DrainTimeoutError)
    const t0 = Date.now()
    b.resume()
    expect(Date.now() - t0).toBeLessThan(5)
    expect(b.armed).toBe(false)
  })
})

describe("the arm lease", () => {
  // A consumer that dies mid-barrier can never send the Resume - it travels on
  // that consumer's own connection and no other party knows the barrier exists.
  // Without a lease the provider refuses every caller forever. Measured in the
  // Go SDK, cleared only by a manual restart.
  test("an abandoned arm releases itself", async () => {
    const b = new Barrier(30)
    await b.arm(1000)
    expect(b.armed).toBe(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(b.armed).toBe(false)
  })

  test("an arm inside its lease is untouched", async () => {
    const b = new Barrier(60_000)
    await b.arm(1000)
    await new Promise((r) => setTimeout(r, 20))
    expect(b.armed).toBe(true)
  })

  // armedForMs is readiness's INDEPENDENT reader: it never runs the release, so
  // a lease that silently fails to fire is still visible. Routing readiness
  // through `armed` would make the lease its own alibi.
  test("armedForMs does not release the arm", async () => {
    const b = new Barrier(20)
    await b.arm(1000)
    await new Promise((r) => setTimeout(r, 40))
    expect(b.armedForMs).toBeGreaterThanOrEqual(40)
  })
})
