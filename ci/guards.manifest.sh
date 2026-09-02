#!/usr/bin/env bash
# THE GUARD MANIFEST - every entry is a claim that a specific test CAN FAIL.
#
# Each `guard` call names a defect, breaks the code that prevents it, and names
# the test that must go red. If the test stays green the guard is not actually
# tested, and the entry fails the gate.
#
#   guard <name> <package> <test-regex> <file> <old> <new>
#
# `old` must appear EXACTLY ONCE in `file`. The mutated code must still COMPILE:
# a mutation that breaks the build makes `go test` fail for the wrong reason.
#
# ***THESE TEN CAME FROM periapsis/ci/guards.manifest.sh ON 2026-09-02***, when
# this SDK was extracted into its own repo. The claims did not change - only the
# paths lost their `sdk/` prefix, because that prefix WAS this repo.
#
# ***THERE IS NO RUNNER HERE YET, SO THIS FILE IS DATA AND NOT A GATE.***
# periapsis/ci/verify-guards.sh mutates files inside a git worktree of periapsis
# and reverts them with `git -C "$WORKTREE" checkout`. It cannot reach across a
# repo boundary, so leaving these entries there would have meant ten guards
# failing on files it can no longer see - and the honest reading of that is not
# "these guards are fine", it is "these guards are unverified".
#
# They were MOVED rather than deleted because the claims are still true and
# still worth gating; what is missing is the harness, not the coverage. Port
# verify-guards.sh (or point a copy at this repo) and this becomes a gate again.

# ---------------------------------------------------------------------------
# go/magicseam: the marker ack means the channel is EMPTY, and a FAILED drain leaves
# the provider armed (the coordinator's abort path sends the Resume). Both are
# what make a non-native provider a real barrier member rather than one that
# claims to have stopped.
# ---------------------------------------------------------------------------
guard "go sdk: ack means the channel is empty" \
    ./go/magicseam/ \
    'TestArmDoesNotReturnWhileACallIsInFlight|TestArmTimesOutWithAnExplanation' \
    go/magicseam/barrier.go \
    '	deadline := time.Now().Add(timeout)' \
    '	if true {
		return nil
	}
	deadline := time.Now().Add(timeout)'

guard "go sdk: a failed drain stays armed" \
    ./go/magicseam/ \
    'TestAFailedDrainLeavesTheBarrierArmed' \
    go/magicseam/barrier.go \
    '		if time.Now().After(deadline) {
			return fmt.Errorf(' \
    '		if time.Now().After(deadline) {
			b.armed.Store(false)
			return fmt.Errorf('

# ---------------------------------------------------------------------------
# go/magicseam: an ARMED provider must REFUSE calls. Unobservable from the ack alone -
# a provider that acks and keeps serving looks identical to a quiesced one until
# a snapshot is taken on the strength of it. The same bug was live-caught in
# trail; this pins the Go side against a consumer written from the spec.
# ---------------------------------------------------------------------------
guard "go sdk: an armed provider refuses calls" \
    ./go/magicseam/ \
    'TestGoProviderAnswersSpecWrittenMarkers' \
    go/magicseam/quic.go \
    '	if barrier != nil && barrier.Armed() {' \
    '	if false {'

guard "no barrier means no advertised capability" \
    ./go/magicseam/ \
    'TestNoBarrierMeansNoCapability' \
    go/magicseam/stream.go \
    '	if hasBarrier {
		caps = append(caps, CapBarrier)
	}' \
    '	caps = append(caps, CapBarrier)
	_ = hasBarrier'

guard "a barrierless provider refuses a marker rather than acking it" \
    ./go/magicseam/ \
    'TestABarrierlessProviderRefusesMarkers' \
    go/magicseam/quic.go \
    '	if barrier == nil {
		stream.Close()

		return
	}' \
    '	if barrier == nil {
		barrier = new(Barrier) // a throwaway that arms trivially, i.e. acks a lie
	}'

guard "an abandoned arm releases itself" \
    ./go/magicseam/ \
    'TestAnAbandonedArmReleasesItself' \
    go/magicseam/barrier.go \
    '	if b.leaseExpired() {
		return false
	}' \
    '	_ = b.leaseExpired()'

guard "a re-arm refreshes the lease" \
    ./go/magicseam/ \
    'TestReArmingRefreshesTheLease' \
    go/magicseam/barrier.go \
    '	b.armedAt.Store(time.Now().UnixNano())' \
    '	b.armedAt.CompareAndSwap(0, time.Now().UnixNano())'

guard "lowering the Go lease is caught by trail's ordering test" \
    RUST:cmd/trail \
    'barrierlease::tests::the_consumer' \
    go/magicseam/barrierlease.go \
    'const DefaultLeaseTimeout = 2 * time.Minute' \
    'const DefaultLeaseTimeout = 60 * time.Second'

guard "the opcode gate opens for barrier as well as stream" \
    ./go/magicseam/ \
    'TestBarrierWithoutStreamStillReadsTheOpcode' \
    go/magicseam/quic.go \
    '	op := opCall
	if opcodeExpected {' \
    '	op := opCall
	if streamsNegotiated {'

guard "barrier is two-sided: the peer's claim alone does not open the gate" \
    ./go/magicseam/ \
    'TestAPeersBarrierClaimAloneDoesNotOpenTheOpcodeGate' \
    go/magicseam/stream.go \
    '	if !hasBarrier {
		return false
	}' \
    '	_ = hasBarrier'
