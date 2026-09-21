import { Controller, type MessageEvent, Sse } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { CopyEvents } from '../copy/copyEvents';
import { toLiveEvent } from './responses';

@Controller('api/events')
export class EventsController {
  constructor(private readonly events: CopyEvents) {}

  @Sse()
  streamEvents(): Observable<MessageEvent> {
    return this.events.events$.pipe(
      map((event) => ({ data: toLiveEvent(event) })),
    );
  }
}
