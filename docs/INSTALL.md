# Installing a prerelease

Prereleases are published to npm under the `next` dist-tag (`0.1.0-alpha.N`):

```bash
pnpm add @castellanjs/core@next @castellanjs/typeorm@next casbin
# NestJS module, optional:
pnpm add @castellanjs/nestjs@next
```

Pin the exact version in production while castellan is in alpha (`"@castellanjs/core": "0.1.0-alpha.1"`).

## Tarballs

Each `v*` tag also has a GitHub release with `pnpm pack` tarballs, for installs without npm access:

```bash
gh release download v0.1.0-alpha.1 --repo lvlrSajjad/castellan --dir vendor/castellan
```

```json
{
  "dependencies": {
    "@castellanjs/core": "file:vendor/castellan/castellanjs-core-0.1.0-alpha.1.tgz",
    "@castellanjs/typeorm": "file:vendor/castellan/castellanjs-typeorm-0.1.0-alpha.1.tgz",
    "casbin": "^5.27.0"
  }
}
```

`v0.1.0-alpha.0` was only released as tarballs, under the old `@castellan/*` names.

## Requirements

Node.js ≥ 22, `casbin` ^5.27, TypeORM 0.3.20+ or 1.x, NestJS 10–12 (for `@castellanjs/nestjs`).
