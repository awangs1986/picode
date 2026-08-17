import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  judgeSliceDriftExperiment,
  scoreSliceDrift,
  type SliceDriftObservation,
} from "../src/devloop/task/slice-drift.ts";

interface DriftGateInput {
  pairs: Array<{
    withoutSlice: SliceDriftObservation;
    withSlice: SliceDriftObservation;
  }>;
}

const inputPath = process.argv[2];
if (inputPath === undefined) {
  console.error("usage: npm run gate:slice-drift -- <paired-observations.json>");
  process.exit(2);
}

let input: DriftGateInput;
try {
  input = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as DriftGateInput;
} catch (cause) {
  console.error(`invalid Slice drift input: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(2);
}
if (!Array.isArray(input.pairs)) {
  console.error("invalid Slice drift input: pairs must be an array");
  process.exit(2);
}
const pairs = input.pairs.map((pair) => ({
  withoutSlice: scoreSliceDrift(pair.withoutSlice),
  withSlice: scoreSliceDrift(pair.withSlice),
}));
const verdict = judgeSliceDriftExperiment(pairs);
console.log(JSON.stringify({ version: 1, pairs, verdict }, null, 2));
process.exit(verdict.passed ? 0 : 1);
