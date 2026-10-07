import type { ExecutionContext } from '@nestjs/common';

type GqlModule = { GqlExecutionContext: { create(context: ExecutionContext): { getContext(): { req?: unknown } } } };
let gql: GqlModule | null | undefined;

/** Loads `@nestjs/graphql` if installed (optional peer dependency). */
export async function loadGraphql(): Promise<void> {
  if (gql !== undefined) return;
  const name = '@nestjs/graphql';
  gql = (await import(/* @vite-ignore */ name).catch(() => null)) as GqlModule | null;
}

/** Returns the HTTP request for HTTP (Express/Fastify) and GraphQL contexts. */
export function getRequest(context: ExecutionContext): any {
  if (context.getType<string>() === 'graphql') {
    if (!gql) throw new Error('GraphQL context detected but @nestjs/graphql is not installed');
    return gql.GqlExecutionContext.create(context).getContext().req;
  }
  return context.switchToHttp().getRequest();
}
