// deps: @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/wallet-sdk-address-format@1.0.0, @midnight-ntwrk/ledger@4.0.0, @midnight-ntwrk/zswap@4.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, rxjs@7.8.1, ws@8.18.0
import { WebSocket } from 'ws';
import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { filter, firstValueFrom } from 'rxjs';

// The Node runtime needs a WebSocket implementation for the indexer subscription.
(globalThis as any).WebSocket = WebSocket;

const seedHex = process.env.WALLET_SEED_HEX ?? '';
if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
  throw new Error('WALLET_SEED_HEX must be a 32-byte hex seed');
}

const PREPROD = {
  networkId: 'preprod',
  indexerUri: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWsUri: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://localhost:6300',
};

async function main(): Promise<void> {
  setNetworkId(PREPROD.networkId);

  const wallet = await WalletBuilder.buildFromSeed(PREPROD, seedHex);
  await wallet.start();

  try {
    // Wait for the indexer to catch up to the chain tip before reading balances.
    const state = await firstValueFrom(
      wallet.state().pipe(filter((s) => s.syncProgress?.synced === true)),
    );

    const nightBalance = state.unshielded.balances[state.unshielded.nightTokenType] ?? 0n;
    const dustBalance = state.dust.balance(new Date());

    console.log('Unshielded address:', state.unshielded.address);
    console.log(`NIGHT balance: ${nightBalance} STAR (${Number(nightBalance) / 1_000_000} NIGHT)`);
    console.log(`DUST balance:  ${dustBalance} SPECK`);
  } finally {
    await wallet.close();
  }
}

main().catch((err) => {
  console.error('Failed to read wallet balances:', err);
  process.exit(1);
});
