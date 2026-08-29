/** Verifies wallet-chain capability gating with deterministic vendor hook doubles. */
// @vitest-environment jsdom

import type { StewardAuth } from "@stwd/sdk";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletHooks = vi.hoisted(() => ({
  connectAsync: vi.fn(),
  connectors: [] as Array<{
    getAccounts?: () => Promise<readonly `0x${string}`[]>;
    getChainId?: () => Promise<number>;
    getProvider: () => Promise<unknown>;
    id: string;
    name: string;
    type: string;
  }>,
  connectModalAvailable: true,
  connectModalOpen: false,
  evmAccount: {
    address: undefined as `0x${string}` | undefined,
    connector: undefined as
      | {
          getAccounts: () => Promise<readonly `0x${string}`[]>;
          getChainId: () => Promise<number>;
          getProvider: () => Promise<unknown>;
          id: string;
          name: string;
          type: string;
        }
      | undefined,
    isConnected: false,
    isConnecting: false,
  },
  openConnectModal: vi.fn(),
  solanaModalVisible: false,
  solanaWallet: {
    connected: false,
    connecting: false,
    publicKey: null as { toBase58: () => string } | null,
    signMessage: undefined as
      | ((message: Uint8Array) => Promise<Uint8Array>)
      | undefined,
  },
  setSolanaModalVisible: vi.fn(),
  signMessageAsync: vi.fn(),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({
    connectModalOpen: walletHooks.connectModalOpen,
    openConnectModal: walletHooks.connectModalAvailable
      ? walletHooks.openConnectModal
      : undefined,
  }),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => walletHooks.solanaWallet,
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({
    setVisible: walletHooks.setSolanaModalVisible,
    visible: walletHooks.solanaModalVisible,
  }),
}));

vi.mock("wagmi", () => ({
  useAccount: () => walletHooks.evmAccount,
  useConnect: () => ({
    connectAsync: walletHooks.connectAsync,
    connectors: walletHooks.connectors,
  }),
  useSignMessage: () => ({
    signMessageAsync: walletHooks.signMessageAsync,
  }),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

import { WalletButtons } from "./wallet-buttons";

const auth = {} as StewardAuth;

function resetWalletHooks() {
  walletHooks.connectors.length = 0;
  walletHooks.connectModalAvailable = true;
  walletHooks.connectModalOpen = false;
  walletHooks.evmAccount.address = undefined;
  walletHooks.evmAccount.connector = undefined;
  walletHooks.evmAccount.isConnected = false;
  walletHooks.evmAccount.isConnecting = false;
  walletHooks.solanaModalVisible = false;
  walletHooks.solanaWallet.connected = false;
  walletHooks.solanaWallet.connecting = false;
  walletHooks.solanaWallet.publicKey = null;
  walletHooks.solanaWallet.signMessage = undefined;
  Reflect.deleteProperty(window, "ethereum");
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createEvmConnector(address: `0x${string}`, chainId: number) {
  return {
    getAccounts: vi.fn().mockResolvedValue([address]),
    getChainId: vi.fn().mockResolvedValue(chainId),
    getProvider: vi.fn().mockResolvedValue({}),
    id: "injected",
    name: "Injected",
    type: "injected",
  };
}

function renderWalletButtons({
  authOverride = auth,
  autoStart = null,
  siwe = false,
  siws = false,
  strictMode = false,
}: {
  authOverride?: StewardAuth;
  autoStart?: "ethereum" | "solana" | null;
  siwe?: boolean;
  siws?: boolean;
  strictMode?: boolean;
} = {}) {
  const props = {
    auth: authOverride,
    autoStart,
    disabled: false,
    siwe,
    siws,
    loadingProvider: null,
    onLoadingChange: vi.fn(),
    onAutoStartHandled: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
  } as const;
  const renderElement = () => {
    const buttons = <WalletButtons {...props} />;
    return strictMode ? <StrictMode>{buttons}</StrictMode> : buttons;
  };
  const view = render(renderElement());

  return {
    ...view,
    props,
    rerenderWalletButtons: () => view.rerender(renderElement()),
  };
}

describe("WalletButtons capability gating", () => {
  beforeEach(resetWalletHooks);

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("fails closed when wallet capabilities are omitted", () => {
    render(
      <WalletButtons
        auth={auth}
        autoStart={null}
        disabled={false}
        loadingProvider={null}
        onLoadingChange={vi.fn()}
        onSuccess={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /EVM wallet/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Solana wallet/i })).toBeNull();
  });

  it.each([
    { siwe: true, siws: false },
    { siwe: false, siws: true },
    { siwe: true, siws: true },
  ])(
    "renders only announced chains for siwe=$siwe and siws=$siws",
    ({ siwe, siws }) => {
      render(
        <WalletButtons
          auth={auth}
          autoStart={null}
          disabled={false}
          siwe={siwe}
          siws={siws}
          loadingProvider={null}
          onLoadingChange={vi.fn()}
          onSuccess={vi.fn()}
          onError={vi.fn()}
        />,
      );

      expect(
        screen.queryByRole("button", { name: /EVM wallet/i }) !== null,
      ).toBe(siwe);
      expect(
        screen.queryByRole("button", { name: /Solana wallet/i }) !== null,
      ).toBe(siws);
    },
  );
});

describe("WalletButtons SIWE authority binding", () => {
  beforeEach(resetWalletHooks);

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, "ethereum");
  });

  it.each([
    { chainId: 8453, name: "Base" },
    { chainId: 56, name: "BSC" },
  ])(
    "passes the live $name chain to Steward and rechecks it before signing",
    async ({ chainId }) => {
      const address = "0x1111111111111111111111111111111111111111";
      const connector = createEvmConnector(address, chainId);
      walletHooks.evmAccount.address = address;
      walletHooks.evmAccount.connector = connector;
      walletHooks.evmAccount.isConnected = true;
      walletHooks.signMessageAsync.mockResolvedValue("0xsigned");
      const signInWithSIWE = vi.fn(
        async (
          _address: string,
          signer: (message: string) => Promise<string>,
        ) => {
          await signer("chain-bound SIWE message");
          return {};
        },
      );
      const { props } = renderWalletButtons({
        authOverride: { signInWithSIWE } as unknown as StewardAuth,
        siwe: true,
      });

      fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

      await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
      expect(signInWithSIWE).toHaveBeenCalledWith(
        address,
        expect.any(Function),
        chainId,
      );
      expect(connector.getAccounts).toHaveBeenCalledTimes(3);
      expect(connector.getChainId).toHaveBeenCalledTimes(3);
      expect(walletHooks.signMessageAsync).toHaveBeenCalledWith({
        account: address,
        connector,
        message: "chain-bound SIWE message",
      });
    },
  );

  it("keeps Wagmi signing bound to the connector and account that began the intent", async () => {
    const address = "0x1212121212121212121212121212121212121212";
    const competingAddress = "0x1313131313131313131313131313131313131313";
    const capturedConnector = createEvmConnector(address, 8453);
    const competingConnector = createEvmConnector(competingAddress, 56);
    walletHooks.evmAccount.address = address;
    walletHooks.evmAccount.connector = capturedConnector;
    walletHooks.evmAccount.isConnected = true;
    walletHooks.signMessageAsync.mockResolvedValue("0xsigned");
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        // Model another connection becoming Wagmi's global `current` connection
        // while Steward's nonce request is in flight. The signer must retain the
        // connector and account captured by this login intent.
        walletHooks.evmAccount.address = competingAddress;
        walletHooks.evmAccount.connector = competingConnector;
        await signer("connector-bound SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(walletHooks.signMessageAsync).toHaveBeenCalledWith({
      account: address,
      connector: capturedConnector,
      message: "connector-bound SIWE message",
    });
    expect(capturedConnector.getAccounts).toHaveBeenCalledTimes(3);
    expect(capturedConnector.getChainId).toHaveBeenCalledTimes(3);
    expect(competingConnector.getAccounts).not.toHaveBeenCalled();
    expect(competingConnector.getChainId).not.toHaveBeenCalled();
  });

  it("fails before nonce/signature work on an unsupported connected chain", async () => {
    const address = "0x2222222222222222222222222222222222222222";
    walletHooks.evmAccount.address = address;
    walletHooks.evmAccount.connector = createEvmConnector(address, 1);
    walletHooks.evmAccount.isConnected = true;
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Ethereum wallet sign-in requires a supported chain (8453, 56), but the wallet is on chain 1.",
    });
    expect(signInWithSIWE).not.toHaveBeenCalled();
    expect(walletHooks.signMessageAsync).not.toHaveBeenCalled();
  });

  it("rejects a supported chain switch between nonce and signature", async () => {
    const address = "0x3333333333333333333333333333333333333333";
    const connector = createEvmConnector(address, 8453);
    connector.getChainId
      .mockReset()
      .mockResolvedValueOnce(8453)
      .mockResolvedValueOnce(56);
    walletHooks.evmAccount.address = address;
    walletHooks.evmAccount.connector = connector;
    walletHooks.evmAccount.isConnected = true;
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("stale-chain SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(signInWithSIWE).toHaveBeenCalledWith(
      address,
      expect.any(Function),
      8453,
    );
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Ethereum wallet chain changed from 8453 to 56 before signing.",
    });
    expect(walletHooks.signMessageAsync).not.toHaveBeenCalled();
  });

  it("rejects an account switch between nonce and signature", async () => {
    const address = "0x4444444444444444444444444444444444444444";
    const connector = createEvmConnector(address, 8453);
    connector.getAccounts
      .mockReset()
      .mockResolvedValueOnce([address])
      .mockResolvedValueOnce(["0x5555555555555555555555555555555555555555"]);
    walletHooks.evmAccount.address = address;
    walletHooks.evmAccount.connector = connector;
    walletHooks.evmAccount.isConnected = true;
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("stale-account SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Ethereum wallet account changed before sign-in could be authorized.",
    });
    expect(walletHooks.signMessageAsync).not.toHaveBeenCalled();
  });

  it("rejects a connector chain switch while the signature prompt is open", async () => {
    const address = "0x5656565656565656565656565656565656565656";
    let currentChainId = 8453;
    const connector = createEvmConnector(address, currentChainId);
    connector.getChainId
      .mockReset()
      .mockImplementation(async () => currentChainId);
    walletHooks.evmAccount.address = address;
    walletHooks.evmAccount.connector = connector;
    walletHooks.evmAccount.isConnected = true;
    const signature = createDeferred<string>();
    walletHooks.signMessageAsync.mockImplementation(() => signature.promise);
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("chain-drift SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(walletHooks.signMessageAsync).toHaveBeenCalledTimes(1),
    );

    currentChainId = 56;
    await act(async () => {
      signature.resolve("0xsigned");
      await signature.promise;
    });

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Ethereum wallet chain changed from 8453 to 56 while signing.",
    });
    expect(connector.getAccounts).toHaveBeenCalledTimes(3);
    expect(connector.getChainId).toHaveBeenCalledTimes(3);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it("rejects a connector account switch while the signature prompt is open", async () => {
    const address = "0x5757575757575757575757575757575757575757";
    let currentAddress: `0x${string}` = address;
    const connector = createEvmConnector(address, 8453);
    connector.getAccounts
      .mockReset()
      .mockImplementation(async () => [currentAddress]);
    walletHooks.evmAccount.address = address;
    walletHooks.evmAccount.connector = connector;
    walletHooks.evmAccount.isConnected = true;
    const signature = createDeferred<string>();
    walletHooks.signMessageAsync.mockImplementation(() => signature.promise);
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("account-drift SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(walletHooks.signMessageAsync).toHaveBeenCalledTimes(1),
    );

    currentAddress = "0x5858585858585858585858585858585858585858";
    await act(async () => {
      signature.resolve("0xsigned");
      await signature.promise;
    });

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Ethereum wallet account changed before sign-in could be authorized.",
    });
    expect(connector.getAccounts).toHaveBeenCalledTimes(3);
    expect(connector.getChainId).toHaveBeenCalledTimes(3);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it("binds and rechecks the chain for the direct EIP-1193 path", async () => {
    const address = "0x6666666666666666666666666666666666666666";
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [address];
      if (method === "eth_chainId") return "0x2105";
      if (method === "personal_sign") return "0xsigned";
      throw new Error(`Unexpected wallet method: ${method}`);
    });
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: { request },
    });
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("direct-provider SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1));
    expect(signInWithSIWE).toHaveBeenCalledWith(
      address,
      expect.any(Function),
      8453,
    );
    expect(
      request.mock.calls.filter(([args]) => args.method === "eth_chainId"),
    ).toHaveLength(3);
    expect(
      request.mock.calls.filter(([args]) => args.method === "eth_accounts"),
    ).toHaveLength(4);
    expect(
      request.mock.calls.filter(([args]) => args.method === "personal_sign"),
    ).toHaveLength(1);
  });

  it("rejects a direct-provider chain switch while the signature prompt is open", async () => {
    const address = "0x6767676767676767676767676767676767676767";
    let currentChainId = "0x2105";
    const signature = createDeferred<string>();
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [address];
      if (method === "eth_chainId") return currentChainId;
      if (method === "personal_sign") return await signature.promise;
      throw new Error(`Unexpected wallet method: ${method}`);
    });
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: { request },
    });
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("direct-chain-drift SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([args]) => args.method === "personal_sign"),
      ).toHaveLength(1),
    );

    currentChainId = "0x38";
    await act(async () => {
      signature.resolve("0xsigned");
      await signature.promise;
    });

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Ethereum wallet chain changed from 8453 to 56 while signing.",
    });
    expect(
      request.mock.calls.filter(([args]) => args.method === "eth_accounts"),
    ).toHaveLength(4);
    expect(
      request.mock.calls.filter(([args]) => args.method === "eth_chainId"),
    ).toHaveLength(3);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it("rejects a direct-provider account switch while the signature prompt is open", async () => {
    const address = "0x6868686868686868686868686868686868686868";
    let currentAddress: `0x${string}` = address;
    const signature = createDeferred<string>();
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [currentAddress];
      if (method === "eth_chainId") return "0x2105";
      if (method === "personal_sign") return await signature.promise;
      throw new Error(`Unexpected wallet method: ${method}`);
    });
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: { request },
    });
    const signInWithSIWE = vi.fn(
      async (
        _address: string,
        signer: (message: string) => Promise<string>,
      ) => {
        await signer("direct-account-drift SIWE message");
        return {};
      },
    );
    const { props } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([args]) => args.method === "personal_sign"),
      ).toHaveLength(1),
    );

    currentAddress = "0x6969696969696969696969696969696969696969";
    await act(async () => {
      signature.resolve("0xsigned");
      await signature.promise;
    });

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Ethereum wallet account changed before sign-in could be authorized.",
    });
    expect(
      request.mock.calls.filter(([args]) => args.method === "eth_accounts"),
    ).toHaveLength(4);
    expect(
      request.mock.calls.filter(([args]) => args.method === "eth_chainId"),
    ).toHaveLength(3);
    expect(props.onSuccess).not.toHaveBeenCalled();
  });
});

describe("WalletButtons modal intent lifecycle", () => {
  beforeEach(resetWalletHooks);

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not sign when an unrelated EVM connection arrives after modal cancellation", async () => {
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(walletHooks.openConnectModal).toHaveBeenCalledTimes(1),
    );
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"]]);

    walletHooks.connectModalOpen = true;
    rerenderWalletButtons();
    expect(props.onLoadingChange).toHaveBeenLastCalledWith("ethereum");
    walletHooks.connectModalOpen = false;
    rerenderWalletButtons();
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"], [null]]);

    walletHooks.evmAccount.address =
      "0x1111111111111111111111111111111111111111";
    walletHooks.evmAccount.isConnected = true;
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSIWE).not.toHaveBeenCalled());
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"], [null]]);
  });

  it("fails EVM intent closed when connecting starts after modal close", async () => {
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(walletHooks.openConnectModal).toHaveBeenCalledTimes(1),
    );
    walletHooks.connectModalOpen = true;
    rerenderWalletButtons();
    walletHooks.connectModalOpen = false;
    rerenderWalletButtons();
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"], [null]]);

    walletHooks.evmAccount.isConnecting = true;
    rerenderWalletButtons();
    walletHooks.evmAccount.isConnecting = false;
    walletHooks.evmAccount.isConnected = true;
    walletHooks.evmAccount.address =
      "0x5555555555555555555555555555555555555555";
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSIWE).not.toHaveBeenCalled());
    expect(props.onLoadingChange).toHaveBeenLastCalledWith(null);
  });

  it("reports unavailable EVM connection without arming a signing intent", async () => {
    walletHooks.connectModalAvailable = false;
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"], [null]]);
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Ethereum wallet connection is unavailable. Refresh and try again.",
    });
    walletHooks.evmAccount.address =
      "0x3333333333333333333333333333333333333333";
    walletHooks.evmAccount.isConnected = true;
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSIWE).not.toHaveBeenCalled());
  });

  it("clears EVM intent when opening the connect modal throws", async () => {
    walletHooks.openConnectModal.mockImplementationOnce(() => {
      throw new Error("EVM modal launch failed");
    });
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"], [null]]);
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message: "EVM modal launch failed",
    });
    walletHooks.evmAccount.address =
      "0x4444444444444444444444444444444444444444";
    walletHooks.evmAccount.isConnected = true;
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSIWE).not.toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledTimes(1);
  });

  it("keeps EVM intent through an in-progress connection and signs once", async () => {
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(walletHooks.openConnectModal).toHaveBeenCalledTimes(1),
    );
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"]]);

    walletHooks.connectModalOpen = true;
    rerenderWalletButtons();
    walletHooks.connectModalOpen = false;
    walletHooks.evmAccount.isConnecting = true;
    rerenderWalletButtons();
    expect(props.onLoadingChange).toHaveBeenLastCalledWith("ethereum");
    walletHooks.evmAccount.isConnecting = false;
    walletHooks.evmAccount.isConnected = true;
    walletHooks.evmAccount.address =
      "0x2222222222222222222222222222222222222222";
    walletHooks.evmAccount.connector = createEvmConnector(
      "0x2222222222222222222222222222222222222222",
      8453,
    );
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSIWE).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(props.onLoadingChange).toHaveBeenLastCalledWith(null),
    );
  });

  it("does not sign when an unrelated Solana connection arrives after modal cancellation", () => {
    const signInWithSolana = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      siws: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Solana wallet/i }));
    expect(walletHooks.setSolanaModalVisible).toHaveBeenCalledWith(true);
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"]]);

    walletHooks.solanaModalVisible = true;
    rerenderWalletButtons();
    expect(props.onLoadingChange).toHaveBeenLastCalledWith("solana");
    walletHooks.solanaModalVisible = false;
    rerenderWalletButtons();
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"], [null]]);

    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "unrelated-solana-account",
    };
    rerenderWalletButtons();

    expect(signInWithSolana).not.toHaveBeenCalled();
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"], [null]]);
  });

  it("fails Solana intent closed when connecting starts after modal close", async () => {
    const signInWithSolana = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      siws: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Solana wallet/i }));
    expect(walletHooks.setSolanaModalVisible).toHaveBeenCalledWith(true);
    walletHooks.solanaModalVisible = true;
    rerenderWalletButtons();
    walletHooks.solanaModalVisible = false;
    rerenderWalletButtons();
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"], [null]]);

    walletHooks.solanaWallet.connecting = true;
    rerenderWalletButtons();
    walletHooks.solanaWallet.connecting = false;
    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "solana-account-after-late-connecting",
    };
    walletHooks.solanaWallet.signMessage = vi
      .fn()
      .mockResolvedValue(new Uint8Array([7, 8, 9]));
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSolana).not.toHaveBeenCalled());
    expect(props.onLoadingChange).toHaveBeenLastCalledWith(null);
  });

  it("clears Solana intent when opening the wallet modal throws", async () => {
    walletHooks.setSolanaModalVisible.mockImplementationOnce(() => {
      throw new Error("Solana modal launch failed");
    });
    const signInWithSolana = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      siws: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Solana wallet/i }));

    expect(props.onError).toHaveBeenCalledTimes(1);
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"], [null]]);
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Solana modal launch failed",
    });
    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "unrelated-solana-account-after-launch-failure",
    };
    walletHooks.solanaWallet.signMessage = vi
      .fn()
      .mockResolvedValue(new Uint8Array([4, 5, 6]));
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSolana).not.toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledTimes(1);
  });

  it("releases the modal loading lock for an unsupported connected Solana wallet", async () => {
    const signInWithSolana = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      siws: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Solana wallet/i }));
    walletHooks.solanaModalVisible = true;
    rerenderWalletButtons();
    walletHooks.solanaModalVisible = false;
    walletHooks.solanaWallet.connecting = true;
    rerenderWalletButtons();
    expect(props.onLoadingChange).toHaveBeenLastCalledWith("solana");

    walletHooks.solanaWallet.connecting = false;
    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "solana-wallet-without-message-signing",
    };
    rerenderWalletButtons();

    await waitFor(() => expect(props.onError).toHaveBeenCalledTimes(1));
    expect(props.onError.mock.calls[0]?.[0]).toMatchObject({
      message: "Connected Solana wallet does not support message signing.",
    });
    expect(props.onLoadingChange).toHaveBeenLastCalledWith(null);
    expect(signInWithSolana).not.toHaveBeenCalled();
  });

  it("keeps Solana intent through an in-progress connection and signs once", async () => {
    const signInWithSolana = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      siws: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Solana wallet/i }));
    expect(walletHooks.setSolanaModalVisible).toHaveBeenCalledWith(true);
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"]]);

    walletHooks.solanaModalVisible = true;
    rerenderWalletButtons();
    walletHooks.solanaModalVisible = false;
    walletHooks.solanaWallet.connecting = true;
    rerenderWalletButtons();
    expect(props.onLoadingChange).toHaveBeenLastCalledWith("solana");
    walletHooks.solanaWallet.connecting = false;
    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "connected-solana-account",
    };
    walletHooks.solanaWallet.signMessage = vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3]));
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSolana).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(props.onLoadingChange).toHaveBeenLastCalledWith(null),
    );
  });
});

describe("WalletButtons deferred intent liveness", () => {
  beforeEach(resetWalletHooks);

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Reflect.deleteProperty(window, "ethereum");
  });

  it("routes a production-shaped unavailable injected connector to RainbowKit", async () => {
    walletHooks.connectors.push(
      {
        getProvider: async () => undefined,
        id: "injected",
        name: "Injected",
        type: "injected",
      },
      {
        getProvider: async () => ({}),
        id: "walletConnect",
        name: "WalletConnect",
        type: "walletConnect",
      },
    );
    const { props } = renderWalletButtons({ siwe: true });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));

    await waitFor(() =>
      expect(walletHooks.openConnectModal).toHaveBeenCalledTimes(1),
    );
    expect(walletHooks.connectAsync).not.toHaveBeenCalled();
    expect(props.onLoadingChange.mock.calls).toEqual([["ethereum"]]);
  });

  it("does not continue to account request or SIWE after unmounting a deferred EIP-1193 lookup", async () => {
    const accounts = createDeferred<readonly string[] | null>();
    const request = vi.fn(({ method }: { method: string }) => {
      if (method === "eth_accounts") return accounts.promise;
      return Promise.resolve(["0x6666666666666666666666666666666666666666"]);
    });
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: { request },
    });
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, unmount } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      accounts.resolve(["0x6666666666666666666666666666666666666666"]);
      await accounts.promise;
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(signInWithSIWE).not.toHaveBeenCalled();
    expect(walletHooks.signMessageAsync).not.toHaveBeenCalled();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it("does not start SIWE when a deferred wagmi connect resolves after unmount", async () => {
    walletHooks.connectors.push({
      getProvider: async () => ({}),
      id: "injected",
      name: "Injected",
      type: "injected",
    });
    const connected = createDeferred<{
      accounts: [`0x${string}`, ...`0x${string}`[]];
    }>();
    walletHooks.connectAsync.mockImplementationOnce(() => connected.promise);
    const signInWithSIWE = vi.fn().mockResolvedValue({});
    const { props, unmount } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() =>
      expect(walletHooks.connectAsync).toHaveBeenCalledTimes(1),
    );
    unmount();
    await act(async () => {
      connected.resolve({
        accounts: ["0x7777777777777777777777777777777777777777"],
      });
      await connected.promise;
    });

    expect(signInWithSIWE).not.toHaveBeenCalled();
    expect(walletHooks.signMessageAsync).not.toHaveBeenCalled();
    expect(props.onSuccess).not.toHaveBeenCalled();
  });

  it("blocks a deferred SIWE signer callback and completion after unmount", async () => {
    walletHooks.evmAccount.address =
      "0x8888888888888888888888888888888888888888";
    walletHooks.evmAccount.connector = createEvmConnector(
      "0x8888888888888888888888888888888888888888",
      8453,
    );
    walletHooks.evmAccount.isConnected = true;
    const sdkResult = createDeferred<Record<string, never>>();
    let sdkSigner: ((message: string) => Promise<string>) | undefined;
    const signInWithSIWE = vi.fn(
      (_address: string, signer: (message: string) => Promise<string>) => {
        sdkSigner = signer;
        return sdkResult.promise;
      },
    );
    const { props, unmount } = renderWalletButtons({
      authOverride: { signInWithSIWE } as unknown as StewardAuth,
      siwe: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /EVM wallet/i }));
    await waitFor(() => expect(sdkSigner).toBeTypeOf("function"));
    unmount();

    await expect(sdkSigner?.("late SIWE message")).rejects.toThrow(
      "Wallet sign-in intent expired.",
    );
    expect(walletHooks.signMessageAsync).not.toHaveBeenCalled();
    await act(async () => {
      sdkResult.resolve({});
      await sdkResult.promise;
    });
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("blocks a deferred SIWS signer callback and completion after unmount", async () => {
    const walletSigner = vi
      .fn()
      .mockResolvedValue(new Uint8Array([10, 11, 12]));
    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "deferred-solana-account",
    };
    walletHooks.solanaWallet.signMessage = walletSigner;
    const sdkResult = createDeferred<Record<string, never>>();
    let sdkSigner: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
    const signInWithSolana = vi.fn(
      (
        _publicKey: string,
        signer: (message: Uint8Array) => Promise<Uint8Array>,
      ) => {
        sdkSigner = signer;
        return sdkResult.promise;
      },
    );
    const { props, unmount } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      siws: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Solana wallet/i }));
    await waitFor(() => expect(sdkSigner).toBeTypeOf("function"));
    unmount();

    await expect(sdkSigner?.(new Uint8Array([1]))).rejects.toThrow(
      "Wallet sign-in intent expired.",
    );
    expect(walletSigner).not.toHaveBeenCalled();
    await act(async () => {
      sdkResult.resolve({});
      await sdkResult.promise;
    });
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("preserves one Solana auto-start intent through StrictMode effect replay", async () => {
    const signInWithSolana = vi.fn().mockResolvedValue({});
    const { props, rerenderWalletButtons } = renderWalletButtons({
      authOverride: { signInWithSolana } as unknown as StewardAuth,
      autoStart: "solana",
      siws: true,
      strictMode: true,
    });

    await waitFor(() =>
      expect(walletHooks.setSolanaModalVisible).toHaveBeenCalledTimes(1),
    );
    expect(props.onAutoStartHandled).toHaveBeenCalledTimes(1);
    expect(props.onLoadingChange.mock.calls).toEqual([["solana"]]);

    walletHooks.solanaModalVisible = true;
    rerenderWalletButtons();
    walletHooks.solanaModalVisible = false;
    walletHooks.solanaWallet.connecting = true;
    rerenderWalletButtons();
    walletHooks.solanaWallet.connecting = false;
    walletHooks.solanaWallet.connected = true;
    walletHooks.solanaWallet.publicKey = {
      toBase58: () => "strict-mode-solana-account",
    };
    walletHooks.solanaWallet.signMessage = vi
      .fn()
      .mockResolvedValue(new Uint8Array([13, 14, 15]));
    rerenderWalletButtons();

    await waitFor(() => expect(signInWithSolana).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(props.onLoadingChange).toHaveBeenLastCalledWith(null),
    );
  });
});
