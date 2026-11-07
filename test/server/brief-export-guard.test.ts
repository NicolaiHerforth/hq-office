// BRIEF EXPORT's guard: an address is public only if the table says so, and address rules never run on a name.
import { describe, expect, test } from "bun:test";
import { guard, publicAddress } from "../../src/server/brief-export-guard.ts";

const allowed = guard(["hud.trusted.example"]);

describe("what is refused", () => {
  for (const url of [
    "https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/", "https://127.0.0.1./", "https://localhost./", "https://LOCALHOST/", "https://foo.localhost/",
    "https://[::1]/", "https://[0:0:0:0:0:0:0:1]/", "https://[::]/", "https://0.0.0.0/", "https://0/",
    "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://[::ffff:10.0.0.1]/", "https://[::ffff:a00:1]/", "https://[::ffff:192.168.1.1]/", "https://[::ffff:c0a8:101]/", "https://[::ffff:169.254.169.254]/", "https://[::ffff:a9fe:a9fe]/",
    "https://[::127.0.0.1]/", "https://[::7f00:1]/", "https://[64:ff9b::7f00:1]/", "https://[64:ff9b::a9fe:a9fe]/", "https://[2002:7f00:1::]/", "https://[2001:0:7f00:1::]/", "https://[2001:db8::1]/", "https://[fec0::1]/", "https://[fe80::1]/", "https://[fd00::1]/", "https://[fc00::1]/", "https://[ff02::1]/",
    "https://169.254.169.254/", "https://100.64.0.1/", "https://198.18.0.1/", "https://198.19.255.255/", "https://192.0.0.1/", "https://192.0.2.1/", "https://198.51.100.1/", "https://203.0.113.1/", "https://224.0.0.1/", "https://239.1.1.1/", "https://240.0.0.1/", "https://255.255.255.255/", "https://172.16.0.1/", "https://172.31.255.255/", "https://10.0.0.1/", "https://192.168.1.1/",
    "https://service.home.arpa/", "https://nas.test/", "https://a.internal/", "https://a.internal./", "https://intranet/", "https://printer/", "https://a.lan./", "https://hud.trusted.example/",
    "http://8.8.8.8/", "ftp://8.8.8.8/",
    "https://[3fff::1]/", "https://[2620:4f:8000::1]/", "https://[2620:4f:8000:ffff::1]/", "https://[3fff:fff:ffff::1]/", "https://[2001:2::1]/", "https://[2001:10::1]/", "https://[2001:1f:ffff::1]/", "https://[2001:20::1]/", "https://[2001:2f:ffff::1]/", "https://192.31.196.1/", "https://192.52.193.1/", "https://192.175.48.1/",
  ]) test(url, async () => { expect(await allowed(url)).toBe(false); });
});

test("a trusted origin is refused whatever it is: a name, a public address, or a v6 one", async () => {
  const mine = guard(["8.8.4.4", "[2606:4700:4700::1111]", "hud.trusted.example"]);
  for (const url of ["https://8.8.4.4/", "https://[2606:4700:4700::1111]/", "https://hud.trusted.example./"]) expect(await mine(url)).toBe(false);
  expect(await mine("https://8.8.8.8/")).toBe(true);
});

describe("what passes", () => {
  // A name that does not resolve here passes the guard and fails where it is used, so these need no network.
  for (const url of [
    "https://fd.example.com/", "https://fcdn.example.com/", "https://fe9.example.com/", "https://fea.example.com/", "https://feb.example.com/", "https://fontawesome.example.com/", "https://10.example.com/", "https://0.example.com/", "https://127.example.com/", "https://100.example.com/",
    "https://8.8.8.8/", "https://1.1.1.1/", "https://172.32.0.1/", "https://172.15.0.1/", "https://100.128.0.1/", "https://198.20.0.1/", "https://223.255.255.255/",
    "https://[2606:4700:4700::1111]/", "https://[2620:4f:8001::1]/", "https://[2620:4f:7fff::1]/", "https://[2620:4e:8000::1]/", "https://[2a00:1450:4001::1]/", "https://[2001:4860:4860::8888]/", "https://[2001:200::1]/", "https://[3fff:1000::1]/", "https://192.31.197.1/", "https://192.175.49.1/",
  ]) test(url, async () => { expect(await allowed(url)).toBe(true); });
});

describe("the address table, as an address", () => {
  test("something that is not an address is not public", () => {
    expect(publicAddress("fd.example.com")).toBe(false);
    expect(publicAddress("")).toBe(false);
  });
  test("a zone on an address does not change its answer", () => {
    expect(publicAddress("fe80::1%en0")).toBe(false);
  });
});
