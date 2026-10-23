import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../../core/auth/auth.module";
import { EventDeadLetterController } from "./event-dead-letter.controller";
import { EventDeadLetterService } from "./event-dead-letter.service";

/**
 * Dead-letter recovery for failed domain-event handlers (issue #354).
 *
 * Exposes `EventDeadLetterService` so event producers can register handlers and
 * dispatch envelopes, and so operator tooling can replay or discard failures.
 */
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [EventDeadLetterController],
  providers: [EventDeadLetterService],
  exports: [EventDeadLetterService],
})
export class EventDeadLetterModule {}
