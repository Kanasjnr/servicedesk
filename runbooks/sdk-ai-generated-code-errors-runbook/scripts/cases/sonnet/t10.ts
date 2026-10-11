// deps: @midnight-ntwrk/midnight-js-network-id@3.0.0, typescript@5.6.3
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export const NETWORK_ID = 'preprod';

export const preprodConfig = {
  networkId: NETWORK_ID,
  indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `https://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  nodeWS: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://127.0.0.1:6300',
} as const;

setNetworkId(preprodConfig.networkId);

console.log('Network id:', getNetworkId());
console.log('Indexer:', preprodConfig.indexer);
console.log('Node RPC:', preprodConfig.node);
console.log('Proof server:', preprodConfig.proofServer);
