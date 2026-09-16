import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { ValidationError } from "class-validator";

export interface FormattedValidationError {
  field: string;
  constraints: Record<string, string>;
  messages: string[];
  children?: FormattedValidationError[];
}

export function formatValidationErrors(
  errors: ValidationError[],
): FormattedValidationError[] {
  return errors.map((err) => {
    const constraints = err.constraints ? Object.values(err.constraints) : [];
    const children =
      err.children && err.children.length > 0
        ? formatValidationErrors(err.children)
        : undefined;
    return {
      field: err.property,
      constraints: err.constraints || {},
      messages: constraints,
      ...(children ? { children } : {}),
    };
  });
}

export function extractAllMessages(
  formattedErrors: FormattedValidationError[],
): string[] {
  const messages: string[] = [];
  for (const err of formattedErrors) {
    messages.push(...err.messages);
    if (err.children) {
      messages.push(...extractAllMessages(err.children));
    }
  }
  return messages;
}

/**
 * Factory creating the globally configured ValidationPipe for trellis-api.
 * Enforces:
 * - Property whitelisting (whitelist: true)
 * - Automatic payload transformation (transform: true)
 * - Structured HTTP 400 Bad Request exception responses with detailed field error messages
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    exceptionFactory: (errors: ValidationError[]) => {
      const formattedErrors = formatValidationErrors(errors);
      const allMessages = extractAllMessages(formattedErrors);
      return new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: allMessages.length > 0 ? allMessages : "Validation failed",
        errors: formattedErrors,
      });
    },
  });
}
