// Compares two release versions by semantic-version precedence (semver.org §11), so the release
// workflow marks a release latest and moves `beta` only for a version newer than the current one.
//
//   node scripts/semver-newer.mjs <candidate> <current>
//
// Exits 0 when candidate is newer, 1 when it is not, 2 when either is not a version.
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function parse(text) {
  const match = VERSION.exec(text ?? '');
  if (!match) return undefined;
  return {
    core: match.slice(1, 4).map(BigInt),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

const numeric = (part) => /^\d+$/.test(part);

// Negative, zero or positive as a precedes, equals or follows b.
function compareIdentifiers(a, b) {
  if (numeric(a) && numeric(b)) {
    const difference = BigInt(a) - BigInt(b);
    return difference === 0n ? 0 : difference < 0n ? -1 : 1;
  }
  if (numeric(a)) return -1;
  if (numeric(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index])
      return a.core[index] < b.core[index] ? -1 : 1;
  }
  // A pre-release precedes its release.
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (
    let index = 0;
    index < Math.min(a.pre.length, b.pre.length);
    index += 1
  ) {
    const order = compareIdentifiers(a.pre[index], b.pre[index]);
    if (order) return order;
  }
  return a.pre.length - b.pre.length;
}

const [candidate, current] = process.argv.slice(2).map(parse);
if (!candidate || !current) {
  console.error('semver-newer: expected two versions such as 0.1.0-beta.2');
  process.exit(2);
}
process.exit(compare(candidate, current) > 0 ? 0 : 1);
