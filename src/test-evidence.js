export function parseTestEvidence(output, command, durationSeconds = null) {
  const rspec = output.match(/(\d+) examples?,\s*(\d+) failures?/i);
  const minitest = output.match(/(\d+) runs?,\s*(\d+) assertions?,\s*(\d+) failures?,\s*(\d+) errors?/i);
  const elapsed = output.match(/Finished in\s+([\d.]+)\s+seconds/i);
  const duration = durationSeconds ?? (elapsed ? Number(elapsed[1]) : null);
  if (rspec) return { command, count: Number(rspec[1]), passed: Number(rspec[2]) === 0, failures: Number(rspec[2]), durationSeconds: duration, coveragePercent: null };
  if (minitest) return { command, count: Number(minitest[1]), passed: Number(minitest[3]) + Number(minitest[4]) === 0, failures: Number(minitest[3]) + Number(minitest[4]), assertions: Number(minitest[2]), durationSeconds: duration, coveragePercent: null };
  return { command, count: null, passed: null, failures: null, durationSeconds: duration, coveragePercent: null, parseStatus: "unrecognized" };
}
