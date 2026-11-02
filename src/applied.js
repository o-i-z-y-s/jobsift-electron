'use strict';

/**
 * src/applied.js
 * The roles the user says they applied to, kept in applied.json in the app data
 * folder, never in results files, and matched against roles whenever a run is
 * shown, so past and future runs both show them.
 *
 *   Saving      Each record keeps every id the posting has: JobSift's role id
 *               and the hiring system's posting key from the apply link
 *               (sources.atsUrlKey), plus the company, title, link, and date.
 *   Matching    A role matches a record when it is the same posting (same role
 *               id), the same posting found again (same posting key), the same
 *               title at the same company, or, more loosely, another title at
 *               the same company. Companies compare by connections.companyKey;
 *               titles compare lowercased, without accents, punctuation, or
 *               anything in brackets. The closest match wins, then the latest.
 *   Expiry      Records match for six months and are then removed.
 *
 * No Electron dependency, so this module can be tested directly with node.
 */

const fs   = require('fs');
const path = require('path');
const { atsUrlKey } = require('./sources');
const { companyKey } = require('./connections');

const FILE = 'applied.json';
const KEEP_MONTHS = 6;
const RANK = { posting: 0, repost: 1, title: 2, company: 3 };

/** Every id a role has: its role id and its hiring system posting key. */
function idsOf(role) {
  const ids = [role?.id, atsUrlKey(role?.apply_url || '')].filter(x => typeof x === 'string' && x);
  return [...new Set(ids)];
}

/** A title reduced for comparison: lowercase, no accents, brackets, or punctuation. */
function titleKey(title) {
  return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function cutoff(now) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - KEEP_MONTHS);
  return d.getTime();
}

function save(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
}

/** The records from the past six months. Older ones are removed from the file. */
function load(dir, now = Date.now()) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')).entries;
  } catch { return []; }
  if (!Array.isArray(entries)) return [];
  const from = cutoff(now);
  const fresh = entries.filter(e => Array.isArray(e?.ids) && Date.parse(e.applied_at) >= from);
  if (fresh.length !== entries.length) save(dir, fresh);
  return fresh;
}

/**
 * Records that the user applied to this role, or, with applied false, removes
 * every record sharing an id with it. A posting already recorded keeps its date.
 */
function setApplied(dir, role, applied, now = Date.now()) {
  const ids = idsOf(role);
  if (!ids.length) return false;
  const entries = load(dir, now);
  const shares = e => e.ids.some(id => ids.includes(id));
  if (applied) {
    const known = entries.find(shares);
    if (known) known.ids = [...new Set([...known.ids, ...ids])];
    else entries.push({
      ids,
      company:    String(role.company || ''),
      title:      String(role.role_title || ''),
      url:        String(role.apply_url || ''),
      applied_at: new Date(now).toISOString(),
    });
    save(dir, entries);
  } else {
    const kept = entries.filter(e => !shares(e));
    if (kept.length === entries.length) return true;
    save(dir, kept);
  }
  return true;
}

/**
 * The closest record for each role, keyed by role id:
 * { kind: 'posting'|'repost'|'title'|'company', applied_at, company, title }.
 * Roles matching no record are left out.
 */
function matchesFor(entries, roles) {
  const byCompany = new Map();
  for (const e of entries) {
    const k = companyKey(e.company);
    if (!k) continue;
    if (!byCompany.has(k)) byCompany.set(k, []);
    byCompany.get(k).push(e);
  }
  const byId = new Map();
  for (const e of entries) for (const id of e.ids) byId.set(id, e);

  const out = {};
  for (const role of roles) {
    if (typeof role?.id !== 'string' || !role.id) continue;
    const found = [];
    const ids = idsOf(role);
    for (const id of ids) {
      const e = byId.get(id);
      if (e) found.push({ e, kind: id === role.id && e.ids.includes(role.id) ? 'posting' : 'repost' });
    }
    const t = titleKey(role.role_title);
    for (const e of byCompany.get(companyKey(role.company)) || []) {
      found.push({ e, kind: t && titleKey(e.title) === t ? 'title' : 'company' });
    }
    if (!found.length) continue;
    found.sort((a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(b.e.applied_at) - Date.parse(a.e.applied_at));
    const { e, kind } = found[0];
    out[role.id] = { kind, applied_at: e.applied_at, company: e.company, title: e.title };
  }
  return out;
}

module.exports = { idsOf, titleKey, load, setApplied, matchesFor, KEEP_MONTHS };
