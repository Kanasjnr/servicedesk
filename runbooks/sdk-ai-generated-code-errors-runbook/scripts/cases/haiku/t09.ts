// deps: vitest@2.1.4, typescript@5.6.3, @midnight-ntwrk/compact-runtime@0.9.0, @midnight-ntwrk/ledger@4.0.0
import { describe, it, expect } from 'vitest';
import { createConstructorContext, createCircuitContext, emptyZswapLocalState } from '@midnight-ntwrk/compact-runtime';
import * as CounterContract from '../contract/out/contract/index.js';

const witnesses = {};

function freshState() {
  const contract = new CounterContract.Contract(witnesses);
  const constructorContext = createConstructorContext({}, '0'.repeat(64));
  const { currentPrivateState, currentContractState, currentZswapLocalState } = contract.initialState(constructorContext);
  return { contract, privateState: currentPrivateState, contractState: currentContractState, zswap: currentZswapLocalState };
}

describe('Counter.increment', () => {
  it('starts the round counter at 0', () => {
    const { contractState } = freshState();
    const ledger = CounterContract.ledger(contractState.data);
    expect(ledger.round).toBe(0n);
  });

  it('increments round by 1 on each call', () => {
    const { contract, privateState, contractState, zswap } = freshState();

    const ctx1 = createCircuitContext(
      '0'.repeat(64),
      zswap,
      contractState,
      privateState,
    );
    const first = contract.circuits.increment(ctx1);
    expect(CounterContract.ledger(first.context.currentQueryContext.state.data).round).toBe(1n);

    const ctx2 = createCircuitContext(
      '0'.repeat(64),
      first.context.currentZswapLocalState,
      first.context.currentQueryContext.state,
      first.context.currentPrivateState,
    );
    const second = contract.circuits.increment(ctx2);
    expect(CounterContract.ledger(second.context.currentQueryContext.state.data).round).toBe(2n);
  });

  it('does not change private state', () => {
    const { contract, privateState, contractState, zswap } = freshState();
    const ctx = createCircuitContext('0'.repeat(64), zswap, contractState, privateState);
    const result = contract.circuits.increment(ctx);
    expect(result.context.currentPrivateState).toEqual(privateState);
  });
});
