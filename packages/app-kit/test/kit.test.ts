// @vitest-environment jsdom
/**
 * The kit's own surfaces (brief #3, U1): the review card must still reach a
 * human in an app that has not migrated to the shared shell yet, and it must
 * say "claude's proposal / 2 pages", never "2 node(s) touched".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const proposal = {
  id: "p1",
  status: "pending",
  label: "Rotate 2 pages",
  touchedNodeIds: ["a", "b"],
  actor: { kind: "agent", id: "claude" },
};

type Call = { url: string; method: string };

function stubFetch(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    calls.push({ url: target, method: (init && init.method) || "GET" });
    if (target === "/api/proposals") {
      return { ok: true, json: async () => ({ ok: true, proposals: [proposal] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
  return calls;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("@nucleus/app-kit review card", () => {
  it("mounts a plain-words card with no shell present", async () => {
    stubFetch();
    await import("../kit/kit.js");
    await tick();
    await tick();

    const host = document.getElementById("nk-review-host");
    expect(host).not.toBeNull();
    expect(host?.hidden).toBe(false);

    const card = host?.querySelector(".nk-review") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("claude\u2019s proposal");
    expect(card.textContent).toContain("Rotate 2 pages");
    // The app noun / neutral default, never the internal count.
    expect(card.textContent).toContain("2 changes");
    expect(card.textContent).not.toMatch(/node/i);
    expect(card.querySelector(".nk-review__accept")?.textContent).toBe("Accept");
    expect(card.querySelector(".nk-review__actions")?.textContent).toContain("Reject");
  });

  it("accepts on A and rejects on R, never while typing", async () => {
    const calls = stubFetch();
    const kit = (globalThis as unknown as { NucleusKit: { refreshProposals: () => Promise<void> } }).NucleusKit;
    await kit.refreshProposals();

    // Typing in a field must not accept an agent's change.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await tick();
    expect(calls.some((call) => call.url.includes("/accept"))).toBe(false);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await tick();
    await tick();
    expect(calls.some((call) => call.url.endsWith("/api/proposals/p1/accept") && call.method === "POST")).toBe(true);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    await tick();
    await tick();
    expect(calls.some((call) => call.url.endsWith("/api/proposals/p1/reject") && call.method === "POST")).toBe(true);
  });

  it("hides itself when nothing is pending", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, proposals: [] }),
    })) as unknown as typeof fetch;
    const kit = (globalThis as unknown as { NucleusKit: { refreshProposals: () => Promise<void> } }).NucleusKit;
    await kit.refreshProposals();
    await tick();
    expect(document.getElementById("nk-review-host")?.hidden).toBe(true);
  });
});
