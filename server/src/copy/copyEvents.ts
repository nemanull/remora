import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { CollectorStats } from '@remora/sdk';
import { Observable, Subject } from 'rxjs';
import type { BookName } from './types';

export type CopyEvent =
  | {
      type: 'decision';
      book: BookName;
      decisionId: bigint;
      wallet: string;
      coin: string;
      action: string;
      verdict: 'COPY' | 'SKIP';
      reason: string;
      decidedAt: Date;
    }
  | {
      type: 'order';
      book: BookName;
      orderId: bigint;
      cloid: string;
      coin: string;
      purpose: string;
      status: string;
      error: string | null;
    }
  | {
      type: 'copy';
      book: BookName;
      positionId: bigint;
      wallet: string;
      coin: string;
      change: 'opened' | 'resized' | 'closed';
      size: string;
      realizedPnl: string;
    }
  | {
      type: 'collector';
      clusterId: number;
      change: 'connected' | 'disconnected' | 'heartbeat' | 'assigned';
      stats: CollectorStats | null;
    }
  | {
      type: 'leader';
      wallet: string;
      status: string;
      isPaused: boolean;
      reason: string | null;
    }
  | {
      type: 'killSwitch';
      book: BookName;
      active: boolean;
      reason: string | null;
    }
  | {
      type: 'alert';
      code: string;
      message: string;
      wallet: string | null;
      clusterId: number | null;
    };

@Injectable()
export class CopyEvents implements OnModuleDestroy {
  private readonly subject = new Subject<CopyEvent>();
  readonly events$: Observable<CopyEvent> = this.subject.asObservable();

  publish(event: CopyEvent): void {
    this.subject.next(event);
  }

  onModuleDestroy(): void {
    this.subject.complete();
  }
}
