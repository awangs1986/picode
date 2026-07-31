# Picode performance gate

`node scripts/performance-gate.mjs` is the machine-independent contract gate. It proves that long runtime histories stay bounded, disabled professional extensions have zero resident child processes, and headless input streams without waiting for EOF.

Startup readiness, idle working set, first-token latency, and long-session frame time are machine- and provider-dependent. Capture those five numeric fields on the same machine before and after a change, then run:

```text
node scripts/performance-gate.mjs --baseline before.json --current after.json
```

Both files must contain `startupReadyMs`, `idleWorkingSetBytes`, `firstTokenMs`, `longSessionP95FrameMs`, and `optionalResidentProcesses`. The baseline may provide `allowedRegressionRatio` overrides; otherwise the gate uses 15%, 10%, 20%, and 20% respectively. Optional resident processes must remain exactly zero. A run without measurement files reports `metricGate: not_requested`; it never fabricates timing or memory evidence.
