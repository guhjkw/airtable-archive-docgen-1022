// src/archiveEngine.js
// The real logic behind the Airtable archive + document preview.
// index.html and tests/verify.js load THIS file. In the delivered setup the same
// steps run as an Airtable script (or a Make.com scenario) on a status change,
// and the documents are produced by a doc-gen tool from the same numbers.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArchiveEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    recordLimit: 50000,     // records allowed per base on your plan
    mode: 'delete',         // 'delete' removes from the active base, 'mark' keeps a stub marked Archived
    failAt: null            // test only: { table: 'production', n: 2 } makes the n-th write fail
  };
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function settingsOf(s) { return Object.assign(clone(DEFAULTS), s || {}); }
  function count(b) { return b.sales.length + b.estimates.length + b.production.length; }
  function r2(n) { return Math.round(n * 100) / 100; }

  // Everything that belongs to one job, plus anything that would break if it moved.
  function collect(active, jobId) {
    var sale = active.sales.filter(function (s) { return s.id === jobId; })[0];
    if (!sale) return { error: 'Job ' + jobId + ' not found in the active base' };
    var est = active.estimates.filter(function (e) { return (e.sales || []).indexOf(jobId) >= 0; });
    var estIds = est.map(function (e) { return e.id; });
    var prod = active.production.filter(function (p) {
      return (p.sales || []).indexOf(jobId) >= 0 || (p.estimates || []).some(function (id) { return estIds.indexOf(id) >= 0; });
    });
    var shared = prod.filter(function (p) { return (p.sales || []).some(function (id) { return id !== jobId; }); })
      .concat(est.filter(function (e) { return (e.sales || []).some(function (id) { return id !== jobId; }); }));
    return { sale: sale, estimates: est, production: prod, shared: shared };
  }

  // ---------- Phase 1: archive one job ----------
  // active/archive: { sales:[], estimates:[], production:[] } (Airtable-like records with link arrays)
  function archive(activeIn, archiveIn, jobId, settings) {
    var s = settingsOf(settings), active = clone(activeIn), arch = clone(archiveIn), log = [];
    var job = collect(active, jobId);
    if (job.error) return { ok: false, reason: job.error, active: active, archive: arch, log: log };
    var label = job.sale.job;
    if (job.sale.status !== 'Complete') return { ok: false, reason: label + ' is "' + job.sale.status + '", only Complete jobs are archived', active: active, archive: arch, log: log };
    if (arch.sales.some(function (x) { return x.sourceId === jobId; })) return { ok: false, reason: label + ' is already in the archive (matched by Source Record ID), nothing copied twice', active: active, archive: arch, log: log };
    if (job.shared.length) return { ok: false, reason: 'Stopped: ' + job.shared.map(function (x) { return x.workOrder || x.item; }).join(', ') + ' is also linked to another active job. Archiving would break that job, so nothing was moved and you were alerted.', active: active, archive: arch, log: log };
    var n = 1 + job.estimates.length + job.production.length;
    if (count(arch) + n > s.recordLimit) return { ok: false, reason: 'The archive base would pass its ' + s.recordLimit + '-record limit. Start a new archive base first.', active: active, archive: arch, log: log };
    log.push('Collected ' + label + ': 1 sales, ' + job.estimates.length + ' estimates, ' + job.production.length + ' production records');

    // Copy parents first, then children, re-linking by the new IDs.
    var map = {}, seq = { sales: count(arch) + 1 }, writes = { sales: 0, estimates: 0, production: 0 }, failed = null;
    function newId(prefix) { return prefix + String(seq.sales++).padStart(4, '0'); }
    function write(table, rec) {
      writes[table]++;
      if (s.failAt && s.failAt.table === table && s.failAt.n === writes[table]) { failed = table + ' write ' + writes[table]; return false; }
      arch[table].push(rec); return true;
    }
    var staged = { sales: [], estimates: [], production: [] };
    var sId = newId('arc'); map[job.sale.id] = sId;
    var sRec = Object.assign(clone(job.sale), { id: sId, sourceId: job.sale.id, projectId: label });
    if (write('sales', sRec)) staged.sales.push(sId);
    log.push('Sales copied: ' + job.sale.id + ' → ' + sId);
    job.estimates.forEach(function (e) {
      if (failed) return;
      var id = newId('arc'); map[e.id] = id;
      var rec = Object.assign(clone(e), { id: id, sourceId: e.id, projectId: label, sales: (e.sales || []).map(function (x) { return map[x]; }) });
      if (write('estimates', rec)) staged.estimates.push(id);
    });
    if (!failed) log.push('Estimates copied and re-linked to ' + sId + ': ' + job.estimates.length);
    job.production.forEach(function (p) {
      if (failed) return;
      var id = newId('arc'); map[p.id] = id;
      var rec = Object.assign(clone(p), { id: id, sourceId: p.id, projectId: label,
        sales: (p.sales || []).map(function (x) { return map[x]; }), estimates: (p.estimates || []).map(function (x) { return map[x]; }) });
      if (write('production', rec)) staged.production.push(id);
    });
    if (!failed) log.push('Production copied and re-linked: ' + job.production.length);

    // Verify before touching the active base.
    var problems = [];
    if (failed) problems.push('A write failed (' + failed + ')');
    var aSales = arch.sales.filter(function (x) { return x.projectId === label; }).length;
    var aEst = arch.estimates.filter(function (x) { return x.projectId === label; });
    var aProd = arch.production.filter(function (x) { return x.projectId === label; });
    if (aSales !== 1 || aEst.length !== job.estimates.length || aProd.length !== job.production.length) problems.push('Counts differ: archive has ' + aSales + '/' + aEst.length + '/' + aProd.length + ', expected 1/' + job.estimates.length + '/' + job.production.length);
    var archIds = {}; ['sales', 'estimates', 'production'].forEach(function (t) { arch[t].forEach(function (x) { archIds[x.id] = true; }); });
    var dangling = 0, links = 0, srcLinks = 0;
    aEst.concat(aProd).forEach(function (x) { (x.sales || []).concat(x.estimates || []).forEach(function (id) { links++; if (!id || !archIds[id]) dangling++; }); });
    job.estimates.concat(job.production).forEach(function (x) { srcLinks += (x.sales || []).length + (x.estimates || []).length; });
    if (dangling) problems.push(dangling + ' link(s) point outside the archive');
    if (!failed && links !== srcLinks) problems.push('Link count ' + links + ' does not match the original ' + srcLinks);

    if (problems.length) {
      // Roll back what was staged; the active base was never touched.
      ['sales', 'estimates', 'production'].forEach(function (t) { arch[t] = arch[t].filter(function (x) { return staged[t].indexOf(x.id) < 0; }); });
      log.push('Verification failed: ' + problems.join('; ') + '. Archive copy rolled back, active base unchanged, alert sent.');
      return { ok: false, reason: problems.join('; '), active: activeIn, archive: archiveIn, log: log, rolledBack: true };
    }
    log.push('Verified: counts 1/' + job.estimates.length + '/' + job.production.length + ', ' + links + ' links, none dangling');

    var ids = [job.sale.id].concat(job.estimates.map(function (e) { return e.id; }), job.production.map(function (p) { return p.id; }));
    if (s.mode === 'mark') {
      ['sales', 'estimates', 'production'].forEach(function (t) { active[t].forEach(function (x) { if (ids.indexOf(x.id) >= 0) { x.archived = true; x.archiveId = map[x.id]; } }); });
      log.push('Active records marked Archived with a link to their archive copy');
    } else {
      ['sales', 'estimates', 'production'].forEach(function (t) { active[t] = active[t].filter(function (x) { return ids.indexOf(x.id) < 0; }); });
      log.push('Removed ' + ids.length + ' records from the active base');
    }
    return { ok: true, active: active, archive: arch, log: log, map: map, moved: ids.length,
      counts: { activeBefore: count(activeIn), activeAfter: count(active), archiveAfter: count(arch) } };
  }

  // ---------- Phase 2: documents from record data ----------
  // AIA G703-style continuation sheet and G702-style summary for one job.
  function scheduleOfValues(base, jobId) {
    var job = collect(base, jobId);
    if (job.error) return { error: job.error };
    var ret = (+job.sale.retainagePct || 0) / 100, lines = [], problems = [];
    job.estimates.forEach(function (e, i) {
      var sv = +e.scheduledValue;
      if (!(sv >= 0)) { problems.push(e.item + ': scheduled value missing'); return; }
      var prod = job.production.filter(function (p) { return (p.estimates || []).indexOf(e.id) >= 0; });
      var pct = prod.length ? prod.reduce(function (a, p) { return a + (+p.pctComplete || 0); }, 0) / prod.length : 0;
      var prev = Math.min(+e.prevPct || 0, pct);
      var stored = prod.reduce(function (a, p) { return a + (+p.materialsStored || 0); }, 0);
      var fromPrev = r2(sv * prev / 100), done = r2(sv * pct / 100), thisPeriod = r2(done - fromPrev);
      var total = r2(done + stored);
      lines.push({ item: i + 1, description: e.item, scheduledValue: sv, fromPrevious: fromPrev, thisPeriod: thisPeriod, stored: stored,
        totalCompleted: total, pct: sv ? Math.round(total / sv * 1000) / 10 : 0, balance: r2(sv - total), retainage: r2(total * ret) });
    });
    var sum = function (k) { return r2(lines.reduce(function (a, l) { return a + l[k]; }, 0)); };
    var contract = +job.sale.contract || 0, scheduled = sum('scheduledValue'), completed = sum('totalCompleted'), retainage = sum('retainage');
    var earned = r2(completed - retainage), previous = r2(lines.reduce(function (a, l) { return a + l.fromPrevious * (1 - ret); }, 0));
    if (Math.abs(scheduled - contract) > 0.009) problems.push('Scheduled values add up to ' + scheduled + ' but the contract sum is ' + contract);
    return {
      job: job.sale.job, client: job.sale.client, project: job.sale.project, lines: lines, problems: problems,
      totals: { scheduledValue: scheduled, fromPrevious: sum('fromPrevious'), thisPeriod: sum('thisPeriod'), stored: sum('stored'), totalCompleted: completed, balance: sum('balance'), retainage: retainage },
      g702: { contractSum: contract, completedAndStored: completed, retainage: retainage, earnedLessRetainage: earned, previousCertificates: r2(previous), currentPaymentDue: r2(earned - previous), balanceToFinish: r2(contract - earned) },
      stickers: job.production.map(function (p) { return { workOrder: p.workOrder, part: p.part, job: job.sale.job, code: p.workOrder + '|' + p.id }; })
    };
  }

  return { DEFAULTS: DEFAULTS, collect: collect, archive: archive, scheduleOfValues: scheduleOfValues, count: count };
});
