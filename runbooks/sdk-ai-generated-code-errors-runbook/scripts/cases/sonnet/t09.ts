// deps: vitest@2.1.8, @midnight-ntwrk/compact-runtime@0.9.0, typescript@5.6.3
// File: contract/test/counter.test.ts
import { describe, it, expect } from 'vitest';
import {
  constructorContext,
  createCircuitContext,
  sampleContractAddress,
  sampleCoinPublicKey,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../out/contract/index.cjs';

const makeContract = () => new Contract({});

function freshContext() {
  const contract = makeContract();
  const { currentPrivateState, currentContractState, currentZswapLocalState } = contract.initialState(
    constructorContext({}, sampleCoinPublicKey()),
  );
  const context = createCircuitContext(
    sampleContractAddress(),
    currentZswapLocalState.coinPublicKey,
    currentContractState.data,
    currentPrivateState,
  );
  return { contract, context };
}

describe('counter contract', () => {
  it('initialises round to zero', () => {
    const { context } = freshContext();
    expect(ledger(context.currentQueryContext.state).round).toBe(0n);
  });

  it('increment increases round by one', () => {
    const { contract, context } = freshContext();
    const result = contract.impureCircuits.increment(context);
    expect(ledger(result.context.currentQueryContext.state).round).toBe(1n);
  });

  it('increment accumulates across calls', () => {
    const { contract, context } = freshContext();
    const first = contract.impureCircuits.increment(context);
    const second = contract.impureCircuits.increment(first.context);
    const third = contract.impureCircuits.increment(second.context);
    expect(ledger(third.context.currentQueryContext.state).round).toBe(3n);
  });
});
