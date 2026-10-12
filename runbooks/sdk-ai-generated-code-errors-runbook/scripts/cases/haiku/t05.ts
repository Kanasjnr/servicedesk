// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/compact-js@2.0.0, @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, rxjs@7.8.1, ws@8.18.0
import { WebSocket } from 'ws';
import path from 'node:path';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
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
  const contractAddress = process.argv[2] ?? process.env.CONTRACT_ADDRESS ?? '';
  if (!contractAddress) throw new Error('Pass the contract address as the first argument or set CONTRACT_ADDRESS');

  setNetworkId('preprod');
  const providers = await buildProviders({ ...PREPROD_CONFIG, seedHex: process.env.WALLET_SEED_HEX ?? '' });

  const deployed = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiled,
    privateStateId: 'counterState',
    initialPrivateState: {},
  });

  let lastRound: bigint | undefined;

  // The indexer streams a new contract state each time a transaction touches this contract.
  const subscription = providers.publicDataProvider
    .contractStateObservable(contractAddress, { type: 'all' })
    .subscribe({
      next: (state) => {
        const ledgerState = CounterContract.ledger(state.data);
        const round = ledgerState.round;
        const changed = round !== lastRound;
        console.log(
          `[${new Date().toISOString()}] block=${state.blockHeight ?? 'n/a'} ` +
            `round=${round.toString()}${changed ? ' (changed)' : ''}`,
        );
        lastRound = round;
      },
      error: (err) => {
        console.error('Subscription error:', err);
      },
    });

  console.log(`Watching ledger state of ${contractAddress}. Press Ctrl+C to stop.`);
  // Keep the deployed handle referenced so the connection stays alive for the subscription.
  void deployed;

  const shutdown = () => {
    subscription.unsubscribe();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to watch contract:', err);
  process.exit(1);
});
