# Benchmark: <what was measured>

- **Date:** <YYYY-MM-DD>   **Commit:** <sha>   **Author:** <name>
- **Question:** <the decision this benchmark informs, e.g. "Is hybrid search fast enough at 1M chunks?">

## Setup
| Item | Value |
|---|---|
| Hardware / instance | <e.g. 4 vCPU / 16 GB, local laptop, managed DB tier> |
| Software versions | <Node 24.x, Postgres 17.x, pgvector 0.8.x, Redis 7.x> |
| Dataset | <size, shape, how generated; real or synthetic> |
| Load tool + script | <k6 / autocannon / wrk + link to script in repo> |
| Duration, concurrency, warm-up | <e.g. 5 min, 50 VUs, 1 min warm-up excluded> |

## Results
| Scenario | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | Error rate | Cost / 1k req |
|---|---|---|---|---|---|---|
| <baseline> | | | | | | |
| <variant> | | | | | | |

<Optional chart: latency over time; mark where shedding/fallback kicked in.>

## Interpretation
<What the numbers say about the question. Where the bottleneck was (CPU, DB, network, provider).>

## Threats to validity
- <e.g. synthetic data with uniform tenants; production is skewed>
- <e.g. LLM provider mocked; real latency adds 400–2000 ms>

## Raw data
<Link to the k6 summary JSON / CSV committed next to this file.>
