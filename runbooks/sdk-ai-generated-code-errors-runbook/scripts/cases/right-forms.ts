// The form check-sdk.mjs recommends for each mistake, typechecked against the network set
// (midnight-js 4.1.1, wallet SDK 1.2.0, compact-runtime 0.16.0, dapp-connector-api 4.0.1).
import type { MidnightProviders, ProofProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import type { FinalizedTransaction, UnprovenTransaction, CoinPublicKey, EncPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { sampleCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { type ContractAddress, createConstructorContext, createCircuitContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import type { Contract } from '@midnight-ntwrk/compact-js';
import { InMemoryTransactionHistoryStorage, mergeWalletEntries, WalletEntrySchema, WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import type { InitialAPI, ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as Counter from './contract/out/contract/index.js';

setNetworkId('preprod');

// Moved names: imported from where they live now.
export type Moved = [MidnightProviders<string>, FinalizedTransaction, UnprovenTransaction, ContractAddress];

// ImpureCircuitId → Contract.ProvableCircuitId
export type CounterCircuit = Contract.ProvableCircuitId<Counter.Contract<undefined>>;

// WalletFacade: static init with wallet factories; history storage takes a schema.
export const history = new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries);
export const makeWallet = (init: Parameters<typeof WalletFacade.init>[0]): Promise<WalletFacade> => WalletFacade.init(init);

// DUST balance: a method on the DUST wallet state, at a point in time.
export const dustNow = (state: FacadeState): bigint => state.dust.balance(new Date());
export const synced = (state: FacadeState): boolean => state.isSynced;

// levelPrivateStateProvider: the two required fields, no walletProvider.
export const privateState = levelPrivateStateProvider({
  privateStateStoreName: 'counter-private-state',
  privateStoragePasswordProvider: async () => 'a password from your secret store',
  accountId: 'the wallet address',
});

// WalletProvider: synchronous key getters (read the keys first).
export const walletProvider = (keys: { coin: CoinPublicKey; enc: EncPublicKey }, balance: (tx: UnboundTransaction, ttl?: Date) => Promise<FinalizedTransaction>): WalletProvider => ({
  getCoinPublicKey: () => keys.coin,
  getEncryptionPublicKey: () => keys.enc,
  balanceTx: balance,
});

// ProofProvider: not generic.
export type Proofs = ProofProvider;

// DApp connector 4.x: InitialAPI at window.midnight[walletId], connect() returns ConnectedAPI.
export const connect = async (walletId: string): Promise<ConnectedAPI> => {
  const initial: InitialAPI | undefined = window.midnight?.[walletId];
  if (!initial) throw new Error(`no wallet ${walletId}`);
  return initial.connect('preprod');
};

// Contract test without a network: constructor and circuit contexts, and ledger() on the ChargedState.
const contract = new Counter.Contract({});
const { currentContractState } = contract.initialState(createConstructorContext({}, sampleCoinPublicKey()));
const ctx = createCircuitContext(sampleContractAddress(), sampleCoinPublicKey(), currentContractState.data, {});
const next = contract.circuits.increment(ctx);
export const round: bigint = Counter.ledger(next.context.currentQueryContext.state).round;
