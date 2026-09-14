import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { instanceSettings, users, workspaces } from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { newId } from '../lib/ids.js';
import { configuredAuthMethods, type AuthMethod } from '../lib/authMethods.js';

// AT8 (ROAD-143). The one instance_settings row and the operator who owns
// it. Spec: docs/design/self-hosted-auth-and-multitenancy.md §4 (with the
// AT8 amendment: setup is gated on INSTANCE_SETUP_TOKEN, not on a sign-in
// that doesn't exist until AT9).
//
// Cloud runs this exact code: our row is provisioned before any customer
// reaches the URL, so setupRequired is always false there and nobody
// outside our own ops ever completes setup. Same code, different data.

export const INSTANCE_ROW_ID = 'instance';

export type SignupMode = 'open' | 'invite_only';

export type SetupStatus = {
  setupRequired: boolean;
  // Present once setup is done — what the desktop renders in the sign-in
  // card's header and which buttons it shows. Before setup, the wizard
  // needs authMethods too (to refuse an unsignable instance up front).
  instanceName: string | null;
  authMethods: AuthMethod[];
  signupMode: SignupMode | null;
};

export async function getSetupStatus(env: NodeJS.ProcessEnv = process.env): Promise<SetupStatus> {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, INSTANCE_ROW_ID));
  return {
    setupRequired: !row,
    instanceName: row?.instanceName ?? null,
    authMethods: configuredAuthMethods(env),
    signupMode: (row?.signupMode as SignupMode | undefined) ?? null,
  };
}

export type CompleteSetupInput = {
  instanceName: string;
  signupMode: SignupMode;
  admin: { email: string; fullName: string };
};

export async function completeSetup(input: CompleteSetupInput, env: NodeJS.ProcessEnv = process.env) {
  // Refuse to produce an instance nobody can sign into. Checked here, not
  // only in the wizard's UI, because the wizard is one client of this.
  const methods = configuredAuthMethods(env);
  if (methods.length === 0) {
    throw new ValidationError(
      'No sign-in method is configured. Set GITHUB_OAUTH_CLIENT_ID/SECRET, GOOGLE_OAUTH_CLIENT_ID/SECRET, or SMTP_HOST/SMTP_FROM before completing setup.',
    );
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: instanceSettings.id }).from(instanceSettings).where(eq(instanceSettings.id, INSTANCE_ROW_ID));
    if (existing) throw new ConflictError('This instance is already set up');

    // The operator's users row starts *unverified* — the same shape as the
    // desktop's first-launch local profile. The first sign-in (AT9) with
    // this email links and verifies it; until then it's a claim the
    // compose-file holder made, which is exactly the trust boundary the
    // setup token represents.
    const [admin] = await tx
      .insert(users)
      .values({
        id: newId('user'),
        email: input.admin.email,
        fullName: input.admin.fullName,
        // A placeholder until AT9's sign-in records how they actually
        // signed in — but an honest one: the first method this instance
        // offers, never 'email' on an instance with no SMTP.
        authMethod: methods[0],
        emailVerifiedAt: null,
        isInstanceAdmin: true,
      })
      .returning();

    // The primary key is the real guard against a concurrent second setup
    // — the select above is for a clean 409 in the ordinary case; two
    // racing requests get one 409 from the unique violation instead.
    const [instance] = await tx
      .insert(instanceSettings)
      .values({
        id: INSTANCE_ROW_ID,
        instanceName: input.instanceName,
        signupMode: input.signupMode,
        setupCompletedAt: new Date(),
      })
      .returning();

    return { instance, admin };
  });
}

export async function getInstance() {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, INSTANCE_ROW_ID));
  if (!row) throw new NotFoundError('instance settings (setup not completed)');
  const [[w], [u]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(workspaces),
    db.select({ n: sql<number>`count(*)::int` }).from(users),
  ]);
  return { ...row, counts: { workspaces: w.n, users: u.n } };
}

export type UpdateInstanceInput = Partial<{ instanceName: string; signupMode: SignupMode }>;

export async function updateInstance(patch: UpdateInstanceInput) {
  const [row] = await db
    .update(instanceSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(instanceSettings.id, INSTANCE_ROW_ID))
    .returning();
  if (!row) throw new NotFoundError('instance settings (setup not completed)');
  return row;
}
