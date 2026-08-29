/**
 * Exact-head browser regression for PR #29600's hosted-login wallet authority.
 * A session-cached SIWE flag may accelerate non-wallet first paint, but it must
 * not mount or expose a wallet until live provider discovery succeeds.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const RECORDING = process.env.E2E_RECORD === "1";
const EXPECTED_HEAD = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();

function assertRecordedSourceProvenance(): void {
  if (!RECORDING) return;

  const sourceStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  ).trim();
  if (sourceStatus !== "") {
    throw new Error(
      "Recorded evidence requires a clean tracked and untracked source tree",
    );
  }
}

assertRecordedSourceProvenance();
const PROVIDERS_CACHE_KEY = "eliza.steward.providers.v1:elizacloud";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

// "SIWE-only" describes the wallet capability: cached email remains usable so
// a failed reconcile renders the non-destructive warning inside the real form.
const SIWE_ONLY_PROVIDERS = {
  passkey: false,
  email: true,
  sms: false,
  siwe: true,
  siws: false,
  google: false,
  discord: false,
  github: false,
  twitter: false,
  telegram: false,
  oauth: [],
};

type Observations = {
  boundaryViolations: string[];
  console: string[];
  consoleErrors: string[];
  providerStatuses: number[];
  walletChunkRequests: string[];
  walletChunkResponses: string[];
};

function localPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search ? "?[query]" : ""}`;
}

function isLocalResource(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  return (
    ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}

function isProviderDiscovery(method: string, rawUrl: string): boolean {
  return (
    method === "GET" && new URL(rawUrl).pathname === "/steward/auth/providers"
  );
}

function isAuthRequest(method: string, rawUrl: string): boolean {
  const pathname = new URL(rawUrl).pathname;
  return (
    !isProviderDiscovery(method, rawUrl) &&
    (/\/auth(?:\/|$)/i.test(pathname) ||
      /^\/api\/cloud\/login(?:\/|$)/i.test(pathname))
  );
}

function isWalletChunk(rawUrl: string): boolean {
  const pathname = new URL(rawUrl).pathname;
  return (
    pathname.includes("/assets/wallet-buttons-") ||
    pathname.includes("/assets/steward-wallet-providers-")
  );
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  if (!RECORDING) return;
  const artifactPath = testInfo.outputPath(`${name}.png`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path: artifactPath, fullPage: true });
  await testInfo.attach(name, { path: artifactPath, contentType: "image/png" });
}

async function readWalletMethods(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const methods = Reflect.get(window, "__elizaWalletCapabilityMethods");
    return Array.isArray(methods)
      ? methods.filter((method): method is string => typeof method === "string")
      : [];
  });
}

async function assertExactHead(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stamp = Reflect.get(window, "__ELIZA_RENDERER_BUILD__");
          if (stamp === null || typeof stamp !== "object") return null;
          const commit = Reflect.get(stamp, "commit");
          return typeof commit === "string" ? commit : null;
        }),
      {
        message: "the served renderer must match the checked-out exact HEAD",
        timeout: 15_000,
      },
    )
    .toBe(EXPECTED_HEAD);
}

function classifyConsoleMessage(type: string, text: string): string {
  if (text === "Service Worker registration blocked by Playwright") {
    return `${type}: expected service-worker block`;
  }
  if (/^\[renderer-build\] [a-f0-9]{12} built /i.test(text)) {
    return `${type}: renderer build marker observed`;
  }
  if (
    text ===
    "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
  ) {
    return `${type}: expected provider discovery 503`;
  }
  // Evidence logs must never copy arbitrary renderer text: future messages may
  // contain session, callback, provider, or account data.
  return `${type}: [redacted ${text.length}-character message]`;
}

function observePage(page: Page): Observations {
  const observed: Observations = {
    boundaryViolations: [],
    console: [],
    consoleErrors: [],
    providerStatuses: [],
    walletChunkRequests: [],
    walletChunkResponses: [],
  };
  const context = page.context();

  page.on("console", (message) => {
    const entry = classifyConsoleMessage(message.type(), message.text());
    observed.console.push(entry);
    if (message.type() === "error") observed.consoleErrors.push(entry);
  });
  page.on("pageerror", () => observed.boundaryViolations.push("page error"));
  context.on("page", () => observed.boundaryViolations.push("additional page"));
  context.on("request", (request) => {
    if (!isLocalResource(request.url())) {
      observed.boundaryViolations.push(
        `external ${request.method()} ${new URL(request.url()).origin}`,
      );
    }
    if (isAuthRequest(request.method(), request.url())) {
      observed.boundaryViolations.push(
        `auth ${request.method()} ${localPath(request.url())}`,
      );
    }
    if (isWalletChunk(request.url())) {
      observed.walletChunkRequests.push(localPath(request.url()));
    }
  });
  context.on("requestfailed", (request) => {
    observed.boundaryViolations.push(
      `failed ${request.method()} ${localPath(request.url())}`,
    );
  });
  context.on("response", (response) => {
    if (isProviderDiscovery(response.request().method(), response.url())) {
      observed.providerStatuses.push(response.status());
    }
    if (isWalletChunk(response.url())) {
      observed.walletChunkResponses.push(localPath(response.url()));
    }
  });

  return observed;
}

function assertCleanBoundaries(observed: Observations): void {
  expect(observed.boundaryViolations).toEqual([]);
  expect(observed.consoleErrors).toEqual([
    "error: expected provider discovery 503",
  ]);
}

async function finishEvidence(
  page: Page,
  testInfo: TestInfo,
  viewport: (typeof VIEWPORTS)[number],
  observed: Observations,
  walletMethods: readonly string[],
): Promise<void> {
  if (!RECORDING) return;

  const logPath = testInfo.outputPath(`${viewport.name}-frontend-network.log`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await writeFile(
    logPath,
    `${[
      "mode=head-regression",
      `head=${EXPECTED_HEAD}`,
      `renderer-commit=${EXPECTED_HEAD}`,
      `viewport=${viewport.width}x${viewport.height}`,
      `provider-statuses=${observed.providerStatuses.join(",")}`,
      `wallet-chunk-requests=${observed.walletChunkRequests.join(",")}`,
      `wallet-chunk-responses=${observed.walletChunkResponses.join(",")}`,
      `wallet-methods=${walletMethods.join(",")}`,
      "assertion=cached-wallet-inert-before-live-authority",
      "assertion=accessible-warning-and-retry-visible",
      "assertion=retry-authorized-siwe-and-rejected-siws",
      "assertion=no-real-wallet-grant-signature-or-auth-egress",
      "--- frontend ---",
      ...(observed.console.length > 0 ? observed.console : ["none"]),
    ].join("\n")}\n`,
    "utf8",
  );
  await testInfo.attach(`${viewport.name}-frontend-network-log`, {
    path: logPath,
    contentType: "text/plain",
  });

  const video = page.video();
  await page.close();
  if (!video) return;
  const basename = `${viewport.name}-wallet-authority-walkthrough`;
  const artifact = await saveBrowserVideoArtifact({
    video,
    testInfo,
    basename,
  });
  await testInfo.attach(basename, {
    path: artifact.path,
    contentType: artifact.contentType,
  });
}

async function installAuthorityFixture(
  page: Page,
  observed: Observations,
): Promise<{
  providerRequestCount: () => number;
  releaseInitialFailure: () => void;
  releaseRetrySuccess: () => void;
}> {
  let releaseInitialFailure = () => {};
  const initialFailureGate = new Promise<void>((resolve) => {
    releaseInitialFailure = resolve;
  });
  let releaseRetrySuccess = () => {};
  const retrySuccessGate = new Promise<void>((resolve) => {
    releaseRetrySuccess = resolve;
  });
  let providerRequestCount = 0;

  await page.addInitScript(
    ({ cacheKey, providers }) => {
      window.sessionStorage.setItem(cacheKey, JSON.stringify(providers));
      const methods: string[] = [];
      Object.defineProperty(window, "__elizaWalletCapabilityMethods", {
        configurable: true,
        value: methods,
      });
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: ({ method }: { method: string }) => {
            methods.push(method);
            if (method === "eth_accounts") {
              // Cross the lazy provider boundary, then remain strictly before
              // any account grant, signature, nonce, or auth exchange.
              return new Promise<readonly string[]>(() => {});
            }
            return Promise.reject(
              new Error(`Unexpected wallet method in fixture: ${method}`),
            );
          },
        },
      });
    },
    { cacheKey: PROVIDERS_CACHE_KEY, providers: SIWE_ONLY_PROVIDERS },
  );

  await page.context().routeWebSocket(/.*/, async (webSocket) => {
    const url = webSocket.url();
    if (
      !isLocalResource(url) ||
      /\/auth(?:\/|$)/i.test(new URL(url).pathname)
    ) {
      observed.boundaryViolations.push(
        isLocalResource(url) ? localPath(url) : "external",
      );
      await webSocket.close({ code: 1008, reason: "blocked by test fixture" });
      return;
    }
    webSocket.connectToServer();
  });

  await page.context().route("**/*", async (route) => {
    const request = route.request();
    if (!isLocalResource(request.url())) {
      await route.abort("blockedbyclient");
      return;
    }
    if (isProviderDiscovery(request.method(), request.url())) {
      providerRequestCount += 1;
      if (providerRequestCount === 1) {
        await initialFailureGate;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "Provider service is temporarily unavailable",
          }),
        });
        return;
      }
      if (providerRequestCount === 2) {
        await retrySuccessGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SIWE_ONLY_PROVIDERS),
        });
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "Unexpected retry" }),
      });
      return;
    }
    if (isAuthRequest(request.method(), request.url())) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });

  return {
    providerRequestCount: () => providerRequestCount,
    releaseInitialFailure,
    releaseRetrySuccess,
  };
}

for (const viewport of VIEWPORTS) {
  test(`cached SIWE stays inert until retry establishes live authority (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const observed = observePage(page);
    const authority = await installAuthorityFixture(page, observed);

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await assertExactHead(page);
    await expect.poll(authority.providerRequestCount).toBe(1);

    // The cache may render its safe email method immediately. Cached wallet
    // positives remain inert while the live request has no answer.
    await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Continue with a wallet/i }),
    ).toHaveCount(0);
    await expect(page.locator("#steward-wallet-options")).toHaveCount(0);
    expect(observed.walletChunkRequests).toEqual([]);
    expect(await readWalletMethods(page)).toEqual([]);
    await capture(page, testInfo, `${viewport.name}-1-cached-before-authority`);

    authority.releaseInitialFailure();
    const warning = page
      .getByRole("alert")
      .filter({ hasText: "Retry to load the sign-in methods" });
    await expect(warning).toBeVisible();
    const retry = warning.getByRole("button", {
      name: "Retry sign-in options",
    });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect(
      page.getByRole("button", { name: /Continue with a wallet/i }),
    ).toHaveCount(0);
    expect(observed.walletChunkRequests).toEqual([]);
    expect(await readWalletMethods(page)).toEqual([]);
    await capture(page, testInfo, `${viewport.name}-2-live-discovery-warning`);

    await retry.click();
    await expect(
      page.getByRole("status", { name: "Loading sign-in options" }),
    ).toBeVisible();
    await expect.poll(authority.providerRequestCount).toBe(2);
    await expect(
      page.getByRole("button", { name: /Continue with a wallet/i }),
    ).toHaveCount(0);
    await expect(page.locator("#steward-wallet-options")).toHaveCount(0);
    expect(observed.walletChunkRequests).toEqual([]);
    expect(await readWalletMethods(page)).toEqual([]);

    authority.releaseRetrySuccess();
    const walletToggle = page.getByRole("button", {
      name: /Continue with a wallet/i,
    });
    await expect(walletToggle).toBeVisible();
    await expect(warning).toHaveCount(0);
    expect(observed.providerStatuses).toEqual([503, 200]);

    const cachedAfterRetry = await page.evaluate((cacheKey) => {
      const raw = window.sessionStorage.getItem(cacheKey);
      return raw ? (JSON.parse(raw) as unknown) : null;
    }, PROVIDERS_CACHE_KEY);
    expect(cachedAfterRetry).toEqual(SIWE_ONLY_PROVIDERS);

    await walletToggle.click();
    const walletRegion = page.locator("#steward-wallet-options");
    const ethereumButton = walletRegion.getByRole("button", {
      name: /^EVM(?: wallet)?$/i,
    });
    const solanaButton = walletRegion.getByRole("button", {
      name: /^Solana(?: wallet)?$/i,
    });
    await expect(ethereumButton).toBeVisible();
    await expect(solanaButton).toHaveCount(0);
    expect(observed.walletChunkRequests).toEqual([]);
    expect(await readWalletMethods(page)).toEqual([]);
    await capture(page, testInfo, `${viewport.name}-3-siwe-only-disclosed`);

    // This app-level intent click loads the real lazy boundary against an inert
    // injected fixture. It never opens, signs with, or grants a real wallet.
    await ethereumButton.click();
    await expect(
      page.getByRole("button", { name: /Wallet options/i }),
    ).toBeDisabled();
    await expect(ethereumButton).toBeVisible({ timeout: 15_000 });
    await expect(solanaButton).toHaveCount(0);
    await expect.poll(() => readWalletMethods(page)).toContain("eth_accounts");
    await expect
      .poll(() => observed.walletChunkResponses.length)
      .toBeGreaterThanOrEqual(2);

    const walletMethods = await readWalletMethods(page);
    expect(walletMethods.length).toBeGreaterThan(0);
    expect(walletMethods.every((method) => method === "eth_accounts")).toBe(
      true,
    );
    expect(observed.walletChunkRequests.length).toBeGreaterThanOrEqual(2);
    assertCleanBoundaries(observed);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await capture(page, testInfo, `${viewport.name}-4-lazy-siwe-boundary`);

    await finishEvidence(page, testInfo, viewport, observed, walletMethods);
  });
}
