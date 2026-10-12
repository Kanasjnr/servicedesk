// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/compact-runtime@0.9.0, ws@8.18.0
import { WebSocket } from 'ws';
import path from 'node:path';
import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProviders, type MidnightProviders } from '@midnight-ntwrk/midnight-js-contracts';
import { getWalletProvider, getMidnightProvider } from './wallet-providers.js';
import type { CounterPrivateState } from './types.js';

(globalThis as any).WebSocket = WebSocket;

const CONTRACT_DIR = path.resolve(process.cwd(), 'contract/out');
const PRIVATE_STATE_STORE = 'counter-private-state';

export interface NodeConfig {
  networkId: 'preprod';
  indexerUri: string;
  indexerWsUri: string;
  node: string;
  proofServer: string;
  seedHex: string;
}

export type CounterProviders = MidnightProviders<'increment', CounterPrivateState>;

export async function buildProviders(config: NodeConfig): Promise<CounterProviders> {
  setNetworkId(config.networkId);

  const wallet = await WalletBuilder.buildFromSeed(config, config.seedHex);
  await wallet.start();

  const zkConfigProvider = new NodeZkConfigProvider<'increment'>(CONTRACT_DIR);

  return createProviders<'increment', CounterPrivateState>({
    // Public, indexed chain data (contract state, transactions, blocks).
    publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
    // Circuit prover and verifier keys, read from the compiled contract output.
    zkConfigProvider,
    // Local ZK proof generation via the proof server.
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    // Private state (witness data) kept encrypted in a local LevelDB store.
    privateStateProvider: levelPrivateStateProvider<CounterPrivateState>({
      privateStateStoreName: PRIVATE_STATE_STORE,
    }),
    walletProvider: getWalletProvider(wallet),
    midnightProvider: getMidnightProvider(wallet),
  });
}

export const PREPROD_CONFIG: Omit<NodeConfig, 'seedHex'> = {
  networkId: 'preprod',
  indexerUri: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWsUri: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://localhost:6300',
};
