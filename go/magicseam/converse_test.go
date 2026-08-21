// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// converseRig stands a provider up with a converse handler and dials it.
// converseRig stands a provider up and returns a connected client.
//
// ═══════════════════════════════════════════════════════════════════════════
// ***THE `port` ARGUMENT IS IGNORED AND THE FIXED SLEEP IS GONE. BOTH WERE
// LOAD-SENSITIVE AND BOTH FAILED IN A REAL SWEEP*** (radiant-main hit it at
// 02:41 mid-verification of an unrelated change; reproduced here, **4 of 5
// concurrent runs red**).
//
//	FIXED PORTS   callers passed 19801/19802/19803/19812. `go test` serialises
//	              WITHIN a package, so one sweep is fine — but **two agents
//	              running `go test ./...` at the same time bind the same port**,
//	              and this machine has two dozen of them. A worktree does not
//	              isolate a port; that is a host-global resource and the
//	              control for it is two concurrent runs, which is exactly what
//	              was happening.
//	`Sleep(150ms)` a guess at how long `ServeQUICWithConverse` needs to bind.
//	              Under load it is not enough and the dial fails immediately —
//	              **the 0.15 s failures.** The 5.15 s ones are the same rig
//	              failing later against a context deadline.
//
// ***PORT 0 AND A RETRY LOOP.*** The OS assigns a free port, so concurrent runs
// cannot collide by construction rather than by luck; and the readiness gate is
// **a successful dial** rather than a duration, so it is correct on a loaded box
// and faster on an idle one.
//
// ***THE `port` PARAMETER IS GONE RATHER THAN IGNORED.*** Keeping it as `_` left
// four dead `"19801"`-shaped literals at the call sites, and a census of
// hardcoded ports in this package would still have counted them — the
// retirement-notice-pollutes-the-census defect, measured in this repo tonight on
// a WIT deletion notice.
//
// ***AND THE FIRST VERSION OF THIS PARAGRAPH WAS ITSELF THE ONLY HIT.*** It said
// *"a grep for <loopback>:19 here now returns zero"* — and spelled the pattern
// out, so the census found exactly one match: this sentence. **The notice
// documenting the pollution polluted the census, within a minute of being
// written.** The remedy is the one already recorded for retired symbols: name the
// thing WITHOUT writing the matchable form. A census of fixed loopback ports in
// this package now returns zero, and this comment does not spell one.
// ═══════════════════════════════════════════════════════════════════════════
func converseRig(t *testing.T, h ConverseHandler) *QUICClient {
	t.Helper()
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	addr := freeAddr(t)
	ctx := t.Context()
	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	go func() {
		_ = ServeQUICWithConverse(ctx, "tcp:"+addr,
			providerCert, providerKey, providerCA, "0.1.0", echo, nil, h)
	}()

	client, err := dialWhenReady(t, ctx, addr, consumerCert, consumerKey, consumerCA)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	return client
}

// freeAddr returns a `127.0.0.1:PORT` the kernel just told us is free.
//
// PORT 0, then release. QUIC is UDP, so this reserves the right family. There is
// a small window between close and re-bind; it is strictly better than a
// constant that is GUARANTEED to collide with a concurrent run.
func freeAddr(t *testing.T) string {
	t.Helper()
	probe, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve a port: %v", err)
	}
	addr := probe.LocalAddr().String()
	_ = probe.Close()

	return addr
}

// dialQUICWhenReady is dialWhenReady for the ORDINARY entry point.
//
// Two functions rather than one because the two dials are different calls —
// `DialQUIC` and `DialQUICForConverse` — and several tests depend on which one
// they use (a plain dial against a converse-advertising peer is refused for a
// DIFFERENT reason, which one of them asserts). Collapsing them behind a flag
// would put that distinction in a boolean.
func dialQUICWhenReady(
	t *testing.T, ctx context.Context, addr string, cert, key, ca, version string,
) (*QUICClient, error) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		client, err := DialQUIC(ctx, "tcp:"+addr, cert, key, ca, version)
		if err == nil {
			return client, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("provider never became dialable at %s within 10s "+
				"(a REAL failure, not the old 150ms guess): %w", addr, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// dialWhenReady retries until the provider answers, instead of sleeping a guess.
//
// ***READINESS IS A SUCCESSFUL DIAL, NOT A DURATION.*** The old `Sleep(150ms)`
// was a guess at bind time: correct on an idle box, wrong on a loaded one, and
// it produced the 0.15 s failures. Retrying is correct under load AND faster
// when there is none. The 10 s ceiling is long enough that a failure here is a
// real one rather than another guess.
func dialWhenReady(
	t *testing.T, ctx context.Context, addr string, cert, key, ca string,
) (*QUICClient, error) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		client, err := DialQUICForConverse(ctx, "tcp:"+addr, cert, key, ca, "0.1.0")
		if err == nil {
			return client, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("provider never became dialable at %s within 10s "+
				"(this is a REAL failure, not the old 150ms guess): %w", addr, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// THE WHOLE POINT: THE CALLEE ASKS QUESTIONS MID-CALL AND THE ANSWERS COME FROM
// THE CALLER'S OWN STATE.
//
// This is what request/reply cannot do, and it is why the op exists. A Perseid
// step computes the paths it observes FROM WHAT EARLIER OBSERVATIONS SAID, so
// the second question here depends on the answer to the first - exactly the
// shape a pre-sent manifest of observations cannot express.
func TestConverse_CalleeAsksAndCallerAnswersFromItsOwnState(t *testing.T) {
	// The callee asks twice, and its SECOND question is derived from the first
	// answer. Nothing about that is expressible in a request/reply call.
	handler := func(_ context.Context, c *Conversation) ([]byte, error) {
		first, err := c.Ask([]byte("replicas-of:web"))
		if err != nil {
			return nil, err
		}
		second, err := c.Ask([]byte("scale-to:" + string(first)))
		if err != nil {
			return nil, err
		}

		return []byte("done:" + string(second)), nil
	}
	client := converseRig(t, handler)

	var asked []string
	reply, err := client.Converse(t.Context(), []byte("run"), func(_ context.Context, ask []byte) ([]byte, error) {
		asked = append(asked, string(ask))
		if strings.HasPrefix(string(ask), "replicas-of:") {
			return []byte("3"), nil
		}

		return []byte("ok"), nil
	})
	if err != nil {
		t.Fatalf("converse: %v", err)
	}

	if len(asked) != 2 {
		t.Fatalf("the callee asked %d questions (%v), want 2 - a conversation that cannot "+
			"interleave is just a call", len(asked), asked)
	}
	if asked[1] != "scale-to:3" {
		t.Errorf("the second question was %q, want it DERIVED from the first answer "+
			"(scale-to:3). If it is not, the exchange is request/reply wearing a loop", asked[1])
	}
	if string(reply) != "done:ok" {
		t.Errorf("final reply %q, want done:ok", reply)
	}
}

// A TRANSPORT FAILURE MUST RETURN AN ERROR AND NEVER AN EMPTY REPLY.
//
// This seam's first caller feeds a driver where an empty result reads as THE
// WORK FINISHED. So a swallowed failure would not stall a program - it would
// RETIRE one, silently and permanently, with no error, no park, and nothing
// outstanding to notice. seam-vision measured that asymmetry on the Driver and
// coordinator pinned it on PodStep; this is the same requirement one layer down.
func TestConverse_AbandonedStreamIsAnErrorNotAnEmptyReply(t *testing.T) {
	// A handler that asks a question the CALLER cannot answer. That is the
	// reachable failure: the answerer errors, Converse abandons the stream, and
	// there is no final frame to return.
	//
	// NOT SIMULATED WITH A PANIC. The first version panicked inside the handler
	// to imitate a crashed callee - and a panic in a goroutine takes the whole
	// test BINARY down, so the suite died rather than failing one test. The
	// behaviour under test is the CALLER's return value, and it is reachable
	// without killing the process.
	handler := func(_ context.Context, c *Conversation) ([]byte, error) {
		_, err := c.Ask([]byte("q"))

		return nil, err
	}
	client := converseRig(t, handler)

	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()

	reply, err := client.Converse(ctx, []byte("run"), func(context.Context, []byte) ([]byte, error) {
		return nil, errors.New("cannot answer: the host is gone")
	})
	if err == nil {
		t.Fatalf("a conversation the caller could not complete returned reply=%q and NIL ERROR. "+
			"An empty reply reads as 'the work finished' to this seam's caller, so this "+
			"would retire a program rather than report a failure", reply)
	}
	if len(reply) != 0 {
		t.Errorf("an error path returned a non-empty reply %q", reply)
	}
}

// A HANDLER THAT RAN AND REFUSED IS NOT A CRASHED ONE, and the caller must be
// able to tell them apart: the first is the program's problem, the second is the
// transport's. A closed stream would collapse both into "unreachable".
func TestConverse_AHandlerErrorIsDeliveredNotDropped(t *testing.T) {
	handler := func(context.Context, *Conversation) ([]byte, error) {
		return nil, errors.New("step refused: capability not granted")
	}
	client := converseRig(t, handler)

	reply, err := client.Converse(t.Context(), []byte("run"), func(context.Context, []byte) ([]byte, error) {
		return nil, nil
	})
	if err != nil {
		t.Fatalf("a handler REFUSAL surfaced as a transport error (%v) - an operator would "+
			"go looking at the network for a program that answered", err)
	}
	if !strings.Contains(string(reply), "capability not granted") {
		t.Errorf("the refusal reason did not reach the caller: %q", reply)
	}
}

// REFUSED AGAINST A PEER THAT NEVER ADVERTISED IT, rather than attempted.
//
// Writing opConverse at a peer that does not know it means that peer reads the
// opcode as the first byte of a caller frame: it MISPARSES rather than failing,
// and a corrupted classic call is far worse than a refused conversation.
func TestConverse_RefusedAgainstAPeerThatDoesNotServeIt(t *testing.T) {
	ca := generateTestCA(t)
	providerCert, providerKey, providerCA := writeTestLeaf(t, ca, t.TempDir())
	consumerCert, consumerKey, consumerCA := writeTestLeaf(t, ca, t.TempDir())

	ctx := t.Context()
	echo := func(_ Caller, request []byte) ([]byte, error) { return request, nil }
	// EPHEMERAL, NOT 19804 — see converseRig's banner. This is the one call site
	// in the package that stands a provider up WITHOUT the rig, so the rig's fix
	// did not reach it and it was the surviving red under concurrent runs.
	addr := freeAddr(t)
	go func() {
		// NO converse handler - the ordinary entry point every existing provider
		// uses, which must keep behaving exactly as before.
		_ = ServeQUICWithBarrier(ctx, "tcp:"+addr,
			providerCert, providerKey, providerCA, "0.1.0", echo, nil)
	}()

	// ADVERTISES, so this test fails for the reason it names: the peer does not
	// serve converse. A plain DialQUIC would also be refused - by the opcode
	// channel never opening - and the test would pass for the wrong reason.
	client, err := dialWhenReady(t, ctx, addr, consumerCert, consumerKey, consumerCA)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	if ConverseServed(client.PeerCaps) {
		t.Fatalf("a provider with NO converse handler advertised %q. Advertising a capability "+
			"you do not implement is worse than not implementing it: the second fails closed "+
			"and the first hangs a caller on a stream nobody reads. caps=%v",
			CapConverse, client.PeerCaps)
	}

	_, err = client.Converse(t.Context(), []byte("run"), func(context.Context, []byte) ([]byte, error) {
		return nil, nil
	})
	if !errors.Is(err, ErrConverseUnsupported) {
		t.Errorf("got %v, want ErrConverseUnsupported - attempting it would misparse the "+
			"opcode as a caller frame on the peer", err)
	}
}

// AND THE CAPABILITY IS ADVERTISED WHEN A HANDLER EXISTS, or the whole op is
// unreachable and every test above would pass against a provider that serves
// nothing.
func TestConverse_AdvertisedOnlyWithAHandler(t *testing.T) {
	with := capsOffered(false, true)
	without := capsOffered(false, false)

	if !strings.Contains(with, CapConverse) {
		t.Errorf("a provider WITH a converse handler advertises %q, so no caller can ever "+
			"reach it: %q", CapConverse, with)
	}
	if strings.Contains(without, CapConverse) {
		t.Errorf("a provider with NO handler advertises %q - a caller opens a stream nothing "+
			"answers and hangs: %q", CapConverse, without)
	}
	fmt.Fprintln(nopWriter{}, with) // keep `with` used if the assertions change
}

type nopWriter struct{}

func (nopWriter) Write(p []byte) (int, error) { return len(p), nil }
