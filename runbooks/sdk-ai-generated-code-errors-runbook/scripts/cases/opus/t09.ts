// deps: @midnight-ntwrk/compact-runtime@0.9.0, vitest@3.2.4
//
// Unit test for the counter contract's `increment()` circuit.
// Runs the compiled contract entirely in-process: no node, indexer or proof server.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  type CircuitContext,
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, type Ledger } from './contract/out/contract/index.js';

// The counter contract has no witnesses, so its private state is empty.
type CounterPrivateState = Record<string, never>;

const COIN_PUBLIC_KEY = '0'.repeat(64);

class CounterSimulator {
  readonly contract: Contract<CounterPrivateState>;
  circuitContext: CircuitContext<CounterPrivateState>;

  constructor() {
    this.contract = new Contract<CounterPrivateState>({});

    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      this.contract.initialState(createConstructorContext({}, COIN_PUBLIC_KEY));

    this.circuitContext = createCircuitContext(
      sampleContractAddress(),
      currentZswapLocalState,
      currentContractState,
      currentPrivateState,
    );
  }

  getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  getPrivateState(): CounterPrivateState {
    return this.circuitContext.currentPrivateState;
  }

  increment(): Ledger {
    const result = this.contract.impureCircuits.increment(this.circuitContext);
    this.circuitContext = result.context;
    return this.getLedger();
  }
}

describe('Counter contract: increment()', () => {
  let sim: CounterSimulator;

  beforeEach(() => {
    sim = new CounterSimulator();
  });

  it('initialises round to 0', () => {
    expect(sim.getLedger().round).toEqual(0n);
  });

  it('increments round by 1', () => {
    const state = sim.increment();
    expect(state.round).toEqual(1n);
  });

  it('accumulates across multiple calls', () => {
    for (let i = 0; i < 5; i++) {
      sim.increment();
    }
    expect(sim.getLedger().round).toEqual(5n);
  });

  it('does not change private state', () => {
    const before = sim.getPrivateState();
    sim.increment();
    expect(sim.getPrivateState()).toEqual(before);
  });

  it('produces deterministic results from the same starting state', () => {
    const a = new CounterSimulator();
    const b = new CounterSimulator();
    a.increment();
    b.increment();
    expect(a.getLedger().round).toEqual(b.getLedger().round);
  });

  it('isolates state between simulator instances', () => {
    const other = new CounterSimulator();
    sim.increment();
    sim.increment();
    expect(sim.getLedger().round).toEqual(2n);
    expect(other.getLedger().round).toEqual(0n);
  });
});
