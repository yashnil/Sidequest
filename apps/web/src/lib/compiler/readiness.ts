import 'server-only';
import {
  missingProviderSwitches,
  openProvidersEnabled,
} from '../providers/switches';
import { capabilityRegistry } from '../capabilities';

/**
 * WHICH PROVIDER SET RUNS — ANSWERABLE WITHOUT IMPORTING ANY OF THEM.
 *
 * This used to live in `compiler/providers.ts`, which builds the provider set.
 * Reading an environment variable is harmless; importing the module that builds
 * Nominatim, Valhalla, Overture and the research model in order to *ask about*
 * them is not. The render-purity audit found the consequence: the plan page had
 * the entire live stack in its transitive import graph purely because it wanted
 * to render "compiling new destinations is switched off in this build".
 *
 * Nothing was ever called from there. But "nothing is called today" is a
 * property of the current control flow rather than of the build, and it is one
 * refactor away from being false — which is exactly the class of defect an
 * architecture test exists to make impossible rather than unlikely.
 *
 *   open     the live open-licensed stack — Nominatim for the name, the Overture
 *            place backbone for what is there, Valhalla for travel times,
 *            Anthropic for research. Public Overpass is a fallback rather than a
 *            requirement.
 *   fixture  deterministic synthetic worlds, built through the *same* backbone.
 *            What the end-to-end suite runs on.
 *   off      no compilation at all, which is the honest default.
 *
 * An unrecognised value falls through to **off**. These reach volunteer-run
 * services and a billed model, and a typo should cost nothing.
 */
export type CompilerProviderChoice = 'open' | 'fixture' | 'off';

export function compilerProviderChoice(): CompilerProviderChoice {
  const configured = process.env.SIDEQUEST_COMPILER_PROVIDER?.trim().toLowerCase();
  if (configured === 'fixture' || configured === 'off') return configured;
  if (configured === 'open') return 'open';
  // Nothing configured: infer from the provider switches, so a developer who
  // turned those on does not also have to remember this one.
  return openProvidersEnabled() ? 'open' : 'off';
}

export interface ProviderReadiness {
  ready: boolean;
  choice: CompilerProviderChoice;
  message: string;
  /**
   * What the traveller can still do, in the order they should consider it.
   *
   * The field this type was missing, and the reason a founder test ended here.
   * A blocked state used to render one amber sentence and **no control at all**:
   * the trip row existed, every refresh returned to the same screen, and the
   * only escape was the browser's back button. A state with no next action is
   * not a state, it is a trap — so the type now makes producing one impossible
   * to forget, and every blocked branch below has to fill it in.
   *
   * Traveller-facing wording throughout. The switch names live in `message` and
   * are for whoever is running the deployment.
   */
  nextActions: { label: string; href: string; kind: 'primary' | 'secondary' }[];
  /**
   * Configuration this build needs and does not have, by variable name.
   *
   * Names only, never values, and never rendered to a traveller — the setup
   * disclosure on the plan screen is for the person who deployed it.
   */
  missing: string[];
}

/**
 * Where a traveller can go when compilation cannot run.
 *
 * Both of these are real routes that do real work: the index-backed chooser can
 * plan any destination this deployment already holds, and the edit route
 * returns them to their own answers with the trip intact. Neither is a
 * placeholder, which is the standing rule for anything that looks like a button.
 */
function blockedActions(): ProviderReadiness['nextActions'] {
  return [
    { label: 'Choose a destination we can plan now', href: '/decide', kind: 'primary' },
    { label: 'Change this trip', href: 'edit', kind: 'secondary' },
  ];
}

export function providerReadiness(): ProviderReadiness {
  const choice = compilerProviderChoice();
  if (choice === 'fixture') {
    return {
      ready: true,
      choice,
      message: 'Running against deterministic test data.',
      nextActions: [],
      missing: [],
    };
  }
  if (choice === 'open') {
    if (openProvidersEnabled()) {
      return {
        ready: true,
        choice,
        message: 'Running against the open map data stack.',
        nextActions: [],
        missing: [],
      };
    }
    /*
     * WHAT IS MISSING, ASKED OF THE CAPABILITY REGISTRY.
     *
     * `missingProviderSwitches` is still the authority on *whether* the open
     * stack can run — it encodes the "backbone or fallback, not neither" rule
     * that no per-capability view can express. What the registry adds is the
     * shape of the answer: it knows which capability each variable unlocks, so a
     * developer reading this is told what they are losing rather than only which
     * string to set.
     *
     * Unioned rather than replaced, and the union is deliberate: a capability
     * the registry does not model must not be able to remove a switch from this
     * list by omission.
     */
    const fromRegistry = capabilityRegistry()
      .report()
      .filter((verdict) => verdict.reason === 'unconfigured')
      .flatMap((verdict) => verdict.missing);
    const missing = [...new Set([...missingProviderSwitches(), ...fromRegistry])].sort();
    return {
      ready: false,
      choice,
      // Names the switches, never a value. A developer needs to know which is
      // missing; nobody needs to see what is in it.
      message: `This build is missing: ${missing.join(', ')}.`,
      nextActions: blockedActions(),
      missing,
    };
  }
  return {
    ready: false,
    choice,
    message:
      'Compiling new destinations is switched off in this build, so only regions we already hold can be planned.',
    nextActions: blockedActions(),
    missing: ['SIDEQUEST_COMPILER_PROVIDER'],
  };
}
