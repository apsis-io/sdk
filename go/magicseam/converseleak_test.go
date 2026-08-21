package magicseam

import (
	"context"
	"errors"
	"runtime"
	"runtime/pprof"
	"strings"
	"testing"
	"time"
)

func leakOnPurpose() {
	ch := make(chan struct{})
	go func() { <-ch }()
}

// THE CONTROL AND THE SUBJECT IN ONE PROFILE.
//
// A deliberate leak proves the instrument is live in THIS binary; the abandoned
// conversation is the thing under test. Without the control a zero means only
// that the profile said nothing, and the release note is explicit that this
// technique cannot see every leak - it works by reachability, so anything held
// by a runnable goroutine is invisible to it.
func TestConverse_AbandonedConversationVersusAKnownLeak(t *testing.T) {
	p := pprof.Lookup("goroutineleak")
	if p == nil {
		t.Skip("goroutineleak profile unavailable")
	}

	handler := func(_ context.Context, c *Conversation) ([]byte, error) {
		_, err := c.Ask([]byte("q"))
		return nil, err
	}
	client := converseRig(t, handler)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	_, _ = client.Converse(ctx, []byte("run"), func(context.Context, []byte) ([]byte, error) {
		return nil, errors.New("caller cannot answer")
	})

	leakOnPurpose()
	time.Sleep(400 * time.Millisecond)
	runtime.GC()
	runtime.GC()

	var sb strings.Builder
	if err := p.WriteTo(&sb, 1); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := sb.String()
	t.Logf("profile:\n%s", out)

	if !strings.Contains(out, "leakOnPurpose") {
		t.Fatal("THE CONTROL DID NOT APPEAR, so this profile is silent and says nothing " +
			"about the conversation either")
	}
	if strings.Contains(out, "serveQUICConverse") || strings.Contains(out, "Conversation).Ask") {
		t.Errorf("THE ABANDONED CONVERSATION LEAKED A CALLEE GOROUTINE.\n"+
			"Converse's `defer stream.CancelRead(0)` is what prevents this: cancelling the "+
			"caller's side makes quic-go fail the callee's blocked read, Ask returns an error, "+
			"the handler returns it and serveQUICConverse exits. Remove that defer and every "+
			"abandoned conversation strands a goroutine on the provider for the life of the "+
			"process.\nprofile:\n%s", out)
	}

	// SCOPE, STATED RATHER THAN IMPLIED: this profile works by REACHABILITY, so a
	// goroutine blocked on something a runnable goroutine still holds is
	// invisible to it - the release note says so. A clean result here is evidence
	// bounded by that, not proof of no leak.
}
