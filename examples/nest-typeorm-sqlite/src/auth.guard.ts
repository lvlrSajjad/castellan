import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { USERS } from './users.js';

/** Fake authentication: the `x-user` header carries a user id from the in-memory directory. */
@Injectable()
export class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const id = req.headers['x-user'];
    const user = typeof id === 'string' ? USERS[id] : undefined;
    if (!user) throw new UnauthorizedException('Send an x-user header, e.g. x-user: tina');
    req.user = user;
    return true;
  }
}
