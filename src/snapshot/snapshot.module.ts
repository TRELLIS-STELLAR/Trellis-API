import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SearchModule } from '../search/search.module';
import { SnapshotService } from './snapshot.service';
import { SnapshotController } from './snapshot.controller';

@Module({
  imports: [ConfigModule, SearchModule],
  providers: [SnapshotService],
  controllers: [SnapshotController],
  exports: [SnapshotService],
})
export class SnapshotModule {}
