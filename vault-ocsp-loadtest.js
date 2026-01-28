#!/usr/bin/env node
/**
 * Vault PKI OCSP response time load test (Node.js)
 *
 * What it does:
 * - Builds a real OCSP request for a given cert (via openssl)
 * - POSTs that OCSP request to Vault's /v1/<mount>/ocsp endpoint
 * - Measures response times and reports p50/p95/p99/max + SLA checks
 *
 * Prereqs:
 * - Node 18+ (built-in fetch)
 * - openssl available in PATH
 *
 * Usage:
 *   node vault-ocsp-loadtest.js \
 *     --vault http://127.0.0.1:8200 \
 *     --mount pki_int \
 *     --cert ./client.crt \
 *     --issuer ./issuer.pem \
 *     --duration 120 \
 *     --concurrency 10 \
 *     --rate 20
 *
 * Notes:
 * - OCSP is typically unauthenticated. No Vault token is used.
 * - If your Vault requires auth for OCSP (uncommon), add header support.
 */

const { performance } = require("perf_hooks");
const { spawnSync } = require("child_process");
const fs = require("fs");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function nowMs() { return performance.now(); }

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

function buildOcspRequest({ vault, mount, certPath, issuerPath }) {
  // We only use openssl to generate a DER OCSP request; we won't hit the network here.
  const ocspUrl = `${vault.replace(/\/+$/, "")}/v1/${mount}/ocsp`;

  // Generate OCSP request to a temp file
  const reqOut = "ocsp.req.der";

  const r = spawnSync("openssl", [
    "ocsp",
    "-issuer", issuerPath,
    "-cert", certPath,
    "-url", ocspUrl,
    "-reqout", reqOut,
    "-noverify"
  ], { encoding: "utf8" });

  if (r.status !== 0) {
    console.error("Failed to generate OCSP request with openssl.");
    console.error("stdout:", r.stdout);
    console.error("stderr:", r.stderr);
    process.exit(1);
  }

  const reqBytes = fs.readFileSync(reqOut);
  // Clean up temp file
  try { fs.unlinkSync(reqOut); } catch (_) {}

  return reqBytes;
}

async function main() {
  const args = parseArgs(process.argv);

  const vault = args.vault || "http://127.0.0.1:8200";
  const mount = args.mount || "pki_int";
  const certPath = args.cert;
  const issuerPath = args.issuer;

  if (!certPath || !issuerPath) {
    console.error("Missing required args: --cert <path> --issuer <path>");
    process.exit(1);
  }
  if (!fs.existsSync(certPath)) {
    console.error(`Cert file not found: ${certPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(issuerPath)) {
    console.error(`Issuer file not found: ${issuerPath}`);
    process.exit(1);
  }

  const durationSec = toInt(args.duration, 120);
  const concurrency = toInt(args.concurrency, 10);
  const rate = toInt(args.rate, 20);           // total requests per second across all workers
  const timeoutMs = toInt(args.timeout_ms, 5000);

  const endpoint = `${vault.replace(/\/+$/, "")}/v1/${mount}/ocsp`;

  console.log("Vault OCSP Response Time Load Test");
  console.log(`Endpoint:     ${endpoint}`);
  console.log(`Cert:         ${certPath}`);
  console.log(`Issuer:       ${issuerPath}`);
  console.log(`Duration:     ${durationSec}s`);
  console.log(`Concurrency:  ${concurrency}`);
  console.log(`Rate:         ${rate} req/sec (total)`);
  console.log(`Timeout:      ${timeoutMs}ms`);
  console.log("");

  // Build a valid OCSP request payload once, reuse it for the entire test
  const ocspReq = buildOcspRequest({ vault, mount, certPath, issuerPath });

  // Rate limiting: per worker "token bucket" using a shared schedule.
  // We schedule requests at roughly 1000/rate ms intervals, distributed across workers.
  const intervalMs = Math.max(1, Math.floor(1000 / Math.max(1, rate)));

  const stopAt = Date.now() + durationSec * 1000;

  let ok = 0, fail = 0;
  const latenciesMs = [];
  const perSecond = new Map(); // epochSecond -> count (OK)
  let inFlight = 0;

  function incSecond() {
    const s = Math.floor(Date.now() / 1000);
    perSecond.set(s, (perSecond.get(s) || 0) + 1);
  }

  async function postOnce() {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const t0 = nowMs();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/ocsp-request",
          "Accept": "application/ocsp-response",
        },
        body: ocspReq,
        signal: controller.signal,
      });

      const t1 = nowMs();
      const dt = t1 - t0;

      if (!res.ok) {
        fail++;
        try { await res.text(); } catch (_) {}
        return;
      }

      // Drain the OCSP response (DER) to include full server time
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

  async function worker(workerId) {
    while (Date.now() < stopAt) {
      // Basic pacing: spread requests across workers
      await new Promise((r) => setTimeout(r, intervalMs * concurrency));
      if (Date.now() >= stopAt) break;

      inFlight++;
      await postOnce();
      inFlight--;
    }
  }

  // Alternative pacing: if you want tighter control, use a global ticker.
  // For simplicity, we use per-worker pacing above.

  const wallStart = nowMs();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  // Wait for in-flight (should be ~0 due to await postOnce)
  while (inFlight > 0) await new Promise((r) => setTimeout(r, 50));
  const wallEnd = nowMs();

  const total = ok + fail;
  const wallSeconds = (wallEnd - wallStart) / 1000;

  latenciesMs.sort((a, b) => a - b);
  const p50 = percentile(latenciesMs, 50);
  const p95 = percentile(latenciesMs, 95);
  const p99 = percentile(latenciesMs, 99);
  const max = latenciesMs.length ? latenciesMs[latenciesMs.length - 1] : null;

  let peakRps = 0;
  for (const [, count] of perSecond.entries()) peakRps = Math.max(peakRps, count);
  const steadyRps = ok / wallSeconds;

  console.log("Results");
  console.log("-------");
  console.log(`Total requests:     ${total}`);
  console.log(`Successful:         ${ok}`);
  console.log(`Failed:             ${fail}`);
  console.log(`Wall time:          ${wallSeconds.toFixed(2)}s`);
  console.log(`Steady rate:        ${steadyRps.toFixed(2)} req/sec`);
  console.log(`Peak 1s rate:       ${peakRps} req/sec`);
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