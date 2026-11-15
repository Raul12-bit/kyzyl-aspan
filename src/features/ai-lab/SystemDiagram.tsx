import { useId, useState } from 'react';
import type { AiId } from '@/domain/ai/registry';
import { prefersReducedMotion } from '@/features/intro/introStore';
import { useI18n } from '@/i18n';
import './diagram.css';
import { hexPoints } from './hex';

const NODES: Record<AiId, { x: number; y: number; r: number }> = {
  ai1: { x: 132, y: 196, r: 58 },
  ai2: { x: 344, y: 196, r: 58 },
  ai3: { x: 790, y: 196, r: 68 },
};
const RELAY = { x: 520, y: 78 };
const NEIGHBOUR = { x: 520, y: 318 };
const STATION = { x: 664, y: 300 };

/** Connector paths (also the tracks the packets ride on). */
const PATHS = {
  alerts: `M ${NODES.ai1.x + 62} 196 L ${NODES.ai2.x - 62} 196`,
  laserUp: `M ${NODES.ai2.x + 44} 160 L ${RELAY.x - 16} ${RELAY.y + 8}`,
  relayDown: `M ${RELAY.x + 16} ${RELAY.y + 8} Q 700 90 ${NODES.ai3.x - 34} ${NODES.ai3.y - 56}`,
  rf: `M ${NODES.ai2.x + 62} 196 L ${NODES.ai3.x - 72} 196`,
  radio: `M ${NODES.ai2.x + 44} 232 L ${STATION.x - 18} ${STATION.y - 4}`,
  stationUp: `M ${STATION.x + 14} ${STATION.y - 14} L ${NODES.ai3.x - 44} ${NODES.ai3.y + 50}`,
  neighbour: `M ${NODES.ai2.x + 40} 238 L ${NEIGHBOUR.x - 16} ${NEIGHBOUR.y - 6}`,
  output: `M ${NODES.ai3.x + 72} 196 L 930 196`,
  memory: `M ${NODES.ai3.x} ${NODES.ai3.y + 70} C ${NODES.ai3.x} 392, ${NODES.ai1.x} 392, ${NODES.ai1.x} ${NODES.ai1.y + 62}`,
} as const;

/**
 * The architecture in one picture: AI #1 → AI #2 on the satellite, AI #3 on the ground, the three kinds
 * of link between them, and the archive's memory flowing back up. Pure SVG drawn from tokens.
 * `active` highlights one AI (the lab's current tab); `onSelect` makes the nodes clickable.
 */
export function SystemDiagram({
  active,
  onSelect,
  className,
}: {
  active?: AiId | null;
  onSelect?: (id: AiId) => void;
  className?: string;
}) {
  const { m } = useI18n();
  const d = m.ai.diagram;
  const s = m.ai.systems;
  const uid = useId().replace(/:/g, '');
  const [animate] = useState(() => !prefersReducedMotion());

  const packet = (path: keyof typeof PATHS, dur: number, delay: number, cls: string) =>
    animate ? (
      <circle r="3.6" className={`sd-packet ${cls}`}>
        <animateMotion dur={`${dur}s`} begin={`${delay}s`} repeatCount="indefinite" path={PATHS[path]} />
      </circle>
    ) : null;

  const node = (id: AiId) => {
    const n = NODES[id];
    const on = active === id;
    const content = (
      <>
        <polygon points={hexPoints(n.x, n.y, n.r)} className="sd-node" data-on={on ? 'true' : 'false'} />
        <polygon points={hexPoints(n.x, n.y, n.r - 7)} className="sd-node__inner" />
        <text x={n.x} y={n.y - 8} className="sd-node__id">
          {s[id].name}
        </text>
        <text x={n.x} y={n.y + 18} className="sd-node__role">
          {s[id].role}
        </text>
      </>
    );
    if (!onSelect) return <g key={id}>{content}</g>;
    return (
      <g
        key={id}
        role="button"
        tabIndex={0}
        aria-label={`${s[id].name} · ${s[id].title}`}
        aria-pressed={on}
        className="sd-hit"
        onClick={() => onSelect(id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(id);
          }
        }}
      >
        {content}
      </g>
    );
  };

  return (
    <svg
      viewBox="0 0 1000 410"
      className={className ? `sd ${className}` : 'sd'}
      role="img"
      aria-labelledby={`${uid}-t`}
    >
      <title id={`${uid}-t`}>{d.label}</title>
      <defs>
        <marker
          id={`${uid}-a`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" className="sd-arrow" />
        </marker>
      </defs>

      {/* the two segments, split by the atmosphere */}
      <text x="40" y="40" className="sd-seg">
        {d.space}
      </text>
      <text x="960" y="40" className="sd-seg" textAnchor="end">
        {d.ground}
      </text>
      <line x1="600" y1="58" x2="600" y2="350" className="sd-divider" />

      {/* links */}
      <path d={PATHS.alerts} className="sd-link sd-link--alert" markerEnd={`url(#${uid}-a)`} />
      <path d={PATHS.laserUp} className="sd-link sd-link--laser" />
      <path d={PATHS.relayDown} className="sd-link sd-link--laser" markerEnd={`url(#${uid}-a)`} />
      <path d={PATHS.rf} className="sd-link sd-link--rf" markerEnd={`url(#${uid}-a)`} />
      <path d={PATHS.radio} className="sd-link sd-link--radio" />
      <path d={PATHS.stationUp} className="sd-link sd-link--radio" markerEnd={`url(#${uid}-a)`} />
      <path d={PATHS.neighbour} className="sd-link sd-link--laser sd-link--thin" />
      <path d={PATHS.output} className="sd-link sd-link--out" markerEnd={`url(#${uid}-a)`} />
      <path d={PATHS.memory} className="sd-link sd-link--memory" markerEnd={`url(#${uid}-a)`} />

      {/* link labels */}
      <text x={(NODES.ai1.x + NODES.ai2.x) / 2} y="184" className="sd-label">
        {m.ai.lab.ai2.alerts.title}
      </text>
      <text x="436" y="110" className="sd-label sd-label--laser" transform="rotate(-32.5 436 110)">
        {d.laser}
      </text>
      <text x="566" y="186" className="sd-label sd-label--rf">
        {d.rf}
      </text>
      <text x="512" y="282" className="sd-label sd-label--radio" transform="rotate(13.9 512 282)">
        {d.radio}
      </text>
      <text x="460" y="388" className="sd-label sd-label--memory">
        {d.memory}
      </text>

      {/* relay, neighbour, station */}
      <polygon points={hexPoints(RELAY.x, RELAY.y, 15)} className="sd-small" />
      <text x={RELAY.x} y={RELAY.y - 24} className="sd-small__label">
        {d.relay}
      </text>
      <polygon points={hexPoints(NEIGHBOUR.x, NEIGHBOUR.y, 15)} className="sd-small" />
      <text x={NEIGHBOUR.x} y={NEIGHBOUR.y + 36} className="sd-small__label">
        {d.neighbour}
      </text>
      <polygon points={hexPoints(STATION.x, STATION.y, 15)} className="sd-small sd-small--ground" />
      <text x={STATION.x} y={STATION.y + 36} className="sd-small__label">
        {d.station}
      </text>

      {/* output: the map, the briefs and the alerts people see (one word per line, any language) */}
      <polygon points={hexPoints(950, 196, 15)} className="sd-small sd-small--out" />
      <text x="950" y="234" className="sd-small__label">
        {d.output.split(' · ').map((w, i) => (
          <tspan key={i} x="950" dy={i === 0 ? 0 : 15}>
            {w}
          </tspan>
        ))}
      </text>

      {node('ai1')}
      {node('ai2')}
      {node('ai3')}

      {packet('alerts', 2.2, 0, 'sd-packet--alert')}
      {packet('laserUp', 2.4, 0.6, 'sd-packet--laser')}
      {packet('relayDown', 3.2, 1.4, 'sd-packet--laser')}
      {packet('rf', 2.8, 0.2, 'sd-packet--rf')}
      {packet('radio', 2.6, 1.8, 'sd-packet--radio')}
      {packet('memory', 6.5, 0.4, 'sd-packet--memory')}
    </svg>
  );
}
