// deps: @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-hd@1.0.0, @midnight-ntwrk/wallet-sdk-shielded@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-dust-wallet@1.0.0, @midnight-ntwrk/ledger-v7@7.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, rxjs@7.8.1, ws@8.18.0, tsx@4.19.0, typescript@5.6.3
import { Buffer } from 'node:buffer';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// @ts-expect-error needed for GraphQL subscriptions in Node
globalThis.WebSocket = WebSocket;

setNetworkId('preprod');

const INDEXER = `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const INDEXER_WS = `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const NODE = `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const PROOF_SERVER = 'http://127.0.0.1:6300';

const seedHex = process.env.WALLET_SEED;
if (!seedHex) throw new Error('Set WALLET_SEED to a 64 character hex seed');

const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
if (hd.type !== 'seedOk') throw new Error('Invalid seed');
const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
hd.hdWallet.clear();

const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
const dustSecretKey = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], 'preprod');

const configuration = {
  networkId: 'preprod',
  costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  relayURL: new URL(NODE),
  provingServerUrl: new URL(PROOF_SERVER),
  indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
  indexerUrl: INDEXER_WS,
  txHistoryStorage: new InMemoryTransactionHistoryStorage(),
};

const wallet = await WalletFacade.init({
  configuration,
  shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
  unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
  dust: (cfg) =>
    DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
});
await wallet.start(shieldedSecretKeys, dustSecretKey);

console.log('Syncing...');
const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

const nightRaw = state.unshielded.balances[ledger.nativeToken().raw] ?? 0n;
const dust = state.dust.walletBalance(new Date());

console.log('Unshielded address:', unshieldedKeystore.getBech32Address().toString());
console.log('NIGHT balance:', nightRaw.toString(), '(atomic units, 1 NIGHT = 1_000_000)');
console.log('DUST balance:', dust.toString(), '(SPECK)');

await wallet.stop();
