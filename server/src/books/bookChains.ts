import { Injectable } from '@nestjs/common';
import type { BookName } from '../copy/types';

function ignore(): void {}

@Injectable()
export class BookChains {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(book: BookName, wallet: string, task: () => Promise<T>): Promise<T> {
    const key = book === 'MAIN' ? book : `${book}:${wallet}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(ignore, ignore);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }
}
