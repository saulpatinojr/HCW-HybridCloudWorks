/** The Enhanced hub's probes (ADR 0033 §1 Platform, §8): narration, the lab agents and the lab routes. */
import { LABS, fromService, liveProbe, sessionProbe } from '../probeKit';
import { evaluateLabsSession, evaluateUnauthSession } from '../probeEvaluators';
import { runLabAgents, runLabCheck } from '../probeRunners';

export const ENHANCED_PROBES = [
  fromService('elevenlabs', {
    hub: 'enhanced',
    covers: 'Podcast narration.',
    impact: 'Episodes cannot be rendered.',
    action: 'Check credits on the Audio tab; rotate the key on Keys.',
  }),
  liveProbe({
    id: 'lab-agents',
    label: 'Lab agents',
    hub: 'enhanced',
    covers: 'The registered lab agents and their 30-second heartbeat.',
    impact: 'Lab jobs queue with nothing to run them.',
    action: 'Restart the agent on the VPS; the Labs Agents tab shows which is offline.',
    href: LABS,
    run: runLabAgents,
  }),
  liveProbe({
    id: 'lab-drift',
    label: 'Lab host runs main',
    hub: 'enhanced',
    covers:
      'The commit each lab host last converged from, against main’s lab-host/ and vps-agent/ changes; raised a day after a change merges unapplied.',
    impact: 'Merged lab fixes, security ones included, are not running on the host.',
    action:
      'Run bootstrap.sh on the lab host; the Labs Agents tab names the commit each host runs.',
    href: LABS,
    run: () => runLabCheck('lab-drift'),
  }),
  liveProbe({
    id: 'coder-template',
    label: 'Coder template published',
    hub: 'enhanced',
    covers:
      'Whether Coder serves the hcw-lab template of the commit the host converged from, from the host’s daily Coder upkeep report.',
    impact: 'Workspaces start from an older template, with older images or settings.',
    action: 'Run bootstrap.sh, or hcw-coder-automation push-template on the lab host.',
    href: LABS,
    run: () => runLabCheck('coder-template'),
  }),
  liveProbe({
    id: 'lab-canary',
    label: 'Lab job canary',
    hub: 'enhanced',
    covers:
      'One real shell-echo job an hour, enqueued and waited for until the agent has run it and reported the payload back; the job is deleted after.',
    impact: 'Lab jobs, the public Validate on the lab included, are not running.',
    action:
      'Read the agent on the lab host (journalctl -u hcw-labs-agent); arm LAB_CANARY if the card says it has not run.',
    href: LABS,
    run: () => runLabCheck('lab-canary'),
  }),
  liveProbe({
    id: 'coder-token',
    label: 'Coder status token',
    hub: 'enhanced',
    covers:
      'Whether Coder accepts CODER-STATUS-TOKEN, from its answers to the labs status read and the Integrations card.',
    impact: 'The labs card cannot show its templates or running workspaces.',
    action:
      'Check the host’s Coder automation on Integrations → Hybrid Lab; it renews the token daily.',
    href: LABS,
    run: () => runLabCheck('coder-token'),
  }),
  // #1282: the host's own Portainer check reports every 15 minutes; the card reads its
  // verdict from the same labs snapshot as the other lab checks, so Test all may press it.
  liveProbe({
    id: 'portainer',
    label: 'Portainer',
    hub: 'enhanced',
    covers:
      'Portainer on the lab host, read every 15 minutes by the host’s own check: up, licence, the local environment, unhealthy or restarting containers, images with updates.',
    impact:
      'The owner’s container UI for the lab host is down or drifting without anyone seeing it.',
    action:
      'Open Portainer through the SSH tunnel (docs/runbooks/labs-host.md, Portainer through an SSH tunnel); the card’s detail names what the check saw.',
    href: LABS,
    run: () => runLabCheck('portainer'),
  }),
  sessionProbe({
    id: 'labs-noop',
    label: 'Labs job round trip',
    hub: 'enhanced',
    covers: 'Enqueue a shell-echo job as the console does, read it back, cancel it.',
    impact: 'The Labs console cannot submit jobs.',
    action: 'Run it from the card below; a job left queued is named with its id.',
    href: LABS,
    safe: false,
    costNote: 'Creates and cancels a real lab job.',
    evaluate: evaluateLabsSession,
    run: (ctx) => ctx.actions.runLabs(),
  }),
  sessionProbe({
    id: 'labs-unauth',
    label: 'Labs refuses anonymous jobs',
    hub: 'enhanced',
    covers: 'The same enqueue with no Authorization header must be refused.',
    impact: 'A 200 here means anyone can queue work on the lab.',
    action: 'If it passes anonymously, stop and check the route guard before anything else.',
    href: LABS,
    safe: true,
    evaluate: evaluateUnauthSession,
    run: (ctx) => ctx.actions.runUnauth(),
  }),
  fromService('hybrid-lab', {
    hub: 'enhanced',
    covers: 'Coder workspaces and the Turnstile check behind the public labs page.',
    impact: 'The labs page says the lab is not provisioned.',
    action: 'Seed CODER-URL and CODER-STATUS-TOKEN on Keys.',
  }),
  fromService('migration-addon', {
    hub: 'enhanced',
    covers: 'Whether the migration add-on answers its health read.',
    impact: '/tools/migration says the tool is unavailable.',
    action: 'Check the add-on container on the lab host (runbook, "Tool add-ons").',
  }),
];
