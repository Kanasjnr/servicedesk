// deps: @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/compact-runtime@0.9.0, rxjs@7.8.1, ws@8.18.0, tsx@4.19.0, typescript@5.6.3
import { WebSocket } from 'ws';
import { map, distinctUntilChanged } from 'rxjs';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as Counter from './contract/out/contract/index.cjs';

// @ts-expect-error GraphQL subscriptions need a WebSocket implementation in Node
globalThis.WebSocket = WebSocket;
setNetworkId('preprod');

const contractAddress = process.argv[2];
if (!contractAddress) throw new Error('Usage: tsx t05.ts <contractAddress>');

const publicDataProvider = indexerPublicDataProvider(
  `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
);

const subscription = publicDataProvider
  .contractStateObservable(contractAddress, { type: 'latest' })
  .pipe(
    map((state) => Counter.ledger(state.data).round),
    distinctUntilChanged(),
  )
  .subscribe({
    next: (round) => console.log(`[${new Date().toISOString()}] round =`, round.toString()),
    error: (err) => console.error('Subscription error:', err),
  });

process.on('SIGINT', () => {
  subscription.unsubscribe();
  process.exit(0);
});
