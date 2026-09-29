/**
 * The crash screen: what the page says when webfs fails before it can draw.
 *
 * Two halves. The pure one — how a thrown value is reduced to a printable
 * line, and what the copyable report says — is straightforward. The other is
 * the panel itself, which only matters if it actually reaches the document, so
 * it's driven against a fake DOM here rather than trusted: this code runs in
 * the situation where everything else is broken, and a crash screen that
 * silently fails to appear leaves the blank page it exists to replace.
 */
import { test, expect, beforeEach } from "bun:test";

// --- a DOM small enough to read, large enough for crash.ts ------------------

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  className = "";
  textContent = "";
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public tagName: string) {}

  get childElementCount() {
    return this.children.length;
  }
  appendChild(child: FakeNode) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click ?? []) fn({ currentTarget: this });
  }
  get classList() {
    return {
      remove: (name: string) => {
        this.className = this.className
          .split(" ")
          .filter(part => part !== name)
          .join(" ");
      },
    };
  }
  /** Everything written into this subtree, for asserting on what's on screen. */
  get text(): string {
    return [this.textContent, ...this.children.map(child => child.text)].join("\n");
  }
  find(className: string): FakeNode | null {
    if (this.className.split(" ").includes(className)) return this;
    for (const child of this.children) {
      const hit = child.find(className);
      if (hit) return hit;
    }
    return null;
  }
}

// crash.ts is imported before the fake DOM is built, deliberately — it reads the
// globals when called, not at module scope, which is itself the point: it must
// not touch anything at import time that could throw before it's installed.
const { describeError, describeWhere, formatReport, installCrashHandlers, reportCrash, WATCHDOG_MS } = await import("./src/crash");

let body: FakeNode;
let root: FakeNode;
let timers: Array<() => void>;
let reloads: number;

function installDom() {
  body = new FakeNode("body");
  root = new FakeNode("div");
  root.attributes.id = "root";
  timers = [];
  reloads = 0;
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const document = {
    body,
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: (tag: string) => new FakeNode(tag),
    addEventListener: () => {},
  };
  const win = {
    document,
    location: { href: "https://example.com/webfs/", reload: () => void reloads++ },
    addEventListener: (type: string, fn: (ev: unknown) => void) => void (listeners[type] ??= []).push(fn),
    dispatch: (type: string, ev: unknown) => {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
    setTimeout: (fn: () => void) => void timers.push(fn),
  };
  Object.assign(globalThis, { document, window: win, navigator: { userAgent: "FakeKit/1.0" } });
  return win;
}

beforeEach(() => {
  installDom();
  // Each test is a fresh page load, which is what installing the handlers
  // means — it clears anything a previous one recorded.
  if (typeof installCrashHandlers === "function") installCrashHandlers();
});


// --- reducing a thrown value ------------------------------------------------

test("an Error prints as name, message and stack", () => {
  const error = new TypeError("x is not a function");
  const described = describeError(error);
  expect(described.message).toBe("TypeError: x is not a function");
  expect(described.stack).toContain("TypeError");
});

test("what reaches a global handler is often not an Error at all", () => {
  expect(describeError("boom").message).toBe("boom");
  expect(describeError(undefined).message).toBe("Thrown undefined");
  // The interesting one: String() on this gives "[object Object]", which is
  // exactly as useful as the blank page it would be explaining.
  expect(describeError({ status: 404, url: "/chunk.js" }).message).toBe('{"status":404,"url":"/chunk.js"}');
});

test("a value that can't be stringified still prints something", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(describeError(circular).message).toBe("[object Object]");
});

test("a position is only added when the browser gave one", () => {
  expect(describeWhere("app.js", 12, 3)).toBe("app.js:12:3");
  expect(describeWhere("app.js", 0, 0)).toBe("app.js");
  expect(describeWhere(null, 12, 3)).toBeNull();
});

// --- the copyable report ----------------------------------------------------

const ENV = {
  version: "v128",
  commit: "abc1234",
  url: "https://example.com/webfs/Notes/todo.md",
  userAgent: "FakeKit/1.0",
  at: "2026-09-29T10:00:00.000Z",
};

test("the report leads with the build and the browser, then every error", () => {
  const text = formatReport(
    [
      { source: "error", message: "TypeError: nope", where: "app.js:1:2", stack: "at start\nat go" },
      { source: "promise", message: "DOMException: quota", where: null, stack: null },
    ],
    ENV,
  );
  expect(text).toContain("webfs v128 (abc1234)");
  expect(text).toContain("FakeKit/1.0");
  expect(text).toContain("[error] TypeError: nope");
  expect(text).toContain("  at app.js:1:2");
  // Both, not just the first: the second failure is often the informative one.
  expect(text).toContain("[promise] DOMException: quota");
});

// --- the panel --------------------------------------------------------------

test("a failure with nothing on screen takes the page", () => {
  reportCrash("error", new Error("chunk load failed"), "chunk-x.js:1:1");
  const panel = body.find("crash")!;
  expect(panel).not.toBeNull();
  expect(panel.className).not.toContain("crash-minimized");
  expect(panel.text).toContain("chunk load failed");
  expect(panel.text).toContain("chunk-x.js:1:1");
});

test("an error behind a working app gets a bar, not the screen", () => {
  root.appendChild(new FakeNode("div")); // the app rendered
  reportCrash("error", new Error("sync failed"));
  const panel = body.find("crash")!;
  expect(panel.className).toContain("crash-minimized");
  expect(panel.find("crash-bar")!.textContent).toContain("sync failed");
  // …and opening it shows the same report rather than a second kind of panel.
  panel.find("crash-bar")!.click();
  expect(panel.className).not.toContain("crash-minimized");
  expect(panel.text).toContain("sync failed");
});

test("a render failure is fatal even though the old tree is still up", () => {
  root.appendChild(new FakeNode("div"));
  reportCrash("render", new Error("hooks order changed"));
  expect(body.find("crash")!.className).not.toContain("crash-minimized");
});

test("the panel is replaced, not stacked, as more errors arrive", () => {
  reportCrash("error", new Error("first"));
  reportCrash("promise", new Error("second"));
  expect(body.children.filter(node => node.className.startsWith("crash")).length).toBe(1);
  expect(body.find("crash")!.text).toContain("first");
  expect(body.find("crash")!.text).toContain("second");
});

test("Reload reloads", () => {
  reportCrash("error", new Error("nope"));
  const reload = body
    .find("crash-actions")!
    .children.find(node => node.textContent === "Reload")!;
  reload.click();
  expect(reloads).toBe(1);
});

// --- the handlers -----------------------------------------------------------

test("a window error and an unhandled rejection both reach the page", () => {
  const win = globalThis.window as unknown as { dispatch: (type: string, ev: unknown) => void };
  installCrashHandlers();
  win.dispatch("error", { message: "boom", error: new Error("boom"), filename: "app.js", lineno: 4, colno: 9 });
  expect(body.find("crash")!.text).toContain("app.js:4:9");
  win.dispatch("unhandledrejection", { reason: new Error("rejected") });
  expect(body.find("crash")!.text).toContain("rejected");
});

test("a failed asset load is not a crash", () => {
  const win = globalThis.window as unknown as { dispatch: (type: string, ev: unknown) => void };
  installCrashHandlers();
  // An <img> that 404s fires "error" on the window too, as a bare Event.
  win.dispatch("error", { target: {} });
  expect(body.find("crash")).toBeNull();
});

test("a load that never finishes and never throws is reported by the watchdog", () => {
  installCrashHandlers();
  for (const fire of timers) fire();
  expect(body.find("crash")!.text).toContain(`${Math.round(WATCHDOG_MS / 1000)} seconds`);
});

test("the watchdog says nothing about an app that did start", () => {
  installCrashHandlers();
  root.appendChild(new FakeNode("div"));
  for (const fire of timers) fire();
  expect(body.find("crash")).toBeNull();
});

test("errors caught before the bundle loaded are taken over, not lost", () => {
  const win = globalThis.window as unknown as { __webfsBoot?: { errors: unknown[]; claimed: boolean } };
  win.__webfsBoot = {
    errors: [{ source: "error", message: "SyntaxError in chunk", where: "chunk-x.js:1:1" }],
    claimed: false,
  };
  installCrashHandlers();
  expect(body.find("crash")!.text).toContain("SyntaxError in chunk");
  // Claiming them is what stops index.html's own last-resort panel appearing
  // on top of this one.
  expect(win.__webfsBoot.claimed).toBe(true);
});
