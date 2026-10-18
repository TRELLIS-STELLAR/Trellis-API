import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OwnershipTransfer } from "./entities/ownership-transfer.entity";
import { OwnershipTransferService } from "./ownership-transfer.service";
import { OwnershipTransferController } from "./ownership-transfer.controller";

@Module({
  imports: [TypeOrmModule.forFeature([OwnershipTransfer])],
  controllers: [OwnershipTransferController],
  providers: [OwnershipTransferService],
  exports: [OwnershipTransferService],
})
export class OwnershipTransferModule {}
