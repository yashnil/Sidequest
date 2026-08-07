import { buildId, recordedBuildId } from './readiness';

/**
 * Did the build change while the suite was running?
 *
 * `npm run start` serves a prebuilt bundle, and a build that lands mid-run
 * replaces the content-hashed chunk files the running process still names. The
 * server keeps answering; its scripts stop existing; every page from that moment
 * renders and never hydrates. Nothing in the resulting failures says so.
 *
 * This cannot prevent it and does not try. It says it happened, so a wall of
 * timeouts is read as "run this again" rather than investigated as a defect —
 * which is exactly the wrong turn this check exists to stop somebody taking.
 */
export default async function globalTeardown(): Promise<void> {
  const before = recordedBuildId();
  const after = buildId();
  if (!before || !after || before === after) return;

  console.error(
    [
      '',
      '  The application was rebuilt while this suite was running.',
      `  Started against build ${before}, finished against ${after}.`,
      '  Failures after the rebuild describe neither build. Run it again on a',
      '  tree nobody is building.',
      '',
    ].join('\n'),
  );
}
