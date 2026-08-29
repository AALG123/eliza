/** Verifies a real login persistence and cookie-sync sequence publishes one authority epoch. */
// @vitest-environment jsdom

import {
  readStoredStewardToken,
  registerStewardTokenCompareAndRestore,
  registerStewardTokenPersistence,
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TOKEN_KEY,
  type StewardSessionChangeDetail,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { afterEach, expect, it, vi } from "vitest";
import {
  consumeStewardServerCookieSynced,
  invalidateStewardServerCookieSyncMarker,
} from "../../lib/steward-session-cookie-sync-marker";
import {
  resolveStewardAuthEndpoint,
  syncStewardSessionCookie,
} from "./steward-session";

afterEach(() => {
  invalidateStewardServerCookieSyncMarker();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("publishes exactly one present transition across login persistence and cookie sync", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const transitions: StewardSessionChangeDetail[] = [];
  const listener = (event: Event) => {
    transitions.push((event as CustomEvent<StewardSessionChangeDetail>).detail);
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

  try {
    await writeStoredStewardToken("login-token");
    await syncStewardSessionCookie("login-token");
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  }

  expect(transitions.map(({ state }) => state)).toEqual(["present"]);
});

it("does not publish credentials when the owning intent aborts during session sync", async () => {
  let resolveSessionPost: ((response: Response) => void) | undefined;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveSessionPost = resolve;
      }),
  );
  const controller = new AbortController();
  const sessionChanges: StewardSessionChangeDetail[] = [];
  const tokenSyncs: Event[] = [];
  const sessionListener = (event: Event) => {
    sessionChanges.push(
      (event as CustomEvent<StewardSessionChangeDetail>).detail,
    );
  };
  const tokenSyncListener = (event: Event) => tokenSyncs.push(event);
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, sessionListener);
  window.addEventListener("steward-token-sync", tokenSyncListener);

  try {
    const sync = syncStewardSessionCookie("revoked-token", null, {
      signal: controller.signal,
    });
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });

    controller.abort();
    resolveSessionPost?.(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(sync).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, sessionListener);
    window.removeEventListener("steward-token-sync", tokenSyncListener);
  }

  expect(readStoredStewardToken()).toBeNull();
  expect(sessionChanges).toEqual([]);
  expect(tokenSyncs).toEqual([]);
  expect(
    consumeStewardServerCookieSynced(
      "revoked-token",
      resolveStewardAuthEndpoint(STEWARD_SESSION_ENDPOINT),
    ),
  ).toBe(false);
});

it("rolls back credentials when the owning intent aborts during durable persistence", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  localStorage.setItem(STEWARD_TOKEN_KEY, "previous-token");

  let markPersistenceStarted: () => void = () => {};
  const persistenceStarted = new Promise<void>((resolve) => {
    markPersistenceStarted = resolve;
  });
  let releasePersistence: () => void = () => {};
  const persistenceWait = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const unregisterPersistence = registerStewardTokenPersistence(
    async (token) => {
      markPersistenceStarted();
      await persistenceWait;
      localStorage.setItem(STEWARD_TOKEN_KEY, token);
    },
  );
  const unregisterCompareAndRestore = registerStewardTokenCompareAndRestore(
    async (expectedToken, restoreToken) => {
      if (localStorage.getItem(STEWARD_TOKEN_KEY) !== expectedToken) {
        return false;
      }
      if (restoreToken === null) {
        localStorage.removeItem(STEWARD_TOKEN_KEY);
      } else {
        localStorage.setItem(STEWARD_TOKEN_KEY, restoreToken);
      }
      return true;
    },
  );
  const controller = new AbortController();
  const sessionChanges: StewardSessionChangeDetail[] = [];
  const tokenSyncs: Event[] = [];
  const sessionListener = (event: Event) => {
    sessionChanges.push(
      (event as CustomEvent<StewardSessionChangeDetail>).detail,
    );
  };
  const tokenSyncListener = (event: Event) => tokenSyncs.push(event);
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, sessionListener);
  window.addEventListener("steward-token-sync", tokenSyncListener);

  try {
    const sync = syncStewardSessionCookie("revoked-token", null, {
      signal: controller.signal,
    });
    await persistenceStarted;
    controller.abort();
    releasePersistence();

    await expect(sync).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    unregisterCompareAndRestore();
    unregisterPersistence();
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, sessionListener);
    window.removeEventListener("steward-token-sync", tokenSyncListener);
  }

  expect(readStoredStewardToken()).toBe("previous-token");
  expect(sessionChanges).toEqual([]);
  expect(tokenSyncs).toEqual([]);
});
