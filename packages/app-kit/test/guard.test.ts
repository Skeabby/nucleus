import { describe, expect, it } from "vitest";

import { checkRequest, tokenCookie } from "../src/index.js";

const ok = { port: 5173, token: "secret" };

function req(
  headers: Record<string, string>,
  method = "GET",
): { headers: Record<string, string>; method: string } {
  return { headers, method };
}

describe("guard: Host / Origin / Content-Type / token (F5+F6, lifted into app-kit)", () => {
  it("accepts a well-posed localhost GET with the bearer token", () => {
    const rejection = checkRequest(req({ host: "127.0.0.1:5173", authorization: "Bearer secret" }), ok);
    expect(rejection).toBeNull();
  });

  it("accepts the nt cookie the launcher exchanged for ?t=", () => {
    expect(checkRequest(req({ host: "localhost:5173", cookie: "other=1; nt=secret" }), ok)).toBeNull();
  });

  it("rejects a foreign Host (DNS rebinding)", () => {
    expect(checkRequest(req({ host: "evil.example:5173", authorization: "Bearer secret" }), ok)).toEqual({
      status: 403,
      error: "bad host",
    });
  });

  it("rejects a cross-page Origin (a web page cannot drive the bus)", () => {
    expect(
      checkRequest(req({ host: "127.0.0.1:5173", origin: "http://evil.example", authorization: "Bearer secret" }), ok),
    ).toEqual({ status: 403, error: "bad origin" });
  });

  it("accepts no Origin at all (cli, curl, sse)", () => {
    expect(checkRequest(req({ host: "127.0.0.1:5173", authorization: "Bearer secret" }), ok)).toBeNull();
  });

  it("rejects non-JSON content-type on writes", () => {
    const headers = { host: "127.0.0.1:5173", authorization: "Bearer secret", "content-type": "text/plain" };
    expect(checkRequest(req(headers, "POST"), ok)).toEqual({ status: 415, error: "bad content-type" });
  });

  it("allows pdf and octet-stream bodies (binary uploads)", () => {
    for (const ct of ["application/pdf", "application/octet-stream; charset=binary"]) {
      const headers = { host: "127.0.0.1:5173", authorization: "Bearer secret", "content-type": ct };
      expect(checkRequest(req(headers, "POST"), ok)).toBeNull();
    }
  });

  it("rejects a missing or wrong token with 401", () => {
    const headers = { host: "127.0.0.1:5173" };
    expect(checkRequest(req(headers), ok)).toEqual({ status: 401, error: "missing token" });
    expect(checkRequest(req({ ...headers, authorization: "Bearer wrong" }), ok)).toEqual({
      status: 401,
      error: "missing token",
    });
  });

  it("empty token disables the token check (open dev mode)", () => {
    expect(checkRequest(req({ host: "127.0.0.1:5173" }), { port: 5173, token: "" })).toBeNull();
  });

  it("tokenCookie is HttpOnly + SameSite=Strict", () => {
    expect(tokenCookie("t1")).toBe("nt=t1; HttpOnly; SameSite=Strict; Path=/");
  });
});
