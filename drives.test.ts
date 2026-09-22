/**
 * The drive model: what names a drive, where its files go, and how a URL is
 * split back into the two.
 *
 * Worth covering without a browser because every one of these is a pure
 * string operation that three unrelated things depend on agreeing about — the
 * registry, the address bar and the OPFS layout. A mismatch between any two
 * shows up as a drive that opens empty.
 */
import { test, expect } from "bun:test";
import {
  DRIVES_DIR,
  describeDrive,
  driveId,
  driveUrl,
  findDrive,
  mountOf,
  parseDrivePath,
  validateDrive,
  type Drive,
} from "./src/drives";

const local: Drive = { kind: "opfs", name: "notes" };
const remote: Drive = { kind: "github", owner: "jdlunger", repo: "webfs", branch: "main", token: "t", auto: true };

test("a drive is named by two segments, whichever kind it is", () => {
  expect(driveId(local)).toBe("opfs/notes");
  expect(driveId(remote)).toBe("jdlunger/webfs");
  expect(describeDrive(local)).toBe("notes");
  expect(describeDrive(remote)).toBe("jdlunger/webfs");
});

test("files live under the drives directory, one folder per drive", () => {
  expect(mountOf(local)).toEqual([DRIVES_DIR, "opfs", "notes"]);
  expect(mountOf(remote)).toEqual([DRIVES_DIR, "jdlunger", "webfs"]);
});

// Everything webfs predates drives with sits beside this directory, so a local
// drive called "Notes" can't collide with a leftover "Notes" folder.
test("no drive's mount is at the OPFS root", () => {
  for (const drive of [local, remote]) expect(mountOf(drive)[0]).toBe(DRIVES_DIR);
});

test("the branch is not part of a drive's identity", () => {
  const other: Drive = { ...remote, branch: "drafts" };
  expect(driveId(other)).toBe(driveId(remote));
  expect(mountOf(other)).toEqual(mountOf(remote));
});

test("a URL splits into the drive and the path inside it", () => {
  expect(parseDrivePath("/opfs/notes/Notes/todo.md")).toEqual({ id: "opfs/notes", path: "/Notes/todo.md" });
  expect(parseDrivePath("/jdlunger/webfs/README.md")).toEqual({ id: "jdlunger/webfs", path: "/README.md" });
  // A drive with no file selected.
  expect(parseDrivePath("/opfs/notes")).toEqual({ id: "opfs/notes", path: "/" });
  expect(parseDrivePath("/opfs/notes/")).toEqual({ id: "opfs/notes", path: "/" });
});

test("a path that names no drive is not half-parsed", () => {
  expect(parseDrivePath("/")).toBeNull();
  expect(parseDrivePath("")).toBeNull();
  expect(parseDrivePath("/opfs")).toBeNull();
});

/**
 * The id is decoded because it's compared against the registry; the rest is
 * left alone because whoever resolves it against a tree decodes it there, and
 * decoding twice would turn a literal "%20" in a filename into a space.
 */
test("the drive is decoded and the file path is left encoded", () => {
  const drive: Drive = { kind: "opfs", name: "my notes" };
  expect(driveUrl(drive)).toBe("/opfs/my%20notes");
  const parsed = parseDrivePath("/opfs/my%20notes/a%20file%20%2520.md");
  expect(parsed).toEqual({ id: "opfs/my notes", path: "/a%20file%20%2520.md" });
});

test("a drive's URL parses back to the drive it came from", () => {
  const drives: Drive[] = [local, remote, { kind: "opfs", name: "日本語" }, { kind: "opfs", name: "café" }];
  for (const drive of drives) {
    const parsed = parseDrivePath(driveUrl(drive));
    expect(parsed).not.toBeNull();
    expect(findDrive(drives, parsed!.id)).toBe(drive);
  }
});

test("malformed encoding is rejected rather than thrown out of", () => {
  expect(parseDrivePath("/opfs/%E0%A4%A/x.md")).toBeNull();
});

test("a name the filesystem would refuse is refused here", () => {
  expect(validateDrive({ kind: "opfs", name: "" }, [])).not.toBeNull();
  expect(validateDrive({ kind: "opfs", name: ".." }, [])).not.toBeNull();
  expect(validateDrive({ kind: "opfs", name: "a/b" }, [])).not.toBeNull();
  expect(validateDrive({ kind: "opfs", name: "café notes" }, [])).toBeNull();
});

// Otherwise /opfs/notes would mean both a local drive and that owner's repo,
// and nothing about the URL could say which.
test("an owner called opfs is refused, because it would be ambiguous", () => {
  expect(validateDrive({ ...remote, owner: "opfs" }, [])).toContain("reserved");
});

test("a drive already in the registry isn't added twice", () => {
  expect(validateDrive({ kind: "opfs", name: "notes" }, [local])).toContain("already");
  // A different branch of the same repository is the same drive.
  expect(validateDrive({ ...remote, branch: "drafts" }, [remote])).toContain("already");
  // Two repositories of the same name under different owners are not.
  expect(validateDrive({ ...remote, owner: "someone" }, [remote])).toBeNull();
});

test("a GitHub drive needs a branch and a token", () => {
  expect(validateDrive({ ...remote, branch: "" }, [])).not.toBeNull();
  expect(validateDrive({ ...remote, token: "" }, [])).not.toBeNull();
});
