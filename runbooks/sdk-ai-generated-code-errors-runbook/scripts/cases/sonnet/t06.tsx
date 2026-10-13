// deps: @midnight-ntwrk/dapp-connector-api@4.0.0, @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-fetch-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/ledger-v7@7.0.0, react@18.3.1, react-dom@18.3.1, vite@5.4.10, typescript@5.6.3
// File: src/App.tsx
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as ledger from '@midnight-ntwrk/ledger-v7';

declare global {
  interface Window {
    midnight?: { mnLace?: InitialAPI; [key: string]: InitialAPI | undefined };
  }
}

const NETWORK = 'preprod';
setNetworkId(NETWORK);

async function buildProviders(api: ConnectedAPI) {
  const config = await api.getConfiguration();
  const shielded = await api.getShieldedAddresses();
  const zkConfigProvider = new FetchZkConfigProvider<'increment'>(`${window.location.origin}/contract`);

  const walletProvider = {
    getCoinPublicKey: () => shielded.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => shielded.shieldedEncryptionPublicKey,
    async balanceTx(tx: ledger.UnprovenTransaction): Promise<ledger.FinalizedTransaction> {
      const serialized = toHex(tx.serialize());
      const { tx: balanced } = await api.balanceUnsealedTransaction(serialized);
      return ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(balanced));
    },
  };

  const midnightProvider = {
    async submitTx(tx: ledger.FinalizedTransaction): Promise<string> {
      await api.submitTransaction(toHex(tx.serialize()));
      return tx.identifiers()[0];
    },
  };

  // Proving is delegated to the wallet's configured prover server
  const proofProvider = (await api.getProvingProvider(zkConfigProvider)) as any;

  return {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: 'counter-dapp' }),
    publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
    zkConfigProvider,
    proofProvider: proofProvider ?? httpClientProofProvider(config.proverServerUri!, zkConfigProvider),
    walletProvider,
    midnightProvider,
  };
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

function App() {
  const [address, setAddress] = useState<string>();
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof buildProviders>>>();
  const [error, setError] = useState<string>();

  async function connect() {
    try {
      const initial = window.midnight?.mnLace;
      if (!initial) throw new Error('Lace wallet not found. Install the Lace extension.');
      const api = await initial.connect(NETWORK);
      const { unshieldedAddress } = await api.getUnshieldedAddress();
      setAddress(unshieldedAddress);
      setProviders(await buildProviders(api));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>Counter DApp</h1>
      {!address && <button onClick={connect}>Connect Lace</button>}
      {address && <p>Connected: <code>{address}</code></p>}
      {providers && <p>Providers ready (balancing, submitting and proving via Lace).</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
