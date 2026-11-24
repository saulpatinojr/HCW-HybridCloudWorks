/** The Spotlight hub's probes (ADR 0033 §1 Platform, §8): the speaker feed behind Speaking. */
import { fromService } from '../probeKit';

export const SPOTLIGHT_PROBES = [
  fromService('sessionize', {
    hub: 'spotlight',
    covers: 'The public speaker feed behind Speaking.',
    impact: 'Speaking events stop updating.',
    action: 'Check the speaker id on the Sessionize card.',
  }),
  fromService('community-days', {
    hub: 'spotlight',
    covers:
      'The directory behind Speaking → Future Events: the key, and that API access is approved.',
    impact: 'The list of events to apply to stops refreshing; the last copy stays on the page.',
    action:
      'Paste a current key on the Keys tab and press Test on the Community Days card; if it says access is not approved, that is granted on the Community Days developers page.',
  }),
];
