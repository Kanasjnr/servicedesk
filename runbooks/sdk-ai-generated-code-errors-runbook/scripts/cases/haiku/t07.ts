// deps: @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/ledger@4.0.0, @midnight-ntwrk/zswap@4.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, rxjs@7.8.1, ws@8.18.0
import { WebSocket } from 'ws';
import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { filter, firstValueFrom, map } from 'rxjs';

(globalThis as any).WebSocket = WebSocket;

const PREPROD = {
  networkId: 'preprod',
  indexerUri: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWsUri: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://localhost:6300',
};

const POLL_INTERVAL_MS = 15_000;
const TIMEOUT_MS = 30 * 60_000;

async function main(): Promise<void> {
  const seedHex = process.env.WALLET_SEED_HEX ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('WALLET_SEED_HEX must be a 32-byte hex seed');

  setNetworkId(PREPROD.networkId);
  const wallet = await WalletBuilder.buildFromSeed(PREPROD, seedHex);
  await wallet.start();

  try {
    const state = await firstValueFrom(wallet.state().pipe(filter((s) => s.syncProgress?.synced === true)));

    // Registering NIGHT UTXOs designates them to generate DUST over time.
    const registerable = state.unshielded.utxos.filter((u) => u.token === state.unshielded.nightTokenType);
    if (registerable.length === 0) throw new Error('No NIGHT UTXOs available to register');

    console.log(`Registering ${registerable.length} NIGHT UTXO(s) for DUST generation...`);
    const recipe = await wallet.registerNightUtxosForDustGeneration(registerable, state.unshielded.secretKey);
    const finalized = await wallet.finalizeRecipe(recipe);
    const txId = await wallet.submitTransaction(finalized);
    console.log('Registration submitted:', txId);

    // Poll the wallet until DUST has accrued, or give up after the timeout.
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const dust = await firstValueFrom(
        wallet.state().pipe(
          filter((s) => s.syncProgress?.synced === true),
          map((s) => s.dust.balance(new Date())),
        ),
      );
      if (dust > 0n) {
        console.log(`DUST available: ${dust} SPECK`);
        return;
      }
      console.log('DUST not yet available, waiting...');
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for DUST');
  } finally {
    await wallet.close();
  }
}

main().catch((err) => {
  console.error('DUST registration failed:', err);
  process.exit(1);
});
