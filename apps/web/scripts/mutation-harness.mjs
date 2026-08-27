#!/usr/bin/env node
/**
 * §30 QUALITY MUTATION TESTS — THE RUNNER.
 *
 * Introduce a named regression, run the tests that are supposed to notice,
 * record which ones did, and put the tree back exactly as it was.
 *
 * The whole value of this is in the last clause, so it is the part with the
 * most machinery behind it:
 *
 * **The bytes are captured before the edit and written back after it**, not
 * regenerated from the mutation. A replace-then-reverse-replace restore is
 * wrong the moment a `find` string appears in the replacement, and it leaves no
 * way to prove the file came back.
 *
 * **The restore is verified, per file, by hash**, and the run stops on the
 * first file that does not match. A harness that quietly leaves a mutation
 * behind is strictly worse than no harness: every subsequent test run in that
 * tree is measuring a defect somebody injected on purpose.
 *
 * **A second, independent check runs against whichever tree is at risk.**
 * In `--in-place` mode that is `git status --porcelain` before and after each
 * mutation: hashes catch a bad restore of a file we touched, and the porcelain
 * snapshot catches a file we did not expect to touch at all — including one a
 * test wrote. In mirror mode `porcelain()` is inert by construction, so what
 * runs instead is a hash of the mutation's own files **in the real repository**,
 * proving the mirror did not write through to the shared tree. The mirror mode
 * used to have no second check at all and said it did.
 *
 * **Interruption restores too.** `SIGINT`, `SIGTERM` and an uncaught throw all
 * run the same restore, because the failure mode this guards against is a
 * developer pressing ctrl-C during a slow vitest run.
 *
 * **Every recorded defender is confirmed against the restored tree.** A test
 * that fails under the mutation *and* fails without it defended nothing; it is
 * simply unstable, and crediting it manufactures a CAUGHT verdict for a
 * behaviour no test can observe. See `markUnstable` for the run that produced
 * exactly that and why one baseline run cannot tell the two apart.
 *
 * ## Working against a copy, by default
 *
 * The tree this repository is developed in is shared — more than one agent, and
 * a dev server, read it while work is in progress. Mutating shared source even
 * for the seconds a vitest run takes is a hazard nobody can see: a concurrent
 * reader gets a file with a deliberate defect in it and no way to know.
 *
 * So the default is to mirror the working tree into a scratch directory and
 * mutate there. `--in-place` opts out for a tree nobody else is holding. The
 * mirror is a copy of the tracked and untracked working files with `node_modules`
 * symlinked, which is enough for vitest and costs about a second.
 *
 * ## Usage
 *
 *   node apps/web/scripts/mutation-harness.mjs --list
 *   node apps/web/scripts/mutation-harness.mjs --dry-run
 *   node apps/web/scripts/mutation-harness.mjs M07 M12
 *   node apps/web/scripts/mutation-harness.mjs --all --in-place
 *
 * Exit code is non-zero when a mutation survived — that is, when the tests said
 * nothing about a regression that was really there. §30's own conclusion: if no
 * test fails, the coverage is vacuous, and this is how that is discovered rather
 * than assumed.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MUTATIONS } from './mutations.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((entry) => entry.startsWith('--')));
const selectors = argv.filter((entry) => !entry.startsWith('--'));

const selected = flags.has('--all')
  ? MUTATIONS
  : selectors.length > 0
    ? MUTATIONS.filter((mutation) =>
        selectors.some((selector) => mutation.id.toLowerCase().includes(selector.toLowerCase())),
      )
    : MUTATIONS;

/* ------------------------------------------------------------------ *
 * The tree the run happens in
 * ------------------------------------------------------------------ */

/**
 * Every workspace package, by the name other packages import it under.
 *
 * Read from the root manifest rather than hardcoded, so a new workspace is
 * linked without anybody remembering to come back here.
 */
function workspacePackages() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const found = new Map();
  for (const pattern of manifest.workspaces ?? []) {
    /* The manifest uses one glob shape — `dir/*` — so a directory read answers it. */
    const parent = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    const parentPath = join(REPO_ROOT, parent);
    if (!existsSync(parentPath)) continue;
    const children = pattern.endsWith('/*') ? readdirSync(parentPath) : [''];
    for (const child of children) {
      const relative = child === '' ? parent : `${parent}/${child}`;
      const packageJson = join(REPO_ROOT, relative, 'package.json');
      if (!existsSync(packageJson)) continue;
      const name = JSON.parse(readFileSync(packageJson, 'utf8')).name;
      if (typeof name === 'string') found.set(name, relative);
    }
  }
  return found;
}

/**
 * THE MIRROR'S OWN `node_modules`, WITH THE WORKSPACE LINKS POINTED INWARDS.
 *
 * This is the correctness of the whole harness, and it was wrong.
 *
 * The mirror used to symlink `node_modules` wholesale at the real repository.
 * npm installs a workspace as `node_modules/@scope/pkg -> ../../packages/pkg`,
 * a *relative* link resolved against the directory the link lives in — which is
 * the real repository, not the mirror. So every `import … from '@sidequest/core'`
 * inside the mirror walked straight back out into the developer's tree and read
 * the **unmutated** source.
 *
 * The consequence was not a slow test run. It was seven of §30's fifteen classes
 * reported as SURVIVED — recorded as vacuous coverage on release-blocking
 * requirements — when the mutation had never reached the code under test at all.
 * A mutation harness that silently tests the wrong bytes is the one tool whose
 * false negatives are indistinguishable from the finding it exists to produce.
 *
 * So third-party packages are still shared (they are large and nobody mutates
 * them), and every workspace name is re-linked at the mirror's own copy.
 */
function linkNodeModules(root) {
  const realModules = join(REPO_ROOT, 'node_modules');
  const mirrorModules = join(root, 'node_modules');
  const workspaces = workspacePackages();
  /* Scopes that hold at least one workspace package have to be rebuilt entry by entry. */
  const scopes = new Set(
    [...workspaces.keys()].filter((name) => name.startsWith('@')).map((name) => name.split('/')[0]),
  );

  mkdirSync(mirrorModules, { recursive: true });
  for (const entry of readdirSync(realModules)) {
    if (!scopes.has(entry)) {
      symlinkSync(join(realModules, entry), join(mirrorModules, entry));
      continue;
    }
    const scopeDir = join(mirrorModules, entry);
    mkdirSync(scopeDir, { recursive: true });
    for (const child of readdirSync(join(realModules, entry))) {
      const name = `${entry}/${child}`;
      const workspace = workspaces.get(name);
      symlinkSync(
        workspace ? join(root, workspace) : join(realModules, entry, child),
        join(scopeDir, child),
      );
    }
  }

  /*
   * A workspace npm never linked (a package added since the last install) still
   * has to resolve, or the run reports a collection error rather than a result.
   */
  for (const [name, relative] of workspaces) {
    const target = join(mirrorModules, name);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(root, relative), target);
  }
}

/**
 * A copy of the working tree, with dependencies shared rather than duplicated.
 *
 * `git ls-files` plus the untracked-but-not-ignored set is exactly what a
 * `git status` clean checkout would contain, which is what makes a mirror a
 * faithful subject: it holds the in-flight edits, not just the last commit.
 */
function mirrorWorkingTree() {
  const root = mkdtempSync(join(tmpdir(), 'sidequest-mutation-'));
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((line) => line.trim() !== '');

  for (const relative of listed) {
    const from = join(REPO_ROOT, relative);
    if (!existsSync(from)) continue;
    cpSync(from, join(root, relative), { recursive: true });
  }
  linkNodeModules(root);
  // The mirror is not a git repository, so `git status` cannot be the restore
  // check there; the per-file hashes are, and they are the stricter of the two.
  return root;
}

const inPlace = flags.has('--in-place');
let workRoot = REPO_ROOT;
let mirrorPath = null;

function cleanUpMirror() {
  if (mirrorPath) {
    rmSync(mirrorPath, { recursive: true, force: true });
    mirrorPath = null;
  }
}

/**
 * Progress goes to stdout directly, as `doctor.mjs` does.
 *
 * The repository's lint rule allows only `warn` and `error` on `console`, which
 * is right for application code and wrong for a reporting tool whose entire
 * output is its result. Writing to the stream says the same thing without
 * pretending a result is a diagnostic.
 */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------------ *
 * Applying and undoing one mutation
 * ------------------------------------------------------------------ */

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

function porcelain() {
  if (workRoot !== REPO_ROOT) return null;
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Files currently held mutated, so an interrupt can put them back. */
const held = new Map();

function restoreHeld() {
  for (const [path, original] of held) {
    try {
      writeFileSync(path, original, 'utf8');
    } catch (error) {
      console.error(`RESTORE FAILED for ${path}: ${error.message}`);
    }
  }
  held.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreHeld();
    cleanUpMirror();
    process.exit(130);
  });
}
process.on('uncaughtException', (error) => {
  restoreHeld();
  cleanUpMirror();
  console.error(error);
  process.exit(1);
});

/**
 * Apply every edit, or none of them.
 *
 * A partially applied mutation is a different mutation, and one nobody wrote
 * down — so an anchor that does not match exactly once aborts the whole entry
 * and puts back anything already changed.
 */
function apply(mutation) {
  const applied = [];
  for (const edit of mutation.edits) {
    const path = join(workRoot, edit.file);
    if (!existsSync(path)) {
      restore(applied);
      return { ok: false, detail: `${edit.file} does not exist` };
    }
    const original = readFileSync(path, 'utf8');
    const occurrences = original.split(edit.find).length - 1;
    if (occurrences !== 1) {
      restore(applied);
      return {
        ok: false,
        detail: `anchor matched ${occurrences} times in ${edit.file} (expected exactly 1)`,
      };
    }
    if (edit.find === edit.replace) {
      restore(applied);
      return { ok: false, detail: `${edit.file}: the replacement is the anchor, so nothing changes` };
    }
    held.set(path, original);
    applied.push({ path, original });
    writeFileSync(path, original.replace(edit.find, edit.replace), 'utf8');
  }
  return { ok: true, applied };
}

function restore(applied) {
  for (const { path, original } of applied) {
    writeFileSync(path, original, 'utf8');
    held.delete(path);
  }
}

/** Every restored file is byte-identical to what was read before the edit. */
function verifyRestored(applied) {
  const wrong = [];
  for (const { path, original } of applied) {
    const now = readFileSync(path, 'utf8');
    if (sha(now) !== sha(original)) wrong.push(path);
  }
  return wrong;
}

/**
 * THE OTHER TREE, AND WHY THE OLD CHECK SAID NOTHING ABOUT IT.
 *
 * The header promises `git status --porcelain` as a second, independent proof
 * that the tree came back. In the default (mirror) mode that promise was
 * hollow: `porcelain()` returns null off the real repository, so the comparison
 * was skipped and "the source tree was restored exactly" held trivially by
 * never having been touched — which is the claim, not the evidence for it.
 *
 * A mirror can write through to the source. Every third-party `node_modules`
 * entry is a symlink at the real repository, the workspace links point inward
 * by construction rather than by accident, and getting that construction wrong
 * is precisely the defect that once made seven of these classes report the
 * wrong verdict. So the files this mutation is about are hashed **in the real
 * repository** before the edit and again after the restore.
 *
 * Narrow on purpose. A full porcelain diff of a working tree that other agents
 * are editing at the same time would trip on their work and say nothing about
 * this run; a difference in exactly the files this mutation writes is either a
 * leak or a collision worth stopping for either way.
 */
function sourceFingerprint(mutation) {
  if (workRoot === REPO_ROOT) return null;
  const digests = new Map();
  for (const edit of mutation.edits) {
    const path = join(REPO_ROOT, edit.file);
    if (existsSync(path)) digests.set(path, sha(readFileSync(path, 'utf8')));
  }
  return digests;
}

function verifySourceUntouched(fingerprint) {
  if (!fingerprint) return [];
  const changed = [];
  for (const [path, digest] of fingerprint) {
    if (!existsSync(path) || sha(readFileSync(path, 'utf8')) !== digest) changed.push(path);
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * Running the targeted tests
 * ------------------------------------------------------------------ */

/**
 * Which named tests failed, read from vitest's own output.
 *
 * The exit code alone says "something failed", which is not the finding §30
 * asks for — the finding is *which test* defended the behaviour. Vitest prints
 * one ` FAIL  <file> > <suite> > <name>` line per failing test, so that is what
 * is parsed. A run that fails to start at all produces no such lines and is
 * reported as an error rather than as a catch, because a mutation that breaks
 * the build has proved nothing about coverage.
 *
 * **A FILE-LEVEL BANNER IS NOT A TEST, AND USED TO BE COUNTED AS ONE.**
 *
 * Vitest prints a second shape — ` FAIL  <file> [ <file> ]` — when a file
 * errors rather than when one of its tests fails: a collection error, a throw
 * at module scope, an unhandled rejection. It carries no `>` because there is
 * no suite and no test name to carry. Counting it as a catcher inflated a
 * count (M15 reported four defenders, one of which was this banner) and, worse,
 * would have let a mutation that merely stops a file from loading be recorded
 * as CAUGHT — a green-looking verdict protecting nothing, which is the exact
 * class this whole exercise exists to find.
 *
 * So the two are separated at the point of reading. Only named failures can
 * make a verdict `caught`; file-level errors are reported beside it, and a
 * mutation whose *only* new failures are file-level is an `error`, because
 * "the file blew up" does not name the test that defended the behaviour.
 */
function runTests(paths) {
  const outcome = spawnSync('npx', ['vitest', 'run', ...paths, '--reporter=default'], {
    cwd: workRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  });
  const output = `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`;
  /**
   * Colour codes stripped before the line is read.
   *
   * Vitest wraps its `FAIL` banner in SGR sequences on a colour-capable
   * terminal, and a test name carrying escape bytes is a name nobody can paste
   * into a filter. The pattern is built from a char code rather than written
   * literally, so this file holds no control character of its own.
   */
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const banners = [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.replace(ansi, ''))
        .filter((line) => line.includes('FAIL'))
        .map((line) => line.replace(/^\s*FAIL\s*/, '').trim())
        .filter((line) => line !== ''),
    ),
  ];
  /* ` > ` is the separator vitest puts between file, suite and test name. */
  const failures = banners.filter((line) => line.includes(' > '));
  const fileErrors = banners.filter((line) => !line.includes(' > '));
  const collected = /Tests\s+(?:\d+ failed \| )?\d+ passed/.test(output) || banners.length > 0;
  return { status: outcome.status ?? 1, failures, fileErrors, collected, output };
}

/**
 * WHICH OF THOSE TESTS WERE ALREADY FAILING BEFORE ANYBODY MUTATED ANYTHING.
 *
 * Without this the harness cannot tell a guard from a graveyard. A test that is
 * red in the unmutated tree fails under every mutation that names it, so every
 * one of them is reported CAUGHT — by a test that defended nothing. That is the
 * same vacuity §30 exists to find, one level up, and it is not hypothetical:
 * this file's own §29 selection carries a deliberately failing scenario that
 * reports a product defect, and it made the first mutation pointed at it look
 * defended.
 *
 * So the same selection is run once unmutated and its failures are subtracted.
 * Cached on the selection, because most entries share one, and a baseline is a
 * property of the tree rather than of the mutation.
 */
const baselineFailures = new Map();

/**
 * WHY ONE UNMUTATED RUN IS NOT ENOUGH, AND WHAT A FABRICATED DEFENDER IS.
 *
 * Subtracting a single baseline answers "was this test red before?". It does
 * not answer the question a CAUGHT verdict actually claims, which is "did *this
 * mutation* make this test red?". Those come apart the moment any test in the
 * selection is unstable — flaky, order-dependent, or reading state some other
 * test wrote. Such a test is green in the baseline run and red in the mutated
 * run for reasons that have nothing to do with the edit, and the harness writes
 * its name down as a defender.
 *
 * That is not hypothetical and it is not rare. A §16B probe recorded
 * `autopick-action-forgets-what-the-traveller-decided` — an edit to one line of
 * a server action — as CAUGHT by two tests, `planner/zz-sweep.test.ts > SWEEP >
 * measures swap menu applicability` and `overture.test.ts > … reads past the
 * first corner and keeps the landmarks it finds there`. Neither loads the
 * mutated module. Neither could observe the edit under any circumstances. The
 * same two names appear as "defenders" of three unrelated mutations in the same
 * log, which is the signature: an unstable test defends everything, because it
 * fails on its own schedule. Re-run in isolation, that mutation SURVIVED — a
 * genuine hole in the suite, reported as a guarded behaviour.
 *
 * A harness that over-reports CAUGHT is worse than no harness at all, because a
 * SURVIVED verdict gets fixed and a CAUGHT one gets cited.
 *
 * So a defender has to prove itself twice: it must fail with the mutation held
 * **and pass on the restored tree**, under the identical command. Anything that
 * fails both ways is unstable by demonstration rather than by suspicion, is
 * struck off the defender list, and is folded into the baseline so it cannot
 * manufacture a defence for any later entry sharing this selection either.
 */
function markUnstable(paths, failures, fileErrors) {
  const baseline = baselineFailures.get(JSON.stringify(paths));
  if (!baseline) return;
  for (const entry of failures) baseline.failures.add(entry);
  for (const entry of fileErrors) baseline.fileErrors.add(entry);
}

function baselineFor(paths) {
  /*
   * `JSON.stringify` rather than a joined string, and not for elegance: the
   * separator here used to be a literal NUL byte, written into this file as a
   * control character. It worked, and it made the source binary — `file(1)`
   * says so, and git's own binary detection only misses it because the byte
   * happens to sit past the window it samples. A tool whose diff could stop
   * being reviewable because one line moved is not one to leave alone, and the
   * header above already states the rule this broke: this file holds no control
   * character of its own.
   */
  const key = JSON.stringify(paths);
  const cached = baselineFailures.get(key);
  if (cached) return cached;
  const run = runTests(paths);
  const baseline = {
    failures: new Set(run.collected ? run.failures : []),
    /* A file already erroring before the mutation cannot be evidence about it. */
    fileErrors: new Set(run.collected ? run.fileErrors : []),
  };
  baselineFailures.set(key, baseline);
  return baseline;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

if (flags.has('--list')) {
  for (const mutation of MUTATIONS) {
    say(`${mutation.id}\n  ${mutation.contract}\n  tests: ${mutation.tests.join(', ')}`);
  }
  process.exit(0);
}

if (!inPlace) {
  mirrorPath = mirrorWorkingTree();
  workRoot = mirrorPath;
  say(`Working in a mirror of the tree: ${workRoot}\n`);
} else {
  say('Working IN PLACE. Nothing else may read this tree until the run finishes.\n');
}

const before = porcelain();
const results = [];

/**
 * A DECLARED DEFENDER THAT IS NOT THERE, WHICH VITEST WILL NOT MENTION.
 *
 * `tests` is the harness's claim about which tests are supposed to notice, and
 * vitest treats each entry as a substring filter over the files it finds. A
 * filter matching nothing is not an error to vitest — it simply selects fewer
 * files, silently — so a selection can rot to half its declared size and every
 * verdict still prints as though the whole of it had been asked.
 *
 * It had. Four entries named `packages/core/src/discovery/board.test.ts` and
 * `packages/core/src/discovery/autoselect.test.ts`, neither of which exists;
 * the tests moved into `discovery.test.ts` at some point and the declarations
 * did not follow. §30 asks *which test defended the behaviour*, and an answer
 * assembled from a selection nobody verified is the same class of quiet
 * inaccuracy as the stale anchor one line further down.
 *
 * So a missing path is refused the way a stale anchor is refused: loudly, and
 * without producing a verdict, because a partial selection cannot produce an
 * honest one.
 */
function missingTests(mutation) {
  return mutation.tests.filter((relative) => !existsSync(join(workRoot, relative)));
}

for (const mutation of selected) {
  if (mutation.unanchored) {
    results.push({ id: mutation.id, verdict: 'unanchored', detail: mutation.unanchored });
    say(`— ${mutation.id}: not attempted — ${mutation.unanchored}\n`);
    continue;
  }

  const absent = missingTests(mutation);
  if (absent.length > 0) {
    results.push({
      id: mutation.id,
      verdict: 'stale',
      detail: `declared test file(s) do not exist: ${absent.join(', ')}`,
    });
    say(`— ${mutation.id}: UNMEASURED — declared test file(s) do not exist: ${absent.join(', ')}`);
    say(
      '  Vitest silently selects nothing for a filter that matches no file, so this entry ' +
        'would have been judged on a smaller selection than it claims. Fix the paths.\n',
    );
    continue;
  }

  const sourceBefore = sourceFingerprint(mutation);
  const applied = apply(mutation);
  if (!applied.ok) {
    /**
     * A STALE ANCHOR IS THE QUIETEST WAY THIS EXERCISE FAILS.
     *
     * §30 class 3 — "a raw obscure map feature outranks a well-established
     * anchor on metadata alone" — sat at `anchor matched 0 times` for a whole
     * phase after `significance.ts` grew a floor on the kind contribution. The
     * class was neither CAUGHT nor SURVIVED. It was **unmeasured**, and it read
     * as one grey line in a table of green ones. That is the second time an
     * anchor has gone stale after a refactor here.
     *
     * So it is shouted rather than tabulated, in the words that say what it
     * costs: nothing was learned about that behaviour, and a table that lists it
     * beside real results invites a reader to count it as one.
     */
    results.push({ id: mutation.id, verdict: 'stale', detail: applied.detail });
    say(`— ${mutation.id}: UNMEASURED — ${applied.detail}`);
    say(
      '  The regression was never introduced, so no test was asked about it. This class is ' +
        'neither caught nor survived: it is a hole where a measurement used to be, and it ' +
        're-anchoring is the only thing that closes it.\n',
    );
    continue;
  }

  if (flags.has('--dry-run')) {
    restore(applied.applied);
    const wrong = verifyRestored(applied.applied);
    results.push({
      id: mutation.id,
      verdict: wrong.length === 0 ? 'anchored' : 'restore_failed',
      detail: wrong.join(', '),
    });
    say(`— ${mutation.id}: anchors resolve, tree restored\n`);
    continue;
  }

  say(`— ${mutation.id}: ${mutation.contract}`);
  /*
   * The baseline is measured with the mutation held, which is safe because it
   * runs against a *restored* tree: `apply` is undone first only in the sense
   * that the baseline is taken from the cache when a previous entry shared this
   * selection. For the first entry of a selection the files are put back, the
   * baseline is taken, and the mutation is reapplied — the cost of one extra
   * vitest run per distinct selection, paid once.
   */
  restore(applied.applied);
  const alreadyRed = baselineFor(mutation.tests);
  const reapplied = apply(mutation);
  if (!reapplied.ok) {
    results.push({ id: mutation.id, verdict: 'stale', detail: reapplied.detail });
    say(`— ${mutation.id}: STALE on reapply — ${reapplied.detail}\n`);
    continue;
  }
  const run = runTests(mutation.tests);
  restore(reapplied.applied);

  const wrong = verifyRestored(reapplied.applied);
  const leaked = verifySourceUntouched(sourceBefore);
  const after = porcelain();
  if (wrong.length > 0 || leaked.length > 0 || (before !== null && after !== before)) {
    console.error(
      `\nSTOPPING: the tree did not come back. Files: ${wrong.join(', ') || '(none by hash)'}`,
    );
    if (leaked.length > 0) {
      console.error(
        `The SOURCE tree changed during this mutation: ${leaked.join(', ')}. Either the mirror ` +
          'wrote through to it, or somebody else edited exactly these files while this ran. ' +
          'Both are reasons to stop and look.',
      );
    }
    if (before !== null && after !== before) {
      console.error('git status differs from the snapshot taken before this mutation.');
    }
    results.push({
      id: mutation.id,
      verdict: 'restore_failed',
      detail: [...wrong, ...leaked].join(', '),
    });
    break;
  }

  if (!run.collected) {
    results.push({
      id: mutation.id,
      verdict: 'error',
      detail: 'the targeted tests could not be collected under the mutation',
    });
    say('  the tests would not even run under this mutation — proves nothing\n');
    continue;
  }

  /* Only the failures the mutation itself caused count as a defence. */
  let newFailures = run.failures.filter((failure) => !alreadyRed.failures.has(failure));
  let newFileErrors = run.fileErrors.filter((entry) => !alreadyRed.fileErrors.has(entry));
  const ignored = alreadyRed.failures.size + alreadyRed.fileErrors.size;

  /*
   * THE CONFIRMATION RUN. Every recorded defender passes on the restored tree.
   *
   * Same selection, same command, same tree the baseline was taken from — the
   * only thing that differs from the mutated run is the mutation, which is what
   * a CAUGHT verdict claims and what nothing here used to check. Paid only when
   * something claims to have caught the mutation, so a survivor costs nothing
   * extra and a defence costs one run to be worth quoting.
   */
  let unstable = [];
  let unstableFiles = [];
  if (newFailures.length > 0 || newFileErrors.length > 0) {
    const confirm = runTests(mutation.tests);
    if (!confirm.collected) {
      results.push({
        id: mutation.id,
        verdict: 'error',
        detail: 'the confirmation run against the restored tree could not be collected',
      });
      say('  the restored tree would not run the selection — no verdict is safe here\n');
      continue;
    }
    unstable = newFailures.filter((failure) => confirm.failures.includes(failure));
    unstableFiles = newFileErrors.filter((entry) => confirm.fileErrors.includes(entry));
    markUnstable(mutation.tests, unstable, unstableFiles);
    newFailures = newFailures.filter((failure) => !unstable.includes(failure));
    newFileErrors = newFileErrors.filter((entry) => !unstableFiles.includes(entry));
  }

  if (newFailures.length > 0) {
    results.push({ id: mutation.id, verdict: 'caught', caughtBy: newFailures, unstable });
    say(`  CAUGHT by ${newFailures.length}:`);
    for (const failure of newFailures) say(`    ${failure}`);
    /*
     * Reported, never counted. A file that stopped loading under the mutation
     * is worth knowing about — it usually means the anchor was coarser than it
     * looked — but it names no test, so it cannot be a defence.
     */
    for (const entry of newFileErrors) say(`    (file-level failure, not counted: ${entry})`);
    for (const entry of [...unstable, ...unstableFiles]) {
      say(`    (struck off — fails on the restored tree too, so it defends nothing: ${entry})`);
    }
    if (ignored > 0) {
      say(`  (${ignored} failure(s) in this selection were already there and do not count)`);
    }
    say('');
  } else if (unstable.length > 0 || unstableFiles.length > 0) {
    results.push({
      id: mutation.id,
      verdict: 'survived',
      unstable: [...unstable, ...unstableFiles],
      detail:
        `every alleged defender (${[...unstable, ...unstableFiles].length}) also failed on the ` +
        'restored tree — unstable, not a defence',
    });
    say(
      '  SURVIVED — the only tests that went red also go red without the mutation:\n' +
        [...unstable, ...unstableFiles].map((entry) => `    ${entry}`).join('\n') +
        '\n',
    );
  } else if (newFileErrors.length > 0) {
    results.push({
      id: mutation.id,
      verdict: 'error',
      detail: `only file-level failures, no test named the regression: ${newFileErrors.join(', ')}`,
    });
    say('  a file blew up and no named test failed — that is not a defence\n');
  } else {
    results.push({
      id: mutation.id,
      verdict: 'survived',
      /*
       * A survival measured against a red selection is not a finding, it is a
       * missing measurement — the test that would have caught this may be one
       * of the ones that was already failing, and subtracting it is exactly
       * what the baseline is for. Said out loud rather than left for a reader
       * to infer, because three classes were reported SURVIVED on this basis
       * during a run whose mirror was taken while another change was mid-flight,
       * and all three were CAUGHT against a clean one.
       */
      ...(ignored > 0
        ? {
            detail: `${ignored} pre-existing failure(s) ignored — unreliable verdict, re-run once the selection is green`,
          }
        : {}),
    });
    say(
      ignored > 0
        ? '  SURVIVED — but the selection was already red, so this verdict proves nothing\n'
        : '  SURVIVED — nothing in the targeted selection noticed\n',
    );
  }
}

cleanUpMirror();

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */

say('\n=== §30 mutation results ===');
for (const result of results) {
  const suffix =
    result.verdict === 'caught'
      ? ` (${result.caughtBy.length} test${result.caughtBy.length === 1 ? '' : 's'})` +
        (result.unstable?.length ? `, ${result.unstable.length} struck off as unstable` : '')
      : result.detail
        ? ` — ${result.detail}`
        : '';
  say(`${result.verdict.toUpperCase().padEnd(14)} ${result.id}${suffix}`);
}

const survived = results.filter((result) => result.verdict === 'survived');
const stale = results.filter((result) => result.verdict === 'stale');
const broken = results.filter((result) =>
  ['restore_failed', 'stale', 'error'].includes(result.verdict),
);
if (survived.length > 0) {
  say(
    `\n${survived.length} mutation(s) survived. §30: if no test fails, the coverage is vacuous.`,
  );
}
/*
 * Counted separately from survivors and said in full, because the two failures
 * are not the same failure and the second one hides. A survivor is a measured
 * hole in the suite; a stale anchor is an unmeasured behaviour wearing a table
 * row, and this table is the artifact everybody quotes.
 */
if (stale.length > 0) {
  say(
    `\n${stale.length} class(es) were NOT MEASURED AT ALL — their anchors no longer match the ` +
      'source, so no regression was introduced and no test was asked anything:',
  );
  for (const entry of stale) say(`  ${entry.id} — ${entry.detail}`);
  say('Re-anchor them. Until then the contract line each one stands for is unguarded.');
}
const struckOff = results.filter((result) => result.unstable?.length);
if (struckOff.length > 0) {
  say(
    `\n${struckOff.length} entr(ies) had an alleged defender struck off: it failed under the ` +
      'mutation and again on the restored tree, so it defended nothing. Those tests are ' +
      'unstable and are worth fixing on their own account.',
  );
}
process.exit(survived.length > 0 || broken.length > 0 ? 1 : 0);
