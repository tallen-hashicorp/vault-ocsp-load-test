#!/usr/bin/env node
/**
 * Vault PKI issuance throughput load test
 *
 * Usage:
 *   VAULT_TOKEN=s.xxxx node vault-issue-loadtest.js \
 *     --url http://127.0.0.1:8200 \
 *     --mount pki_int \
 *     --role example-dot-com \
 *     --cn localhost \
 *     --duration 120 \
 *     --concurrency 10
 *
 * Notes:
 * - Requires Node 18+ (built-in fetch).
 * - Prints steady-state and peak issuance rates, plus latency percentiles.
 */

const { performance } = require("perf_hooks");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function nowMs() {
  return performance.now();
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

async function main() {
  const args = parseArgs(process.argv);

  const vaultToken = process.env.VAULT_TOKEN;
  if (!vaultToken) {
    console.error("Missing VAULT_TOKEN env var.");
    process.exit(1);
  }

  const baseUrl = (args.url || "http://127.0.0.1:8200").replace(/\/+$/, "");
  const mount = args.mount || "pki_int";
  const role = args.role || "example-dot-com";
  const cn = args.cn || "localhost";

  const durationSec = toInt(args.duration, 120);       // test duration
  const concurrency = toInt(args.concurrency, 10);     // concurrent workers
  const timeoutMs = toInt(args.timeout_ms, 10000);     // per-request timeout

  const endpoint = `${baseUrl}/v1/${mount}/issue/${role}`;

  console.log("Vault PKI Issuance Load Test");
  console.log(`Endpoint:     ${endpoint}`);
  console.log(`CN:           ${cn}`);
  console.log(`Duration:     ${durationSec}s`);
  console.log(`Concurrency:  ${concurrency}`);
  console.log(`Timeout:      ${timeoutMs}ms`);
  console.log("");

  const stopAt = Date.now() + durationSec * 1000;

  // Metrics
  let ok = 0;
  let fail = 0;
  const latenciesMs = [];
  const perSecond = new Map(); // secondEpoch -> count

  function incSecond() {
    const s = Math.floor(Date.now() / 1000);
    perSecond.set(s, (perSecond.get(s) || 0) + 1);
  }

  async function issueOnce(workerId) {
    // Simple payload; add alt_names/ip_sans if needed.
    const body = JSON.stringify({ common_name: cn });

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const t0 = nowMs();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "X-Vault-Token": vaultToken,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      const t1 = nowMs();
      const dt = t1 - t0;

      if (!res.ok) {
        fail++;
        // Drain body for reuse of connection
        try { await res.text(); } catch (_) {}
        return;
      }

      // Drain response quickly without parsing to reduce overhead
      // (Parsing JSON adds some overhead; throughput tests often skip it.)
      try { await res.arrayBuffer(); } catch (_) {}

      ok++;
      latenciesMs.push(dt);
      incSecond();
    } catch (e) {
      fail++;
    } finally {
      clearTimeout(t);
    }
  }

  async function workerLoop(workerId) {
    while (Date.now() < stopAt) {
      await issueOnce(workerId);
    }
  }

  const wallStart = nowMs();
  const workers = Array.from({ length: concurrency }, (_, i) => workerLoop(i));
  await Promise.all(workers);
  const wallEnd = nowMs();

  const total = ok + fail;
  const wallSeconds = (wallEnd - wallStart) / 1000;

  latenciesMs.sort((a, b) => a - b);

  const p50 = percentile(latenciesMs, 50);
  const p95 = percentile(latenciesMs, 95);
  const p99 = percentile(latenciesMs, 99);
  const max = latenciesMs.length ? latenciesMs[latenciesMs.length - 1] : null;

  // Compute peak per-second issuance rate (OK only)
  let peakRps = 0;
  for (const [, count] of perSecond.entries()) peakRps = Math.max(peakRps, count);

  const steadyRps = ok / wallSeconds;
  const steadyPerHour = steadyRps * 3600;

  console.log("Results");
  console.log("-------");
  console.log(`Total requests:     ${total}`);
  console.log(`Successful issues:  ${ok}`);
  console.log(`Failed:            ${fail}`);
  console.log(`Wall time:         ${wallSeconds.toFixed(2)}s`);
  console.log("");
  console.log(`Steady-state rate:  ${steadyRps.toFixed(2)} certs/sec (${steadyPerHour.toFixed(0)} certs/hour)`);
  console.log(`Peak 1s rate:       ${peakRps} certs/sec`);
  console.log("");
  if (p50 != null) {
    console.log("Latency (successful)");
    console.log(`p50: ${p50.toFixed(1)} ms`);
    console.log(`p95: ${p95.toFixed(1)} ms`);
    console.log(`p99: ${p99.toFixed(1)} ms`);
    console.log(`max: ${max.toFixed(1)} ms`);
  } else {
    console.log("No successful requests; no latency stats.");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});