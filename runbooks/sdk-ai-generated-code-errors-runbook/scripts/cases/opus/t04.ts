// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/compact-js@2.3.0, @midnight-ntwrk/compact-runtime@0.11.0, @midnight-ntwrk/ledger-v7@7.0.0, @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-hd@3.0.0, @midnight-ntwrk/wallet-sdk-shielded@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-dust-wallet@1.0.0, rxjs@7.8.2, ws@8.18.3
//
// t04: Join an already-deployed counter contract by address, call increment(),
// then read the ledger's `round` value and print it.
//
// Run: MIDNIGHT_SEED=<hex> CONTRACT_ADDRESS=<hex> npx tsx t04.ts

import path from 'node:path';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type {
  ContractAddress,
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
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

import * as Counter from './contract/out/contract/index.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const config = {
  indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  node: `https://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://127.0.0.1:6300',
  zkConfigPath: path.resolve(process.cwd(), 'contract', 'out'),
};

type CounterPrivateState = Record<string, never>;
const PRIVATE_STATE_ID = 'counterPrivateState' as const;
type CounterCircuits = ImpureCircuitId<Counter.Contract<CounterPrivateState>>;
type CounterProviders = MidnightProviders<CounterCircuits, typeof PRIVATE_STATE_ID, CounterPrivateState>;

const counterCompiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(config.zkConfigPath),
);

async function readRound(providers: CounterProviders, address: ContractAddress): Promise<bigint> {
  const contractState = await providers.publicDataProvider.queryContractState(address);
  if (contractState == null) throw new Error(`No contract state found at ${address}`);
  return Counter.ledger(contractState.data).round;
}

async function main(): Promise<void> {
  const seed = process.env.MIDNIGHT_SEED;
  const contractAddress = process.env.CONTRACT_ADDRESS as ContractAddress | undefined;
  if (!seed) throw new Error('Set MIDNIGHT_SEED');
  if (!contractAddress) throw new Error('Set CONTRACT_ADDRESS');

  setNetworkId('preprod');

  // --- wallet -------------------------------------------------------------
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
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  // --- providers ----------------------------------------------------------
  const walletAndMidnightProvider: WalletProvider & MidnightProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
      const recipe = await wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys, dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await wallet.signRecipe(recipe, (payload) => unshieldedKeystore.signData(payload));
      return wallet.finalizeRecipe(signed);
    },
    submitTx: (tx: FinalizedTransaction) => wallet.submitTransaction(tx),
  };

  const zkConfigProvider = new NodeZkConfigProvider<CounterCircuits>(config.zkConfigPath);
  const providers: CounterProviders = {
    privateStateProvider: levelPrivateStateProvider<typeof PRIVATE_STATE_ID>({
      privateStateStoreName: 'counter-private-state',
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

  // --- find, call, read ---------------------------------------------------
  const counter = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: counterCompiledContract,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
  console.log(`Joined counter at ${counter.deployTxData.public.contractAddress}`);
  console.log(`round before: ${await readRound(providers, contractAddress)}`);

  console.log('Calling increment()...');
  const result = await counter.callTx.increment();
  console.log(`  txId: ${result.public.txId}  block: ${result.public.blockHeight}`);

  const round = await readRound(providers, contractAddress);
  console.log(`round after:  ${round}`);

  await wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
