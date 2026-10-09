import { describe, expect, test } from "bun:test";
import { normalizePostUrl, referencesSpin } from "../../src/lib/xverify.server";
import { csvCell, toCsv } from "../../src/lib/helpers.server";

describe("normalizePostUrl", () => {
  test("accepts x.com / twitter.com status links and returns the numeric id", () => {
    expect(normalizePostUrl("https://x.com/goApeGames/status/1834567890123456789")).toBe("1834567890123456789");
    expect(normalizePostUrl("https://twitter.com/a_b/statuses/42?s=20")).toBe("42");
    expect(normalizePostUrl("https://mobile.x.com/a/status/7/photo/1")).toBe("7");
    expect(normalizePostUrl("  https://www.x.com/a/status/9#x ")).toBe("9");
  });
  test("rejects everything else", () => {
    for (const u of [
      "http://x.com/a/status/1",
      "https://x.com.evil.com/a/status/1",
      "https://evil.com/x.com/a/status/1",
      "https://x.com/a/likes/1",
      "https://x.com/waytoolonghandle123/status/1",
      "javascript:alert(1)",
      "",
    ])
      expect(normalizePostUrl(u)).toBeNull();
  });
});

describe("referencesSpin", () => {
  const id = "3f2b9c3e-1111-4222-8333-444455556666";
  test("matches the share link or the id, case-insensitively", () => {
    expect(referencesSpin({ text: "gm", urls: [`https://gotcha.example/spin/${id}`] }, id)).toBe(true);
    expect(referencesSpin({ text: `pulled ${id.toUpperCase()}`, urls: [] }, id)).toBe(true);
  });
  test("does not match another spin", () => {
    expect(referencesSpin({ text: "The Games Are Calling", urls: ["https://gotcha.example/spin/other"] }, id)).toBe(false);
  });
});

describe("csvCell", () => {
  test("neutralises formula injection", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-cmd")).toBe("'-cmd");
  });
  test("keeps plain numbers numeric and quotes separators", () => {
    expect(csvCell("-10")).toBe("-10");
    expect(csvCell(123n)).toBe("123");
    expect(csvCell("a,b")).toBe("\"a,b\"");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["rank", "alias"], [[1, "ape"]])).toBe("rank,alias\r\n1,ape");
  });
});
