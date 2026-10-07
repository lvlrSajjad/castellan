/** The authenticated principal. `siteIds` are the sites the user works at. */
export interface AppUser {
  id: string;
  orgId: string;
  siteIds: number[];
}

export type AppAction = 'read' | 'create' | 'update' | 'delete';

/** Fake user directory. In a real app this comes from your identity provider / JWT. */
export const USERS: Record<string, AppUser> = {
  tina: { id: 'tina', orgId: 'north', siteIds: [1] }, // technician
  sam: { id: 'sam', orgId: 'north', siteIds: [1, 2] }, // site manager
  olga: { id: 'olga', orgId: 'north', siteIds: [1, 2] }, // org admin
  tara: { id: 'tara', orgId: 'south', siteIds: [3] }, // technician
  sven: { id: 'sven', orgId: 'south', siteIds: [3] }, // site manager
};

/** Roles are assigned per organization (Casbin domain) at startup, see seed.ts. */
export const ROLE_ASSIGNMENTS: ReadonlyArray<{ userId: string; role: string; orgId: string }> = [
  { userId: 'tina', role: 'technician', orgId: 'north' },
  { userId: 'sam', role: 'site-manager', orgId: 'north' },
  { userId: 'olga', role: 'org-admin', orgId: 'north' },
  { userId: 'tara', role: 'technician', orgId: 'south' },
  { userId: 'sven', role: 'site-manager', orgId: 'south' },
];
