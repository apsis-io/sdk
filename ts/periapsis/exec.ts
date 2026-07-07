// Ergonomic wrapper around periapsis:host/exec (ADR: the exec seam, trail's
// tools/trail/src/exec.rs) - allowlisted child-component spawning. A guest may
// only spawn a NAME declared at pod launch via `--exec-with <name>=<path>`
// (or the periapsis.io/wasm-exec-with pod annotation); anything else throws a
// JS Error whose `.payload` is `{ tag: "not-allowed" }`. p3-only: stream<u8>
// and ChildProcess.wait's async func need trail's --p3 launch path.
//
// Extracted from examples/wasm/js-dwarf-shell's exec() REPL builtin (the
// reference implementation this was validated against, live, on a real pod).

import { ChildProcess } from "periapsis:host/exec@0.1.0";
import { stringToBytes, bytesToString, concatBytes } from "./codec.js";

export interface ExecResult {
  exitCode: number;
  stdout: string;
}

/**
 * Spawn `name` (must be pre-declared via --exec-with), optionally feeding
 * `input` to its stdin, then collect ALL of its stdout and wait for its exit
 * code. A simple sequential request/response shape - writes `input` (if any)
 * to the child's stdin then closes it, THEN drains stdout to completion. Fine
 * for a simple request/response child; a long-lived interactive child that
 * needs concurrent read/write instead of this write-then-read sequencing
 * should use `spawn` directly (see below) with its own `Promise.all` of the
 * write and read loops, mirroring wasi:http/types@0.3.0's Response.new
 * pattern used elsewhere in this codebase.
 */
export async function exec(name: string, args: string[] = [], input?: string): Promise<ExecResult> {
  const child = spawn(name, args, input);
  const stdout = await drainStdout(child);
  const exitCode = await child.wait();
  return { exitCode, stdout };
}

/**
 * Lower-level spawn: creates the child's stdin stream pair, writes `input`
 * (if given) then closes the writable half, and returns the live
 * `ChildProcess` handle for the caller to drive `stdout()`/`wait()` directly -
 * use this instead of `exec` when you need to interleave reads and writes
 * (e.g. a child that only produces output after seeing partial input) rather
 * than exec's write-everything-then-read-everything sequencing.
 */
export function spawn(name: string, args: string[] = [], input?: string): ChildProcess {
  const { readable, writable } = wit.Stream(wit.Stream.U8);
  const child = ChildProcess.spawn(name, args, readable);
  if (input) {
    void writable.writeAll(stringToBytes(input)).then(() => writable.drop());
  } else {
    writable.drop();
  }
  return child;
}

/** Read a spawned child's stdout to completion (EOF) and decode it as text. */
export async function drainStdout(child: ChildProcess): Promise<string> {
  const outReadable = child.stdout();
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await outReadable.read(4096);
    if (chunk.length === 0) break;
    chunks.push(chunk);
  }
  outReadable.drop();
  return bytesToString(concatBytes(chunks));
}
