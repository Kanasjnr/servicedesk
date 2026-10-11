// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/compact-js@2.3.0, @midnight-ntwrk/compact-runtime@0.11.0, @midnight-ntwrk/ledger-v7@7.0.0, @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-hd@3.0.0, @midnight-ntwrk/wallet-sdk-shielded@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-dust-wallet@1.0.0, rxjs@7.8.2, ws@8.18.3
//
// t02: Configure every midnight-js provider needed to use the compiled
// counter contract (./contract/out) from Node.js.
//
//   publicDataProvider   -> indexer (GraphQL HTTP + WS)
//   proofProvider        -> proof server over HTTP
//   zkConfigProvider     -> prover/verifier keys + ZKIR from ./contract/out
//   privateStateProvider -> LevelDB on disk
//   walletProvider       -> WalletFacade (balancing + signing)
//   midnightProvider     -> WalletFacade (submission to the node)

import path from 'node:path';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type {
  FinalizedTransaction,
  ImpureCircuitId,
  MidnightProvider,
  MidnightProviders,
  UnboundTransaction,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

import * as Counter from './contract/out/contract/index.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

// ---------------------------------------------------------------------------
// Network + contract configuration
// ---------------------------------------------------------------------------

export const config = {
  indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `https://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://127.0.0.1:6300',
  zkConfigPath: path.resolve(process.cwd(), 'contract', 'out'),
  privateStateStoreName: 'counter-private-state',
} as const;

setNetworkId('preprod');

// ---------------------------------------------------------------------------
// Contract typing
// ---------------------------------------------------------------------------

export type CounterPrivateState = Record<string, never>;
export const CounterPrivateStateId = 'counterPrivateState' as const;
export type CounterContract = Counter.Contract<CounterPrivateState>;
export type CounterCircuits = ImpureCircuitId<CounterContract>;
export type CounterProviders = MidnightProviders<
  CounterCircuits,
  typeof CounterPrivateStateId,
  CounterPrivateState
>;

export const counterCompiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(config.zkConfigPath),
);

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

export async function buildWallet(seedHex: string): Promise<WalletContext> {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
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
    indexerClientConnection: { indexerHttpUrl: config.indexer, indexerWsUrl: config.indexerWS },
    provingServerUrl: new URL(config.proofServer),
    relayURL: new URL(config.node.replace(/^http/, 'ws')),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };

  const wallet = new WalletFacade(
    ShieldedWallet(walletConfig).startWithSecretKeys(shieldedSecretKeys),
    UnshieldedWallet(walletConfig).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    DustWallet(walletConfig).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  );
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

// ---------------------------------------------------------------------------
// Wallet + Midnight provider (one object implements both interfaces)
// ---------------------------------------------------------------------------

export async function createWalletAndMidnightProvider(
  ctx: WalletContext,
): Promise<WalletProvider & MidnightProvider> {
  const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await ctx.wallet.signRecipe(recipe, (payload) =>
        ctx.unshieldedKeystore.signData(payload),
      );
      return ctx.wallet.finalizeRecipe(signed);
    },
    submitTx(tx: FinalizedTransaction) {
      return ctx.wallet.submitTransaction(tx);
    },
  };
}

// ---------------------------------------------------------------------------
// All providers
// ---------------------------------------------------------------------------

export async function configureProviders(ctx: WalletContext): Promise<CounterProviders> {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(ctx);
  const zkConfigProvider = new NodeZkConfigProvider<CounterCircuits>(config.zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider<typeof CounterPrivateStateId>({
      privateStateStoreName: config.privateStateStoreName,
      walletProvider: walletAndMidnightProvider,
      privateStoragePasswordProvider: async () =>
        process.env.PRIVATE_STATE_PASSWORD ?? 'change-me-to-a-strong-password',
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = process.env.MIDNIGHT_SEED;
  if (!seed) throw new Error('Set MIDNIGHT_SEED');
  const ctx = await buildWallet(seed);
  const providers = await configureProviders(ctx);
  console.log('Providers ready:', Object.keys(providers).join(', '));
  await ctx.wallet.stop();
}
