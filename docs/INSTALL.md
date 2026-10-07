# Installing a prerelease

castellan is not on npm yet. Prereleases are tagged in git (`v0.1.0-alpha.N`) and each tag has a
GitHub release with `pnpm pack` tarballs of the three packages.

## From the release tarballs (recommended)

Download the tarballs from the release page, put them in your repo (e.g. `vendor/castellan/`), and
depend on them by path:

```json
{
  "dependencies": {
    "@castellan/core": "file:vendor/castellan/castellan-core-0.1.0-alpha.0.tgz",
    "@castellan/typeorm": "file:vendor/castellan/castellan-typeorm-0.1.0-alpha.0.tgz",
    "casbin": "^5.27.0"
  }
}
```

With the GitHub CLI:

```bash
gh release download v0.1.0-alpha.0 --repo lvlrSajjad/castellan --dir vendor/castellan
```

## Building the tarballs yourself

```bash
git clone https://github.com/lvlrSajjad/castellan && cd castellan
git checkout v0.1.0-alpha.0
pnpm install && pnpm build && pnpm pack:all   # writes dist-packs/*.tgz
```

## Requirements

Node.js ≥ 22, `casbin` ^5.27, TypeORM 0.3.20+ or 1.x, NestJS 10–12 (for `@castellan/nestjs`).
