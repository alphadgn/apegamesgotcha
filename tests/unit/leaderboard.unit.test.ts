import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeXPostUrl, spinShareCode, fetchPostEvidence } from "../../src/lib/social.server";
import { csvCell } from "../../src/lib/server-context.server";
import { resolvePrivyUser } from "../../src/lib/privy.server";
import { bytes32ToUuid, uuidToBytes32 } from "../../src/lib/vrf.server";
import { gotchaVrfAbi } from "../../src/lib/gotchaVrfAbi";

test("X status links normalise to post ids; other URLs are refused", () => {
  assert.equal(
    normalizeXPostUrl("https://x.com/goApeGames/status/1845000000000000001"),
    "1845000000000000001",
  );
  assert.equal(
    normalizeXPostUrl("https://twitter.com/a/status/1845000000000000002?s=46"),
    "1845000000000000002",
  );
  assert.equal(normalizeXPostUrl("https://x.com.evil.io/a/status/1845000000000000003"), null);
  assert.equal(normalizeXPostUrl("http://x.com/a/status/1845000000000000004"), null);
  assert.equal(
    normalizeXPostUrl("https://example.com/?u=https://x.com/a/status/1845000000000000005"),
    null,
  );
});

test("share codes match the database helper", () => {
  assert.equal(spinShareCode("7f6c1d4e-1234-4abc-9def-0123456789ab"), "AGG-7F6C1D4E12");
});

test("X API verification is optional and never throws; failures leave shares for manual review", async () => {
  delete process.env["X_API_BEARER_TOKEN"];
  assert.equal(await fetchPostEvidence("1845000000000000001", "AGG-X"), null);
  process.env["X_API_BEARER_TOKEN"] = "test";
  const calls: string[] = [];
  const failing = (async (u: string) => {
    calls.push(String(u));
    return new Response("rate limited", { status: 429 });
  }) as unknown as typeof fetch;
  assert.equal(await fetchPostEvidence("1845000000000000001", "AGG-X", failing), null);
  assert.ok(
    calls[0]!.startsWith("https://api.x.com/2/tweets/1845000000000000001?"),
    "only the fixed X API host is called",
  );
  const ok = (async () =>
    Response.json({
      data: {
        id: "1845000000000000001",
        text: "My pull AGG-7F6C1D4E12 #GoApeGames2026",
        created_at: "2026-10-12T10:00:00.000Z",
        author_id: "99",
      },
      includes: { users: [{ id: "99", username: "alice_apes" }] },
    })) as unknown as typeof fetch;
  const ev = await fetchPostEvidence("1845000000000000001", "AGG-7F6C1D4E12", ok);
  assert.deepEqual(
    [ev?.author_username, ev?.author_x_user_id, ev?.references_spin, ev?.public],
    ["alice_apes", "99", true, true],
  );
  assert.equal(await fetchPostEvidence("not-a-number", "AGG-X", ok), null);
  delete process.env["X_API_BEARER_TOKEN"];
});

test("CSV export cells are formula-safe", () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("-25"), "-25", "plain negative numbers stay numbers");
  assert.equal(csvCell("-1+1"), "'-1+1");
  assert.equal(csvCell("Ape, King"), '"Ape, King"');
  assert.equal(csvCell(null), "");
});

test("Privy sign-in never merges accounts: conflicting candidates are refused", () => {
  assert.equal(resolvePrivyUser({ byDid: null, byEmail: null, byWallets: [] }), null);
  assert.equal(resolvePrivyUser({ byDid: "a", byEmail: "a", byWallets: ["a"] }), "a");
  assert.equal(resolvePrivyUser({ byDid: null, byEmail: "b", byWallets: [] }), "b");
  assert.throws(
    () => resolvePrivyUser({ byDid: "a", byEmail: "b", byWallets: [] }),
    /more than one/,
  );
  assert.throws(
    () => resolvePrivyUser({ byDid: null, byEmail: null, byWallets: ["a", "b"] }),
    /more than one/,
  );
});

test("spin ids round-trip through bytes32; the ABI has no cancellation", () => {
  const id = "7f6c1d4e-1234-4abc-9def-0123456789ab";
  assert.equal(bytes32ToUuid(uuidToBytes32(id)), id);
  const names = gotchaVrfAbi.map((x) => ("name" in x ? x.name : ""));
  assert.ok(!names.includes("cancelRequest"));
  assert.ok(names.includes("setRequestsPaused"));
});
