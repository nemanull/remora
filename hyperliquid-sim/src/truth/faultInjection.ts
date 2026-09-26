type TimedFault = { until: number; ip: string | null };

export type RestFault = { status: number | null; delayMs: number };

function appliesTo(fault: TimedFault | null, ip: string, now: number): boolean {
  return (
    fault !== null &&
    now < fault.until &&
    (fault.ip === null || fault.ip === ip)
  );
}

export class FaultInjection {
  private stall: TimedFault | null = null;
  private restStatus: (TimedFault & { status: number }) | null = null;
  private restDelay: (TimedFault & { delayMs: number }) | null = null;

  stallPushes(durationMs: number, ip: string | null, now: number): void {
    this.stall = { until: now + durationMs, ip };
  }

  answerRestWith(
    status: number,
    durationMs: number,
    ip: string | null,
    now: number,
  ): void {
    this.restStatus = { until: now + durationMs, ip, status };
  }

  delayRest(
    delayMs: number,
    durationMs: number,
    ip: string | null,
    now: number,
  ): void {
    this.restDelay = { until: now + durationMs, ip, delayMs };
  }

  clear(): void {
    this.stall = null;
    this.restStatus = null;
    this.restDelay = null;
  }

  isStalled(ip: string, now: number): boolean {
    return appliesTo(this.stall, ip, now);
  }

  readRestFault(ip: string, now: number): RestFault {
    return {
      status: appliesTo(this.restStatus, ip, now)
        ? (this.restStatus?.status ?? null)
        : null,
      delayMs: appliesTo(this.restDelay, ip, now)
        ? (this.restDelay?.delayMs ?? 0)
        : 0,
    };
  }
}
