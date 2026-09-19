import forge from "node-forge";

/**
 * Test certificates for the transport suites (SPEC section 12).
 *
 * Every negative case is exercised with validation enabled against a trusted
 * test authority: the client receives the authority's certificate through
 * the tester's `trustedCaPem` option and rejects everything else. No test
 * weakens certificate checking. Leaves share one key pair; a certificate is
 * the signed statement about it, so one key serves the valid, expired, and
 * wrong-host cases alike.
 */

/** One usable server key pair, PEM encoded. */
export interface TestCertificate {
  certPem: string;
  keyPem: string;
}

/** Options for one issued leaf certificate. */
export interface IssueOptions {
  /** DNS names the certificate is valid for. The first becomes the common name. */
  hosts: string[];
  /** IP addresses the certificate is valid for. */
  ips?: string[];
  /** Validity start. Defaults to one day in the past. */
  notBefore?: Date;
  /** Validity end. Defaults to 90 days in the future. */
  notAfter?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A certificate authority that signs leaves with one shared leaf key. */
export interface TestAuthority extends TestCertificate {
  issue(options: IssueOptions): TestCertificate;
  /** A leaf that signs itself: valid in form, trusted by no one. */
  selfSigned(options: IssueOptions): TestCertificate;
}

/** Create the trusted test authority. Keep its `certPem`; it signs the leaves. */
export function createTestAuthority(commonName = "Mail Hub Transport Test Authority"): TestAuthority {
  const authorityKeys = forge.pki.rsa.generateKeyPair(2048);
  const authorityCert = forge.pki.createCertificate();
  authorityCert.publicKey = authorityKeys.publicKey;
  authorityCert.serialNumber = serialNumber();
  authorityCert.validity.notBefore = new Date(Date.now() - DAY_MS);
  authorityCert.validity.notAfter = new Date(Date.now() + 365 * DAY_MS);
  const name = [{ name: "commonName", value: commonName }];
  authorityCert.setSubject(name);
  authorityCert.setIssuer(name);
  authorityCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  authorityCert.sign(authorityKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);

  return {
    certPem: forge.pki.certificateToPem(authorityCert),
    keyPem: forge.pki.privateKeyToPem(authorityKeys.privateKey),
    issue: (options) =>
      signLeaf(options, {
        publicKey: leafKeys.publicKey,
        privateKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
        issuer: authorityCert.subject.attributes,
        signingKey: authorityKeys.privateKey,
      }),
    selfSigned: (options) =>
      signLeaf(options, {
        publicKey: leafKeys.publicKey,
        privateKeyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
        issuer: null,
        signingKey: leafKeys.privateKey,
      }),
  };
}

/** Build, sign, and PEM-encode one leaf certificate. */
function signLeaf(
  options: IssueOptions,
  parts: {
    publicKey: forge.pki.PublicKey;
    privateKeyPem: string;
    issuer: forge.pki.CertificateField[] | null;
    signingKey: forge.pki.rsa.PrivateKey;
  },
): TestCertificate {
  const subject = [{ name: "commonName", value: options.hosts[0] ?? "localhost" }];
  const cert = forge.pki.createCertificate();
  cert.publicKey = parts.publicKey;
  cert.serialNumber = serialNumber();
  cert.validity.notBefore = options.notBefore ?? new Date(Date.now() - DAY_MS);
  cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 90 * DAY_MS);
  cert.setSubject(subject);
  cert.setIssuer(parts.issuer ?? subject);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        ...options.hosts.map((host) => ({ type: 2 as const, value: host })),
        ...(options.ips ?? []).map((ip) => ({ type: 7 as const, value: ip })),
      ],
    },
  ]);
  cert.sign(parts.signingKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: parts.privateKeyPem,
  };
}

/** A distinct odd serial number, as required for certificates. */
function serialNumber(): string {
  return `${Date.now().toString(16)}${process.pid.toString(16)}${Math.floor(Math.random() * 0xffffff).toString(16)}`.slice(0, 18);
}
