import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ApiKeysService } from "./api-keys.service";
import { AllowedStrategies } from "./decorators/allowed-strategies.decorator";
import { Permission } from "src/common/guard/roles.enum";

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(["read", "write", ...Object.values(Permission)], { each: true })
  permissions?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}

@ApiTags("API keys")
@ApiBearerAuth("JWT-auth")
@Controller("auth/api-keys")
@AllowedStrategies("traditional", "oauth", "wallet")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  private owner(req: any): string {
    if (!req.user?.id || req.authType === "api-key")
      throw new UnauthorizedException(
        "An authenticated user account is required",
      );
    return req.user.id;
  }

  @Post()
  create(@Req() req: any, @Body() body: CreateApiKeyDto) {
    return this.keys.create(
      this.owner(req),
      body.name,
      body.permissions,
      body.expiresInDays,
    );
  }

  @Get()
  list(@Req() req: any) {
    return this.keys.list(this.owner(req));
  }

  @Delete(":id")
  revoke(@Req() req: any, @Param("id", ParseUUIDPipe) id: string) {
    return this.keys.revoke(this.owner(req), id);
  }
}
