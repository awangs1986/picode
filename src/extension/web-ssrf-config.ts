import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piAgentDir } from "../shared/paths.ts";

const FAKE_IP_RANGE = "198.18.0.0/15";
const PROBE_HOST = "example.com";

export interface TunSsrfCompatibilityResult {
  detected: boolean;
  changed: boolean;
  range?: string;
}
interface LookupAddress { address: string; family: number }

function isTunFakeIp(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 198 &&
    (octets[1] === 18 || octets[1] === 19) && octets.every(Number.isInteger);
}

/**
 * Reconcile pi-web-access with Clash/Mihomo-style fake-IP DNS without
 * weakening localhost or general private-range protection. The vendor owns
 * enforcement; Picode only opts into its narrow, documented benchmark CIDR
 * after the host actually demonstrates that DNS behavior.
 */
export async function ensureTunSsrfCompatibility(options: {
  configPath?: string;
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
} = {}): Promise<TunSsrfCompatibilityResult> {
  const lookup = options.lookup ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  let addresses: readonly LookupAddress[];
  try {
    addresses = await lookup(PROBE_HOST);
  } catch {
    return { detected: false, changed: false };
  }
  if (!addresses.some((entry) => entry.family === 4 && isTunFakeIp(entry.address))) {
    return { detected: false, changed: false };
  }

  const configPath = options.configPath ?? join(piAgentDir(), "web-search.json");
  let root: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`pi-web-access config must contain a JSON object: ${configPath}`);
    }
    root = parsed as Record<string, unknown>;
  }
  const currentSsrf = typeof root.ssrf === "object" && root.ssrf !== null && !Array.isArray(root.ssrf)
    ? root.ssrf as Record<string, unknown>
    : {};
  const currentRanges = Array.isArray(currentSsrf.allowRanges)
    ? currentSsrf.allowRanges.filter((value): value is string => typeof value === "string")
    : [];
  if (currentRanges.includes(FAKE_IP_RANGE)) {
    return { detected: true, changed: false, range: FAKE_IP_RANGE };
  }

  const next = {
    ...root,
    ssrf: { ...currentSsrf, allowRanges: [...currentRanges, FAKE_IP_RANGE] },
  };
  mkdirSync(dirname(configPath), { recursive: true });
  const staging = `${configPath}.picode-${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(staging, configPath);
  } finally {
    if (existsSync(staging)) rmSync(staging, { force: true });
  }
  return { detected: true, changed: true, range: FAKE_IP_RANGE };
}
