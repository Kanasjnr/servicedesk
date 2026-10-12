// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/compact-js@2.0.0, @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, ws@8.18.0
import { WebSocket } from 'ws';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import path from 'node:path';
import { buildProviders, PREPROD_CONFIG } from './providers.js';
import * as CounterContract from '../contract/out/contract/index.js';

(globalThis as any).WebSocket = WebSocket;

const compiled = CompiledContract.make('counter', CounterContract.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(path.resolve(process.cwd(), 'contract/out')),
);

async function main(): Promise<void> {
  const contractAddress = process.argv[2] ?? process.env.CONTRACT_ADDRESS ?? '';
  if (!contractAddress) throw new Error('Pass the contract address as the first argument or set CONTRACT_ADDRESS');

  const seedHex = process.env.WALLET_SEED_HEX ?? '';
  setNetworkId('preprod');
  const providers = await buildProviders({ ...PREPROD_CONFIG, seedHex });

  const deployed = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiled,
    privateStateId: 'counterState',
    initialPrivateState: {},
  });

  console.log('Calling increment()...');
  const incrementTx = await deployed.callTx.increment();
  console.log('increment() submitted in transaction:', incrementTx.public.txId);
  console.log('Block height:', incrementTx.public.blockHeight);

  // Read the public ledger state through the indexer and decode it with the generated ledger() accessor.
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!contractState) throw new Error('No contract state found at the given address');

  const ledgerState = CounterContract.ledger(contractState.data);
  console.log('Ledger round value:', ledgerState.round.toString());
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to increment counter:', err);
  process.exit(1);
});
