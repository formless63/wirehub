/** Labeled desktop navigation: Work and Activity scroll; Extensions, Settings and the avatar menu stay at the bottom. */
import type { JSX } from 'react';

import { AvatarMenu } from './AvatarMenu.tsx';
import { NavItems } from './NavItems.tsx';

export function Rail(): JSX.Element {
  return <nav aria-label="sections" className="cs-navigation-rail max-sm:hidden">
    <div className="cs-navigation-links"><NavItems compact groups={['work', 'activity']} /></div>
    <div className="cs-navigation-bottom"><NavItems compact groups={['bottom']} /></div>
    <AvatarMenu />
  </nav>;
}
