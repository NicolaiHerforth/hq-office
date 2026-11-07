// BRIEF EXPORT: a held value as an honest page writes it, and what that costs the server the question panel depends on.
import { describe, expect, test } from "bun:test";
import { decodedAttribute, maskSpelled } from "../../src/server/brief-export-spelled.ts";

const PLAIN = [{ name: "K", value: "FAKEplainSECRETvalue77" }], MARKS = [{ name: "M", value: "FAKE&sec<ret>value42" }], EURO = [{ name: "E", value: "pre€sec1234" }];

describe("what it masks", () => {
  for (const [name, text, held] of [
    ["a numeric reference", "a FAKEplain&#83;ECRETvalue77 b", PLAIN],
    ["with no semicolon", "a FAKEplain&#83ECRETvalue77 b", PLAIN],
    ["in hex, upper X, leading zeros", "a FAKEplain&#X00053;ECRETvalue77 b", PLAIN],
    ["named references", "a FAKE&amp;sec&lt;ret&gt;value42 b", MARKS],
    ["names with no semicolon", "a FAKE&ampsec&ltret&gtvalue42 b", MARKS],
    ["encodeURIComponent's form", "a FAKE%26sec%3Cret%3Evalue42 b", MARKS],
    ["encodeURIComponent's form, lower hex", "a FAKE%26sec%3cret%3evalue42 b", MARKS],
    ["encodeURI's form", "a FAKE&sec%3Cret%3Evalue42 b", MARKS],
    ["encodeURI's form, lower hex", "a FAKE&sec%3cret%3evalue42 b", MARKS],
    ["encodeURI's form, its & written as a page must", "a FAKE&amp;sec%3Cret%3Evalue42 b", MARKS],
    ["Windows-1252's numeric reference", "a pre&#128;sec1234 b", EURO],
    ["and in hex", "a pre&#x80;sec1234 b", EURO],
    ["a character's own reference", "a pre&#8364;sec1234 b", EURO],
    ["percent-encoded UTF-8", "a pre%E2%82%ACsec1234 b", EURO],
    ["and lower hex", "a pre%e2%82%acsec1234 b", EURO],
  ] as const) test(name, () => {
    expect(maskSpelled(text, [...held])).toBe(`a [secret ${held[0].name}] b`);
  });
  test("every occurrence, and the text between them stays", () => {
    expect(maskSpelled("1 FAKEplain&#83;ECRETvalue77 2 FAKEplain&#83;ECRETvalue77 3", PLAIN)).toBe("1 [secret K] 2 [secret K] 3");
  });
  test("a longer value keeps what a shorter one also holds", () => {
    const held = [{ name: "SHORT", value: "abcd" }, { name: "LONG", value: "cd&efgh" }];
    expect(maskSpelled("ab cd&amp;efgh", held)).toBe("ab [secret LONG]");
    expect(maskSpelled("abcd&amp;efgh", held)).toBe("ab[secret LONG]");
  });
  test("what spells no value is left exactly as it is", () => {
    for (const text of ["&amp; &lt;b&gt; &#x2603; &bogus; &constructor; &#; & &&", "FAKE&amp;sec&lt;ret", "%26%3C", ""]) expect(maskSpelled(text, [...PLAIN, ...MARKS])).toBe(text);
  });
  test("a value under 4 characters is left alone, as the shared mask does", () => {
    expect(maskSpelled("a&amp;b", [{ name: "S", value: "a&b" }])).toBe("a&amp;b");
  });
  test("half of a surrogate pair cannot be an address, and does not stop it", () => {
    expect(maskSpelled("ab\ud800cd", [{ name: "H", value: "ab\ud800cd" }])).toBe("[secret H]");
  });
});

describe("what it leaves, and the README names", () => {
  for (const [name, text] of [["a CSS escape", "FAKEplain\\53 ECRETvalue77"], ["split by a tag", "FAKEplain<b>SECRETvalue77</b>"], ["a JS escape", "FAKEplain\\x53ECRETvalue77"], ["base64", btoa("FAKEplainSECRETvalue77")]]) {
    test(name, () => { expect(maskSpelled(text, PLAIN)).toBe(text); });
  }
  test("a name for several characters, and a name outside ASCII", () => {
    expect(maskSpelled("AA&fjlig;BB123499", [{ name: "F", value: "AAfjBB123499" }])).toBe("AA&fjlig;BB123499");
    expect(maskSpelled("pre&euro;sec1234", EURO)).toBe("pre&euro;sec1234");
  });
});

describe("an attribute, as a browser reads it", () => {
  for (const [written, read] of [
    ["?a=1&lt=3", "?a=1&lt=3"], ["?a=1&gt=3", "?a=1&gt=3"], ["?a&amp=3", "?a&amp=3"], ["?a&quotb", "?a&quotb"], ["?a=1&lt;=3", "?a=1<=3"], ["&lt", "<"], ["&amp&", "&&"], ["&lt b", "< b"],
    ["&#65;&#x41;", "AA"], ["&#128;", "€"], ["&#0;", "�"], ["&#xD800;", "�"], ["&#x110000;", "�"], ["&bogus;", "&bogus;"], ["&constructor;", "&constructor;"], ["plain", "plain"], ["a&", "a&"], ["&#", "&#"], ["", ""],
  ]) test(JSON.stringify(written), () => { expect(decodedAttribute(written)).toBe(read); });
});

describe("what it costs", () => {
  const timed = (text: string, held: { name: string; value: string }[]) => {
    const started = performance.now();
    const out = maskSpelled(text, held);
    return { ms: performance.now() - started, out };
  };
  test("150,000 spelled occurrences: every one masked, far under a second", () => {
    const { ms, out } = timed("FAKEplain&#83;ECRETvalue77 ".repeat(150_000), PLAIN);
    expect(out).toBe("[secret K] ".repeat(150_000));
    expect(ms).toBeLessThan(1000);
  });
  test("64 MB with one spelled value", () => {
    const { ms, out } = timed(`${"x".repeat(64 * 1024 * 1024)}FAKEplain&#83;ECRETvalue77`, PLAIN);
    expect(out.endsWith("x[secret K]")).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
  test("a page with no value in it, and references everywhere", () => {
    expect(timed("&amp;".repeat(2_000_000), PLAIN).ms).toBeLessThan(1000);
    expect(timed("&".repeat(10_000_000), MARKS).ms).toBeLessThan(1000);
  });
});
