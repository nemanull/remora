import { Module } from '@nestjs/common';
import { BooksModule } from '../books/books.module';
import { ExecutionModule } from '../execution/execution.module';
import { CopyDecisionService } from './copyDecision.service';

@Module({
  imports: [BooksModule, ExecutionModule],
  providers: [CopyDecisionService],
  exports: [CopyDecisionService],
})
export class CopyModule {}
