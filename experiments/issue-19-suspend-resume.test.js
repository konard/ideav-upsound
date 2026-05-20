// Experiment / reproducible test for issue #19.
//
// Verifies that, while a failed request is in its retry-with-delay window:
//   1. the parallel request that was running at the moment of failure is aborted
//      and remembered (NOT retried in parallel with the failing one);
//   2. no NEW requests are scheduled by the limiter (no competition);
//   3. after the failing request succeeds via retry, the suspended request is
//      launched.
//
// We extract the algorithm from templates/bill.html into a runnable JS module
// driven by mocked `fetch` and the global `xsrf` symbol.
//
// Run: node experiments/issue-19-suspend-resume.test.js

const assert = require('node:assert');

global.xsrf = 'xsrf-token';

// --- record every fetch invocation, simulate per-attempt outcomes ---
const fetchCalls = []; // { artist, ts, aborted, status }
function makeFetch(plan) {
  // plan: Map<artistKey, [outcome, outcome, ...]>
  //   outcome: { kind: 'ok', body, ms } | { kind: 'http', status, ms } | { kind: 'net', ms }
  const attempts = new Map();
  return function fetch(url, opts) {
    const artist = new URL(url).searchParams.get('FR_byArtist');
    const seq = attempts.get(artist) || 0;
    attempts.set(artist, seq + 1);
    const outcomes = plan.get(artist) || [{ kind: 'ok', body: '[{"Quantity":1}]', ms: 10 }];
    const outcome = outcomes[Math.min(seq, outcomes.length - 1)];
    const call = { artist, ts: Date.now(), aborted: false, outcome };
    fetchCalls.push(call);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (outcome.kind === 'ok') {
          resolve({ ok: true, status: 200, text: async () => outcome.body });
        } else if (outcome.kind === 'http') {
          resolve({ ok: false, status: outcome.status, text: async () => '' });
        } else {
          const err = new Error('network down');
          err.name = 'TypeError';
          reject(err);
        }
      }, outcome.ms);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          call.aborted = true;
          clearTimeout(timer);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };
}

// --- minimal log helper ---
const logLines = [];
function log(msg) { logLines.push(msg); }

// --- the algorithm under test (mirrors templates/bill.html) ---
async function processArtists(artList, fetchImpl) {
  const initialMaxConcurrent = 2;
  const maxRetries = 3;
  let maxConcurrent = initialMaxConcurrent;

  let completed = 0;
  let hasError = false;
  let stopRequested = false;

  const activeRequests = new Map();
  const suspendedQueue = [];
  const suspendedSet = new Set();
  let retryLock = Promise.resolve();

  async function processArtist(artist, retryCount = 0) {
    if (hasError || stopRequested) return null;
    if (suspendedSet.has(artist)) return null;

    const url = 'https://example.test/r?JSON_KV&FR_byArtist=' + artist.ArtistID;
    const controller = new AbortController();
    activeRequests.set(artist, controller);

    try {
      log(`req ${ artist.ArtistID } attempt ${ retryCount }`);
      const formData = new URLSearchParams();
      formData.append('_xsrf', global.xsrf);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${ response.status }`);
      JSON.parse(await response.text());
      activeRequests.delete(artist);
      completed++;
      log(`ok ${ artist.ArtistID }`);
      return { success: true, artist };
    } catch (error) {
      activeRequests.delete(artist);
      if (error.name === 'AbortError' || suspendedSet.has(artist)) {
        log(`suspended ${ artist.ArtistID }`);
        return null;
      }
      if (maxConcurrent !== 1) {
        maxConcurrent = 1;
        log('maxConcurrent=1');
      }
      for (const [other, otherCtrl] of activeRequests) {
        if (other === artist || suspendedSet.has(other)) continue;
        log(`abort parallel ${ other.ArtistID }`);
        suspendedSet.add(other);
        suspendedQueue.push(other);
        try { otherCtrl.abort(); } catch (_) {}
      }
      if (retryCount < maxRetries) {
        let releaseLock;
        const prev = retryLock;
        retryLock = new Promise(r => { releaseLock = r; });
        try {
          await prev;
          await new Promise(r => setTimeout(r, 50)); // shortened delay for test
          if (stopRequested) return null;
          return await processArtist(artist, retryCount + 1);
        } finally { releaseLock(); }
      }
      hasError = true;
      throw error;
    }
  }

  async function processWithLimit(items) {
    const results = [];
    const executing = [];
    for (let i = 0; i < items.length; i++) {
      if (hasError || stopRequested) break;
      await retryLock;
      if (hasError || stopRequested) break;
      const item = items[i];
      const p = processArtist(item).then(r => {
        executing.splice(executing.indexOf(p), 1);
        return r;
      });
      results.push(p);
      executing.push(p);
      if (executing.length >= maxConcurrent) await Promise.race(executing);
    }
    await Promise.all(results);
    while (suspendedQueue.length > 0 && !hasError && !stopRequested) {
      await retryLock;
      if (hasError || stopRequested) break;
      const artist = suspendedQueue.shift();
      suspendedSet.delete(artist);
      log(`resume ${ artist.ArtistID }`);
      results.push(await processArtist(artist));
    }
    return results;
  }

  return processWithLimit(artList);
}

// --- scenario ---
// Two artists start in parallel (maxConcurrent=2). A2 errors HTTP 500 once,
// then succeeds. A1's first request is slow; the moment A2 fails we expect
// A1 to be aborted+suspended. After A2's retry succeeds, A1 is launched fresh.
async function main() {
  const artists = [
    { ArtistID: 'A1', Artist: 'a1', ISRCID: 'i1', Quantity: 1 },
    { ArtistID: 'A2', Artist: 'a2', ISRCID: 'i2', Quantity: 1 },
    { ArtistID: 'A3', Artist: 'a3', ISRCID: 'i3', Quantity: 1 },
  ];
  const plan = new Map([
    ['A1', [{ kind: 'ok', body: '[{"Quantity":1}]', ms: 200 }, // first attempt: slow, will be aborted
            { kind: 'ok', body: '[{"Quantity":1}]', ms: 10 }]], // resume attempt
    ['A2', [{ kind: 'http', status: 500, ms: 10 },              // first attempt: fast 500
            { kind: 'ok',   body: '[{"Quantity":1}]', ms: 10 }]],
    ['A3', [{ kind: 'ok', body: '[{"Quantity":1}]', ms: 10 }]],
  ]);

  const t0 = Date.now();
  await processArtists(artists, makeFetch(plan));
  const elapsed = Date.now() - t0;

  // A1 must have been attempted twice (initial+aborted, then resumed).
  const a1Calls = fetchCalls.filter(c => c.artist === 'A1');
  assert.strictEqual(a1Calls.length, 2, `A1 should be invoked twice (was ${ a1Calls.length })`);
  assert.strictEqual(a1Calls[0].aborted, true, 'A1 first call must have been aborted');
  assert.strictEqual(a1Calls[1].aborted, false, 'A1 resume call must succeed');

  // A2 must have been attempted twice (initial 500, then retry success).
  const a2Calls = fetchCalls.filter(c => c.artist === 'A2');
  assert.strictEqual(a2Calls.length, 2, `A2 should be invoked twice (was ${ a2Calls.length })`);

  // A3 must be invoked AFTER A2's retry succeeds (i.e. after the retry delay).
  // It must NOT start while A2 is in retry-delay (no competition).
  const a3Start = fetchCalls.find(c => c.artist === 'A3').ts;
  const a2RetryStart = a2Calls[1].ts;
  assert.ok(a3Start >= a2RetryStart, `A3 (${ a3Start }) must start at/after A2 retry (${ a2RetryStart })`);

  // A1 resume must run AFTER A2's successful retry (the suspended queue is
  // drained at the end of processWithLimit).
  assert.ok(a1Calls[1].ts >= a2RetryStart, 'A1 resume must come after A2 retry');

  console.log('Test passed in', elapsed, 'ms');
  console.log('Trace:');
  for (const l of logLines) console.log('  ' + l);
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
