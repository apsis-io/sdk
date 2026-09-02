// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

package magicseam

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// ***THE WIRE PROTOCOL IS DECLARED TWICE, IN TWO LANGUAGES, AND NOTHING CHECKED
// THEY AGREE.***
//
// Written reviewing the converse seam at trail-main's request. The constants
// happened to match; what was missing is anything that FAILS when they stop.
//
// # WHY THIS ONE IS WORTH A CROSS-LANGUAGE TEST WHEN MOST ARE NOT
//
// ***THE FAILURE MODE IS SILENCE.*** radiant-main lost an hour to exactly this
// class tonight: advertising a capability whose opcode was not written, so the
// peer read a frame's length prefix as an opcode and both ends blocked forever.
// Their own words - *"a misparse has no error path: both ends are still reading,
// nothing errors, and the loudest available protocol bug presents as silence."*
//
// A renumbered opcode is the same shape. Go writes 5, Rust reads 5 as something
// else, and the symptom is a Perseid that never completes a pass - with no error
// anywhere and a driver that looks merely slow.
//
// # WHY A SOURCE READ RATHER THAN A ROUND TRIP
//
// The honest answer is that a round trip is better and needs a trail binary,
// which this package cannot assume. A source read is the weaker instrument that
// runs everywhere, and its known weakness is that it checks a LITERAL rather
// than a BEHAVIOUR - so it catches a renumber and would not catch a Rust reader
// that ignores the byte entirely.
//
// ***IT FAILS RATHER THAN SKIPS WHEN IT CANNOT READ THE FILE.*** A skip here
// would make a moved or renamed streamwire.rs look exactly like agreement, which
// is the "instrument broken is a third outcome" rule and the whole reason this
// file is not `t.Skip`-guarded.
func TestWireConstantsAgreeWithTrail(t *testing.T) {
	src := rustStreamWire(t)

	for _, c := range []struct {
		name string
		rust string
		got  byte
	}{
		{"opcode", "OP_CONVERSE", opConverse},
		{"ask tag", "CONV_ASK", convAsk},
		{"done tag", "CONV_DONE", convDone},
	} {
		want := rustByteConst(t, src, c.rust)
		if want != c.got {
			t.Errorf("%s DIVERGED: Go has %d, "+rustWirePath+" %s = %d. "+
				"A renumbered opcode does not error - both ends block and a pass "+
				"never completes, which reads as a slow driver rather than a bug",
				c.name, c.got, c.rust, want)
		}
	}
}

// The capability token is a STRING and drifts differently - a typo on either
// side means the peer never advertises, Converse refuses up front, and that at
// least fails loudly. Pinned anyway because the loud failure is "this seam does
// not work at all", which is expensive to diagnose from the consumer end.
func TestWireCapabilityTokenAgreesWithTrail(t *testing.T) {
	src := rustStreamWire(t)
	re := regexp.MustCompile(`CAP_CONVERSE:\s*&str\s*=\s*"([^"]+)"`)
	m := re.FindSubmatch(src)
	if m == nil {
		t.Fatal("CAP_CONVERSE not found in " + rustWirePath + " - the constant was " +
			"renamed or removed, and this test cannot tell that from agreement")
	}
	if string(m[1]) != CapConverse {
		t.Errorf("capability token DIVERGED: Go %q, Rust %q - the peer never "+
			"advertises and every Converse is refused before it starts",
			CapConverse, string(m[1]))
	}
}

// rustStreamWire reads the Rust side's wire definitions. FATAL on any failure:
// an unreadable file must not read as agreement.
//
// MOVED 2026-08-26: the vocabulary left trail's wire vocabulary for
// rust/seamwire/src/lib.rs when it was extracted into a crate, so trail and
// the comet agent link one copy instead of each carrying their own.
//
// MOVED AGAIN 2026-09-02, when the SDK left periapsis for its own repo. The
// vocabulary crate came WITH it, so this read stays in-repo and merely loses a
// `..` - the drift check it powers is as strong as it was. The SERVED half did
// not come along, and that one genuinely crossed a repo boundary; see trailSrc.
//
// ***THIS TEST CAUGHT THAT MOVE AND THAT IS WHY THE PATH IS STILL WRITTEN OUT.***
// The extraction shipped green - cargo test, go vet and comettest all passed,
// because this is a GO test reading RUST source and no build anywhere can see
// it. What went red was the pair invariant below, reporting converse as
// advertised=false, served=true. Searching for the file instead of naming it
// would have turned the next move into a silent not-found, which is exactly what
// the original comment refused and what the failure text at the pair test would
// then have mis-explained.
// rustWirePath is the ONE place the vocabulary's location is written down, and
// every failure message that sends a reader there names it from here.
//
// It is a const because a repo-relative location is a CONVENTION, not a host
// path: no test may point this somewhere else and still claim to have checked
// the wire.
//
// The move above left three messages saying `streamwire.rs` - a diverged opcode,
// a missing CAP_CONVERSE and a missing byte constant all directed the reader to
// a file that no longer existed. Each was correct when written. Repointing three
// string literals would have re-armed exactly that, so the literal exists once.
const rustWirePath = "rust/seamwire/src/lib.rs"

func rustStreamWire(t *testing.T) []byte {
	t.Helper()
	// Relative to go/magicseam. Written out rather than searched so a MOVED
	// file fails here instead of being silently not-found somewhere else.
	path := filepath.Join("..", "..", filepath.FromSlash(rustWirePath))
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s, so the two sides are UNCHECKED rather than in "+
			"agreement: %v", path, err)
	}

	return src
}

// rustFnBody returns the brace-matched body of the function whose signature
// starts at `sig`, and whether it was found.
//
// Brace counting is enough for THIS input and would not be for arbitrary Rust: a
// `{` inside a string or char literal would miscount. The seamwire crate's Caps
// constructor is a vec! of identifiers, so the limitation is stated rather than
// papered over - if that body ever grows a brace-bearing literal, the CAP_STREAM
// control above fails loudly instead of this silently returning the wrong span.
func rustFnBody(src, sig string) (string, bool) {
	i := strings.Index(src, sig)
	if i < 0 {
		return "", false
	}
	open := strings.Index(src[i:], "{")
	if open < 0 {
		return "", false
	}
	start := i + open
	depth := 0
	for j := start; j < len(src); j++ {
		switch src[j] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return src[start : j+1], true
			}
		}
	}

	return "", false
}

// rustByteConst reads a `NAME: u8 = <n>;` constant out of Rust source.
//
// ***IT READS DECLARATIONS ONLY, AND THAT IS A FIX RATHER THAN A REFINEMENT.***
// The first version regexed the WHOLE FILE with no comment filter, while the
// served-detector below deliberately skips `//` lines. Measured against
// synthetic input before this change:
//
//	"/// historically OP_CONVERSE: u8 = 9" above "pub const OP_CONVERSE: u8 = 5;"
//	  -> returned ***9***, the comment's value, because FindSubmatch takes the
//	     FIRST match in the file
//
// A doc comment recording an old opcode is exactly the thing somebody writes
// when they renumber one, so the failure arrives attached to the change it is
// supposed to catch. Comment lines are dropped before matching.
//
// ***AND A HEX LITERAL RETURNED 0.*** `(\d+)` matches the leading `0` of
// `0x05` and stops, so `Sscanf` yields 0 and the test reports "Rust has 0"
// against Go's 5 - a DIVERGENCE with a fabricated number in the message, which
// sends the reader to compare two values one of which was never in the file.
// Rust accepts `0x05` here and nothing stops somebody writing it.
//
// Both are loud rather than silent, which is why they survived: a wrong number
// in a failure message still fails.
func rustByteConst(t *testing.T, src []byte, name string) byte {
	t.Helper()
	// DECLARATIONS ONLY: drop comment lines before matching, so a doc comment
	// quoting an old value cannot be read as the current one.
	var code [][]byte
	for _, line := range bytes.Split(src, []byte("\n")) {
		if bytes.HasPrefix(bytes.TrimSpace(line), []byte("//")) {
			continue
		}
		code = append(code, line)
	}
	re := regexp.MustCompile(fmt.Sprintf(`%s:\s*u8\s*=\s*(0[xX][0-9a-fA-F]+|\d+)`,
		regexp.QuoteMeta(name)))
	m := re.FindSubmatch(bytes.Join(code, []byte("\n")))
	if m == nil {
		t.Fatalf("%s not found in "+rustWirePath+" OUTSIDE COMMENTS - renamed, removed, "+
			"or now only mentioned in prose, none of which this test can distinguish "+
			"from agreement", name)
	}
	v, err := strconv.ParseUint(string(m[1]), 0, 8) // base 0: accepts 0x and decimal
	if err != nil {
		t.Fatalf("%s = %q, not a byte: %v", name, m[1], err)
	}

	return byte(v)
}

// ***ADVERTISED IF AND ONLY IF SERVED. THE PAIR IS THE INVARIANT; NEITHER HALF
// ALONE IS.***
//
// TestWireDrift above compares Go's CapConverse against Rust's CAP_CONVERSE and
// passes when the SPELLINGS match. Its own failure text says what is at stake -
// "the peer never advertises and every Converse is refused before it starts" -
// and on 2026-08-21 that is exactly what production did while this file was
// green:
//
//	radiant dialled the pod, the pod served, and the handshake refused:
//	"peer does not support the converse seam (peer advertised [stream status barrier])"
//
// CAP_CONVERSE has ONE occurrence in the Rust tree: its own definition. It is in
// no advertised set, so dead-code elimination drops the string from the binary -
// `strings /usr/local/bin/trail | grep converse` returns 0 while `barrier`
// returns 18.
//
// # THE FIRST VERSION OF THIS TEST DEMANDED THE WRONG THING
//
// It asserted CAP_CONVERSE must be USED, and went red. That would have pushed
// somebody to add it to Caps::ours() - ***advertising a capability trail cannot
// serve.*** reconcile.rs:384 marks the serve side as unwritten ("*** HERE ***
// OP_CONVERSE -> serve_conversation"), so the current refusal is CORRECT and
// readable: Converse is declined at the handshake instead of hanging mid-stream.
//
// That is the same "linked is not served" defect trail's own HOST_PACKAGES
// refusal is about, and I nearly encoded the inverse of it in a guard.
//
// ***SO THE INVARIANT IS THE PAIR.*** Both absent is today and is correct. Both
// present is the finished state. ***One without the other is the bug, in either
// direction*** - advertising without serving hangs a caller, serving without
// advertising means nobody ever calls it.
// trailSrc locates trail's Rust sources, which stopped being a sibling directory
// on 2026-09-02 when this SDK was extracted into its own repo.
//
// ***THE ADVERTISED HALF CAME WITH US AND THE SERVED HALF DID NOT.*** seamwire
// is a vocabulary and belongs to every speaker, so it moved into this repo;
// trail's dispatch is an implementation and stayed in periapsis. The pair
// invariant therefore now reads across a repo boundary, and no repo-relative
// path can express that - which is exactly what the const above refuses to be
// used for.
//
// ***SO THIS IS A SKIP AND NOT A FATAL, AND THAT IS A REAL WEAKENING.*** Every
// other unreadable-file path in this file is fatal on the stated principle that
// an unreadable file must not read as agreement. That principle assumed the file
// was always THERE - true in a monorepo, false now: a clone of this SDK alone
// has no periapsis to read, and failing it would mean this repo's own test suite
// cannot pass on its own. A skip is the honest report of UNCHECKED; a green
// fatal-free run that never looked would not be.
//
// Point PERIAPSIS_SRC at a periapsis checkout to arm it - `PERIAPSIS_SRC=../periapsis
// go test ./...`, or in CI wherever the two repos are checked out together. Set
// but unreadable stays FATAL: asking for the check and silently not getting it
// is the failure mode the whole file exists to prevent.
func trailSrc(t *testing.T) (string, bool) {
	t.Helper()
	root := os.Getenv("PERIAPSIS_SRC")
	if root == "" {
		t.Skip("PERIAPSIS_SRC unset, so the advertised/served pair is UNCHECKED " +
			"rather than clean - trail's dispatch lives in periapsis and this SDK " +
			"no longer ships beside it. Set PERIAPSIS_SRC to a periapsis checkout " +
			"to arm this test.")
		return "", false
	}

	return filepath.Join(root, "cmd", "trail", "src"), true
}

func TestWireDrift_ConverseIsAdvertisedIfAndOnlyIfServed(t *testing.T) {
	dir, ok := trailSrc(t)
	if !ok {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("cannot read %s, so this is UNCHECKED rather than clean: %v", dir, err)
	}

	// SERVED means "some file other than the wire-constant module refers to this
	// op". The seamwire crate DEFINES all six and lists them again in a
	// duplicate-value test table, so a mention there is worth nothing; a mention
	// anywhere else is the dispatch reaching for it.
	//
	// The qualified path below is still `crate::streamwire::` and that is NOT
	// stale: trail's entry point carries `pub(crate) use seamwire as
	// streamwire`, so trail's dispatch reads the same after the extraction as
	// before. Deleting that LINE while call sites still say `crate::streamwire::`
	// is a compile error (E0433), which is why it is not dead code.
	//
	// ***BUT RENAMING THE ALIAS DOES NOT BREAK THIS TEST, AND I CLAIMED IT WOULD.***
	// trail-main wrote here that retiring the alias would turn SERVED false for
	// every op. comet-main measured it - alias and all 46 call sites renamed to
	// `wirevocab`, `go test -run WireDrift` still ok. The detector below is
	// `strings.Contains(ln, op)`, a bare substring match on `OP_STREAM`; the
	// MODULE name it is qualified by is invisible to it either way.
	//
	// Kept as a correction rather than deleted, because the wrong version was the
	// reassuring one: it told a reader this scan was more fragile than it is, and
	// a fragility claim is what stops somebody doing a rename that is fine.
	//
	// ***THE FIRST SERVED-DETECTOR RETURNED FALSE FOR EVERY OP INCLUDING THE FIVE
	// THAT PLAINLY WORK***, and the test passed anyway because false==false. It
	// required a `=>` match arm on the same line as a bare token; the dispatch is
	// an if-chain over a qualified path (`if op == crate::streamwire::OP_STREAM`),
	// so it could not have fired for anything. ***That is why servedOps below is
	// asserted against a positive control rather than only read.***
	served := map[string]bool{}
	// ***THE TWO HALVES NOW LIVE IN DIFFERENT PLACES, AND THAT SPLIT IS WHAT
	// BROKE THIS TEST.*** Until the 2026-08-26 extraction both were under
	// trail's sources, so one directory scan answered both questions. Caps::ours()
	// moved to rust/seamwire; the dispatch that SERVES an op did not. Reading
	// only the old directory finds served=true, advertised=false, and reports a
	// broken pair for a codebase that is fine.
	//
	// So ADVERTISED is read from the vocabulary crate by name, and SERVED is
	// scanned across trail's sources. Two sources, because there are now two
	// places - not because the invariant changed.
	//
	// ADVERTISED means "inside the Caps constructor body", not "mentioned in the
	// file". A doc comment naming CAP_CONVERSE must not read as an
	// advertisement, which is why this is a brace-matched window and not a
	// whole-file Contains.
	//
	// ***THE WINDOW IS BRACE-MATCHED, NOT FIRST-`}`.*** It used to end at
	// `strings.Index(src[i:], "}")` - the first closing brace after the signature
	// - which works only because `ours()`'s body happens to contain no brace
	// before the token list. Measured against synthetic input: adding one
	// `if cfg!(...) { }` ahead of the vec! flips advertised to FALSE while
	// CAP_CONVERSE is still plainly listed.
	//
	// That direction is a SPURIOUS RED, and this repo has measured what a guard
	// that refuses wrongly produces: the remedy people reach for is removal. A
	// cry-wolf invariant is worse than a missing one.
	advertised := false
	if body, ok := rustFnBody(string(rustStreamWire(t)), "pub fn ours()"); ok {
		// POSITIVE CONTROL ON THIS DETECTOR, which it did not have while its
		// sibling below did. CAP_STREAM has been advertised since negotiation
		// existed, so if the window cannot see IT, the window is broken and
		// the verdict on CAP_CONVERSE is an instrument zero rather than a
		// measurement.
		if !strings.Contains(body, "CAP_STREAM") {
			t.Fatalf("CONTROL FAILED: the Caps::ours() window does not contain "+
				"CAP_STREAM, which is advertised. The window is broken, so its "+
				"verdict on CAP_CONVERSE means nothing - fix the extraction "+
				"before reading any result from it. Window was:\n%s", body)
		}
		if strings.Contains(body, "CAP_CONVERSE") {
			advertised = true
		}
	} else {
		// The constructor not being FOUND is an instrument failure, not an
		// absence: it means the crate moved or ours() was renamed, and every
		// verdict below would be drawn from a window that does not exist.
		t.Fatal("Caps::ours() not found in the seamwire crate - the vocabulary " +
			"moved or the constructor was renamed, so advertised is UNCHECKED " +
			"rather than false")
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".rs") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("cannot read %s: %v", e.Name(), err)
		}
		src := string(raw)
		// SERVED ONLY. The advertised window is read once, above.
		//
		// The `streamwire.rs` exclusion that used to stand here is gone with the
		// file. Its reason still holds and is now structural rather than a
		// filter: the vocabulary defines every op and lists them again in a
		// duplicate-value table, so a mention there is worth nothing - and this
		// scan can no longer reach it, because it walks trail's sources and the
		// vocabulary is a separate crate.
		for _, line := range strings.Split(src, "\n") {
			ln := strings.TrimSpace(line)
			if strings.HasPrefix(ln, "//") || strings.HasPrefix(ln, "*") {
				continue
			}
			for _, op := range []string{"OP_CALL", "OP_STREAM", "OP_MARKER_ACK", "OP_MARKER", "OP_RESUME", "OP_CONVERSE"} {
				if strings.Contains(ln, op) {
					served[op] = true
				}
			}
		}
	}

	// ***POSITIVE CONTROL, IN THE TEST.*** OP_STREAM and OP_MARKER are dispatched
	// in remote_quic.rs today. If the detector stops finding THEM, its verdict on
	// OP_CONVERSE is an instrument zero and the assertion below is meaningless -
	// which is exactly the state this test shipped in for one revision.
	for _, ctrl := range []string{"OP_STREAM", "OP_MARKER"} {
		if !served[ctrl] {
			t.Fatalf("CONTROL FAILED: %s is dispatched in remote_quic.rs and the detector "+
				"cannot see it, so this test cannot tell 'converse is unserved' from "+
				"'the detector is broken'. Fix the detector before reading any verdict "+
				"from it - a green here would be false==false, not a measurement.", ctrl)
		}
	}

	if advertised != served["OP_CONVERSE"] {
		t.Errorf("converse is advertised=%v but served=%v - THE PAIR IS THE INVARIANT.\n"+
			"  advertised && !served: a caller is told the peer speaks it, opens a "+
			"conversation, and hangs or fails mid-stream instead of being declined at "+
			"the handshake.\n"+
			"  served && !advertised: the handler exists and NOBODY EVER REACHES IT - "+
			"every Converse is refused up front, which is what production did on "+
			"2026-08-21 with the pod answering [stream status barrier].",
			advertised, served["OP_CONVERSE"])
	}
}
