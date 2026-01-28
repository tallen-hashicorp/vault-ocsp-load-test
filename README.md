# vault-ocsp-load-test

This repo contains simple load tests for HashiCorp Vault PKI, focused on:

- Certificate Issuance Throughput  
- OCSP Response Time

Everything here assumes:

- A running Vault Enterprise cluster (or single node for local testing)
- PKI already configured with an intermediate mount (`pki_int`)
- A role called `example-dot-com`
- Local testing against `127.0.0.1`

The goal is to provide practical, repeatable benchmarks for both issuance and OCSP performance.

---

## Setup Endpoints

First configure Vault to advertise issuing certs, OCSP, and CRL endpoints for the `pki_int` mount:

```bash
vault write pki_int/config/urls \
  issuing_certificates="http://127.0.0.1:8200/v1/pki_int/ca" \
  ocsp_servers="http://127.0.0.1:8200/v1/pki_int/ocsp" \
  crl_distribution_points="http://127.0.0.1:8200/v1/pki_int/crl"
```

Verify:

```bash
vault read pki_int/config/urls
```

Note: existing certificates will not update automatically — you must re-issue certificates after configuring these URLs.

---

## Test Certificate Issuance Throughput

This test measures sustained and peak certificate issuance rate.

```bash
export VAULT_TOKEN=YOUR_TOKEN

node vault-issue-loadtest.js \
  --url http://127.0.0.1:8200 \
  --mount pki_int \
  --role example-dot-com \
  --cn localhost \
  --duration 120 \
  --concurrency 10
```

Adjust:

- `duration` for longer steady-state runs  
- `concurrency` to find peak throughput  

---

### Results

Here are the results from a single Vault Enterprise 1.21.1+ent node running on an M2 Pro Mac:

```
Vault PKI Issuance Load Test
Endpoint:     http://127.0.0.1:8200/v1/pki_int/issue/example-dot-com
CN:           localhost
Duration:     120s
Concurrency:  10
Timeout:      10000ms

Results
-------
Total requests:     9576
Successful issues:  9576
Failed:            0
Wall time:         120.18s

Steady-state rate:  79.68 certs/sec (286849 certs/hour)
Peak 1s rate:       91 certs/sec

Latency (successful)
p50: 116.0 ms
p95: 222.7 ms
p99: 280.3 ms
max: 451.3 ms
```

This comfortably exceeds the target of ≥ 1,000 certificates/hour.

---

## Test OCSP Response Time

First, issue a certificate to use for OCSP testing:

```bash
export VAULT_ADDR='http://127.0.0.1:8200'
vault login

vault write -format=json pki_int/issue/example-dot-com common_name=localhost > cert.json
jq -r .data.certificate cert.json > client.crt
jq -r .data.private_key cert.json > client.key
jq -r .data.issuing_ca cert.json > issuer.pem
```

This produces:

- `client.crt` – leaf certificate  
- `client.key` – private key (not used for OCSP)  
- `issuer.pem` – issuing CA certificate  

Then run the OCSP load test:

```bash
export VAULT_TOKEN=YOUR_TOKEN

node vault-ocsp-loadtest.js \
  --vault http://127.0.0.1:8200 \
  --mount pki_int \
  --cert ./client.crt \
  --issuer ./issuer.pem \
  --duration 120 \
  --concurrency 10 \
  --rate 20
```

You can increase `rate` and `concurrency` to find saturation limits.

---

### Results

Here are the results from a single Vault 1.21.1+ent node running on an M2 Pro Mac:

```
Vault OCSP Response Time Load Test
Endpoint:     http://127.0.0.1:8200/v1/pki_int/ocsp
Cert:         ./client.crt
Issuer:       ./issuer.pem
Duration:     120s
Concurrency:  10
Rate:         20 req/sec (total)
Timeout:      5000ms

Results
-------
Total requests:     2330
Successful:         2330
Failed:             0
Wall time:          120.47s
Steady rate:        19.34 req/sec
Peak 1s rate:       20 req/sec

Latency (successful)
p50: 11.8 ms
p95: 23.7 ms
p99: 33.2 ms
max: 53.2 ms
```