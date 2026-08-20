import { ASSETS } from "./assets.ts";

// Route: /functions/v1/panel/<path> (root path serves index.html). No auth
// on serving the static files themselves — the panel JS prompts for the
// bearer token and only the orders-api calls are gated (matches the old
// Express behavior, where static assets carried no order data by themselves).
export function handlePanel(req: Request): Response {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const idx = segments.indexOf("panel");
  const relative = idx >= 0 ? segments.slice(idx + 1).join("/") : segments.join("/");
  const filePath = relative === "" ? "index.html" : relative;

  const asset = ASSETS[filePath];
  if (!asset) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(asset.body as BodyInit, { status: 200, headers: { "Content-Type": asset.contentType } });
}

if (import.meta.main) {
  Deno.serve((req) => handlePanel(req));
}
