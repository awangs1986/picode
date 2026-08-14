import { hostname } from "node:os";
import type { ControlDriver } from "../control/index.ts";
import { startRemoteServe } from "./server.ts";
import { advertisedIpv4 } from "./network.ts";
import { ChatWriterLeases } from "../guard/chat-writer-lease.ts";

export const SERVE_HELP = `Usage: picode serve [options]

Start the explicit trusted-LAN Host for Picode Remote.

Options:
  --bind <ipv4>    LAN address to bind and advertise (default: first private IPv4)
  --port <port>    HTTPS/WSS port (default: 7878, 0 chooses a free port)
  --name <name>    Host name shown during pairing
  --workspace <dir>  PC-authorized directory used for all remote-created Chats
  --no-qr          Print pairing JSON without terminal QR rendering
  --help           Show this help`;

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

export async function runServeCli(input: {
  argv: string[];
  driver: ControlDriver;
  stdout(line: string): void;
  stderr(line: string): void;
}): Promise<number> {
  if (input.argv.includes("--help") || input.argv.includes("-h")) {
    input.stdout(SERVE_HELP);
    return 0;
  }
  const supported = new Set(["--bind", "--port", "--name", "--workspace", "--no-qr"]);
  for (let index = 0; index < input.argv.length; index += 1) {
    const value = input.argv[index];
    if (!value?.startsWith("--")) continue;
    if (!supported.has(value)) throw new Error(`unknown option: ${value}`);
    if (value !== "--no-qr") index += 1;
  }
  const bind = option(input.argv, "--bind") ?? advertisedIpv4();
  if (bind === undefined) throw new Error("no private IPv4 address found; pass --bind <ipv4>");
  const rawPort = option(input.argv, "--port");
  const port = rawPort === undefined ? 7878 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${rawPort}`);
  const hostName = option(input.argv, "--name") ?? hostname();
  const newChatWorkspace = option(input.argv, "--workspace");

  const handle = await startRemoteServe({
    driver: input.driver,
    bind,
    advertisedHost: bind,
    port,
    hostName,
    writerLeases: new ChatWriterLeases(),
    ...(newChatWorkspace === undefined ? {} : { newChatWorkspace }),
  });
  input.stdout(`[picode serve] ${handle.endpoint}`);
  input.stdout(`[picode serve] Host Identity SHA-256: ${handle.fingerprint}`);
  const pairing = JSON.parse(handle.pairingPayload) as { pairingCode: string };
  input.stdout(`[picode serve] Manual pairing: enter Host IP ${bind} and one-use KEY ${pairing.pairingCode}`);
  input.stdout(`[picode serve] Pairing expires in 5 minutes, allows at most 5 failed attempts, and is one-use.`);
  if (!input.argv.includes("--no-qr")) input.stdout(handle.pairingQr);
  input.stdout(handle.pairingPayload);

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  input.stderr("[picode serve] stopping");
  await handle.close();
  return 0;
}
