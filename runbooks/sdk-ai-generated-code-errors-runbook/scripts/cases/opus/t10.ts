// deps: @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0
//
// Set the Midnight network to preprod and configure the indexer, node RPC and
// proof server endpoints, then build the endpoint-backed providers.

import path from 'node:path';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type { PublicDataProvider, ProofProvider, ZKConfigProvider, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';

export interface MidnightNetworkConfig {
  readonly networkId: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

export const PreprodConfig: MidnightNetworkConfig = {
  networkId: 'preprod',
  indexer: process.env.MIDNIGHT_INDEXER_URL ?? `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: process.env.MIDNIGHT_INDEXER_WS_URL ?? `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: process.env.MIDNIGHT_NODE_URL ?? `https://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: process.env.MIDNIGHT_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
};

// Must run before any ledger/wallet/contract code serialises data,
// since encodings and addresses are network-specific.
setNetworkId(PreprodConfig.networkId);

const ZK_CONFIG_PATH = path.resolve(process.cwd(), 'contract', 'out');

export interface EndpointProviders {
  publicDataProvider: PublicDataProvider;
  zkConfigProvider: ZKConfigProvider<'increment'>;
  proofProvider: ProofProvider<'increment'>;
  privateStateProvider: PrivateStateProvider;
}

export function buildProviders(config: MidnightNetworkConfig = PreprodConfig): EndpointProviders {
  const zkConfigProvider = new NodeZkConfigProvider<'increment'>(ZK_CONFIG_PATH);

  return {
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'counter-private-state',
    }),
  };
}

async function checkEndpoint(name: string, check: () => Promise<Response>): Promise<void> {
  try {
    const res = await check();
    console.log(`${name.padEnd(13)} ${res.ok ? 'OK' : `HTTP ${res.status}`}`);
  } catch (err) {
    console.log(`${name.padEnd(13)} UNREACHABLE (${(err as Error).message})`);
  }
}

export async function checkEndpoints(config: MidnightNetworkConfig = PreprodConfig): Promise<void> {
  await checkEndpoint('Indexer', () =>
    fetch(config.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height hash } }' }),
    }),
  );

  await checkEndpoint('Node RPC', () =>
    fetch(config.node, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }),
    }),
  );

  await checkEndpoint('Proof server', () => fetch(new URL('/health', config.proofServer)));
}

async function main(): Promise<void> {
  console.log(`Network ID:   ${getNetworkId()}`);
  console.log(`Indexer:      ${PreprodConfig.indexer}`);
  console.log(`Indexer WS:   ${PreprodConfig.indexerWS}`);
  console.log(`Node RPC:     ${PreprodConfig.node}`);
  console.log(`Proof server: ${PreprodConfig.proofServer}`);
  console.log();

  await checkEndpoints();
  buildProviders();
  console.log('\nProviders configured for preprod.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
