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
    if (["generate", "verify", "help"].includes(name)) {
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
  const source = envName ? process.env[envName] : flags.key;
  if (!source) usage("no key: pass --key <path> or --key-env <VAR>");
  if (envName && !process.env[envName]) {
    console.error(`sign-catalog: environment variable ${envName} is empty`);
    process.exit(2);
  }
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

const parsed = args(process.argv.slice(2));
if (parsed.flags.help) usage();
if (parsed.flags.generate) process.exit(generate(parsed.flags));
if (parsed.flags.verify) process.exit(verifyCatalog(parsed.flags));
if (parsed.positional.length === 0) usage();
process.exit(signCatalog(parsed.flags));
