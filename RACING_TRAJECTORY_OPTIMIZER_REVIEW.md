# Racing trajectory optimizer review

Date: 2026-08-18

## Executive result

Confidence: high for the measured performance and implementation findings; moderate for the proposed next-stage speedups.

The optimizer was not GPU-bound in its original steady-state loop. At the measured baseline, one normal generation spent about 6-8 ms in the GPU proxy and 1,178-1,188 ms in serial CPU binary64 checks. The GPU accounted for less than 1% of that generation. The main limit was not continuous certification. It was the high-fidelity JavaScript evaluator used inside every generation.

The accepted changes make the GPU proxy population control the evolutionary update, enlarge the GPU population from 2,048 to 8,192 candidates, reduce routine binary64 promotions, add smooth trust-region pattern moves, and perform only one final curvature certification. The final deterministic Silver Delta run produced:

- certified lap: **26.492584069 s**;
- discovery time: **173.084 s**;
- curvature conversion and polishing: **64.976 s**;
- complete Playwright wall time: **263.3 s**;
- certificate: pass on 8,192 edges;
- minimum containment bound: **0.934236 m**;
- maximum dynamics utilization: **0.999979762**;
- speed fixed-point residual: **5.46e-9**;
- 4,096-to-8,192 mesh lap-time delta: **9.34 ms**.

The requested sub-26 s result was not reached. The best retained implementation is 0.493 s above that target. A rejected 256-batch smoothing experiment reached about 26.445 s in 8.2 minutes, then plateaued. This shows that a longer run alone is a poor route to sub-26 s.

The user's statement that a sub-26 s trajectory exists was not independently proved in this review because no certified reference trajectory was present in the repository.

## Scope, assumptions, and success criteria

Assumptions:

1. The Fourier backbone must remain the discovery representation.
2. A result counts only after the independent intrinsic-curvature certificate passes.
3. Proxy candidate rate and certified full-lap rate are different quantities.
4. The existing track and vehicle settings define the benchmark. They were not relaxed.
5. A change is accepted only when deterministic Silver Delta benchmarks and correctness tests support it.

Success criteria used in this work:

1. Identify the measured CPU, GPU, finalization, and certification costs.
2. Preserve structural closure and final feasibility.
3. Improve time-to-lap, not only raw proxy throughput.
4. Keep proxy and binary64 score domains separate inside population ranking.
5. Reject changes that increase complexity without a measured benefit.

## Benchmark evidence

All Silver Delta results below use seed `0x12345678:0x9abcdef0` and stable Chrome WebGPU on the local machine.

| Configuration | Batches | Discovery | Complete wall | Certified lap | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| Original measured implementation | 8 | about 30 s search plus tails | 56.2 s | 30.895 s | Baseline |
| Original 64-batch path with repeated certification | 64 | 77.7 s | 4.6 min | 27.462 s | Superseded |
| Accepted implementation | 64 | 68.611 s | 159.2 s | 27.121165 s | Pass |
| Accepted implementation | 128 | 173.084 s | 263.3 s | **26.492584 s** | Final result |
| Residual-smoothing research branch | 256 | plateaued after about batch 128 | 8.2 min | about 26.445 s | Rejected |

The 128-batch run evaluated at least 1,056,768 main-population candidates. Its average main-population rate was about 6,100 candidates/s over discovery, before adding pattern candidates. This is an end-to-end rate, not a kernel-only rate.

The last fine pattern generation took 2,159 ms:

| Phase | Time | Share |
| --- | ---: | ---: |
| Candidate generation and packing | 169 ms | 7.8% |
| Main GPU proxy | 341 ms | 15.8% |
| CPU truth checks | 506 ms | 23.4% |
| Pattern screening and truth checks | 1,144 ms | 53.0% |

A fine generation without pattern search is therefore about 1.02 s. In such a generation, the main GPU phase is about one third of wall time. In a pattern generation, CPU work again dominates.

At 1,024 stations, the main GPU proxy processes 8,192 candidates in about 0.341 s. This is about 24,000 complete proxy laps/s or 24.6 million candidate-stations/s. At early low-resolution levels, measured GPU phases of 14-32 ms imply about 256,000-585,000 proxy candidates/s. The user's estimate of about 500,000 candidates/s is plausible only for the low-resolution proxy. It is not a high-fidelity or certified-lap rate.

## Mathematical audit

### 1. Discovery representation

Confidence: high.

The lateral displacement is decoded as

```text
d(u) = m + h tanh(z(u)),
```

where `m` is the corridor midpoint and `h` is its half-width. The latent field is

```text
z(u) = F(u) a + (B(u) - F(u) G) b.
```

`F` is the low-frequency real Fourier basis. `B` is the periodic quintic B-spline basis. `G` projects each spline column onto the Fourier subspace. The residual is therefore orthogonal to the Fourier backbone under the construction quadrature.

This design has useful structural properties:

- periodic closure is built into the discovery variables;
- the Fourier block controls the global shape;
- the residual block adds local high-pass corrections;
- `tanh` keeps the centerline displacement inside the safe scalar corridor;
- the derivative chain through `tanh` is implemented consistently through second order in WGSL and through higher orders in the CPU path.

For the reference curve `c(u)` and normal `n(u)`, the racing line is

```text
r(u) = c(u) + d(u)n(u).
```

The evaluator uses

```text
r'  = c' + d'n + dn'
r'' = c'' + d''n + 2d'n' + dn''
kappa = cross(r', r'') / |r'|^3.
```

The formulas and dimensions are correct. The main mathematical risk is not the representation. It is the fidelity gap between the two evaluators.

### 2. Vehicle dynamics and lap-time solve

Confidence: high.

The state is squared speed `q = v^2`. The lateral speed cap includes aerodynamic load:

```text
load(q) = 1 + gamma q
|kappa| q <= ay0 load(q).
```

The longitudinal tire remainder is obtained from the acceleration superellipse. Drag is removed from positive traction and added to braking. The lap-time quadrature is

```text
T = sum 2 ds_i / (sqrt(q_i) + sqrt(q_(i+1))).
```

The CPU reference starts at lateral caps and applies forward and backward reach constraints. Each reach uses an implicit midpoint equation with 28 bisection iterations. The cyclic solve permits up to 256 sweeps and stops when relative change is below `1e-8`.

The update is monotone: each step can only reduce `q`. Subject to monotone reach functions, it converges from the cap envelope to the greatest feasible fixed point. This is the correct maximum-speed solution on the fixed sampled path. The final certificate checks the remaining active-limit residual.

### 3. Final intrinsic-curvature representation

Confidence: high.

Discovery closure does not make an arbitrary curvature field close. The final representation must satisfy three nonlocal constraints:

```text
integral kappa ds = 2 pi w
integral cos(theta) ds = 0
integral sin(theta) ds = 0.
```

The curvature projector solves these conditions before acceptance. Certification projects again, measures closure at 16,384 samples, evaluates geometry and dynamics on 2,048, 4,096, and 8,192 meshes, and reports an 8,192-node profile. The final measured physical closure residual was `9.36e-12`.

### 4. Why high-frequency tuning becomes slow

Confidence: high for the diagnosis; moderate for the best next optimizer.

The late-stage behavior is expected. A Fourier displacement perturbation at mode `k` has derivatives that grow as `k` and `k^2`. Curvature is dominated by second derivatives. A coefficient step of equal magnitude therefore becomes much more severe as frequency grows. Feasible steps should scale roughly as `k^-2`.

The existing mutation schedule already applies this `k^-2` scaling. Residual mutation also scales with control spacing squared. The remaining problem is coordination. Independent high-frequency changes often create a fast local correction plus a compensating ripple or a new active containment violation. A random diagonal mutation must discover several signed corrections at once.

The accepted pattern search addresses this without replacing the Fourier backbone:

1. Probe both signs of each active Fourier direction.
2. Probe local raised-cosine arc moves at 120, 60, 30, and 15 m supports.
3. Compensate the Fourier projection so each residual move is physically local.
4. Fit a bounded one-dimensional quadratic from each symmetric pair.
5. Retain feasible one-sided moves at active constraints.
6. Combine compatible spectral and local directions at trust scales 0.25, 0.5, and 1.
7. Send only proxy improvements and combined moves to binary64 evaluation.

This turns part of the delicate fine tuning into a small derivative-free block step. It is more sample-efficient than waiting for one random candidate to contain every required correction.

## Computational audit

### 1. GPU utilization

Confidence: high for process-level utilization; unknown for shader-core occupancy.

The browser benchmark does not expose reliable vendor utilization counters. Therefore this review cannot claim a measured shader-core occupancy percentage. It can measure how much wall time is inside the GPU submission and readback phase.

The original optimizer did not keep the process predominantly GPU-resident. The proxy kernel completed quickly, then the GPU waited while one JavaScript worker evaluated 32 binary64 candidates serially. At the original measured point, CPU truth consumed about 98% of a normal generation.

The accepted loop improves this balance, but it is still not fully GPU-resident:

- early levels: GPU proxy is fast and CPU truth dominates;
- finest normal level: GPU proxy is about 34% of generation time;
- finest pattern level: CPU truth and pattern work dominate;
- final curvature conversion and polish: CPU-only, about 65 s;
- final certificate: CPU binary64 worker, about 25 s.

The GPU is doing real work. The application is not falling back to a CPU proxy. The issue is Amdahl's law around the GPU work.

### 2. GPU kernel structure

Confidence: high.

The geometry kernel maps one invocation to one `(candidate, station)` pair. This gives millions of independent geometry invocations at fine resolution. Coefficients are stored coefficient-major, so adjacent candidate invocations read adjacent values.

The reduction kernel maps one invocation to one candidate. That invocation performs eight complete forward/backward speed sweeps and then one reduction over all stations. The outer candidate dimension is parallel, but the station scan for each candidate is serial.

At the finest level, the principal buffers are:

- station geometry: `8192 * 1024 * 16` bytes = **128 MiB**;
- station violation: 32 MiB;
- speed profile: 32 MiB;
- basis and coefficient buffers in addition.

The geometry buffer alone reaches the WebGPU minimum guaranteed `maxStorageBufferBindingSize` of 128 MiB. A direct population increase beyond 8,192 at 1,024 stations is not portable and is not the next useful optimization.

### 3. Dense residual basis cost

Confidence: high.

The quintic B-spline is locally supported on six controls, but the stored hybrid basis table is dense. The orthogonal projection term makes every residual column appear at every station. The WGSL geometry kernel therefore loops over every Fourier and residual coefficient for every candidate-station pair.

The expression can be factored:

```text
z(u) = F(u)(a - G b) + B_local(u)b.
```

This reduces the station loop from all residual controls to the Fourier block plus six local spline controls. It is the largest clear GPU-kernel opportunity at the finest level.

A research implementation of this factorization reduced the measured fine GPU phase from about 47 ms to 8-11 ms in an earlier smaller-population configuration, but it changed candidate scores and ranks even for a Fourier-only check. It was rejected and removed. The likely problem is an unsafe producer/consumer storage layout or a numerical/compiler interaction, not the algebra. This optimization must not be retried without a score-equivalence gate and separate non-aliasing buffers.

### 4. CPU truth path

Confidence: high.

One binary64 evaluation does more work than one GPU proxy:

- it evaluates both nodes and midpoints;
- it evaluates higher curvature derivatives;
- it checks midpoint containment and progress;
- it includes both curvature-rate and curvature-second-derivative regularization;
- it solves implicit reach with 28 bisection iterations;
- it performs up to 256 cyclic sweeps instead of a fixed eight;
- it computes speed optimality and jerk metrics.

These checks are valid, but they are serial across promoted candidates. At the finest level, eight routine truth checks still take about 506 ms. The original 32 checks took about 1.18 s at its active mesh. A CPU worker pool or a higher-fidelity GPU gate can reduce this term directly.

### 5. Proxy/truth mismatch

Confidence: high.

The GPU proxy is a screening objective, not a float32 version of the CPU objective:

| Feature | GPU proxy | CPU truth |
| --- | --- | --- |
| Geometry samples | Nodes | Nodes and midpoints |
| Speed reach | Explicit endpoint | Implicit midpoint |
| Cyclic sweeps | Fixed 8 | Up to 256 to tolerance |
| Curvature regularizer | First difference of curvature | `kappaL` and `kappaLL` |
| Accumulation | float32 | binary64 with compensated sums |
| Continuous containment | No | Final certificate only |

This gap makes proxy top-k recall more important than raw candidate count. The repository specification requires CPU/GPU equivalence checks, but the current test suite has no random candidate rank-equivalence harness. This is the main missing performance-safety test.

### 6. Synchronization and host overhead

Confidence: high.

Each generation currently:

1. creates and packs a new float32 coefficient array in JavaScript;
2. uploads it;
3. submits geometry and reduction;
4. copies all results to a map-readable buffer;
5. waits on `mapAsync`;
6. starts CPU truth work only after the GPU has become idle.

The explicit readback is necessary for selection, but it prevents overlap. Candidate generation alone is about 169 ms at the finest level. The coefficient upload is also larger than needed for local refinements.

Pattern scoring has another inefficiency: `scoreGpu` is bound to the 8,192-candidate main resolution, so a few hundred pattern probes still dispatch 8,192 slots. An exact-size pattern buffer was tested. It preserved the result but did not change the 1.15 s pattern phase or total discovery time because pattern CPU truth checks dominate. The extra branch was removed.

### 7. Finalization and certification tail

Confidence: high.

The final 128-batch run spent 173.1 s in discovery, then another 65.0 s in curvature conversion/polish and about 25 s in certification and UI handoff. The last two terms are almost independent of the population-loop speed. A tenfold faster proxy would reduce the measured 263 s wall time to no less than about 107 s unless these tails also change.

Repeated live and discovery-elite certifications previously made the tail much worse. The accepted implementation publishes one canonical curvature finalist and performs one authoritative certificate.

### 8. Checkpoint path

Confidence: high.

The optimizer serializes a stopped checkpoint, and IndexedDB has get/put/delete checkpoint functions. The main thread still starts every run with `checkpoint: null` and does not persist the `stopped` event checkpoint. The README statement that a stopped run resumes fine-level search is therefore not true for the current UI path. Wiring this path would not improve a fresh-run benchmark, but it would materially improve practical time-to-solution across sessions.

## Accepted implementation changes

1. Increased the GPU topology from 8 x 256 to **8 x 1,024** candidates.
2. Kept the 128 MiB fine geometry buffer within the portable WebGPU storage-binding limit.
3. Made the complete GPU population control the evolutionary update.
4. Kept binary64 scores authoritative only for the global incumbent and retained archive.
5. Reduced routine truth promotions to two per island before the finest level and one per island at the finest level.
6. Rotated exploratory truth checks so a one-check budget does not always promote only proxy leaders.
7. Reduced the truth mesh floor from 512 to 256 while retaining basis-dependent resolution bounds.
8. Added phase telemetry for generation, GPU proxy, CPU truth, pattern search, canonicalization, and bookkeeping.
9. Added symmetric quadratic spectral/local pattern combinations and active-boundary one-sided moves.
10. Increased fine pattern frequency from every eight generations to every two.
11. Reduced the expensive curvature finalizer to one discovery source, 16 local probes, and two full reranks per pass.
12. Removed repeated live/discovery certification and retained one final intrinsic-curvature certificate.
13. Restored a full provisional discovery preview every 30 seconds without adding it to the certification queue. The preview drives the trajectory, lap metrics, profile charts, vehicle, and Run playback.

## Rejected research branches

| Experiment | Measured result | Reason for rejection |
| --- | --- | --- |
| 16 islands x 512 candidates | 27.171 s at 64 batches; about 998 ms CPU truth | More island truth overhead; no lap benefit |
| 64 Fourier modes | 28.994 s at 64 batches | Worse conditioning and slower convergence |
| Whole-spectrum curvature finalizer | 26.959 s at 64 batches; 136.5 s finalization | Twice the finalizer cost |
| Residual diffusion/smoothing island | 26.445 s at 256 batches in 8.2 min | Small gain, late plateau, failed time goal |
| Alternate Philox seeds | 27.136 s and 27.208 s at 64 batches | No deterministic improvement |
| Chord-derived structural seed | 27.123 s at 64 batches | Better initial seed, no final benefit |
| Compact/local WGSL basis | Large kernel speedup but changed ranks | Failed numerical equivalence |
| Exact-size pattern GPU dispatch | Same 27.121165 s and same 68.6 s discovery | CPU pattern evaluation dominated |

## Path to a defensible sub-26 s result

The next work should not start with a larger random population. It should improve fidelity, parallel truth throughput, and late-stage coordination in this order.

### Priority 0: build the proxy rank contract

For random and local candidates at every hierarchy level, record:

- feasibility confusion matrix;
- maximum and RMS geometry error;
- lap-time bias;
- Spearman or Kendall rank correlation;
- top-8/top-16 recall of CPU truth elites;
- results before and after any shader optimization.

Make this a deterministic browser conformance test. Without it, a faster shader can silently make the optimizer worse, as the compact-basis experiment did.

### Priority 1: factor the local residual safely

Use a separate GPU pass and non-aliasing buffer to compute `a_eff = a - G b` for every candidate. Then evaluate `F a_eff` plus only six active quintic controls per station. Require the rank contract to pass before benchmarking. This should make the fine geometry phase scale with about 71 active values instead of roughly 322.

Expected effect: moderate confidence of a 2-4x reduction in the 341 ms fine GPU phase after allocation and memory costs. The earlier unsafe prototype showed a larger kernel-only gain, but that number is not an accepted forecast.

### Priority 2: parallelize binary64 truth

Evaluate the 8 or 16 promoted candidates in a small worker pool. Each evaluation is independent and read-only. Use shared immutable track tables or transfer a compact compiled context once per worker.

Expected effect: moderate confidence that the 506 ms fine truth phase can fall to about 150-250 ms on a typical 8-core CPU. This also attacks the dominant part of pattern search.

### Priority 3: add a converged GPU truth tier

Add midpoint geometry and the CPU regularizer to a second GPU objective. Replace the fixed eight-sweep explicit envelope with a convergence-checked batched relaxation or an equivalent bounded iteration. Keep final binary64 checks, but promote from this higher-recall tier.

The purpose is not certification on float32. The purpose is to make the GPU ranking predict the binary64 ranking closely enough that fewer CPU checks lose no elite recall.

### Priority 4: make the fine tuner block-aware

Keep the Fourier backbone. Extend the accepted pattern method with a small active set:

1. estimate signed gains and diagonal curvature from symmetric probes;
2. select nonoverlapping physical arc supports;
3. solve a clipped diagonal or low-rank trust-region step;
4. backtrack against proxy feasibility;
5. perform one parallel binary64 batch.

This matches the observed nature of the late corrections. It should replace many random high-frequency trials with a few coordinated smooth moves.

### Priority 5: reduce the fixed tail

Parallelize independent curvature projections/evaluations, preserve the current coarse-to-fine reranking, and measure each subphase. The 65 s finalizer is now larger than 37% of discovery time. The 25 s certificate should stay authoritative, but its three independent mesh evaluations may also support controlled parallel execution.

### Priority 6: connect checkpoint persistence

Persist the optimizer's stopped checkpoint under the existing track/settings fingerprint and restore it on the next compatible run. This is the cheapest practical way to turn several short sessions into one long fine search.

## Final assessment

The GPU is not being bypassed, but the application is not yet a predominantly GPU-resident optimizer. The original bottleneck was serial CPU truth evaluation. After the accepted changes, the fine GPU proxy, CPU truth path, structured pattern search, and CPU finalizer are all material costs.

The present implementation is substantially more effective: it reaches a certified 26.493 s result in 4.4 minutes and preserves a strong final certificate. It does not meet the sub-26 s target. The most credible next route is a measured CPU/GPU rank contract, safe factorization of the local residual basis, parallel binary64 truth evaluation, and a block-aware smooth fine tuner. More candidates or more Fourier modes alone are unlikely to close the remaining gap efficiently.
