import tailwind from "bun-plugin-tailwind";
import { rm } from "node:fs/promises";
import path from "node:path";

/**
 * The build number, and the commit it came from.
 *
 * `git rev-list --count HEAD` is the whole scheme: it only goes up as commits
 * land, nothing is checked in, and no one has to remember to bump a file.
 *
 * The catch is that it counts *the history this checkout has*. A shallow
 * clone — which is what `actions/checkout` makes by default — has one commit,
 * so the count comes back 1 and the next deploy says 1 again: a version that
 * silently resets and then climbs again, which is worse than none at all
 * because it looks right. So a shallow checkout is refused rather than
 * guessed at, and the app shows "dev" in the corner where the number goes.
 * The workflow asks for `fetch-depth: 0` to avoid this; if that ever comes
 * off, the deployed app says so itself.
 */
async function buildVersion(): Promise<{ version: string | null; commit: string | null }> {
  const git = async (...args: string[]) => {
    const result = await Bun.$`git ${args}`.nothrow().quiet();
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };

  const commit = await git("rev-parse", "--short", "HEAD");
  if ((await git("rev-parse", "--is-shallow-repository")) !== "false") {
    console.warn("  (shallow checkout: no version number — the deploy workflow needs fetch-depth: 0)");
    return { version: null, commit };
  }
  return { version: await git("rev-list", "--count", "HEAD"), commit };
}

const { version, commit } = await buildVersion();

const outdir = path.join(process.cwd(), "dist");
await rm(outdir, { recursive: true, force: true });

const entrypoints = [...new Bun.Glob("src/**/*.html").scanSync()];

const result = await Bun.build({
  entrypoints,
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // GitHub Pages serves this repo under /webfs/ rather than at the
    // domain root, so client-side routing needs to know its own prefix.
    "process.env.BUN_PUBLIC_BASE_PATH": JSON.stringify("/webfs"),
    // Defined even when null, so version.ts reads a literal rather than the
    // bare `process` global — which in a browser throws (see basePath.ts).
    "process.env.BUN_PUBLIC_VERSION": JSON.stringify(version ?? ""),
    "process.env.BUN_PUBLIC_COMMIT": JSON.stringify(commit ?? ""),
  },
});

console.log(version === null ? " no version number" : ` version v${version} (${commit})`);

for (const output of result.outputs) {
  console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
}
