// deps: @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-address-format@1.0.0, @midnight-ntwrk/ledger-v7@7.0.0, rxjs@7.8.1, tsx@4.19.0, typescript@5.6.3
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { buildWallet } from './wallet';

const receiver = process.argv[2];
if (!receiver) throw new Error('Usage: tsx t08.ts <mn_addr_preprod1...>');

const { wallet, shieldedSecretKeys, dustSecretKey, keystore } = await buildWallet(process.env.WALLET_SEED!);
await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

// 1 tNIGHT = 1_000_000 base units
const amount = 5_000_000n;

const recipe = await wallet.transferTransaction(
  [
    {
      type: 'unshielded',
      outputs: [{ type: ledger.nativeToken().raw, receiverAddress: receiver, amount }],
    },
  ],
  { shieldedSecretKeys, dustSecretKey },
  { ttl: new Date(Date.now() + 30 * 60 * 1000), payFees: true },
);

const signedRecipe = await wallet.signRecipe(recipe, (payload) => keystore.signData(payload));
const finalized = await wallet.finalizeRecipe(signedRecipe);
const txId = await wallet.submitTransaction(finalized);

console.log('Sent 5 tNIGHT. Transaction id:', txId);
await wallet.stop();
