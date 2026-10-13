// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/midnight-js-http-client-proof-provider@3.0.0, @midnight-ntwrk/midnight-js-indexer-public-data-provider@3.0.0, @midnight-ntwrk/midnight-js-level-private-state-provider@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/ledger-v7@7.0.0, @midnight-ntwrk/compact-runtime@0.9.0
import path from 'node:path';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import type { UnshieldedKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import * as Rx from 'rxjs';

setNetworkId('preprod');

export type CounterCircuits = 'increment';
export const counterPrivateStateId = 'counterPrivateState';
export type CounterPrivateState = Record<string, never>;
export type CounterProviders = MidnightProviders<CounterCircuits, typeof counterPrivateStateId, CounterPrivateState>;

const config = {
  indexer: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`,
  proofServer: 'http://127.0.0.1:6300',
};

export async function configureProviders(
  wallet: WalletFacade,
  shieldedSecretKeys: ledger.ZswapSecretKeys,
  dustSecretKey: ledger.DustSecretKey,
  keystore: UnshieldedKeystore,
): Promise<CounterProviders> {
  const zkConfigPath = path.resolve(process.cwd(), 'contract', 'out');
  const zkConfigProvider = new NodeZkConfigProvider<CounterCircuits>(zkConfigPath);

  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  const walletAndMidnightProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys, dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => wallet.submitTransaction(tx),
  };

  return {
    privateStateProvider: levelPrivateStateProvider<typeof counterPrivateStateId, CounterPrivateState>({
      privateStateStoreName: 'counter-private-state',
      walletProvider: walletAndMidnightProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
}
