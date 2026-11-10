// A clock that moves only when a test moves it.
import type { Clock } from "../../src/core/clock.ts";

export class FakeClock implements Clock {
	private ms: number;
	constructor(start: string | number = "2026-11-10T14:00:00Z") {
		this.ms = typeof start === "number" ? start : Date.parse(start);
	}
	now(): number {
		return this.ms;
	}
	advance(ms: number): void {
		this.ms += ms;
	}
	advanceMinutes(minutes: number): void {
		this.ms += minutes * 60_000;
	}
}
