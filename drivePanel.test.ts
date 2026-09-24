/**
 * Covers the pure pieces of the drive panel: what counts as a repository
 * someone might paste in, the GitHub token link built from it, and the
 * last-synced time the strip falls back to when the device is offline.
 *
 * The link is worth pinning down because its parameters are GitHub's, not
 * ours — a renamed one fails silently, landing the user on an empty token
 * form with no indication anything was meant to be filled in.
 */
import { test, expect } from "bun:test";
import { parseRepository, syncedAtLabel, tokenSetupUrl } from "./src/DrivePanel";

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

// --- when this device last got through ---------------------------------------

/**
 * These assert which *branch* the label took, not how the locale renders a
 * date. The month order and the clock are the reader's own settings —
 * pinning "23 Sep 14:32" here would be pinning this container's locale, and
 * would fail on a machine set to anything else.
 */
const at = (spec: string) => new Date(spec).getTime();

test("a sync earlier today is named by the clock, not the date", () => {
  const now = at("2026-09-24T18:00:00");
  expect(syncedAtLabel(at("2026-09-24T09:15:00"), now)).toStartWith("today ");
  // Minutes ago is still today: this label is about staleness you can place,
  // not about how recent it was — "just now" is the other line's job.
  expect(syncedAtLabel(at("2026-09-24T17:59:00"), now)).toStartWith("today ");
});

test("yesterday is named, because a date has to be read twice", () => {
  const now = at("2026-09-24T09:00:00");
  expect(syncedAtLabel(at("2026-09-23T23:50:00"), now)).toStartWith("yesterday ");
  // Ten minutes earlier by the clock, but a different day — which is the
  // point of comparing calendar days rather than hours apart.
  expect(syncedAtLabel(at("2026-09-24T08:50:00"), now)).toStartWith("today ");
});

test("anything older carries its date, and its year only when that differs", () => {
  const now = at("2026-09-24T09:00:00");
  const thisYear = syncedAtLabel(at("2026-03-02T14:32:00"), now);
  expect(thisYear).not.toStartWith("today");
  expect(thisYear).not.toStartWith("yesterday");
  expect(thisYear).not.toContain("2026");

  // A device that has been shut in a drawer since last year should say so.
  expect(syncedAtLabel(at("2025-12-30T14:32:00"), now)).toContain("2025");
});
