# The OpenStreetMap database boundary

Sidequest's durable place and routing data is derived from OpenStreetMap, which is published under
the **Open Database License 1.0 (ODbL)**. ODbL is a share-alike licence: it grants the right to use,
adapt and redistribute the database, and attaches two obligations in return — attribution, always,
and reciprocal licensing of a *Derivative Database* if one is publicly used.

This document exists so that the boundary between "our own work" and "a derivative of theirs" is
written down rather than assumed, and so a future decision to publish is a decision somebody makes
deliberately.

## What is OSM-derived

Everything in this list came out of the OpenStreetMap database and carries `licenceId: 'ODbL-1.0'`
on its `source.element` record, with the upstream element id, timestamp and a link back.

| In Sidequest | Comes from | Stored as |
| --- | --- | --- |
| A place's identity, name and coordinates | Overpass (`node/…`, `way/…`, `relation/…`) | `Place.name`, `Place.coordinates`, `Place.source.element` |
| The tag that classified it | Overpass | `Place.tags[0]`, e.g. `tourism=viewpoint` |
| Planning tags: `opening_hours`, `fee`, `access`, `wheelchair`, `website`, `operator`, `ele`, `seasonal` | Overpass | normalized, not copied wholesale |
| A destination's centre, bounding box and administrative hierarchy | Nominatim | `GeographicScope`, `DestinationCandidate` |
| Base town identity and coordinates | Nominatim | `BaseCandidate` |
| **Travel durations and distances** | Valhalla routing over OSM data | `CompiledRegion.travelTimes` |

Routing output is included deliberately. A duration produced by routing over the OSM network is
derived from that network, and treating it as unencumbered because a routing engine sat in between
would be wishful.

## What is not OSM-derived

These are Sidequest's own work and carry `licenceId: 'sidequest-authored'`:

- every `shortDescription` — written by the classification step, not copied from a tag
- category, interest tags, physical intensity, typical duration, weather exposure, whether a place
  is a genuine bad-weather alternative
- popularity and hidden-gem scores, and every personal-fit score
- the traveller's questionnaire answers, selections and feedback
- the whole itinerary structure: clustering, day assignment, ordering, meal placement, validation

Weather is separate again: Open-Meteo under **CC BY 4.0**, attribution only, no share-alike.

## The deliberate decision not to copy the tag dictionary

An OSM element can carry two hundred tags. `normalizeElement` keeps the identity, the position, the
one tag that classified it, and eight planning tags — and drops the rest.

That is a licensing decision as much as a storage one. A table that mirrors OSM's tag dictionary is a
redistribution of their database wearing our column names; a table holding the minimum fields our
planner reasons about, joined to our own derived judgements, is a genuine derivative work. The second
is what we want to be, and the difference is visible in the code rather than argued after the fact.

## Attribution, and where it must appear

`© OpenStreetMap contributors` must be visible wherever OSM-derived data or a map based on it is
shown. In this codebase that string is **data, not copy**: it lives on `DataLicence.attribution`,
travels on `CompiledRegion.licences`, and is rendered from there. A component that paraphrases it has
quietly stopped complying, which is why `requiredAttributions()` exists and why the string is never
hard-coded in a template.

Surfaces that must carry it once OSM-derived regions render:

- the Discovery Board and every place card built from a compiled region
- the itinerary, including any exported form
- the coverage and provenance report
- any map view

Sidequest must never present an OSM fact as independently authored. A place card shows the source and
links to the element; a fact extracted by the classification step is labelled as our inference, not as
something the map said.

## The share-alike question — an open review item

**Not yet triggered, and it needs a decision before it is.**

ODbL §4.4 attaches the reciprocal obligation to a *Derivative Database* that is **Publicly Used**.
Today Sidequest is a local development application: nothing is published, and no derived database is
offered to anyone. On that reading, attribution is the only live obligation.

The obligation becomes real at any of these, and this list is the review trigger:

1. **Deploying the web app publicly**, where compiled regions are served to users. This is the most
   likely first trigger and the one most likely to be missed, because it feels like shipping a
   product rather than publishing a database.
2. **Offering an API** that returns compiled regions, places, or travel-time matrices.
3. **Exporting** a compiled region — a downloadable trip packet containing OSM-derived places is a
   distribution of a derivative database in a way a rendered page arguably is not.
4. **Sharing an itinerary by link**, if the shared artifact carries the underlying place records
   rather than a rendered view.

Two distinctions that will matter and that this project has not yet resolved:

- **Produced Work vs Derivative Database.** A rendered itinerary is plausibly a *Produced Work*
  (attribution only). The compiled region behind it is plausibly a *Derivative Database*
  (share-alike). Sidequest currently stores both, and the line between them runs straight through
  `CompiledRegion`.
- **"Substantial" has no bright line.** ODbL's threshold for a substantial extraction is not
  numerically defined. A region of forty places is not obviously substantial; a corpus built up over
  thousands of compilations plausibly is.

**Action required before any public deployment or export feature:** get this reviewed by somebody
qualified, and record the outcome here. `hasShareAlikeObligation()` already reports whether an
artifact carries the flag; what it cannot decide is whether we have crossed into public use.

## Moving off the public endpoints

The public Nominatim, Overpass and Valhalla instances are used here for **bounded development
evaluation only**, under the constraints their own policies set: one request per second to Nominatim,
no autocomplete, an identifying User-Agent, caching, bounded Overpass queries with a server-side
timeout, and small Valhalla matrices.

None of them is a production architecture, and each is one environment variable away from being
replaced:

| Provider | Variable | Production path |
| --- | --- | --- |
| Nominatim | `SIDEQUEST_GEOCODER_URL` | Hosted geocoder or self-managed Nominatim |
| Overpass | `SIDEQUEST_POI_URL` | Hosted Overpass, regional extracts, or self-hosted |
| Valhalla | `SIDEQUEST_ROUTES_URL` | Hosted or self-managed Valhalla |

Self-hosting changes nothing about the licence. ODbL attaches to the data, not to who runs the server.
