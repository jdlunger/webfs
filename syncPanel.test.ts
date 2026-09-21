/**
 * Covers the two pure pieces of the sync dialog: what counts as a repository
 * someone might paste in, and the GitHub token link built from it.
 *
 * The link is worth pinning down because its parameters are GitHub's, not
 * ours — a renamed one fails silently, landing the user on an empty token
 * form with no indication anything was meant to be filled in.
 */
import { test, expect } from "bun:test";
import { parseRepository, tokenSetupUrl } from "./src/SyncPanel";

test("a repository is accepted however someone happens to have it", () => {
  const expected = { owner: "jdlunger", repo: "notes" };
  expect(parseRepository("jdlunger/notes")).toEqual(expected);
  expect(parseRepository("  jdlunger/notes  ")).toEqual(expected);
  expect(parseRepository("jdlunger/notes/")).toEqual(expected);
  expect(parseRepository("https://github.com/jdlunger/notes")).toEqual(expected);
  expect(parseRepository("https://github.com/jdlunger/notes.git")).toEqual(expected);
  expect(parseRepository("git@github.com:jdlunger/notes.git")).toEqual(expected);
});

test("something that isn't a repository is rejected rather than half-parsed", () => {
  expect(parseRepository("")).toBeNull();
  expect(parseRepository("notes")).toBeNull();
  expect(parseRepository("jdlunger / notes")).toBeNull();
  expect(parseRepository("https://github.com/jdlunger/notes/tree/main")).toBeNull();
});

test("the token link pre-fills the permission, owner and expiry", () => {
  const url = new URL(tokenSetupUrl("jdlunger/notes"));

  expect(url.origin + url.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
  // write implies read, and GitHub adds metadata:read itself.
  expect(url.searchParams.get("contents")).toBe("write");
  // target_name is the repository's *owner*; there is no parameter for the
  // repository, which is why the dialog says to pick it on the page.
  expect(url.searchParams.get("target_name")).toBe("jdlunger");
  expect(url.searchParams.get("name")).toBe("webfs");
  // The page's own default is 30 days, which would break sync in a month.
  expect(url.searchParams.get("expires_in")).toBe("365");
  expect(url.searchParams.get("description")).toContain("jdlunger/notes");
});

test("the link stays usable before a repository has been typed", () => {
  const url = new URL(tokenSetupUrl(""));
  expect(url.searchParams.get("contents")).toBe("write");
  // No owner to point at yet; GitHub defaults to the signed-in account.
  expect(url.searchParams.has("target_name")).toBe(false);
});

test("the pre-filled name and description stay inside GitHub's limits", () => {
  const url = new URL(tokenSetupUrl("a-very-long-organization-name/a-very-long-repository-name"));
  expect(url.searchParams.get("name")!.length).toBeLessThanOrEqual(40);
  expect(url.searchParams.get("description")!.length).toBeLessThanOrEqual(1024);
});
