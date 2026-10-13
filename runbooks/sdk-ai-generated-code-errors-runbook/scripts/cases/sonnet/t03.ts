// deps: @midnight-ntwrk/midnight-js-contracts@3.0.0, @midnight-ntwrk/compact-js@2.0.0, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/midnight-js-types@3.0.0, @midnight-ntwrk/midnight-js-node-zk-config-provider@3.0.0, @midnight-ntwrk/midnight-js-network-id@3.0.0, tsx@4.19.0, typescript@5.6.3
import path from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import * as Counter from './contract/out/contract/index.cjs';
import { configureProviders, counterPrivateStateId } from './t02';
import { buildWallet } from './wallet';

const compiledContract = CompiledContract.make('counter', Counter.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(path.resolve(process.cwd(), 'contract', 'out')),
);

const { wallet, shieldedSecretKeys, dustSecretKey, keystore } = await buildWallet(process.env.WALLET_SEED!);
const providers = await configureProviders(wallet, shieldedSecretKeys, dustSecretKey, keystore);

const deployed = await deployContract(providers, {
  compiledContract,
  privateStateId: counterPrivateStateId,
  initialPrivateState: {},
});

console.log('Contract deployed at:', deployed.deployTxData.public.contractAddress);
process.exit(0);
