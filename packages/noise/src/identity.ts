import { LinkspanError } from "@jokoagent/linkspan-core";
import {
  generateKeyPair,
  generateKeyPairFromSeed,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
  publicKeyFromRaw,
} from "@libp2p/crypto/keys";
import type { PrivateKey, PublicKey } from "@libp2p/interface";
import type { Identity } from "./types.js";

export function formatPublicKey(key: PublicKey): string {
  if (key.type !== "Ed25519" || key.raw.byteLength !== 32) {
    throw new LinkspanError("authentication_failed", "An Ed25519 endpoint identity is required");
  }
  return `ed25519:${Array.from(key.raw, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function parsePublicKey(value: string): PublicKey {
  if (!/^ed25519:[0-9a-f]{64}$/.test(value)) {
    throw new LinkspanError("invalid_argument", "A complete canonical Ed25519 public key is required");
  }
  return publicKeyFromRaw(Uint8Array.from(value.slice(8).match(/../g)!, (byte) => Number.parseInt(byte, 16)));
}

export async function createIdentity(): Promise<Identity> {
  const key = await generateKeyPair("Ed25519");
  return { privateKey: privateKeyToProtobuf(key), publicKey: formatPublicKey(key.publicKey) };
}

export async function identityFromPrivateKey(bytes: Uint8Array): Promise<Identity> {
  // Reject other key encodings before entering their parsers or provider paths.
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 68 || bytes[0] !== 8 || bytes[1] !== 1 || bytes[2] !== 18 || bytes[3] !== 64) {
    throw new LinkspanError("invalid_argument", "A protobuf-encoded Ed25519 private key is required");
  }
  try {
    const stored = privateKeyFromProtobuf(bytes.slice());
    if (stored.type !== "Ed25519") throw new Error("key type");
    const key = await generateKeyPairFromSeed("Ed25519", stored.raw.slice(0, 32));
    if (!key.publicKey.equals(stored.publicKey)) throw new Error("key mismatch");
    return { privateKey: privateKeyToProtobuf(key), publicKey: formatPublicKey(key.publicKey) };
  } catch (cause) {
    throw new LinkspanError("invalid_argument", "The endpoint private key is invalid", { cause });
  }
}

export async function importIdentity(identity: Identity): Promise<{ identity: Identity; key: PrivateKey }> {
  const normalized = await identityFromPrivateKey(identity.privateKey);
  if (normalized.publicKey !== identity.publicKey) {
    throw new LinkspanError("identity_mismatch", "The local identity does not match its private key");
  }
  return { identity: normalized, key: privateKeyFromProtobuf(normalized.privateKey) };
}
