import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveQUIC, dialQUIC, TRAIL_QUIC_SNI } from "./quic.js";
import { SeamRejectedError, SeamTooLargeError } from "./magicseam.js";

// ---- real loopback QUIC integration test ----
//
// Generates a throwaway self-signed CA + leaf cert via `openssl` (already
// on PATH in this environment, no new npm dependency needed just to mint
// certs for tests - Node has no built-in X.509 cert *generation*, only
// parsing) - both sides use the SAME leaf, matching this package's
// fixed-SAN design (see quic.ts's own doc comment: every leaf shares
// TRAIL_QUIC_SNI, mirroring tools/trail/src/remote_quic.rs's own test
// module and sdk/go/magicseam/quic_test.go). Real UDP sockets on
// 127.0.0.1, real mTLS handshakes, real streams - only the handler is a
// trivial mock.

function generateTestCerts(): { cert: string; key: string; ca: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magicseam-quic-test-"));
  const caKey = path.join(dir, "ca.key");
  const caCert = path.join(dir, "ca.pem");
  const leafKey = path.join(dir, "leaf.key");
  const leafCsr = path.join(dir, "leaf.csr");
  const leafCert = path.join(dir, "leaf.pem");
  const extFile = path.join(dir, "ext.cnf");

  const sh = (cmd: string) => execSync(cmd, { stdio: ["ignore", "ignore", "pipe"] });

  sh(`openssl ecparam -name prime256v1 -genkey -noout -out ${caKey}`);
  sh(`openssl req -x509 -new -key ${caKey} -days 1 -out ${caCert} -subj "/CN=test-trail-ca"`);
  sh(`openssl ecparam -name prime256v1 -genkey -noout -out ${leafKey}`);
  sh(`openssl req -new -key ${leafKey} -out ${leafCsr} -subj "/CN=${TRAIL_QUIC_SNI}"`);
  fs.writeFileSync(extFile, `subjectAltName=DNS:${TRAIL_QUIC_SNI}\n`);
  sh(`openssl x509 -req -in ${leafCsr} -CA ${caCert} -CAkey ${caKey} -CAcreateserial -days 1 -out ${leafCert} -extfile ${extFile}`);

  return { cert: leafCert, key: leafKey, ca: caCert };
}

describe("QUIC transport", () => {
  test("real loopback mTLS round trip", async () => {
    const { cert, key, ca } = generateTestCerts();
    await serveQUIC("tcp:127.0.0.1:19810", cert, key, ca, "0.1.0", (_c, req) => req);
    await new Promise((r) => setTimeout(r, 150));

    const client = await dialQUIC("tcp:127.0.0.1:19810", cert, key, ca, "0.1.0");
    expect(client.served).toBe("0.1.0");

    const resp = await client.call(new TextEncoder().encode("hello quic ts"));
    expect(new TextDecoder().decode(resp)).toBe("hello quic ts");
    await client.close();
  }, 15000);

  test("concurrent calls do not serialize", async () => {
    const { cert, key, ca } = generateTestCerts();
    await serveQUIC("tcp:127.0.0.1:19811", cert, key, ca, "", async (_c, req) => {
      await new Promise((r) => setTimeout(r, 200));
      return req;
    });
    await new Promise((r) => setTimeout(r, 150));

    const client = await dialQUIC("tcp:127.0.0.1:19811", cert, key, ca, "");
    const start = Date.now();
    await Promise.all([client.call(new Uint8Array([1])), client.call(new Uint8Array([2]))]);
    const elapsed = Date.now() - start;
    // Two 200ms calls that ran concurrently finish in ~200ms; serialized,
    // they'd take ~400ms. Generous bound to absorb CI/loopback jitter.
    expect(elapsed).toBeLessThan(350);
    await client.close();
  }, 15000);

  test("rejected/too-large/other error tags round-trip", async () => {
    const { cert, key, ca } = generateTestCerts();
    await serveQUIC("tcp:127.0.0.1:19812", cert, key, ca, "", (_c, req) => {
      const text = Buffer.from(req).toString("utf8");
      if (text === "reject") throw new SeamRejectedError();
      if (text === "toolarge") throw new SeamTooLargeError();
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 150));

    const client = await dialQUIC("tcp:127.0.0.1:19812", cert, key, ca, "");

    await expect(client.call(new TextEncoder().encode("reject"))).rejects.toBeInstanceOf(SeamRejectedError);
    await expect(client.call(new TextEncoder().encode("toolarge"))).rejects.toBeInstanceOf(SeamTooLargeError);
    await expect(client.call(new TextEncoder().encode("other"))).rejects.toThrow();

    await client.close();
  }, 15000);
});
