/**
 * What a user sees when webfs fails before it can draw anything.
 *
 * The app is a single page with no server: if the bundle throws while it is
 * evaluating, if a chunk the service worker cached has gone missing, or if
 * the first render throws, the document stays exactly as index.html left it —
 * an empty `<div id="root">`, which is a white screen with nothing on it and
 * nothing to do about it. That happened on a phone, offline, in the installed
 * PWA: no devtools, no console, no way to ask what went wrong, and by the
 * time it could be asked it no longer reproduced.
 *
 * So the failure has to say so on the page itself. Three ways in, because a
 * blank screen has three causes and only the first is an exception anyone
 * catches:
 *
 *   - `window.onerror` / `unhandledrejection`, which covers a module that
 *     threw while evaluating and a promise nobody awaited;
 *   - React's error boundary (`reportCrash` from `frontend.tsx`), for a render
 *     that throws;
 *   - a watchdog, for the case with no error at all — a load that simply never
 *     finishes, which is what a hung `await` in startup looks like.
 *
 * Everything here is plain DOM and no imports beyond the version. It runs in
 * the situation where React is the thing that broke, so it can't be React, and
 * it must not be able to throw on its own account — a crash screen that
 * crashes leaves the blank page it was written to replace.
 */
import { APP_COMMIT, versionLabel } from "./version";

/** How a failure arrived. Shown to the user, so these read as English. */
export type CrashSource = "error" | "promise" | "render" | "timeout";

export interface CrashEntry {
  source: CrashSource;
  message: string;
  /** Where it came from — a file and position, when the browser said. */
  where: string | null;
  stack: string | null;
}

/** What the report says about the build and the browser it ran in. */
export interface CrashEnv {
  version: string;
  commit: string | null;
  url: string;
  userAgent: string;
  at: string;
}

/**
 * How long a load may take before the absence of a screen is itself the bug.
 *
 * Generous on purpose: the first paint waits on OPFS, a tree walk and Crepe,
 * and a slow phone opening a large vault is not a crash. The cost of being
 * wrong is a panel over a working app, so it errs long.
 */
export const WATCHDOG_MS = 15_000;

/**
 * Reduces anything that can be thrown to something printable.
 *
 * `throw` takes any value, and the ones that reach a global handler are
 * routinely not Errors: a rejected fetch promise, a string, `undefined` from a
 * worker message. `String(value)` alone gives "[object Object]" for the most
 * interesting of those, so an object is JSON-ed when it can be.
 */
export function describeError(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) {
    const name = value.name || "Error";
    const message = value.message ? `${name}: ${value.message}` : name;
    return { message, stack: value.stack ?? null };
  }
  if (typeof value === "string") return { message: value, stack: null };
  if (value === null || value === undefined) return { message: `Thrown ${String(value)}`, stack: null };
  try {
    const json = JSON.stringify(value);
    if (json !== undefined && json !== "{}") return { message: json, stack: null };
  } catch {
    // A circular or exotic value. String() below is the fallback.
  }
  return { message: String(value), stack: null };
}

/** `filename:line:col`, as far as the browser was willing to say. */
export function describeWhere(filename?: string | null, line?: number | null, column?: number | null): string | null {
  if (!filename) return null;
  const at = typeof line === "number" && line > 0 ? `:${line}${typeof column === "number" && column > 0 ? `:${column}` : ""}` : "";
  return `${filename}${at}`;
}

/**
 * The whole report as one block of text, for the Copy button.
 *
 * This is the artifact that actually travels: someone holding a phone can't
 * read a stack off a screenshot into a bug report, but they can copy this and
 * paste it. So it leads with the build and the browser — the two questions any
 * answer starts with — and prints every error, not just the first.
 */
export function formatReport(entries: readonly CrashEntry[], env: CrashEnv): string {
  const lines = [
    `webfs ${env.version}${env.commit ? ` (${env.commit})` : ""}`,
    `when: ${env.at}`,
    `url:  ${env.url}`,
    `ua:   ${env.userAgent}`,
  ];
  for (const entry of entries) {
    lines.push("", `[${entry.source}] ${entry.message}`);
    if (entry.where) lines.push(`  at ${entry.where}`);
    if (entry.stack) lines.push(entry.stack.replace(/^/gm, "  "));
  }
  return lines.join("\n");
}

/** What `formatReport` needs about this build and page, read from the browser. */
export function readEnv(): CrashEnv {
  return {
    version: versionLabel(),
    commit: APP_COMMIT,
    url: safely(() => window.location.href, "?"),
    userAgent: safely(() => navigator.userAgent, "?"),
    at: safely(() => new Date().toISOString(), "?"),
  };
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

// --- the panel ---------------------------------------------------------------

const entries: CrashEntry[] = [];
let panel: HTMLElement | null = null;
let dismissed = false;
/** Set once a failure has left the page with nothing usable on it. */
let fatal = false;

/** Whether the app has drawn anything yet — an empty root is the blank page. */
function rendered(): boolean {
  const root = document.getElementById("root");
  return root !== null && root.childElementCount > 0;
}

/**
 * Records a failure and shows it if the page has nothing else on it.
 *
 * The condition is what keeps this from being a nuisance. Before the first
 * render there is nothing to lose and everything to explain, so the panel
 * takes the screen. Afterwards the app is on screen and working as far as
 * anyone can see; covering it with a stack trace because a sync call rejected
 * would be its own bug, so a mounted app gets the collapsed bar instead, which
 * says an error happened and opens the same report on a tap.
 */
export function reportCrash(source: CrashSource, value: unknown, where: string | null = null): void {
  const { message, stack } = describeError(value);
  entries.push({ source, message, where, stack });
  try {
    console.error(`[webfs] ${source}:`, value);
  } catch {}
  if (source === "render" || !rendered()) {
    fatal = true;
    dismissed = false;
  }
  show();
}

/** Anything the pre-bundle script in index.html caught while we were loading. */
function drainBootErrors(): void {
  const boot = (window as unknown as { __webfsBoot?: { errors?: unknown[]; claimed?: boolean; panel?: { remove(): void } | null } })
    .__webfsBoot;
  if (!boot) return;
  boot.claimed = true;
  // It may already have drawn its own last-resort panel — a bundle that was
  // merely slow rather than broken looks the same from there until it
  // arrives. This one supersedes it.
  boot.panel?.remove();
  boot.panel = null;
  const pending = boot.errors ?? [];
  boot.errors = [];
  for (const raw of pending) {
    const item = raw as { source?: CrashSource; error?: unknown; message?: string; where?: string | null };
    reportCrash(item.source ?? "error", item.error ?? item.message ?? "Unknown startup error", item.where ?? null);
  }
}

/**
 * Installs the handlers and starts the watchdog. Called first thing in
 * `frontend.tsx`, before any other module can do something that throws.
 */
export function installCrashHandlers(): void {
  // A page load starts with nothing recorded and nothing on screen. Saying so
  // here rather than in the initialisers above is what lets the tests drive
  // several independent loads through one imported module.
  entries.length = 0;
  panel?.remove();
  panel = null;
  dismissed = false;
  fatal = false;

  drainBootErrors();

  window.addEventListener("error", event => {
    // A failed <img>/<script>/<link> load also fires "error" on the window
    // during capture, but as an Event on the element rather than an
    // ErrorEvent; `message` is what tells the two apart.
    if (!("message" in event)) return;
    reportCrash("error", event.error ?? event.message, describeWhere(event.filename, event.lineno, event.colno));
  });

  window.addEventListener("unhandledrejection", event => {
    reportCrash("promise", event.reason);
  });

  window.setTimeout(() => {
    if (rendered() || entries.length > 0) return;
    reportCrash(
      "timeout",
      `webfs didn't finish starting within ${Math.round(WATCHDOG_MS / 1000)} seconds, and nothing threw. ` +
        `An outdated cached build is the usual cause — "Clear cache and reload" below refetches it.`,
    );
  }, WATCHDOG_MS);
}

function show(): void {
  if (dismissed) return;
  try {
    render();
  } catch {
    // The panel is the last thing standing; if building it throws, the page
    // keeps whatever it had rather than taking the error handler down too.
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(): void {
  if (!document.body) {
    // Still parsing <head>: the panel has nowhere to go yet. Rendering is
    // idempotent, so simply coming back when the body exists is enough.
    document.addEventListener("DOMContentLoaded", () => show(), { once: true });
    return;
  }
  panel?.remove();
  panel = el("div", fatal ? "crash" : "crash crash-minimized");

  const report = formatReport(entries, readEnv());
  const latest = entries[entries.length - 1];

  const bar = el("button", "crash-bar");
  bar.setAttribute("type", "button");
  bar.textContent = `⚠ ${entries.length} error${entries.length === 1 ? "" : "s"} — ${latest ? latest.message : ""}`;
  bar.addEventListener("click", () => {
    panel?.classList.remove("crash-minimized");
  });
  panel.appendChild(bar);

  const box = el("div", "crash-box");
  box.appendChild(el("h1", "crash-title", "webfs couldn't start"));
  box.appendChild(
    el(
      "p",
      "crash-lede",
      "Something failed before the app could draw itself. The details below are the whole of what went wrong — copy them into a bug report.",
    ),
  );

  const pre = el("pre", "crash-report", report);
  box.appendChild(pre);

  const actions = el("div", "crash-actions");
  actions.appendChild(button("Reload", () => window.location.reload()));
  actions.appendChild(
    button("Copy details", async ev => {
      const done = await copy(report);
      (ev.currentTarget as HTMLElement).textContent = done ? "Copied" : "Press and hold the text above to copy";
    }),
  );
  // The failure this was written for is a stale cached shell, which a reload
  // can't shift — the worker answers it from the cache it is stale in. On a
  // phone there is no other way out of that, so the escape hatch is here.
  actions.appendChild(button("Clear cache and reload", () => void clearCaches()));
  if (!fatal) actions.appendChild(button("Dismiss", () => dismiss()));
  box.appendChild(actions);

  panel.appendChild(box);
  document.body.appendChild(panel);
}

function button(label: string, onClick: (ev: MouseEvent) => void): HTMLElement {
  const node = el("button", "crash-button", label);
  node.setAttribute("type", "button");
  node.addEventListener("click", onClick);
  return node;
}

function dismiss(): void {
  dismissed = true;
  panel?.remove();
  panel = null;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Safari refuses the clipboard outside a user gesture it recognises, and
    // an installed PWA is exactly where that bites. The text is on screen and
    // selectable, so saying so is the fallback.
    return false;
  }
}

/**
 * Unregisters the service worker and empties its caches, then reloads.
 *
 * Deletes nothing of the user's: OPFS is the document store and is untouched,
 * as is localStorage. This clears only the copy of the *app* that the worker
 * is serving, which is the thing that can strand a device on a build that
 * doesn't work.
 */
async function clearCaches(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
  } catch {}
  try {
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  } catch {}
  window.location.reload();
}
