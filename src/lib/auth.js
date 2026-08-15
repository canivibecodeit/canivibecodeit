/* Better Auth server instance. OAuth-only (Google + GitHub), users and
   sessions in the runtime DB next to the other tables.

   Config notes that are load-bearing behind Cloudflare + Railway:
   - advanced.ipAddress.ipAddressHeaders: without it the rate limiter can't
     see a client IP behind the proxy chain and collapses every visitor into
     one shared bucket (sign-in paths allow 3 requests per 10s, site-wide).
   - rateLimit.storage "database": the in-memory default resets on every
     deploy and doesn't survive container restarts.
   - accountLinking: no trusted providers and no implicit linking. Honoring a
     provider's verified-email flag to auto-link accounts is an account
     takeover vector if any provider ever mis-reports verification.
   - baseURL + secret are explicit env vars, never inferred from the request
     (X-Forwarded-Host can lie). Secure cookies keyed off the configured URL,
     not off request detection (TLS terminates upstream of the app).

   Initialization is LAZY on purpose. Middleware imports this module on every
   request; a module-scope throw or top-level await would turn any auth
   misconfig or DB blip into a site-wide outage for the ~99% anonymous
   traffic. A failed build is not cached, so auth heals when the DB does. */

import { betterAuth } from 'better-auth';
import { getOAuthState } from 'better-auth/api';
import { addToWaitlist, authDatabase, removeFromWaitlist, stackClear } from './db.js';
import { alertRob, deleteResendContact, esc, mirrorToResend, unmailable } from './mail.js';

const BASE_URL = process.env.BETTER_AUTH_URL || 'http://localhost:8095';

async function buildAuth() {
  if (process.env.DATABASE_URL && !process.env.BETTER_AUTH_SECRET) {
    // Production must never run on the library's fallback secret. Thrown here
    // (not at module scope) so only auth fails, never the site.
    throw new Error('BETTER_AUTH_SECRET is required in production');
  }

  return betterAuth({
    database: await authDatabase(),
    baseURL: BASE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    telemetry: { enabled: false },
    onAPIError: {
      // Human-facing OAuth failures (declined consent, unlinked second
      // provider) land on our styled page, not the library's bare JSON.
      errorURL: '/signin',
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      },
      github: {
        clientId: process.env.GITHUB_CLIENT_ID || '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        disableImplicitLinking: true,
      },
    },
    session: {
      // No fresh-session gate: delete-account is the only fresh-gated action
      // we expose, and the privacy page promises self-service deletion. The
      // account guards a bookmark list, not money.
      freshAge: 0,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      useSecureCookies: BASE_URL.startsWith('https'),
    },
    user: {
      additionalFields: {
        // Digest opt-in. input: false means only the server (the create hook
        // below and /api/account surfaces) may set it, never a client payload.
        newsletter: { type: 'boolean', defaultValue: false, input: false },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          // Our tables don't rely on FK cascades (SQLite doesn't enforce them
          // by default), so cascade by hand. GDPR delete means everywhere:
          // stack rows, the waitlist row, and the Resend audience contact.
          await stackClear(user.id);
          if (user.email) {
            const email = user.email.trim().toLowerCase();
            await removeFromWaitlist(email);
            const gone = await deleteResendContact(email);
            if (!gone) {
              // The account rows still get deleted; a human sweeps the mirror.
              alertRob('account delete: Resend contact removal failed', `<p>${esc(email)}</p>`);
            }
          }
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // The signup surface's checkbox rides in the signed OAuth state
            // via signIn.social({ additionalData: { newsletter: true } }).
            // Unchecked by default (UK PECR: silence is not consent).
            let newsletter = false;
            try {
              const state = await getOAuthState();
              newsletter = state?.newsletter === true;
            } catch {
              // no state (non-OAuth create): keep the default
            }
            return { data: { ...user, newsletter } };
          },
          after: async (user) => {
            if (!user.newsletter || !user.email) return;
            const email = user.email.trim().toLowerCase();
            if (unmailable(email)) return;
            // Same pipeline as every other digest signup: waitlist row is the
            // source of truth, Resend audience is a mirror, and only a NEW row
            // mirrors so an unsubscribe on Resend's side is never undone.
            try {
              if (await addToWaitlist(email, 'account')) mirrorToResend(email);
            } catch (err) {
              console.error(`digest opt-in failed for new user: ${err?.message || err}`);
            }
          },
        },
      },
    },
  });
}

let authPromise;

/* The one way to get the auth instance. Memoized; a rejected build clears
   itself so the next request retries instead of freezing the failure. */
export function getAuth() {
  if (!authPromise) {
    authPromise = buildAuth().catch((err) => {
      authPromise = null;
      throw err;
    });
  }
  return authPromise;
}
