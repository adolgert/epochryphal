// Core functions that read the time take a Clock, so tests can pass a fake one.

export interface Clock {
	/** Milliseconds since the epoch. */
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
