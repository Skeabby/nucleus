/**
 * `/api/settings` — the shell's memory (brief #3, §3.4).
 *
 * Why this is tested at the HTTP level: the interesting bugs are the guard
 * (settings are user data: no token, no read), the allowlist (an app typo must
 * not silently persist) and the fact that settings survive a restart even when
 * the document is reset.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CommandBus, createDocument, registerCoreCommands } from "@nucleus/core";
import { ControlServer } from "@nucleus/control";
import {
  SETTINGS_KEYS,
  SettingsError,
  SettingsStore,
  createAppServer,
  validateSettings,
  type AppKitSession,
  type AppServer,
} from "../src/index.js";

const TOKEN = "settings-test-token";

function makeSession(): AppKitSession {
  let local = 0;
  const doc = createDocument("nucleus.settings-test");
  const bus = new CommandBus();
  registerCoreCommands(bus, { createId: () => `n${++local}` });
  return { doc, bus, control: new ControlServer(bus, doc) };
}

function options(dataDir: string): Parameters<typeof createAppServer>[0] {
  return {
    id: "nucleus.settings-test",
    name: "Settings Test",
    publicDir: process.cwd(),
    createSession: makeSession,
    token: TOKEN,
    port: 0,
    persist: false,
    dataDir,
  } as Parameters<typeof createAppServer>[0];
}

const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
const base = (app: AppServer) => `http://127.0.0.1:${app.port()}`;

describe("settings allowlist", () => {
  it("accepts the documented keys", () => {
    expect(SETTINGS_KEYS.sort()).toEqual(
      ["collapsedSections", "developerDetails", "panelWidths", "theme", "thumbnailSize", "viewMode"].sort(),
    );
    const clean = validateSettings({
      developerDetails: true,
      theme: "dark",
      thumbnailSize: "l",
      viewMode: "split",
      collapsedSections: ["history", "sources"],
      panelWidths: { left: 240, right: 300 },
    });
    expect(clean).toMatchObject({ theme: "dark", thumbnailSize: "l", viewMode: "split" });
  });

  it("refuses unknown keys and bad values", () => {
    expect(() => validateSettings({ watchedByTheFbi: true })).toThrow(SettingsError);
    expect(() => validateSettings({ watchedByTheFbi: true })).toThrow(/unknown setting/);
    expect(() => validateSettings({ theme: "neon" })).toThrow(/bad value/);
    expect(() => validateSettings({ panelWidths: { left: 20 } })).toThrow(/bad value/);
    expect(() => validateSettings({ panelWidths: { middle: 240 } })).toThrow(/bad value/);
    expect(() => validateSettings({ thumbnailSize: 900 })).toThrow(/bad value/);
    expect(() => validateSettings(["not", "an", "object"])).toThrow(/object/);
  });
});

describe("settings store", () => {
  it("round-trips through <dataDir>/settings/<appId>.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-settings-"));
    const store = SettingsStore.for(dir, "nucleus.notes");
    expect(await store.load()).toEqual({});

    const saved = await store.save({ theme: "light", developerDetails: false });
    expect(saved).toEqual({ theme: "light", developerDetails: false });

    const file = join(dir, "settings", "nucleus_notes.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).toEqual({ theme: "light", developerDetails: false });

    // A merge, not a replace: the shell saves one key at a time.
    await store.save({ viewMode: "split" });
    expect(await store.load()).toEqual({ theme: "light", developerDetails: false, viewMode: "split" });

    await store.clear();
    expect(await store.load()).toEqual({});
  });

  it("reads a corrupt file as no settings instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-settings-corrupt-"));
    const store = SettingsStore.for(dir, "nucleus.notes");
    await store.save({ theme: "dark" });
    const file = join(dir, "settings", "nucleus_notes.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ this is not json", "utf8");
    expect(await store.load()).toEqual({});
  });
});

describe("/api/settings over HTTP", () => {
  it("is guarded: no token, no read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-settings-http-"));
    const app = await createAppServer(options(dir));
    const anonymous = await fetch(`${base(app)}/api/settings`);
    expect(anonymous.status).toBe(401);
    await app.close();
  });

  it("persists across a restart and is not cleared by /api/reset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-settings-restart-"));

    const one = await createAppServer(options(dir));
    const posted = await fetch(`${base(one)}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ settings: { theme: "light", developerDetails: true } }),
    });
    expect(posted.status).toBe(200);
    expect((await posted.json()) as unknown).toMatchObject({
      ok: true,
      settings: { theme: "light", developerDetails: true },
    });

    // The shell sends a flat object too; both shapes are accepted.
    const flat = await fetch(`${base(one)}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ thumbnailSize: "s" }),
    });
    expect((await flat.json()) as unknown).toMatchObject({ settings: { thumbnailSize: "s" } });

    await one.close();

    const two = await createAppServer(options(dir));
    const read = await fetch(`${base(two)}/api/settings`, { headers });
    expect((await read.json()) as unknown).toMatchObject({
      settings: { theme: "light", developerDetails: true, thumbnailSize: "s" },
    });

    await fetch(`${base(two)}/api/reset`, { method: "POST", headers });
    const afterReset = await fetch(`${base(two)}/api/settings`, { headers });
    expect((await afterReset.json()) as unknown).toMatchObject({
      settings: { theme: "light", developerDetails: true, thumbnailSize: "s" },
    });
    await two.close();
  });

  it("answers 400 validation on an unknown key and keeps the old value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nucleus-settings-bad-"));
    const app = await createAppServer(options(dir));
    await fetch(`${base(app)}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ theme: "dark" }),
    });
    const bad = await fetch(`${base(app)}/api/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ darkMode: true }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as unknown).toMatchObject({ ok: false, error: { kind: "validation" } });

    const read = await fetch(`${base(app)}/api/settings`, { headers });
    expect((await read.json()) as unknown).toMatchObject({ settings: { theme: "dark" } });
    await app.close();
  });
});
