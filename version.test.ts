/**
 * The build number in the corner.
 *
 * Two halves: how it reads, and whether it survives the bundler at all. The
 * second one is the reason this file exists — an `process.env.X` the build
 * doesn't inline is left as literal source referencing a `process` global
 * that a browser doesn't have, so the failure isn't a wrong number, it's a
 * throw on module load. That can't be seen from here without actually
 * building, so this builds.
 */
import { test, expect } from "bun:test";
import { versionLabel, versionTitle } from "./src/version";

test("the label is the number, or says plainly that there isn't one", () => {
  expect(versionLabel("128")).toBe("v128");
  expect(versionLabel(null)).toBe("dev");
});

test("the tooltip says the same thing in full, with the commit when there is one", () => {
  expect(versionTitle("128", "25dae50")).toBe("Build 128 (25dae50)");
  expect(versionTitle("128", null)).toBe("Build 128");
  expect(versionTitle(null, "25dae50")).toBe("A local build (25dae50), with no version number");
});

test("the defines reach the bundle, and no bare process reference is left behind", async () => {
  const built = await Bun.build({
    entrypoints: ["./src/version.ts"],
    target: "browser",
    define: {
      "process.env.BUN_PUBLIC_VERSION": JSON.stringify("128"),
      "process.env.BUN_PUBLIC_COMMIT": JSON.stringify("25dae50"),
    },
  });
  const code = await built.outputs[0]!.text();

  expect(code).toContain("128");
  expect(code).toContain("25dae50");
  // The try/catch stays (it's what makes an *un*-defined build survive), but
  // nothing may read `process` — this module runs in a browser.
  expect(code).not.toContain("process.env");
});

test("a build with no defines still loads, where there is no `process` at all", async () => {
  // What `bun dev` serves: no defines, so the bundle really does carry a
  // `process.env` reference to a global a browser doesn't have. Importing it
  // here would prove nothing — Bun *has* `process`, so the read would quietly
  // give undefined and the test would pass for the wrong reason. It's built
  // as an IIFE and run with `process` shadowed instead, which is the only way
  // to make the throw this module guards against actually happen.
  const entry = `${import.meta.dir}/node_modules/.cache/version-probe.ts`;
  await Bun.write(
    entry,
    `import { APP_VERSION, versionLabel } from "${import.meta.dir}/src/version";\n` +
      `globalThis.probe = { APP_VERSION, label: versionLabel() };\n`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" });
  const code = await built.outputs[0]!.text();
  expect(code).toContain("process.env"); // The reference survives, as documented.

  const globals: Record<string, unknown> = {};
  new Function("process", "globalThis", code)(undefined, globals);
  expect(globals.probe).toEqual({ APP_VERSION: null, label: "dev" });
});
