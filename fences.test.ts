/**
 * Covers the triple-backtick command syntax: what counts as one, what it
 * writes back, and that an ordinary code block is left alone. The last is the
 * one that matters most — a note full of shell snippets must not start
 * sprouting todo lists.
 */
import { test, expect } from "bun:test";
import { FENCE_BLOCK, describeScope, expandFences, fenceMarkdown, isFenceName, parseFence, type MarkdownNode } from "./src/fences";

test("a fence naming a command is one, and nothing else is", () => {
  expect(parseFence("todo", "")).toEqual({ name: "todo", args: "" });
  expect(parseFence("todo", "Projects/Side")).toEqual({ name: "todo", args: "Projects/Side" });
  expect(parseFence("todo", "  Notes  ")).toEqual({ name: "todo", args: "Notes" });
  expect(parseFence("ts", "")).toBeNull();
  expect(parseFence(null, null)).toBeNull();
  expect(parseFence(undefined, undefined)).toBeNull();
  expect(isFenceName("todo")).toBe(true);
  expect(isFenceName("todos")).toBe(false);
});

test("a command is written back as the fence it came from", () => {
  expect(fenceMarkdown({ name: "todo", args: "" })).toBe("```todo\n```");
  expect(fenceMarkdown({ name: "todo", args: "Projects" })).toBe("```todo Projects\n```");
});

test("the fence is long enough to hold whatever is inside it", () => {
  // Nothing has a body yet, but a short fence would end the block early and
  // turn the rest of the note into prose — too quiet a failure to leave to
  // the day something does.
  expect(fenceMarkdown({ name: "todo", args: "" }, "plain")).toBe("```todo\nplain\n```");
  expect(fenceMarkdown({ name: "todo", args: "" }, "a ``` b")).toBe("````todo\na ``` b\n````");
});

test("a code block that names a command becomes a node of its own", () => {
  const tree: MarkdownNode = {
    type: "root",
    children: [
      { type: "code", lang: "todo", meta: "Notes", value: "" },
      { type: "code", lang: "ts", meta: null, value: "const x = 1;" },
    ],
  };
  expect(expandFences(tree).children).toEqual([
    { type: FENCE_BLOCK, name: "todo", args: "Notes", value: "" },
    { type: "code", lang: "ts", meta: null, value: "const x = 1;" },
  ]);
});

test("a command inside a blockquote is found too", () => {
  const tree: MarkdownNode = {
    type: "root",
    children: [{ type: "blockquote", children: [{ type: "code", lang: "todo", meta: "", value: "" }] }],
  };
  const quote = expandFences(tree).children?.[0];
  expect(quote?.children).toEqual([{ type: FENCE_BLOCK, name: "todo", args: "", value: "" }]);
});

test("the block says what it is looking at", () => {
  expect(describeScope("")).toBe("everywhere in this drive");
  expect(describeScope("Projects")).toBe("in Projects");
  expect(describeScope("/Projects/")).toBe("in Projects");
});
