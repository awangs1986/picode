import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "public");
const port = Number(process.argv[3] ?? 4173);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const requested = decodeURIComponent((request.url ?? "/").split("?", 1)[0]);
    const relative = requested === "/" ? "/main-ui-prototype.html" : requested;
    const file = resolve(root, `.${relative}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": mime[extname(file)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Picode local preview listening on http://127.0.0.1:${port}\n`);
});
