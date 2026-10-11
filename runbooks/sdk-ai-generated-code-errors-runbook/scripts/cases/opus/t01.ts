// deps: @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-hd@3.0.0, @midnight-ntwrk/wallet-sdk-shielded@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-dust-wallet@1.0.0, @midnight-ntwrk/ledger-v7@7.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, rxjs@7.8.2, ws@8.18.3
//
// t01: Create a wallet from a hex seed on Midnight preprod, wait for sync,
// print the unshielded NIGHT balance and the DUST balance.
//
// Run: MIDNIGHT_SEED=<64-char hex> npx tsx t01.ts

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// The wallet SDK's indexer subscriptions need a global WebSocket in Node.js.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const PREPROD = {
  indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `https://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://127.0.0.1:6300',
};

const NIGHT_DECIMALS = 6; // 1 NIGHT = 1_000_000 STAR
const DUST_DECIMALS = 15; // 1 DUST = 10^15 SPECK

function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

function deriveKeys(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') {
    throw new Error('Invalid wallet seed');
  }
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') {
    throw new Error('HD key derivation failed');
  }
  hd.hdWallet.clear();
  return derived.keys;
}

async function main(): Promise<void> {
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed || !/^[0-9a-fA-F]{64}$/.test(seed)) {
    throw new Error('Set MIDNIGHT_SEED to a 32-byte hex seed');
  }

  setNetworkId('preprod');

  const keys = deriveKeys(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const walletConfig = {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: PREPROD.indexer,
      indexerWsUrl: PREPROD.indexerWS,
    },
    provingServerUrl: new URL(PREPROD.proofServer),
    relayURL: new URL(PREPROD.node.replace(/^http/, 'ws')),
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };

  const shielded = ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys);
  const unshielded = UnshieldedWallet(walletConfig).startWithPublicKey(
    PublicKey.fromKeyStore(unshieldedKeystore),
  );
  const dust = DustWallet(walletConfig).startWithSecretKey(
    dustSecretKey,
    ledger.LedgerParameters.initialParameters().dust,
  );

  const wallet = new WalletFacade(shielded, unshielded, dust);
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  console.log(`Unshielded address: ${unshieldedKeystore.getBech32Address().asString()}`);
  console.log('Syncing wallet with preprod...');

  const state: FacadeState = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((s) => {
        if (!s.isSynced) console.log('  still syncing...');
      }),
      Rx.filter((s) => s.isSynced),
    ),
  );

  const nightBalance = state.unshielded.balances[ledger.unshieldedToken().raw] ?? 0n;
  const dustBalance = state.dust.walletBalance(new Date());

  console.log('Wallet synced.');
  console.log(`Unshielded NIGHT balance: ${formatUnits(nightBalance, NIGHT_DECIMALS)} tNIGHT (${nightBalance} STAR)`);
  console.log(`DUST balance:             ${formatUnits(dustBalance, DUST_DECIMALS)} DUST (${dustBalance} SPECK)`);

  await wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
