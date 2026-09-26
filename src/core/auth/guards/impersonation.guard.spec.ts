import { ImpersonationGuard } from './impersonation.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ALLOW_IMPERSONATION_KEY } from '../decorators/allow-impersonation.decorator';

describe('ImpersonationGuard', () => {
  let guard: ImpersonationGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;
    guard = new ImpersonationGuard(reflector);
  });

  const createMockContext = (method: string, user?: any) => {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          user,
        }),
      }),
    } as unknown as ExecutionContext;
  };

  it('should allow if ALLOW_IMPERSONATION_KEY is true', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const context = createMockContext('POST', { impersonatorId: 'admin1' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow if user is not impersonating', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = createMockContext('POST', { id: 'user1' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow safe methods during impersonation', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = createMockContext('GET', { impersonatorId: 'admin1' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should block dangerous methods during impersonation', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = createMockContext('POST', { impersonatorId: 'admin1' });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
