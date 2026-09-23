/**
 * The link that hands a GitHub drive to another device.
 *
 * Two properties are worth pinning: the token goes in the fragment and never
 * the query string, and a fragment from a stranger can't name something the
 * add dialog would have refused.
 */
import { test, expect } from "bun:test";
import { SHARE_WARNING, looksLikeShareLink, parseShareLink, shareLink } from "./src/shareLink";
import type { GitHubDrive } from "./src/drives";

const DRIVE: GitHubDrive = {
  kind: "github",
  owner: "jdlunger",
  repo: "jdTHIM",
  branch: "main",
  token: "github_pat_11ABCDEF_secret",
  auto: true,
};

test("the token is in the fragment, so no server ever sees it", () => {
  const link = shareLink(DRIVE, "https://jdlunger.github.io", "/webfs");
  const url = new URL(link);
  // The part before "#" is what goes in the request line and the Referer.
  expect(url.search).toBe("");
  expect(link.split("#")[0]).not.toContain(DRIVE.token);
  expect(url.hash).toContain(encodeURIComponent(DRIVE.token));
});

test("it points at the app root, which is a page Pages actually serves", () => {
  expect(shareLink(DRIVE, "https://jdlunger.github.io", "/webfs").split("#")[0]).toBe("https://jdlunger.github.io/webfs/");
  // Locally there is no base path, and the root is still the root.
  expect(shareLink(DRIVE, "http://localhost:3000", "").split("#")[0]).toBe("http://localhost:3000/");
});

test("a link round-trips into the drive it came from", () => {
  const link = shareLink(DRIVE, "https://jdlunger.github.io", "/webfs");
  expect(parseShareLink(new URL(link).hash)).toEqual(DRIVE);
});

test("auto-sync is carried, and defaults on when the link doesn't say", () => {
  const manual = { ...DRIVE, auto: false };
  expect(parseShareLink(new URL(shareLink(manual, "https://x", "")).hash)?.auto).toBe(false);
  expect(parseShareLink("#add-drive=1&owner=a&repo=b&branch=main&token=t")?.auto).toBe(true);
});

test("a fragment that isn't one of ours is not one of ours", () => {
  expect(parseShareLink("")).toBeNull();
  expect(parseShareLink("#")).toBeNull();
  expect(parseShareLink("#section-2")).toBeNull();
  expect(parseShareLink("#owner=a&repo=b&branch=main&token=t")).toBeNull(); // No marker.
  expect(looksLikeShareLink("#section-2")).toBe(false);
  expect(looksLikeShareLink("#add-drive=1&owner=a&repo=b&branch=main&token=t")).toBe(true);
});

test("a link missing any of the four is refused rather than half-read", () => {
  for (const missing of ["owner", "repo", "branch", "token"]) {
    const params = new URLSearchParams({ "add-drive": "1", owner: "a", repo: "b", branch: "main", token: "t" });
    params.delete(missing);
    expect(parseShareLink(`#${params}`)).toBeNull();
  }
  // Present but empty is the same as absent.
  expect(parseShareLink("#add-drive=1&owner=a&repo=b&branch=main&token=%20")).toBeNull();
});

test("a link can't name something the add dialog would have refused", () => {
  // `opfs` is the local-drive namespace: a repo owned by it would shadow one.
  expect(parseShareLink("#add-drive=1&owner=opfs&repo=notes&branch=main&token=t")).toBeNull();
  // A slash in either segment would make the drive id ambiguous.
  expect(parseShareLink("#add-drive=1&owner=a%2Fb&repo=c&branch=main&token=t")).toBeNull();
  expect(parseShareLink("#add-drive=1&owner=a&repo=c%5Cd&branch=main&token=t")).toBeNull();
});

test("a token with URL punctuation in it survives the round trip", () => {
  const awkward = { ...DRIVE, token: "a+b/c=d&e?f#g", branch: "feature/some thing" };
  const link = shareLink(awkward, "https://x", "");
  expect(parseShareLink(new URL(link).hash)).toEqual(awkward);
});

test("the warning says what the link actually is", () => {
  expect(SHARE_WARNING).toContain("token");
  expect(SHARE_WARNING).toContain("revoke");
});
