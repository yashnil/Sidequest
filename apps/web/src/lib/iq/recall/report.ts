import { RECALL_STAGES, type CanonicalRecallReport, type SubjectRecall } from './stages';

/**
 * THE REPORT A HUMAN READS.
 *
 * Printed by the gate whether it passes or fails, because the number that
 * matters most is not the verdict — it is *where* recall was lost, and a gate
 * that only speaks when it fails leaves the "after" measurement with nothing to
 * compare against.
 *
 * Plain text with no colour and no width assumptions: this goes into terminal
 * scrollback, CI logs and phase documents, and a table that only renders in one
 * of those is a table nobody quotes.
 */

function pad(value: string, width: number): string {
  /*
   * Padded on *display width* rather than code-unit length, because half these
   * names are CJK and a monospace terminal draws those two columns wide. A
   * `padEnd` over `string.length` produces a table that is visibly ragged
   * exactly on the destination this instrument exists for.
   */
  let width_ = 0;
  for (const char of value) width_ += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u.test(char) ? 2 : 1;
  return value + ' '.repeat(Math.max(0, width - width_));
}

function stageLabel(entry: SubjectRecall): string {
  if (entry.verdict === 'out_of_scope') return 'out of scope';
  if (!entry.lostAt) return 'reached the board';
  /*
   * A subject can be lost early and still be on a board built from a different
   * pack. Saying so is the point of independent stage flags.
   */
  const suffix = entry.passed.board ? ' *' : '';
  return `lost at ${entry.lostAt}${suffix}`;
}

/** The cell numbers every acquisition-loss verdict owes the reader. */
function cellFigures(entry: SubjectRecall): string {
  const cell = entry.cell;
  return `cell kept ${cell?.retainedInCell ?? 0} (densest ${cell?.densestCell ?? 0}), ${cell?.zeroPriorityInCell ?? 0} of them score 0.000`;
}

function why(entry: SubjectRecall): string {
  if (entry.verdict === 'outside_partition') {
    return 'never scheduled — its position falls in no partition cell (the partition dropped it)';
  }
  if (entry.verdict === 'never_read') {
    const cells = entry.cell?.cellIds.join('+') ?? '?';
    return `never read — cell ${cells} contributed 0 place records`;
  }
  if (entry.verdict === 'unread') {
    const cells = entry.cell?.cellIds.join('+') ?? '?';
    return `read cut short — the layer names cell ${cells} as failed or truncated; ${cellFigures(entry)}`;
  }
  if (entry.verdict === 'proxy_only') {
    const proxy = entry.match.proxy;
    const as = proxy ? `: ${proxy.name} [${proxy.layerId}/${proxy.sourceCategory}] at ${proxy.metres}m` : '';
    return `own record absent — a proxy exists${as}; not the subject, not counted; ${cellFigures(entry)}`;
  }
  if (entry.verdict === 'outranked') {
    return `outranked — its ground was fully read, so absence is retention eviction; ${cellFigures(entry)}`;
  }
  if (entry.verdict === 'unread_or_outranked') {
    return `unread or outranked — ${cellFigures(entry)}`;
  }
  if (entry.verdict === 'out_of_scope') return 'outside the pack bounds; not counted';
  const via = entry.match.tier === 'name' ? 'by name' : `by site, ${entry.match.metres}m`;
  /*
   * The record we decided *is* the subject, printed. Without it a `site` match
   * is an unauditable assertion, and the difference between "the garden" and "an
   * oak inside the garden" is exactly what a reader needs to see.
   */
  const record = entry.match.record;
  const as = record ? ` as ${record.name} [${record.layerId}/${record.sourceCategory}]` : '';
  /*
   * Survivor credit is said out loud, so a stage passed via the collapse
   * survivor can never be mistaken for the matched record holding its own
   * seat — and a survivor that lost its seat too is named as the loss it is.
   */
  const survivor = entry.survivor
    ? ` · superseded by collapse → survivor ${entry.survivor.name} [${entry.survivor.layerId}/${entry.survivor.sourceCategory}]` +
      (entry.survivor.creditedStages.length > 0
        ? `, credited ${entry.survivor.creditedStages.join('+')} via survivor`
        : ', survivor lost its seat too')
    : '';
  return `${via}${as}${entry.role ? ` · role ${entry.role}` : ''}${survivor}`;
}

export function renderRecallReport(report: CanonicalRecallReport): string {
  const lines: string[] = [];
  const counted = report.subjects.length - report.outOfScope.length;

  lines.push('');
  lines.push('='.repeat(96));
  lines.push(`CANONICAL RECALL — ${report.destinationId}  (${report.shape})`);
  lines.push('='.repeat(96));
  lines.push(
    `pack ${report.packId}  state=${report.packState}  hash=${report.packContentHash}  built ${report.packCreatedAt}`,
  );
  if (report.provenance?.relabelled) {
    lines.push(
      `NOTE: this pack was written at schema v${report.provenance.storedSchemaVersion} and read by relabelling it to the current schema. ` +
        'Every figure below describes that build, not necessarily a build of the current compiler.',
    );
  }
  const placesReadLabel =
    report.read.placesRead === 'complete'
      ? 'places read complete (only the retention cap stopped it)'
      : report.read.placesRead === 'truncated'
        ? 'places read cut short (ground provably unread)'
        : 'places read completeness indeterminate (legacy budget vocabulary)';
  lines.push(
    `read: ${report.read.placesRetained} place records across ${report.read.cellsWithPlaces}/${report.read.cells} partition cells; ` +
      `densest cell holds ${(report.read.densestCellShare * 100).toFixed(1)}%; ` +
      `row groups ${report.read.rowGroupsRead}/${report.read.rowGroupsInspected} opened; ` +
      `${placesReadLabel}; ` +
      `budgets exhausted: ${report.read.budgetsExhausted.join(', ') || 'none'}`,
  );
  lines.push('');

  lines.push('STAGE FUNNEL');
  for (const stage of RECALL_STAGES) {
    const count = report.stages.find((entry) => entry.stage === stage)!;
    const share = count.of === 0 ? 0 : (count.reached / count.of) * 100;
    const bar = '#'.repeat(Math.round(share / 4)).padEnd(25, '.');
    /*
     * The board row owes the reader what its number was counted over: the
     * rendered seat list of the same build, credited by record identity, is a
     * different claim from a re-match against a differently-built region — and
     * a release has already quoted the second as if it were the first.
     */
    const note =
      (stage === 'shortlisted' || stage === 'board') && !report.laterStagesMeasured
        ? '   (not measured: no compiled artifact)'
        : stage === 'board' && report.laterStagesMeasured && !report.laterStagesFromSameBuild
          ? '   (measured against a region compiled from a different pack build)'
          : stage === 'board' && report.laterStagesFromSameBuild && report.board?.renderedSeatList
            ? `   (the ${report.board.seats}-card seat list the discover page renders; credit by record identity)`
            : '';
    lines.push(
      `  ${pad(stage, 13)} ${bar} ${String(count.reached).padStart(3)}/${count.of}  ${share.toFixed(0).padStart(3)}%${note}`,
    );
  }
  lines.push('');

  lines.push('PER SUBJECT');
  const nameWidth = Math.max(...report.subjects.map((entry) => entry.subject.name.length), 20) + 2;
  for (const entry of report.subjects) {
    lines.push(`  ${pad(entry.subject.name, nameWidth)}${pad(stageLabel(entry), 20)}${why(entry)}`);
    for (const instead of entry.insteadFound) {
      lines.push(
        `  ${' '.repeat(nameWidth)}${' '.repeat(20)}  instead: ${instead.name} [${instead.layerId}/${instead.sourceCategory} → ${instead.subrole}] ${instead.metres}m`,
      );
    }
  }
  lines.push('');
  /*
   * The asterisk's explanation must be the true one. "Built from a different
   * pack" is a claim the report has already checked — `laterStagesFromSameBuild`
   * compares the compiled artifact's recorded pack hash against the measured
   * pack — and printing it unconditionally made the instrument assert a
   * provenance mismatch against an artifact that records the very same hash.
   */
  if (report.subjects.some((entry) => entry.lostAt && entry.passed.board)) {
    lines.push(
      report.laterStagesFromSameBuild
        ? '* on the board despite being lost earlier, from the same pack build: the board carries a hit the pack-side stages cannot account for.'
        : '* on the board despite being lost earlier: the compiled artifact was built from a different pack than the one measured above.',
    );
  }
  lines.push(
    `counted ${counted} of ${report.subjects.length} subjects; ${report.outOfScope.length} outside the pack bounds`,
  );
  lines.push('='.repeat(96));
  return lines.join('\n');
}
