#!/usr/bin/env node
/**
 * Sign a catalogue with Ed25519 (N1 — update trust).
 *
 * The signature covers the **exact bytes** of `catalog.json`: no canonical
 * JSON, no re-serialisation, so what a reviewer reads in the diff is what the
 * launcher verifies. The `.sig` file is a tiny JSON envelope holding the key id
 * and the base64 signature; the launcher embeds the matching public keys.
 *
 *   node tools/sign-catalog.mjs launcher-rs/mirror/catalog.json --key keys/2026-a.pem
 *   node tools/sign-catalog.mjs catalog.json --key-env NUCLEUS_CATALOG_KEY --key-id 2026-a
 *   node tools/sign-catalog.mjs --generate --key-id 2026-a --out-dir ../nucleus-keys
 *   node tools/sign-catalog.mjs catalog.json --verify keys/2026-a.pub
 *
 * Key material never enters the repository: `--generate` writes the private
 * half outside the tree (pass `--out-dir`), and CI reads it from a secret whose
 * name is given by `--key-env`. The public half is printed as 32 hex bytes, the
 * exact literal that goes into `TRUSTED_KEYS` in `core/src/trust.rs`.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ALGORITHM = "ed25519";

function usage(message) {
  if (message) console.error(`sign-catalog: ${message}`);
  console.error(
    [
      "usage:",
      "  node tools/sign-catalog.mjs <catalog.json> [--key <pem>] [--key-env <VAR>] [--key-id <id>] [--out <sig>]",
      "  node tools/sign-catalog.mjs <catalog.json> --verify <public.pem|public.hex>",
      "  node tools/sign-catalog.mjs --generate [--key-id <id>] [--out-dir <dir>]",
      "  node tools/sign-catalog.mjs --selftest",
    ].join("\n"),
  );
  process.exit(2);
}

function args(argv) {
  const out = { positional: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      out.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (["generate", "verify", "selftest", "help"].includes(name)) {
      out.flags[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value`);
    out.flags[name] = value;
    index += 1;
  }
  return out;
}

/** Raw 32-byte public key for the launcher's `TRUSTED_KEYS` literal. */
function rawPublicHex(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  // SPKI for Ed25519 is a fixed 12-byte prefix followed by the 32 raw bytes.
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

function loadPrivate(flags) {
  const envName = flags["key-env"];
  if (envName && !process.env[envName]) {
    console.error(`sign-catalog: environment variable ${envName} is empty`);
    process.exit(2);
  }
  const source = envName ? process.env[envName] : flags.key;
  if (!source) usage("no key: pass --key <path> or --key-env <VAR>");
  // A path is the common case; a PEM body is what a CI secret usually holds.
  const material = existsSync(source) ? readFileSync(source, "utf8") : source;
  if (!material.includes("-----BEGIN")) usage(`not a PEM private key: ${envName ? `$${envName}` : source}`);
  return createPrivateKey(material);
}

function signCatalog(flags) {
  const catalogPath = flags.positional[0];
  if (!catalogPath) usage("missing catalog.json");
  const bytes = readFileSync(catalogPath);
  const privateKey = loadPrivate(flags);
  const keyId = flags["key-id"] ?? "2026-a";
  const signature = sign(null, bytes, privateKey).toString("base64");
  const publicKey = createPublicKey(privateKey);
  const outPath = flags.out ?? `${catalogPath}.sig`;
  const envelope = { algorithm: ALGORITHM, keyId, signature };
  writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  console.log(`signed   ${path.relative(process.cwd(), catalogPath)} (${bytes.length} bytes)`);
  console.log(`key      ${keyId}`);
  console.log(`sig      ${path.relative(process.cwd(), outPath)}`);
  console.log(`public   ${rawPublicHex(publicKey)}`);
  return 0;
}

function verifyCatalog(flags) {
  const catalogPath = flags.positional[0];
  const publicPath = flags.verify === true ? flags.positional[1] : flags.verify;
  if (!catalogPath || !publicPath) usage("--verify needs <public.pem|public.hex>");
  const bytes = readFileSync(catalogPath);
  const sigPath = flags.out ?? `${catalogPath}.sig`;
  const envelope = JSON.parse(readFileSync(sigPath, "utf8"));
  const material = readFileSync(publicPath, "utf8").trim();
  const publicKey = material.includes("-----BEGIN")
    ? createPublicKey(material)
    : createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          Buffer.from(material, "hex"),
        ]),
        format: "der",
        type: "spki",
      });
  const ok = verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64"));
  console.log(`${ok ? "verified" : "REJECTED"} ${catalogPath} with ${envelope.keyId}`);
  return ok ? 0 : 1;
}

function generate(flags) {
  const keyId = flags["key-id"] ?? "2026-a";
  const outDir = path.resolve(flags["out-dir"] ?? ".");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(outDir, { recursive: true });
  const privatePath = path.join(outDir, `${keyId}.private.pem`);
  const publicPath = path.join(outDir, `${keyId}.public.pem`);
  if (existsSync(privatePath)) {
    console.error(`sign-catalog: ${privatePath} exists — refusing to overwrite a signing key`);
    process.exit(1);
  }
  writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`key id   ${keyId}`);
  console.log(`private  ${privatePath}   (never commit this)`);
  console.log(`public   ${publicPath}`);
  console.log(`embed in core/src/trust.rs:`);
  console.log(`  ("${keyId}", [${rawPublicHex(publicKey).match(/../g).map((b) => `0x${b}`).join(", ")}]),`);
  return 0;
}

/**
 * The same golden vector as `core/src/trust.rs`: a deterministic seed
 * (`0x00..0x1f`), a fixed payload and the signature it must produce. Ed25519
 * signing is deterministic, so a mismatch means the tool changed how it signs
 * (or what it signs) — exactly the failure a release must never ship.
 */
const SELF_TEST = {
  payload:
    '{"suiteVersion":"9.9.9","issuedAt":"2026-10-24T00:00:00Z","expiresAt":"2027-01-22T00:00:00Z","apps":[]}',
  publicHex: "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
  signature:
    "dJlMfSHpXtNN5KSqNtyrTPy0JDczQsZqkoaKRm16mh1CuJyuWDqrjWkkqYgvNkNL+duHV3Y0dPfH7ALFOc2YAA==",
};

function selfTest() {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  // PKCS#8 wrapper for an Ed25519 private key: fixed prefix + the 32-byte seed.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const bytes = Buffer.from(SELF_TEST.payload, "utf8");
  const signature = sign(null, bytes, privateKey).toString("base64");
  const publicHex = rawPublicHex(createPublicKey(privateKey));
  const checks = [
    ["public key matches the published test key", publicHex === SELF_TEST.publicHex],
    ["signature matches the Rust golden vector", signature === SELF_TEST.signature],
    [
      "signature verifies against its own public key",
      verify(null, bytes, createPublicKey(privateKey), Buffer.from(signature, "base64")),
    ],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
    if (!ok) failed += 1;
  }
  if (signature !== SELF_TEST.signature) console.error(`  got ${signature}`);
  return failed === 0 ? 0 : 1;
}

const parsed = args(process.argv.slice(2));
// One option bag for every sub-command: `flags` for the named ones, plus the
// positionals, so `signCatalog`/`verifyCatalog` can read either.
const opts = { ...parsed.flags, positional: parsed.positional };
if (opts.help) usage();
if (opts.selftest) process.exit(selfTest());
if (opts.generate) process.exit(generate(opts));
if (opts.verify) process.exit(verifyCatalog(opts));
if (opts.positional.length === 0) usage();
process.exit(signCatalog(opts));
