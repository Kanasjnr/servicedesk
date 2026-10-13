// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, ws@8.18.0
import { WebSocket } from 'ws';
import path from 'node:path';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { buildProviders, PREPROD_CONFIG } from './providers.js';
import * as CounterContract from '../contract/out/contract/index.js';

(globalThis as any).WebSocket = WebSocket;

const compiled = CompiledContract.make('counter', CounterContract.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(path.resolve(process.cwd(), 'contract/out')),
);

async function main(): Promise<void> {
  const seedHex = process.env.WALLET_SEED_HEX ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('WALLET_SEED_HEX must be a 32-byte hex seed');

  setNetworkId('preprod');
  const providers = await buildProviders({ ...PREPROD_CONFIG, seedHex });

  console.log('Deploying counter contract to preprod (proof generation may take a few minutes)...');

  const deployed = await deployContract(providers, {
    compiledContract: compiled,
    privateStateId: 'counterState',
    initialPrivateState: {},
  });

  const address = deployed.deployTxData.public.contractAddress;
  console.log('Contract deployed at:', address);
  console.log('Deploy transaction id:', deployed.deployTxData.public.txId);
  process.exit(0);
}

main().catch((err) => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
