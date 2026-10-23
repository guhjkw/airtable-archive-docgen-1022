// tests/verify.js  —  node tests/verify.js
// Tests the same src/archiveEngine.js that index.html loads.
'use strict';
var A = require('../src/archiveEngine.js');
var D = require('../data/sample.json');
var passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('PASS: ' + name); } else { failed++; console.log('FAIL: ' + name); } }
function fresh() { return JSON.parse(JSON.stringify(D)); }

console.log('1. Collecting a job');
var c = A.collect(D.active, 'recS1');
check('J-2041 has 3 estimates and 5 production records', c.estimates.length === 3 && c.production.length === 5 && c.shared.length === 0);
check('a work order linked to two jobs is flagged as shared', A.collect(D.active, 'recS3').shared.length === 1);

console.log('\n2. Archiving a complete job');
var d = fresh(), r = A.archive(d.active, d.archive, 'recS1', {});
check('archive succeeds and moves 9 records', r.ok && r.moved === 9);
check('active base goes from 26 to 17 records, archive from 3 to 12', r.counts.activeBefore === 26 && r.counts.activeAfter === 17 && r.counts.archiveAfter === 12);
var arcSale = r.archive.sales.filter(function (x) { return x.sourceId === 'recS1'; })[0];
check('every archived record keeps its Source Record ID and the Project ID', r.archive.estimates.concat(r.archive.production).filter(function (x) { return x.projectId === 'J-2041'; }).every(function (x) { return /^rec/.test(x.sourceId); }));
check('estimates are re-linked to the NEW sales record, not the old one', r.archive.estimates.filter(function (x) { return x.projectId === 'J-2041'; }).every(function (x) { return x.sales[0] === arcSale.id; }));
var wo = r.archive.production.filter(function (x) { return x.workOrder === 'WO-3320'; })[0];
var est = r.archive.estimates.filter(function (x) { return x.id === wo.estimates[0]; })[0];
check('a work order still traces to its estimate line (Walnut wall paneling)', est && est.item === 'Walnut wall paneling');
check('the log records the verification step', r.log.some(function (l) { return /^Verified: counts 1\/3\/5, 13 links, none dangling/.test(l); }));
check('the original input objects are not modified', D.active.sales.length === 5 && D.archive.sales.length === 1);

console.log('\n3. Refusals');
check('job not Complete: refused', /only Complete jobs/.test(A.archive(D.active, D.archive, 'recS2', {}).reason));
check('shared work order: stopped, nothing moved', /also linked to another active job/.test(A.archive(D.active, D.archive, 'recS3', {}).reason));
check('same job twice: no duplicate in the archive', /already in the archive/.test(A.archive(D.active, r.archive, 'recS1', {}).reason));
check('archive base near its limit: refused before copying', /record limit/.test(A.archive(D.active, D.archive, 'recS1', { recordLimit: 10 }).reason));
check('unknown job: refused', /not found/.test(A.archive(D.active, D.archive, 'recX', {}).reason));

console.log('\n4. A failed write rolls everything back');
var f = A.archive(D.active, D.archive, 'recS1', { failAt: { table: 'production', n: 2 } });
check('failure at the 2nd production write: not ok, rolled back', !f.ok && f.rolledBack === true);
check('archive back to its original 3 records', A.count(f.archive) === 3);
check('active base untouched (26 records)', A.count(f.active) === 26);

console.log('\n5. Mark instead of delete');
var m = A.archive(D.active, D.archive, 'recS5', { mode: 'mark' });
check('mark mode keeps stubs in the active base, marked Archived', m.ok && A.count(m.active) === 26 && m.active.sales.filter(function (x) { return x.id === 'recS5'; })[0].archived === true);
check('each stub points at its archive copy', m.active.production.filter(function (x) { return x.id === 'recP11'; })[0].archiveId === m.map.recP11);

console.log('\n6. Schedule of Values (G703) and summary (G702)');
var s = A.scheduleOfValues(D.active, 'recS2');
check('two lines, scheduled values add up to the $96,500 contract', s.lines.length === 2 && s.totals.scheduledValue === 96500 && s.problems.length === 0);
check('kitchen cabinets: average of two work orders (60% and 20%) = 40%', s.lines[0].thisPeriod === 8100 && s.lines[0].fromPrevious === 24300);
check('materials stored added to total completed: $36,600 (45.2%)', s.lines[0].totalCompleted === 36600 && s.lines[0].pct === 45.2);
check('retainage 5% of completed and stored: $1,962.50', s.totals.retainage === 1962.5);
check('current payment due: $14,202.50', s.g702.currentPaymentDue === 14202.5);
check('balance to finish including retainage: $59,212.50', s.g702.balanceToFinish === 59212.5);
check('one sticker per work order, with a scannable code value', s.stickers.length === 3 && s.stickers[0].code === 'WO-3401|recP6');
var bad = fresh(); bad.active.estimates[3].scheduledValue = 80000;
check('scheduled values not matching the contract are flagged', /add up to 95500 but the contract sum is 96500/.test(A.scheduleOfValues(bad.active, 'recS2').problems[0]));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
