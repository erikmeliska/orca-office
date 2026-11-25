/** Whether the system asks for less motion (M6 A13): no confetti, no dancing, no spinning, no disco lights. */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
