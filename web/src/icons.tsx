// Line icons for the interface, drawn here rather than borrowed: emoji in the chrome
// were the single biggest thing making it look like a toy. One stroke weight, one size.

const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
               strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** a drop: what taste is, on the ground */
const Drop = () => <path d="M12 3.5c3.6 4.6 6 7.7 6 11a6 6 0 0 1-12 0c0-3.3 2.4-6.4 6-11z" />

/** One icon per stimulus kind (sensors.ts ids); anything unknown is a plain dot. */
export function StimIcon({ id, size = 18 }: { id: string; size?: number }) {
  const p = { ...base, width: size, height: size }
  switch (id) {
    case 'sugar':
      return <svg {...p}><Drop /><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" /></svg>
    case 'bitter':
      return <svg {...p}><Drop /><path d="M5.5 18.5l13-13" /></svg>
    case 'looming':
      // something overhead, coming down
      return <svg {...p}><circle cx="12" cy="7.5" r="4.5" /><path d="M12 14.5v5.5M7.5 15l-1.5 4M16.5 15l1.5 4" /></svg>
    case 'bristle':
      // specks landing
      return <svg {...p}><path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5L15 9M9 15l-2.5 2.5" /></svg>
    case 'touch':
      // air moving
      return <svg {...p}><path d="M3 9c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0M3 15c2.5-2.5 4.5-2.5 7 0s4.5 2.5 7 0" /></svg>
    case 'odor':
      // a mushroom: geosmin is the smell of mould
      return <svg {...p}><path d="M4 11.5c0-4.5 3.6-7.5 8-7.5s8 3 8 7.5c0 .8-.6 1.5-1.5 1.5h-13C4.6 13 4 12.3 4 11.5z" /><path d="M9.5 13l.5 5.5a2 2 0 0 0 4 0l.5-5.5" /></svg>
    default:
      return <svg {...p}><circle cx="12" cy="12" r="4" /></svg>
  }
}
export const ToolIcon = StimIcon

/** the fly, as a mark: body, head, two wings */
export const FlyIcon = ({ size = 22 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <ellipse cx="12" cy="14" rx="3" ry="6" />
    <circle cx="12" cy="6.5" r="2.2" />
    <path d="M9.5 10.5C5 8.5 3 10 3.5 12.5S8 15 9.8 13.5M14.5 10.5c4.5-2 6.5-.5 6 2S16 15 14.2 13.5" />
  </svg>
)

export const SoundIcon = () => (
  <svg {...base}><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>
)
export const MuteIcon = () => (
  <svg {...base}><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" /><path d="M16 9.5l5 5M21 9.5l-5 5" /></svg>
)
/** activity: the brain's readouts */
export const PulseIcon = () => (
  <svg {...base}><path d="M3 12.5h4l2.5-6 4 11 2.5-5H21" /></svg>
)
export const SlidersIcon = () => (
  <svg {...base}><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.8" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.8" fill="currentColor" stroke="none" /><circle cx="8" cy="17" r="1.8" fill="currentColor" stroke="none" /></svg>
)
export const CloseIcon = () => (
  <svg {...base} width={14} height={14}><path d="M6 6l12 12M18 6L6 18" /></svg>
)
export const PauseIcon = () => (
  <svg {...base} width={14} height={14}><path d="M8 5v14M16 5v14" strokeWidth={2} /></svg>
)
export const PlayIcon = () => (
  <svg {...base} width={14} height={14}><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" /></svg>
)
/** the whole brain, as a small point cloud */
export const BrainIcon = () => (
  <svg {...base}><path d="M9 4.5a3.5 3.5 0 0 0-3.4 4.3A3.5 3.5 0 0 0 5 15.2a3.5 3.5 0 0 0 4.5 4.3M15 4.5a3.5 3.5 0 0 1 3.4 4.3 3.5 3.5 0 0 1 .6 6.4 3.5 3.5 0 0 1-4.5 4.3M12 5v14" /></svg>
)
