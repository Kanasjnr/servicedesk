// deps: react@18.3.1, react-dom@18.3.1, @midnight-ntwrk/dapp-connector-api@3.0.0, @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/ledger@4.0.0, vite@5.4.10, @vitejs/plugin-react@4.3.2
import { useCallback, useEffect, useState } from 'react';
import type { DAppConnectorAPI, DAppConnectorWalletAPI } from '@midnight-ntwrk/dapp-connector-api';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { WalletProvider, MidnightProvider } from '@midnight-ntwrk/midnight-js-types';

declare global {
  interface Window {
    midnight?: { mnLace?: DAppConnectorAPI };
  }
}

const NETWORK = 'preprod';
const INDEXER_HTTP = 'https://midnight-preprod.blockfrost.io/api/v0?project_id=<your preprod project_id>';
const INDEXER_WS = 'wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=<your preprod project_id>';
const PROOF_SERVER = 'http://localhost:6300';

setNetworkId(NETWORK);

// Wallet-backed providers: the Lace wallet balances, proves and submits transactions.
function buildWalletProviders(wallet: DAppConnectorWalletAPI) {
  const walletProvider: WalletProvider = {
    getCoinPublicKey: async () => {
      const [shielded] = await wallet.getShieldedAddresses();
      return shielded.coinPublicKey;
    },
    getEncryptionPublicKey: async () => {
      const [shielded] = await wallet.getShieldedAddresses();
      return shielded.encryptionPublicKey;
    },
    balanceTx: async (tx, ttl) => {
      const proven = await wallet.balanceAndProveTransaction(tx, ttl);
      return proven;
    },
  };

  const midnightProvider: MidnightProvider = {
    submitTx: async (tx) => {
      const txId = await wallet.submitTransaction(tx);
      return txId;
    },
  };

  const zkConfigProvider = new FetchZkConfigProvider<'increment'>(`${window.location.origin}/contract`);

  return {
    walletProvider,
    midnightProvider,
    publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS),
    zkConfigProvider,
    // Proving still runs on the proof server; the wallet only balances the transaction.
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
  };
}

export function App() {
  const [wallet, setWallet] = useState<DAppConnectorWalletAPI | null>(null);
  const [address, setAddress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    try {
      const connector = window.midnight?.mnLace;
      if (!connector) throw new Error('Lace wallet not found. Install the Lace browser extension.');

      const api = await connector.enable();
      const config = await api.getConfiguration();
      if (config.networkId !== NETWORK) {
        throw new Error(`Lace is on ${config.networkId}; switch it to ${NETWORK}.`);
      }

      const [unshielded] = [await api.getUnshieldedAddress()];
      setWallet(api);
      setAddress(unshielded.unshieldedAddress);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    connect();
  }, [connect]);

  const providers = wallet ? buildWalletProviders(wallet) : null;

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Counter DApp</h1>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {address ? (
        <>
          <p>
            Connected wallet: <code>{address}</code>
          </p>
          <p>{providers ? 'Providers ready.' : 'Connecting providers...'}</p>
        </>
      ) : (
        <button onClick={connect}>Connect Lace</button>
      )}
    </main>
  );
}
