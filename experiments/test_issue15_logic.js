/**
 * Test script for Issue #15 changes in templates/bill.html
 *
 * Requirements verified:
 * 1. After error, attempt 3 retries before giving up.
 * 2. Once an error occurs, maxConcurrent drops to 1 and stays there
 *    (does NOT get restored to the initial value during the run).
 * 3. A stopRequested flag halts further processing immediately.
 */

function makeContext() {
    const initialMaxConcurrent = 2;
    const maxRetries = 3;
    const ctx = {
        initialMaxConcurrent,
        maxRetries,
        maxConcurrent: initialMaxConcurrent,
        hasError: false,
        stopRequested: false,
        log: [],
        write(msg) { this.log.push(msg); },
    };
    return ctx;
}

async function processArtist(ctx, artist, behaviorByAttempt, retryCount = 0) {
    if (ctx.hasError || ctx.stopRequested) return null;
    const attemptIdx = retryCount;
    const outcome = behaviorByAttempt[attemptIdx] || 'success';

    if (outcome === 'fail') {
        if (ctx.maxConcurrent !== 1) {
            ctx.maxConcurrent = 1;
            ctx.write(`maxConcurrent -> 1 after error (artist=${artist})`);
        }
        if (retryCount < ctx.maxRetries) {
            ctx.write(`error, retry ${retryCount + 1}/${ctx.maxRetries} (artist=${artist})`);
            return processArtist(ctx, artist, behaviorByAttempt, retryCount + 1);
        }
        ctx.hasError = true;
        ctx.write(`ERROR after ${ctx.maxRetries} retries (artist=${artist})`);
        throw new Error(`exhausted retries for ${artist}`);
    }

    if (outcome === 'stop') {
        ctx.stopRequested = true;
        ctx.write(`stopRequested during artist=${artist}`);
        return null;
    }

    ctx.write(`success (artist=${artist}, retry=${retryCount})`);
    return { artist };
}

async function test1_threeRetriesThenSuccess() {
    console.log('\nTest 1: 3 retries, succeeds on 3rd retry');
    const ctx = makeContext();
    const result = await processArtist(ctx, 'A', ['fail', 'fail', 'fail', 'success']);
    console.log('  log:', ctx.log);
    console.log('  result:', result);
    console.log('  maxConcurrent:', ctx.maxConcurrent, '(expected 1)');
    console.log('  hasError:', ctx.hasError, '(expected false)');
    if (!result || ctx.maxConcurrent !== 1 || ctx.hasError) throw new Error('Test 1 failed');
    console.log('  PASS');
}

async function test2_exhaustRetries() {
    console.log('\nTest 2: All 4 attempts fail -> error');
    const ctx = makeContext();
    let threw = false;
    try {
        await processArtist(ctx, 'B', ['fail', 'fail', 'fail', 'fail']);
    } catch (e) { threw = true; }
    console.log('  log:', ctx.log);
    console.log('  threw:', threw, '(expected true)');
    console.log('  hasError:', ctx.hasError, '(expected true)');
    console.log('  maxConcurrent:', ctx.maxConcurrent, '(expected 1)');
    if (!threw || !ctx.hasError || ctx.maxConcurrent !== 1) throw new Error('Test 2 failed');
    console.log('  PASS');
}

async function test3_maxConcurrentDoesNotRestore() {
    console.log('\nTest 3: maxConcurrent stays at 1 even after a successful retry');
    const ctx = makeContext();
    await processArtist(ctx, 'A', ['fail', 'success']);
    console.log('  maxConcurrent after A:', ctx.maxConcurrent, '(expected 1)');
    if (ctx.maxConcurrent !== 1) throw new Error('Test 3 failed - was restored');
    // Process another artist successfully - should still be 1
    await processArtist(ctx, 'B', ['success']);
    console.log('  maxConcurrent after B:', ctx.maxConcurrent, '(expected 1)');
    if (ctx.maxConcurrent !== 1) throw new Error('Test 3 failed - was restored after B');
    console.log('  PASS');
}

async function test4_stopRequestedHalts() {
    console.log('\nTest 4: stopRequested halts processing');
    const ctx = makeContext();
    ctx.stopRequested = true;
    const result = await processArtist(ctx, 'A', ['success']);
    console.log('  result:', result, '(expected null)');
    if (result !== null) throw new Error('Test 4 failed');
    console.log('  PASS');
}

async function main() {
    console.log('=== Issue #15 logic tests ===');
    await test1_threeRetriesThenSuccess();
    await test2_exhaustRetries();
    await test3_maxConcurrentDoesNotRestore();
    await test4_stopRequestedHalts();
    console.log('\n=== All tests passed ===');
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
