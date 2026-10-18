import { randomBytes } from "node:crypto";
import { getConfig } from "../config/index.ts";
import type { SessionId, ShortId } from "./types.ts";

const GHOST_LOCAL = /^s-([0-9a-f]{8})$/i;
const ASKER_LOCAL = /^ask-[a-z0-9]+$/i;

/** "Atin <a@b.com>" -> "a@b.com"; plain addresses pass through. Lowercased. */
export function extractEmail(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

export function localPart(addr: string): string {
  const email = extractEmail(addr);
  const at = email.lastIndexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

export function shortIdFor(sessionId: SessionId): ShortId {
  return sessionId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function addressFor(shortId: ShortId, domain: string = getConfig().primitiveDomain): string {
  return `s-${shortId.toLowerCase()}@${domain}`;
}

/** Parses s-<8hex> from the local part and ignores the domain. Null if not a ghost address. */
export function shortIdFromAddress(addr: string): ShortId | null {
  const m = localPart(addr).match(GHOST_LOCAL);
  return m ? m[1].toLowerCase() : null;
}

export function isGhostAddress(addr: string): boolean {
  return shortIdFromAddress(addr) !== null;
}

export function isAskerAddress(addr: string): boolean {
  return ASKER_LOCAL.test(localPart(addr));
}

export function newAskerAddress(domain: string = getConfig().primitiveDomain): string {
  return `ask-${randomBytes(5).toString("hex")}@${domain}`;
}
