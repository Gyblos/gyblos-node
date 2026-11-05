"""Scan source data with reviewed CE rules; never execute product code."""
import collections
import copy
import json
import os
import pathlib
import stat
import subprocess
import sys

EXTENSIONS = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'}
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_FILES = 5000
SCRATCH = pathlib.Path('/scratch')


class ScanFailure(Exception):
    """An incomplete scan, unexpected detection or invalid inventory."""


def require(condition, message):
    if not condition:
        raise ScanFailure(message)


def source_path(value):
    path = pathlib.PurePosixPath(value)
    require(not path.is_absolute() and bool(path.parts), 'Invalid source path.')
    require('..' not in path.parts and '.local' not in path.parts, 'Unsafe source path.')
    return path


def empty_project(name):
    root = SCRATCH / name
    root.mkdir()
    # An explicit empty file overrides the selected frontend's default ignores.
    (root / '.semgrepignore').write_text('')
    return root


def project_sources(source, manifest, name='project'):
    root = empty_project(name)
    expected = set()
    total = 0
    for value in manifest.read_bytes().decode('utf-8').split('\0'):
        if not value or pathlib.PurePosixPath(value).suffix not in EXTENSIONS:
            continue
        relative = source_path(value)
        require(value not in expected, 'Duplicate source inventory entry.')
        current = source
        for component in relative.parts:
            current = current / component
            require(not current.is_symlink(), 'Tracked source symlinks are not permitted.')
        require(stat.S_ISREG(current.lstat().st_mode), 'Tracked source is not a regular file.')
        descriptor = os.open(current, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as handle:
            info = os.fstat(handle.fileno())
            require(stat.S_ISREG(info.st_mode), 'Tracked source is not a regular file.')
            require(info.st_nlink == 1, 'Tracked source hard links are not permitted.')
            require(info.st_size <= MAX_FILE_BYTES, 'Tracked source exceeds the reviewed size limit.')
            content = handle.read(MAX_FILE_BYTES + 1)
        require(len(content) == info.st_size, 'Tracked source changed during copying.')
        total += len(content)
        require(total <= MAX_TOTAL_BYTES, 'Source projection exceeds the reviewed size limit.')
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        expected.add(value)
        require(len(expected) <= MAX_FILES, 'Source inventory exceeds the reviewed file limit.')
    require(bool(expected), 'No tracked JavaScript or TypeScript files.')
    return root, expected


def scan(root, config):
    command = [
        'semgrep', 'scan', '--legacy', '--config', str(config), '--oss-only',
        '--metrics', 'off', '--disable-version-check', '--disable-nosem',
        '--strict', '--error', '--no-git-ignore', '--no-rewrite-rule-ids',
        '--no-exclude-binary-files',
        '--max-target-bytes', '0', '--optimizations', 'all', '--jobs', '2', '--timeout', '10',
        '--timeout-threshold', '1', '--max-memory', '1024',
        '--json', '.',
    ]
    completed = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=180)
    require(completed.returncode in {0, 1, 3}, 'Semgrep process failed.')
    try:
        report = json.loads(completed.stdout)
    except (ValueError, TypeError) as error:
        raise ScanFailure('Semgrep did not return a JSON report.') from error
    if root.name == 'project' and isinstance(report, dict):
        for error in report.get('errors', []):
            kind = error.get('type')
            if isinstance(kind, list):
                kind = kind[0]
            print('Analysis error: ' + json.dumps({'type': kind, 'path': error.get('path')}))
    return completed.returncode, report


def complete_report(report, expected):
    require(isinstance(report, dict), 'Invalid Semgrep report.')
    require(report.get('errors') == [], 'Semgrep reported an analysis error.')
    require(report.get('skipped_rules') == [], 'Semgrep skipped a rule.')
    require(report.get('engine_requested') == 'OSS', 'Expected the Community Edition engine.')
    paths = report.get('paths', {}).get('scanned')
    require(isinstance(paths, list), 'Semgrep omitted its scanned-file inventory.')
    actual = {str(source_path(value)) for value in paths}
    require(actual == expected and len(paths) == len(expected), 'Semgrep scanned-file coverage differs from Git inventory.')
    require(isinstance(report.get('results'), list), 'Semgrep omitted its findings.')
    return report['results']


def findings(results):
    return collections.Counter((item['path'], item['check_id']) for item in results)


def verify_report_guards(report, expected):
    variants = []
    for key, value in [('errors', [{'type': 'PartialParsing'}]), ('skipped_rules', ['synthetic-rule'])]:
        variant = copy.deepcopy(report)
        variant[key] = value
        variants.append(variant)
    for paths in [[], list(expected)[:-1], [*expected, 'unexpected.ts'], [*expected, *expected]]:
        variant = copy.deepcopy(report)
        variant['paths']['scanned'] = paths
        variants.append(variant)
    for variant in variants:
        try:
            complete_report(variant, expected)
        except ScanFailure:
            continue
        raise ScanFailure('Incomplete analysis report was accepted.')
    root = empty_project('unsafe-inventory')
    (root / 'escape.ts').symlink_to('/scratch/probes/eval.ts')
    manifest = SCRATCH / 'unsafe-targets'
    manifest.write_bytes(b'escape.ts\0')
    try:
        project_sources(root, manifest, 'inventory-projection')
    except ScanFailure:
        pass
    else:
        raise ScanFailure('A tracked symlink was accepted.')
    print(f'Coverage accounting: {len(variants)} incomplete-report guards and tracked-symlink guard passed.')


def verify_rules(config, probes):
    root = empty_project('probes')
    cases = json.loads(probes.read_text())['cases']
    expected = set()
    matches = collections.Counter()
    for case in cases:
        relative = source_path(case['file'])
        require(str(relative) not in expected, 'Duplicate coverage probe path.')
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('//' + 'x' * case['padding'] + '\n' + case['source'] + '\n')
        expected.add(str(relative))
        matches.update((str(relative), rule) for rule in case['expected'])
    returncode, report = scan(root, config)
    results = complete_report(report, expected)
    require(returncode == 1 and findings(results) == matches, 'Positive/negative rule coverage probe failed.')
    ids = {rule['id'] for rule in json.loads(config.read_text())['rules']}
    require(ids == {rule for _, rule in matches}, 'An enabled rule has no positive coverage probe.')
    verify_report_guards(report, expected)
    for extension in ['ts', 'tsx', 'js']:
        malformed = empty_project('malformed-' + extension)
        filename = 'invalid.' + extension
        # A comment activates the semantic prefilter without creating a finding.
        (malformed / filename).write_text('// eval\nexport const broken = ( ;\n')
        code, invalid = scan(malformed, config)
        require(code != 0 and bool(invalid.get('errors')) and not invalid.get('results'),
                'Relevant malformed source did not report an analysis error.')
        no_keyword = empty_project('no-keyword-' + extension)
        (no_keyword / filename).write_text('export const broken = ( ;\n')
        code, limited = scan(no_keyword, config)
        complete_report(limited, {filename})
        require(code == 0 and not limited.get('errors') and not limited.get('results'),
                'Known parser/prefilter behavior changed; re-review coverage limits.')
    unsupported = empty_project('unsupported-type')
    (unsupported / 'valid.ts').write_text('// eval\nexport type * from "./types";\n')
    code, limited = scan(unsupported, config)
    require(code != 0 and bool(limited.get('errors')) and not limited.get('results'),
            'Known TypeScript compatibility behavior changed; re-review coverage.')
    print(f'Rule coverage: {len(ids)} rules, {len(cases)} positive/negative probes; 3 relevant-malformed guards passed.')
    print('TypeScript compatibility guard: relevant unsupported syntax is rejected, not suppressed.')
    print('Known limit verified: 3 no-keyword malformed inputs are not syntax-validated by CE; typecheck remains required.')


def main():
    source = pathlib.Path(sys.argv[1])
    manifest = pathlib.Path(sys.argv[2])
    expected_version = sys.argv[3]
    for path in ['home', 'tmp', 'config', 'cache']:
        (SCRATCH / path).mkdir(exist_ok=True)
    version = subprocess.run(['semgrep', '--version'], capture_output=True, text=True, timeout=30)
    require(version.returncode == 0 and version.stdout.strip() == expected_version, 'Unexpected Semgrep version.')
    config = source / 'tooling/semgrep/rules.json'
    verify_rules(config, source / 'tooling/semgrep/probes.json')
    root, expected = project_sources(source, manifest)
    returncode, report = scan(root, config)
    results = complete_report(report, expected)
    # Only identifiers/locations reach logs, never matched source/snippets.
    for item in results:
        print('Finding: ' + json.dumps({'rule': item['check_id'], 'path': item['path'], 'line': item['start']['line']}))
    require(returncode == 0 and not results, 'Static analysis findings require review.')
    print(f'Semgrep CE {expected_version}: {len(expected)} tracked JS/TS/TSX files scanned; 0 findings, 0 analysis errors, 0 omitted targets.')


if __name__ == '__main__':
    try:
        main()
    except (ScanFailure, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        detail = str(error) if isinstance(error, ScanFailure) else 'invalid input or process failure'
        print(f'Static analysis failed: {type(error).__name__}: {detail}', file=sys.stderr)
        sys.exit(1)
