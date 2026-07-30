let buffer = Buffer.alloc(0);

function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString("utf8");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(length) || buffer.length < end + 4 + length) return;
    const body = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
    buffer = buffer.subarray(end + 4 + length);
    if (body.method === "initialize")
      send({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } });
    else if (body.method === "textDocument/hover")
      send({ jsonrpc: "2.0", id: body.id, result: { contents: "mock hover" } });
    else if (body.method === "shutdown") send({ jsonrpc: "2.0", id: body.id, result: null });
    else if (body.method === "exit") process.exit(0);
  }
});
