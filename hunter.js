// hunter.js (CommonJS)
const fetch = require('node-fetch');
require('dotenv').config();

const HUNTER_KEY = process.env.HUNTER_API_KEY;
if (!HUNTER_KEY) {
  console.warn('⚠️ HUNTER_API_KEY belum diset di .env');
}

const HUNTER_BASE = 'https://api.hunter.io/v2';

async function callHunter(path, params = {}) {
  if (!HUNTER_KEY) throw new Error('Missing HUNTER_API_KEY');
  const url = new URL(`${HUNTER_BASE}${path}`);
  // append api_key
  url.searchParams.set('api_key', HUNTER_KEY);
  // append params
  for (const k of Object.keys(params)) {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, params[k]);
    }
  }
  try {
    const res = await fetch(url.toString(), { timeout: 15000 });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    if (!res.ok) {
      // include body when available
      const msg = json && json.errors ? JSON.stringify(json.errors) : (json && json.message) || text;
      return { ok: false, status: res.status, message: msg, data: json };
    }
    return { ok: true, status: res.status, data: json };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Wrappers for endpoints you asked
async function discover(params = {}) {
  // Example path: /discover
  return callHunter('/discover', params);
}

async function domainSearch(domain, params = {}) {
  return callHunter('/domain-search', { domain, ...params });
}

async function emailFinder(domain, first_name, last_name, params = {}) {
  return callHunter('/email-finder', { domain, first_name, last_name, ...params });
}

async function emailVerifier(email, params = {}) {
  return callHunter('/email-verifier', { email, ...params });
}

async function companiesFind(domain, params = {}) {
  return callHunter('/companies/find', { domain, ...params });
}

async function peopleFind(email, params = {}) {
  return callHunter('/people/find', { email, ...params });
}

async function combinedFind(email, params = {}) {
  return callHunter('/combined/find', { email, ...params });
}

// Master check that calls relevant endpoints based on input
// options = { domain, email, first_name, last_name, discoverQuery }
async function hunterCheck(options = {}) {
  const { domain, email, first_name, last_name, discoverQuery } = options;

  const tasks = [];
  if (discoverQuery || domain) {
    // call discover (if discoverQuery provided, else domain)
    tasks.push(
      (async () => ({ name: 'discover', res: await discover({ q: discoverQuery || domain }) }))()
    );
  }
  if (domain) {
    tasks.push((async () => ({ name: 'domain_search', res: await domainSearch(domain) }))());
    tasks.push((async () => ({ name: 'companies_find', res: await companiesFind(domain) }))());
  }
  if (first_name && last_name && domain) {
    tasks.push((async () => ({ name: 'email_finder', res: await emailFinder(domain, first_name, last_name) }))());
  }
  if (email) {
    tasks.push((async () => ({ name: 'email_verifier', res: await emailVerifier(email) }))());
    tasks.push((async () => ({ name: 'people_find', res: await peopleFind(email) }))());
    tasks.push((async () => ({ name: 'combined_find', res: await combinedFind(email) }))());
  }

  if (!tasks.length) {
    return { ok: false, msg: 'Nothing to check. Provide domain and/or email and/or name.' };
  }

  const settled = await Promise.allSettled(tasks);
  // format results
  const report = [];
  const raw = {};
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const { name, res } = s.value;
      raw[name] = res;
      if (!res.ok) {
        report.push(`• ${name}: ❌ (${res.status || ''}) ${res.message || res.error || JSON.stringify(res.data || res)}`);
      } else {
        // basic summarization depending on endpoint
        const data = res.data || {};
        if (name === 'domain_search') {
          const hits = data.data?.emails?.length || 0;
          report.push(`• domain_search (${options.domain}): ✅ ${hits} email(s) found.`);
        } else if (name === 'email_verifier') {
          const v = data.data || {};
          report.push(`• email_verifier (${options.email}): ✅ valid=${v.result || v.status || v.valid || 'unknown'} (score: ${v.score || '-'})`);
        } else if (name === 'email_finder') {
          const found = data.data?.email || data.data?.emails?.length || 0;
          report.push(`• email_finder (${options.first_name} ${options.last_name} @ ${options.domain}): ${found ? '✅ found' : '❌ not found'}`);
        } else if (name === 'companies_find') {
          const company = data.data?.company?.name || (data.data?.companies && data.data.companies.length ? data.data.companies[0].name : '-');
          report.push(`• companies_find (${options.domain}): ${company ? `✅ ${company}` : '❌ no company'}`);
        } else if (name === 'people_find') {
          const person = data.data?.data || data.data?.person || {};
          report.push(`• people_find (${options.email}): ${person.name || person.first_name || 'found'}`);
        } else if (name === 'combined_find') {
          report.push(`• combined_find (${options.email}): ✅ combined data returned`);
        } else if (name === 'discover') {
          report.push(`• discover (${discoverQuery || domain}): ✅ result returned`);
        } else {
          report.push(`• ${name}: ✅ success`);
        }
      }
    } else {
      // rejected
      report.push(`• task failed: ${s.reason && s.reason.message ? s.reason.message : JSON.stringify(s.reason)}`);
    }
  }

  const textReport = [
    `🔎 *Hunter.io Multi-Check Report*`,
    domain ? `Domain: ${domain}` : null,
    email ? `Email: ${email}` : null,
    (first_name && last_name) ? `Name: ${first_name} ${last_name}` : null,
    '',
    ...report
  ].filter(Boolean).join('\n');

  return { ok: true, text: textReport, raw };
}

module.exports = {
  discover,
  domainSearch,
  emailFinder,
  emailVerifier,
  companiesFind,
  peopleFind,
  combinedFind,
  hunterCheck
};
