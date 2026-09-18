import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * A software passkey for tests. It builds spec-shaped WebAuthn responses and
 * signs assertions with a real P-256 key, so the server verification path
 * runs exactly as it would against a platform authenticator.
 */

export interface FakePasskey {
  credentialId: string;
  /** CBOR-encoded COSE public key, as embedded in attested credential data. */
  cosePublicKey: Uint8Array;
  signCount: number;
}

interface FakePasskeyInternal extends FakePasskey {
  privateKey: KeyObject;
}

export function createFakePasskey(): FakePasskey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  const credentialId = bytesToBase64Url(randomBytes(32));
  const cosePublicKey = encodeCoseKey(x, y);
  const passkey: FakePasskeyInternal = { credentialId, cosePublicKey, signCount: 0, privateKey };
  return passkey;
}

/** Build a registration response for `navigator.credentials.create`. */
export function fakeRegistrationResponse(input: {
  passkey: FakePasskey;
  options: PublicKeyCredentialCreationOptionsJSON;
  rpId: string;
  origin: string;
  userVerified?: boolean;
}): RegistrationResponseJSON {
  const passkey = input.passkey as FakePasskeyInternal;
  passkey.signCount += 1;
  const clientDataJSON = clientData("webauthn.create", input.options.challenge, input.origin);
  const authData = authenticatorData(input.rpId, passkey.signCount, input.userVerified ?? true, {
    credentialId: passkey.credentialId,
    cosePublicKey: passkey.cosePublicKey,
  });
  const attestationObject = encodeCborMap([
    ["fmt", cborText("none")],
    ["attStmt", cborMap([])],
    ["authData", cborBytes(authData)],
  ] as Array<[CborKeyInput, CborValue]>);
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    response: {
      clientDataJSON,
      attestationObject: bytesToBase64Url(attestationObject),
      transports: ["internal"],
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

/** Build an assertion response for `navigator.credentials.get`. */
export function fakeAuthenticationResponse(input: {
  passkey: FakePasskey;
  options: PublicKeyCredentialRequestOptionsJSON;
  rpId: string;
  origin: string;
  userVerified?: boolean;
}): AuthenticationResponseJSON {
  const passkey = input.passkey as FakePasskeyInternal;
  passkey.signCount += 1;
  const clientDataJSON = clientData("webauthn.get", input.options.challenge, input.origin);
  const authData = authenticatorData(input.rpId, passkey.signCount, input.userVerified ?? true);
  const signature = cryptoSign(
    null,
    Buffer.concat([Buffer.from(authData), createHash("sha256").update(clientDataJSON, "utf8").digest()]),
    passkey.privateKey,
  );
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    response: {
      clientDataJSON,
      authenticatorData: bytesToBase64Url(authData),
      signature: bytesToBase64Url(new Uint8Array(signature)),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): string {
  // WebAuthn transmits client data as base64url-encoded bytes.
  const json = JSON.stringify({ type, challenge, origin, crossOrigin: false });
  return bytesToBase64Url(new TextEncoder().encode(json));
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function authenticatorData(
  rpId: string,
  signCount: number,
  userVerified: boolean,
  attested?: { credentialId: string; cosePublicKey: Uint8Array },
): Uint8Array {
  const rpIdHash = createHash("sha256").update(rpId, "utf8").digest();
  const flags = FLAG_UP | (userVerified ? FLAG_UV : 0) | (attested === undefined ? 0 : FLAG_AT);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount, 0);
  const parts: Uint8Array[] = [rpIdHash, new Uint8Array([flags]), new Uint8Array(counter)];
  if (attested !== undefined) {
    const credentialId = base64UrlToBytes(attested.credentialId);
    const aaguid = new Uint8Array(16);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length, 0);
    parts.push(aaguid, new Uint8Array(length), credentialId, attested.cosePublicKey);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** COSE key for ES256: kty 2 (EC2), alg -7, crv 1 (P-256), x, y. */
function encodeCoseKey(x: Uint8Array, y: Uint8Array): Uint8Array {
  return encodeCborMap([
    [1, cborUnsigned(2)],
    [3, cborNegative(-7)],
    [-1, cborUnsigned(1)],
    [-2, cborBytes(x)],
    [-3, cborBytes(y)],
  ] as Array<[CborKeyInput, CborValue]>);
}

type CborValue =
  | { kind: "unsigned"; value: number }
  | { kind: "negative"; value: number }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "text"; value: string }
  | { kind: "map"; value: Array<[CborKeyInput, CborValue]> };
/** A map key: an unsigned or negative integer, or a text string. */
type CborKeyInput = number | string;

const cborUnsigned = (value: number): CborValue => ({ kind: "unsigned", value });
const cborNegative = (value: number): CborValue => ({ kind: "negative", value });
const cborBytes = (value: Uint8Array): CborValue => ({ kind: "bytes", value });
const cborText = (value: string): CborValue => ({ kind: "text", value });
const cborMap = (value: Array<[CborKeyInput, CborValue]>): CborValue => ({ kind: "map", value });

function encodeHead(major: number, length: number): Uint8Array {
  if (length < 24) {
    return new Uint8Array([(major << 5) | length]);
  }
  if (length <= 0xff) {
    return new Uint8Array([(major << 5) | 24, length]);
  }
  if (length <= 0xffff) {
    return new Uint8Array([(major << 5) | 25, length >> 8, length & 0xff]);
  }
  const head = new Uint8Array(5);
  head[0] = (major << 5) | 26;
  new DataView(head.buffer).setUint32(1, length);
  return head;
}

function encodeCborValue(value: CborValue): Uint8Array {
  switch (value.kind) {
    case "unsigned":
      return encodeHead(0, value.value);
    case "negative":
      // CBOR stores negative values as -1 minus the stored unsigned value.
      return encodeHead(1, -value.value - 1);
    case "bytes":
      return concat(encodeHead(2, value.value.length), value.value);
    case "text": {
      const bytes = new TextEncoder().encode(value.value);
      return concat(encodeHead(3, bytes.length), bytes);
    }
    case "map": {
      const parts = value.value.map(([key, item]) => concat(encodeCborValue(toCborKey(key)), encodeCborValue(item)));
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      return concat(encodeHead(5, value.value.length), concatParts(parts, total));
    }
  }
}

function toCborKey(key: CborKeyInput): CborValue {
  if (typeof key === "string") {
    return cborText(key);
  }
  return key >= 0 ? cborUnsigned(key) : cborNegative(key);
}

function encodeCborMap(entries: Array<[CborKeyInput, CborValue]>): Uint8Array {
  return encodeCborValue(cborMap(entries));
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  return concatParts([left, right], left.length + right.length);
}

function concatParts(parts: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}
