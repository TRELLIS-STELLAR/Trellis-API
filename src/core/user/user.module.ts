import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { AdminRoleController } from "./admin-role.controller";
import { RoleSeederService } from "./role-seeder.service";
import { AuthModule } from "src/core/auth/auth.module";
import { AdminTwoFactorGuard } from "src/core/auth/guards/admin-two-factor.guard";

@Module({
  imports: [TypeOrmModule.forFeature([User]), AuthModule],
  controllers: [UserController, AdminRoleController],
  providers: [UserService, RoleSeederService, AdminTwoFactorGuard],
  exports: [UserService, TypeOrmModule],
})
export class UserModule {}
