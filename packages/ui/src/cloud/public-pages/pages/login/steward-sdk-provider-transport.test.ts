import { StewardAuth, type StewardProviders } from "@stwd/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENABLED_PROVIDERS: StewardProviders = {
  passkey: false,
  email: true,
  sms: false,
  siwe: true,
  siws: false,
  google: true,
  discord: false,
  github: false,
  telegram: false,
  twitter: false,
  oauth: [],
};

const REVOKED_PROVIDERS: StewardProviders = {
  passkey: false,
  email: false,
  sms: false,
  siwe: false,
  siws: false,
  google: false,
  discord: false,
  github: false,
  telegram: false,
  twitter: false,
  oauth: [],
};

describe("Steward provider transport authority", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bypasses both SDK memory and browser HTTP caches on forced discovery", async () => {
    let upstreamProviders = ENABLED_PROVIDERS;
    let browserCachedResponse: Response | null = null;

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.cache !== "no-store" && browserCachedResponse !== null) {
          return browserCachedResponse.clone();
        }

        const response = new Response(JSON.stringify(upstreamProviders), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=60",
          },
        });
        if (init?.cache !== "no-store") {
          browserCachedResponse = response.clone();
        }
        return response;
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = new StewardAuth({
      baseUrl: "https://api.example.test/steward",
      tenantId: "elizacloud",
    });

    await expect(auth.getProviders()).resolves.toEqual(ENABLED_PROVIDERS);
    upstreamProviders = REVOKED_PROVIDERS;

    await expect(auth.getProviders(true)).resolves.toEqual(REVOKED_PROVIDERS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const forcedRequestInit = fetchMock.mock.calls[1]?.[1];
    expect(forcedRequestInit?.cache).toBe("no-store");
  });
});
