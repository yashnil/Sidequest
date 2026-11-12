import type * as MapLibre from 'maplibre-gl';
import { CLUSTER_RADIUS_PX, clusterLabel, clusterMarkers, clusterRing, daysText, fanOffsets, type ClusterItem, type MarkerCluster } from './map-clusters';
import { boundsOfKm } from './atlas/atlas-model';

/**
 * THE CLUSTER MARKS ON A MAPLIBRE MAP — the DOM half of `map-clusters.ts`.
 *
 * Both vector maps draw their pins as DOM buttons (a pin is a real control,
 * named, in the tab order), so grouping happens in screen space over those
 * buttons rather than in a GeoJSON `cluster: true` source, which would turn
 * every pin into a canvas symbol nobody can tab to. When the camera settles the
 * layer asks the pure module which pins overlap, hides those pins and draws one
 * cluster button in their place:
 *
 * - a disc with the count, ringed by the colours of the days it holds;
 * - a list of the names on hover and on keyboard focus (and all of them in its
 *   accessible name, for a screen reader and a long-press);
 * - a press frames the members' own extent, where they come apart.
 *
 * Past `maxClusterZoom` nothing is grouped: marks still sharing one spot fan
 * out on a small ring instead, so the last press always reveals every pin.
 * Every hit area is at least 44 px.
 */
export interface ClusterLayerItem {
  id: string;
  lat: number;
  lng: number;
  label: string;
  dayNumber?: number | undefined;
  pinned?: boolean | undefined;
}

export interface ClusterLayerOptions {
  ground: 'night' | 'survey';
  /** At and above this zoom nothing is grouped. */
  maxClusterZoom?: number;
  radiusPx?: number;
  padding?: number | { top: number; right: number; bottom: number; left: number };
  reducedMotion?: () => boolean;
  /** Called after every regrouping with the number of cluster marks drawn. */
  onCount?: (count: number) => void;
}

type PinEntry = { marker: MapLibre.Marker; el: HTMLElement };

export class ClusterLayer {
  private clusters = new Map<string, { marker: MapLibre.Marker; el: HTMLButtonElement; cluster: MarkerCluster }>();
  private items: readonly ClusterLayerItem[] = [];
  private pins: Map<string, PinEntry> = new Map();
  private enabled = false;
  private lastCount = -1;
  private readonly onSettle = () => this.render();

  constructor(
    private readonly map: MapLibre.Map,
    private readonly lib: typeof MapLibre,
    private options: ClusterLayerOptions,
  ) {
    map.on('moveend', this.onSettle);
  }

  setOptions(options: Partial<ClusterLayerOptions>) {
    this.options = { ...this.options, ...options };
  }

  /** The pins the owner has drawn, and whether this frame groups them at all. */
  update(items: readonly ClusterLayerItem[], pins: Map<string, PinEntry>, enabled: boolean) {
    this.items = items;
    this.pins = pins;
    this.enabled = enabled;
    this.render();
  }

  /** How many cluster marks are on the map, for the owner's data attribute. */
  count(): number {
    return this.clusters.size;
  }

  destroy() {
    this.map.off('moveend', this.onSettle);
    for (const { marker } of this.clusters.values()) marker.remove();
    this.clusters.clear();
  }

  private render() {
    const zoom = this.map.getZoom();
    const maxClusterZoom = this.options.maxClusterZoom ?? 14;
    const screen: ClusterItem[] = this.items
      .filter((item) => this.pins.has(item.id))
      .map((item) => {
        const at = this.map.project([item.lng, item.lat]);
        return { id: item.id, x: at.x, y: at.y, lat: item.lat, lng: item.lng, label: item.label, dayNumber: item.dayNumber, pinned: item.pinned };
      });

    const grouping = this.enabled && zoom < maxClusterZoom;
    const result = grouping ? clusterMarkers(screen, { radius: this.options.radiusPx ?? CLUSTER_RADIUS_PX }) : { singles: screen, clusters: [] as MarkerCluster[] };
    const hidden = new Set(result.clusters.flatMap((c) => c.members.map((m) => m.id)));

    /* Pins: hidden when grouped; otherwise shown, fanned out where they still share a spot. */
    for (const [id, entry] of this.pins) {
      entry.el.style.display = hidden.has(id) ? 'none' : '';
      entry.marker.setOffset([0, 0]);
    }
    if (!grouping) {
      /* Only where marks genuinely coincide: a fan for pins nearer than half a pin. */
      const coincident = clusterMarkers(
        screen.map((s) => ({ ...s, pinned: false })),
        { radius: 14 },
      ).clusters;
      for (const group of coincident) {
        const seats = fanOffsets(group.members.length);
        group.members.forEach((member, k) => {
          const pin = this.pins.get(member.id);
          const item = this.items.find((i) => i.id === member.id);
          if (!pin || item?.pinned) return;
          pin.marker.setOffset(seats[k]!);
        });
      }
    }

    /* Cluster marks: reused by key, removed when gone. */
    const seen = new Set<string>();
    for (const cluster of result.clusters) {
      seen.add(cluster.key);
      let entry = this.clusters.get(cluster.key);
      if (!entry) {
        const el = document.createElement('button');
        el.type = 'button';
        const marker = new this.lib.Marker({ element: el, anchor: 'center' }).setLngLat([cluster.lng, cluster.lat]).addTo(this.map);
        entry = { marker, el, cluster };
        const own = entry;
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          this.expand(own.cluster);
        });
        this.clusters.set(cluster.key, entry);
      }
      entry.cluster = cluster;
      entry.marker.setLngLat([cluster.lng, cluster.lat]);
      entry.marker.setOffset(clearOfPinned(cluster, result.singles.filter((single) => single.pinned)));
      paintCluster(entry.el, cluster, this.options.ground);
    }
    for (const [key, entry] of this.clusters) {
      if (seen.has(key)) continue;
      entry.marker.remove();
      this.clusters.delete(key);
    }
    this.map.getContainer().dataset.clusters = String(this.clusters.size);
    if (this.clusters.size !== this.lastCount) {
      this.lastCount = this.clusters.size;
      this.options.onCount?.(this.clusters.size);
    }
  }

  /** Frame the cluster's members, close enough that they come apart (or fan out, if they share one spot). */
  private expand(cluster: MarkerCluster) {
    const maxClusterZoom = this.options.maxClusterZoom ?? 14;
    const bounds = boundsOfKm(cluster.members, 0.4);
    if (!bounds) return;
    const reduced = this.options.reducedMotion?.() ?? false;
    this.map.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: this.options.padding ?? 96, maxZoom: Math.max(maxClusterZoom + 0.5, this.map.getZoom() + 1.5), duration: reduced ? 0 : 700 },
    );
  }
}

/**
 * A cluster never sits under a bed. Where a pinned mark (a base, the selection)
 * lands within a disc of a cluster's centre, the cluster steps aside along the
 * line from that mark — straight down when they coincide — so the count and the
 * base are both readable and both pressable. Screen offset only.
 */
export function clearOfPinned(cluster: { x: number; y: number }, pinned: readonly { x: number; y: number }[], clearance = 34): [number, number] {
  const blocker = pinned.find((p) => Math.hypot(p.x - cluster.x, p.y - cluster.y) < clearance);
  if (!blocker) return [0, 0];
  const dx = cluster.x - blocker.x;
  const dy = cluster.y - blocker.y;
  const length = Math.hypot(dx, dy);
  const [ux, uy] = length < 1 ? [0.6, 0.8] : [dx / length, dy / length];
  return [Math.round(blocker.x + ux * clearance - cluster.x), Math.round(blocker.y + uy * clearance - cluster.y)];
}

/** The cluster button's contents and style; one function so a reused element is repainted exactly. */
function paintCluster(el: HTMLButtonElement, cluster: MarkerCluster, ground: 'night' | 'survey') {
  const night = ground === 'night';
  const size = cluster.members.length >= 10 ? 40 : cluster.members.length >= 5 ? 36 : 32;
  el.className = 'group relative grid h-11 w-11 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7fd1e0]';
  el.dataset.cluster = String(cluster.members.length);
  el.dataset.clusterDays = cluster.days.join(',');
  el.setAttribute('aria-label', clusterLabel(cluster));
  el.style.zIndex = '600';
  const days = daysText(cluster.days);
  /* Built with DOM calls and textContent, never markup: place names come from providers (CLAUDE.md, "never renders raw HTML"). */
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const disc = make('span', 'grid place-items-center rounded-full transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110');
  disc.setAttribute('aria-hidden', 'true');
  disc.style.width = `${size}px`;
  disc.style.height = `${size}px`;
  disc.style.background = clusterRing(cluster, night ? 'night' : 'paper');
  disc.style.boxShadow = '0 1px 6px rgb(0 0 0 / 0.45)';
  const count = make('span', 'grid place-items-center rounded-full font-mono text-[12px] font-semibold leading-none', String(cluster.members.length));
  count.style.width = `${size - 8}px`;
  count.style.height = `${size - 8}px`;
  count.style.background = night ? '#0d1a1f' : '#f1ebdf';
  count.style.color = night ? '#f1ebdf' : '#0d1a1f';
  disc.append(count);
  const tip = make('span', `pointer-events-none absolute bottom-[calc(100%+2px)] left-1/2 hidden w-max max-w-[15rem] -translate-x-1/2 border px-2.5 py-2 text-left text-[11px] leading-snug group-hover:block group-focus-visible:block ${night ? 'border-[#f1ebdf]/20 bg-[#0d1a1f]/95 text-[#f1ebdf]' : 'border-[#0d1a1f]/15 bg-[#f1ebdf] text-[#0d1a1f]'}`);
  tip.setAttribute('aria-hidden', 'true');
  tip.append(make('span', 'block font-mono text-[10px] uppercase tracking-[0.12em] opacity-70', `${cluster.members.length} places${days ? ` · ${days}` : ''}`));
  const list = make('ul', 'mt-1 space-y-0.5');
  for (const member of cluster.members.slice(0, 6)) list.append(make('li', 'truncate', member.label));
  if (cluster.members.length > 6) list.append(make('li', 'opacity-70', `and ${cluster.members.length - 6} more`));
  tip.append(list, make('span', 'mt-1 block opacity-60', 'Press to zoom in'));
  el.replaceChildren(disc, tip);
}

