// deps: @midnight-ntwrk/wallet@4.0.0, @midnight-ntwrk/wallet-sdk-address-format@1.0.0, @midnight-ntwrk/ledger@4.0.0, @midnight-ntwrk/zswap@4.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, rxjs@7.8.1, ws@8.18.0
import { WebSocket } from 'ws';
import { WalletBuilder } from '@midnight-ntwrk/wallet';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { filter, firstValueFrom } from 'rxjs';

(globalThis as any).WebSocket = WebSocket;

const PREPROD = {
  networkId: 'preprod',
  indexerUri: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWsUri: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://localhost:6300',
};

// 1 NIGHT = 1_000_000 STAR
const AMOUNT_STAR = 5n * 1_000_000n;

async function main(): Promise<void> {
  const seedHex = process.env.WALLET_SEED_HEX ?? '';
  const recipient = process.env.RECIPIENT_ADDRESS ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('WALLET_SEED_HEX must be a 32-byte hex seed');
  if (!recipient) throw new Error('RECIPIENT_ADDRESS must be set to a Midnight unshielded address');

  setNetworkId(PREPROD.networkId);
  const wallet = await WalletBuilder.buildFromSeed(PREPROD, seedHex);
  await wallet.start();

  try {
    const state = await firstValueFrom(wallet.state().pipe(filter((s) => s.syncProgress?.synced === true)));
    const nightType = state.unshielded.nightTokenType;
    const available = state.unshielded.balances[nightType] ?? 0n;
    if (available < AMOUNT_STAR) {
      throw new Error(`Insufficient tNIGHT: have ${available} STAR, need ${AMOUNT_STAR} STAR`);
    }

    console.log(`Sending 5 tNIGHT to ${recipient}...`);
    const recipe = await wallet.transferTransaction(
      [
        {
          type: 'unshielded',
          outputs: [{ receiverAddress: recipient, amount: AMOUNT_STAR, type: nightType }],
        },
      ],
      state.unshielded.secretKey,
    );

    const finalized = await wallet.finalizeRecipe(recipe);
    const txId = await wallet.submitTransaction(finalized);
    console.log('Transfer submitted, transaction id:', txId);

    // Wait for the indexer to confirm the transaction.
    await firstValueFrom(
      wallet.state().pipe(
        filter((s) => s.unshielded.transactionHistory.some((t) => t.id === txId && t.status === 'confirmed')),
      ),
    );
    console.log('Transfer confirmed.');
  } finally {
    await wallet.close();
  }
}

main().catch((err) => {
  console.error('Transfer failed:', err);
  process.exit(1);
});
