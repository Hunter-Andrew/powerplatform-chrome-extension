// Environment classification for the production guardrail (used by the popup).
// Tags are per host and stored in chrome.storage.sync: 'prod' | 'test' | 'dev'.
// Untagged hosts are guessed from their name: anything that doesn't look like dev/test is treated as production.
const KEY = 'envTags';
const NONPROD = /(^|[^a-z])(dev|develop|development|test|tst|uat|qa|sit|sandbox|sbx|stage|staging|stg|trn|train|training|demo|poc|preprod|pre-prod|hotfix|build|ci)(\d*)($|[^a-z])/i;

export const LABELS = { prod: 'Production', test: 'Test', dev: 'Development' };

/** Guess from the org's subdomain, e.g. contoso-dev.crm.dynamics.com -> test/dev. */
export function guessEnv(host) {
  const org = String(host || '').split('.')[0];
  if (!org) return 'prod';
  const m = NONPROD.exec(org);
  if (!m) return 'prod';
  return /^(dev|develop|development|sandbox|sbx|poc|build|ci)$/i.test(m[2]) ? 'dev' : 'test';
}

export async function getTags() {
  try {
    const r = await chrome.storage.sync.get(KEY);
    return r[KEY] || {};
  } catch {
    return {};
  }
}

export async function setTag(host, tag) {
  const tags = await getTags();
  if (tag) tags[host] = tag;
  else delete tags[host];
  await chrome.storage.sync.set({ [KEY]: tags });
}

/** { host, tag: explicit tag or null, guess, effective, isProd } */
export async function classify(host) {
  const tags = await getTags();
  const tag = tags[host] || null;
  const guess = guessEnv(host);
  const effective = tag || guess;
  return { host, tag, guess, effective, isProd: effective === 'prod' };
}
