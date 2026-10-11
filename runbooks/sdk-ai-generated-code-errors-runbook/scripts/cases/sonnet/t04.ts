// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/compact-js@2.0.0, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/midnight-js-types@3.0.0, tsx@4.19.0, typescript@5.6.3
import path from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import * as Counter from './contract/out/contract/index.cjs';
import { configureProviders, counterPrivateStateId } from './t02';
import { buildWallet } from './wallet';

const compiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(path.resolve(process.cwd(), 'contract', 'out')),
);

const contractAddress = process.argv[2];
if (!contractAddress) throw new Error('Usage: tsx t04.ts <contractAddress>');

const { wallet, shieldedSecretKeys, dustSecretKey, keystore } = await buildWallet(process.env.WALLET_SEED!);
const providers = await configureProviders(wallet, shieldedSecretKeys, dustSecretKey, keystore);

const contract = await findDeployedContract(providers, {
  contractAddress,
  compiledContract,
  privateStateId: counterPrivateStateId,
  initialPrivateState: {},
});

const tx = await contract.callTx.increment();
console.log(`increment submitted in tx ${tx.public.txId}, block ${tx.public.blockHeight}`);

const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
if (!contractState) throw new Error('Contract state not found');
const ledgerState = Counter.ledger(contractState.data);
console.log('Current round:', ledgerState.round.toString());
process.exit(0);
