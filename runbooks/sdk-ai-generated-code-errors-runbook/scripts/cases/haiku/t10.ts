// deps: @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export interface MidnightEndpoints {
  networkId: 'preprod';
  indexer: {
    http: string;
    ws: string;
  };
  nodeRpc: string;
  proofServer: string;
}

// Public preprod endpoints. The proof server is expected to run locally (Docker, port 6300).
export const PREPROD_ENDPOINTS: MidnightEndpoints = {
  networkId: 'preprod',
  indexer: {
    http: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
    ws: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  },
  nodeRpc: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://localhost:6300',
};

export function configureNetwork(endpoints: MidnightEndpoints = PREPROD_ENDPOINTS): MidnightEndpoints {
  setNetworkId(endpoints.networkId);

  const active = getNetworkId();
  if (active !== endpoints.networkId) {
    throw new Error(`Network mismatch: expected ${endpoints.networkId}, got ${active}`);
  }

  for (const [label, url] of [
    ['indexer HTTP', endpoints.indexer.http],
    ['indexer WS', endpoints.indexer.ws],
    ['node RPC', endpoints.nodeRpc],
    ['proof server', endpoints.proofServer],
  ] as const) {
    if (!url) throw new Error(`Missing endpoint: ${label}`);
  }

  return endpoints;
}

// Allow overriding individual endpoints via environment variables, e.g. for a local devnet.
export function endpointsFromEnv(env: NodeJS.ProcessEnv = process.env): MidnightEndpoints {
  return {
    networkId: 'preprod',
    indexer: {
      http: env.MIDNIGHT_INDEXER_HTTP ?? PREPROD_ENDPOINTS.indexer.http,
      ws: env.MIDNIGHT_INDEXER_WS ?? PREPROD_ENDPOINTS.indexer.ws,
    },
    nodeRpc: env.MIDNIGHT_NODE_RPC ?? PREPROD_ENDPOINTS.nodeRpc,
    proofServer: env.MIDNIGHT_PROOF_SERVER ?? PREPROD_ENDPOINTS.proofServer,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const endpoints = configureNetwork(endpointsFromEnv());
  console.log(JSON.stringify(endpoints, null, 2));
}
