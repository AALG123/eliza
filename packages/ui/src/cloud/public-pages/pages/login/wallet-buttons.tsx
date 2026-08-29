/**
 * Native Ethereum + Solana sign-in buttons for the Steward login section.
 *
 * Bounded port of `cloud-frontend@4056e0e868`'s wallet-buttons (#the wallet
 * branch dropped in the cloud-frontend → @elizaos/ui fold). Changes from the
 * original: i18n comes from CloudI18nProvider, and the @web3icons brand marks
 * are dropped for text-only buttons (the console is black-and-white; color is
 * reserved for meaning).
 *
 * Click flow:
 *   1. If not connected, open the wallet connect modal (native EIP-1193 /
 *      injected connector preferred over the RainbowKit QR modal).
 *   2. Once connected, auto-trigger the SIWE/SIWS signature.
 *   3. Call onSuccess(result) or onError(err).
 *
 * The discovered SIWE/SIWS capabilities remain authoritative after this lazy
 * stack mounts, so an unannounced chain never renders a sign-in control.
 *
 * Must render inside `StewardWalletProviders` (wagmi + RainbowKit + Solana
 * adapter contexts — shared with the billing crypto top-up).
 */

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type {
  StewardAuth,
  StewardAuthResult,
  StewardMfaRequiredResult,
} from "@stwd/sdk";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { type Connector, useAccount, useConnect, useSignMessage } from "wagmi";
import { Button } from "../../../../components/ui/button";
import { Spinner } from "../../../../components/ui/spinner";
import { useCloudT } from "../../../shell/CloudI18nProvider";

type HexAddress = `0x${string}`;

interface Eip1193Provider {
  isPhantom?: boolean;
  request(args: {
    method: "eth_accounts" | "eth_requestAccounts";
  }): Promise<readonly string[] | null>;
  request(args: {
    method: "personal_sign";
    params: readonly [`0x${string}`, HexAddress];
  }): Promise<string>;
}

function getWindowEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!ethereum || typeof ethereum.request !== "function") return null;
  if (ethereum.isPhantom === true) return null;
  return ethereum;
}

function isHexAddress(value: string | undefined): value is HexAddress {
  return /^0x[a-fA-F0-9]{40}$/.test(value ?? "");
}

// Wallet sign-in returns `StewardAuthResult | StewardMfaRequiredResult`.
// There is no MFA-continuation UI in this login surface, so narrow on the
// `mfaRequired` discriminant and surface a clear error instead of forwarding
// an MFA challenge to onSuccess as if it carried tokens.
function requireCompletedAuth(
  result: StewardAuthResult | StewardMfaRequiredResult,
): StewardAuthResult {
  if ("mfaRequired" in result) {
    throw new Error("MFA required — not yet supported in this client.");
  }
  return result;
}

async function requestEip1193Account(
  provider: Eip1193Provider,
  assertIntentCurrent: () => void,
): Promise<HexAddress | null> {
  const existingAccounts = await provider.request({ method: "eth_accounts" });
  assertIntentCurrent();
  const [existingAccount] = existingAccounts ?? [];
  if (isHexAddress(existingAccount)) return existingAccount;

  const requestedAccounts = await provider.request({
    method: "eth_requestAccounts",
  });
  assertIntentCurrent();
  const [requestedAccount] = requestedAccounts ?? [];
  return isHexAddress(requestedAccount) ? requestedAccount : null;
}

function stringToHex(value: string): `0x${string}` {
  let hex = "";
  for (const byte of new TextEncoder().encode(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
}

async function personalSign(
  provider: Eip1193Provider,
  address: HexAddress,
  message: string,
): Promise<string> {
  const signature = await provider.request({
    method: "personal_sign",
    params: [stringToHex(message), address],
  });
  if (!signature.startsWith("0x")) {
    throw new Error("Wallet returned an invalid Ethereum signature.");
  }
  return signature;
}

// Phantom injects itself as an Ethereum provider but must never be used for
// SIWE — it is Solana-first and the user's intent for SIWE is a real EVM wallet.
// We mirror the previous EIP-1193 isPhantom check, but against the connector's
// underlying provider so the wagmi store stays the source of truth.
function isInjectedStyleConnector(connector: Connector): boolean {
  const id = connector.id.toLowerCase();
  const type = connector.type.toLowerCase();
  return (
    type === "injected" ||
    id === "metamask" ||
    id === "metamasksdk" ||
    id === "coinbasewallet" ||
    id === "coinbasewalletsdk"
  );
}

async function isEligibleEvmConnector(connector: Connector): Promise<boolean> {
  const id = connector.id.toLowerCase();
  const name = (connector.name ?? "").toLowerCase();
  if (id.includes("phantom") || name.includes("phantom")) return false;
  try {
    const provider = (await connector.getProvider()) as unknown;
    if (provider !== null && typeof provider === "object") {
      if (Reflect.get(provider, "isPhantom") === true) return false;
    }
    // Wagmi always registers its injected connector, even when the browser has
    // no extension. Treat a missing provider as unavailable so RainbowKit can
    // offer WalletConnect instead of attempting a doomed injected connect.
    if (isInjectedStyleConnector(connector) && provider == null) return false;
  } catch {
    // error-policy:J6 a failed injected provider probe means the extension is
    // unavailable. Non-injected connectors stay under RainbowKit's modal.
    return false;
  }
  return true;
}

// Pick the best available injected EVM connector that is NOT Phantom. When no
// extension-backed connector is usable, return null so RainbowKit owns the
// WalletConnect selection/QR flow rather than connecting one connector blind.
async function pickInjectedConnector(
  connectors: readonly Connector[],
): Promise<Connector | null> {
  for (const connector of connectors) {
    if (!isInjectedStyleConnector(connector)) continue;
    if (!(await isEligibleEvmConnector(connector))) continue;
    return connector;
  }
  return null;
}

/**
 * Component-local async intent guard. Cleanup marks the lifecycle unavailable
 * synchronously, but defers final invalidation by one microtask so React
 * StrictMode's setup → cleanup → setup replay can supersede the cleanup without
 * abandoning the one auto-started wallet intent.
 */
function useWalletIntentLifecycle(onUnmount: () => void) {
  const mountedRef = useRef(true);
  const intentGenerationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const cleanupPendingRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    mountedRef.current = true;
    cleanupPendingRef.current = null;
    return () => {
      cleanupPendingRef.current = lifecycle;
      queueMicrotask(() => {
        if (
          lifecycleRef.current === lifecycle &&
          cleanupPendingRef.current === lifecycle
        ) {
          mountedRef.current = false;
          intentGenerationRef.current += 1;
          onUnmount();
        }
      });
    };
  }, [onUnmount]);

  const beginIntent = useCallback(() => {
    intentGenerationRef.current += 1;
    return intentGenerationRef.current;
  }, []);

  const invalidateIntent = useCallback(() => {
    intentGenerationRef.current += 1;
  }, []);

  const isIntentCurrent = useCallback((generation: number) => {
    return (
      mountedRef.current &&
      cleanupPendingRef.current === null &&
      intentGenerationRef.current === generation
    );
  }, []);

  return { beginIntent, invalidateIntent, isIntentCurrent };
}

function throwIfWalletIntentExpired(
  isIntentCurrent: (generation: number) => boolean,
  generation: number,
) {
  if (!isIntentCurrent(generation)) {
    throw new Error("Wallet sign-in intent expired.");
  }
}

export function WalletButtons({
  autoStart,
  auth,
  disabled,
  siwe = false,
  siws = false,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
  loadingProvider,
}: {
  autoStart?: "ethereum" | "solana" | null;
  auth: StewardAuth;
  disabled: boolean;
  siwe?: boolean;
  siws?: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (error: Error, kind: "ethereum" | "solana") => void;
  onLoadingChange: (kind: "ethereum" | "solana" | null) => void;
  loadingProvider: "ethereum" | "solana" | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {siwe && (
        <EthereumButton
          autoStart={autoStart === "ethereum"}
          auth={auth}
          disabled={disabled}
          onAutoStartHandled={onAutoStartHandled}
          loading={loadingProvider === "ethereum"}
          onSuccess={onSuccess}
          onError={(err) => onError(err, "ethereum")}
          onLoadingChange={(l) => onLoadingChange(l ? "ethereum" : null)}
        />
      )}
      {siws && (
        <SolanaButton
          autoStart={autoStart === "solana"}
          auth={auth}
          disabled={disabled}
          onAutoStartHandled={onAutoStartHandled}
          loading={loadingProvider === "solana"}
          onSuccess={onSuccess}
          onError={(err) => onError(err, "solana")}
          onLoadingChange={(l) => onLoadingChange(l ? "solana" : null)}
        />
      )}
    </div>
  );
}

// ── Ethereum ────────────────────────────────────────────────────────────────

function EthereumButton({
  autoStart,
  auth,
  disabled,
  loading,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  autoStart: boolean;
  auth: StewardAuth;
  disabled: boolean;
  loading: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (err: Error) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const t = useCloudT();
  const { address, isConnected, isConnecting } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connectAsync, connectors } = useConnect();
  const { connectModalOpen, openConnectModal } = useConnectModal();
  // We start a sign flow either from the click (if already connected) or after
  // the user connects via the modal. This ref tracks the "we're waiting for
  // connection to trigger SIWE" intent.
  const pendingSignRef = useRef(false);
  const pendingSignGenerationRef = useRef<number | null>(null);
  const connectModalSeenRef = useRef(false);

  const clearPendingSignIntent = useCallback(() => {
    pendingSignRef.current = false;
    pendingSignGenerationRef.current = null;
    connectModalSeenRef.current = false;
  }, []);
  const { beginIntent, invalidateIntent, isIntentCurrent } =
    useWalletIntentLifecycle(clearPendingSignIntent);
  const invalidateSignIntent = useCallback(() => {
    clearPendingSignIntent();
    invalidateIntent();
  }, [clearPendingSignIntent, invalidateIntent]);

  const signWith = useCallback(
    async (
      addr: HexAddress,
      signMessage: (message: string) => Promise<string>,
      generation: number,
    ) => {
      if (!isIntentCurrent(generation)) return;
      onLoadingChange(true);
      try {
        const result = requireCompletedAuth(
          await auth.signInWithSIWE(addr, async (message: string) => {
            throwIfWalletIntentExpired(isIntentCurrent, generation);
            const signature = await signMessage(message);
            throwIfWalletIntentExpired(isIntentCurrent, generation);
            return signature;
          }),
        );
        if (!isIntentCurrent(generation)) return;
        await onSuccess(result);
      } catch (e) {
        if (!isIntentCurrent(generation)) return;
        const err = e instanceof Error ? e : new Error(String(e));
        onError(err);
      } finally {
        if (isIntentCurrent(generation)) {
          invalidateSignIntent();
          onLoadingChange(false);
        }
      }
    },
    [
      auth,
      invalidateSignIntent,
      isIntentCurrent,
      onSuccess,
      onError,
      onLoadingChange,
    ],
  );

  const sign = useCallback(
    async (addr: HexAddress, generation: number) => {
      await signWith(
        addr,
        async (message: string) => {
          return await signMessageAsync({ message });
        },
        generation,
      );
    },
    [signMessageAsync, signWith],
  );

  const signWithEip1193 = useCallback(
    async (provider: Eip1193Provider, addr: HexAddress, generation: number) => {
      await signWith(
        addr,
        async (message: string) => {
          return await personalSign(provider, addr, message);
        },
        generation,
      );
    },
    [signWith],
  );

  // If click triggered a connect modal, once connection lands, auto-sign.
  useEffect(() => {
    const generation = pendingSignGenerationRef.current;
    if (
      pendingSignRef.current &&
      generation !== null &&
      isIntentCurrent(generation) &&
      isConnected &&
      address
    ) {
      clearPendingSignIntent();
      void sign(address, generation);
    }
  }, [isConnected, address, clearPendingSignIntent, isIntentCurrent, sign]);

  // RainbowKit exposes the connect modal's lifecycle separately from wagmi's
  // connection state. Once a modal opened for this button closes without a
  // connection still progressing, cancel the pending SIWE intent so an
  // unrelated future wallet connection cannot trigger a signature prompt.
  // This intentionally fails closed if the close render wins a race with
  // wagmi's `isConnecting` update: a later connection requires a fresh click.
  useLayoutEffect(() => {
    if (!pendingSignRef.current) return;
    if (connectModalOpen) {
      connectModalSeenRef.current = true;
      return;
    }
    if (connectModalSeenRef.current && !isConnected && !isConnecting) {
      invalidateSignIntent();
      onLoadingChange(false);
    }
  }, [
    connectModalOpen,
    invalidateSignIntent,
    isConnected,
    isConnecting,
    onLoadingChange,
  ]);

  const connectAndSign = useCallback(
    async (generation: number) => {
      onLoadingChange(true);
      // After a successful modal launch, the modal/connection effects own this
      // lock until cancellation or a terminal signature result.
      let modalOwnsLoading = false;
      try {
        const provider = getWindowEthereumProvider();
        if (provider) {
          const account = await requestEip1193Account(provider, () =>
            throwIfWalletIntentExpired(isIntentCurrent, generation),
          );
          if (!isIntentCurrent(generation)) return;
          if (account) {
            await signWithEip1193(provider, account, generation);
            return;
          }
        }

        const connector = await pickInjectedConnector(connectors);
        if (!isIntentCurrent(generation)) return;
        if (!connector) {
          // No injected connector available — fall through to the RainbowKit
          // modal (WalletConnect QR etc.).
          if (!openConnectModal) {
            clearPendingSignIntent();
            throw new Error(
              t("cloud.login.wallet.error.connectUnavailable", {
                defaultValue:
                  "Ethereum wallet connection is unavailable. Refresh and try again.",
              }),
            );
          }
          pendingSignRef.current = true;
          pendingSignGenerationRef.current = generation;
          connectModalSeenRef.current = false;
          openConnectModal();
          modalOwnsLoading = true;
          return;
        }
        const { accounts } = await connectAsync({ connector });
        if (!isIntentCurrent(generation)) return;
        const [account] = accounts;
        if (!account) {
          throw new Error(
            t("cloud.login.wallet.error.noAccount", {
              defaultValue: "No Ethereum account returned by wallet.",
            }),
          );
        }
        await sign(account, generation);
      } catch (e) {
        if (!isIntentCurrent(generation)) return;
        const err = e instanceof Error ? e : new Error(String(e));
        onError(err);
      } finally {
        if (!modalOwnsLoading && isIntentCurrent(generation)) {
          invalidateSignIntent();
          onLoadingChange(false);
        }
      }
    },
    [
      clearPendingSignIntent,
      connectAsync,
      connectors,
      invalidateSignIntent,
      isIntentCurrent,
      openConnectModal,
      onError,
      onLoadingChange,
      sign,
      signWithEip1193,
      t,
    ],
  );

  const handleClick = useCallback(() => {
    if (disabled || loading) return;
    clearPendingSignIntent();
    const generation = beginIntent();
    if (isConnected && address) {
      void sign(address, generation);
      return;
    }
    void connectAndSign(generation);
  }, [
    address,
    beginIntent,
    clearPendingSignIntent,
    connectAndSign,
    disabled,
    isConnected,
    loading,
    sign,
  ]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || disabled || loading) return;
    autoStartedRef.current = true;
    onAutoStartHandled?.();
    handleClick();
  }, [autoStart, disabled, handleClick, loading, onAutoStartHandled]);

  return (
    <Button
      variant="outlineMuted"
      size="touch"
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="hosted-signin-focus-emphasis"
    >
      {loading && <Spinner />}
      {t("cloud.login.wallet.evm", { defaultValue: "EVM wallet" })}
    </Button>
  );
}

// ── Solana ──────────────────────────────────────────────────────────────────

function SolanaButton({
  autoStart,
  auth,
  disabled,
  loading,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  autoStart: boolean;
  auth: StewardAuth;
  disabled: boolean;
  loading: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (err: Error) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const t = useCloudT();
  const wallet = useWallet();
  const { setVisible, visible } = useWalletModal();
  const pendingSignRef = useRef(false);
  const pendingSignGenerationRef = useRef<number | null>(null);
  const walletModalSeenRef = useRef(false);

  const clearPendingSignIntent = useCallback(() => {
    pendingSignRef.current = false;
    pendingSignGenerationRef.current = null;
    walletModalSeenRef.current = false;
  }, []);
  const { beginIntent, invalidateIntent, isIntentCurrent } =
    useWalletIntentLifecycle(clearPendingSignIntent);
  const invalidateSignIntent = useCallback(() => {
    clearPendingSignIntent();
    invalidateIntent();
  }, [clearPendingSignIntent, invalidateIntent]);

  const sign = useCallback(
    async (generation: number) => {
      if (!isIntentCurrent(generation)) return;
      if (!wallet.publicKey || !wallet.signMessage) {
        invalidateSignIntent();
        onLoadingChange(false);
        onError(
          new Error(
            t("cloud.login.wallet.error.notSupported", {
              defaultValue:
                "Connected Solana wallet does not support message signing.",
            }),
          ),
        );
        return;
      }
      onLoadingChange(true);
      try {
        const publicKey = wallet.publicKey.toBase58();
        const signMessage = wallet.signMessage;
        const result = requireCompletedAuth(
          await auth.signInWithSolana(publicKey, async (msg: Uint8Array) => {
            throwIfWalletIntentExpired(isIntentCurrent, generation);
            const out = await signMessage(msg);
            throwIfWalletIntentExpired(isIntentCurrent, generation);
            if (!out)
              throw new Error(
                t("cloud.login.wallet.error.emptySignature", {
                  defaultValue: "Wallet returned an empty signature.",
                }),
              );
            return out;
          }),
        );
        if (!isIntentCurrent(generation)) return;
        await onSuccess(result);
      } catch (e) {
        if (!isIntentCurrent(generation)) return;
        const err = e instanceof Error ? e : new Error(String(e));
        onError(err);
      } finally {
        if (isIntentCurrent(generation)) {
          invalidateSignIntent();
          onLoadingChange(false);
        }
      }
    },
    [
      auth,
      invalidateSignIntent,
      isIntentCurrent,
      wallet,
      onSuccess,
      onError,
      onLoadingChange,
      t,
    ],
  );

  useEffect(() => {
    const generation = pendingSignGenerationRef.current;
    if (
      pendingSignRef.current &&
      generation !== null &&
      isIntentCurrent(generation) &&
      wallet.connected &&
      wallet.publicKey
    ) {
      clearPendingSignIntent();
      void sign(generation);
    }
  }, [
    wallet.connected,
    wallet.publicKey,
    clearPendingSignIntent,
    isIntentCurrent,
    sign,
  ]);

  useLayoutEffect(() => {
    if (!pendingSignRef.current) return;
    if (visible) {
      walletModalSeenRef.current = true;
      return;
    }
    // Fail closed if modal-close renders before `wallet.connecting`: never let
    // a later connection inherit an intent the user appeared to cancel.
    if (walletModalSeenRef.current && !wallet.connected && !wallet.connecting) {
      invalidateSignIntent();
      onLoadingChange(false);
    }
  }, [
    invalidateSignIntent,
    onLoadingChange,
    visible,
    wallet.connected,
    wallet.connecting,
  ]);

  const handleClick = useCallback(() => {
    if (disabled || loading) return;
    clearPendingSignIntent();
    const generation = beginIntent();
    if (wallet.connected && wallet.publicKey) {
      void sign(generation);
      return;
    }
    // Keep sibling provider actions locked while modal intent can still
    // progress into a signature. Cancellation and terminal paths release it.
    onLoadingChange(true);
    pendingSignRef.current = true;
    pendingSignGenerationRef.current = generation;
    walletModalSeenRef.current = false;
    try {
      setVisible(true);
    } catch (e) {
      if (!isIntentCurrent(generation)) return;
      invalidateSignIntent();
      onLoadingChange(false);
      const err = e instanceof Error ? e : new Error(String(e));
      onError(err);
    }
  }, [
    beginIntent,
    clearPendingSignIntent,
    disabled,
    invalidateSignIntent,
    isIntentCurrent,
    loading,
    onError,
    onLoadingChange,
    wallet.connected,
    wallet.publicKey,
    sign,
    setVisible,
  ]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || disabled || loading) return;
    autoStartedRef.current = true;
    onAutoStartHandled?.();
    handleClick();
  }, [autoStart, disabled, handleClick, loading, onAutoStartHandled]);

  return (
    <Button
      variant="outlineMuted"
      size="touch"
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="hosted-signin-focus-emphasis"
    >
      {loading && <Spinner />}
      {t("cloud.login.wallet.solana", { defaultValue: "Solana wallet" })}
    </Button>
  );
}
