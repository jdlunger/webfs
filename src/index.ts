import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    // The manifest/service-worker/icons live in public/ and are copied
    // into dist/ alongside the static build (see deploy-pages.yml) for
    // production, but the "/*" catch-all below (needed so client-side
    // routing's deep links don't 404 in dev) would otherwise swallow these
    // same paths and serve index.html for them instead.
    //
    // Icons are listed individually rather than via a `{ dir }` route:
    // pairing a directory route with an HTML import route makes this dev
    // server's Bun (1.3.11) misdetect the app as a React Server Components
    // framework project and refuse to start ("Failed to resolve
    // 'react-server-dom-bun/server'").
    "/manifest.webmanifest": new Response(Bun.file("public/manifest.webmanifest"), {
      headers: { "content-type": "application/manifest+json" },
    }),
    "/sw.js": new Response(Bun.file("public/sw.js"), {
      headers: { "content-type": "text/javascript" },
    }),
    "/icons/icon-180.png": new Response(Bun.file("public/icons/icon-180.png")),
    "/icons/icon-192.png": new Response(Bun.file("public/icons/icon-192.png")),
    "/icons/icon-512.png": new Response(Bun.file("public/icons/icon-512.png")),
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
