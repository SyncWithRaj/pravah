import { Module } from '@nestjs/common';
import { MetadataService } from './metadata.service';
import {
  MetadataController,
  InternalMetadataController,
} from './metadata.controller';

@Module({
  controllers: [MetadataController, InternalMetadataController],
  providers: [MetadataService],
  exports: [MetadataService],
})
export class MetadataModule {}
