/**
 * The sidebar's width is a number in localStorage, which is only interesting
 * where it stops being one: a store that throws, a value written on another
 * screen, a value someone edited by hand.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_CONTENT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from "./src/sidebarWidth";

// Bun has no localStorage, which is the same situation as a browser that
// blocks it — so the tests supply one, and one test takes it away again.
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("a width is held between a readable tree and a usable editor", () => {
  expect(clampSidebarWidth(300)).toBe(300);
  expect(clampSidebarWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
  expect(clampSidebarWidth(5000)).toBe(MAX_SIDEBAR_WIDTH);
  expect(clampSidebarWidth(300.4)).toBe(300);
});

test("the window is a ceiling too, so a width from a larger screen still leaves an editor", () => {
  expect(clampSidebarWidth(500, 700)).toBe(700 - MIN_CONTENT_WIDTH);
  // A window with no room for both loses the argument to the minimum: the
  // tree stays legible, and the pane beside it is the browser's problem.
  expect(clampSidebarWidth(400, 380)).toBe(MIN_SIDEBAR_WIDTH);
});

test("a width survives the round trip", () => {
  saveSidebarWidth(412);
  expect(loadSidebarWidth()).toBe(412);
});

test("nothing stored means the default", () => {
  expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
});

test("a stored value is clamped on the way out, not trusted", () => {
  store.set("webfs:sidebar:width", "9000");
  expect(loadSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);
  store.set("webfs:sidebar:width", "wide please");
  expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  store.set("webfs:sidebar:width", "500");
  expect(loadSidebarWidth(700)).toBe(700 - MIN_CONTENT_WIDTH);
});

test("a localStorage that throws costs the width, not the app", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(() => saveSidebarWidth(300)).not.toThrow();
  expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
});
