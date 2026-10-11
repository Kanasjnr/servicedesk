// deps: @midnight-ntwrk/dapp-connector-api@4.0.0, @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-fetch-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-utils@3.0.0, @midnight-ntwrk/wallet-sdk-address-format@3.0.0, @midnight-ntwrk/compact-js@2.3.0, @midnight-ntwrk/compact-runtime@0.11.0, @midnight-ntwrk/ledger-v7@7.0.0, react@18.3.1, react-dom@18.3.1
//
// t06: Browser DApp. Connect to Lace through the Midnight DApp connector (v4),
// show the wallet address, and build midnight-js providers where the wallet
// does balancing, submission and proving.
//
// The compiled contract's keys/ and zkir/ folders must be served as static
// assets (e.g. copy ./contract/out/{keys,zkir} into public/counter/).

import { createElement as h, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId, type NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import type {
  FinalizedTransaction,
  ImpureCircuitId,
  MidnightProvider,
  MidnightProviders,
  ProofProvider,
  UnboundTransaction,
  UnprovenTransaction,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { MidnightBech32m, ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

import * as Counter from '../contract/out/contract/index.js';

declare global {
  interface Window {
    midnight?: Record<string, InitialAPI>;
  }
}

const NETWORK_ID: NetworkId = 'preprod';

type CounterPrivateState = Record<string, never>;
const PRIVATE_STATE_ID = 'counterPrivateState' as const;
type CounterCircuits = ImpureCircuitId<Counter.Contract<CounterPrivateState>>;
export type CounterProviders = MidnightProviders<CounterCircuits, typeof PRIVATE_STATE_ID, CounterPrivateState>;

export const counterCompiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
);

// ---------------------------------------------------------------------------
// Wallet discovery + connection
// ---------------------------------------------------------------------------

function findLace(): InitialAPI {
  const injected = window.midnight;
  if (!injected) throw new Error('No Midnight wallet found. Install the Lace extension.');
  const lace =
    injected.mnLace ??
    Object.values(injected).find((w) => w.name.toLowerCase().includes('lace') && w.apiVersion.startsWith('4.'));
  if (!lace) throw new Error('Lace (Midnight DApp connector v4) not found in window.midnight');
  return lace;
}

export async function connectLace(): Promise<ConnectedAPI> {
  const lace = findLace();
  const api = await lace.connect(NETWORK_ID);
  const status = await api.getConnectionStatus();
  if (status.status !== 'connected') throw new Error(`Wallet not connected: ${status.status}`);
  return api;
}

// ---------------------------------------------------------------------------
// Providers backed by the wallet
// ---------------------------------------------------------------------------

export async function buildProviders(api: ConnectedAPI): Promise<CounterProviders> {
  const walletConfig = await api.getConfiguration();
  setNetworkId(walletConfig.networkId as NetworkId);

  const { shieldedAddress } = await api.getShieldedAddresses();
  const parsedShielded = MidnightBech32m.parse(shieldedAddress).decode(ShieldedAddress, walletConfig.networkId);
  const coinPublicKey = parsedShielded.coinPublicKeyString();
  const encryptionPublicKey = parsedShielded.encryptionPublicKeyString();

  const zkConfigProvider = new FetchZkConfigProvider<CounterCircuits>(
    `${window.location.origin}/counter`,
    fetch.bind(window),
  );

  // Proving is delegated to the wallet; it fetches circuit material through us.
  const provingProvider = await api.getProvingProvider({
    getZKIR: (circuitKeyLocation: string) => zkConfigProvider.getZKIR(circuitKeyLocation as CounterCircuits),
    getProverKey: (circuitKeyLocation: string) => zkConfigProvider.getProverKey(circuitKeyLocation as CounterCircuits),
    getVerifierKey: (circuitKeyLocation: string) =>
      zkConfigProvider.getVerifierKey(circuitKeyLocation as CounterCircuits),
  });

  const proofProvider: ProofProvider<CounterCircuits> = {
    proveTx(unprovenTx: UnprovenTransaction): Promise<UnboundTransaction> {
      return unprovenTx.prove(provingProvider, ledger.CostModel.initialCostModel());
    },
  };

  // Balancing (fees in DUST + signing) is done by the wallet.
  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,
    async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
      const { tx: balancedHex } = await api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(balancedHex));
    },
  };

  // Submission goes through the wallet's node connection.
  const midnightProvider: MidnightProvider = {
    async submitTx(tx: FinalizedTransaction) {
      await api.submitTransaction(toHex(tx.serialize()));
      return tx.identifiers()[0];
    },
  };

  return {
    privateStateProvider: levelPrivateStateProvider<typeof PRIVATE_STATE_ID>({
      privateStateStoreName: 'counter-private-state',
      walletProvider,
      privateStoragePasswordProvider: async () => coinPublicKey,
    }),
    publicDataProvider: indexerPublicDataProvider(walletConfig.indexerUri, walletConfig.indexerWsUri),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };
}

// ---------------------------------------------------------------------------
// React UI
// ---------------------------------------------------------------------------

interface WalletSession {
  api: ConnectedAPI;
  unshieldedAddress: string;
  shieldedAddress: string;
  providers: CounterProviders;
}

export function useLaceWallet() {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const api = await connectLace();
      const [{ unshieldedAddress }, { shieldedAddress }] = await Promise.all([
        api.getUnshieldedAddress(),
        api.getShieldedAddresses(),
      ]);
      const providers = await buildProviders(api);
      setSession({ api, unshieldedAddress, shieldedAddress, providers });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  return { session, error, connecting, connect };
}

function App() {
  const { session, error, connecting, connect } = useLaceWallet();

  return h(
    'main',
    { style: { fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '2rem auto', padding: '0 16px' } },
    h('h1', null, 'Midnight Counter'),
    session
      ? h(
          'section',
          null,
          h('p', null, 'Connected to Lace on ', h('strong', null, NETWORK_ID)),
          h('p', null, 'Unshielded address: ', h('code', { style: { wordBreak: 'break-all' } }, session.unshieldedAddress)),
          h('p', null, 'Shielded address: ', h('code', { style: { wordBreak: 'break-all' } }, session.shieldedAddress)),
          h('p', null, 'Providers ready: ', Object.keys(session.providers).join(', ')),
        )
      : h('button', { onClick: connect, disabled: connecting }, connecting ? 'Connecting...' : 'Connect Lace'),
    error ? h('p', { style: { color: 'crimson' } }, error) : null,
  );
}

const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(h(App));
