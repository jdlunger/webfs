/**
 * Covers Obsidian's embed syntax: what counts as one, what it says about how
 * to show the image, and — the part that matters most — that the text between
 * the brackets survives a trip through the editor unchanged. A vault written
 * elsewhere is only safe to open here if nothing rewrites it.
 */
import { test, expect } from "bun:test";
import {
  WIKI_IMAGE,
  expandWikiImages,
  splitWikiImages,
  wikiImageLayout,
  wikiImageMarkdown,
  wikiImageTarget,
  type MarkdownNode,
} from "./src/wikilinks";

test("an embed is cut out of the text around it", () => {
  expect(splitWikiImages("before ![[shot.png]] after")).toEqual([
    { type: "text", value: "before " },
    { type: WIKI_IMAGE, raw: "shot.png" },
    { type: "text", value: " after" },
  ]);
  // A line that is nothing but an embed leaves no empty text nodes behind.
  expect(splitWikiImages("![[shot.png]]")).toEqual([{ type: WIKI_IMAGE, raw: "shot.png" }]);
});

test("several embeds in one line are each their own", () => {
  expect(splitWikiImages("![[a.png]] and ![[b.png|80]]")).toEqual([
    { type: WIKI_IMAGE, raw: "a.png" },
    { type: "text", value: " and " },
    { type: WIKI_IMAGE, raw: "b.png|80" },
  ]);
});

test("text with no embed comes back as itself, in one piece", () => {
  expect(splitWikiImages("just words")).toEqual([{ type: "text", value: "just words" }]);
  // A link, not an embed: no leading "!".
  expect(splitWikiImages("[[Some Note]]")).toEqual([{ type: "text", value: "[[Some Note]]" }]);
});

test("only images are claimed, so a note embed stays legible", () => {
  // Rendering these as <img> would show a broken image where the name was.
  expect(splitWikiImages("![[Some Note]]")).toEqual([{ type: "text", value: "![[Some Note]]" }]);
  expect(splitWikiImages("![[paper.pdf]]")).toEqual([{ type: "text", value: "![[paper.pdf]]" }]);
  expect(splitWikiImages("![[]]")).toEqual([{ type: "text", value: "![[]]" }]);
});

test("the target is the part before the first pipe", () => {
  expect(wikiImageTarget("shot.png")).toBe("shot.png");
  expect(wikiImageTarget("Pasted image 20260905101712.png|541")).toBe("Pasted image 20260905101712.png");
  // As written in this vault, spaces and all.
  expect(wikiImageTarget("Pasted image 20260903064507.png | center | 623")).toBe("Pasted image 20260903064507.png");
});

test("a bare number is a width, in Obsidian's own reading of it", () => {
  expect(wikiImageLayout("shot.png")).toEqual({ center: false });
  expect(wikiImageLayout("shot.png|541")).toEqual({ width: 541, center: false });
  expect(wikiImageLayout("shot.png|640x480")).toEqual({ width: 640, height: 480, center: false });
  expect(wikiImageLayout("shot.png | center | 623")).toEqual({ width: 623, center: true });
  // Not a size and not "center": ignored rather than guessed at.
  expect(wikiImageLayout("shot.png|huge")).toEqual({ center: false });
});

test("an embed serializes back to exactly the text it was parsed from", () => {
  // Byte-identical, or every note opened here becomes a sync change.
  for (const raw of ["shot.png", "shot.png|541", "Pasted image 20260903064507.png | center | 623"]) {
    const [part] = splitWikiImages(`![[${raw}]]`);
    expect(part).toEqual({ type: WIKI_IMAGE, raw });
    expect(wikiImageMarkdown(raw)).toBe(`![[${raw}]]`);
  }
});

test("the tree walk reaches embeds nested in lists, and leaves code alone", () => {
  const tree: MarkdownNode = {
    type: "root",
    children: [
      {
        type: "list",
        children: [
          {
            type: "listItem",
            children: [{ type: "paragraph", children: [{ type: "text", value: "see ![[shot.png|80]]" }] }],
          },
        ],
      },
      // remark gives code its own node type, so an embed written inside one is
      // never a text node and stays the literal text it was meant to be.
      { type: "inlineCode", value: "![[shot.png]]" },
      { type: "code", lang: "js", value: "const x = \"![[shot.png]]\";" },
    ],
  };

  expandWikiImages(tree);

  expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.children).toEqual([
    { type: "text", value: "see " },
    { type: WIKI_IMAGE, raw: "shot.png|80" },
  ]);
  expect(tree.children?.[1]).toEqual({ type: "inlineCode", value: "![[shot.png]]" });
  expect(tree.children?.[2]).toEqual({ type: "code", lang: "js", value: "const x = \"![[shot.png]]\";" });
});
