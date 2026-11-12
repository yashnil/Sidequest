import type { ReactNode } from 'react';
import { WorldDots } from '@/components/advisor/WorldDots';
import { GUIDE_VARIANT_LABELS, type GuideDay, type GuideItem, type GuideModel, type GuidePhoto } from '@/lib/guide/model';
import { GuideAutoPrint } from './GuideAutoPrint';
import { GuideMapSvg } from './GuideMapSvg';
import { Qr } from './Qr';
import './guide.css';

/**
 * THE PRINTED GUIDE — A DOCUMENT, NOT A PRINTED WEB PAGE.
 *
 * Laid out for CSS paged media and nothing else: A4, named pages, running
 * header and page numbers in the page margins, one section per page break,
 * days as simple blocks that do not split, figures floated so they fragment
 * cleanly. No flex or grid container is ever asked to break across a page.
 * Everything it says comes from `GuideModel`; it computes nothing about the
 * trip itself.
 */

const NON_LATIN = /[^\u0020-\u024f\u1e00-\u1eff\u2000-\u206f\u20a0-\u20cf]/;

function Place({ text, lang }: { text: string; lang: string | undefined }) {
  return lang && NON_LATIN.test(text) ? <span lang={lang}>{text}</span> : <>{text}</>;
}

/** A CSS string literal, for the running header the margin boxes print. */
function cssString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]+/g, ' ')}"`;
}

function Photo({ photo, className, caption = true }: { photo: GuidePhoto; className?: string; caption?: boolean }) {
  return (
    <figure className={`guide-photo ${photo.crop ? 'is-crop' : 'is-whole'} ${className ?? ''}`}>
      <div className="guide-photo-frame">
        {/* A print document wants the file itself, not a responsive loader. */}
        <img src={photo.src} alt={photo.alt} decoding="sync" loading="eager" />
      </div>
      {caption ? <figcaption>Photo · {photo.credit}</figcaption> : null}
    </figure>
  );
}

function SectionHead({ eyebrow, title, lede }: { eyebrow: string; title: string; lede?: string }) {
  return (
    <header className="guide-section-head">
      <p className="guide-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {lede ? <p className="guide-lede">{lede}</p> : null}
    </header>
  );
}

function Cover({ guide }: { guide: GuideModel }) {
  const { identity } = guide;
  const centre = guide.glance.map?.points.find((p) => p.kind === 'base') ?? guide.glance.map?.points[0];
  return (
    <section className="guide-cover" aria-label="Cover">
      {guide.cover.photo ? (
        <Photo photo={guide.cover.photo} className="guide-cover-photo" caption={false} />
      ) : (
        <div className="guide-cover-plate topo-plate" aria-hidden="true" />
      )}
      <div className="guide-cover-body">
        <p className="guide-eyebrow">{GUIDE_VARIANT_LABELS[guide.variant].title}</p>
        <h1>
          <Place text={identity.title} lang={guide.placeLang} />
        </h1>
        {identity.thesis ? <p className="guide-cover-thesis">{identity.thesis}</p> : null}
        <dl className="guide-cover-facts">
          <div>
            <dt>When</dt>
            <dd>{identity.dateRange}</dd>
          </div>
          <div>
            <dt>Length</dt>
            <dd>
              {identity.dayCount} days · {identity.nightCount} nights
            </dd>
          </div>
          {identity.party ? (
            <div>
              <dt>Who</dt>
              <dd>{identity.party}</dd>
            </div>
          ) : null}
          <div className="is-wide">
            <dt>Route</dt>
            <dd>
              {identity.route.map((stop, index) => (
                <span key={`${stop}-${index}`}>
                  {index > 0 ? <span className="guide-arrow"> → </span> : null}
                  <Place text={stop} lang={guide.placeLang} />
                </span>
              ))}
            </dd>
          </div>
        </dl>
        <div className="guide-cover-foot">
          {centre ? <WorldDots highlighted={[{ id: 'trip', lat: centre.lat, lng: centre.lng }]} label="Where this trip is in the world" className="guide-locator" /> : null}
          <p>
            Planned with Sidequest · {identity.generatedOn}
            {identity.timeZone ? (
              <>
                <br />
                All times are local ({identity.timeZone.abbreviation}, {identity.timeZone.id})
              </>
            ) : null}
            {guide.cover.photo ? (
              <>
                <br />
                Cover photo · {guide.cover.photo.credit}
              </>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  );
}

function Glance({ guide }: { guide: GuideModel }) {
  const { glance } = guide;
  return (
    <section className="guide-section guide-glance" aria-labelledby="glance">
      <SectionHead eyebrow="Trip at a glance" title="The shape of the trip" />
      <dl className="guide-figures">
        {glance.figures.map((figure) => (
          <div key={figure.label}>
            <dt>{figure.label}</dt>
            <dd>{figure.value}</dd>
          </div>
        ))}
      </dl>
      {glance.map ? (
        <figure className="guide-figure guide-overview-map">
          <GuideMapSvg map={glance.map} width={640} height={glance.map.points.length > 30 ? 380 : 330} label="Map of the whole trip" lang={guide.placeLang} showNames={glance.map.points.filter((p) => p.kind === 'base').length > 1} />
          <figcaption>
            Letters are where you sleep; numbers are the day each stop falls on. Solid lines follow measured routes; dashed lines are straight connections, not roads.
            {glance.map.unplaced > 0 ? ` ${glance.map.unplaced} ${glance.map.unplaced === 1 ? 'stop has' : 'stops have'} no confirmed position and ${glance.map.unplaced === 1 ? 'is' : 'are'} not drawn.` : ''}
          </figcaption>
        </figure>
      ) : null}
      <div className="guide-two">
        <div>
          <h3>Where you sleep</h3>
          <ol className="guide-stays-brief">
            {glance.stays.map((stay, index) => (
              <li key={`${stay.name}-${index}`}>
                <span className="guide-badge">{'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index] ?? '•'}</span>
                <strong>
                  <Place text={stay.name} lang={guide.placeLang} />
                </strong>{' '}
                <span className="guide-muted">
                  · {stay.nights} {stay.nights === 1 ? 'night' : 'nights'} · {stay.dates}
                </span>
              </li>
            ))}
          </ol>
          {glance.getAround ? (
            <>
              <h3>Getting around</h3>
              <p>{glance.getAround}</p>
            </>
          ) : null}
        </div>
        <div>
          {glance.highlights.length > 0 ? (
            <>
              <h3>Built around</h3>
              <ul className="guide-highlights">
                {glance.highlights.map((item) => (
                  <li key={item.name}>
                    <strong>
                      <Place text={item.name} lang={guide.placeLang} />
                    </strong>{' '}
                    <span className="guide-muted">· Day {item.dayNumber}</span>
                    {item.why ? <span className="guide-why">{item.why}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {glance.throughout.length > 0 ? (
            <>
              <h3>Throughout the trip</h3>
              <ul className="guide-notes">
                {glance.throughout.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ItemRow({ item, lang }: { item: GuideItem; lang: string | undefined }) {
  if (item.kind === 'travel') {
    return (
      <li className="guide-item is-travel">
        <span className="guide-time" />
        <span className="guide-item-body">
          <Place text={item.title} lang={lang} />
          {item.duration ? <span className="guide-dur"> · {item.duration}</span> : null}
        </span>
      </li>
    );
  }
  return (
    <li className={`guide-item is-${item.kind}`}>
      <span className={`guide-time ${item.time && !/^\d/.test(item.time) ? 'is-part' : item.approx ? 'is-approx' : ''}`}>{item.time ?? ''}</span>
      <span className="guide-item-body">
        {item.pin ? <span className="guide-pin">{item.pin}</span> : null}
        <span className="guide-item-title">
          <Place text={item.title} lang={lang} />
        </span>
        {item.duration && item.kind === 'stop' ? <span className="guide-dur"> · {item.duration}</span> : null}
        {item.flag ? <span className="guide-flag">{item.flag}</span> : null}
        {item.detail ? <span className="guide-item-detail">{item.detail}</span> : null}
      </span>
    </li>
  );
}

function Day({ day, guide }: { day: GuideDay; guide: GuideModel }) {
  const complete = guide.variant === 'complete';
  const hasFigure = complete && (day.map || day.photo);
  return (
    <article className={`guide-day ${complete ? 'is-complete' : 'is-compact'} ${day.items.length > (complete ? 14 : 11) ? 'is-long' : ''}`} aria-labelledby={`day-${day.number}`}>
      <header className="guide-day-head">
        <p className="guide-day-num">
          Day <span>{day.number}</span>
        </p>
        <div>
          <p className="guide-day-date">
            {day.weekday} {day.dateLabel} · <Place text={day.base} lang={guide.placeLang} /> · {day.intensity} day{day.travel ? ` · ${day.travel}` : ''}
          </p>
          <h3 id={`day-${day.number}`}>{day.theme}</h3>
          {day.move ? (
            <p className="guide-move">
              Moving on: <Place text={day.move.from} lang={guide.placeLang} /> → <Place text={day.move.to} lang={guide.placeLang} />
            </p>
          ) : null}
        </div>
      </header>
      {hasFigure ? (
        <aside className="guide-day-figure">
          {day.map ? <GuideMapSvg map={day.map} width={300} height={day.photo ? 190 : 260} label={`Map of day ${day.number}`} lang={guide.placeLang} /> : null}
          {day.photo ? <Photo photo={day.photo} /> : null}
        </aside>
      ) : null}
      <ol className="guide-items">
        {day.items.map((item, index) => (
          <ItemRow key={index} item={item} lang={guide.placeLang} />
        ))}
      </ol>
      {day.notes.length > 0 || day.backup ? (
        <div className="guide-day-notes">
          {day.notes.map((note) => (
            <p key={note}>
              <span className="guide-note-mark">Note</span> {note}
            </p>
          ))}
          {day.backup ? (
            <p>
              <span className="guide-note-mark">Plan B</span> {day.backup}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Days({ guide }: { guide: GuideModel }) {
  return (
    <section className={`guide-section guide-days ${guide.variant === 'complete' ? 'is-complete' : ''}`} aria-label="Day by day">
      <SectionHead eyebrow="Day by day" title={`${guide.days.length} days`} lede={guide.identity.timeZone ? `Times are local (${guide.identity.timeZone.abbreviation}). A time marked ≈ follows a journey estimated from the map; a part of the day stands in where a journey could not be timed.` : 'A time marked ≈ follows a journey estimated from the map; a part of the day stands in where a journey could not be timed.'} />
      {guide.days.map((day) => (
        <Day key={day.number} day={day} guide={guide} />
      ))}
    </section>
  );
}

function StaysAndTransport({ guide }: { guide: GuideModel }) {
  const owner = guide.audience === 'owner';
  return (
    <section className="guide-section guide-stays" aria-label="Stays and transport">
      <SectionHead eyebrow="Accommodation & transport" title="Where you sleep, and how you move" />
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col">Stay</th>
            <th scope="col" className="is-num">
              Nights
            </th>
            <th scope="col">Dates</th>
            <th scope="col">{owner ? 'Status' : 'Why here'}</th>
          </tr>
        </thead>
        <tbody>
          {guide.stays.map((stay, index) => (
            <tr key={`${stay.name}-${index}`}>
              <td>
                <strong>
                  <Place text={stay.name} lang={guide.placeLang} />
                </strong>
                {stay.area ? <span className="guide-cell-sub">{stay.area}</span> : null}
                {owner && stay.why ? <span className="guide-cell-sub">{stay.why}</span> : null}
              </td>
              <td className="is-num">{stay.nights}</td>
              <td className="is-nowrap">{stay.dates}</td>
              <td>
                {owner ? (
                  <>
                    <span className={`guide-status ${stay.status === 'Booked' ? 'is-done' : 'is-open'}`}>{stay.status}</span>
                    {stay.booked ? <span className="guide-cell-sub">{stay.booked}</span> : null}
                  </>
                ) : (
                  stay.why ?? ''
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="guide-keep">
        <h3>Getting around</h3>
        {guide.transport.headline ? <p>{guide.transport.headline}</p> : null}
        {guide.transport.points.length > 0 ? (
          <ul className="guide-notes">
            {guide.transport.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {guide.transport.moves.length > 0 ? (
        <div className="guide-keep">
          <h3>Moving between stays</h3>
          <table className="guide-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">How</th>
              </tr>
            </thead>
            <tbody>
              {guide.transport.moves.map((move) => (
                <tr key={move.day}>
                  <td className="is-num">{move.day}</td>
                  <td>
                    <Place text={move.from} lang={guide.placeLang} />
                  </td>
                  <td>
                    <Place text={move.to} lang={guide.placeLang} />
                  </td>
                  <td>{move.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function BookingsAndPrep({ guide }: { guide: GuideModel }) {
  const owner = guide.audience === 'owner';
  return (
    <section className="guide-section guide-prep" aria-label="Bookings and preparation">
      <SectionHead eyebrow="Bookings & preparation" title="Before you go" />
      {guide.bookings.length > 0 ? (
        <div className="guide-block">
          <h3>What to book</h3>
          <table className="guide-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">When</th>
                <th scope="col">What to do</th>
                {owner ? <th scope="col">Status</th> : <th scope="col">Priority</th>}
              </tr>
            </thead>
            <tbody>
              {guide.bookings.map((booking, index) => (
                <tr key={`${booking.title}-${index}`}>
                  <td>
                    <strong>
                      <Place text={booking.title} lang={guide.placeLang} />
                    </strong>
                    {owner ? <span className="guide-cell-sub">{booking.priority}</span> : null}
                  </td>
                  <td className="is-nowrap">{booking.when ?? '—'}</td>
                  <td>
                    {booking.action}
                    {booking.deadline ? <span className="guide-cell-sub">By {booking.deadline}</span> : null}
                  </td>
                  <td>{owner ? <span className={`guide-status ${booking.status === 'Booked' || booking.status === 'Not needed' ? 'is-done' : 'is-open'}`}>{booking.status}</span> : booking.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Nothing on this plan needs booking ahead, as far as Sidequest can tell.</p>
      )}
      {guide.prep.beforeYouGo.length > 0 ? (
        <div className="guide-block">
          <h3>To do before you leave</h3>
          <ul className="guide-checklist">
            {guide.prep.beforeYouGo.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {guide.prep.packing.length > 0 ? (
        <div className="guide-block is-breakable">
          <h3>Packing</h3>
          <div className="guide-packing">
            {guide.prep.packing.map((group) => (
              <div key={group.category} className="guide-packing-group">
                <h4>{group.category}</h4>
                <ul className="guide-checklist is-tight">
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Reference({ guide }: { guide: GuideModel }) {
  const { country, links } = guide.reference;
  return (
    <section className="guide-section guide-reference" aria-label="Practical reference">
      <SectionHead eyebrow="Practical reference" title="Keep this page handy" />
      <div className="guide-emergency">
        {country ? (
          <>
            <p className="guide-emergency-num">
              <span>Emergency</span> {country.emergency}
            </p>
            <p>
              The general emergency number in {country.name}
              {country.emergencyNotes ? ` (${country.emergencyNotes})` : ''}. Confirm locally; reference facts compiled by Sidequest.
            </p>
          </>
        ) : (
          <p>Save the local emergency number and the address of where you sleep each night before you go; Sidequest holds no reference facts for this destination.</p>
        )}
      </div>
      {country ? (
        <dl className="guide-facts">
          <div>
            <dt>Driving</dt>
            <dd>On the {country.drivingSide}</dd>
          </div>
          <div>
            <dt>Money</dt>
            <dd>{country.currency}</dd>
          </div>
          <div>
            <dt>Plugs</dt>
            <dd>
              Type {country.plugs.join(', ')} · {country.voltage} V
            </dd>
          </div>
          <div>
            <dt>Calling code</dt>
            <dd>{country.callingCode}</dd>
          </div>
          {guide.identity.timeZone ? (
            <div>
              <dt>Time zone</dt>
              <dd>
                {guide.identity.timeZone.abbreviation} · {guide.identity.timeZone.id}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {links.length > 0 ? (
        <div className="guide-block">
          <h3>Scan to open</h3>
          <ul className="guide-links">
            {links.map((link) => (
              <li key={link.url} className="guide-link">
                <Qr value={link.url} size="22mm" label={`QR code: ${link.label}`} />
                <span>
                  <strong>{link.label}</strong>
                  {link.note ? <span className="guide-cell-sub">{link.note}</span> : null}
                  {link.short ? <span className="guide-short">{link.short}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {guide.variant === 'compact' ? <Credits guide={guide} /> : null}
    </section>
  );
}

function Credits({ guide }: { guide: GuideModel }) {
  if (guide.credits.photos.length === 0 && guide.credits.data.length === 0) return null;
  return (
    <div className="guide-credits">
      <h3>Credits</h3>
      {guide.credits.photos.map((line) => (
        <p key={line}>Photo · {line}</p>
      ))}
      {guide.credits.data.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function Appendix({ guide }: { guide: GuideModel }) {
  const appendix = guide.appendix;
  if (!appendix) return null;
  return (
    <section className="guide-section guide-appendix" aria-label="Appendix">
      <SectionHead eyebrow="Appendix" title="Planning notes and reference" />
      {appendix.planning.length > 0 ? (
        <div className="guide-block">
          <h3>How this plan was put together</h3>
          {appendix.planning.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
      {appendix.skip.length > 0 ? (
        <div className="guide-block">
          <h3>Worth skipping, for how you travel</h3>
          <ul className="guide-notes">
            {appendix.skip.map((entry) => (
              <li key={entry.name}>
                <strong>
                  <Place text={entry.name} lang={guide.placeLang} />
                </strong>{' '}
                — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {appendix.budget ? (
        <div className="guide-block">
          <h3>Budget estimate ({appendix.budget.currency})</h3>
          <table className="guide-table">
            <tbody>
              {appendix.budget.lines.map((line) => (
                <tr key={line.label}>
                  <td>
                    <strong>{line.label}</strong>
                    <span className="guide-cell-sub">{line.basis}</span>
                  </td>
                  <td className="is-num is-nowrap">{line.range}</td>
                </tr>
              ))}
              <tr className="is-total">
                <td>Estimated total</td>
                <td className="is-num is-nowrap">{appendix.budget.total}</td>
              </tr>
            </tbody>
          </table>
          <p className="guide-muted">{appendix.budget.note} Estimates only; no price on this page was checked live.</p>
        </div>
      ) : null}
      {appendix.positions.length > 0 ? (
        <div className="guide-block">
          <h3>Positions</h3>
          <p className="guide-muted">Type a pair into any map app’s search box.</p>
          <table className="guide-table is-positions">
            <tbody>
              {appendix.positions.map((row, index) => (
                <tr key={`${row.day}-${index}`}>
                  <td className="is-num">{row.day}</td>
                  <td>
                    <Place text={row.name} lang={guide.placeLang} />
                  </td>
                  <td className="is-mono is-nowrap">{row.coordinates}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Credits guide={guide} />
    </section>
  );
}

export function GuideDocument({ guide }: { guide: GuideModel }): ReactNode {
  const header = cssString(`${guide.identity.title} · ${guide.identity.dateRange}`);
  return (
    <div className={`guide guide-${guide.variant}`} data-guide-variant={guide.variant} data-guide-audience={guide.audience}>
      <style>{`@page guide { @top-left { content: ${header}; } }`}</style>
      <Cover guide={guide} />
      <Glance guide={guide} />
      <Days guide={guide} />
      <StaysAndTransport guide={guide} />
      <BookingsAndPrep guide={guide} />
      <Reference guide={guide} />
      <Appendix guide={guide} />
      <GuideAutoPrint />
    </div>
  );
}
