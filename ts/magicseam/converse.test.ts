import { describe, expect, test } from "bun:test"
import {
  CAP_BARRIER,
  CAP_CONVERSE,
  CAP_STREAM,
  CONV_ASK,
  CONV_DONE,
  OP_CALL,
  OP_CONVERSE,
  OP_MARKER,
  OP_MARKER_ACK,
  OP_RESUME,
  OP_STREAM,
  capsOffered,
  parseCaps,
} from "./stream.js"

describe("converse capability", () => {
  // ***ADVERTISED IFF SERVED, IN BOTH DIRECTIONS.***
  //
  // This is the whole safety property of the token and it is asymmetric in a way
  // that makes only one direction obvious. Under-advertising is loud: a caller
  // asks `converseServed`, gets false, and is refused up front with "peer does
  // not support the converse seam" - the exact error radiant saw for days, and a
  // GOOD error. Over-advertising is silent: the caller sends OP_CONVERSE, the
  // provider has nothing to dispatch to, and both ends sit reading. There is no
  // error path because nobody has done anything wrong on the wire.
  //
  // So the second assertion here is the load-bearing one, and it is the one a
  // test written from "does converse work" would omit.
  test("the token appears only when a handler was supplied", () => {
    expect(parseCaps(Buffer.from(capsOffered(false, true)))).toContain(CAP_CONVERSE)
    expect(parseCaps(Buffer.from(capsOffered(false, false)))).not.toContain(CAP_CONVERSE)
  })

  // DEFAULTING MATTERS BECAUSE EVERY EXISTING CALLER OMITS THE ARGUMENT.
  // `capsOffered(barrier !== undefined)` is what this SDK shipped with, and if
  // the new parameter defaulted to true every provider written before converse
  // existed would start advertising it the moment it was linked.
  test("an omitted argument does not advertise", () => {
    expect(parseCaps(Buffer.from(capsOffered()))).not.toContain(CAP_CONVERSE)
    expect(parseCaps(Buffer.from(capsOffered(true)))).not.toContain(CAP_CONVERSE)
  })

  // Converse must not disturb what was already negotiated. A provider with a
  // barrier and a converse handler advertises BOTH plus the bulk seam.
  test("it composes with the existing tokens rather than replacing them", () => {
    const caps = parseCaps(Buffer.from(capsOffered(true, true)))
    expect(caps).toContain(CAP_STREAM)
    expect(caps).toContain(CAP_BARRIER)
    expect(caps).toContain(CAP_CONVERSE)
  })

  // ***THE OPCODE MUST NOT COLLIDE WITH ANY OTHER.*** Checked as a SET over every
  // pair rather than against the neighbour it was added next to: OP_CONVERSE was
  // appended after OP_RESUME, so comparing it only to OP_RESUME would pass while
  // it silently aliased OP_CALL. rust/seamwire/src/lib.rs carries the same
  // all-pairs test for the same reason.
  test("every opcode is distinct", () => {
    const ops = [OP_CALL, OP_STREAM, OP_MARKER, OP_MARKER_ACK, OP_RESUME, OP_CONVERSE]
    expect(new Set(ops).size).toBe(ops.length)
    expect(OP_CONVERSE).toBe(5)
  })

  // The conversation tags live in their OWN namespace - they are the first byte
  // of a callee frame, not an opcode - so CONV_ASK deliberately shares the value
  // 0 with OP_CALL and that is not a collision. What must hold is that the two
  // tags differ from each other, since one ends the conversation and the other
  // does not.
  test("the conversation tags are distinct from each other", () => {
    expect(CONV_ASK).not.toBe(CONV_DONE)
    expect(CONV_ASK).toBe(0)
    expect(CONV_DONE).toBe(1)
  })

  // ***THE MUTANT, WRITTEN HERE RATHER THAN APPLIED TO stream.ts.***
  //
  // The advertise-iff-served test above has both arms, so reading it says it
  // cannot pass on a broken capsOffered. Reading is what this repo distrusts, and
  // mutating the shared source would red every peer running `bun test` for as
  // long as it sat there. For a pure function the equivalent is to write the
  // wrong implementation here and assert the same inputs SEPARATE the two.
  //
  // `alwaysAdvertises` is not a strawman: dropping the flag and always pushing
  // the token is the smallest edit that makes converse "work" in a hand test,
  // and it is precisely the over-advertisement that hangs a caller instead of
  // refusing it.
  test("the inputs above would catch an unconditional advertiser", () => {
    const alwaysAdvertises = (_hasBarrier = false, _hasConverse = false): string =>
      [CAP_STREAM, CAP_CONVERSE].join(",")

    // The mutant must actually differ, or this test proves nothing.
    expect(parseCaps(Buffer.from(alwaysAdvertises(false, true)))).toContain(CAP_CONVERSE)
    // ...and the discriminating input is the one where NO handler was supplied.
    expect(parseCaps(Buffer.from(alwaysAdvertises(false, false)))).toContain(CAP_CONVERSE)
    expect(parseCaps(Buffer.from(capsOffered(false, false)))).not.toContain(CAP_CONVERSE)
  })

  // WIRE PARITY WITH THE OTHER IMPLEMENTATIONS, ASSERTED ON THE LITERALS.
  //
  // These values are spelled independently in rust/seamwire/src/lib.rs and
  // go/magicseam/converse.go with no shared source, and the protocol doc
  // names that as the standing drift hazard. A mismatch here does not fail at
  // connect time - it misframes a conversation, which presents as a hang.
  test("the token and tag values match trail and the Go SDK", () => {
    expect(CAP_CONVERSE).toBe("converse")
    expect(OP_CONVERSE).toBe(5)
    expect(CONV_ASK).toBe(0)
    expect(CONV_DONE).toBe(1)
  })
})
