// deps: @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-hd@3.0.0, @midnight-ntwrk/wallet-sdk-shielded@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-dust-wallet@1.0.0, @midnight-ntwrk/wallet-sdk-address-format@3.0.0, @midnight-ntwrk/ledger-v6@6.1.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, rxjs@7.8.1
//
// Send 5 tNIGHT (unshielded) from a seed-derived wallet to another Midnight address.
//
// Usage:
//   WALLET_SEED=<64-hex-char seed> npx tsx t08.ts mn_addr_preprod1...

import * as ledger from '@midnight-ntwrk/ledger-v6';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import * as Rx from 'rxjs';

// 1 NIGHT = 1_000_000 STAR (6 decimals)
const STAR_PER_NIGHT = 1_000_000n;
const AMOUNT = 5n * STAR_PER_NIGHT;

const NETWORK_ID = 'preprod';
const INDEXER_HTTP = `https://midnight-preprod.blockfrost.io/api/v0?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const INDEXER_WS = `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const NODE_RPC = `wss://rpc.midnight-preprod.blockfrost.io?project_id=${process.env.BLOCKFROST_PROJECT_ID}`;
const PROOF_SERVER = 'http://127.0.0.1:6300';

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
    throw new Error('Key derivation failed');
  }
  hd.hdWallet.clear();

  return {
    shieldedSecretKeys: ledger.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]),
    dustSecretKey: ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust]),
    unshieldedKeystore: createKeystore(derived.keys[Roles.NightExternal], NETWORK_ID),
  };
}

async function buildWallet(seedHex: string) {
  const { shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = deriveKeys(seedHex);

  const indexerClientConnection = {
    indexerHttpUrl: INDEXER_HTTP,
    indexerWsUrl: INDEXER_WS,
  };

  const baseConfig = {
    networkId: NETWORK_ID,
    indexerClientConnection,
    provingServerUrl: new URL(PROOF_SERVER),
    relayURL: new URL(NODE_RPC),
  };

  const shieldedWallet = ShieldedWallet(baseConfig).startWithSecretKeys(shieldedSecretKeys);

  const unshieldedWallet = UnshieldedWallet({
    networkId: NETWORK_ID,
    indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  const dustWallet = DustWallet({
    ...baseConfig,
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
  }).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);

  const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

function validateRecipient(address: string): string {
  const parsed = MidnightBech32m.parse(address);
  // Throws if the address is not an unshielded address for this network.
  UnshieldedAddress.codec.decode(getNetworkId(), parsed);
  return address;
}

async function main(): Promise<void> {
  const seed = process.env.WALLET_SEED;
  const recipientArg = process.argv[2];

  if (!seed) throw new Error('Set WALLET_SEED to your 32-byte hex wallet seed');
  if (!recipientArg) throw new Error('Pass the recipient unshielded address as the first argument');

  setNetworkId(NETWORK_ID);
  const recipient = validateRecipient(recipientArg);

  const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = await buildWallet(seed);

  console.log('Syncing wallet...');
  const state = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((s) => s.isSynced),
    ),
  );

  const nightTokenType = ledger.unshieldedToken().raw;
  const balance = state.unshielded.balances[nightTokenType] ?? 0n;
  console.log(`Sender:  ${unshieldedKeystore.getBech32Address().asString()}`);
  console.log(`Balance: ${balance / STAR_PER_NIGHT} tNIGHT`);

  if (balance < AMOUNT) {
    throw new Error(`Insufficient tNIGHT: have ${balance} STAR, need ${AMOUNT} STAR`);
  }

  const ttl = new Date(Date.now() + 30 * 60 * 1000);

  const recipe = await wallet.transferTransaction(
    shieldedSecretKeys,
    dustSecretKey,
    [
      {
        type: 'unshielded',
        outputs: [
          {
            type: nightTokenType,
            receiverAddress: recipient,
            amount: AMOUNT,
          },
        ],
      },
    ],
    ttl,
  );

  const signedTx = await wallet.signTransaction(recipe.transaction, (payload) =>
    unshieldedKeystore.signData(payload),
  );

  const finalizedTx = await wallet.finalizeTransaction({ ...recipe, transaction: signedTx });
  const txId = await wallet.submitTransaction(finalizedTx);

  console.log(`Sent 5 tNIGHT to ${recipient}`);
  console.log(`Transaction ID: ${txId}`);

  await wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
