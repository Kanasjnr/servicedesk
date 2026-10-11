// deps: @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-hd@3.0.0, @midnight-ntwrk/wallet-sdk-shielded@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-dust-wallet@1.0.0, @midnight-ntwrk/ledger-v7@7.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, rxjs@7.8.2, ws@8.18.3
//
// t07: Register the wallet's unshielded NIGHT UTXOs for DUST generation,
// then wait until a spendable DUST balance appears.
//
// Run: MIDNIGHT_SEED=<hex> npx tsx t07.ts

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const PREPROD = {
  indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `https://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://127.0.0.1:6300',
};

const DUST_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('Set MIDNIGHT_SEED');

  setNetworkId('preprod');

  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('Invalid wallet seed');
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('HD key derivation failed');
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], getNetworkId());

  const walletConfig = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: PREPROD.indexer, indexerWsUrl: PREPROD.indexerWS },
    provingServerUrl: new URL(PREPROD.proofServer),
    relayURL: new URL(PREPROD.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };

  const wallet = new WalletFacade(
    ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys),
    UnshieldedWallet(walletConfig).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    DustWallet(walletConfig).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  );
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  console.log('Syncing wallet...');
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  const nightBalance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
  console.log(`Unshielded NIGHT: ${nightBalance} STAR`);
  if (nightBalance === 0n) {
    throw new Error(
      `No tNIGHT in ${unshieldedKeystore.getBech32Address().asString()}. Fund it from the preprod faucet first.`,
    );
  }

  // Only NIGHT UTXOs not yet designated for DUST generation.
  const unregistered = state.unshielded.availableCoins.filter(
    (coin) => coin.meta?.registeredForDustGeneration !== true,
  );

  if (unregistered.length === 0) {
    console.log('All NIGHT UTXOs are already registered for DUST generation.');
  } else {
    console.log(`Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation...`);
    const recipe = await wallet.registerNightUtxosForDustGeneration(
      unregistered,
      unshieldedKeystore.getPublicKey(),
      (payload) => unshieldedKeystore.signData(payload),
    );
    const finalized = await wallet.finalizeRecipe(recipe);
    const txId = await wallet.submitTransaction(finalized);
    console.log(`Registration submitted: ${txId}`);
  }

  console.log('Waiting for DUST to accrue...');
  const dustBalance = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.filter((s) => s.isSynced),
      Rx.map((s) => s.dust.walletBalance(new Date())),
      Rx.tap((balance) => console.log(`  DUST balance: ${balance} SPECK`)),
      Rx.filter((balance) => balance > 0n),
      Rx.timeout({
        first: DUST_WAIT_TIMEOUT_MS,
        with: () => Rx.throwError(() => new Error('Timed out waiting for DUST generation')),
      }),
    ),
  );

  console.log(`DUST available: ${dustBalance} SPECK. Wallet can now pay transaction fees.`);
  await wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
