import { networkInterfaces } from "node:os";

/** Select a routable LAN address without granting any workspace authority. */
export function advertisedIpv4(): string | undefined {
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
  return addresses.find((address) => address.startsWith("100.")) ?? addresses[0];
}
