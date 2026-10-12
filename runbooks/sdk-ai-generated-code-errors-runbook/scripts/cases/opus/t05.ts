// deps: @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/compact-runtime@0.11.0, rxjs@7.8.2, ws@8.18.3
//
// t05: Subscribe to the counter contract's ledger state and log every change.
// Read-only: only the indexer-backed public data provider is needed (no wallet).
//
// Run: CONTRACT_ADDRESS=<hex> npx tsx t05.ts

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-types';

import * as Counter from './contract/out/contract/index.js';

// The indexer subscription runs over GraphQL-WS, which needs a global WebSocket in Node.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const INDEXER = `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const INDEXER_WS = `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;

async function main(): Promise<void> {
  const contractAddress = process.env.CONTRACT_ADDRESS as ContractAddress | undefined;
  if (!contractAddress) throw new Error('Set CONTRACT_ADDRESS');

  setNetworkId('preprod');

  const publicDataProvider = indexerPublicDataProvider(INDEXER, INDEXER_WS);

  // Print the current value first so there is a baseline.
  const initial = await publicDataProvider.queryContractState(contractAddress);
  if (initial == null) throw new Error(`No contract deployed at ${contractAddress}`);
  console.log(`[${new Date().toISOString()}] initial round = ${Counter.ledger(initial.data).round}`);

  // Stream every subsequent contract state update from the indexer.
  const subscription = publicDataProvider
    .contractStateObservable(contractAddress, { type: 'latest' })
    .pipe(
      Rx.map((contractState) => Counter.ledger(contractState.data)),
      Rx.distinctUntilChanged((a, b) => a.round === b.round),
    )
    .subscribe({
      next: (ledgerState) => {
        console.log(`[${new Date().toISOString()}] round = ${ledgerState.round}`);
      },
      error: (err) => {
        console.error('Ledger subscription failed:', err);
        process.exit(1);
      },
      complete: () => console.log('Ledger subscription completed'),
    });

  const shutdown = () => {
    console.log('Unsubscribing...');
    subscription.unsubscribe();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`Watching ledger of ${contractAddress} (Ctrl+C to stop)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
