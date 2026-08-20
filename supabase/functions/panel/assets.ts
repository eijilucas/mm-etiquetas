// Static assets are embedded as plain TS modules (`export default "..."`)
// rather than read from disk at runtime or imported via Deno's "text"/"bytes"
// import attributes — the deployed function has no filesystem access to files
// outside its module graph, and Supabase's remote bundler doesn't support
// those import attributes yet, so a plain string/base64 export is what
// actually survives `supabase functions deploy`.
import indexHtml from "./generated/index-html.ts";
import appJs from "./generated/app-js.ts";
import styleCss from "./generated/style-css.ts";
import { horstWoff2_b64, horstWoff_b64, logoPng_b64 } from "./binary-assets.ts";

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const ASSETS: Record<string, { body: string | Uint8Array; contentType: string }> = {
  "index.html": { body: indexHtml, contentType: "text/html; charset=utf-8" },
  "app.js": { body: appJs, contentType: "application/javascript; charset=utf-8" },
  "style.css": { body: styleCss, contentType: "text/css; charset=utf-8" },
  "logo.png": { body: fromBase64(logoPng_b64), contentType: "image/png" },
  "fonts/Horst-Blackletter.woff": { body: fromBase64(horstWoff_b64), contentType: "font/woff" },
  "fonts/Horst-Blackletter.woff2": { body: fromBase64(horstWoff2_b64), contentType: "font/woff2" },
};
