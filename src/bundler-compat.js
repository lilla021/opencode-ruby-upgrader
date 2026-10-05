// Bundler/Ruby compatibility facts for the Bundler bridge.
//
// This module deliberately holds no version table. The tool performs no network
// requests, so it cannot look up which Bundler supports which Ruby, and a
// hardcoded table would silently rot the first time RubyGems cut a series.
// Instead the *floor* is supplied by the agent as cited research at the moment a
// bridge is approved -- the same way Rails and Ruby compatibility facts already
// enter this system -- and recorded in run evidence so it can be re-verified.
//
// What lives here is the arithmetic: comparing versions, and deciding whether a
// declared floor is genuinely above the project's pin. That logic must be local
// and deterministic, because it is what makes an approval defensible.

export const BUNDLER_COMPATIBILITY_SOURCE = "https://guides.rubygems.org/bundler-compatibility/";

// The official guide is a table of *minimum floors*, not fixed pairings: Bundler
// 2.5 requires Ruby >= 3.0, 2.6 requires >= 3.1, and 2.7 and 4.0 both require
// >= 3.2. A higher Bundler supports a wider range of Rubies, so a Ruby hop
// forward essentially never forces a Bundler upgrade -- an *existing* Bundler
// pin is what breaks when the Ruby moves. The bridge therefore exists because
// this project's pin lags its new Ruby, which is the mirror image of the Rails
// bridge (where Rails lagging Ruby blocks the hop).
export const bundlerVersion = /^\d+\.\d+(?:\.\d+)?$/;

export const bundlerSeries = (value) => String(value ?? "").split(".").slice(0, 2).join(".");
const parts = (value) => bundlerSeries(value).split(".").map(Number);
export const compareBundler = (left, right) => {
  const [lMajor, lMinor] = parts(left); const [rMajor, rMinor] = parts(right);
  return lMajor !== rMajor ? lMajor - rMajor : lMinor - rMinor;
};

// Bundler series move +1 per minor, with one major boundary: the 2.x line ends
// at 2.7 and the next series is 4.0. That jump is major 2 to 4 -- major 3 was
// never a Bundler series -- so this is an explicit successor rather than the
// +1 pattern Ruby uses. Treating 2.7 -> 4.0 as a valid single hop is required
// because that is how the official series run; without it a project on 2.4 could
// never reach 4.0 through a reviewed ladder.
const bundlerSeriesSuccessors = new Map([["2.7", "4.0"]]);
export const contiguousBundlerHop = (from, to) => {
  const [fromMajor, fromMinor] = parts(from); const [toMajor, toMinor] = parts(to);
  if (![fromMajor, fromMinor, toMajor, toMinor].every((value) => Number.isInteger(value))) return false;
  return toMajor === fromMajor && toMinor === fromMinor + 1
    || bundlerSeriesSuccessors.get(bundlerSeries(from)) === bundlerSeries(to);
};

// True when the project's recorded `BUNDLED WITH` pin sits below a researched
// floor. Bundler auto-switches to that pin, so this is the version that will
// actually run -- and the reason a hop is blocked.
export function bundlerPinBelowFloor({ pinned, minimum }) {
  if (!bundlerVersion.test(String(pinned ?? "")) || !bundlerVersion.test(String(minimum ?? ""))) return false;
  return compareBundler(pinned, minimum) < 0;
}

// A ladder must start at the pin and reach the researched floor one contiguous
// minor series at a time, so no hop can skip an intermediate Bundler whose
// behavior changes are themselves unreviewed.
export function validateBundlerLadder({ ladder, pinned, target }) {
  if (!Array.isArray(ladder) || ladder.length < 2) return "A Bundler research ladder must contain at least two versions.";
  if (ladder.some((version) => !bundlerVersion.test(version))) return "A Bundler research ladder must contain Bundler versions.";
  if (bundlerSeries(ladder[0]) !== bundlerSeries(pinned)) return "A Bundler research ladder must begin at the version recorded in BUNDLED WITH.";
  // Contiguity is checked before the endpoint so a ladder that both skips a
  // series and overshoots reports the more specific problem.
  for (let index = 1; index < ladder.length; index += 1) {
    if (!contiguousBundlerHop(ladder[index - 1], ladder[index])) return "A Bundler research ladder must advance one minor series per hop, or across the 2.7 to 4.0 series boundary.";
  }
  if (bundlerSeries(ladder.at(-1)) !== bundlerSeries(target)) return "A Bundler research ladder must end at the researched target Bundler.";
  return null;
}