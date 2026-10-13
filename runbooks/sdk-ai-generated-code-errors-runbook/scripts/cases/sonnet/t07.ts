// deps: @midnight-ntwrk/wallet-sdk-facade@1.0.0, @midnight-ntwrk/wallet-sdk-unshielded-wallet@1.0.0, @midnight-ntwrk/ledger-v7@7.0.0, rxjs@7.8.1, tsx@4.19.0, typescript@5.6.3
import * as Rx from 'rxjs';
import { buildWallet } from './wallet';

const { wallet, dustSecretKey, keystore } = await buildWallet(process.env.WALLET_SEED!);

const synced = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

const dustBalance = synced.dust.walletBalance(new Date());
if (dustBalance > 0n) {
  console.log('DUST already available:', dustBalance.toString());
} else {
  const nightUtxos = synced.unshielded.availableCoins.filter((c) => c.meta.registeredForDustGeneration === false);
  if (nightUtxos.length === 0 && synced.dust.availableCoins.length === 0) {
    throw new Error('No unshielded NIGHT UTXOs to register. Fund the wallet from the preprod faucet first.');
  }

  console.log(`Registering ${nightUtxos.length} NIGHT UTXO(s) for DUST generation...`);
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    nightUtxos,
    keystore.getPublicKey(),
    (payload) => keystore.signData(payload),
  );
  const finalized = await wallet.finalizeRecipe(recipe);
  const txId = await wallet.submitTransaction(finalized);
  console.log('Registration submitted:', txId);
}

console.log('Waiting for DUST...');
const withDust = await Rx.firstValueFrom(
  wallet.state().pipe(
    Rx.throttleTime(5_000),
    Rx.filter((s) => s.isSynced),
    Rx.filter((s) => s.dust.walletBalance(new Date()) > 0n),
  ),
);
console.log('DUST available:', withDust.dust.walletBalance(new Date()).toString());

await wallet.stop();
