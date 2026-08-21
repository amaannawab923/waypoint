import { customAlphabet } from 'nanoid';

// Same "prefix-xxxxxxx" style ids as the old mock (see mock/db.ts's newId),
// so seeded/demo ids stay human-readable and match what already exists in
// any localStorage snapshot a user might compare against during migration.
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const generate = customAlphabet(alphabet, 7);

export function newId(prefix: string): string {
  return `${prefix}-${generate()}`;
}
