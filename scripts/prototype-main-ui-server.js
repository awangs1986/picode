// PROTOTYPE — throwaway static server for public/main-ui-prototype.html.
const publicRoot = new URL("../public/", import.meta.url);
const requestedPort = Number(process.env.PICODE_PROTOTYPE_PORT || 4173);

const server = Bun.serve({
  port: requestedPort,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/main-ui-prototype.html";
    if (pathname.includes("..")) return new Response("Not found", { status: 404 });

    const file = Bun.file(new URL(pathname.slice(1), publicRoot));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, { headers: { "content-type": file.type } });
  },
});

console.log(`Picode main UI prototype: http://127.0.0.1:${server.port}/?variant=A`);
